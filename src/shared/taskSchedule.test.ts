import { describe, expect, test } from 'bun:test'
import { parseCronExpression } from './cron.js'
import { buildCron, dateTimeInZone, isValidCron, parseCron, zonedDateTimeToIso } from './taskSchedule.js'

describe('schedule editor contract', () => {
  test('round trips every repeat mode through the same expression used by the scheduler', () => {
    for (const expression of [
      '*/15 * * * *', '30 */4 * * *', '5 9 * * *', '5 9 * * 1-5',
      '0 18 * * 1,3,5', '30 8 28 * *', '0 9 29 2 *',
    ]) {
      const parsed = parseCron(expression)
      expect(buildCron(parsed.frequency, parsed.time, parsed), expression).toBe(expression)
      expect(isValidCron(expression), expression).toBe(true)
    }
    expect(parseCron('0 9 29 2 *').frequency).toBe('customCron')
  })

  test('building selected weekdays does not reorder the editor selection', () => {
    const parsed = parseCron('5 9 * * 5,1,3')
    expect(buildCron(parsed.frequency, parsed.time, parsed)).toBe('5 9 * * 1,3,5')
    expect(parsed.selectedDays).toEqual([5, 1, 3])
  })

  test('client validation agrees with the runtime and preserves custom expressions for editing', () => {
    for (const expression of [
      '*/0 * * * *', '0 9 * * 5-1', '0/2 9 * * *', '0 9 * * 8',
      '0-30/10 9 * * *', '0 9 * * 5-7', '*/5,30 9 * * *',
    ]) {
      expect(isValidCron(expression), expression).toBe(parseCronExpression(expression) !== null)
      expect(buildCron('customCron', '09:00', { ...parseCron(''), customCron: ` ${expression} ` })).toBe(expression)
    }
    expect(parseCron('0 24 * * *')).toMatchObject({ frequency: 'customCron', customCron: '0 24 * * *' })
  })
})

describe('schedule wall times', () => {
  test('converts the selected timezone independently of the client or host zone', () => {
    expect(zonedDateTimeToIso('2030-10-26T09:00', 'Asia/Shanghai')).toBe('2030-10-26T01:00:00.000Z')
    expect(dateTimeInZone('2030-10-26T01:00:00.000Z', 'Asia/Shanghai')).toBe('2030-10-26T09:00')
    expect(zonedDateTimeToIso('2030-10-26T09:00', 'Asia/Kathmandu')).toBe('2030-10-26T03:15:00.000Z')
    expect(zonedDateTimeToIso('2030-10-26T23:00', 'America/Los_Angeles')).toBe('2030-10-27T06:00:00.000Z')
  })

  test('rejects impossible calendar times, nonexistent DST wall times and invalid zones', () => {
    for (const value of ['2030-02-30T09:00', '2030-13-01T09:00', '2030-10-26T25:00', '2030-10-26', '']) {
      expect(zonedDateTimeToIso(value, 'UTC'), value).toBeNull()
    }
    expect(zonedDateTimeToIso('2030-03-10T02:30', 'America/New_York')).toBeNull()
    expect(zonedDateTimeToIso('2030-10-26T09:00', 'invalid')).toBeNull()
    expect(dateTimeInZone('not-a-date', 'Asia/Shanghai')).toBe('')
  })
})
