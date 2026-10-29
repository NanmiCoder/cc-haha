import { parseCronExpression } from './cron'

export type TaskSchedule =
  | { kind: 'once'; runAt: string; timeZone: string }
  | { kind: 'cron'; expression: string; timeZone: string }

export type TaskExecution = { kind: 'session'; targetSessionId: string } | { kind: 'new-session' }
export type TaskNotificationPolicy = 'important' | 'all' | 'failed' | 'none'
export type TaskNotificationConfig = {
  enabled: boolean
  channels: ('desktop' | 'telegram' | 'feishu')[]
}

function formatTime(hour: number, minute: number): string {
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
}

/**
 * Reverse-parse a cron expression back into UI-friendly state
 * for the task edit modal.
 */
export type FrequencyKey = 'everyNMinutes' | 'everyNHours' | 'daily' | 'weekdays' | 'specificDays' | 'monthly' | 'customCron'

export type ParsedCron = {
  frequency: FrequencyKey
  time: string
  minuteInterval: number
  hourInterval: number
  minuteOffset: number
  selectedDays: number[]
  monthDay: number
  customCron: string
}

const DEFAULTS: ParsedCron = {
  frequency: 'customCron',
  time: '09:00',
  minuteInterval: 15,
  hourInterval: 1,
  minuteOffset: 0,
  selectedDays: [1],
  monthDay: 1,
  customCron: '',
}

export function parseCron(cron: string): ParsedCron {
  const fields = cron.trim().split(/\s+/)
  if (!parseCronExpression(cron)) return { ...DEFAULTS, customCron: cron }

  const min = fields[0]!
  const hour = fields[1]!
  const dom = fields[2]!
  const month = fields[3]!
  const dow = fields[4]!

  // */N * * * * → everyNMinutes
  if (/^\*\/\d+$/.test(min) && hour === '*' && dom === '*' && month === '*' && dow === '*') {
    return { ...DEFAULTS, frequency: 'everyNMinutes', minuteInterval: parseInt(min.split('/')[1]!) }
  }

  // M */N * * * → everyNHours
  if (/^\d+$/.test(min) && /^\*\/\d+$/.test(hour) && dom === '*' && month === '*' && dow === '*') {
    return { ...DEFAULTS, frequency: 'everyNHours', minuteOffset: parseInt(min), hourInterval: parseInt(hour.split('/')[1]!) }
  }

  // M H ... patterns need time
  if (/^\d+$/.test(min) && /^\d+$/.test(hour)) {
    const time = formatTime(parseInt(hour), parseInt(min))

    // M H * * * → daily
    if (dom === '*' && month === '*' && dow === '*') {
      return { ...DEFAULTS, frequency: 'daily', time }
    }
    // M H * * 1-5 → weekdays
    if (dom === '*' && month === '*' && dow === '1-5') {
      return { ...DEFAULTS, frequency: 'weekdays', time }
    }
    // M H * * <list> → specificDays
    if (dom === '*' && month === '*' && /^[\d,]+$/.test(dow)) {
      return { ...DEFAULTS, frequency: 'specificDays', time, selectedDays: dow.split(',').map(Number) }
    }
    // M H D * * → monthly
    if (/^\d+$/.test(dom) && month === '*' && dow === '*') {
      return { ...DEFAULTS, frequency: 'monthly', time, monthDay: parseInt(dom) }
    }
  }

  return { ...DEFAULTS, customCron: cron }
}

export function buildCron(
  freq: FrequencyKey,
  time: string,
  opts: {
    minuteInterval: number
    hourInterval: number
    minuteOffset: number
    selectedDays: number[]
    monthDay: number
    customCron: string
  },
): string {
  const [hours, minutes] = time.split(':').map(Number)
  switch (freq) {
    case 'everyNMinutes':
      return `*/${opts.minuteInterval} * * * *`
    case 'everyNHours':
      return `${opts.minuteOffset} */${opts.hourInterval} * * *`
    case 'daily':
      return `${minutes} ${hours} * * *`
    case 'weekdays':
      return `${minutes} ${hours} * * 1-5`
    case 'specificDays':
      return `${minutes} ${hours} * * ${[...opts.selectedDays].sort((a, b) => a - b).join(',')}`
    case 'monthly':
      return `${minutes} ${hours} ${opts.monthDay} * *`
    case 'customCron':
      return opts.customCron.trim()
  }
}

/** Match the exact grammar accepted by the scheduler. */
export function isValidCron(cron: string): boolean {
  return parseCronExpression(cron) !== null
}

export function dateTimeInZone(value: string, timeZone: string): string {
  try {
    const parts = new Intl.DateTimeFormat('sv-SE', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(value))
    const get = (type: string) => parts.find(p => p.type === type)?.value
    return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}`
  } catch { return '' }
}

/** Reject nonexistent wall times (DST gaps) rather than silently moving a task. */
export function zonedDateTimeToIso(value: string, timeZone: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return null
  const wall = Date.parse(`${value}:00Z`)
  if (!Number.isFinite(wall)) return null
  let candidate = wall
  for (let attempt = 0; attempt < 4; attempt++) {
    const displayed = dateTimeInZone(new Date(candidate).toISOString(), timeZone)
    if (!displayed) return null
    if (displayed === value) return new Date(candidate).toISOString()
    candidate += wall - Date.parse(`${displayed}:00Z`)
  }
  return null
}
