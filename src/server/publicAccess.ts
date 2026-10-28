import { createHash, randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Server, ServerWebSocket, WebSocketHandler } from 'bun'
import { isLocalAccessAuthorized } from './localAccessAuth.js'
import { setResponseHeaders } from './middleware/responseHeaders.js'
import { projectRemoteAgents, projectRemoteConnectors, projectRemoteSettings, projectRemoteWorkflows, remoteProviderRouteAllowed, remoteSettingsRouteAllowed, type ApiRequestContext } from './remoteBrowserPolicy.js'
import type { WebSocketData } from './ws/handler.js'

const PREFIX = '/api/public-access'
const COOKIE = '__Host-haha-remote'
const NATIVE_TOKEN_PREFIX = 'native_'
const PAIR_TTL = 5 * 60_000
const SESSION_TTL = 30 * 24 * 60 * 60_000
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const secret = () => randomBytes(32).toString('base64url')
type Device = { id: string, name: string, createdAt: number, expiresAt: number, tokenHash: string }
type Pending = { id: string, name: string, expiresAt: number, claimHash: string, status: 'pending' | 'approved' | 'rejected', clientType: 'browser' | 'native' }
type Stored = Record<string, unknown> & { version: number, devices: Device[] }
type RemoteData = WebSocketData & { remoteDeviceId: string }

/** v0 did not store devices. Never adopt legacy LAN bearer tokens as remote sessions. */
export function migratePublicAccessStore(value: unknown): Stored {
  const old = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
  if (typeof old.version === 'number' && old.version > 1) throw new Error('Unsupported remote device store version')
  const devices = Array.isArray(old.devices) ? old.devices.filter((item): item is Device => {
    if (!item || typeof item !== 'object') return false
    const d = item as Device
    return typeof d.id === 'string' && typeof d.name === 'string' &&
      Number.isFinite(d.createdAt) && Number.isFinite(d.expiresAt) && /^[a-f0-9]{64}$/.test(d.tokenHash)
  }) : []
  return { ...old, version: 1, devices }
}

export function isPublicBusinessPathAllowed(url: URL, method: string): boolean {
  // Match the business router's segment normalization, with a deny-by-default surface.
  const parts = url.pathname.split('/').filter(Boolean)
  if (parts[0] === 'ws') return parts.length === 2 && /^[\w-]{1,64}$/.test(parts[1]!)
  if (parts[0] !== 'api') return false
  // Only the profile projection is shared with phones, never the full preferences or mutations.
  if (parts[1] === 'desktop-ui') {
    return method === 'GET' && url.pathname === '/api/desktop-ui/preferences/profile' && !url.search
  }
  // Native project selection needs directory names, not the broader filesystem
  // file/search surface. Keep the exact route and its query contract read-only.
  if (parts[1] === 'filesystem') {
    return method === 'GET' && url.pathname === '/api/filesystem/browse' &&
      [...url.searchParams.keys()].every(key => key === 'path')
  }
  // Read-only catalogs for the phone's "+" sheet. Connector detail and every
  // connector action (authenticate, prepare, remove…) and every workflow
  // mutation or run detail remain desktop-only.
  if (parts[1] === 'connectors' || parts[1] === 'workflows') return parts.length === 2 && method === 'GET'
  if (parts[1] === 'skills') return parts.length === 3 &&
    (parts[2] === 'mentions' || parts[2] === 'commands') && method === 'GET'
  if (parts[1] === 'computer-use') {
    if (parts.length !== 3) return false
    return (parts[2] === 'status' && method === 'GET') ||
      (parts[2] === 'authorized-apps' && (method === 'GET' || method === 'PUT')) ||
      (parts[2] === 'open-permission-card' && method === 'POST')
  }
  if (parts[1] === 'sessions' && parts[2] === 'mobile-push') return parts.length === 3 ? method === 'GET' || method === 'PUT' || method === 'DELETE' : parts.length === 4 && (method === 'DELETE' || (parts[3] === 'test' && method === 'POST'))
  if (parts[1] === 'providers') return remoteProviderRouteAllowed(parts, method)
  if (parts[1] === 'settings') return remoteSettingsRouteAllowed(parts, method)
  if (parts[1] === 'scheduled-tasks') {
    if (parts.length === 2) return method === 'GET' || method === 'POST'
    if (parts[2] === 'runs') return method === 'GET' && (parts.length === 3 || parts.length === 4)
    if (parts.length === 3) return method === 'PUT' || method === 'DELETE'
    return parts.length === 4 && ((parts[3] === 'run' && method === 'POST') || (parts[3] === 'runs' && method === 'GET'))
  }
  if (method === 'PUT' && ['/api/models/current', '/api/effort'].includes('/' + parts.join('/'))) return true
  if (method === 'GET' && ['/api/settings/user', '/api/permissions/mode', '/api/providers/auth-status'].includes('/' + parts.join('/'))) return true
  if (['sessions', 'conversations'].includes(parts[1] ?? '')) return true
  // Agent 只有列表和单项两种 GET；路由器会忽略单项名字后面多出来的段，所以多出来的段不能放行。
  if (parts[1] === 'agents') return method === 'GET' && parts.length <= 3
  return method === 'GET' && ['models', 'effort', 'search', 'tasks', 'teams', 'activity-stats'].includes(parts[1] ?? '')
}

