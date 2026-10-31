import type { Host } from './types'

export class ConnectionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConnectionError'
  }
}

/** HTTP is allowed only for explicit private/LAN destinations. */
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
    throw new ConnectionError('请输入完整的 http:// 或 https:// 地址')
  }
  if (url.username || url.password)
    throw new ConnectionError('地址不能包含用户名或密码')
  if (!['http:', 'https:'].includes(url.protocol))
    throw new ConnectionError('只支持 HTTP 或 HTTPS 连接')
  if (
    url.protocol === 'http:' &&
    (auth === 'remote' || !isLocalHostname(url.hostname))
  )
    throw new ConnectionError('远程连接必须使用 HTTPS')
  if (url.pathname !== '/' || url.search || url.hash)
    throw new ConnectionError('主机地址只能包含协议、主机名和端口')
  return url.origin
}

function secret(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (
    typeof value !== 'string' ||
    value.length > 4096 ||
    /\s|[\u0000-\u001f\u007f]/.test(value)
  )
    throw new ConnectionError('连接凭据格式无效')
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
    throw new ConnectionError('连接地址为空或过长')
  if (raw.startsWith('{')) {
    let value: unknown
    try {
      value = JSON.parse(raw)
    } catch {
      throw new ConnectionError('二维码内容不是有效 JSON')
    }
    if (
      !value ||
      typeof value !== 'object' ||
      !('serverUrl' in value) ||
      typeof value.serverUrl !== 'string'
    )
      throw new ConnectionError('二维码缺少服务器地址')
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
    throw new ConnectionError('请输入完整的连接地址')
  }
  if (
    url.username ||
    url.password ||
    !['http:', 'https:'].includes(url.protocol)
  )
    throw new ConnectionError('连接地址格式无效')
  const params = url.searchParams
  const fragment = new URLSearchParams(url.hash.slice(1))
  if (fragment.has('pair')) {
    if (url.search || (url.pathname !== '/' && url.pathname !== '/remote'))
      throw new ConnectionError('远程配对地址格式无效')
    const pairSecret = secret(fragment.get('pair'))
    if (
      !pairSecret ||
      fragment.getAll('pair').length !== 1 ||
      [...fragment.keys()].some((key) => key !== 'pair')
    )
      throw new ConnectionError('配对码无效')
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
      throw new ConnectionError('局域网二维码格式无效')
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

export function connectionHeaders(
  host: Host,
  credential: string
): Record<string, string> {
  const token = secret(credential)
  const headers: Record<string, string> = {}
  if (token) headers.Authorization = `Bearer ${token}`
  if (host.auth === 'remote')
    headers.Origin = normalizeHostUrl(host.url, 'remote')
  return headers
}

export function buildSocketOptions(
  host: Host,
  credential: string,
  sessionId: string,
  platform: 'native' | 'web'
): { url: string; headers?: Record<string, string> } {
  if (!sessionId || sessionId.length > 256 || /[\s/\\?#]/.test(sessionId))
    throw new ConnectionError('会话标识无效')
  if (!secret(credential)) throw new ConnectionError('缺少连接凭据')
  const url = new URL(normalizeHostUrl(host.url, host.auth))
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  url.pathname = `/ws/${encodeURIComponent(sessionId)}`
  // Tool images arrive as references; the bytes are fetched only when drawn.
  url.searchParams.set('media', 'ref')
  if (platform === 'web') {
    if (host.auth === 'remote')
      throw new ConnectionError('远程凭据需要原生 App，浏览器预览不支持此连接')
    url.searchParams.set('token', credential)
    return { url: url.toString() }
  }
  const headers = connectionHeaders(host, credential)
  // Android otherwise invents a browser Origin from the endpoint. Native LAN
  // aliases still use bearer authentication and need no browser-origin claim.
  if (host.auth === 'lan') headers.Origin = ''
  return { url: url.toString(), headers }
}
