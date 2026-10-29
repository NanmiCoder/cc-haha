import type { DesktopPublicAccessConfiguration } from './types'

export const DEFAULT_PUBLIC_ACCESS_PORT = 17463

/** A gateway publishes a whole HTTPS origin, never a credential-bearing URL. */
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

function isLocalPort(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 1024 && (value as number) <= 65535
}

/** The connector receives an opaque Cloudflare credential, never shell text. */
export function isCloudflareTunnelToken(value: unknown): value is string | undefined {
  return value === undefined || value === '' ||
    (typeof value === 'string' && value.length >= 32 && value.length <= 8192 && /^[A-Za-z0-9_+/=-]+$/.test(value))
}

export function isPublicAccessConfiguration(value: unknown): value is DesktopPublicAccessConfiguration {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const config = value as Record<string, unknown>
  if (Object.keys(config).some(key => !['mode', 'customUrl', 'localPort', 'tunnelToken'].includes(key))) return false
  if (!['quick', 'named'].includes(String(config.mode)) || !isLocalPort(config.localPort) || !isCloudflareTunnelToken(config.tunnelToken)) return false
  return typeof config.customUrl === 'string' && (config.mode === 'quick'
    ? config.customUrl === ''
    : config.customUrl === '' || normalizePublicAccessOrigin(config.customUrl) !== null)
}
