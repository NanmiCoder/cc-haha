/**
 * Unit tests for one-shot reservation helpers (scheduledReservation.ts).
 *
 * All times are local, matching src/utils/cron.ts. We build Date objects with
 * the local-time constructor so the assertions hold in any test timezone.
 */

import { describe, it, expect } from 'bun:test'
import {
  RESERVATION_WINDOW_MS,
  buildOneShotCron,
  isOneShotCron,
  isWithinReservationWindow,
  parseOneShotCronTarget,
} from '../services/scheduledReservation.js'

describe('buildOneShotCron', () => {
  it('pins minute hour day-of-month month with a wildcard day-of-week', () => {
    expect(buildOneShotCron(new Date(2026, 5, 15, 9, 5))).toBe('5 9 15 6 *')
  })

  it('handles the year-end boundary (Dec 31 23:30)', () => {
    expect(buildOneShotCron(new Date(2026, 11, 31, 23, 30))).toBe('30 23 31 12 *')
  })

  it('handles the next-day midnight boundary (Jan 1 00:05)', () => {
    expect(buildOneShotCron(new Date(2027, 0, 1, 0, 5))).toBe('5 0 1 1 *')
  })

  it('round-trips through parseOneShotCronTarget', () => {
    const target = new Date(2026, 11, 31, 23, 30)
    const cron = buildOneShotCron(target)
    const resolved = parseOneShotCronTarget(cron, new Date(2026, 11, 31, 22, 0))
    expect(resolved?.getTime()).toBe(target.getTime())
  })
})

describe('isOneShotCron', () => {
  it('accepts pinned one-shot expressions', () => {
    expect(isOneShotCron('30 23 31 12 *')).toBe(true)
    expect(isOneShotCron('5 0 1 1 *')).toBe(true)
  })

  it('rejects recurring and non-pinned expressions', () => {
    expect(isOneShotCron('0 9 * * *')).toBe(false) // daily
    expect(isOneShotCron('30 14 * * 1-5')).toBe(false) // weekdays
    expect(isOneShotCron('0 9 1 6 3')).toBe(false) // day-of-week constrained
    expect(isOneShotCron('*/15 * * * *')).toBe(false) // step minutes
    expect(isOneShotCron('* * * * *')).toBe(false)
    expect(isOneShotCron('not a cron')).toBe(false)
  })
})

describe('parseOneShotCronTarget', () => {
  it('resolves the next occurrence after the reference within the same year', () => {
    const target = parseOneShotCronTarget(
      '0 10 15 6 *',
      new Date(2026, 5, 15, 9, 0),
    )
    expect(target?.getTime()).toBe(new Date(2026, 5, 15, 10, 0).getTime())
  })

  it('rolls into the next year when the reference is already past this year', () => {
    const target = parseOneShotCronTarget(
      '5 0 1 1 *',
      new Date(2026, 11, 31, 23, 0),
    )
    expect(target?.getTime()).toBe(new Date(2027, 0, 1, 0, 5).getTime())
  })

  it('returns null for non one-shot crons', () => {
    expect(parseOneShotCronTarget('0 9 * * *', new Date(2026, 0, 1))).toBeNull()
  })
})

describe('isWithinReservationWindow', () => {
  const now = Date.now()

  it('exposes a 48-hour window', () => {
    expect(RESERVATION_WINDOW_MS).toBe(48 * 60 * 60 * 1000)
  })

  it('accepts targets inside the window', () => {
    expect(isWithinReservationWindow(now + 60_000, now)).toBe(true)
    expect(isWithinReservationWindow(now + RESERVATION_WINDOW_MS, now)).toBe(true)
  })

  it('rejects targets beyond the window', () => {
    expect(isWithinReservationWindow(now + RESERVATION_WINDOW_MS + 1000, now)).toBe(false)
    expect(isWithinReservationWindow(now + 72 * 60 * 60 * 1000, now)).toBe(false)
  })

  it('rejects targets in the past', () => {
    expect(isWithinReservationWindow(now - 1000, now)).toBe(false)
  })
})
