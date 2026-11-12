import { formatDuration } from './dashboard'
import type { ScheduledTask, TaskRun } from './operations'
import { dateTimeInZone, parseCron } from '../../../src/shared/taskSchedule'

/**
 * Scheduled plans use their explicit timezone and the server's next occurrence.
 * Legacy string helpers remain available for older callers and fixtures.
 */

export type DailySchedule = { hour: number; minute: number; weekdays: boolean }

/** Run record summary: the summaryOnly list has no taskName/output/error; only the detail endpoint does. */
export type RunSummary = Pick<TaskRun, 'id' | 'taskId' | 'startedAt' | 'status'> &
  Partial<
    Pick<
      TaskRun,
      | 'taskName'
      | 'completedAt'
      | 'durationMs'
      | 'sessionId'
      | 'output'
      | 'error'
      | 'outputPreview'
      | 'errorPreview'
    >
  > & { hasOutput?: boolean; hasError?: boolean }

export type Tone = 'ok' | 'err' | 'attn' | 'run' | 'none'

export function parseDailyCron(cron: string): DailySchedule | null {
  const match = /^(\d{1,2}) (\d{1,2}) \* \* (\*|1-5)$/.exec(cron.trim())
  if (!match) return null
  const minute = Number(match[1])
  const hour = Number(match[2])
  if (hour > 23 || minute > 59) return null
  return { hour, minute, weekdays: match[3] === '1-5' }
}

/** Fixed days of the week: m h * * d[,d…], d is 0–7 (both 0 and 7 are Sunday). */
export type WeeklySchedule = { hour: number; minute: number; days: number[] }
export function parseWeeklyCron(cron: string): WeeklySchedule | null {
  const match = /^(\d{1,2}) (\d{1,2}) \* \* ([0-7](?:,[0-7])*)$/.exec(cron.trim())
  if (!match) return null
  const minute = Number(match[1])
  const hour = Number(match[2])
  if (hour > 23 || minute > 59) return null
  const days = [...new Set(match[3]!.split(',').map((day) => Number(day) % 7))].sort(
    (a, b) => ((a + 6) % 7) - ((b + 6) % 7)
  )
  return { hour, minute, days }
}
const weekdayDigits = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const weekdayFull = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

/** 1st, 2nd, 3rd, 4th … 11th, 12th, 13th, 21st. */
export const ordinal = (day: number) => {
  const teen = day % 100 >= 11 && day % 100 <= 13
  const suffix = teen ? 'th' : ['th', 'st', 'nd', 'rd'][day % 10] ?? 'th'
  return `${day}${suffix}`
}

const pad = (value: number) => String(value).padStart(2, '0')
export const clockLabel = (date: Date) =>
  `${pad(date.getHours())}:${pad(date.getMinutes())}`

/** Same rule as operations.dailyCron: H:mm or HH:mm, hours 0–23, minutes 0–59. */
export function isClockValid(time: string) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(time.trim())
  return !!match && Number(match[1]) <= 23 && Number(match[2]) <= 59
}

/** Separate recurrence and clock captions; preserve unknown expressions verbatim. */
export function scheduleParts(cron: string) {
  const parsed = parseDailyCron(cron)
  if (!parsed) {
    const weekly = parseWeeklyCron(cron)
    if (weekly) return {
          repeat: weekly.days.length === 1
            ? `Every ${weekdayFull[weekly.days[0]!]}`
            : `Every ${weekly.days.map((day) => weekdayDigits[day]).join(', ')}`,
          time: `${pad(weekly.hour)}:${pad(weekly.minute)}`,
        }
    const parsed = parseCron(cron)
    if (parsed.frequency === 'monthly') return { repeat: `Monthly on the ${ordinal(parsed.monthDay)}`, time: parsed.time }
    if (parsed.frequency === 'everyNMinutes') return { repeat: `Every ${parsed.minuteInterval} minutes`, time: '' }
    if (parsed.frequency === 'everyNHours') return { repeat: `Every ${parsed.hourInterval} hours`, time: parsed.minuteOffset ? `at minute ${parsed.minuteOffset}` : 'on the hour' }
    return null
  }
  return {
    repeat: parsed.weekdays ? 'Weekdays' : 'Daily',
    time: `${pad(parsed.hour)}:${pad(parsed.minute)}`,
  }
}

