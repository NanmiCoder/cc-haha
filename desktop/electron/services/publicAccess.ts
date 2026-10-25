import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { PUBLIC_ACCESS_CONSENT_VERSION, type DesktopPublicAccessConfiguration, type DesktopPublicAccessStatus } from '../../src/lib/desktopHost/types'
import { DEFAULT_PUBLIC_ACCESS_PORT, isNgrokDevOrigin, isPublicAccessConfiguration, normalizeNgrokDomain, normalizePublicAccessOrigin } from '../../src/lib/desktopHost/publicAccessConfiguration'
export { PUBLIC_ACCESS_CONSENT_VERSION } from '../../src/lib/desktopHost/types'

export type PublicAccessStatus = DesktopPublicAccessStatus
type Settings = Record<string, unknown> & DesktopPublicAccessConfiguration & { version: number, authtoken: string, autoStart: boolean, consentVersion: number, ngrokUrl: string | null }
type Listener = { url(): string | null, close(): Promise<void> }
type ForwardConfig = { addr: string, authtoken: string, publicUrl?: string | null, onStatusChange: (status: string) => void }
type NgrokSdk = Pick<typeof import('@ngrok/ngrok'), 'SessionBuilder'>
export async function forwardPublicAccess(config: ForwardConfig, sdk: NgrokSdk): Promise<Listener> {
  // forward() retains a process-global session, including its original token
  // and callbacks. Own a session per attempt so stop and credential rotation
  // also end authentication, without closing another generation's session.
  let closed = false
  const session = await new sdk.SessionBuilder()
    .authtoken(config.authtoken)
    .handleDisconnection(() => {
      if (!closed) config.onStatusChange('closed')
      return true
    })
    .handleHeartbeat(latency => {
      // The native SDK can pass null when a heartbeat has no response.
      if (!closed && typeof latency === 'number') config.onStatusChange('connected')
    })
    .connect()
  try {
    const endpoint = session.httpEndpoint()
    if (config.publicUrl) endpoint.domain(new URL(config.publicUrl).hostname)
    const listener = await endpoint.listenAndForward(`http://${config.addr}`)
    return {
      url: () => listener.url(),
      async close() {
        closed = true
        await Promise.all([closePublicAccessResource(listener), closePublicAccessResource(session)])
      },
    }
  } catch (error) {
    closed = true
    await closePublicAccessResource(session)
    throw error
  }
}

async function closePublicAccessResource(resource: { close(): Promise<void> }) {
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      resource.close(),
      new Promise<void>(resolve => { timeout = setTimeout(resolve, 3_000) }),
    ])
  } catch { /* SDK errors can contain credentials; do not log them. */ }
  finally { if (timeout) clearTimeout(timeout) }
}
type Backend = { request<T>(route: string, method: string, body?: unknown): Promise<T> }
type Options = {
  directory: string
  backend: Backend
  forward?: (config: ForwardConfig) => Promise<Listener>
}

/** Forward migration is additive and keeps unrecognized fields in this private file. */
export function migratePublicAccessSettings(raw: unknown): Settings {
  const value = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {}
  const config = {
    mode: value.mode === undefined ? 'ngrok' : value.mode,
    customUrl: value.customUrl === undefined ? '' : value.customUrl,
    localPort: value.localPort === undefined && value.mode !== 'custom' ? DEFAULT_PUBLIC_ACCESS_PORT : value.localPort,
    ngrokDomain: value.ngrokDomain === undefined ? '' : value.ngrokDomain,
  }
  // A malformed saved endpoint must not become a different, implicitly enabled route.
  if (!isPublicAccessConfiguration(config)) throw new Error('Invalid public access configuration')
  const ngrokUrl = value.ngrokUrl == null ? null : normalizePublicAccessOrigin(value.ngrokUrl)
  if (value.ngrokUrl != null && !ngrokUrl) throw new Error('Invalid saved ngrok domain configuration')
  return {
    ...value,
    ...config,
    customUrl: config.customUrl ? normalizePublicAccessOrigin(config.customUrl)! : '',
    ngrokDomain: config.ngrokDomain ? normalizeNgrokDomain(config.ngrokDomain)! : '',
    ngrokUrl,
    version: typeof value.version === 'number' ? Math.max(3, value.version) : 3,
    authtoken: typeof value.authtoken === 'string' ? value.authtoken : '',
    autoStart: value.autoStart === true,
    consentVersion: typeof value.consentVersion === 'number' ? value.consentVersion : 0,
  }
}

