import type { Locale, TranslationKey } from '../i18n'

type Translator = (key: TranslationKey, params?: Record<string, string | number>) => string

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS

export function formatMessageTimestamp(
  value: number | string | Date,
  t: Translator,
  locale: Locale,
  now = Date.now(),
): string {
  const date = coerceDate(value)
  if (!date) return ''

  const timestamp = date.getTime()
  const diff = now - timestamp

  if (diff >= 0 && diff < MINUTE_MS) return t('session.timeJustNow')
  if (diff >= MINUTE_MS && diff < HOUR_MS) {
    return t('session.timeMinutes', { n: Math.floor(diff / MINUTE_MS) })
  }
  if (diff >= HOUR_MS && diff < DAY_MS) {
    return t('session.timeHours', { n: Math.floor(diff / HOUR_MS) })
  }
  if (diff >= DAY_MS && diff < 7 * DAY_MS) {
    return formatWeekdayTime(date, locale)
  }

  return isSameLocalYear(date, new Date(now))
    ? formatMonthDayTime(date, locale)
    : formatYearMonthDayTime(date, locale)
}

export function formatExactMessageTimestamp(value: number | string | Date, locale: Locale): string {
  const date = coerceDate(value)
  if (!date) return ''
  return new Intl.DateTimeFormat(localeToIntl(locale), {
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date)
}

export function formatMessageHoverTime(
  value: number | string | Date,
  locale: Locale,
  now = Date.now(),
): string {
  const date = coerceDate(value)
  if (!date) return ''
  return isSameLocalYear(date, new Date(now))
    ? formatMonthDayTime(date, locale)
    : formatYearMonthDayTime(date, locale)
}

function coerceDate(value: number | string | Date): Date | null {
  const date = value instanceof Date ? value : new Date(value)
  return Number.isFinite(date.getTime()) ? date : null
}

function localeToIntl(_locale: Locale): string {
  return 'en-US'
}

function formatWeekdayTime(date: Date, locale: Locale): string {
  const intlLocale = localeToIntl(locale)
  const weekday = new Intl.DateTimeFormat(intlLocale, { weekday: 'short' }).format(date)
  return `${weekday} ${formatClockTime(date, intlLocale)}`
}

function formatMonthDayTime(date: Date, locale: Locale): string {
  const intlLocale = localeToIntl(locale)
  const day = new Intl.DateTimeFormat(intlLocale, {
    month: 'short',
    day: 'numeric',
  }).format(date)
  return `${day} ${formatClockTime(date, intlLocale)}`
}

function formatYearMonthDayTime(date: Date, locale: Locale): string {
  const intlLocale = localeToIntl(locale)
  const day = new Intl.DateTimeFormat(intlLocale, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  }).format(date)
  return `${day} ${formatClockTime(date, intlLocale)}`
}

function formatClockTime(date: Date, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date)
}

function isSameLocalYear(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear()
}