const isWorkday = (date: Date) => date.getDay() >= 1 && date.getDay() <= 5

/** Next trigger time (phone local time zone); returns null if it cannot be computed. */
export function nextRunAt(cron: string | ScheduledTask, now = new Date()): Date | null {
  if (typeof cron !== 'string') {
    if (cron.enabled === false || cron.scheduleState === 'completed') return null
    const at = cron.nextRunAt ?? (cron.schedule?.kind === 'once' ? Date.parse(cron.schedule.runAt) : NaN)
    return Number.isFinite(at) && at > now.getTime() ? new Date(at) : null
  }
  const parsed = parseDailyCron(cron)
  if (!parsed) {
    const weekly = parseWeeklyCron(cron)
    if (!weekly) return null
    const candidate = new Date(now)
    candidate.setHours(weekly.hour, weekly.minute, 0, 0)
    for (let index = 0; index < 8; index += 1) {
      if (candidate.getTime() > now.getTime() && weekly.days.includes(candidate.getDay()))
        return candidate
      candidate.setDate(candidate.getDate() + 1)
    }
    return null
  }
  const candidate = new Date(now)
  candidate.setHours(parsed.hour, parsed.minute, 0, 0)
  if (candidate.getTime() <= now.getTime())
    candidate.setDate(candidate.getDate() + 1)
  for (let index = 0; index < 7; index += 1) {
    if (!parsed.weekdays || isWorkday(candidate)) return candidate
    candidate.setDate(candidate.getDate() + 1)
  }
  return null
}

const dayStart = (date: Date) =>
  new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
/** Difference in calendar days: 0 today, -1 yesterday, 1 tomorrow. Counted by calendar day, unaffected by DST. */
function dayOffset(date: Date, now: Date) {
  return Math.round((dayStart(date) - dayStart(now)) / 86400000)
}

function toDate(value: Date | string | number) {
  const date = value instanceof Date ? value : new Date(value)
  return Number.isFinite(date.getTime()) ? date : null
}

/** Today 09:00 · Yesterday 23:30 · Tomorrow 09:00 · 10/23 23:30 (with year across years). */
export function dayTimeLabel(value: Date | string | number, now = new Date()) {
  const date = toDate(value)
  if (!date) return ''
  const offset = dayOffset(date, now)
  const time = clockLabel(date)
  if (offset === 0) return `Today ${time}`
  if (offset === -1) return `Yesterday ${time}`
  if (offset === 1) return `Tomorrow ${time}`
  const day = `${date.getMonth() + 1}/${date.getDate()}`
  return date.getFullYear() === now.getFullYear()
    ? `${day} ${time}`
    : `${date.getFullYear()}/${day} ${time}`
}

const weekdayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/** Only say which day (the time is already in the schedule): today / tonight / tomorrow / Mon / 10/27. */
export function nextDayLabel(value: Date, now = new Date()) {
  const offset = dayOffset(value, now)
  if (offset === 0) return value.getHours() >= 18 ? 'Tonight' : 'Today'
  if (offset === 1) return 'Tomorrow'
  if (offset > 1 && offset < 7) return weekdayNames[value.getDay()]!
  return `${value.getMonth() + 1}/${value.getDate()}`
}

/** The next occurrence caption uses the plan's timezone, like its clock above it. */
export function taskNextRunLabel(task: ScheduledTask, next: Date, now = new Date()) {
  if (!task.schedule) return `${nextDayLabel(next, now)} ${clockLabel(next)}`
  const wall = dateTimeInZone(next.toISOString(), task.schedule.timeZone)
  const today = dateTimeInZone(now.toISOString(), task.schedule.timeZone)
  const offset = (Date.parse(wall.slice(0, 10)) - Date.parse(today.slice(0, 10))) / 86400000
  const date = new Date(`${wall}:00Z`)
  const day = offset === 0 ? (date.getUTCHours() >= 18 ? 'Tonight' : 'Today') : offset === 1 ? 'Tomorrow'
    : offset > 1 && offset < 7 ? weekdayNames[date.getUTCDay()] : `${date.getUTCMonth() + 1}/${date.getUTCDate()}`
  return `${day} ${wall.slice(11)}`
}

