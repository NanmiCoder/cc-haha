import { createHash, createHmac, randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Server, ServerWebSocket, WebSocketHandler } from 'bun'
import { isLocalAccessAuthorized } from './localAccessAuth.js'
import { setResponseHeaders } from './middleware/responseHeaders.js'
import { projectRemoteAgents, projectRemoteConnectors, projectRemoteSettings, projectRemoteWorkflows, remoteProviderRouteAllowed, remoteSettingsRouteAllowed, type ApiRequestContext } from './remoteBrowserPolicy.js'
import type { WebSocketData } from './ws/handler.js'
import { parseResumeRequest } from './ws/resumableStreams.js'
import type { TunnelGateway } from './p2p/mux.js'
import { NativeRemoteIdentity, isNativeRemotePublicKey } from './nativeRemoteIdentity.js'
import { parseRemoteOrigin, remoteCanonical, REMOTE_CHALLENGE_TTL_MS, REMOTE_ID_PATTERN, REMOTE_NONCE_PATTERN, verifyRemoteSignature } from '../shared/remoteIdentityProtocol.js'

const PREFIX = '/api/public-access'
const COOKIE = '__Host-haha-remote'
const NATIVE_TOKEN_PREFIX = 'native_'
const PAIR_TTL = 5 * 60_000
const SESSION_TTL = 30 * 24 * 60 * 60_000
const NATIVE_SESSION_TTL = 24 * 60 * 60_000
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const secret = () => randomBytes(32).toString('base64url')
type Device = Record<string, unknown> & { id: string, name: string, createdAt: number, expiresAt: number, tokenHash: string, origin: string | null, nativePublicKey?: string, portableNative?: true }
type Pending = { id: string, name: string, expiresAt: number, claimHash: string, status: 'pending' | 'approved' | 'rejected', clientType: 'browser' | 'native' }
type Stored = Record<string, unknown> & { version: 2, origin: string | null, devices: Device[], lastPublicUrl?: unknown }
type RemoteData = WebSocketData & { remoteDeviceId: string, remoteOrigin: string, remoteTokenHash: string }
type NativeChallenge = { nonce: string, origin: string, expiresAt: number }

/**
 * Proof that a computer holding this device's pairing produced `message`. The
 * phone derives the same key from its own credential (`sha256hex(token)`), so a
 * relayed or LAN answer cannot be forged without the pairing.
 */
export const deviceMac = (tokenHash: string, message: string) =>
  createHmac('sha256', tokenHash).update(message).digest('base64url')

const PRIVATE_V4 = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/
/** Addresses a phone on the same network (or tailnet) may reach the gateway's port at. */
export function lanAddresses(interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]>): string[] {
  const found: string[] = []
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal && PRIVATE_V4.test(entry.address) && !found.includes(entry.address)) found.push(entry.address)
    }
  }
  return found.slice(0, 6)
}