function secure(response: Response): Response {
  return setResponseHeaders(response, {
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Content-Security-Policy': "frame-ancestors 'none'; object-src 'none'; base-uri 'self'",
  })
}

function remoteComputerUseConsentPatch(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const patch = value as Record<string, unknown>
  if (Object.keys(patch).some(key => key !== 'enabled' && key !== 'grantFlags')) return false
  if (patch.enabled !== undefined && typeof patch.enabled !== 'boolean') return false
  if (patch.grantFlags !== undefined) {
    if (!patch.grantFlags || typeof patch.grantFlags !== 'object' || Array.isArray(patch.grantFlags)) return false
    return Object.entries(patch.grantFlags).every(([key, flag]) =>
      ['clipboardRead', 'clipboardWrite', 'systemKeyCombos'].includes(key) && typeof flag === 'boolean')
  }
  return true
}
const json = (value: unknown, status = 200) => secure(Response.json(value, { status }))

type Dependencies = {
  handleApiRequest: (request: Request, url: URL, context?: ApiRequestContext) => Promise<Response>
  handleStatic: (request: Request, url: URL) => Promise<Response | null>
  websocket: WebSocketHandler<WebSocketData>
  serverPort: () => number
  storePath?: string
  now?: () => number
}

/** The listener, not attacker-controlled headers, establishes the remote trust boundary. */
export class PublicAccessServer {
  private server: Server<RemoteData> | null = null
  private publicUrl: string | null = null
  private stored: Stored = { version: 1, devices: [] }
  private loaded = false
  private pairing: { hash: string, expiresAt: number } | null = null
  private pending = new Map<string, Pending>()
  private sockets = new Set<ServerWebSocket<RemoteData>>()
  private timer: ReturnType<typeof setInterval> | null = null
  private rates = new Map<string, { start: number, count: number }>()
  private readonly now: () => number
  private readonly storePath: string

