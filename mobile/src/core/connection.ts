import type { Host } from './types'

export class ConnectionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConnectionError'
  }
}

/** Used to choose the default authentication flow for an HTTPS address. */
export function isLocalHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host === '::1'
  )
    return true
  if (/^(fc|fd)[0-9a-f]{2}:/.test(host) || /^fe[89ab][0-9a-f]:/.test(host))
    return true
  const pieces = host.split('.').map(Number)
  if (
    pieces.length !== 4 ||
    !pieces.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)
  )
    return false
  const [a, b] = pieces
  return (
    a === 10 ||
    a === 127 ||
    (a === 192 && b === 168) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 169 && b === 254)
  )
}

export function normalizeHostUrl(input: string, auth: Host['auth']): string {
  let url: URL
  try {
    url = new URL(input.trim())
  } catch {
    throw new ConnectionError('Please enter a full http:// or https:// address')
  }
  if (url.username || url.password)
    throw new ConnectionError('Address cannot contain a username or password')
  if (!['http:', 'https:'].includes(url.protocol))
    throw new ConnectionError('Only HTTP or HTTPS connections are supported')
  // Explicit HTTP addresses use the access-token flow, including private DNS
  // names and VPN hosts. Device pairing still requires an HTTPS origin.
  if (url.protocol === 'http:' && auth === 'remote')
    throw new ConnectionError('Remote connections must use HTTPS')
  if (url.pathname !== '/' || url.search || url.hash)
    throw new ConnectionError('Host address can only contain protocol, host name and port')
  return url.origin
}

function secret(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (
    typeof value !== 'string' ||
    value.length > 4096 ||
    /\s|[\u0000-\u001f\u007f]/.test(value)
  )
    throw new ConnectionError('Invalid connection credential format')
  return value
}

export type ParsedConnection = {
  url: string
  auth: Host['auth']
  credential?: string
  pairSecret?: string
}

/** Accepts desktop LAN QR URLs, their JSON equivalent, a raw origin or a remote #pair URL. */
export function parseConnectionInput(input: string): ParsedConnection {
  const raw = input.trim()
  if (!raw || raw.length > 16384)
    throw new ConnectionError('Connection address is empty or too long')
  if (raw.startsWith('{')) {
    let value: unknown
    try {
      value = JSON.parse(raw)
    } catch {
      throw new ConnectionError('QR code content is not a valid JSON')
    }
    if (
      !value ||
      typeof value !== 'object' ||
      !('serverUrl' in value) ||
      typeof value.serverUrl !== 'string'
    )
      throw new ConnectionError('QR code is missing the server address')
    return {
      url: normalizeHostUrl(value.serverUrl, 'lan'),
      auth: 'lan',
      credential: secret('h5Token' in value ? value.h5Token : undefined),
    }
  }
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new ConnectionError('Please enter the full connection address')
  }
  if (
    url.username ||
    url.password ||
    !['http:', 'https:'].includes(url.protocol)
  )
    throw new ConnectionError('Invalid connection address format')
  const params = url.searchParams
  const fragment = new URLSearchParams(url.hash.slice(1))
  if (fragment.has('pair')) {
    if (url.search || (url.pathname !== '/' && url.pathname !== '/remote'))
      throw new ConnectionError('Invalid remote pairing address format')
    const pairSecret = secret(fragment.get('pair'))
    if (
      !pairSecret ||
      fragment.getAll('pair').length !== 1 ||
      [...fragment.keys()].some((key) => key !== 'pair')
    )
      throw new ConnectionError('Invalid pairing code')
    return {
      url: normalizeHostUrl(url.origin, 'remote'),
      auth: 'remote',
      pairSecret,
    }
  }
  if (params.has('serverUrl') || params.has('h5Token')) {
    if (
      url.hash ||
      params.getAll('serverUrl').length > 1 ||
      params.getAll('h5Token').length > 1 ||
      [...params.keys()].some((key) => !['serverUrl', 'h5Token'].includes(key))
    )
      throw new ConnectionError('Invalid LAN QR code format')
    return {
      url: normalizeHostUrl(params.get('serverUrl') || url.origin, 'lan'),
      auth: 'lan',
      credential: secret(params.get('h5Token')),
    }
  }
  const auth =
    url.protocol === 'https:' && !isLocalHostname(url.hostname)
      ? 'remote'
      : 'lan'
  return { url: normalizeHostUrl(raw, auth), auth }
}

/** The origin requests go to; see {@link Host.page} for the H5 page's own computer. */
export function hostOrigin(host: Host): string {
  return host.page ? new URL(host.url).origin : normalizeHostUrl(host.url, host.auth)
}

export function connectionHeaders(
  host: Host,
  credential: string
): Record<string, string> {
  const token = secret(credential)
  const headers: Record<string, string> = {}
  if (token) headers.Authorization = `Bearer ${token}`
  if (host.auth === 'remote')
    headers.Origin = host.page ? hostOrigin(host) : normalizeHostUrl(host.url, 'remote')
  return headers
}

export function buildSocketOptions(
  host: Host,
  credential: string,
  sessionId: string,
  platform: 'native' | 'web'
): { url: string; headers?: Record<string, string> } {
  if (!sessionId || sessionId.length > 256 || /[\s/\\?#]/.test(sessionId))
    throw new ConnectionError('Invalid session ID')
  const token = secret(credential)
  // A browser page served by the computer itself (H5) may have no token: its
  // device cookie or the loopback address authenticates the socket instead.
  if (!token && platform !== 'web') throw new ConnectionError('Missing connection credentials')
  const url = new URL(hostOrigin(host))
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  url.pathname = `/ws/${encodeURIComponent(sessionId)}`
  // Tool images arrive as references; the bytes are fetched only when drawn.
  url.searchParams.set('media', 'ref')
  if (platform === 'web') {
    if (host.auth === 'remote' && token)
      throw new ConnectionError('Remote credentials require the native app; browser preview does not support this connection')
    if (token) url.searchParams.set('token', token)
    return { url: url.toString() }
  }
  const headers = connectionHeaders(host, credential)
  // Android otherwise invents a browser Origin from the endpoint. Native LAN
  // aliases still use bearer authentication and need no browser-origin claim.
  if (host.auth === 'lan') headers.Origin = ''
  return { url: url.toString(), headers }
}
