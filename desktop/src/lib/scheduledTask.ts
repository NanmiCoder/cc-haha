import type { CronTask, ScheduledTaskTrigger, TaskRun } from '@/types/task'
import { describeCron } from '@/lib/cronDescribe'
import type { TranslationKey } from '@/i18n/locales/en'

export type ScheduledTaskResult = {
  schemaVersion: 1
  kind: 'scheduled_task'
  operation: 'created' | 'updated' | 'viewed' | 'deleted'
  taskId: string
  task: CronTask
}

export type ScheduledTaskRunsResult = {
  schemaVersion: 1
  kind: 'scheduled_task_runs'
  runs: TaskRun[]
}

export type ScheduledTaskListResult = {
  schemaVersion: 1
  kind: 'scheduled_task_list'
  tasks: Array<Pick<CronTask, 'id' | 'cron'> & Partial<CronTask> & { promptPreview?: string }>
  totalCount?: number
}

function record(value: unknown): Record<string, unknown> | null {
  if (typeof value === 'string') {
    try { return record(JSON.parse(value)) } catch { return null }
  }
  if (Array.isArray(value)) {
    if (value.length !== 1) return null
    return record(value[0]?.text)
  }
  return value && typeof value === 'object' ? value as Record<string, unknown> : null
}

function validSchedule(value: unknown): boolean {
  if (value === undefined) return true
  const schedule = record(value)
  return !!schedule && typeof schedule.timeZone === 'string' && (
    schedule.kind === 'once' ? typeof schedule.runAt === 'string' : schedule.kind === 'cron' && typeof schedule.expression === 'string'
  )
}

function validTaskSummary(task: Record<string, unknown>): boolean {
  return typeof task.id === 'string' && typeof task.cron === 'string' && validSchedule(task.schedule) &&
    (task.name === undefined || typeof task.name === 'string') && (task.enabled === undefined || typeof task.enabled === 'boolean')
}

/** Only the named tool's successful, versioned protocol produces UI cards. */
export function parseScheduledTaskResult(toolName: string, content: unknown, isError = false): ScheduledTaskResult | ScheduledTaskRunsResult | ScheduledTaskListResult | null {
  if (toolName !== 'ScheduledTask' || isError) return null
  const result = record(content)
  if (result?.schemaVersion !== 1) return null
  if (result.kind === 'scheduled_task_list' && Array.isArray(result.tasks) && result.tasks.every(task => {
    const entry = record(task)
    return entry && validTaskSummary(entry) && (entry.promptPreview === undefined || typeof entry.promptPreview === 'string')
  })) return result as ScheduledTaskListResult
  if (result.kind === 'scheduled_task_runs' && Array.isArray(result.runs) && result.runs.every(run => {
    const entry = record(run)
    return entry && typeof entry.id === 'string' && typeof entry.taskId === 'string' && typeof entry.status === 'string' &&
      ['taskName', 'startedAt', 'sessionId', 'output', 'error', 'outputPreview', 'errorPreview'].every(key => entry[key] === undefined || typeof entry[key] === 'string')
  })) return result as ScheduledTaskRunsResult
  if (result.kind !== 'scheduled_task' || typeof result.taskId !== 'string' ||
    !['created', 'updated', 'viewed', 'deleted'].includes(String(result.operation))) return null
  const task = record(result.task)
  if (!task || !validTaskSummary(task) || task.id !== result.taskId || typeof task.prompt !== 'string') return null
  return result as ScheduledTaskResult
}

export function validScheduledTaskTrigger(value: unknown): value is ScheduledTaskTrigger {
  const entry = record(value)
  return !!entry && ['taskId', 'runId', 'scheduledFor', 'taskName'].every(key => typeof entry[key] === 'string' && entry[key] !== '')
}

type Translate = (key: TranslationKey, params?: Record<string, string | number>) => string

export function describeTaskSchedule(task: Pick<CronTask, 'schedule' | 'cron'>, t: Translate): string {
  if (task.schedule?.kind === 'once') {
    return `${t('scheduledChat.once')} · ${formatTaskDate(task.schedule.runAt, task.schedule.timeZone)}`
  }
  const cron = task.schedule?.kind === 'cron' ? task.schedule.expression : task.cron
  return describeCron(cron, t) + (task.schedule?.timeZone ? ` · ${task.schedule.timeZone}` : '')
}

export function formatTaskDate(value: string | number, timeZone?: string): string {
  try { return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short', timeZone }).format(new Date(value)) }
  catch { return String(value) }
}

export function taskIsAttached(task: CronTask, sessionId: string): boolean {
  return task.execution?.kind === 'session' && task.execution.targetSessionId === sessionId &&
    task.scheduleState !== 'completed'
}

export function dateTimeInZone(value: string, timeZone: string): string {
  try {
    const parts = new Intl.DateTimeFormat('sv-SE', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(value))
    const get = (type: string) => parts.find(p => p.type === type)?.value
    return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}`
  } catch { return '' }
}

/** Reject nonexistent wall times (DST gaps) rather than silently moving a task. */
export function zonedDateTimeToIso(value: string, timeZone: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return null
  const wall = Date.parse(`${value}:00Z`)
  if (!Number.isFinite(wall)) return null
  let candidate = wall
  for (let attempt = 0; attempt < 4; attempt++) {
    const displayed = dateTimeInZone(new Date(candidate).toISOString(), timeZone)
    if (!displayed) return null
    if (displayed === value) return new Date(candidate).toISOString()
    candidate += wall - Date.parse(`${displayed}:00Z`)
  }
  return null
}
