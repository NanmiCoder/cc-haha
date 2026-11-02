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

const STANDARD_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/
const TUNNEL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const BASE64_RUN = /[A-Za-z0-9+/]{32,}={0,2}/g

/**
 * Reads a credential the way cloudflared does: standard base64 of a JSON object with
 * account tag `a`, tunnel UUID `t` and base64 secret `s`.
 */
export function readCloudflareTunnelToken(value: string): { tunnelId: string } | null {
  if (value.length > 8192 || !STANDARD_BASE64.test(value)) return null
  try {
    const credential: unknown = JSON.parse(atob(value))
    if (!credential || typeof credential !== 'object' || Array.isArray(credential)) return null
    const { a, t, s } = credential as Record<string, unknown>
    if (typeof a !== 'string' || !a || typeof t !== 'string' || !TUNNEL_ID.test(t)) return null
    if (typeof s !== 'string' || !s || !STANDARD_BASE64.test(s)) return null
    return { tunnelId: t.toLowerCase() }
  } catch { return null }
}

export type CloudflareTunnelTokenInput =
  | { status: 'found', token: string, tunnelId: string }
  | { status: 'missing' | 'ambiguous' }

/** Cloudflare shows the token only inside its install commands; any of them yields just the credential. */
export function findCloudflareTunnelToken(text: string): CloudflareTunnelTokenInput {
  const tokens = new Map<string, string>()
  for (const [candidate] of text.matchAll(BASE64_RUN)) {
    const credential = readCloudflareTunnelToken(candidate)
    if (credential) tokens.set(candidate, credential.tunnelId)
  }
  const [found, ...others] = tokens
  if (!found) return { status: 'missing' }
  if (others.length) return { status: 'ambiguous' }
  return { status: 'found', token: found[0], tunnelId: found[1] }
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
