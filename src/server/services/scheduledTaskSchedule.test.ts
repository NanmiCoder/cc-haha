import { afterEach, expect, mock, spyOn, test } from 'bun:test'
import { buildCron, parseCron, zonedDateTimeToIso, type FrequencyKey } from '../../shared/taskSchedule.js'
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

test('shared mobile and desktop repeat controls produce the intended server occurrence', () => {
  const options = {
    ...parseCron('0 9 * * *'),
    minuteInterval: 15, hourInterval: 4, minuteOffset: 30,
    selectedDays: [1, 3], monthDay: 15, customCron: '0 9 1,15 * *',
  }
  const cases: [FrequencyKey, string][] = [
    ['everyNMinutes', '2030-01-01T00:15:00.000Z'],
    ['everyNHours', '2030-01-01T00:30:00.000Z'],
    ['daily', '2030-01-01T01:00:00.000Z'],
    ['weekdays', '2030-01-01T01:00:00.000Z'],
    ['specificDays', '2030-01-02T01:00:00.000Z'],
    ['monthly', '2030-01-15T01:00:00.000Z'],
    ['customCron', '2030-01-01T01:00:00.000Z'],
  ]
  // 08:00 on Tuesday in the chosen zone. Server host and phone timezone do
  // not decide either the scheduled day or the instant for these controls.
  for (const [frequency, expected] of cases) {
    const expression = buildCron(frequency, '09:00', options)
    expect(next(expression, '2030-01-01T00:00:00Z', 'Asia/Shanghai'), frequency).toBe(expected)
  }
  const once: TaskSchedule = { kind: 'once', runAt: zonedDateTimeToIso('2030-01-01T09:00', 'Asia/Shanghai')!, timeZone: 'Asia/Shanghai' }
  validateTaskSchedule(once)
  expect(nextScheduledTime(once, Date.parse('2030-01-01T00:00:00Z'))).toBe(Date.parse('2030-01-01T01:00:00Z'))
})
