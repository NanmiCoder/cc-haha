import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { PowerSaveBlocker } from 'electron'
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
  /** Phones may upgrade to a direct (P2P) path; on unless the user turned it off. */
  p2pEnabled: boolean
  /** Hold off idle system sleep while remote access is wanted; on unless the user turned it off. */
  keepAwake: boolean
}
type Backend = { request<T>(route: string, method: string, body?: unknown): Promise<T> }
type Options = {
  directory: string
  backend: Backend
  desktopRoot?: string
  startTunnel?: typeof startCloudflareTunnel
  /** Called whenever the connection state or the P2P preference changes. */
  onState?: (status: PublicAccessStatus) => void
  /**
   * Holds the computer out of idle sleep while remote access is wanted. Every
   * `start` returns its own id, so this never shares an assertion with the
   * prevent-sleep or idle-power services.
   */
  powerSaveBlocker?: Pick<PowerSaveBlocker, 'start' | 'stop'>
}
/** Settings files at this version or newer carry `keepAwake` (version 6 added `p2pEnabled`). */
const SETTINGS_VERSION = 7
const CONTROLLED_ERRORS = ['runtime', 'network', 'configuration', 'proxy', 'token', 'route'] as const
type ControlledError = typeof CONTROLLED_ERRORS[number]
// Cloudflare normally pushes a dashboard tunnel's routes right after registration.
const ROUTE_WAIT_MS = 5_000
/**
 * Pauses before each check that the public hostname reaches this gateway. A
 * fresh quick hostname, or a slow path to Cloudflare, often fails the first
 * checks, and giving up rebuilds the tunnel under a new address that paired
 * phones cannot learn.
 */
const VERIFY_WAITS_MS = [0, 2_000, 4_000, 8_000, 15_000]
/** The last check starts no later than this after the first one. */
const VERIFY_BUDGET_MS = 45_000
type AttachOutcome = 'online' | 'superseded' | 'failed'

/** Resolves true after `milliseconds`, or false as soon as `signal` aborts; never leaves its timer behind. */
function pause(milliseconds: number, signal: AbortSignal) {
  return new Promise<boolean>(resolve => {
    if (signal.aborted) { resolve(false); return }
    const finish = (completed: boolean) => {
      clearTimeout(timer)
      signal.removeEventListener('abort', aborted)
      resolve(completed)
    }
    const aborted = () => finish(false)
    const timer = setTimeout(() => finish(true), milliseconds)
    signal.addEventListener('abort', aborted, { once: true })
  })
}