/** v1 cookies lack an origin binding. Preserve their records without granting access on a new origin. */
export function migratePublicAccessStore(value: unknown): Stored {
  const old = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
  if (typeof old.version === 'number' && old.version > 2) throw new Error('Unsupported remote device store version')
  const legacyOrigin = old.version === 1 ? parseRemoteOrigin(old.lastPublicUrl) : null
  const devices = Array.isArray(old.devices) ? old.devices.flatMap((item): Device[] => {
    if (!item || typeof item !== 'object') return []
    const d = item as Device
    if (typeof d.id !== 'string' || typeof d.name !== 'string' ||
      !Number.isFinite(d.createdAt) || !Number.isFinite(d.expiresAt) ||
      !(typeof d.tokenHash === 'string' && (/^[a-f0-9]{64}$/.test(d.tokenHash) || (old.version === 2 && d.tokenHash === '')))) return []
    const { nativePublicKey, portableNative, ...rest } = d
    return [{ ...rest, origin: old.version === 2 ? parseRemoteOrigin(d.origin) : legacyOrigin,
      ...(legacyOrigin || (old.version === 2 && portableNative === true) ? { portableNative: true } : {}),
      ...(old.version === 2 && isNativeRemotePublicKey(nativePublicKey) ? { nativePublicKey } : {}) }]
  }) : []
  return { ...old, version: 2, origin: old.version === 2 ? parseRemoteOrigin(old.origin) : legacyOrigin, devices }
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
  if (parts[1] === 'voice') {
    // Phones reuse the host's prepared recognizer. Download, deletion and
    // shared preference changes stay on the desktop's settings surface.
    if (method === 'GET') {
      return !url.search && (url.pathname === '/api/voice/catalog' ||
        /^\/api\/voice\/providers\/[^/]+\/status$/.test(url.pathname))
    }
    return method === 'POST' && url.pathname === '/api/voice/transcribe' &&
      [...url.searchParams.keys()].every(key =>
        (key === 'provider' || key === 'language') && url.searchParams.getAll(key).length === 1,
      )
  }
  if (parts[1] === 'skills') return parts.length === 3 &&
    (parts[2] === 'mentions' || parts[2] === 'commands') && method === 'GET'
  if (parts[1] === 'computer-use') {
    if (parts.length !== 3) return false
    return (parts[2] === 'status' && method === 'GET') ||
      (parts[2] === 'authorized-apps' && (method === 'GET' || method === 'PUT')) ||
      (parts[2] === 'open-permission-card' && method === 'POST')
  }
  if (parts[1] === 'sessions' && parts[2] === 'mobile-push') return parts.length === 3 ? method === 'GET' || method === 'PUT' || method === 'DELETE' : parts.length === 4 && (method === 'DELETE' || ((parts[3] === 'test' || parts[3] === 'pull') && method === 'POST'))
  if (parts[1] === 'providers') return remoteProviderRouteAllowed(parts, method)
  if (parts[1] === 'settings') return remoteSettingsRouteAllowed(parts, method)
  if (parts[1] === 'scheduled-tasks') {
    if (parts[2] === 'notification-capabilities') return method === 'GET' &&
      url.pathname === '/api/scheduled-tasks/notification-capabilities' && !url.search
    if (parts.length === 2) return method === 'GET' || method === 'POST'
    if (parts[2] === 'runs') return method === 'GET' && (parts.length === 3 || parts.length === 4)
    if (parts.length === 3) return method === 'PUT' || method === 'DELETE'
    return parts.length === 4 && ((parts[3] === 'run' && method === 'POST') || (parts[3] === 'runs' && method === 'GET'))
  }
  if (method === 'PUT' && ['/api/models/current', '/api/effort'].includes('/' + parts.join('/'))) return true
  if (method === 'GET' && ['/api/settings/user', '/api/permissions/mode', '/api/providers/auth-status'].includes('/' + parts.join('/'))) return true
  if (['sessions', 'conversations'].includes(parts[1] ?? '')) return true
  // A submitted team waits on a human review of its plan; the phone must be
  // able to finish it. Members, messages and team deletion stay desktop-only.
  if (parts[1] === 'teams' && parts.length >= 4 && parts[3] === 'plan') {
    if (parts.length === 4) return method === 'PATCH'
    return parts.length === 5 && method === 'POST' && ['approve', 'return', 'cancel', 'retry', 'end'].includes(parts[4]!)
  }
  // Agent 只有列表和单项两种 GET；路由器会忽略单项名字后面多出来的段，所以多出来的段不能放行。
  if (parts[1] === 'agents') return method === 'GET' && parts.length <= 3
  return method === 'GET' && ['models', 'effort', 'search', 'tasks', 'teams', 'activity-stats'].includes(parts[1] ?? '')
}

