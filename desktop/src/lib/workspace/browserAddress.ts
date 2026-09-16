import { isHtmlFilePath } from '../htmlPreviewPolicy'

/** Address bar input; local HTML still goes through the existing preview router. */
export function normalizeBrowserAddress(input: string): string {
  const value = input.trim()
  if (!value) return ''
  if (/^https?:\/\//i.test(value)) return value
  if (/^(localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::\d+)?(?:[/?#].*)?$/i.test(value)) {
    return `http://${value}`
  }
  if (/^[^\s/:]+\.[^\s/:]+(?::\d+)?(?:[/?#].*)?$/u.test(value) && !isHtmlFilePath(value.split('/')[0]!)) {
    return `https://${value}`
  }
  if (isHtmlFilePath(value)) return value
  if (/^[a-z][a-z\d+.-]*:/i.test(value)) return ''
  return `https://www.google.com/search?q=${encodeURIComponent(value)}`
}
