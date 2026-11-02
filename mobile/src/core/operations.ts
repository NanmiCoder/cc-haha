import type { ApiClient } from './client'
import type { HistoryEntry } from './types'
import { formatDuration } from './dashboard'
import type { TaskExecution, TaskNotificationConfig, TaskNotificationPolicy, TaskSchedule } from '../../../src/shared/taskSchedule'

export type RewindMode = 'both' | 'conversation' | 'code'
export type Checkpoint = {
  target: {
    targetUserMessageId: string
    userMessageIndex: number
    userMessageCount: number
  }
  conversation?: { messagesRemoved: number }
  code: {
    available: boolean
    reason?: string
    filesChanged: string[]
    insertions: number
    deletions: number
  }
  restoreAvailable?: boolean
  unverifiedChangeSources?: string[]
  startedAt?: number
}
export type DiffResponse = {
  state: 'ok' | 'missing' | 'not_git_repo' | 'error'
  path: string
  diff?: string
  error?: string
}
export type DiffLine = {
  text: string
  kind: 'context' | 'add' | 'remove' | 'hunk' | 'meta'
  before?: number
  after?: number
}
export function parseDiff(diff: string): DiffLine[] {
  let before = 0,
    after = 0
  return diff.split('\n').map((text) => {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text)
    if (hunk) {
      before = Number(hunk[1])
      after = Number(hunk[2])
      return { text, kind: 'hunk' }
    }
    if (
      /^(---|\+\+\+|diff |index |new file|deleted file|\\)/.test(text) ||
      (!before && !after)
    )
      return { text, kind: 'meta' }
    if (text.startsWith('+'))
      return { text: text.slice(1), kind: 'add', after: after++ }
    if (text.startsWith('-'))
      return { text: text.slice(1), kind: 'remove', before: before++ }
    if (text.startsWith(' '))
      return {
        text: text.slice(1),
        kind: 'context',
        before: before++,
        after: after++,
      }
    return { text, kind: 'meta' }
  })
}
export const sessionPath = (id: string) =>
  `/api/sessions/${encodeURIComponent(id)}`
export async function listCheckpoints(
  client: ApiClient,
  id: string,
  signal?: AbortSignal
) {
  return client.get<{ checkpoints: Checkpoint[] }>(
    `${sessionPath(id)}/turn-checkpoints`,
    { signal }
  )
}
export function checkpointDiff(
  client: ApiClient,
  id: string,
  target: Checkpoint['target'],
  path: string,
  signal?: AbortSignal
) {
  const query = new URLSearchParams({
    targetUserMessageId: target.targetUserMessageId,
    path,
  })
  return client.get<DiffResponse>(
    `${sessionPath(id)}/turn-checkpoints/diff?${query}`,
    { signal }
  )
}
export function rewind(
  client: ApiClient,
  id: string,
  target: Checkpoint['target'],
  mode: RewindMode,
  dryRun: boolean,
  signal?: AbortSignal
) {
  return client.post<Checkpoint>(
    `${sessionPath(id)}/rewind`,
    { targetUserMessageId: target.targetUserMessageId, mode, dryRun },
    { timeoutMs: 60000, signal }
  )
}
export const canRestoreCode = (checkpoint: Checkpoint | null | undefined) =>
  checkpoint?.restoreAvailable === true

export type BackgroundTask = {
  taskId: string
  toolUseId?: string
  taskType?: string
  description?: string
  status: 'running' | 'completed' | 'failed' | 'stopped'
  stopping?: boolean
  summary?: string
  result?: string
  outputFile?: string
  startedAt?: string
}
export type BackgroundSnapshot = {
  tasks: BackgroundTask[]
  historyComplete: boolean
}
export type SubagentOutput = {
  messages: HistoryEntry[]
  result?: string
  summary?: string
  truncated?: boolean
  status: string
}
export type BackgroundOutput = {
  taskId: string
  state: 'available' | 'empty' | 'missing'
  text: string
  totalBytes: number
  truncated: boolean
}
export type TaskOutput =
  | { kind: 'shell'; output: BackgroundOutput }
  | { kind: 'agent'; output: SubagentOutput }
  | { kind: 'notice'; text: string }
export const isAgent = (task: BackgroundTask) =>
  task.taskType === 'local_agent' || task.taskType === 'remote_agent'
