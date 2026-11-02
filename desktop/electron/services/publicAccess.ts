import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { PUBLIC_ACCESS_CONSENT_VERSION, type DesktopPublicAccessConfiguration, type DesktopPublicAccessStatus } from '../../src/lib/desktopHost/types'
import { DEFAULT_PUBLIC_ACCESS_PORT, isPublicAccessConfiguration, normalizePublicAccessOrigin, readCloudflareTunnelToken } from '../../src/lib/desktopHost/publicAccessConfiguration'
import { CloudflareTunnelError, publishedGatewayOrigin, startCloudflareTunnel, type CloudflareTunnel } from './cloudflareTunnel'
export { PUBLIC_ACCESS_CONSENT_VERSION } from '../../src/lib/desktopHost/types'

export type PublicAccessStatus = DesktopPublicAccessStatus
type Settings = Record<string, unknown> & Omit<DesktopPublicAccessConfiguration, 'tunnelToken'> & {
  version: number
  tunnelToken: string
  autoStart: boolean
  consentVersion: number
  migrationRequired: boolean
}
type Backend = { request<T>(route: string, method: string, body?: unknown): Promise<T> }
type Options = { directory: string, backend: Backend, desktopRoot?: string, startTunnel?: typeof startCloudflareTunnel }
const CONTROLLED_ERRORS = ['runtime', 'network', 'configuration', 'proxy', 'token', 'route'] as const
type ControlledError = typeof CONTROLLED_ERRORS[number]
// Cloudflare normally pushes a dashboard tunnel's routes right after registration.
const ROUTE_WAIT_MS = 5_000

/** Retired private-network consent never silently becomes permission to publish a public tunnel. */
export function migratePublicAccessSettings(raw: unknown): Settings {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid public access configuration')
  const value = raw as Record<string, unknown>
  if (value.mode === 'quick' || value.mode === 'named') {
    const config = { mode: value.mode, customUrl: value.customUrl, localPort: value.localPort, tunnelToken: value.tunnelToken }
    if (!isPublicAccessConfiguration(config)) throw new Error('Invalid public access configuration')
    return {
      ...value, ...config, customUrl: config.customUrl ? normalizePublicAccessOrigin(config.customUrl)! : '',
      tunnelToken: config.tunnelToken ?? '', version: Math.max(5, typeof value.version === 'number' ? value.version : 0),
      autoStart: value.autoStart === true, consentVersion: typeof value.consentVersion === 'number' ? value.consentVersion : 0,
      migrationRequired: value.migrationRequired === true,
    }
  }
  if (value.mode !== undefined && !['tailscale', 'ngrok', 'custom'].includes(String(value.mode))) throw new Error('Invalid legacy public access configuration')
  const localPort = value.localPort === undefined ? DEFAULT_PUBLIC_ACCESS_PORT : value.localPort
  if (!Number.isInteger(localPort) || (localPort as number) < 1024 || (localPort as number) > 65535) throw new Error('Invalid saved listener port')
  if ((value.mode === 'custom' || value.mode === 'tailscale') && value.customUrl !== '' && !normalizePublicAccessOrigin(value.customUrl)) throw new Error('Invalid legacy public access configuration')
  const legacy = Object.keys(value).length > 0
  return {
    ...value,
    ...(legacy ? { legacyRemoteConfiguration: value.legacyRemoteConfiguration ?? { ...value } } : {}),
    version: Math.max(5, typeof value.version === 'number' ? value.version : 0),
    mode: 'quick', customUrl: '', localPort: localPort as number, tunnelToken: '',
    autoStart: false, consentVersion: 0, migrationRequired: legacy,
  }
}

export function classifyPublicAccessError(error: unknown): NonNullable<PublicAccessStatus['error']> {
  if (error && typeof error === 'object' && 'code' in error && (CONTROLLED_ERRORS as readonly string[]).includes(String(error.code))) {
    return error.code as ControlledError
  }
  return /configuration|invalid|consent|eaddrinuse|address already in use/i.test(String(error instanceof Error ? error.message : error)) ? 'configuration' : 'network'
}

/** Only controlled categories cross IPC; proxy credentials and upstream messages stay private. */
export async function readPublicAccessControlResponse<T>(response: Response): Promise<T> {
  if (response.ok) return await response.json() as T
  const value = await response.json().catch(() => ({})) as Record<string, unknown>
  const code = ['network', 'configuration', 'runtime', 'proxy'].includes(String(value.code))
    ? value.code as 'network' | 'configuration' | 'runtime' | 'proxy'
    : 'configuration'
  throw new CloudflareTunnelError(code, 'Remote connection request failed')
}

