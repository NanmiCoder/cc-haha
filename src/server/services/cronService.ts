/**
 * CronService — 管理定时任务的增删改查
 *
 * 任务持久化到 ~/.claude/scheduled_tasks.json（JSON 文件）。
 * 文件格式: { "tasks": [ CronTask, ... ] }
 */

import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import * as crypto from 'crypto'
import { stripBOM } from '../../utils/jsonRead.js'
import { ApiError } from '../middleware/errorHandler.js'
import { isBlankFileContent } from './blankFileContent.js'
import { parseCronExpression } from '../../utils/cron.js'
import { migrateScheduledTasks } from './scheduledTaskMigrations.js'
import { nextScheduledTime, validateTaskSchedule, type TaskSchedule } from './scheduledTaskSchedule.js'

export type TaskNotificationConfig = {
  enabled: boolean
  channels: ('desktop' | 'telegram' | 'feishu')[]
}

export type CronTask = {
  id: string
  revision?: number
  completedAt?: string
  scheduleAnchorAt?: number
  sourceSessionId?: string
  execution?: { kind: 'session'; targetSessionId: string } | { kind: 'new-session' }
  schedule?: TaskSchedule
  notificationPolicy?: 'important' | 'all' | 'failed' | 'none'
  nextRunAt?: number
  scheduleState?: 'active' | 'paused' | 'completed'
  name?: string
  description?: string
  cron: string // 5-field cron expression
  prompt: string
  createdAt: number // epoch ms
  lastFiredAt?: string // ISO timestamp of last execution
  enabled?: boolean // allow disabling without deleting (default true)
  recurring?: boolean
  permanent?: boolean
  permissionMode?: string
  model?: string
  providerId?: string | null
  folderPath?: string
  useWorktree?: boolean
  notification?: TaskNotificationConfig
}

type TasksFile = {
  schemaVersion?: number
  tasks: CronTask[]
  creations?: Record<string, { input: string; taskId: string }>
  [key: string]: unknown
}

export type CreateCronTaskInput = Omit<CronTask, 'id' | 'createdAt' | 'cron'> & { cron?: string }

const TASKS_FILE_WRITE_ATTEMPTS = 2

/**
 * 每个任务文件一条互斥队列（模块级，跨实例共享）。
 * 调度器会在同一分钟并发启动多个任务（各自调用 updateLastFired），
 * API 的增删改也可能与调度器写入交错；无互斥时后完成的写回会覆盖
 * 先完成的修改（执行时间丢失、创建不落盘、已删除任务复活）。
 * 注意 API 层（scheduled-tasks.ts）与调度器（cronScheduler.ts）持有
 * 不同的 CronService 实例，因此队列必须按文件路径共享而非挂在实例上。
 */
const mutationQueues = new Map<string, Promise<unknown>>()

/** 在指定文件的互斥队列中执行变更操作，保留其原始结果/错误。 */
function runExclusive<T>(filePath: string, operation: () => Promise<T>): Promise<T> {
  const previous = mutationQueues.get(filePath) ?? Promise.resolve()
  const result = previous.then(operation)
  mutationQueues.set(
    filePath,
    result.then(
      () => undefined,
      () => undefined,
    ),
  )
  return result
}

export class CronService {
  /** 任务文件路径 */
  private getTasksFilePath(): string {
    const configDir =
      process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
    return path.join(configDir, 'scheduled_tasks.json')
  }

  // ---------------------------------------------------------------------------
  // 公开方法
  // ---------------------------------------------------------------------------

  /** 获取所有任务 */
  async listTasks(): Promise<CronTask[]> {
    const data = await this.readTasksFile()
    return data.tasks.map(task => this.snapshot(task))
  }

