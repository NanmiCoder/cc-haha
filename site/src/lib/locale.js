/**
 * 站点语言分流。
 *
 * 只有根路径 `/` 会按保存的选择分流：没有选择时，浏览器首选语言是中文就留在中文页，
 * 其余语言跳 `/en`。
 * 带语言前缀的地址（`/en`、`/start`、`/en/start`）都是用户点进来的明确意图，一概不动 ——
 * 否则英文用户点一条中文文档链接会被莫名踢走。
 *
 * 手动切过语言之后，选择记进 localStorage，之后回到 `/` 就按记住的来。
 *
 * 注意：同一套判断在 index.html 里有一份内联副本 —— 首帧就得跳完，等不到这个模块加载。
 * 改 STORAGE_KEY 或浏览器语言判断时两处要一起改，check-docs.mjs 会盯着它们不漂移。
 */

export const LOCALE_STORAGE_KEY = 'cch-locale'
export const DEFAULT_LOCALE = 'en'

export function resolveBrowserLocale({ language, languages } = {}) {
  const preferredLanguage = languages?.[0] || language || ''
  return /^zh(?:[-_]|$)/i.test(preferredLanguage) ? 'zh' : DEFAULT_LOCALE
}

export function normalizeStoredLocale(value) {
  return value === 'en' || value === 'zh' ? value : null
}

/**
 * 根路径该跳去哪；返回 null 表示留在原地（用户选择了中文站）。
 */
export function resolveRootRedirect({ pathname, stored, language, languages }) {
  if (String(pathname ?? '/').replace(/\/+$/, '') !== '') return null

  const locale = normalizeStoredLocale(stored) || resolveBrowserLocale({ language, languages })
  return locale === 'en' ? '/en' : null
}

export function rememberLocale(locale) {
  const value = normalizeStoredLocale(locale)
  if (!value) return

  try {
    localStorage.setItem(LOCALE_STORAGE_KEY, value)
  } catch {
    // 隐私模式下 localStorage 直接抛，记不住偏好也不能让语言切换本身失败。
  }
}
