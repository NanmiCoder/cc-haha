import { describe, it, expect } from 'vitest'
import {
  RESERVATION_WINDOW_MS,
  buildOneShotCron,
  isOneShotCron,
  isWithinReservationWindow,
  oneShotCronToDate,
  toDateTimeLocalValue,
  fromDateTimeLocalValue,
} from '../oneShotCron'

describe('buildOneShotCron', () => {
  it('pins minute hour day month with a wildcard day-of-week', () => {
    expect(buildOneShotCron(new Date(2026, 5, 15, 9, 5))).toBe('5 9 15 6 *')
  })

  it('handles the year-end boundary', () => {
    expect(buildOneShotCron(new Date(2026, 11, 31, 23, 30))).toBe('30 23 31 12 *')
  })

  it('handles the next-day midnight boundary', () => {
    expect(buildOneShotCron(new Date(2027, 0, 1, 0, 5))).toBe('5 0 1 1 *')
  })
})

describe('isOneShotCron', () => {
  it('accepts pinned expressions', () => {
    expect(isOneShotCron('30 23 31 12 *')).toBe(true)
    expect(isOneShotCron('5 0 1 1 *')).toBe(true)
  })

  it('rejects recurring and malformed expressions', () => {
    expect(isOneShotCron('0 9 * * *')).toBe(false)
    expect(isOneShotCron('30 14 * * 1-5')).toBe(false)
    expect(isOneShotCron('0 9 1 6 3')).toBe(false)
    expect(isOneShotCron('* * * * *')).toBe(false)
    expect(isOneShotCron('nope')).toBe(false)
    expect(isOneShotCron('0 9 1 13 *')).toBe(false) // month out of range
  })
})

describe('oneShotCronToDate', () => {
  it('resolves the next occurrence after the reference', () => {
    const resolved = oneShotCronToDate('0 10 15 6 *', new Date(2026, 5, 15, 9, 0))
    expect(resolved?.getTime()).toBe(new Date(2026, 5, 15, 10, 0).getTime())
  })

  it('rolls into the next year across the boundary', () => {
    const resolved = oneShotCronToDate('5 0 1 1 *', new Date(2026, 11, 31, 23, 0))
    expect(resolved?.getTime()).toBe(new Date(2027, 0, 1, 0, 5).getTime())
  })

  it('returns null for non one-shot crons', () => {
    expect(oneShotCronToDate('0 9 * * *', new Date(2026, 0, 1))).toBeNull()
  })
})

describe('isWithinReservationWindow', () => {
  const now = Date.now()

  it('exposes a 48-hour window', () => {
    expect(RESERVATION_WINDOW_MS).toBe(48 * 60 * 60 * 1000)
  })

  it('accepts in-window future targets and rejects the rest', () => {
    expect(isWithinReservationWindow(now + 60_000, now)).toBe(true)
    expect(isWithinReservationWindow(now + RESERVATION_WINDOW_MS, now)).toBe(true)
    expect(isWithinReservationWindow(now + RESERVATION_WINDOW_MS + 1000, now)).toBe(false)
    expect(isWithinReservationWindow(now - 1000, now)).toBe(false)
  })
})

describe('datetime-local value round-trip', () => {
  it('formats and parses a local datetime', () => {
    const date = new Date(2026, 5, 15, 9, 5)
    const value = toDateTimeLocalValue(date)
    expect(value).toBe('2026-06-15T09:05')
    expect(fromDateTimeLocalValue(value)?.getTime()).toBe(date.getTime())
  })

  it('rejects malformed values', () => {
    expect(fromDateTimeLocalValue('')).toBeNull()
    expect(fromDateTimeLocalValue('2026-06-15')).toBeNull()
    expect(fromDateTimeLocalValue('2026-13-40T99:99')).toBeNull()
  })
})