  /** 创建新任务 */
  async createTask(
    task: CreateCronTaskInput,
    options?: { sourceSessionId?: string; requestId?: string },
  ): Promise<CronTask> {
    if ((!task.cron && !task.schedule) || !task.prompt) {
      throw ApiError.badRequest('Fields "cron" and "prompt" are required')
    }

    this.validateTask(task)
    return runExclusive(this.getTasksFilePath(), async () => {
      const data = await this.readTasksFile()
      const creationKey = options?.requestId ? `${options.sourceSessionId ?? task.sourceSessionId ?? ''}:${options.requestId}` : undefined
      const input = JSON.stringify(task)
      const previous = creationKey ? data.creations?.[creationKey] : undefined
      if (previous) {
        if (previous.input !== input) throw ApiError.conflict('Request ID was already used with different task input')
        const existing = data.tasks.find(item => item.id === previous.taskId)
        if (!existing) throw ApiError.conflict('The task created by this request was deleted')
        return this.snapshot(existing)
      }
      if (task.schedule?.kind === 'once' && Date.parse(task.schedule.runAt) <= Date.now()) throw ApiError.badRequest('One-time task must be scheduled in the future')
      const newTask: CronTask = {
        ...task,
        cron: task.schedule?.kind === 'cron' ? task.schedule.expression : task.cron ?? '',
        ...(task.execution ? {} : { permissionMode: 'bypassPermissions' }),
        sourceSessionId: options?.sourceSessionId ?? task.sourceSessionId,
        recurring: task.schedule ? task.schedule.kind === 'cron' : task.recurring,
        revision: 1,
        id: crypto.randomBytes(4).toString('hex'),
        createdAt: Date.now(),
      }
      data.tasks.push(newTask)
      if (creationKey) (data.creations ??= {})[creationKey] = { input, taskId: newTask.id }
      await this.writeTasksFile(data)
      return this.snapshot(newTask)
    })
  }

  /** 更新已有任务 */
  async updateTask(id: string, updates: Partial<CronTask>, options?: { expectedRevision?: number }): Promise<CronTask> {
    return runExclusive(this.getTasksFilePath(), async () => {
      const data = await this.readTasksFile()
      const index = data.tasks.findIndex((t) => t.id === id)
      if (index === -1) {
        throw ApiError.notFound(`Task not found: ${id}`)
      }

      if (options?.expectedRevision !== undefined && options.expectedRevision !== (data.tasks[index].revision ?? 1)) throw ApiError.conflict('Task was changed; reload before updating')
      this.validateTask({ ...data.tasks[index], ...updates })
      const onceSchedule = updates.schedule ?? data.tasks[index].schedule
      if ((updates.schedule || updates.enabled === true) && onceSchedule?.kind === 'once' && Date.parse(onceSchedule.runAt) <= Date.now()) throw ApiError.badRequest('One-time task must be scheduled in the future')
      // 不允许修改 id 和 createdAt
      const { id: _id, createdAt: _ca, revision: _revision, nextRunAt: _next, scheduleState: _state, ...safeUpdates } = updates
      data.tasks[index] = {
        ...data.tasks[index],
        ...safeUpdates,
        ...((safeUpdates.execution ?? data.tasks[index].execution) ? {} : { permissionMode: 'bypassPermissions' }),
        ...(safeUpdates.schedule ? { cron: safeUpdates.schedule.kind === 'cron' ? safeUpdates.schedule.expression : '', recurring: safeUpdates.schedule.kind === 'cron' } : {}),
        ...(safeUpdates.schedule || (safeUpdates.enabled === true && data.tasks[index].enabled === false) ? { completedAt: undefined, scheduleAnchorAt: Math.max(Date.now(), data.tasks[index].lastFiredAt ? Date.parse(data.tasks[index].lastFiredAt) + 1 : 0) } : {}),
        revision: (data.tasks[index].revision ?? 1) + 1,
      }
      await this.writeTasksFile(data)
      return this.snapshot(data.tasks[index])
    })
  }

  /** 删除任务 */
  async deleteTask(id: string, options?: { expectedRevision?: number }): Promise<void> {
    return runExclusive(this.getTasksFilePath(), async () => {
      const data = await this.readTasksFile()
      const index = data.tasks.findIndex((t) => t.id === id)
      if (index === -1) {
        throw ApiError.notFound(`Task not found: ${id}`)
      }
      if (options?.expectedRevision !== undefined && options.expectedRevision !== (data.tasks[index].revision ?? 1)) throw ApiError.conflict('Task was changed; reload before deleting')
      data.tasks.splice(index, 1)
      await this.writeTasksFile(data)
    })
  }

  /** 更新任务的最后执行时间 */
  async updateLastFired(taskId: string, timestamp: string, options?: { expectedRevision?: number }): Promise<void> {
    return runExclusive(this.getTasksFilePath(), async () => {
      const data = await this.readTasksFile()
      const index = data.tasks.findIndex((t) => t.id === taskId)
      if (index === -1) {
        return // Task may have been deleted; silently ignore
      }
      const task = data.tasks[index]
      if (options?.expectedRevision !== undefined && options.expectedRevision !== (task.revision ?? 1)) return
      // Recovery may race a later occurrence; an older receipt must not rewind it.
      if (task.lastFiredAt && Date.parse(task.lastFiredAt) >= Date.parse(timestamp)) return
      task.lastFiredAt = timestamp
      await this.writeTasksFile(data)
    })
  }

