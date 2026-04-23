/**
 * Cron expression utilities: human-readable description & validation.
 * Works with standard 5-field cron: minute hour day-of-month month day-of-week
 */

import type { TranslationKey } from '../i18n'

type TFunc = (key: TranslationKey, params?: Record<string, string | number>) => string

function pad(n: number): string {
  return n.toString().padStart(2, '0')
}

function formatTime(hour: number, minute: number): string {
  return `${pad(hour)}:${pad(minute)}`
}

function describeDow(field: string, t: TFunc): string {
  const parts = field.split(',')
  const days: number[] = []
  for (const part of parts) {
    const range = part.match(/^(\d+)-(\d+)$/)
    if (range) {
      const start = parseInt(range[1]!)
      const end = parseInt(range[2]!)
      for (let i = start; i <= end; i++) days.push(i)
    } else {
      days.push(parseInt(part))
    }
  }
  return days.map((d) => t(`cron.dow.${d % 7}` as any)).join(', ') // dynamic key
}

export function describeCron(cron: string, t: TFunc): string {
  const fields = cron.trim().split(/\s+/)
  if (fields.length !== 5) return t('cron.customSchedule', { cron })

  const min = fields[0]!
  const hour = fields[1]!
  const dom = fields[2]!
  const month = fields[3]!
  const dow = fields[4]!

  // */N * * * * → every N minutes
  if (hour === '*' && dom === '*' && month === '*' && dow === '*') {
    const stepMatch = min.match(/^\*\/(\d+)$/)
    if (stepMatch) {
      const n = parseInt(stepMatch[1]!)
      if (n === 1) return t('cron.everyMinute')
      return t('cron.everyNMinutes', { n })
    }
    if (min === '*') return t('cron.everyMinute')
  }

  // M */N * * * → every N hours (optionally at :M)
  if (/^\d+$/.test(min) && dom === '*' && month === '*' && dow === '*') {
    const hourStep = hour.match(/^\*\/(\d+)$/)
    if (hourStep) {
      const n = parseInt(hourStep[1]!)
      const m = parseInt(min)
      if (m === 0) {
        if (n === 1) return t('cron.everyHour')
        return t('cron.everyNHours', { n })
      }
      return t('cron.everyNHoursAtMinute', { n, m: pad(m) })
    }
  }

  // M H * * <dow> → daily / weekdays / specific days
  if (/^\d+$/.test(min) && /^\d+$/.test(hour) && dom === '*' && month === '*') {
    const time = formatTime(parseInt(hour), parseInt(min))

    if (dow === '*') {
      return t('cron.dailyAt', { time })
    }
    if (dow === '1-5') {
      return t('cron.weekdaysAt', { time })
    }
    if (/^[\d,\-]+$/.test(dow)) {
      const days = describeDow(dow, t)
      return t('cron.specificDaysAt', { days, time })
    }
  }

  // M H D * * → monthly on day D
  if (/^\d+$/.test(min) && /^\d+$/.test(hour) && /^\d+$/.test(dom) && month === '*' && dow === '*') {
    const time = formatTime(parseInt(hour), parseInt(min))
    return t('cron.monthlyAt', { day: parseInt(dom), time })
  }

  return t('cron.customSchedule', { cron })
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
  if (fields.length !== 5) return { ...DEFAULTS, customCron: cron }

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

export function isValidCron(cron: string): boolean {
  const fields = cron.trim().split(/\s+/)
  if (fields.length !== 5) return false

  const fieldPattern = /^(\*|(\d+(-\d+)?(\/\d+)?)(,(\d+(-\d+)?(\/\d+)?))*)$/
  const maxValues = [59, 23, 31, 12, 7]
  const minValues = [0, 0, 1, 1, 0]

  for (let i = 0; i < 5; i++) {
    const field = fields[i]!
    if (/^\*\/\d+$/.test(field)) continue
    if (field === '*') continue
    if (!fieldPattern.test(field)) return false
    const nums = field.replace(/\/\d+/g, '').split(/[,\-]/).filter((s) => /^\d+$/.test(s))
    for (const num of nums) {
      const n = parseInt(num)
      if (n < minValues[i]! || n > maxValues[i]!) return false
    }
  }

  return true
}
