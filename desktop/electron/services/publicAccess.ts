import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { PUBLIC_ACCESS_CONSENT_VERSION, type DesktopPublicAccessConfiguration, type DesktopPublicAccessStatus } from '../../src/lib/desktopHost/types'
import { DEFAULT_PUBLIC_ACCESS_PORT, isPublicAccessConfiguration, normalizePublicAccessOrigin, normalizeTailscaleOrigin } from '../../src/lib/desktopHost/publicAccessConfiguration'
export { PUBLIC_ACCESS_CONSENT_VERSION } from '../../src/lib/desktopHost/types'

export type PublicAccessStatus = DesktopPublicAccessStatus
type Settings = Record<string, unknown> & DesktopPublicAccessConfiguration & {
  version: number
  autoStart: boolean
  consentVersion: number
  migrationRequired: boolean
}
type Backend = { request<T>(route: string, method: string, body?: unknown): Promise<T> }
type Options = { directory: string, backend: Backend }

/** Keep legacy values private and intact, but never resume a retired tunnel. */
export function migratePublicAccessSettings(raw: unknown): Settings {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid public access configuration')
  const value = raw as Record<string, unknown>
  if (value.mode === 'tailscale') {
    const config = { mode: value.mode, customUrl: value.customUrl, localPort: value.localPort }
    if (!isPublicAccessConfiguration(config)) throw new Error('Invalid public access configuration')
    return {
      ...value, ...config,
      customUrl: config.customUrl ? normalizeTailscaleOrigin(config.customUrl)! : '',
      version: typeof value.version === 'number' ? Math.max(4, value.version) : 4,
      autoStart: value.autoStart === true,
      consentVersion: typeof value.consentVersion === 'number' ? value.consentVersion : 0,
      migrationRequired: value.migrationRequired === true,
    }
  }
  if (value.mode !== undefined && value.mode !== 'ngrok' && value.mode !== 'custom') throw new Error('Invalid legacy public access configuration')
  const legacy = Object.keys(value).length > 0
  const localPort = value.localPort === undefined && value.mode !== 'custom' ? DEFAULT_PUBLIC_ACCESS_PORT : value.localPort
  if (!Number.isInteger(localPort) || (localPort as number) < 1024 || (localPort as number) > 65535) throw new Error('Invalid saved listener port')
  if (value.mode === 'custom' && !normalizePublicAccessOrigin(value.customUrl)) throw new Error('Invalid legacy public access configuration')
  const customUrl = value.mode === 'custom' ? normalizeTailscaleOrigin(value.customUrl) ?? '' : ''
  return {
    ...value,
    ...(legacy ? { legacyRemoteConfiguration: value.legacyRemoteConfiguration ?? { ...value } } : {}),
    mode: 'tailscale', customUrl, localPort: localPort as number,
    version: typeof value.version === 'number' ? Math.max(4, value.version) : 4,
    // The previous consent described a public provider, not the new private setup.
    autoStart: false, consentVersion: 0, migrationRequired: legacy && !customUrl,
  }
}

export function classifyPublicAccessError(error: unknown): NonNullable<PublicAccessStatus['error']> {
  const message = String(error instanceof Error ? error.message : error).toLowerCase()
  return /configuration|invalid|consent|eaddrinuse|address already in use/.test(message) ? 'configuration' : 'network'
}