function secure(response: Response, cacheControl = 'no-store'): Response {
  return setResponseHeaders(response, {
    'Cache-Control': cacheControl,
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

/** The P2P broker as the gateway sees it (see p2p/broker.ts). */
type P2PSignaling = {
  readonly available: boolean
  iceServers(): unknown
  offer(deviceId: string, input: Record<string, unknown>): Promise<unknown>
  candidates(deviceId: string, input: Record<string, unknown>): Promise<unknown>
}
/** Bun's upgrade entry point, or the P2P multiplexer's stand-in for it. */
type Upgrader = { upgrade(request: Request, options: { data: RemoteData }): boolean }

type Dependencies = {
  handleApiRequest: (request: Request, url: URL, context?: ApiRequestContext) => Promise<Response>
  handleStatic: (request: Request, url: URL) => Promise<Response | null>
  websocket: WebSocketHandler<WebSocketData>
  /** End a device's resumable streams, including detached ones no socket points at. */
  terminateDeviceStreams?: (deviceId: string) => void
  /** Phone-to-desktop direct connections; absent on hosts without P2P. */
  p2p?: () => P2PSignaling | undefined
  serverPort: () => number
  storePath?: string
  now?: () => number
  resolveProxy?: () => Promise<{ proxyUrl: string | null }>
  verifyGateway?: (origin: string, gatewayId: string) => Promise<boolean>
  /**
   * The public address differs from the one phones were last given (a Quick
   * Tunnel restarted). `sign` proves the address to one paired device.
   */
  onOriginChanged?: (change: { url: string, previous: string, sign: (deviceId: string) => string | undefined }) => void
  networkInterfaces?: () => NodeJS.Dict<os.NetworkInterfaceInfo[]>
  hostName?: () => string
}

/** The listener, not attacker-controlled headers, establishes the remote trust boundary. */
export class PublicAccessServer {
  private server: Server<RemoteData> | null = null
  /** Answers only the address lookup, on every interface (see `lanFetch`). */
  private lan: Server<undefined> | null = null
  private publicUrl: string | null = null
  private gatewayId: string | null = null
  private stored: Stored = { version: 2, origin: null, devices: [] }
  private loaded = false
  private pairing: { hash: string, expiresAt: number } | null = null
  private pending = new Map<string, Pending>()
  private challenges = new Map<string, NativeChallenge>()
  private generation = 0
  private sockets = new Set<ServerWebSocket<RemoteData>>()
  private timer: ReturnType<typeof setInterval> | null = null
  private rates = new Map<string, { start: number, count: number }>()
  private readonly now: () => number
  private readonly storePath: string
  private readonly identity: NativeRemoteIdentity

  constructor(private deps: Dependencies) {
    this.now = deps.now ?? Date.now
    this.storePath = deps.storePath ?? path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'cc-haha', 'public-access-devices.json')
    this.identity = new NativeRemoteIdentity(path.join(path.dirname(this.storePath), 'public-access-identity.json'))
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

  private persist(next = this.stored) {
    mkdirSync(path.dirname(this.storePath), { recursive: true, mode: 0o700 })
    const temporary = `${this.storePath}.${secret()}.tmp`
    try {
      writeFileSync(temporary, JSON.stringify(next), { mode: 0o600, flag: 'wx' })
      renameSync(temporary, this.storePath)
    } finally {
      try { unlinkSync(temporary) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    }
    this.stored = next
  }

  status() {
    this.prune()
    return {
      enabled: this.server !== null,
      port: this.server?.port ?? null,
      publicUrl: this.publicUrl,
      gatewayId: this.gatewayId,
      pending: [...this.pending.values()].filter(p => p.status === 'pending').map(({ id, name }) => ({ id, name })),
      devices: this.stored.devices.map(({ id, name, createdAt, expiresAt }) => ({ id, name, createdAt, expiresAt })),
    }
  }

  private prune() {
    for (const [key, rate] of this.rates) if (this.now() - rate.start >= 60_000) this.rates.delete(key)
    for (const [id, p] of this.pending) if (p.expiresAt <= this.now()) this.pending.delete(id)
    for (const [id, challenge] of this.challenges) if (challenge.expiresAt <= this.now()) this.challenges.delete(id)
    this.stored.devices = this.stored.devices.flatMap(device => {
      if (device.expiresAt > this.now()) return [device]
      if (device.tokenHash) this.deps.terminateDeviceStreams?.(device.id)
      return device.nativePublicKey ? [{ ...device, tokenHash: '', origin: null }] : []
    })
    if (this.server) {
      for (const ws of this.sockets) {
        if (!this.authorizedSocket(ws.data)) this.closeTerminal(ws, 1008, 'Remote access revoked')
      }
    }
  }

  private authorizedSocket(data: RemoteData) {
    return data.remoteOrigin === this.publicUrl &&
      this.authorizedDevice(data.remoteDeviceId, data.remoteTokenHash)
  }

  /** Close a socket so that its resumable stream ends instead of waiting for the client. */
  private closeTerminal(ws: ServerWebSocket<RemoteData>, code: number, reason: string) {
    ws.data.terminal = true
    ws.close(code, reason)
  }

  private terminateAllStreams() {
    for (const device of this.stored.devices) this.deps.terminateDeviceStreams?.(device.id)
  }

  private authorizedDevice(id: string, tokenHash?: string) {
    return this.server !== null && this.publicUrl !== null && this.stored.devices.some(device =>
      device.id === id && device.expiresAt > this.now() && !!device.tokenHash &&
      (tokenHash === undefined || tokenHash === device.tokenHash) &&
      (device.origin === this.publicUrl || (device.portableNative === true && !device.nativePublicKey)))
  }

  isDeviceActive(id: string) { return this.authorizedDevice(id) }

  /**
   * Still paired, whether or not the listener runs right now (a tunnel restart
   * stops it briefly). Read-only: never creates the store. An unreadable store
   * answers true so callers do not discard data on a guess.
   */
  isDevicePaired(id: string) {
    let devices = this.stored.devices
    if (!this.loaded) {
      try { devices = migratePublicAccessStore(JSON.parse(readFileSync(this.storePath, 'utf8'))).devices } catch (error) {
        return (error as NodeJS.ErrnoException).code !== 'ENOENT'
      }
    }
    return devices.some(d => d.id === id && (d.nativePublicKey || d.expiresAt > this.now()))
  }

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
    const tokenHash = hash(token)
    return this.stored.devices.find(d => d.tokenHash === tokenHash && d.expiresAt > this.now() &&
      (d.origin === this.publicUrl || (authorization !== null && d.portableNative === true && !d.nativePublicKey)))
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
    this.load()
    const previous = typeof this.stored.lastPublicUrl === 'string' ? this.stored.lastPublicUrl : null
    if (this.stored.origin !== url.origin) {
      const invalidated = this.stored.devices.filter(device => device.origin &&
        (!device.portableNative || device.nativePublicKey))
      // A migrated record can authenticate a cookie only on the recorded old
      // origin. Clear that binding even when its native bearer can still move.
      this.persist({ ...this.stored, origin: url.origin, lastPublicUrl: url.origin, devices: this.stored.devices.map(device => {
        if (!device.origin) return device
        return invalidated.includes(device)
          ? { ...device, tokenHash: '', expiresAt: 0, origin: null }
          : { ...device, origin: null }
      }) })
      this.generation++
      this.pending.clear()
      this.pairing = null
      this.challenges.clear()
      for (const ws of this.sockets) this.closeTerminal(ws, 1008, 'Remote origin changed')
      if (this.publicUrl) this.terminateAllStreams()
      else for (const device of invalidated) this.deps.terminateDeviceStreams?.(device.id)
    } else if (previous !== url.origin) {
      this.persist({ ...this.stored, lastPublicUrl: url.origin })
    }
    this.publicUrl = url.origin
    if (previous === url.origin) return
    if (!previous) return
    const announced = url.origin
    try {
      this.deps.onOriginChanged?.({
        url: announced, previous,
        sign: deviceId => {
          const device = this.stored.devices.find(d => d.id === deviceId && d.expiresAt > this.now())
          return device && deviceMac(device.tokenHash, `cc-haha-host-url\n${announced}`)
        },
      })
    } catch { /* announcing is best-effort; the gateway is up either way */ }
  }

  /**
   * WebSocket handlers shared by Bun's sockets and sockets carried over a P2P
   * data channel, so per-device limits, rate limits and revocation apply to both.
   */
  readonly socketHandlers = {
    open: (ws: ServerWebSocket<RemoteData>) => {
      if (!this.authorizedSocket(ws.data) || this.sockets.size >= 64 || [...this.sockets].filter(s => s.data.remoteDeviceId === ws.data.remoteDeviceId).length >= 8) {
        ws.close(1008, 'Remote connection limit')
        return
      }
      this.sockets.add(ws)
      this.deps.websocket.open?.(ws)
    },
    message: (ws: ServerWebSocket<RemoteData>, message: string | Buffer) => {
      if (!this.authorizedSocket(ws.data)) { this.closeTerminal(ws, 1008, 'Remote access revoked'); return }
      if (!this.rate(`ws:${ws.data.remoteDeviceId}`, 600)) { ws.close(1008, 'Remote rate limit'); return }
      return this.deps.websocket.message(ws, message)
    },
    close: (ws: ServerWebSocket<RemoteData>, code: number, reason: string) => {
      if (this.sockets.delete(ws)) this.deps.websocket.close?.(ws, code, reason)
    },
    drain: (ws: ServerWebSocket<RemoteData>) => this.deps.websocket.drain?.(ws),
  }

  /** The gateway as a P2P peer's multiplexer uses it: the same entry point as Cloudflare. */
  tunnel(): TunnelGateway {
    return {
      fetch: (request, server) => this.fetch(request, server as Upgrader),
      socketHandlers: this.socketHandlers as unknown as TunnelGateway['socketHandlers'],
      deviceIdFor: request => this.deviceFor(request)?.id,
      publicUrl: () => this.publicUrl,
    }
  }

  enable(publicUrl?: string, port?: number) {
    if (port !== undefined && (!Number.isInteger(port) || port < 1024 || port > 65535)) throw new Error('Invalid remote listener port')
    // A proxy's fixed upstream must never silently move, including while another
    // connection attempt already owns the gateway. Validate before changing origin.
    if (this.server && port !== undefined && this.server.port !== port) throw new Error('Remote listener already uses another port')
    this.load()
    if (publicUrl !== undefined) this.setOrigin(publicUrl)
    if (this.server) return this.status()
    this.gatewayId = secret()
    this.server = Bun.serve<RemoteData>({
      hostname: '127.0.0.1', port: port ?? 0, idleTimeout: 0, maxRequestBodySize: 16 * 1024 * 1024,
      fetch: (req, server) => this.fetch(req, server),
      websocket: { maxPayloadLength: 1024 * 1024, ...this.socketHandlers },
    })
    // The gateway stays loopback-only (a wildcard bind could share the fixed port
    // with another loopback service). The LAN gets only the address lookup, on
    // the next port, so a phone finds it again after the public URL changed.
    if (this.server.port < 65535) {
      try {
        this.lan = Bun.serve({
          hostname: '0.0.0.0', port: this.server.port + 1, idleTimeout: 10,
          fetch: (req, server) => this.lanFetch(req, server.requestIP(req)?.address ?? ''),
        })
      } catch { this.lan = null }
    }
    this.timer = setInterval(() => this.prune(), 10_000)
    this.timer.unref()
    return this.status()
  }

  /**
   * `restart`: the desktop is recovering the tunnel and brings the same gateway
   * back, so resumable streams stay detached and phones resume afterwards.
   */
  disable(options: { restart?: boolean } = {}) {
    const listener = this.server
    this.server = null
    this.generation++
    this.publicUrl = null
    this.gatewayId = null
    this.pairing = null
    this.pending.clear()
    this.challenges.clear()
    this.rates.clear()
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    // Disabling/rebuilding the tunnel does not revoke the stored device token.
    for (const ws of this.sockets) {
      if (options.restart) ws.close(1012, 'Remote access restarting')
      else this.closeTerminal(ws, 1012, 'Remote access disabled')
    }
    if (!options.restart) this.terminateAllStreams()
    listener?.stop(true)
    this.lan?.stop(true)
    this.lan = null
    return this.status()
  }

  private async p2pRoute(request: Request, route: string): Promise<Response> {
    const broker = this.deps.p2p?.()
    if (!broker) return json({ error: 'Not found' }, 404)
    const device = this.deviceFor(request)
    if (!device) return json({ error: 'Device pairing required' }, 401)
    if (request.headers.get('Origin') !== this.publicUrl) return json({ error: 'Origin required' }, 403)
    if (!this.rate(`p2p:${device.id}`, 30)) return json({ error: 'Too many requests' }, 429)
    if (route === 'api/public-access/p2p' && request.method === 'GET') {
      return json({ v: 1, available: broker.available, iceServers: broker.iceServers(), gatherMs: 300 })
    }
    const step = route === 'api/public-access/p2p/offer' ? 'offer' : route === 'api/public-access/p2p/candidates' ? 'candidates' : null
    if (!step || request.method !== 'POST') return json({ error: 'Not found' }, 404)
    let input: Record<string, unknown>
    try { input = await this.readInput(request, 32 * 1024) } catch { return json({ error: 'Invalid direct connection request' }, 400) }
    try {
      return json(await (step === 'offer' ? broker.offer(device.id, input) : broker.candidates(device.id, input)))
    } catch (error) {
      const status = error && typeof error === 'object' && 'status' in error && typeof error.status === 'number' ? error.status : 500
      const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : 'P2P_FAILED'
      return json({ error: error instanceof Error ? error.message : 'Direct connection failed', code }, status)
    }
  }

  /** This control route never inherits tokenless loopback or query-token trust. */
  async control(request: Request): Promise<Response> {
    if (!isLocalAccessAuthorized(request)) return json({ error: 'Desktop credential required' }, 403)
    try {
      this.load()
      const route = new URL(request.url).pathname.split('/').filter(Boolean).slice(2).join('/')
      if ((route === 'status' || route === '') && request.method === 'GET') return json(this.status())
      if (route === 'network' && request.method === 'GET') {
        try {
          if (!this.deps.resolveProxy) throw new Error('Network settings unavailable')
          return json(await this.deps.resolveProxy())
        } catch { return json({ error: 'Network proxy unavailable', code: 'proxy' }, 503) }
      }
      const input = request.method === 'GET' ? {} : await this.readInput(request)
      if (route === 'enable' && request.method === 'POST') {
        if (input.publicUrl !== undefined && typeof input.publicUrl !== 'string') throw new Error('HTTPS origin required')
        if (input.port !== undefined && typeof input.port !== 'number') throw new Error('Invalid remote listener port')
        return json(this.enable(input.publicUrl as string | undefined, input.port as number | undefined))
      }
      if (route === 'origin' && request.method === 'PUT') { this.setOrigin(input.publicUrl); return json(this.status()) }
      if (route === 'verify' && request.method === 'POST') {
        if (!this.server || !this.publicUrl || !this.gatewayId || !this.deps.verifyGateway) return json({ ok: false })
        return json({ ok: await this.deps.verifyGateway(this.publicUrl, this.gatewayId) })
      }
      if (route === 'disable' && request.method === 'POST') return json(this.disable({ restart: input.reason === 'restart' }))
      if (route === 'native/identity' && request.method === 'GET') return json(this.identity.metadata())
      if (route === 'native/configure' && request.method === 'POST') return json(this.identity.configure(input.directoryUrl))
      if (route === 'native/announcement' && request.method === 'POST') {
        if (!this.server || !this.publicUrl || !this.identity.binding()) return json({ error: 'Remote directory is not ready' }, 409)
        return json(this.identity.announcement(this.publicUrl, this.now()))
      }
      if (route === 'pairing' && request.method === 'POST') {
        if (!this.server || !this.publicUrl) return json({ error: 'Remote access is not ready' }, 409)
        const token = secret()
        this.pairing = { hash: hash(token), expiresAt: this.now() + PAIR_TTL }
        return json({ secret: token, expiresAt: this.pairing.expiresAt, nativeBinding: this.identity.binding() })
      }
      const id = typeof input.id === 'string' ? input.id : ''
      if (route === 'revoke' && request.method === 'POST') {
        this.persist({ ...this.stored, devices: this.stored.devices.filter(d => d.id !== id) })
        if (id) this.deps.terminateDeviceStreams?.(id)
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

  private async readInput(request: Request, limit = 4096): Promise<Record<string, unknown>> {
    const text = await request.text()
    if (text.length > limit) throw new Error('Request too large')
    if (!text) return {}
    const input: unknown = JSON.parse(text)
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Object required')
    return input as Record<string, unknown>
  }

  /**
   * A request from the local network (not Cloudflare, not P2P). Its only use is
   * telling a paired phone the current public address after a Quick Tunnel
   * restart. Nothing secret crosses the network: the phone sends a hash of its
   * pairing hash and a nonce, and checks the answer's MAC with its credential.
   */
  private lanFetch(request: Request, address: string): Response {
    try {
      const url = new URL(request.url)
      if (request.method !== 'GET' || url.pathname !== `${PREFIX}/locate`) return json({ error: 'Not found' }, 404)
      if (!this.rate(`locate:${address}`, 30) || !this.rate('locate-global', 300)) return json({ error: 'Too many requests' }, 429)
      const id = url.searchParams.get('id') ?? ''
      const nonce = url.searchParams.get('nonce') ?? ''
      if (!/^[a-f0-9]{64}$/.test(id) || !/^[A-Za-z0-9_-]{16,128}$/.test(nonce)) return json({ error: 'Invalid request' }, 400)
      const publicUrl = this.publicUrl
      const device = this.stored.devices.find(d => d.expiresAt > this.now() && hash(d.tokenHash) === id)
      if (!device || !publicUrl) return json({ error: 'Not found' }, 404)
      return json({ url: publicUrl, mac: deviceMac(device.tokenHash, `cc-haha-locate\n${nonce}\n${publicUrl}`) })
    } catch { return json({ error: 'Invalid request' }, 400) }
  }

  private async nativeRequest(route: string, input: Record<string, unknown>, request: Request): Promise<Response> {
    const origin = this.publicUrl!
    const generation = this.generation
    const denied = () => json({ error: 'Native device proof rejected' }, 401)
    if (!this.server || request.headers.get('Origin') !== origin) return denied()
    if (route === 'api/public-access/native/challenge') {
      if (typeof input.nonce !== 'string' || !REMOTE_NONCE_PATTERN.test(input.nonce) ||
        typeof input.hostId !== 'string' || !REMOTE_ID_PATTERN.test(input.hostId)) return json({ error: 'Invalid native challenge' }, 400)
      const { hostId, publicKey } = this.identity.metadata()
      if (input.hostId !== hostId) return denied()
      if (this.challenges.size >= 128) return json({ error: 'Too many native challenges' }, 429)
      const challenge = secret()
      const expiresAt = this.now() + REMOTE_CHALLENGE_TTL_MS
      const nonce = input.nonce
      this.challenges.set(challenge, { nonce, origin, expiresAt })
      return json({ version: 2, hostId, publicKey, origin, nonce, challenge, expiresAt,
        signature: this.identity.sign('host-proof', [hostId, origin, nonce, challenge, String(expiresAt)]) })
    }
    if (route === 'api/public-access/native/enroll') {
      if (!this.deviceFor(request)) return denied()
      const { devicePublicKey, nonce, signature } = input
      if (!isNativeRemotePublicKey(devicePublicKey) || typeof nonce !== 'string' || !REMOTE_NONCE_PATTERN.test(nonce) || typeof signature !== 'string') return denied()
      const { hostId } = this.identity.metadata()
      if (!await verifyRemoteSignature(devicePublicKey, signature, remoteCanonical('enroll', [hostId, origin, devicePublicKey, nonce]))) return denied()
      // Verification yields: recheck origin, revocation and competing enrollment before committing.
      const device = this.deviceFor(request)
      if (!device || this.publicUrl !== origin || this.generation !== generation) return denied()
      if (device.nativePublicKey && device.nativePublicKey !== devicePublicKey) return json({ error: 'Device already bound to another key' }, 409)
      if (!device.nativePublicKey) this.persist({ ...this.stored, devices: this.stored.devices.map(d => d.id === device.id
        ? { ...d, origin, nativePublicKey: devicePublicKey } : d) })
      return json({ version: 2, hostId, origin, deviceId: device.id, devicePublicKey, nonce,
        signature: this.identity.sign('enrolled', [hostId, origin, device.id, devicePublicKey, nonce]) })
    }
    if (route === 'api/public-access/native/session') {
      if (input.clientType !== undefined && input.clientType !== 'browser' && input.clientType !== 'native') return json({ error: 'Unsupported session client type' }, 400)
      const { hostId, deviceId, nonce, challenge, expiresAt, signature } = input
      const pending = typeof challenge === 'string' ? this.challenges.get(challenge) : undefined
      // Failed proofs also consume the challenge, preventing repeated key guesses/replay.
      if (typeof challenge === 'string') this.challenges.delete(challenge)
      if (!pending || pending.origin !== origin || pending.nonce !== nonce || pending.expiresAt !== expiresAt || pending.expiresAt <= this.now() ||
        typeof deviceId !== 'string' || typeof nonce !== 'string' || typeof signature !== 'string' || typeof hostId !== 'string' ||
        this.identity.metadata().hostId !== hostId) return denied()
      const device = this.stored.devices.find(d => d.id === deviceId)
      if (!device?.nativePublicKey || !await verifyRemoteSignature(device.nativePublicKey, signature,
        remoteCanonical('resume', [hostId, origin, deviceId, nonce, challenge as string, String(expiresAt)]))) return denied()
      if (!this.server || this.publicUrl !== origin || this.generation !== generation || pending.expiresAt <= this.now() ||
        !this.stored.devices.some(d => d.id === deviceId && d.nativePublicKey === device.nativePublicKey)) return denied()
      const nativeClient = input.clientType === 'native'
      const token = `${nativeClient ? NATIVE_TOKEN_PREFIX : ''}${secret()}`
      const tokenHash = hash(token)
      const sessionExpiry = this.now() + NATIVE_SESSION_TTL
      this.persist({ ...this.stored, devices: this.stored.devices.map(d => d.id === deviceId ? { ...d, origin, tokenHash, expiresAt: sessionExpiry } : d) })
      this.deps.terminateDeviceStreams?.(deviceId)
      this.prune()
      const proof = { version: 2, hostId, origin, deviceId, nonce, tokenHash, expiresAt: sessionExpiry,
        signature: this.identity.sign('session', [hostId, origin, deviceId, nonce, tokenHash, String(sessionExpiry)]) }
      // The same persistent device proof can renew either transport. Never put
      // a native bearer in a cookie; sign the hash of the exact delivered token.
      if (nativeClient) return json({ ...proof, token, tokenType: 'Bearer' })
      return secure(Response.json(proof, {
        headers: { 'Set-Cookie': `${COOKIE}=${token}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${NATIVE_SESSION_TTL / 1000}` },
      }))
    }
    return json({ error: 'Not found' }, 404)
  }

  async fetch(request: Request, server: Upgrader): Promise<Response | undefined> {
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
      if (url.pathname === '/health' && request.method === 'GET') return json({ status: 'ok', gatewayId: this.gatewayId })
      const route = url.pathname.split('/').filter(Boolean).join('/')
      // Direct-connection signaling: an authenticated device only, with its own
      // limit, so it never competes with the shared pairing budget.
      if (route === 'api/public-access/p2p' || route.startsWith('api/public-access/p2p/')) return await this.p2pRoute(request, route)
      if (route === 'api/public-access/locator' && request.method === 'GET') {
        const device = this.deviceFor(request)
        if (!device) return json({ error: 'Device pairing required' }, 401)
        if (!this.rate(`locator:${device.id}`, 30)) return json({ error: 'Too many requests' }, 429)
        if (!this.lan) return json({ port: null, addresses: [] })
        return json({ port: this.lan.port, addresses: lanAddresses((this.deps.networkInterfaces ?? os.networkInterfaces)()) })
      }
      if (route.startsWith('api/public-access/')) {
        if (!this.rate('pairing-global', 180)) return json({ error: 'Too many requests' }, 429)
        if (route === 'api/public-access/session' && request.method === 'GET') {
          const device = this.deviceFor(request)
          // Native clients name a paired computer without a second credential.
          // Never disclose local host information to an unpaired visitor.
          return json(device ? {
            authenticated: true,
            ...(request.headers.get('Authorization') === null ? {
              hostName: (this.deps.hostName?.() ?? os.hostname()).replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 80),
              protocolVersion: 1,
            } : {}),
            expiresAt: device.expiresAt,
          } : { authenticated: false })
        }
        const input = await this.readInput(request)
        this.prune()
        if (route.startsWith('api/public-access/native/') && request.method === 'POST') return await this.nativeRequest(route, input, request)
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
          // Bind credential delivery before desktop approval; persist hashes only.
          const token = `${p.clientType === 'native' ? NATIVE_TOKEN_PREFIX : ''}${secret()}`
          const device: Device = {
            id: p.id, name: p.name, createdAt: this.now(), expiresAt: this.now() + SESSION_TTL, tokenHash: hash(token),
            origin: this.publicUrl,
            ...(p.clientType === 'native' ? { portableNative: true } : {}),
          }
          this.persist({ ...this.stored, devices: [...this.stored.devices, device] })
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
          const upgraded = server.upgrade(request, { data: { sessionId: url.pathname.split('/').pop()!, connectedAt: this.now(), channel: 'client', clientKind: 'full', sdkToken: null, serverPort: this.deps.serverPort(), serverHost: '127.0.0.1', remoteDeviceId: device.id, remoteOrigin: this.publicUrl, remoteTokenHash: device.tokenHash, mediaRefs: url.searchParams.get('media') === 'ref', resume: parseResumeRequest(url.searchParams) } })
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
      const response = await this.deps.handleStatic(request, url) ?? new Response('Not found', { status: 404 })
      // Only public, content-versioned application bundles can survive a phone
      // reconnect in HTTP cache. HTML, credentials and session data never do.
      const immutableAsset = response.status === 200 && !url.search &&
        /^\/assets\/[^/]+-[A-Za-z0-9_-]{8,}\.(?:js|css|woff2?|png|jpe?g|svg|webp|wasm)$/.test(url.pathname) &&
        response.headers.get('cache-control') === 'public, max-age=31536000, immutable'
      return secure(response, immutableAsset ? 'public, max-age=31536000, immutable' : 'no-store')
    } catch { return json({ error: 'Remote request failed' }, 400) }
  }
}

export function isPublicAccessControlPath(pathname: string) {
  const normalized = `/${pathname.split('/').filter(Boolean).join('/')}`
  return normalized === PREFIX || normalized.startsWith(`${PREFIX}/`)
}
