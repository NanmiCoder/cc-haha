import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { PUBLIC_ACCESS_CONSENT_VERSION } from '../../src/lib/desktopHost/types'
export { PUBLIC_ACCESS_CONSENT_VERSION } from '../../src/lib/desktopHost/types'

export type PublicAccessStatus = {
  state: 'unconfigured' | 'disabled' | 'connecting' | 'online' | 'reconnecting' | 'failed'
  hasCredential: boolean
  publicUrl: string | null
  error: 'auth' | 'quota' | 'network' | 'configuration' | null
  autoStart: boolean
  consentVersion: number
}
type Settings = Record<string, unknown> & { version: number, authtoken: string, autoStart: boolean, consentVersion: number }
type Listener = { url(): string | null, close(): Promise<void> }
type ForwardConfig = { addr: string, authtoken: string, onStatusChange: (status: string) => void }
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
    const listener = await session.httpEndpoint().listenAndForward(`http://${config.addr}`)
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
  forward?: (config: { addr: string, authtoken: string, onStatusChange: (status: string) => void }) => Promise<Listener>
}

/** Forward migration is additive and keeps unrecognized fields in this private file. */
export function migratePublicAccessSettings(raw: unknown): Settings {
  const value = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {}
  return {
    ...value,
    version: typeof value.version === 'number' ? Math.max(1, value.version) : 1,
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
  private status: PublicAccessStatus
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
    this.status = { state: this.settings.authtoken ? 'disabled' : 'unconfigured', hasCredential: !!this.settings.authtoken,
      publicUrl: null, error: invalid ? 'configuration' : null, autoStart: this.settings.autoStart, consentVersion: this.settings.consentVersion }
  }

  getStatus(): PublicAccessStatus { return { ...this.status } }

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
    this.settings.autoStart = false
    this.settings.consentVersion = 0
    this.persist()
    Object.assign(this.status, { hasCredential: false, autoStart: false, consentVersion: 0, state: 'unconfigured' })
    return this.getStatus()
  }

  setAutoStart(enabled: boolean) {
    this.settings.autoStart = enabled
    this.persist()
    this.status.autoStart = enabled
    return this.getStatus()
  }

  async restore() {
    if (this.settings.autoStart && this.settings.consentVersion === PUBLIC_ACCESS_CONSENT_VERSION && this.settings.authtoken) {
      return this.start(PUBLIC_ACCESS_CONSENT_VERSION)
    }
    return this.getStatus()
  }

  start(consentVersion: number): Promise<PublicAccessStatus> {
    if (this.disposed) return Promise.resolve(this.getStatus())
    if (consentVersion !== PUBLIC_ACCESS_CONSENT_VERSION || !this.settings.authtoken) return Promise.reject(new Error('Credential and current consent required'))
    if (this.pending) return this.pending
    if (this.listener) return Promise.resolve(this.getStatus())
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
      const { port } = await this.options.backend.request<{ port: number }>('/enable', 'POST')
      if (generation !== this.generation) return this.getStatus()
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid listener port')
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
      listener = await forward({ addr: `127.0.0.1:${port}`, authtoken: this.settings.authtoken, onStatusChange })
      if (generation !== this.generation) { await this.closeListener(listener); return this.getStatus() }
      const url = listener.url()
      if (!url || new URL(url).protocol !== 'https:') throw new Error('Invalid public domain')
      await this.options.backend.request('/origin', 'PUT', { publicUrl: url })
      if (generation !== this.generation) { await this.closeListener(listener); return this.getStatus() }
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
    Object.assign(this.status, { publicUrl: null, error: null, state: this.settings.authtoken ? 'disabled' : 'unconfigured' })
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