export class PublicAccessManager {
  private settings: Settings
  private readonly file: string
  private status: Omit<PublicAccessStatus, keyof DesktopPublicAccessConfiguration | 'migrationRequired'>
  private generation = 0
  private wanted = false
  private disposed = false
  private pending: Promise<PublicAccessStatus> | null = null
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
      // Keep unreadable/corrupt user data for diagnosis; only an explicit save replaces it.
      this.settings = migratePublicAccessSettings({})
      invalid = true
    }
    this.status = { state: this.isConfigured() ? 'disabled' : 'unconfigured', publicUrl: null,
      error: invalid ? 'configuration' : null, autoStart: this.settings.autoStart, consentVersion: this.settings.consentVersion }
  }

  getStatus(): PublicAccessStatus {
    const { mode, customUrl, localPort, migrationRequired } = this.settings
    return { ...this.status, mode, customUrl, localPort, migrationRequired }
  }

  private isConfigured() { return !!this.settings.customUrl }

  async configure(configuration: DesktopPublicAccessConfiguration) {
    if (!isPublicAccessConfiguration(configuration)) throw new Error('Invalid public access configuration')
    const customUrl = configuration.customUrl ? normalizeTailscaleOrigin(configuration.customUrl)! : ''
    if (this.settings.customUrl === customUrl && this.settings.localPort === configuration.localPort) return this.getStatus()
    const stopped = this.stop()
    const generation = this.generation
    await stopped
    if (generation !== this.generation || this.disposed) throw new Error('Public access configuration interrupted')
    if (this.stopUnconfirmed) throw new Error('Remote gateway stop was not confirmed')
    Object.assign(this.settings, { ...configuration, customUrl, consentVersion: 0, migrationRequired: false })
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
    if (this.stopping || this.stopUnconfirmed) return Promise.reject(new Error('Remote gateway stop must be confirmed before enabling access'))
    if (consentVersion !== PUBLIC_ACCESS_CONSENT_VERSION || !this.isConfigured()) return Promise.reject(new Error('Configuration and current consent required'))
    if (this.pending) return this.pending
    if (this.status.state === 'online') return Promise.resolve(this.getStatus())
    this.settings.consentVersion = consentVersion
    this.persist()
    this.status.consentVersion = consentVersion
    this.wanted = true
    if (this.retry) clearTimeout(this.retry)
    this.retry = null
    const operation = this.connect(++this.generation)
    this.pending = operation
    const clear = () => { if (this.pending === operation) this.pending = null }
    void operation.then(clear, clear)
    return operation
  }

  private async connect(generation: number) {
    this.status.state = this.retryCount ? 'reconnecting' : 'connecting'
    this.status.error = null
    try {
      const { port } = await this.options.backend.request<{ port: number }>('/enable', 'POST', {
        port: this.settings.localPort, publicUrl: this.settings.customUrl,
      })
      if (generation !== this.generation) return this.getStatus()
      if (port !== this.settings.localPort) throw new Error('Invalid fixed listener port configuration')
      // Only the local authenticated gateway is ready. Tailscale and Serve are
      // managed by the user; this does not claim that a phone can reach them.
      this.status.publicUrl = this.settings.customUrl
      this.status.state = 'online'
      this.retryCount = 0
    } catch (error) {
      if (generation !== this.generation) return this.getStatus()
      try {
        await this.options.backend.request('/disable', 'POST')
      } catch {
        if (generation === this.generation) {
          this.stopUnconfirmed = true
          // Keep the requested access pending until a ready sidecar confirms shutdown.
          Object.assign(this.status, { state: 'failed', error: 'stop' })
        }
        return this.getStatus()
      }
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

  async stop() {
    this.wanted = false
    const generation = ++this.generation
    if (this.retry) clearTimeout(this.retry)
    this.retry = null
    this.retryCount = 0
    this.pending = null
    this.stopping++
    // Serve remains running outside the app. Only a successful gateway shutdown
    // acknowledgement lets us say that remote access has actually been closed.
    try {
      await this.options.backend.request('/disable', 'POST')
      if (generation === this.generation) {
        this.stopUnconfirmed = false
        Object.assign(this.status, { publicUrl: null, error: null, state: this.isConfigured() ? 'disabled' : 'unconfigured' })
      }
    } catch {
      if (generation === this.generation) {
        this.stopUnconfirmed = true
        Object.assign(this.status, { state: 'failed', error: 'stop' })
      }
    } finally {
      this.stopping--
    }
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
    if (resume && !this.disposed && generation === this.generation && !this.stopUnconfirmed) await this.start(PUBLIC_ACCESS_CONSENT_VERSION)
  }

  async dispose() {
    this.disposed = true
    await this.stop()
  }
}
