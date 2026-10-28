/**
 * Adapter i18n.
 *
 * Locale resolution happens once per process (see `common/config.ts`):
 *   ADAPTER_LOCALE (env) > `locale` in ~/.claude/adapters.json > zh
 *
 * Chinese stays the default so existing installations behave exactly as
 * before; English and Vietnamese are opt-in.
 *
 * Lookup order for a missing key: requested locale -> English -> Chinese.
 * A key missing everywhere is returned verbatim so a bad translation never
 * hides the message entirely.
 */
import en from './locales/en.json'
import vi from './locales/vi.json'
import zh from './locales/zh.json'

export type Locale = 'en' | 'vi' | 'zh'

export const SUPPORTED_LOCALES: readonly Locale[] = ['en', 'vi', 'zh']
export const DEFAULT_LOCALE: Locale = 'zh'

const CATALOGS: Record<Locale, Record<string, string>> = { en, vi, zh }

let currentLocale: Locale = DEFAULT_LOCALE

/** Accept `en`, `en-US`, `vi_VN`, `zh-Hans`, … and return a supported base locale. */
export function normalizeLocale(value: unknown): Locale | null {
  if (typeof value !== 'string') return null
  const base = value.trim().toLowerCase().split(/[-_]/)[0]
  return (SUPPORTED_LOCALES as readonly string[]).includes(base) ? (base as Locale) : null
}

/** Set the process locale. Unsupported values fall back to the default. */
export function setLocale(value: unknown): Locale {
  currentLocale = normalizeLocale(value) ?? DEFAULT_LOCALE
  return currentLocale
}

export function getLocale(): Locale {
  return currentLocale
}

/**
 * Translate a key, interpolating `{name}` placeholders.
 * `locale` is only needed to render a string for someone other than the
 * process default (for example, a per-user locale override).
 */
export function t(
  key: string,
  params?: Record<string, string | number>,
  locale: Locale = currentLocale,
): string {
  const catalog = CATALOGS[locale] ?? CATALOGS[DEFAULT_LOCALE]
  const template = catalog[key] ?? CATALOGS.en[key] ?? CATALOGS.zh[key] ?? key
  if (!params) return template
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = params[name]
    return value === undefined ? match : String(value)
  })
}
