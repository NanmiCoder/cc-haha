import type { TranslationKey } from '../i18n'

type Translate = (key: TranslationKey, params?: Record<string, string | number>) => string

/**
 * "Just now / 5 min ago / 3 days ago", falling back to a short date after a
 * month. Session rows on the desktop sidebar and the phone's session list
 * read the same way because they share this.
 */
export function formatRelativeTime(dateStr: string, t: Translate, now = Date.now()): string {
  const date = new Date(dateStr)
  const timestamp = date.getTime()
  if (!Number.isFinite(timestamp)) return ''

  const diff = now - timestamp
  const min = Math.floor(diff / 60000)
  if (min < 1) return t('session.timeJustNow')
  if (min < 60) return t('session.timeMinutes', { n: min })
  const hr = Math.floor(min / 60)
  if (hr < 24) return t('session.timeHours', { n: hr })
  const day = Math.floor(hr / 24)
  if (day < 30) return t('session.timeDays', { n: day })
  return new Intl.DateTimeFormat(undefined, { month: 'numeric', day: 'numeric' }).format(date)
}