/** 子 Agent 的只读 transcript；taskId 用来在同一个 toolUseId 下区分多次运行。 */
export function loadSubagentRun(
  client: ApiClient,
  sessionId: string,
  toolUseId: string,
  taskId: string | undefined,
  signal: AbortSignal
) {
  const query = taskId ? `?taskId=${encodeURIComponent(taskId)}` : ''
  return client.get<SubagentOutput>(
    `${sessionPath(sessionId)}/subagents/by-tool/${encodeURIComponent(toolUseId)}${query}`,
    { signal }
  )
}
export async function loadTaskOutput(
  client: ApiClient,
  sessionId: string,
  task: BackgroundTask,
  signal: AbortSignal
): Promise<TaskOutput> {
  if (isAgent(task) && task.toolUseId)
    return {
      kind: 'agent',
      output: await loadSubagentRun(client, sessionId, task.toolUseId, task.taskId, signal),
    }
  if (task.taskType === 'local_bash')
    return {
      kind: 'shell',
      output: await client.get<BackgroundOutput>(
        `${sessionPath(sessionId)}/background-tasks/${encodeURIComponent(task.taskId)}/output`,
        { signal }
      ),
    }
  return {
    kind: 'notice',
    text:
      task.result || task.summary || '电脑暂不提供此类任务的日志读取。',
  }
}
export function shellOutputText(output: BackgroundOutput) {
  if (output.state === 'missing')
    return '电脑上的任务日志暂未生成或已被清理。'
  if (output.state === 'empty') return '任务尚未写入输出。'
  return output.text
}
export function activityFromEvent(
  tasks: BackgroundTask[],
  event: unknown
): BackgroundTask[] {
  if (!event || typeof event !== 'object') return tasks
  const value = event as Record<string, unknown>
  if (
    value.type !== 'system_notification' ||
    !value.data ||
    typeof value.data !== 'object'
  )
    return tasks
  const data = value.data as Record<string, unknown>
  if (
    typeof data.task_id !== 'string' ||
    data.owner_agent_id ||
    data.task_type === 'in_process_teammate'
  )
    return tasks
  const existing = tasks.find((task) => task.taskId === data.task_id)
  const status =
    value.subtype === 'task_started' || value.subtype === 'task_progress'
      ? 'running'
      : data.status === 'killed'
        ? 'stopped'
        : data.status
  if (!['running', 'completed', 'failed', 'stopped'].includes(String(status)))
    return tasks
  const task: BackgroundTask = {
    ...existing,
    taskId: data.task_id,
    status: status as BackgroundTask['status'],
  }
  for (const [wire, key] of [
    ['tool_use_id', 'toolUseId'],
    ['task_type', 'taskType'],
    ['description', 'description'],
    ['summary', 'summary'],
    ['result', 'result'],
    ['output_file', 'outputFile'],
  ] as const)
    if (typeof data[wire] === 'string') task[key] = data[wire] as string
  return existing
    ? tasks.map((item) => (item.taskId === task.taskId ? task : item))
    : [...tasks, task]
}
export function taskElapsed(task: BackgroundTask, now = Date.now()) {
  if (!task.startedAt) return ''
  const since = Date.parse(task.startedAt)
  if (!Number.isFinite(since)) return ''
  return formatDuration((now - since) / 1000)
}

export type ScheduledTask = {
  id: string
  name?: string
  description?: string
  cron: string
  prompt: string
  enabled?: boolean
  recurring?: boolean
  permanent?: boolean
  folderPath?: string
  lastFiredAt?: string
  createdAt: number
  permissionMode?: string
  schedule?: TaskSchedule
  execution?: TaskExecution
  revision?: number
  nextRunAt?: number
  scheduleState?: 'active' | 'paused' | 'completed'
  model?: string
  providerId?: string | null
  useWorktree?: boolean
  notificationPolicy?: TaskNotificationPolicy
  notification?: TaskNotificationConfig
}
export type TaskRun = {
  id: string
  taskId: string
  taskName: string
  startedAt: string
  completedAt?: string
  status: 'running' | 'completed' | 'failed' | 'timeout'
  output?: string
  error?: string
  outputPreview?: string
  errorPreview?: string
  sessionId?: string
  durationMs?: number
}
export function latestRuns(runs: TaskRun[]) {
  const result = new Map<string, TaskRun>()
  for (const run of runs)
    if (
      !result.has(run.taskId) ||
      Date.parse(run.startedAt) > Date.parse(result.get(run.taskId)!.startedAt)
    )
      result.set(run.taskId, run)
  return result
}
export function dailyCron(time: string, weekdays: boolean) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(time.trim())
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59)
    throw new Error('请输入有效时间，例如 09:00')
  return `${Number(match[2])} ${Number(match[1])} * * ${weekdays ? '1-5' : '*'}`
}
export function scheduleLabel(cron: string) {
  const match = /^(\d+) (\d+) \* \* (\*|1-5)$/.exec(cron)
  return match
    ? `${match[3] === '*' ? '每天' : '工作日'} ${match[2]!.padStart(2, '0')}:${match[1]!.padStart(2, '0')}`
    : cron
}
