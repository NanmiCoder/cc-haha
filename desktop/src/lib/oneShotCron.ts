/**
 * One-shot reservation helpers (desktop mirror).
 *
 * Mirrors `src/server/services/scheduledReservation.ts`. The server stays
 * authoritative for the 48h window; this copy exists so the wizard can preview
 * and validate a one-time send before submitting. All times are local.
 */

/** Reservations must fire within 48 hours of creation. */
export const RESERVATION_WINDOW_MS = 48 * 60 * 60 * 1000

/** Convert a target local Date into a pinned one-shot cron `分 时 日 月 *`. */
export function buildOneShotCron(date: Date): string {
  return `${date.getMinutes()} ${date.getHours()} ${date.getDate()} ${date.getMonth() + 1} *`
}

/**
 * True when `cron` is a pinned one-shot expression `minute hour day-of-month
 * month *` (first four fields single numbers, day-of-week a wildcard).
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
    Number(month) >= 1 && Number(month) <= 12 &&
    Number(dayOfMonth) >= 1 && Number(dayOfMonth) <= 31 &&
    Number(hour) <= 23 && Number(minute) <= 59
  )
}

/**
 * Resolve the next concrete target Date for a one-shot cron strictly after
 * `reference` (local). Returns null when `cron` is not a pinned one-shot or no
 * occurrence falls within this year or next.
 */
export function oneShotCronToDate(cron: string, reference: Date): Date | null {
  if (!isOneShotCron(cron)) return null
  const [minute, hour, dayOfMonth, month] = cron.trim().split(/\s+/).map((n) => Number(n))
  const refMs = reference.getTime()
  const startYear = reference.getFullYear()
  for (let year = startYear; year <= startYear + 1; year++) {
    const candidate = new Date(year, month! - 1, dayOfMonth!, hour!, minute!, 0, 0)
    // Guard against day rollover (e.g. an impossible date for this year).
    if (candidate.getMonth() !== month! - 1 || candidate.getDate() !== dayOfMonth!) {
      continue
    }
    if (candidate.getTime() > refMs) return candidate
  }
  return null
}

/** True when the target is in the future and within the 48-hour window. */
export function isWithinReservationWindow(targetMs: number, nowMs: number): boolean {
  if (!Number.isFinite(targetMs) || !Number.isFinite(nowMs)) return false
  const delta = targetMs - nowMs
  return delta >= 0 && delta <= RESERVATION_WINDOW_MS
}

function pad(n: number): string {
  return n.toString().padStart(2, '0')
}

/** Format a Date as a `datetime-local` input value (`YYYY-MM-DDTHH:mm`, local). */
export function toDateTimeLocalValue(date: Date): string {
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}`
  )
}

/**
 * Parse a `datetime-local` input value into a local Date. Returns null for an
 * empty or malformed value.
 */
export function fromDateTimeLocalValue(value: string): Date | null {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/)
  if (!match) return null
  const [, year, month, day, hour, minute] = match
  const date = new Date(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    0,
    0,
  )
  if (
    date.getMonth() !== Number(month) - 1 ||
    date.getDate() !== Number(day)
  ) {
    return null
  }
  return date
}