export class PublicAccessManager {
  private settings: Settings
  private readonly file: string
  private status: Omit<PublicAccessStatus, 'mode' | 'customUrl' | 'localPort' | 'tokenSet' | 'tunnelId' | 'migrationRequired'>
  private generation = 0
  private wanted = false
  private disposed = false
  private pending: Promise<PublicAccessStatus> | null = null
  /** What `start` callers await: the attempt's outcome, or its first wait for a Cloudflare route. */
  private pendingResult: Promise<PublicAccessStatus> | null = null
  private pendingGeneration = 0
  private controller: AbortController | null = null
  private tunnel: CloudflareTunnel | null = null
  private readonly stoppingTunnels = new Set<CloudflareTunnel>()
  private readonly pendingStops = new Set<() => Promise<void>>()
  private unsubscribe: (() => void) | null = null
  private retry: ReturnType<typeof setTimeout> | null = null
  private retryCount = 0
  private stopping = 0
  private stopUnconfirmed = false

  constructor(private options: Options) {
    this.file = path.join(options.directory, 'public-access-private.json')
    let invalid = false
    try {
      this.settings = migratePublicAccessSettings(existsSync(this.file) ? JSON.parse(readFileSync(this.file, 'utf8')) : {})
      if (existsSync(this.file)) this.persist()
    } catch {
      this.settings = migratePublicAccessSettings({})
      invalid = true
    }
    this.status = { state: invalid || !this.isConfigured() ? 'unconfigured' : 'disabled', publicUrl: null,
      error: invalid ? 'configuration' : null, phase: null, autoStart: this.settings.autoStart, consentVersion: this.settings.consentVersion }
  }

  getStatus(): PublicAccessStatus {
    const { mode, customUrl, localPort, migrationRequired } = this.settings
    return { ...this.status, mode, customUrl, localPort, migrationRequired, tokenSet: !!this.settings.tunnelToken,
      tunnelId: readCloudflareTunnelToken(this.settings.tunnelToken)?.tunnelId ?? null }
  }

  private isConfigured() { return this.settings.mode === 'quick' || !!this.settings.tunnelToken }
  private current(generation: number) { return generation === this.generation && !this.disposed }

  async configure(configuration: DesktopPublicAccessConfiguration) {
    if (!isPublicAccessConfiguration(configuration)) throw new Error('Invalid public access configuration')
    const customUrl = configuration.customUrl ? normalizePublicAccessOrigin(configuration.customUrl)! : ''
    const tunnelToken = configuration.tunnelToken || this.settings.tunnelToken
    if (this.settings.mode === configuration.mode && this.settings.customUrl === customUrl &&
      this.settings.localPort === configuration.localPort && this.settings.tunnelToken === tunnelToken && this.status.error !== 'configuration') return this.getStatus()
    const stopped = this.stop()
    const generation = this.generation
    await stopped
    if (!this.current(generation)) throw new Error('Public access configuration interrupted')
    if (this.stopUnconfirmed) throw new Error('Remote gateway stop was not confirmed')
    Object.assign(this.settings, { ...configuration, customUrl, tunnelToken, consentVersion: 0, migrationRequired: false })
    this.persist()
    Object.assign(this.status, { consentVersion: 0, error: null, state: this.isConfigured() ? 'disabled' : 'unconfigured' })
    return this.getStatus()
  }

  private persist() {
    mkdirSync(this.options.directory, { recursive: true, mode: 0o700 })
    const temporary = `${this.file}.tmp`
    writeFileSync(temporary, JSON.stringify(this.settings), { mode: 0o600 })
    chmodSync(temporary, 0o600)
    renameSync(temporary, this.file)
    chmodSync(this.file, 0o600)
  }

  setAutoStart(enabled: boolean) {
    this.settings.autoStart = enabled
    this.persist()
    this.status.autoStart = enabled
    return this.getStatus()
  }

  async restore() {
    if (this.settings.autoStart && this.settings.consentVersion === PUBLIC_ACCESS_CONSENT_VERSION && this.isConfigured()) return this.start(PUBLIC_ACCESS_CONSENT_VERSION)
    return this.getStatus()
  }

