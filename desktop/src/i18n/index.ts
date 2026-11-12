import { useCallback } from 'react'
import { useSettingsStore } from '../stores/settingsStore'
import { en, type TranslationKey } from './locales/en'
import type { Locale } from './locale'

const translations: Record<Locale, Record<string, string>> = {
  en,
}

/**
 * Translate a key with optional interpolation params.
 * Falls back to the key itself if no translation is found.
 *
 * @example
 * translate('en', 'settings.providers.connected', { latency: '42' })
 * // => "Connected (42ms)"
 */
export function translate(
  locale: Locale,
  key: TranslationKey,
  params?: Record<string, string | number>,
): string {
  let text = translations[locale]?.[key] ?? translations.en[key] ?? key
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      text = text.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v))
    }
  }
  return text
}

/**
 * React hook that returns a `t()` function bound to the current locale.
 * Re-renders when the locale changes.
 *
 * @example
 * const t = useTranslation()
 * t('sidebar.newSession')  // => "New session"
 */
export function useTranslation() {
  const locale = useSettingsStore((s) => s.locale)
  return useCallback(
    (key: TranslationKey, params?: Record<string, string | number>) =>
      translate(locale, key, params),
    [locale],
  )
}

/**
 * Get a translation outside of React (e.g. in stores).
 * Reads the current locale from the Zustand store directly.
 */
export function t(key: TranslationKey, params?: Record<string, string | number>): string {
  const locale = useSettingsStore.getState().locale
  return translate(locale, key, params)
}

export type { TranslationKey }
export type { Locale } from './locale'