/** Lowercases a leading relative day so it reads mid-sentence ("Done today 09:00"). */
const inline = (label: string) => label.replace(/^(Today|Yesterday|Tomorrow|Tonight)\b/, (day) => day.toLowerCase())

/** The "Last run" line for each task in the list. */
export function latestRunLine(
  run: RunSummary | undefined,
  cron: string | ScheduledTask,
  now = new Date()
): { tone: Tone; text: string } {
  if (!run) return { tone: 'none', text: 'No runs yet' }
  const at = inline(dayTimeLabel(run.startedAt, now))
  if (run.status === 'failed')
    return { tone: 'err', text: `Failed ${at} · tap to see the result` }
  if (run.status === 'timeout')
    return { tone: 'err', text: `Timed out ${at} · tap to see the result` }
  if (run.status === 'running')
    return { tone: 'run', text: `Started ${at} · running` }
  const next = nextRunAt(cron, now)
  return {
    tone: 'ok',
    text: next ? `Done ${at} · Next ${inline(typeof cron === 'string' ? `${nextDayLabel(next, now)} ${clockLabel(next)}` : taskNextRunLabel(cron, next, now))}` : `Done ${at}`,
  }
}

export function taskScheduleParts(task: Pick<ScheduledTask, 'cron' | 'schedule'>) {
  if (task.schedule?.kind === 'once') return { repeat: 'Once only', time: dateTimeInZone(task.schedule.runAt, task.schedule.timeZone).replace('T', ' ') }
  return scheduleParts(task.schedule?.expression ?? task.cron)
}

const firstLine = (text?: string) =>
  text
    ?.split('\n')
    .map((line) => line.trim())
    .find(Boolean)

/** The result line for "Last run" on the detail page: include the computer preview if any, otherwise just the status. */
export function runResultLine(run: RunSummary): { tone: Tone; text: string } {
  if (run.status === 'running') return { tone: 'run', text: 'Running' }
  if (run.status === 'completed') {
    const preview = firstLine(run.outputPreview ?? run.output)
    return { tone: 'ok', text: preview ? `Done · ${preview}` : 'Done' }
  }
  const label = run.status === 'timeout' ? 'Timed out' : 'Failed'
  const preview = firstLine(run.errorPreview ?? run.error)
  return {
    tone: run.status === 'timeout' ? 'attn' : 'err',
    text: preview ? `${label} · ${preview}` : `${label} · tap to see the result`,
  }
}

/** Run duration: finished ones use durationMs (or start/end time), running ones count up to now. */
export function runDuration(run: RunSummary, now = Date.now()) {
  if (typeof run.durationMs === 'number' && Number.isFinite(run.durationMs))
    return formatDuration(run.durationMs / 1000)
  const start = Date.parse(run.startedAt)
  if (!Number.isFinite(start)) return ''
  const end =
    run.status === 'running'
      ? now
      : run.completedAt
        ? Date.parse(run.completedAt)
        : NaN
  return Number.isFinite(end) ? formatDuration((end - start) / 1000) : ''
}

/** Project name = last segment of the directory; with no directory the computer runs in the user home. */
export function projectLabel(folderPath?: string) {
  const name = folderPath?.split(/[\\/]/).filter(Boolean).pop()
  return name || 'Computer default directory'
}

export function newestFirst<T extends { startedAt: string }>(runs: T[]) {
  return [...runs].sort(
    (a, b) => (Date.parse(b.startedAt) || 0) - (Date.parse(a.startedAt) || 0)
  )
}

/** Most recent run of each task (summaryOnly records also work). */
export function latestByTask<T extends { taskId: string; startedAt: string }>(runs: T[]) {
  const result = new Map<string, T>()
  for (const run of runs) {
    const current = result.get(run.taskId)
    if (!current || (Date.parse(run.startedAt) || 0) > (Date.parse(current.startedAt) || 0))
      result.set(run.taskId, run)
  }
  return result
}