  constructor(private deps: Dependencies) {
    this.now = deps.now ?? Date.now
    this.storePath = deps.storePath ?? path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'cc-haha', 'public-access-devices.json')
  }

  private load() {
    if (this.loaded) return
    let old: unknown = {}
    try { old = JSON.parse(readFileSync(this.storePath, 'utf8')) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    this.stored = migratePublicAccessStore(old)
    this.persist()
    this.loaded = true
  }

  private persist() {
    mkdirSync(path.dirname(this.storePath), { recursive: true, mode: 0o700 })
    const temporary = `${this.storePath}.${secret()}.tmp`
    writeFileSync(temporary, JSON.stringify(this.stored), { mode: 0o600 })
    renameSync(temporary, this.storePath)
  }

  status() {
    this.prune()
    return {
      enabled: this.server !== null,
      port: this.server?.port ?? null,
      publicUrl: this.publicUrl,
      pending: [...this.pending.values()].filter(p => p.status === 'pending').map(({ id, name }) => ({ id, name })),
      devices: this.stored.devices.map(({ id, name, createdAt, expiresAt }) => ({ id, name, createdAt, expiresAt })),
    }
  }

  private prune() {
    for (const [key, rate] of this.rates) if (this.now() - rate.start >= 60_000) this.rates.delete(key)
    for (const [id, p] of this.pending) if (p.expiresAt <= this.now()) this.pending.delete(id)
    this.stored.devices = this.stored.devices.filter(d => d.expiresAt > this.now())
    for (const ws of this.sockets) if (!this.authorizedDevice(ws.data.remoteDeviceId)) ws.close(1008, 'Remote access revoked')
  }

  private authorizedDevice(id: string) {
    return this.server !== null && this.stored.devices.some(d => d.id === id && d.expiresAt > this.now())
  }

  isDeviceActive(id: string) { return this.authorizedDevice(id) }

  private deviceFor(request: Request): Device | undefined {
    const authorization = request.headers.get('Authorization')
    // Native credentials are explicitly issued at pairing, never inferred from
    // a LAN/local bearer or a browser cookie. An invalid explicit credential
    // must not silently fall back to an ambient cookie belonging to another device.
    const token = authorization !== null
      ? /^Bearer (native_[A-Za-z0-9_-]{43})$/i.exec(authorization)?.[1]
      : request.headers.get('Cookie')?.split(';').map(s => s.trim()).find(s => s.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1)
    if (authorization === null && /^native_[A-Za-z0-9_-]{43}$/.test(token ?? '')) return undefined
    if (!token || token.length > 128 || !this.server) return undefined
    return this.stored.devices.find(d => d.tokenHash === hash(token) && d.expiresAt > this.now())
  }

  private rate(key: string, limit: number) {
    const current = this.rates.get(key)
    if (!current || this.now() - current.start >= 60_000) {
      this.rates.set(key, { start: this.now(), count: 1 })
      return true
    }
    return ++current.count <= limit
  }

  setOrigin(value: unknown) {
    if (typeof value !== 'string') throw new Error('HTTPS origin required')
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('HTTPS origin required')
    if (this.publicUrl && this.publicUrl !== url.origin) {
      this.pending.clear()
      this.pairing = null
      for (const ws of this.sockets) ws.close(1008, 'Remote origin changed')
    }
    this.publicUrl = url.origin
  }

  enable(publicUrl?: string, port?: number) {
    if (port !== undefined && (!Number.isInteger(port) || port < 1024 || port > 65535)) throw new Error('Invalid remote listener port')
    // A proxy's fixed upstream must never silently move, including while another
    // connection attempt already owns the gateway. Validate before changing origin.
    if (this.server && port !== undefined && this.server.port !== port) throw new Error('Remote listener already uses another port')
    this.load()
    if (publicUrl !== undefined) this.setOrigin(publicUrl)
    if (this.server) return this.status()
    this.server = Bun.serve<RemoteData>({
      hostname: '127.0.0.1', port: port ?? 0, idleTimeout: 0, maxRequestBodySize: 16 * 1024 * 1024,
      fetch: (req, server) => this.fetch(req, server),
      websocket: {
        maxPayloadLength: 1024 * 1024,
        open: ws => {
          if (!this.authorizedDevice(ws.data.remoteDeviceId) || this.sockets.size >= 64 || [...this.sockets].filter(s => s.data.remoteDeviceId === ws.data.remoteDeviceId).length >= 8) {
            ws.close(1008, 'Remote connection limit')
            return
          }
          this.sockets.add(ws)
          this.deps.websocket.open?.(ws)
        },
        message: (ws, message) => {
          if (!this.authorizedDevice(ws.data.remoteDeviceId)) { ws.close(1008, 'Remote access revoked'); return }
          if (!this.rate(`ws:${ws.data.remoteDeviceId}`, 600)) { ws.close(1008, 'Remote rate limit'); return }
          return this.deps.websocket.message(ws, message)
        },
        close: (ws, code, reason) => {
          if (this.sockets.delete(ws)) this.deps.websocket.close?.(ws, code, reason)
        },
        drain: ws => this.deps.websocket.drain?.(ws),
      },
    })
    this.timer = setInterval(() => this.prune(), 10_000)
    this.timer.unref()
    return this.status()
  }

  disable() {
    const listener = this.server
    this.server = null
    this.publicUrl = null
    this.pairing = null
    this.pending.clear()
    this.rates.clear()
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    // Disabling/rebuilding the tunnel does not revoke the stored device token.
    for (const ws of this.sockets) ws.close(1012, 'Remote access disabled')
    listener?.stop(true)
    return this.status()
  }

  /** This control route never inherits tokenless loopback or query-token trust. */
  async control(request: Request): Promise<Response> {
    if (!isLocalAccessAuthorized(request)) return json({ error: 'Desktop credential required' }, 403)
    try {
      this.load()
      const route = new URL(request.url).pathname.split('/').filter(Boolean).slice(2).join('/')
      if ((route === 'status' || route === '') && request.method === 'GET') return json(this.status())
      const input = request.method === 'GET' ? {} : await this.readInput(request)
      if (route === 'enable' && request.method === 'POST') {
        if (input.publicUrl !== undefined && typeof input.publicUrl !== 'string') throw new Error('HTTPS origin required')
        if (input.port !== undefined && typeof input.port !== 'number') throw new Error('Invalid remote listener port')
        return json(this.enable(input.publicUrl as string | undefined, input.port as number | undefined))
      }
      if (route === 'origin' && request.method === 'PUT') { this.setOrigin(input.publicUrl); return json(this.status()) }
      if (route === 'disable' && request.method === 'POST') return json(this.disable())
      if (route === 'pairing' && request.method === 'POST') {
        if (!this.server || !this.publicUrl) return json({ error: 'Remote access is not ready' }, 409)
        const token = secret()
        this.pairing = { hash: hash(token), expiresAt: this.now() + PAIR_TTL }
        return json({ secret: token, expiresAt: this.pairing.expiresAt })
      }
      const id = typeof input.id === 'string' ? input.id : ''
      if (route === 'revoke' && request.method === 'POST') {
        this.stored.devices = this.stored.devices.filter(d => d.id !== id)
        this.persist()
        this.prune()
        return json(this.status())
      }
      if (['approve', 'reject'].includes(route) && request.method === 'POST') {
        this.prune()
        const p = this.pending.get(id)
        if (!p || p.status !== 'pending') return json({ error: 'Pairing request expired' }, 404)
        p.status = route === 'approve' ? 'approved' : 'rejected'
        return json(this.status())
      }
      return json({ error: 'Not found' }, 404)
    } catch { return json({ error: 'Invalid remote access request or unavailable device store' }, 400) }
  }

  private async readInput(request: Request): Promise<Record<string, unknown>> {
    const text = await request.text()
    if (text.length > 4096) throw new Error('Request too large')
    if (!text) return {}
    const input: unknown = JSON.parse(text)
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Object required')
    return input as Record<string, unknown>
  }

  async fetch(request: Request, server: Server<RemoteData>): Promise<Response | undefined> {
    try {
      if (!this.server || !this.publicUrl) return json({ error: 'Remote access unavailable' }, 503)
      const url = new URL(request.url)
      const origin = request.headers.get('Origin')
      const isApiOrSocket = ['api', 'ws'].includes(url.pathname.split('/').filter(Boolean)[0] ?? '')
      const crossSite = ['cross-site', 'same-site'].includes(request.headers.get('Sec-Fetch-Site') ?? '')
      if ((origin && origin !== this.publicUrl) || (isApiOrSocket && crossSite)) return json({ error: 'Origin rejected' }, 403)
      if ((request.method !== 'GET' && request.method !== 'HEAD') || url.pathname.startsWith('/ws/')) {
        if (origin !== this.publicUrl) return json({ error: 'Origin required' }, 403)
      }
      if (url.pathname === '/health' && request.method === 'GET') return json({ status: 'ok' })
      const route = url.pathname.split('/').filter(Boolean).join('/')
      if (route.startsWith('api/public-access/')) {
        if (!this.rate('pairing-global', 180)) return json({ error: 'Too many requests' }, 429)
        if (route === 'api/public-access/session' && request.method === 'GET') {
          const device = this.deviceFor(request)
          return json(device ? { authenticated: true, expiresAt: device.expiresAt } : { authenticated: false })
        }
        const input = await this.readInput(request)
        this.prune()
        if (route === 'api/public-access/pair' && request.method === 'POST') {
          if (!this.rate('pair-attempts', 20)) return json({ error: 'Too many attempts' }, 429)
          if (input.clientType !== undefined && input.clientType !== 'browser' && input.clientType !== 'native') return json({ error: 'Unsupported pairing client type' }, 400)
          if (!this.pairing || this.pairing.expiresAt <= this.now() || typeof input.secret !== 'string' || hash(input.secret) !== this.pairing.hash) return json({ error: 'Pairing code expired or invalid' }, 401)
          if (this.stored.devices.length >= 32 || this.pending.size >= 8) return json({ error: 'Device limit reached' }, 429)
          const expiresAt = this.pairing.expiresAt
          this.pairing = null
          const id = secret()
          const claimSecret = secret()
          const clientType = input.clientType === 'native' ? 'native' : 'browser'
          const name = typeof input.name === 'string' ? input.name.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 80) : clientType === 'native' ? 'Mobile app' : 'Mobile browser'
          this.pending.set(id, { id, name, claimHash: hash(claimSecret), status: 'pending', expiresAt, clientType })
          return json({ id, claimSecret })
        }
        if (route === 'api/public-access/claim' && request.method === 'POST') {
          const p = typeof input.id === 'string' ? this.pending.get(input.id) : undefined
          if (!p || typeof input.claimSecret !== 'string' || hash(input.claimSecret) !== p.claimHash) return json({ error: 'Pairing request expired or invalid' }, 401)
          if (p.status !== 'approved') return json({ status: p.status })
          // The delivery mechanism is bound before desktop approval. Keep the
          // durable store hash-only and compatible with existing browser devices.
          const token = `${p.clientType === 'native' ? NATIVE_TOKEN_PREFIX : ''}${secret()}`
          const device = { id: p.id, name: p.name, createdAt: this.now(), expiresAt: this.now() + SESSION_TTL, tokenHash: hash(token) }
          this.stored.devices.push(device)
          try { this.persist() } catch (error) { this.stored.devices.pop(); throw error }
          this.pending.delete(p.id)
          if (p.clientType === 'native') return json({ status: 'approved', token, tokenType: 'Bearer', deviceId: device.id, expiresAt: device.expiresAt })
          return secure(Response.json({ status: 'approved' }, { headers: { 'Set-Cookie': `${COOKIE}=${token}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${SESSION_TTL / 1000}` } }))
        }
        return json({ error: 'Not found' }, 404)
      }
      const protectedPath = ['api', 'ws', 'sdk', 'proxy', 'local-file', 'preview-fs'].includes(url.pathname.split('/').filter(Boolean)[0] ?? '')
      if (protectedPath) {
        const device = this.deviceFor(request)
        if (!device) return json({ error: 'Device pairing required' }, 401)
        if (!isPublicBusinessPathAllowed(url, request.method)) return json({ error: 'Desktop-only capability' }, 403)
        if (route === 'api/computer-use/authorized-apps' && request.method === 'PUT') {
          let patch: unknown
          try { patch = await request.clone().json() } catch { return json({ error: 'Invalid JSON body' }, 400) }
          if (!remoteComputerUseConsentPatch(patch)) return json({ error: 'Only global Computer Use consent can be changed remotely' }, 403)
        }
        if (!this.rate(`api:${device.id}`, 1200)) return json({ error: 'Too many requests' }, 429)
        if (url.pathname.startsWith('/ws/')) {
          const upgraded = server.upgrade(request, { data: { sessionId: url.pathname.split('/').pop()!, connectedAt: this.now(), channel: 'client', clientKind: 'full', sdkToken: null, serverPort: this.deps.serverPort(), serverHost: '127.0.0.1', remoteDeviceId: device.id } })
          return upgraded ? undefined : json({ error: 'Upgrade failed' }, 400)
        }
        const response = await this.deps.handleApiRequest(request, url, { remoteBrowser: true, remoteDeviceId: device.id, remoteDeviceExpiresAt: device.expiresAt })
        if (route === 'api/providers/auth-status' && response.ok) {
          const status = await response.json() as Record<string, unknown>
          const sources = ['cc-haha-provider', 'claude-oauth', 'openai-oauth', 'grok-oauth', 'deepseek-oauth', 'original-settings', 'env', 'none']
          return json({
            hasAuth: status.hasAuth === true,
            source: typeof status.source === 'string' && sources.includes(status.source) ? status.source : 'none',
            ...(typeof status.activeProvider === 'string' ? { activeProvider: status.activeProvider } : {}),
          })
        }
        if (route === 'api/connectors' && request.method === 'GET' && response.ok) return json(projectRemoteConnectors(await response.json() as Record<string, unknown>))
        if (route === 'api/workflows' && request.method === 'GET' && response.ok) return json(projectRemoteWorkflows(await response.json() as Record<string, unknown>))
        // Native apps authenticate with a bearer; browsers use the cookie and keep the full agent view.
        if (request.headers.get('Authorization') !== null && request.method === 'GET' && response.ok &&
          /^api\/agents(\/|$)/.test(route)) {
          return json(projectRemoteAgents(await response.json() as Record<string, unknown>))
        }
        if (route === 'api/settings/user' && request.method === 'GET' && response.ok) {
          const settings = await response.json() as Record<string, unknown>
          return json(projectRemoteSettings(settings))
        }
        return secure(response)
      }
      if (url.pathname === '/') return secure(new Response(null, { status: 302, headers: { Location: '/remote' } }))
      return secure(await this.deps.handleStatic(request, url) ?? new Response('Not found', { status: 404 }))
    } catch { return json({ error: 'Remote request failed' }, 400) }
  }
}

export function isPublicAccessControlPath(pathname: string) {
  const normalized = `/${pathname.split('/').filter(Boolean).join('/')}`
  return normalized === PREFIX || normalized.startsWith(`${PREFIX}/`)
}
