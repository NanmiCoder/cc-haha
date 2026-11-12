import { describe, expect, it } from 'vitest'
import { translate, type Locale } from '../i18n'
import { formatMessageTimestamp } from './formatMessageTimestamp'

const t = (locale: Locale) => (
  key: Parameters<typeof translate>[1],
  params?: Parameters<typeof translate>[2],
) => translate(locale, key, params)

describe('formatMessageTimestamp', () => {
  const now = new Date(2026, 4, 29, 16, 0).getTime()

  it('uses relative labels for recent messages', () => {
    expect(formatMessageTimestamp(now - 2 * 60 * 60_000, t('en'), 'en', now)).toBe('2h ago')
  })

  it('uses weekday and clock time for recent history', () => {
    const value = new Date(2026, 4, 24, 15, 50).getTime()

    expect(formatMessageTimestamp(value, t('en'), 'en', now)).toBe('Sun 15:50')
  })

  it('includes the calendar date for older messages', () => {
    const value = new Date(2026, 3, 20, 9, 30).getTime()

    expect(formatMessageTimestamp(value, t('en'), 'en', now)).toBe('Apr 20 09:30')
  })

  it('includes the year for messages from an earlier year', () => {
    const value = new Date(2025, 11, 15, 9, 30).getTime()

    expect(formatMessageTimestamp(value, t('en'), 'en', now)).toBe('Dec 15, 2025 09:30')
  })
})
