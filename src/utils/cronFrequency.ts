/**
 * Converts between UI-friendly frequency settings and cron expressions.
 * Used by the ScheduledTaskWizard for human-readable schedule configuration.
 */

/** Supported frequency values in the scheduled task UI. */
export type Frequency = 'manual' | 'hourly' | 'daily' | 'weekdays' | 'weekly'

export const FREQUENCY_OPTIONS: { label: string; value: Frequency }[] = [
  { label: 'Manual', value: 'manual' },
  { label: 'Hourly', value: 'hourly' },
  { label: 'Daily', value: 'daily' },
  { label: 'Weekdays', value: 'weekdays' },
  { label: 'Weekly', value: 'weekly' },
]

/** Validate "HH:MM" or "H:MM" time string. Returns [hour, minute] or null. */
function parseTime(time: string): { hour: number; minute: number } | null {
  if (!time || typeof time !== 'string') return null
  const [h, m] = time.trim().split(':')
  const hour = parseInt(h ?? '', 10)
  const minute = parseInt(m ?? '', 10)
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null
  if (hour < 0 || hour > 23) return null
  if (minute < 0 || minute > 59) return null
  return { hour, minute }
}

/**
 * Convert a frequency + time to a 5-field cron expression.
 * Time format: "HH:MM" (24-hour). Defaults to "09:00" if not provided.
 *
 * - manual: no cron (returns empty string — task runs on demand)
 * - hourly: "0 * * * *"
 * - daily + "09:00": "0 9 * * *"
 * - weekdays + "09:00": "0 9 * * 1-5"
 * - weekly + "09:00": "0 9 * * 1" (Monday)
 */
export function frequencyToCron(frequency: Frequency, time?: string): string {
  if (frequency === 'manual') return ''

  const parsed = parseTime(time ?? '09:00')
  if (!parsed) return '' // malformed time → no-op
  const { hour, minute } = parsed

  switch (frequency) {
    case 'hourly':
      return `${minute} * * * *`
    case 'daily':
      return `${minute} ${hour} * * *`
    case 'weekdays':
      return `${minute} ${hour} * * 1-5`
    case 'weekly':
      return `${minute} ${hour} * * 1`
  }
}

/**
 * Best-effort reverse: guess the frequency + time from a cron expression.
 * Returns the closest match; complex crons fall back to { frequency: 'manual' }.
 */
export function cronToFrequency(cron: string): {
  frequency: Frequency
  time?: string
} {
  if (!cron || cron.trim() === '') return { frequency: 'manual' }

  const parts = cron.trim().split(/\s+/)
  if (parts.length !== 5) return { frequency: 'manual' }

  const [minute, hour, dom, month, dow] = parts

  // Hourly: "N * * * *"
  if (hour === '*' && dom === '*' && month === '*' && dow === '*') {
    return { frequency: 'hourly' }
  }

  // Check if it's a specific hour+minute pattern
  if (
    dom === '*' &&
    month === '*' &&
    isNumber(minute!) &&
    isNumber(hour!)
  ) {
    const h = parseInt(hour!, 10)
    const m = parseInt(minute!, 10)
    // Guard against out-of-range values (e.g. malformed cron in existing data)
    if (h < 0 || h > 23 || m < 0 || m > 59) {
      return { frequency: 'manual' }
    }
    const timeStr = `${pad(h)}:${pad(m)}`

    // Weekdays: "M H * * 1-5"
    if (dow === '1-5') {
      return { frequency: 'weekdays', time: timeStr }
    }

    // Weekly: "M H * * 1"
    if (dow === '1') {
      return { frequency: 'weekly', time: timeStr }
    }

    // Daily: "M H * * *"
    if (dow === '*') {
      return { frequency: 'daily', time: timeStr }
    }
  }

  // Can't map to a simple frequency
  return { frequency: 'manual' }
}

function isNumber(s: string): boolean {
  return /^\d+$/.test(s)
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}