export function classifyPublicAccessError(error: unknown): NonNullable<PublicAccessStatus['error']> {
  // Never return provider messages: they may echo credentials or request details.
  const message = String(error instanceof Error ? error.message : error).toLowerCase()
  if (/authtoken|authentication|unauthorized|err_ngrok_(105|106|107|109|4018)/.test(message)) return 'auth'
  if (/quota|limit|bandwidth|err_ngrok_(108|120|122|324|6024)/.test(message)) return 'quota'
  if (/domain|configuration|invalid|consent|credential/.test(message)) return 'configuration'
  return 'network'
}

export class PublicAccessManager {
  private settings: Settings
  private readonly file: string
  private status: Omit<PublicAccessStatus, keyof DesktopPublicAccessConfiguration | 'ngrokUrl'>
  private generation = 0
  private wanted = false
  private disposed = false
  private listener: Listener | null = null
  private pending: Promise<PublicAccessStatus> | null = null
  private retry: ReturnType<typeof setTimeout> | null = null
  private retryCount = 0
  private disconnectWatchdog: ReturnType<typeof setTimeout> | null = null

  constructor(private options: Options) {
    this.file = path.join(options.directory, 'public-access-private.json')
    let invalid = false
    try {
      this.settings = migratePublicAccessSettings(existsSync(this.file) ? JSON.parse(readFileSync(this.file, 'utf8')) : {})
      if (existsSync(this.file)) this.persist()
    } catch {
      // Keep unreadable/corrupt user data for diagnosis; only an explicit save replaces it.
      this.settings = migratePublicAccessSettings({})
      invalid = true
    }
    this.status = { state: this.isConfigured() ? 'disabled' : 'unconfigured', hasCredential: !!this.settings.authtoken,
      publicUrl: null, error: invalid ? 'configuration' : null, autoStart: this.settings.autoStart, consentVersion: this.settings.consentVersion }
  }

  getStatus(): PublicAccessStatus {
    const { mode, customUrl, localPort, ngrokDomain, ngrokUrl } = this.settings
    return { ...this.status, mode, customUrl, localPort, ngrokDomain, ngrokUrl }
  }

  private isConfigured() {
    return this.settings.mode === 'custom' ? !!this.settings.customUrl : !!this.settings.authtoken
  }

