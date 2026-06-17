/**
 * Minimal gettext-style i18n for cc-haha.
 *
 * Design goals:
 *   1. No runtime dependencies beyond what's already in utils/.
 *   2. Deterministic — locale is resolved once per process (from env + settings).
 *   3. Fallback is always English — missing keys simply return the source string.
 *   4. Typed: `t(key, vars?)` gives mild type safety via string literals.
 *
 * Use:
 *   import { t, setLocale } from 'src/utils/i18n/index.js'
 *   console.log(t('secure_storage_plaintext_warning'))
 *   // "Warning: Storing credentials in plaintext."
 */

import memoize from 'lodash-es/memoize.js'
import { zhCN } from './locales/zh_CN.js'
import { zhTW } from './locales/zh_TW.js'
import { en } from './locales/en.js'

export type Locale = 'en' | 'zh-CN' | 'zh-TW'

export type TranslationKey =
  | keyof typeof en
  | keyof typeof zhCN
  | keyof typeof zhTW
  | (string & {}) // allow arbitrary strings too (they fall through)

const CATALOGS: Record<Locale, Partial<Record<string, string>>> = {
  en,
  'zh-CN': zhCN,
  'zh-TW': zhTW,
}

function detectLocale(): Locale {
  const env =
    process.env.CC_HAHA_LOCALE ||
    process.env.LANG ||
    process.env.LC_ALL ||
    process.env.LC_MESSAGES ||
    ''
  const normalized = env.replace(/\.[^.]+$/, '').toLowerCase()
  if (normalized.startsWith('zh-tw') || normalized.startsWith('zh_hant') || normalized === 'zh_hk') {
    return 'zh-TW'
  }
  if (normalized.startsWith('zh')) return 'zh-CN'
  return 'en'
}

let currentLocale: Locale = detectLocale()

export function setLocale(l: Locale | string): void {
  const lower = (l || '').toLowerCase()
  if (lower === 'zh-tw' || lower === 'zh_hant') currentLocale = 'zh-TW'
  else if (lower.startsWith('zh')) currentLocale = 'zh-CN'
  else currentLocale = 'en'
  // Sync to env so child processes and the CLI startup path pick it up
  process.env.CC_HAHA_LOCALE = currentLocale
}

export function getLocale(): Locale {
  return currentLocale
}

function interpolate(source: string, vars?: Record<string, string | number>): string {
  if (!vars) return source
  return source.replace(/%\{(\w+)\}/g, (_m, key: string) => {
    const v = vars[key]
    return v === undefined ? `%{${key}}` : String(v)
  })
}

function resolve(key: string): string {
  const catalog = CATALOGS[currentLocale]
  const candidate = catalog?.[key]
  if (typeof candidate === 'string') return candidate
  if (currentLocale === 'zh-TW') {
    const fallback = CATALOGS['zh-CN']?.[key]
    if (typeof fallback === 'string') return fallback
  }
  return key
}

/**
 * Main translation call — memoized so lookups are effectively free on hot paths.
 * Variables are substituted with `%{name}` placeholders.
 */
export const t = memoize(
  function translate(key: string, vars?: Record<string, string | number>): string {
    return interpolate(resolve(key), vars)
  },
  (k, v) => (v ? `${k}::${JSON.stringify(v)}` : k),
)

/** Reset locale detection — mostly useful for tests. */
export function resetLocale(): void {
  currentLocale = detectLocale()
  t.cache?.clear?.()
}
