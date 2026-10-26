import type { DesktopPublicAccessConfiguration } from './types'

export const DEFAULT_PUBLIC_ACCESS_PORT = 17463

/** A tunnel publishes a whole HTTPS origin, never a path or a credential-bearing URL. */
export function normalizePublicAccessOrigin(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 2048) return null
  const input = value.trim()
  if (!/^https:\/\//i.test(input) || /[\s\\?#@]/.test(input)) return null
  try {
    const url = new URL(input)
    if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) return null
    return url.origin
  } catch { return null }
}

/** ngrok binds a registered DNS name; its domain option does not take an IP or port. */
export function normalizeNgrokDomain(value: unknown): string | null {
  const origin = normalizePublicAccessOrigin(value)
  if (!origin) return null
  const url = new URL(origin)
  if (url.port || url.hostname.length > 253 || /^\d+(\.\d+){3}$/.test(url.hostname)) return null
  const labels = url.hostname.split('.')
  if (labels.length < 2 || labels.some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))) return null
  return origin
}

/** Only ngrok's assigned account dev domains are safe to reuse automatically. */
export function isNgrokDevOrigin(value: unknown): boolean {
  const origin = normalizeNgrokDomain(value)
  return origin !== null && /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.ngrok-free\.(app|dev)$/.test(new URL(origin).hostname)
}

export function isPublicAccessConfiguration(value: unknown): value is DesktopPublicAccessConfiguration {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const config = value as Record<string, unknown>
  if (Object.keys(config).some(key => !['mode', 'customUrl', 'localPort', 'ngrokDomain'].includes(key))) return false
  if (config.mode !== 'ngrok' && config.mode !== 'custom') return false
  if (!Number.isInteger(config.localPort) || (config.localPort as number) < 1024 || (config.localPort as number) > 65535) return false
  if (typeof config.ngrokDomain !== 'string' || (config.ngrokDomain !== '' && normalizeNgrokDomain(config.ngrokDomain) === null)) return false
  return typeof config.customUrl === 'string' &&
    ((config.mode === 'ngrok' && config.customUrl === '') || normalizePublicAccessOrigin(config.customUrl) !== null)
}
