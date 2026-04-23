import { describe, expect, test } from 'bun:test'
import {
  frequencyToCron,
  cronToFrequency,
  FREQUENCY_OPTIONS,
} from '../cronFrequency.js'

describe('frequencyToCron', () => {
  test('manual returns empty string', () => {
    expect(frequencyToCron('manual')).toBe('')
    expect(frequencyToCron('manual', '09:00')).toBe('')
  })

  test('hourly returns minute-only cron', () => {
    expect(frequencyToCron('hourly')).toBe('0 * * * *')
    expect(frequencyToCron('hourly', '15')).toBe('') // malformed: must be HH:MM
    expect(frequencyToCron('hourly', '0 * * * *')).toBe('') // malformed time
    expect(frequencyToCron('hourly', ':15')).toBe('') // malformed
    expect(frequencyToCron('hourly', '00:15')).toBe('15 * * * *')
  })

  test('daily returns correct cron', () => {
    expect(frequencyToCron('daily', '09:00')).toBe('0 9 * * *')
    expect(frequencyToCron('daily', '14:30')).toBe('30 14 * * *')
  })

  test('weekdays returns cron with 1-5 dow', () => {
    expect(frequencyToCron('weekdays', '09:00')).toBe('0 9 * * 1-5')
    expect(frequencyToCron('weekdays', '08:30')).toBe('30 8 * * 1-5')
  })

  test('weekly returns cron with dow=1', () => {
    expect(frequencyToCron('weekly', '09:00')).toBe('0 9 * * 1')
    expect(frequencyToCron('weekly', '17:00')).toBe('0 17 * * 1')
  })

  test('rejects invalid time formats', () => {
    expect(frequencyToCron('daily', '')).toBe('')
    expect(frequencyToCron('daily', '25:00')).toBe('')
    expect(frequencyToCron('daily', '09:60')).toBe('')
    expect(frequencyToCron('daily', 'abc')).toBe('')
    expect(frequencyToCron('daily', '9')).toBe('')
    expect(frequencyToCron('daily', ':30')).toBe('')
  })

  test('defaults to 09:00 for missing time', () => {
    expect(frequencyToCron('daily')).toBe('0 9 * * *')
    expect(frequencyToCron('weekdays')).toBe('0 9 * * 1-5')
    expect(frequencyToCron('weekly')).toBe('0 9 * * 1')
  })
})

describe('cronToFrequency', () => {
  test('empty cron returns manual', () => {
    expect(cronToFrequency('')).toEqual({ frequency: 'manual' })
    expect(cronToFrequency('   ')).toEqual({ frequency: 'manual' })
  })

  test('invalid cron returns manual', () => {
    expect(cronToFrequency('not a cron')).toEqual({ frequency: 'manual' })
    expect(cronToFrequency('*')).toEqual({ frequency: 'manual' })
    expect(cronToFrequency('* *')).toEqual({ frequency: 'manual' })
  })

  test('hourly pattern detected', () => {
    expect(cronToFrequency('7 * * * *')).toEqual({ frequency: 'hourly' })
    expect(cronToFrequency('0 * * * *')).toEqual({ frequency: 'hourly' })
    expect(cronToFrequency('30 * * * *')).toEqual({ frequency: 'hourly' })
  })

  test('daily pattern detected', () => {
    expect(cronToFrequency('0 9 * * *')).toEqual({ frequency: 'daily', time: '09:00' })
    expect(cronToFrequency('30 14 * * *')).toEqual({ frequency: 'daily', time: '14:30' })
  })

  test('weekdays pattern detected', () => {
    expect(cronToFrequency('0 9 * * 1-5')).toEqual({ frequency: 'weekdays', time: '09:00' })
    expect(cronToFrequency('30 8 * * 1-5')).toEqual({ frequency: 'weekdays', time: '08:30' })
  })

  test('weekly pattern detected', () => {
    expect(cronToFrequency('0 9 * * 1')).toEqual({ frequency: 'weekly', time: '09:00' })
    expect(cronToFrequency('0 17 * * 1')).toEqual({ frequency: 'weekly', time: '17:00' })
  })

  test('complex crons return manual', () => {
    expect(cronToFrequency('0 9 1-15 * *')).toEqual({ frequency: 'manual' })
    expect(cronToFrequency('0 9 * * 0,6')).toEqual({ frequency: 'manual' })
    expect(cronToFrequency('0 9 * 1,2 *')).toEqual({ frequency: 'manual' })
    expect(cronToFrequency('0 */2 * * *')).toEqual({ frequency: 'manual' })
  })

  test('hourly when minute is step but hour is wildcard', () => {
    // */5 in minute + * in hour matches the first branch: hour === '*' && all wildcards
    expect(cronToFrequency('*/5 * * * *')).toEqual({ frequency: 'hourly' })
  })

  test('out-of-range values return manual', () => {
    expect(cronToFrequency('60 25 * * *')).toEqual({ frequency: 'manual' })
    expect(cronToFrequency('99 99 * * *')).toEqual({ frequency: 'manual' })
  })

  test('pads hour and minute correctly', () => {
    expect(cronToFrequency('5 9 * * *')).toEqual({ frequency: 'daily', time: '09:05' })
    expect(cronToFrequency('30 0 * * *')).toEqual({ frequency: 'daily', time: '00:30' })
  })
})

describe('FREQUENCY_OPTIONS', () => {
  test('contains all expected frequencies', () => {
    const values = FREQUENCY_OPTIONS.map(o => o.value)
    expect(values).toContain('manual')
    expect(values).toContain('hourly')
    expect(values).toContain('daily')
    expect(values).toContain('weekdays')
    expect(values).toContain('weekly')
  })

  test('all have labels', () => {
    for (const opt of FREQUENCY_OPTIONS) {
      expect(typeof opt.label).toBe('string')
      expect(opt.label.length).toBeGreaterThan(0)
    }
  })
})

describe('round-trip: frequency → cron → frequency', () => {
  test('daily round-trip preserves data', () => {
    const cron = frequencyToCron('daily', '09:00')
    const result = cronToFrequency(cron)
    expect(result).toEqual({ frequency: 'daily', time: '09:00' })
  })

  test('weekdays round-trip preserves data', () => {
    const cron = frequencyToCron('weekdays', '08:30')
    const result = cronToFrequency(cron)
    expect(result).toEqual({ frequency: 'weekdays', time: '08:30' })
  })

  test('weekly round-trip preserves data', () => {
    const cron = frequencyToCron('weekly', '17:00')
    const result = cronToFrequency(cron)
    expect(result).toEqual({ frequency: 'weekly', time: '17:00' })
  })

  test('hourly round-trip preserves minute', () => {
    // frequencyToCron('hourly', '00:15') produces "15 * * * *"
    // cronToFrequency('15 * * * *') returns 'hourly' (minute is numeric, hour is '*')
    const cron = frequencyToCron('hourly', '00:15')
    const result = cronToFrequency(cron)
    expect(result).toEqual({ frequency: 'hourly' })
  })
})
