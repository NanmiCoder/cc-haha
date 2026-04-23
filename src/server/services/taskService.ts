/**
 * TaskService — CLI Task V2 的读取与查询
 *
 * 任务信息存储在 ~/.claude/tasks/<task_list_id>/ 目录下，每个任务一个 JSON 文件。
 * Task list ID 可以是 session ID、team name 等。
 */

import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'

export type TaskStatus = 'pending' | 'in_progress' | 'completed'

export type TaskInfo = {
  id: string
  subject: string
  description: string
  activeForm?: string
  owner?: string
  status: TaskStatus
  blocks: string[]
  blockedBy: string[]
  metadata?: Record<string, unknown>
  taskListId: string
}

export type TaskListSummary = {
  id: string
  taskCount: number
  completedCount: number
  inProgressCount: number
  pendingCount: number
}

export class TaskService {
  private getConfigDir(): string {
    return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
  }

  private getTasksDir(): string {
    return path.join(this.getConfigDir(), 'tasks')
  }

  /** 列出所有 task list (目录) */
  async listTaskLists(): Promise<TaskListSummary[]> {
    const tasksDir = this.getTasksDir()
    try {
      const entries = await fs.readdir(tasksDir, { withFileTypes: true })
      const results: TaskListSummary[] = []

      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        const tasks = await this.getTasksForList(entry.name)
        if (tasks.length === 0) continue

        results.push({
          id: entry.name,
          taskCount: tasks.length,
          completedCount: tasks.filter((t) => t.status === 'completed').length,
          inProgressCount: tasks.filter((t) => t.status === 'in_progress').length,
          pendingCount: tasks.filter((t) => t.status === 'pending').length,
        })
      }

      return results
    } catch (err: any) {
      if (err.code === 'ENOENT') return []
      throw err
    }
  }

  /** 获取指定 task list 的所有任务 */
  async getTasksForList(taskListId: string): Promise<TaskInfo[]> {
    const listDir = path.join(this.getTasksDir(), taskListId)
    try {
      const entries = await fs.readdir(listDir)
      const tasks: TaskInfo[] = []

      for (const filename of entries) {
        if (!filename.endsWith('.json')) continue
        try {
          const raw = await fs.readFile(path.join(listDir, filename), 'utf-8')
          const data = JSON.parse(raw)
          const task = this.parseTaskFile(data, taskListId)
          if (task) tasks.push(task)
        } catch {
          // skip unparseable files
        }
      }

      // Sort by numeric ID
      return tasks.sort((a, b) => {
        const numA = parseInt(a.id, 10)
        const numB = parseInt(b.id, 10)
        if (!isNaN(numA) && !isNaN(numB)) return numA - numB
        return a.id.localeCompare(b.id)
      })
    } catch (err: any) {
      if (err.code === 'ENOENT') return []
      throw err
    }
  }

  /** 列出所有任务（跨所有 task list） */
  async listTasks(): Promise<TaskInfo[]> {
    const taskLists = await this.listTaskLists()
    const allTasks: TaskInfo[] = []
    for (const list of taskLists) {
      const tasks = await this.getTasksForList(list.id)
      allTasks.push(...tasks)
    }
    return allTasks
  }

  /** 获取单个任务详情 */
  async getTask(taskListId: string, taskId: string): Promise<TaskInfo | null> {
    const tasks = await this.getTasksForList(taskListId)
    return tasks.find((t) => t.id === taskId) || null
  }

  /** 解析单个任务文件 — 匹配 CLI V2 Task 格式 */
  private parseTaskFile(data: any, taskListId: string): TaskInfo | null {
    if (!data || typeof data !== 'object') return null
    if (!data.id || !data.subject) return null

    // Skip internal tasks
    if (data.metadata?._internal) return null

    return {
      id: String(data.id),
      subject: data.subject || '',
      description: data.description || '',
      activeForm: data.activeForm,
      owner: data.owner,
      status: (['pending', 'in_progress', 'completed'].includes(data.status)
        ? data.status
        : 'pending') as TaskStatus,
      blocks: Array.isArray(data.blocks) ? data.blocks : [],
      blockedBy: Array.isArray(data.blockedBy) ? data.blockedBy : [],
      metadata: data.metadata,
      taskListId,
    }
  }
}

export const taskService = new TaskService()