  async getTask(id: string): Promise<CronTask | undefined> {
    return (await this.listTasks()).find(task => task.id === id)
  }

  private validateTask(task: CreateCronTaskInput): void {
    if (typeof task.prompt !== 'string' || !task.prompt.trim()) throw ApiError.badRequest('Task prompt is required')
    if (task.schedule) validateTaskSchedule(task.schedule)
    else if (typeof task.cron !== 'string' || !parseCronExpression(task.cron)) throw ApiError.badRequest('Invalid 5-field cron expression')
    if (task.execution && (task.execution.kind !== 'new-session' && (task.execution.kind !== 'session' || typeof task.execution.targetSessionId !== 'string' || !task.execution.targetSessionId.trim()))) throw ApiError.badRequest('Invalid task execution target')
    if (task.notificationPolicy !== undefined && !['important', 'all', 'failed', 'none'].includes(task.notificationPolicy)) throw ApiError.badRequest('Invalid notification policy')
  }

  private snapshot(task: CronTask): CronTask {
    const onceAlreadyClaimed = task.schedule?.kind === 'once' && !!task.lastFiredAt && Date.parse(task.lastFiredAt) >= (task.scheduleAnchorAt ?? task.createdAt)
    const next = task.enabled !== false && task.schedule && !onceAlreadyClaimed
      ? nextScheduledTime(task.schedule, Math.max(task.scheduleAnchorAt ?? task.createdAt, task.lastFiredAt ? Date.parse(task.lastFiredAt) : 0))
      : null
    return {
      ...task, revision: task.revision ?? 1,
      ...(task.execution ? {} : { permissionMode: 'bypassPermissions' }),
      nextRunAt: next ?? undefined,
      scheduleState: task.enabled === false ? (task.schedule?.kind === 'once' && task.completedAt ? 'completed' : 'paused') : 'active',
    }
  }

  // ---------------------------------------------------------------------------
  // 内部: 文件读写
  // ---------------------------------------------------------------------------

  /**
   * 读取任务 JSON 文件。文件不存在、或内容为空（空白 / 全 NUL，见 isBlankFileContent）
   * 时返回空列表；带 UTF-8 BOM 的文件（PowerShell 5.x 默认写入）照常解析。
   * 有实际内容却无法解析时仍然抛错：此时文件可能还能人工恢复，绝不能让后续写入悄悄覆盖它。
   */
  private async readTasksFile(): Promise<TasksFile> {
    try {
      const raw = await fs.readFile(this.getTasksFilePath(), 'utf-8')
      if (isBlankFileContent(raw)) {
        return { tasks: [] }
      }
      const parsed = JSON.parse(stripBOM(raw)) as TasksFile
      // 兼容异常格式
      if (!Array.isArray(parsed.tasks)) {
        return { tasks: [] }
      }
      // Additive v1 migration: preserve legacy execution/time semantics and unknown fields.
      return migrateScheduledTasks(parsed) as TasksFile
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return { tasks: [] }
      }
      throw ApiError.internal(
        `Failed to read scheduled tasks: ${(err as Error).message}`,
      )
    }
  }

  /** 原子写入任务 JSON 文件 */
  private async writeTasksFile(data: TasksFile): Promise<void> {
    const filePath = this.getTasksFilePath()
    const dir = path.dirname(filePath)
    const contents = JSON.stringify({ ...data, schemaVersion: 1 }, null, 2) + '\n'
    let lastError: Error | undefined

    for (let attempt = 0; attempt < TASKS_FILE_WRITE_ATTEMPTS; attempt++) {
      const tmpFile = `${filePath}.tmp.${process.pid}.${Date.now()}.${crypto.randomBytes(6).toString('hex')}`

      try {
        await fs.mkdir(dir, { recursive: true })
        await fs.writeFile(tmpFile, contents, 'utf-8')
        await fs.rename(tmpFile, filePath)
        return
      } catch (err) {
        lastError = err as Error
        await fs.unlink(tmpFile).catch(() => {})

        // EPERM: Windows 上与其他进程同时 rename 到同一目标可能瞬时失败，
        // 与 ENOENT 一样属于可重试的瞬时错误。
        const code = (err as NodeJS.ErrnoException).code
        const retryable = code === 'ENOENT' || code === 'EPERM'
        if (!retryable || attempt === TASKS_FILE_WRITE_ATTEMPTS - 1) {
          break
        }
      }
    }

    throw ApiError.internal(
      `Failed to write scheduled tasks: ${lastError?.message ?? 'unknown error'}`,
    )
  }
}
