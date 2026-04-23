import { describe, it, expect } from 'vitest'
import { describeCron, isValidCron } from '../cronDescribe'

// Simple mock t() that returns the key with params interpolated
const t = (key: string, params?: Record<string, string | number>) => {
  let text = key
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      text = text.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v))
    }
  }
  return text
}

describe('describeCron', () => {
  it('every minute', () => {
    expect(describeCron('* * * * *', t)).toBe('cron.everyMinute')
  })

  it('every N minutes', () => {
    expect(describeCron('*/15 * * * *', t)).toBe('cron.everyNMinutes')
    expect(describeCron('*/5 * * * *', t)).toBe('cron.everyNMinutes')
  })

  it('*/1 is treated as every minute', () => {
    expect(describeCron('*/1 * * * *', t)).toBe('cron.everyMinute')
  })

  it('every hour', () => {
    expect(describeCron('0 */1 * * *', t)).toBe('cron.everyHour')
  })

  it('every N hours', () => {
    expect(describeCron('0 */4 * * *', t)).toBe('cron.everyNHours')
  })

  it('every N hours at minute offset', () => {
    expect(describeCron('30 */4 * * *', t)).toBe('cron.everyNHoursAtMinute')
  })

  it('daily at time', () => {
    expect(describeCron('30 9 * * *', t)).toBe('cron.dailyAt')
  })

  it('weekdays at time', () => {
    expect(describeCron('30 9 * * 1-5', t)).toBe('cron.weekdaysAt')
  })

  it('specific days of week', () => {
    const result = describeCron('0 9 * * 1,3,5', t)
    expect(result).toBe('cron.specificDaysAt')
  })

  it('monthly on specific day', () => {
    expect(describeCron('0 9 15 * *', t)).toBe('cron.monthlyAt')
  })

  it('unrecognized pattern falls back to custom', () => {
    expect(describeCron('0 9 1 6 *', t)).toBe('cron.customSchedule')
  })

  it('invalid field count falls back to custom', () => {
    expect(describeCron('0 9 *', t)).toBe('cron.customSchedule')
  })
})

describe('isValidCron', () => {
  it('accepts valid expressions', () => {
    expect(isValidCron('0 9 * * *')).toBe(true)
    expect(isValidCron('*/15 * * * *')).toBe(true)
    expect(isValidCron('30 14 * * 1-5')).toBe(true)
    expect(isValidCron('0 9 * * 1,3,5')).toBe(true)
    expect(isValidCron('0 9 15 * *')).toBe(true)
    expect(isValidCron('0 */2 * * *')).toBe(true)
  })

  it('rejects invalid expressions', () => {
    expect(isValidCron('')).toBe(false)
    expect(isValidCron('hello')).toBe(false)
    expect(isValidCron('0 9 *')).toBe(false)  // too few fields
    expect(isValidCron('0 9 * * * *')).toBe(false)  // too many fields
    expect(isValidCron('60 9 * * *')).toBe(false)  // minute > 59
    expect(isValidCron('0 25 * * *')).toBe(false)  // hour > 23
    expect(isValidCron('0 9 32 * *')).toBe(false)  // day > 31
    expect(isValidCron('0 9 * 13 *')).toBe(false)  // month > 12
    expect(isValidCron('0 9 * * 8')).toBe(false)   // dow > 7
  })

  it('accepts edge case values', () => {
    expect(isValidCron('0 0 1 1 0')).toBe(true)
    expect(isValidCron('59 23 31 12 7')).toBe(true)
  })
})
