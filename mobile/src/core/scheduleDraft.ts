import {
  buildCron,
  dateTimeInZone,
  isValidCron,
  parseCron,
  zonedDateTimeToIso,
  type ParsedCron,
  type TaskExecution,
  type TaskNotificationConfig,
  type TaskNotificationPolicy,
  type TaskSchedule,
} from '../../../src/shared/taskSchedule'
import type { ScheduledTask } from './operations'
import type { RuntimeConfig } from './types'

export type ScheduleDraft = Omit<ParsedCron, 'frequency'> & {
  frequency: ParsedCron['frequency'] | 'once'
  runAt: string
  /** Local draft only: retain which instant a quick choice or existing plan meant. */
  runAtInstant?: string
  timeZone: string
  legacy?: boolean
}

export function newScheduleDraft(timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone, now = Date.now()): ScheduleDraft {
  const runAtInstant = new Date(Math.ceil((now + 30 * 60_000) / 60_000) * 60_000).toISOString()
  return {
    ...parseCron('0 9 * * *'),
    runAt: dateTimeInZone(runAtInstant, timeZone),
    runAtInstant,
    timeZone,
  }
}

export function scheduleDraftForTask(task: Pick<ScheduledTask, 'cron' | 'schedule'>): ScheduleDraft {
  const draft = newScheduleDraft(task.schedule?.timeZone)
  if (task.schedule?.kind === 'once') {
    return { ...draft, frequency: 'once', runAt: dateTimeInZone(task.schedule.runAt, task.schedule.timeZone), runAtInstant: task.schedule.runAt }
  }
  return { ...draft, ...parseCron(task.schedule?.expression ?? task.cron), ...(!task.schedule ? { legacy: true } : {}) }
}

export type SchedulePreset = 'halfHour' | 'tomorrow' | 'workdays'

/** Presets use the selected timezone, including when phone and computer differ. */
export function applySchedulePreset(draft: ScheduleDraft, preset: SchedulePreset, now = Date.now()): ScheduleDraft {
  try { new Intl.DateTimeFormat('en', { timeZone: draft.timeZone }).format(now) }
  catch { throw new Error('请输入有效时区，例如 Asia/Shanghai') }
  if (preset === 'workdays') return { ...draft, frequency: 'weekdays', time: '09:00', legacy: false }
  if (preset === 'halfHour') {
    const at = Math.ceil((now + 30 * 60_000) / 60_000) * 60_000
    const runAtInstant = new Date(at).toISOString()
    return { ...draft, frequency: 'once', runAt: dateTimeInZone(runAtInstant, draft.timeZone), runAtInstant, legacy: false }
  }
  const today = dateTimeInZone(new Date(now).toISOString(), draft.timeZone).slice(0, 10)
  const tomorrow = new Date(`${today}T12:00:00Z`)
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1)
  return { ...draft, frequency: 'once', runAt: `${tomorrow.toISOString().slice(0, 10)}T09:00`, legacy: false }
}

export function scheduleFromDraft(draft: ScheduleDraft, now = Date.now(), original?: TaskSchedule): TaskSchedule {
  try { new Intl.DateTimeFormat('en', { timeZone: draft.timeZone }).format(now) }
  catch { throw new Error('请输入有效时区，例如 Asia/Shanghai') }
  if (draft.frequency === 'once') {
    const anchoredRunAt = draft.runAtInstant && dateTimeInZone(draft.runAtInstant, draft.timeZone) === draft.runAt
      ? draft.runAtInstant : undefined
    // An unchanged edit must retain seconds and the instant in a DST overlap.
    // A quick choice can deliberately select the other half of that same wall time.
    if (original?.kind === 'once' && original.timeZone === draft.timeZone && dateTimeInZone(original.runAt, original.timeZone) === draft.runAt &&
      (!anchoredRunAt || Date.parse(anchoredRunAt) === Date.parse(original.runAt))) return original
    const runAt = anchoredRunAt ?? zonedDateTimeToIso(draft.runAt, draft.timeZone)
    if (!runAt || Date.parse(runAt) <= now) throw new Error('请选择未来的有效日期和时间')
    return { kind: 'once', runAt, timeZone: draft.timeZone }
  }
  if (draft.frequency === 'specificDays' && (!draft.selectedDays.length || draft.selectedDays.some(day => !Number.isInteger(day) || day < 0 || day > 7))) throw new Error('请至少选择一周中的一天')
  if (['daily', 'weekdays', 'specificDays', 'monthly'].includes(draft.frequency) && !/^\d{1,2}:\d{2}$/.test(draft.time)) throw new Error('请输入有效时间，例如 09:00')
  const expression = buildCron(draft.frequency, draft.time, draft)
  if (!isValidCron(expression)) throw new Error('请输入有效的五段 Cron 表达式或执行时间')
  return { kind: 'cron', expression, timeZone: draft.timeZone }
}