  async configure(configuration: DesktopPublicAccessConfiguration) {
    if (!isPublicAccessConfiguration(configuration)) throw new Error('Invalid public access configuration')
    const customUrl = configuration.customUrl ? normalizePublicAccessOrigin(configuration.customUrl)! : ''
    const ngrokDomain = configuration.ngrokDomain ? normalizeNgrokDomain(configuration.ngrokDomain)! : ''
    if (this.settings.mode === configuration.mode && this.settings.customUrl === customUrl && this.settings.localPort === configuration.localPort && this.settings.ngrokDomain === ngrokDomain) return this.getStatus()
    const stopped = this.stop()
    const generation = this.generation
    await stopped
    if (generation !== this.generation || this.disposed) throw new Error('Public access configuration interrupted')
    Object.assign(this.settings, { ...configuration, customUrl, ngrokDomain, consentVersion: 0 })
    this.persist()
    Object.assign(this.status, { consentVersion: 0, state: this.isConfigured() ? 'disabled' : 'unconfigured' })
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

  async saveCredential(token: string) {
    if (!token.trim() || token.length > 4096 || /\s/.test(token.trim())) throw new Error('Invalid credential')
    await this.stop()
    if (this.settings.authtoken !== token.trim()) this.settings.ngrokUrl = null
    this.settings.authtoken = token.trim()
    this.persist()
    this.status.hasCredential = true
    this.status.state = 'disabled'
    this.status.error = null
    return this.getStatus()
  }

  async deleteCredential() {
    await this.stop()
    this.settings.authtoken = ''
    this.settings.ngrokUrl = null
    this.settings.autoStart = false
    this.settings.consentVersion = 0
    this.persist()
    Object.assign(this.status, { hasCredential: false, autoStart: false, consentVersion: 0, state: this.isConfigured() ? 'disabled' : 'unconfigured' })
    return this.getStatus()
  }

  setAutoStart(enabled: boolean) {
    this.settings.autoStart = enabled
    this.persist()
    this.status.autoStart = enabled
    return this.getStatus()
  }

  async restore() {
    if (this.settings.autoStart && this.settings.consentVersion === PUBLIC_ACCESS_CONSENT_VERSION && this.isConfigured()) {
      return this.start(PUBLIC_ACCESS_CONSENT_VERSION)
    }
    return this.getStatus()
  }

  start(consentVersion: number): Promise<PublicAccessStatus> {
    if (this.disposed) return Promise.resolve(this.getStatus())
    if (consentVersion !== PUBLIC_ACCESS_CONSENT_VERSION || !this.isConfigured()) return Promise.reject(new Error('Configuration, credential and current consent required'))
    if (this.pending) return this.pending
    if (this.listener || (this.settings.mode === 'custom' && this.status.state === 'online')) return Promise.resolve(this.getStatus())
    this.settings.consentVersion = consentVersion
    this.persist()
    this.status.consentVersion = consentVersion
    this.wanted = true
    if (this.retry) clearTimeout(this.retry)
    this.retry = null
    const generation = ++this.generation
    const operation = this.connect(generation)
    this.pending = operation
    void operation.finally(() => { if (this.pending === operation) this.pending = null })
    return operation
  }

  private async connect(generation: number) {
    this.status.state = this.retryCount ? 'reconnecting' : 'connecting'
    this.status.error = null
    let listener: Listener | null = null
    try {
      const custom = this.settings.mode === 'custom'
      const { port } = custom
        ? await this.options.backend.request<{ port: number }>('/enable', 'POST', { port: this.settings.localPort, publicUrl: this.settings.customUrl })
        : await this.options.backend.request<{ port: number }>('/enable', 'POST')
      if (generation !== this.generation) return this.getStatus()
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid listener port')
      if (custom) {
        if (port !== this.settings.localPort) throw new Error('Invalid fixed listener port configuration')
        // This reports only local gateway readiness; an externally managed tunnel
        // is neither started nor probed by the app.
        this.status.publicUrl = this.settings.customUrl
        this.status.state = 'online'
        this.retryCount = 0
        return this.getStatus()
      }
      const forward = this.options.forward ?? (async config => forwardPublicAccess(config, await import('@ngrok/ngrok')))
      let disconnected = false
      const onStatusChange = (state: string) => {
        if (generation !== this.generation) return
        disconnected = state !== 'connected'
        this.status.state = disconnected ? 'reconnecting' : 'online'
        if (!this.listener) return
        if (!disconnected && this.disconnectWatchdog) {
          clearTimeout(this.disconnectWatchdog)
          this.disconnectWatchdog = null
        }
        // The SDK wrapper discards disconnect errors. Give its automatic
        // reconnect a grace period, then establish a fresh session so fatal
        // auth/quota errors become observable instead of spinning forever.
        if (disconnected && !this.disconnectWatchdog) {
          this.disconnectWatchdog = setTimeout(() => { void this.reconnectDisconnected(generation) }, 30_000)
          this.disconnectWatchdog.unref?.()
        }
      }
      // Random paid-plan addresses are observations, not domain reservations.
      // Rebind only an explicit registered domain or the account's assigned dev domain.
      const requestedUrl = this.settings.ngrokDomain || (isNgrokDevOrigin(this.settings.ngrokUrl) ? this.settings.ngrokUrl : null)
      listener = await forward({ addr: `127.0.0.1:${port}`, authtoken: this.settings.authtoken, publicUrl: requestedUrl, onStatusChange })
      if (generation !== this.generation) { await this.closeListener(listener); return this.getStatus() }
      const url = normalizePublicAccessOrigin(listener.url())
      if (!url || (requestedUrl && url !== requestedUrl)) throw new Error('Invalid public domain configuration')
      await this.options.backend.request('/origin', 'PUT', { publicUrl: url })
      if (generation !== this.generation) { await this.closeListener(listener); return this.getStatus() }
      if (this.settings.ngrokUrl !== url) {
        this.settings.ngrokUrl = url
        this.persist()
      }
      this.listener = listener
      this.status.publicUrl = url
      onStatusChange(disconnected ? 'closed' : 'connected')
      this.retryCount = 0
    } catch (error) {
      await this.closeListener(listener)
      if (generation !== this.generation) return this.getStatus()
      await this.options.backend.request('/disable', 'POST').catch(() => {})
      if (generation !== this.generation) return this.getStatus()
      this.status.error = classifyPublicAccessError(error)
      this.status.state = 'failed'
      if (this.status.error === 'network' && this.wanted) {
        this.status.state = 'reconnecting'
        this.retry = setTimeout(() => { this.retry = null; void this.start(PUBLIC_ACCESS_CONSENT_VERSION) }, Math.min(30_000, 1000 * 2 ** this.retryCount++))
        this.retry.unref?.()
      }
    }
    return this.getStatus()
  }

  private async closeListener(listener: Listener | null) {
    if (!listener) return
    await closePublicAccessResource(listener)
  }

  private async reconnectDisconnected(generation: number) {
    if (generation !== this.generation || !this.wanted) return
    this.disconnectWatchdog = null
    const listener = this.listener
    this.listener = null
    const reconnectGeneration = ++this.generation
    this.status.publicUrl = null
    await this.options.backend.request('/disable', 'POST').catch(() => {})
    await this.closeListener(listener)
    if (reconnectGeneration !== this.generation || !this.wanted) return
    this.retryCount = 1
    await this.start(PUBLIC_ACCESS_CONSENT_VERSION)
  }

  async stop() {
    this.wanted = false
    ++this.generation
    if (this.retry) clearTimeout(this.retry)
    this.retry = null
    if (this.disconnectWatchdog) clearTimeout(this.disconnectWatchdog)
    this.disconnectWatchdog = null
    this.retryCount = 0
    const listener = this.listener
    this.listener = null
    // Pending SDK calls cannot be cancelled; their generation closes any late result.
    this.pending = null
    Object.assign(this.status, { publicUrl: null, error: null, state: this.isConfigured() ? 'disabled' : 'unconfigured' })
    await this.options.backend.request('/disable', 'POST').catch(() => {})
    await this.closeListener(listener)
    return this.getStatus()
  }

  async serverUnavailable() {
    const resume = this.wanted
    const stopped = this.stop()
    this.wanted = resume
    if (resume) this.status.state = 'reconnecting'
    await stopped
  }

  async serverChanged() {
    const resume = this.wanted
    const stopped = this.stop()
    const generation = this.generation
    await stopped
    if (resume && !this.disposed && generation === this.generation) await this.start(PUBLIC_ACCESS_CONSENT_VERSION)
  }

  async dispose() {
    this.disposed = true
    await this.stop()
  }
}