  start(consentVersion: number): Promise<PublicAccessStatus> {
    if (this.disposed) return Promise.resolve(this.getStatus())
    if (this.stopping || this.stopUnconfirmed) return Promise.reject(new Error('Remote gateway stop must be confirmed before enabling access'))
    if (consentVersion !== PUBLIC_ACCESS_CONSENT_VERSION || !this.isConfigured() || this.status.state === 'unconfigured' && this.status.error === 'configuration') return Promise.reject(new Error('Configuration and current consent required'))
    if (this.pending) {
      if (this.pendingGeneration === this.generation) return this.pendingResult!
      const generation = this.generation
      return this.pending.then(() => this.current(generation) ? this.start(consentVersion) : this.getStatus())
    }
    if (this.status.state === 'online') return Promise.resolve(this.getStatus())
    this.settings.consentVersion = consentVersion
    this.settings.migrationRequired = false
    this.persist()
    this.status.consentVersion = consentVersion
    this.wanted = true
    if (this.retry) clearTimeout(this.retry)
    this.retry = null
    let routeWaitStarted!: () => void
    const routeWait = new Promise<void>(resolve => { routeWaitStarted = resolve })
    const operation = this.connect(++this.generation, routeWaitStarted)
    const result = Promise.race([operation, routeWait.then(() => this.getStatus())])
    this.pending = operation
    this.pendingResult = result
    this.pendingGeneration = this.generation
    const clear = () => { if (this.pending === operation) { this.pending = null; this.pendingResult = null } }
    void operation.then(clear, clear)
    return result
  }

  /**
   * A dashboard tunnel's setup wizard offers its route step only after it sees this connector,
   * so the connector stays registered until a pushed route sends a hostname to the gateway.
   */
  private async waitForRoute(tunnel: CloudflareTunnel, port: number, generation: number, signal: AbortSignal, onWait: () => void) {
    let routes = await tunnel.publishedRoutes(null, { timeoutMs: ROUTE_WAIT_MS, signal })
    while (this.current(generation)) {
      const origin = routes && publishedGatewayOrigin(routes, port, this.settings.customUrl || undefined)
      if (origin) { this.status.error = null; return origin }
      Object.assign(this.status, { phase: 'routing', error: routes?.some(route => route.hostname) ? 'route' : null })
      onWait()
      const next = await tunnel.publishedRoutes(routes, { signal })
      if (next === routes && this.current(generation)) throw new CloudflareTunnelError('network', 'Cloudflare disconnected while waiting for a route')
      routes = next
    }
    return null
  }

  private async connect(generation: number, onRouteWait: () => void) {
    const controller = new AbortController()
    this.controller = controller
    Object.assign(this.status, { state: this.retryCount ? 'reconnecting' : 'connecting', error: null, phase: 'preparing', publicUrl: null })
    try {
      const { port } = await this.options.backend.request<{ port: number }>('/enable', 'POST', { port: this.settings.localPort })
      if (!this.current(generation)) return this.getStatus()
      if (port !== this.settings.localPort) throw new CloudflareTunnelError('configuration', 'Invalid fixed listener port configuration')
      const { proxyUrl } = await this.options.backend.request<{ proxyUrl: string | null }>('/network', 'GET')
      if (!this.current(generation)) return this.getStatus()
      const tunnel = await (this.options.startTunnel ?? startCloudflareTunnel)({
        mode: this.settings.mode, localPort: port,
        token: this.settings.mode === 'named' ? this.settings.tunnelToken : undefined,
        proxyUrl: proxyUrl || undefined, signal: controller.signal,
        onPhase: () => { if (this.current(generation)) this.status.phase = 'connecting' },
      }, { desktopRoot: this.options.desktopRoot })
      if (!this.current(generation)) {
        this.stoppingTunnels.add(tunnel)
        try { await tunnel.stop(); this.stoppingTunnels.delete(tunnel) }
        catch { this.stopUnconfirmed = true; Object.assign(this.status, { state: 'failed', error: 'stop', publicUrl: null, phase: null }) }
        return this.getStatus()
      }
      this.tunnel = tunnel
      this.unsubscribe = tunnel.onExit(() => { if (this.current(generation) && this.wanted) void this.recoverAfterExit() })
      const publicUrl = tunnel.url ?? await this.waitForRoute(tunnel, port, generation, controller.signal, onRouteWait)
      if (!publicUrl || !this.current(generation)) return this.getStatus()
      await this.options.backend.request('/origin', 'PUT', { publicUrl })
      if (!this.current(generation)) return this.getStatus()
      this.status.phase = 'checking'
      let verified = false
      for (let attempt = 0; attempt < 3 && this.current(generation); attempt++) {
        const result = await this.options.backend.request<{ ok: boolean }>('/verify', 'POST')
        if (!this.current(generation)) return this.getStatus()
        if (result.ok === true) { verified = true; break }
      }
      if (!verified) throw new CloudflareTunnelError(proxyUrl ? 'proxy' : 'network', 'The public hostname does not reach this remote gateway')
      Object.assign(this.status, { publicUrl, state: 'online', phase: null })
      this.retryCount = 0
    } catch (error) {
      if (error instanceof CloudflareTunnelError && error.retryStop) {
        this.pendingStops.add(error.retryStop)
        this.stopUnconfirmed = true
        Object.assign(this.status, { state: 'failed', error: 'stop', phase: null, publicUrl: null })
      }
      if (!this.current(generation)) return this.getStatus()
      this.unsubscribe?.()
      this.unsubscribe = null
      const tunnel = this.tunnel
      this.tunnel = null
      controller.abort()
      let closed = !this.pendingStops.size
      if (tunnel) this.stoppingTunnels.add(tunnel)
      for (const closing of this.stoppingTunnels) {
        try { await closing.stop(); this.stoppingTunnels.delete(closing) } catch { closed = false }
      }
      try { await this.options.backend.request('/disable', 'POST') } catch { closed = false }
      if (!this.current(generation)) return this.getStatus()
      if (!closed) {
        this.stopUnconfirmed = true
        Object.assign(this.status, { state: 'failed', error: 'stop', phase: null, publicUrl: null })
      } else {
        const category = classifyPublicAccessError(error)
        Object.assign(this.status, { state: 'failed', error: category, phase: null, publicUrl: null })
        if (category === 'network' || category === 'proxy') this.scheduleRetry()
      }
    }
    return this.getStatus()
  }

