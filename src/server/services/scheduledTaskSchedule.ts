import { parseCronExpression } from '../../utils/cron.js'
import { ApiError } from '../middleware/errorHandler.js'

export type TaskSchedule =
  | { kind: 'once'; runAt: string; timeZone: string }
  | { kind: 'cron'; expression: string; timeZone: string }

const formatters = new Map<string, Intl.DateTimeFormat>()
function formatter(timeZone: string): Intl.DateTimeFormat {
  let value = formatters.get(timeZone)
  if (!value) {
    try {
      value = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' })
    } catch { throw ApiError.badRequest('Invalid schedule timeZone') }
    formatters.set(timeZone, value)
  }
  return value
}

export function validateTaskSchedule(schedule: TaskSchedule): void {
  if (!schedule || !['once', 'cron'].includes(schedule.kind) || typeof schedule.timeZone !== 'string') throw ApiError.badRequest('Invalid schedule')
  formatter(schedule.timeZone)
  if (schedule.kind === 'once') {
    if (typeof schedule.runAt !== 'string' || !/(Z|[+-]\d{2}:\d{2})$/.test(schedule.runAt) || !Number.isFinite(Date.parse(schedule.runAt))) {
      throw ApiError.badRequest('runAt must be an ISO timestamp with an explicit offset')
    }
  } else if (typeof schedule.expression !== 'string' || !parseCronExpression(schedule.expression)) {
    throw ApiError.badRequest('Invalid 5-field cron expression')
  }
}

const nextCache = new Map<string, number | null>()
const DAY_MS = 86_400_000

/**
 * Jump between matching calendar dates over a complete Gregorian cycle. Only
 * candidate dates need timezone conversion; scanning their bounded UTC windows
 * preserves DST gaps, overlaps and non-hour offsets without guessing an offset.
 */
export function nextScheduledTime(schedule: TaskSchedule, afterMs: number): number | null {
  if (schedule.kind === 'once') return Date.parse(schedule.runAt)
  const fields = parseCronExpression(schedule.expression)
  if (!fields) return null
  const start = Math.floor(afterMs / 60_000) * 60_000 + 60_000
  const key = `${schedule.expression}|${schedule.timeZone}|${start}`
  if (nextCache.has(key)) return nextCache.get(key)!
  const fmt = formatter(schedule.timeZone)
  let found: number | null = null
  // IANA offsets are less than one day. Include the preceding nominal date so
  // schedules west of UTC and UTC-crossing local dates are both considered.
  const firstDate = new Date(Math.floor(start / DAY_MS) * DAY_MS - DAY_MS)
  const lastDate = new Date(firstDate)
  lastDate.setUTCFullYear(firstDate.getUTCFullYear() + 400)
  const hours = new Set(fields.hour)
  const minutes = new Set(fields.minute)
  dates: for (let year = firstDate.getUTCFullYear(); year <= lastDate.getUTCFullYear(); year++) {
    for (const month of fields.month) {
      for (const day of fields.dayOfMonth) {
        const date = new Date(0)
        date.setUTCFullYear(year, month - 1, day)
        const wallDate = date.getTime()
        if (date.getUTCMonth() !== month - 1 || wallDate < firstDate.getTime()) continue
        if (wallDate > lastDate.getTime() || (found !== null && wallDate - DAY_MS >= found)) break dates
        if (!fields.dayOfWeek.includes(date.getUTCDay())) continue
        for (let time = Math.max(start, wallDate - DAY_MS); time < wallDate + 2 * DAY_MS && (found === null || time < found); time += 60_000) {
          const parts = Object.fromEntries(fmt.formatToParts(time).map(part => [part.type, Number(part.value)]))
          if (parts.year === year && parts.month === month && parts.day === day && hours.has(parts.hour!) && minutes.has(parts.minute!)) {
            found = time
            break
          }
        }
      }
    }
  }
  if (nextCache.size >= 128) nextCache.clear()
  nextCache.set(key, found)
  return found
}
