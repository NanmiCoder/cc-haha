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

/** Serve's certificate belongs to a device's tailnet DNS name. */
export function normalizeTailscaleOrigin(value: unknown): string | null {
  const origin = normalizePublicAccessOrigin(value)
  if (!origin) return null
  const url = new URL(origin)
  const labels = url.hostname.split('.')
  if (url.hostname.length > 253 || labels.length < 4 || labels.slice(-2).join('.') !== 'ts.net') return null
  if (labels.some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) return null
  if (url.port && (Number(url.port) < 1 || Number(url.port) > 65535)) return null
  return origin
}

function isLocalPort(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 1024 && (value as number) <= 65535
}

/** The caller copies this command; the app never executes user-supplied shell text. */
export function buildTailscaleServeCommand(localPort: number, origin?: string): string | null {
  if (!isLocalPort(localPort)) return null
  const normalized = origin === undefined || origin === '' ? null : normalizeTailscaleOrigin(origin)
  if (origin && !normalized) return null
  const port = normalized ? new URL(normalized).port : ''
  return `tailscale serve --bg${port ? ` --https=${port}` : ''} http://127.0.0.1:${localPort}`
}

export function isPublicAccessConfiguration(value: unknown): value is DesktopPublicAccessConfiguration {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const config = value as Record<string, unknown>
  if (Object.keys(config).some(key => !['mode', 'customUrl', 'localPort'].includes(key))) return false
  return config.mode === 'tailscale' && isLocalPort(config.localPort) && typeof config.customUrl === 'string' &&
    (config.customUrl === '' || normalizeTailscaleOrigin(config.customUrl) !== null)
}