  private scheduleRetry() {
    if (!this.wanted || this.disposed || this.stopUnconfirmed) return
    this.status.state = 'reconnecting'
    this.retry = setTimeout(() => { this.retry = null; void this.start(PUBLIC_ACCESS_CONSENT_VERSION) }, Math.min(30_000, 1000 * 2 ** this.retryCount++))
    this.retry.unref?.()
  }

  private async recoverAfterExit() {
    const resume = this.wanted
    const stopped = this.stop()
    const generation = this.generation
    this.wanted = resume
    await stopped
    if (this.current(generation) && resume && !this.stopUnconfirmed) this.scheduleRetry()
  }

  async stop() {
    this.wanted = false
    const generation = ++this.generation
    this.controller?.abort()
    this.controller = null
    this.unsubscribe?.()
    this.unsubscribe = null
    const tunnel = this.tunnel
    this.tunnel = null
    if (tunnel) this.stoppingTunnels.add(tunnel)
    if (this.retry) clearTimeout(this.retry)
    this.retry = null
    this.retryCount = 0
    // Keep an aborted startup single-flight until it settles. A late shutdown
    // failure must be observed before another connector may be launched.
    this.stopping++
    let closed = true
    try {
      for (const closing of this.stoppingTunnels) {
        try { await closing.stop(); this.stoppingTunnels.delete(closing) } catch { closed = false }
      }
      for (const retryStop of this.pendingStops) {
        try { await retryStop(); this.pendingStops.delete(retryStop) } catch { closed = false }
      }
      try { await this.options.backend.request('/disable', 'POST') } catch { closed = false }
      if (generation === this.generation) {
        this.stopUnconfirmed = !closed
        Object.assign(this.status, { publicUrl: null, phase: null, error: closed ? null : 'stop',
          state: closed ? this.isConfigured() ? 'disabled' : 'unconfigured' : 'failed' })
      }
    } finally { this.stopping-- }
    return this.getStatus()
  }

  async serverUnavailable() {
    const resume = this.wanted
    const stopped = this.stop()
    const generation = this.generation
    this.wanted = resume
    await stopped
    if (generation === this.generation && resume && !this.stopUnconfirmed) this.status.state = 'reconnecting'
  }

  async serverChanged() {
    const resume = this.wanted
    const stopped = this.stop()
    const generation = this.generation
    this.wanted = resume
    await stopped
    await this.pending?.catch(() => {})
    if (resume && this.current(generation) && !this.stopUnconfirmed) await this.start(PUBLIC_ACCESS_CONSENT_VERSION)
  }

  async dispose() {
    this.disposed = true
    const pending = this.pending
    await this.stop()
    // Startup owns connector cleanup until it returns a handle. Keep the host
    // alive until cancellation has finished its bounded shutdown and cleanup.
    await pending?.catch(() => {})
  }
}