/** Retired private-network consent never silently becomes permission to publish a public tunnel. */
export function migratePublicAccessSettings(raw: unknown): Settings {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid public access configuration')
  const value = raw as Record<string, unknown>
  if (value.mode === 'quick' || value.mode === 'named') {
    const config = { mode: value.mode, customUrl: value.customUrl, localPort: value.localPort, tunnelToken: value.tunnelToken }
    if (!isPublicAccessConfiguration(config)) throw new Error('Invalid public access configuration')
    return {
      ...value, ...config, customUrl: config.customUrl ? normalizePublicAccessOrigin(config.customUrl)! : '',
      tunnelToken: config.tunnelToken ?? '', version: Math.max(SETTINGS_VERSION, typeof value.version === 'number' ? value.version : 0),
      autoStart: value.autoStart === true, consentVersion: typeof value.consentVersion === 'number' ? value.consentVersion : 0,
      migrationRequired: value.migrationRequired === true,
      p2pEnabled: value.p2pEnabled !== false,
      keepAwake: value.keepAwake !== false,
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
    version: Math.max(SETTINGS_VERSION, typeof value.version === 'number' ? value.version : 0),
    mode: 'quick', customUrl: '', localPort: localPort as number, tunnelToken: '',
    autoStart: false, consentVersion: 0, migrationRequired: legacy,
    p2pEnabled: value.p2pEnabled !== false,
    keepAwake: value.keepAwake !== false,
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
  /**
   * The verified address of the running tunnel and the settings it was built
   * from. cloudflared keeps that address while the sidecar restarts, so a new
   * sidecar re-attaches to it instead of rebuilding the tunnel.
   */
  private established: { publicUrl: string, key: string } | null = null
  /** Bumped whenever the sidecar leaves or a new one starts re-attaching. */
  private attachment = 0
  private attaching: AbortController | null = null
  private blockerId: number | null = null

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
    const { mode, customUrl, localPort, migrationRequired, p2pEnabled, keepAwake } = this.settings
    return { ...this.status, mode, customUrl, localPort, migrationRequired, p2pEnabled, keepAwake, tokenSet: !!this.settings.tunnelToken,
      tunnelId: readCloudflareTunnelToken(this.settings.tunnelToken)?.tunnelId ?? null }
  }

  private isConfigured() { return this.settings.mode === 'quick' || !!this.settings.tunnelToken }
  /** Every status change goes through here so the P2P endpoint and the sleep assertion follow the connection. */
  private update(patch: Partial<typeof this.status>) {
    const before = this.status.state
    Object.assign(this.status, patch)
    this.syncKeepAwake()
    if (this.status.state !== before) this.options.onState?.(this.getStatus())
  }

  /** Remote access is on or on its way back; the same states that run the P2P host. */
  private accessWanted() {
    const { state } = this.status
    return state === 'connecting' || state === 'reconnecting' || state === 'online'
  }

  /** Prevents idle system sleep only: the display may sleep and closing a lid still sleeps. */
  private syncKeepAwake() {
    const blocker = this.options.powerSaveBlocker
    if (!blocker) return
    const hold = !this.disposed && this.settings.keepAwake && this.accessWanted()
    try {
      if (hold && this.blockerId === null) this.blockerId = blocker.start('prevent-app-suspension')
      else if (!hold && this.blockerId !== null) {
        const id = this.blockerId
        this.blockerId = null
        blocker.stop(id)
      }
    } catch {
      // A power assertion is best effort; it must never fail the connection itself.
    }
  }

  /** Saved settings that failed to load stay untouched on disk until the user configures again. */
  private savedSettingsInvalid() { return this.status.state === 'unconfigured' && this.status.error === 'configuration' }

  setP2PEnabled(enabled: boolean) {
    if (this.savedSettingsInvalid()) throw new Error('Invalid public access configuration')
    if (this.settings.p2pEnabled !== enabled) {
      this.settings.p2pEnabled = enabled
      this.persist()
      this.options.onState?.(this.getStatus())
    }
    return this.getStatus()
  }

  setKeepAwake(enabled: boolean) {
    if (this.savedSettingsInvalid()) throw new Error('Invalid public access configuration')
    if (this.settings.keepAwake !== enabled) {
      this.settings.keepAwake = enabled
      this.persist()
      this.syncKeepAwake()
    }
    return this.getStatus()
  }
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
    this.update({ consentVersion: 0, error: null, state: this.isConfigured() ? 'disabled' : 'unconfigured' })
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
    if (this.savedSettingsInvalid()) throw new Error('Invalid public access configuration')
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
    if (consentVersion !== PUBLIC_ACCESS_CONSENT_VERSION || !this.isConfigured() || this.savedSettingsInvalid()) return Promise.reject(new Error('Configuration and current consent required'))
    if (this.pending) {
      if (this.pendingGeneration === this.generation) return this.pendingResult!
      const generation = this.generation
      return this.pending.then(() => this.current(generation) ? this.start(consentVersion) : this.getStatus())
    }
    // A running tunnel is online, or kept for the sidecar to re-attach; never launch a second one.
    if (this.status.state === 'online' || this.tunnel) return Promise.resolve(this.getStatus())
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
    return this.track(operation, Promise.race([operation, routeWait.then(() => this.getStatus())]))
  }

  /** Single-flight: `start` callers join whichever operation owns the connection right now. */
  private track(operation: Promise<PublicAccessStatus>, result = operation) {
    this.pending = operation
    this.pendingResult = result
    this.pendingGeneration = this.generation
    const clear = () => { if (this.pending === operation) { this.pending = null; this.pendingResult = null } }
    void operation.then(clear, clear)
    return result
  }

  /** The settings a running tunnel was built from; a change means it cannot be reused. */
  private tunnelKey() {
    const { mode, customUrl, localPort, tunnelToken } = this.settings
    return JSON.stringify([mode, customUrl, localPort, tunnelToken])
  }

  /**
   * Null when the attempt was superseded while it checked. Spaced checks give a
   * fresh hostname time to resolve before the tunnel is given up.
   */
  private async verifyPublicUrl(live: () => boolean, signal: AbortSignal): Promise<boolean | null> {
    const deadline = Date.now() + VERIFY_BUDGET_MS
    for (const [index, wait] of VERIFY_WAITS_MS.entries()) {
      if (index > 0) {
        const remaining = deadline - Date.now()
        if (remaining <= 0) break
        if (!await pause(Math.min(wait, remaining), signal)) return null
      }
      if (!live()) return null
      const result = await this.options.backend.request<{ ok: boolean }>('/verify', 'POST')
      if (!live()) return null
      if (result.ok === true) return true
    }
    return false
  }

  /**
   * A dashboard tunnel's setup wizard offers its route step only after it sees this connector,
   * so the connector stays registered until a pushed route sends a hostname to the gateway.
   */
  private async waitForRoute(tunnel: CloudflareTunnel, port: number, generation: number, signal: AbortSignal, onWait: () => void) {
    let routes = await tunnel.publishedRoutes(null, { timeoutMs: ROUTE_WAIT_MS, signal })
    while (this.current(generation)) {
      const origin = routes && publishedGatewayOrigin(routes, port, this.settings.customUrl || undefined)
      if (origin) { this.update({ error: null }); return origin }
      this.update({ phase: 'routing', error: routes?.some(route => route.hostname) ? 'route' : null })
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
    this.update({ state: this.retryCount ? 'reconnecting' : 'connecting', error: null, phase: 'preparing', publicUrl: null })
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
        onPhase: () => { if (this.current(generation)) this.update({ phase: 'connecting' }) },
      }, { desktopRoot: this.options.desktopRoot })
      if (!this.current(generation)) {
        this.stoppingTunnels.add(tunnel)
        try { await tunnel.stop(); this.stoppingTunnels.delete(tunnel) }
        catch { this.stopUnconfirmed = true; this.update({ state: 'failed', error: 'stop', publicUrl: null, phase: null }) }
        return this.getStatus()
      }
      this.tunnel = tunnel
      this.unsubscribe = tunnel.onExit(() => { if (this.current(generation) && this.wanted) void this.recoverAfterExit() })
      const publicUrl = tunnel.url ?? await this.waitForRoute(tunnel, port, generation, controller.signal, onRouteWait)
      if (!publicUrl || !this.current(generation)) return this.getStatus()
      await this.options.backend.request('/origin', 'PUT', { publicUrl })
      if (!this.current(generation)) return this.getStatus()
      this.update({ phase: 'checking' })
      const verified = await this.verifyPublicUrl(() => this.current(generation), controller.signal)
      if (verified === null) return this.getStatus()
      if (!verified) throw new CloudflareTunnelError(proxyUrl ? 'proxy' : 'network', 'The public hostname does not reach this remote gateway')
      this.established = { publicUrl, key: this.tunnelKey() }
      this.update({ publicUrl, state: 'online', phase: null })
      this.retryCount = 0
    } catch (error) {
      if (error instanceof CloudflareTunnelError && error.retryStop) {
        this.pendingStops.add(error.retryStop)
        this.stopUnconfirmed = true
        this.update({ state: 'failed', error: 'stop', phase: null, publicUrl: null })
      }
      if (!this.current(generation)) return this.getStatus()
      this.unsubscribe?.()
      this.unsubscribe = null
      const tunnel = this.tunnel
      this.tunnel = null
      this.established = null
      controller.abort()
      let closed = !this.pendingStops.size
      if (tunnel) this.stoppingTunnels.add(tunnel)
      for (const closing of this.stoppingTunnels) {
        try { await closing.stop(); this.stoppingTunnels.delete(closing) } catch { closed = false }
      }
      const category = classifyPublicAccessError(error)
      // A network or proxy failure is retried with the same gateway, so phones
      // keep their resumable streams; anything final ends them.
      const retrying = closed && (category === 'network' || category === 'proxy') && this.canRetry()
      try {
        if (retrying) await this.options.backend.request('/disable', 'POST', { reason: 'restart' })
        else await this.options.backend.request('/disable', 'POST')
      } catch { closed = false }
      if (!this.current(generation)) return this.getStatus()
      if (!closed) {
        this.stopUnconfirmed = true
        this.update({ state: 'failed', error: 'stop', phase: null, publicUrl: null })
      } else {
        this.update({ state: retrying ? 'reconnecting' : 'failed', error: category, phase: null, publicUrl: null })
        if (retrying) this.scheduleRetry()
      }
    }
    return this.getStatus()
  }

  private canRetry() { return this.wanted && !this.disposed && !this.stopUnconfirmed }

  private scheduleRetry() {
    if (!this.canRetry()) return
    this.update({ state: 'reconnecting' })
    this.retry = setTimeout(() => { this.retry = null; void this.start(PUBLIC_ACCESS_CONSENT_VERSION) }, Math.min(30_000, 1000 * 2 ** this.retryCount++))
    this.retry.unref?.()
  }

  private async recoverAfterExit() {
    const resume = this.wanted
    const stopped = this.stop({ restart: resume })
    const generation = this.generation
    this.wanted = resume
    await stopped
    if (this.current(generation) && resume && !this.stopUnconfirmed) this.scheduleRetry()
  }

  /**
   * `restart`: the gateway comes back right after (tunnel or sidecar recovery),
   * so phones keep their resumable session streams instead of starting over.
   */
  async stop(options: { restart?: boolean } = {}) {
    this.wanted = false
    const generation = ++this.generation
    this.controller?.abort()
    this.controller = null
    this.attaching?.abort()
    this.attaching = null
    this.unsubscribe?.()
    this.unsubscribe = null
    const tunnel = this.tunnel
    this.tunnel = null
    this.established = null
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
      try {
        if (options.restart) await this.options.backend.request('/disable', 'POST', { reason: 'restart' })
        else await this.options.backend.request('/disable', 'POST')
      } catch { closed = false }
      if (generation === this.generation) {
        this.stopUnconfirmed = !closed
        // A restart resumes right after, so it never reads (or acts) as switched off.
        this.update({ publicUrl: null, phase: null, error: closed ? null : 'stop',
          state: !closed ? 'failed' : options.restart ? 'reconnecting' : this.isConfigured() ? 'disabled' : 'unconfigured' })
      }
    } finally { this.stopping-- }
    return this.getStatus()
  }

  /**
   * The gateway listens on the fixed `localPort`, so cloudflared's origin is
   * unchanged after a sidecar restart. A verified tunnel built from the
   * current settings stays up and keeps its public address for the next sidecar.
   */
  private canKeepTunnel() {
    return this.wanted && !this.disposed && !this.stopUnconfirmed && this.tunnel !== null &&
      this.established !== null && this.established.key === this.tunnelKey()
  }

  async serverUnavailable() {
    if (this.canKeepTunnel()) {
      // The gateway went down with the sidecar; cloudflared stays connected and
      // still watches for its own exit (recoverAfterExit) meanwhile.
      this.attachment++
      this.attaching?.abort()
      this.attaching = null
      this.update({ state: 'reconnecting', phase: null, error: null, publicUrl: null })
      return
    }
    const resume = this.wanted
    const stopped = this.stop({ restart: resume })
    const generation = this.generation
    this.wanted = resume
    await stopped
    if (generation === this.generation && resume && !this.stopUnconfirmed) this.update({ state: 'reconnecting' })
  }

  async serverChanged() {
    if (this.canKeepTunnel()) {
      const attempt = this.reattach()
      this.track(attempt.then(() => this.getStatus()))
      // Superseded: a stop, a tunnel exit or the next sidecar change owns what happens now.
      if (await attempt !== 'failed') return
    }
    const resume = this.wanted
    const stopped = this.stop({ restart: resume })
    const generation = this.generation
    this.wanted = resume
    await stopped
    await this.pending?.catch(() => {})
    if (resume && this.current(generation) && !this.stopUnconfirmed) await this.start(PUBLIC_ACCESS_CONSENT_VERSION)
  }

  /**
   * Opens the new sidecar's gateway on the same port and origin the running
   * tunnel already serves, so phones keep the address they were paired with.
   * `failed` asks the caller to rebuild the tunnel from scratch.
   */
  private async reattach(): Promise<AttachOutcome> {
    const generation = this.generation
    const attachment = ++this.attachment
    const tunnel = this.tunnel
    const { publicUrl } = this.established!
    const port = this.settings.localPort
    this.attaching?.abort()
    const controller = new AbortController()
    this.attaching = controller
    const live = () => this.current(generation) && attachment === this.attachment && this.tunnel === tunnel
    this.update({ state: 'reconnecting', phase: 'checking', error: null, publicUrl: null })
    try {
      const enabled = await this.options.backend.request<{ port: number }>('/enable', 'POST', { port })
      if (!live()) return 'superseded'
      if (enabled.port !== port) return 'failed'
      await this.options.backend.request('/origin', 'PUT', { publicUrl })
      if (!live()) return 'superseded'
      const verified = await this.verifyPublicUrl(live, controller.signal)
      if (verified === null) return 'superseded'
      if (!verified) return 'failed'
      this.update({ state: 'online', phase: null, error: null, publicUrl })
      return 'online'
    } catch {
      return live() ? 'failed' : 'superseded'
    } finally {
      if (this.attaching === controller) this.attaching = null
    }
  }

  async dispose() {
    this.disposed = true
    this.syncKeepAwake()
    const pending = this.pending
    await this.stop()
    // Startup owns connector cleanup until it returns a handle. Keep the host
    // alive until cancellation has finished its bounded shutdown and cleanup.
    await pending?.catch(() => {})
  }
}
