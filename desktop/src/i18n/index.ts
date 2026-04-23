import { useSettingsStore } from '../stores/settingsStore'
import { en, type TranslationKey } from './locales/en'
import { zh } from './locales/zh'

export type Locale = 'en' | 'zh'

const translations: Record<Locale, Record<string, string>> = { en, zh }

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
 * t('sidebar.newSession')  // => "New session" or "新建会话"
 */
export function useTranslation() {
  const locale = useSettingsStore((s) => s.locale)
  return (key: TranslationKey, params?: Record<string, string | number>) =>
    translate(locale, key, params)
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