export function scheduleUpdate(draft: ScheduleDraft, task: ScheduledTask, now = Date.now()) {
  const revision = task.revision === undefined ? {} : { expectedRevision: task.revision }
  const initial = scheduleDraftForTask(task)
  if (draft.frequency !== 'once' && initial.frequency !== 'once') {
    const unchanged = buildCron(draft.frequency, draft.time, draft) === buildCron(initial.frequency, initial.time, initial)
    if (draft.legacy && !task.schedule) {
      const schedule = scheduleFromDraft(draft, now)
      if (unchanged) return null
      // Old cron tasks retain host-local timing and their existing recurring flag.
      return { cron: schedule.kind === 'cron' ? schedule.expression : '', ...revision }
    }
    if (unchanged && draft.timeZone === task.schedule?.timeZone) return null
  }
  const schedule = scheduleFromDraft(draft, now, task.schedule)
  const previous = task.schedule
  if (previous?.timeZone === schedule.timeZone && (
    schedule.kind === 'once' && previous.kind === 'once' ? schedule.runAt === previous.runAt
      : schedule.kind === 'cron' && previous.kind === 'cron' && schedule.expression === previous.expression
  )) return null
  return {
    schedule,
    recurring: schedule.kind === 'cron',
    ...(schedule.kind === 'cron' ? { cron: schedule.expression } : {}),
    ...revision,
  }
}

export type ScheduleCreateOptions = {
  name: string
  prompt: string
  execution: TaskExecution
  folderPath: string
  runtime?: RuntimeConfig
  /** Omit explicit OAuth identity when using the computer's native settings/env. */
  followDefaultRuntime?: boolean
  useWorktree: boolean
  notificationPolicy: TaskNotificationPolicy
  channels: TaskNotificationConfig['channels']
}

export function createScheduleInput(options: ScheduleCreateOptions, draft: ScheduleDraft, now = Date.now()) {
  const prompt = options.prompt.trim()
  if (!prompt) throw new Error('请填写要执行的内容')
  const schedule = scheduleFromDraft(draft, now)
  if (options.execution.kind === 'session' && !options.execution.targetSessionId) throw new Error('请选择要执行的会话')
  if (options.execution.kind === 'new-session' && !options.folderPath.trim()) throw new Error('请选择电脑上的项目目录')
  if (options.notificationPolicy !== 'none' && !options.channels.length) throw new Error('请至少选择一个通知渠道')
  return {
    name: options.name.trim() || prompt.split('\n').find(line => line.trim())!.slice(0, 40),
    prompt,
    enabled: true,
    recurring: schedule.kind === 'cron',
    schedule,
    ...(schedule.kind === 'cron' ? { cron: schedule.expression } : {}),
    execution: options.execution,
    ...(options.execution.kind === 'new-session' ? {
      folderPath: options.folderPath.trim(),
      permissionMode: 'bypassPermissions',
      ...(options.runtime && !options.followDefaultRuntime ? { model: options.runtime.modelId, providerId: options.runtime.providerId } : {}),
      ...(options.useWorktree ? { useWorktree: true } : {}),
    } : {}),
    notificationPolicy: options.notificationPolicy,
    notification: { enabled: options.notificationPolicy !== 'none', channels: options.notificationPolicy === 'none' ? [] : options.channels },
  }
}
