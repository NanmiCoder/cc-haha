/**
 * One-shot reservation helpers.
 *
 * A "reservation" is a one-time scheduled send: the user picks a concrete
 * local date/time within the next {@link RESERVATION_WINDOW_MS} and we pin it
 * to a 5-field cron of the shape `minute hour day-of-month month *` combined
 * with `recurring: false`. Because the cron omits the year, the scheduler's
 * existing `recurring === false` handling disables the task after it fires, so
 * it never re-triggers on the same month/day next year.
 *
 * These functions are pure and timezone-local (they use the process's local
 * timezone, matching `src/utils/cron.ts`). The desktop app mirrors them in
 * `desktop/src/lib/oneShotCron.ts` for wizard preview and validation.
 */

import {
  computeNextCronRun,
  parseCronExpression,
} from '../../utils/cron.js'

/** Reservations must fire within 48 hours of creation. */
export const RESERVATION_WINDOW_MS = 48 * 60 * 60 * 1000

/**
 * Convert a target local Date into a pinned one-shot cron `分 时 日 月 *`.
 * The year is intentionally dropped — `recurring: false` gives the one-time
 * semantics, and the scheduler disables the task after it fires.
 */
export function buildOneShotCron(date: Date): string {
  const minute = date.getMinutes()
  const hour = date.getHours()
  const dayOfMonth = date.getDate()
  const month = date.getMonth() + 1
  return `${minute} ${hour} ${dayOfMonth} ${month} *`
}

/**
 * True when `cron` is a pinned one-shot expression of the shape
 * `minute hour day-of-month month *` (each of the first four fields a single
 * number, day-of-week a wildcard). This is exactly what {@link buildOneShotCron}
 * produces. Generic recurring crons (including a yearly `M H D Mo DOW`) are not
 * treated as one-shot reservations.
 */
export function isOneShotCron(cron: string): boolean {
  const fields = cron.trim().split(/\s+/)
  if (fields.length !== 5) return false
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields
  return (
    /^\d+$/.test(minute!) &&
    /^\d+$/.test(hour!) &&
    /^\d+$/.test(dayOfMonth!) &&
    /^\d+$/.test(month!) &&
    dayOfWeek === '*' &&
    parseCronExpression(cron) !== null
  )
}

/**
 * Resolve the next concrete target Date for a one-shot cron strictly after
 * `reference` (local timezone). Returns null when `cron` is not a pinned
 * one-shot expression, so callers can skip reservation-only rules for ordinary
 * recurring crons.
 */
export function parseOneShotCronTarget(
  cron: string,
  reference: Date,
): Date | null {
  if (!isOneShotCron(cron)) return null
  const fields = parseCronExpression(cron)
  if (!fields) return null
  return computeNextCronRun(fields, reference)
}

/**
 * True when a reservation target falls in the future and within the 48-hour
 * window measured from `nowMs`.
 */
export function isWithinReservationWindow(
  targetMs: number,
  nowMs: number,
): boolean {
  if (!Number.isFinite(targetMs) || !Number.isFinite(nowMs)) return false
  const delta = targetMs - nowMs
  return delta >= 0 && delta <= RESERVATION_WINDOW_MS
}
