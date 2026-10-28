import { afterEach, expect, mock, spyOn, test } from 'bun:test'
import { nextScheduledTime, validateTaskSchedule, type TaskSchedule } from './scheduledTaskSchedule.js'

afterEach(() => mock.restore())

function next(expression: string, after: string, timeZone = 'UTC'): string | null {
  const schedule: TaskSchedule = { kind: 'cron', expression, timeZone }
  validateTaskSchedule(schedule)
  const time = nextScheduledTime(schedule, Date.parse(after))
  return time === null ? null : new Date(time).toISOString()
}

test('finds leap-day occurrences beyond a year and after the previous occurrence', () => {
  const formatting = spyOn(Intl.DateTimeFormat.prototype, 'formatToParts')
  expect(next('0 9 29 2 *', '2026-10-26T00:00:00Z')).toBe('2028-02-29T09:00:00.000Z')
  expect(next('0 9 29 2 *', '2028-02-29T09:00:00Z')).toBe('2032-02-29T09:00:00.000Z')
  // Multi-year gaps must skip calendar dates rather than scan every UTC minute.
  expect(formatting.mock.calls.length).toBeLessThan(15_000)
})

test('preserves the scheduler intersection of weekday and day-of-month across decades', () => {
  expect(next('0 9 29 2 1', '2026-10-26T00:00:00Z')).toBe('2044-02-29T09:00:00.000Z')
})

test('returns null for a calendar date that cannot occur in a Gregorian cycle', () => {
  const formatting = spyOn(Intl.DateTimeFormat.prototype, 'formatToParts')
  expect(next('0 9 30 2 *', '2026-10-26T00:00:00Z')).toBeNull()
  expect(formatting.mock.calls.length).toBeLessThan(100)
})

test('preserves timezone date boundaries and both halves of a DST overlap', () => {
  expect(next('0 0 1 1 *', '2026-12-30T00:00:00Z', 'Pacific/Kiritimati')).toBe('2026-12-31T10:00:00.000Z')
  expect(next('30 1 * * *', '2026-11-01T05:30:00Z', 'America/New_York')).toBe('2026-11-01T06:30:00.000Z')
  expect(next('30 2 * * *', '2026-03-08T05:00:00Z', 'America/New_York')).toBe('2026-03-09T06:30:00.000Z')
  expect(next('45 1 * * *', '2026-04-04T14:45:00Z', 'Australia/Lord_Howe')).toBe('2026-04-04T15:15:00.000Z')
})
