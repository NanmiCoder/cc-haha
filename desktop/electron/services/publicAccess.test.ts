import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { PublicAccessManager, PUBLIC_ACCESS_CONSENT_VERSION, classifyPublicAccessError, migratePublicAccessSettings, forwardPublicAccess } from './publicAccess'

const directories: string[] = []
const managers: PublicAccessManager[] = []
afterEach(async () => {
  await Promise.all(managers.splice(0).map(manager => manager.dispose()))
  directories.splice(0).forEach(directory => rmSync(directory, { recursive: true, force: true }))
  vi.useRealTimers()
})
async function advance(milliseconds: number) {
  vi.advanceTimersByTime(milliseconds)
  // Bun's Vitest compatibility does not expose advanceTimersByTimeAsync.
  for (let i = 0; i < 20; i++) await Promise.resolve()
}
function fixture() {
  const directory = mkdtempSync(path.join(tmpdir(), 'ngrok-host-test-'))
  directories.push(directory)
  const request = vi.fn(async (route: string) => route === '/enable' ? { port: 32123 } : {})
  const listener = { url: () => 'https://fixture.ngrok-free.app', close: vi.fn(async () => {}) }
  const forward = vi.fn(async (_config: unknown) => listener)
  const manager = new PublicAccessManager({ directory, backend: { request: request as never }, forward })
  managers.push(manager)
  return { directory, request, listener, forward, manager }
}

describe('ngrok host management', () => {
  it('migrates old fixtures additively with no implicit consent or auto start', () => {
    expect(migratePublicAccessSettings({ authtoken: 'fake-token', future: 7 })).toEqual({ version: 1, authtoken: 'fake-token', autoStart: false, consentVersion: 0, future: 7 })
    expect(migratePublicAccessSettings({ version: 4 }).version).toBe(4)
  })
  it('keeps credentials private and redacts all returned statuses', async () => {
    const { manager, directory } = fixture()
    const status = await manager.saveCredential('fake-secret')
    expect(JSON.stringify(status)).not.toContain('fake-secret')
    const file = path.join(directory, 'public-access-private.json')
    expect(JSON.parse(readFileSync(file, 'utf8')).authtoken).toBe('fake-secret')
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600)
    await manager.deleteCredential()
    expect(readFileSync(file, 'utf8')).not.toContain('fake-secret')
  })
  it('requires current consent and never starts a fresh profile automatically', async () => {
    const { manager, forward } = fixture()
    await manager.restore()
    expect(forward).not.toHaveBeenCalled()
    await manager.saveCredential('fake-token')
    await expect(manager.start(0)).rejects.toThrow('consent')
    expect(forward).not.toHaveBeenCalled()
  })
  it('does not restore v1 consent after remote settings capabilities expand', async () => {
    const { directory } = fixture()
    const file = path.join(directory, 'public-access-private.json')
    writeFileSync(file, JSON.stringify({ version: 1, authtoken: 'fake-token', autoStart: true, consentVersion: 1, future: 'preserved' }))
    const request = vi.fn(async (route: string) => route === '/enable' ? { port: 32123 } : {})
    const forward = vi.fn(async () => ({ url: () => 'https://fixture.ngrok-free.app', close: vi.fn(async () => {}) }))
    const manager = new PublicAccessManager({ directory, backend: { request: request as never }, forward })
    managers.push(manager)
    await manager.restore()
    await expect(manager.start(1)).rejects.toThrow('consent')
    expect(forward).not.toHaveBeenCalled()
    expect(manager.getStatus().consentVersion).toBe(1)
    await manager.start(PUBLIC_ACCESS_CONSENT_VERSION)
    expect(forward).toHaveBeenCalledTimes(1)
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ consentVersion: 2, future: 'preserved' })
  })
  it('migrates persisted settings with unknown fields and consent', async () => {
    const { directory } = fixture()
    writeFileSync(path.join(directory, 'public-access-private.json'), JSON.stringify({ authtoken: 'fake-token', extra: true }))
    const manager = new PublicAccessManager({ directory, backend: { request: vi.fn(async () => ({})) as never } })
    managers.push(manager)
    expect(manager.getStatus()).toMatchObject({ autoStart: false, consentVersion: 0, hasCredential: true })
    expect(JSON.parse(readFileSync(path.join(directory, 'public-access-private.json'), 'utf8'))).toMatchObject({ version: 1, extra: true })
  })
  it('preserves corrupt configuration and fails closed without crashing startup', async () => {
    const { directory } = fixture()
    const file = path.join(directory, 'public-access-private.json')
    writeFileSync(file, '{broken')
    const manager = new PublicAccessManager({ directory, backend: { request: vi.fn(async () => ({})) as never } })
    managers.push(manager)
    expect(manager.getStatus()).toMatchObject({ hasCredential: false, error: 'configuration' })
    await manager.restore()
    expect(readFileSync(file, 'utf8')).toBe('{broken')
  })
  it('deduplicates starts and binds the public origin only after tunnel creation', async () => {
    const { manager, request, forward } = fixture()
    await manager.saveCredential('fake-token')
    await Promise.all([manager.start(PUBLIC_ACCESS_CONSENT_VERSION), manager.start(PUBLIC_ACCESS_CONSENT_VERSION)])
    expect(forward).toHaveBeenCalledTimes(1)
    expect(request).toHaveBeenLastCalledWith('/origin', 'PUT', { publicUrl: 'https://fixture.ngrok-free.app' })
    expect(manager.getStatus()).toMatchObject({ state: 'online', consentVersion: PUBLIC_ACCESS_CONSENT_VERSION })
  })
  it('closes late SDK results after stop without publishing their URL', async () => {
    const { manager, forward, listener, request } = fixture()
    await manager.saveCredential('fake-token')
    let finish!: (value: typeof listener) => void
    forward.mockImplementation(() => new Promise(resolve => { finish = resolve }))
    const start = manager.start(PUBLIC_ACCESS_CONSENT_VERSION)
    await Promise.resolve()
    await manager.stop()
    finish(listener)
    await start
    expect(listener.close).toHaveBeenCalledTimes(1)
    expect(manager.getStatus().state).toBe('disabled')
    expect(request.mock.calls.some(([route]) => route === '/origin')).toBe(false)
  })
  it('exit prevents pending connection or restart from reopening', async () => {
    const { manager, forward, listener } = fixture()
    await manager.saveCredential('fake-token')
    let finish!: (value: typeof listener) => void
    forward.mockImplementation(() => new Promise(resolve => { finish = resolve }))
    const start = manager.start(PUBLIC_ACCESS_CONSENT_VERSION)
    await Promise.resolve()
    await manager.dispose()
    finish(listener)
    await start
    await manager.start(PUBLIC_ACCESS_CONSENT_VERSION)
    expect(forward).toHaveBeenCalledTimes(1)
    expect(listener.close).toHaveBeenCalled()
  })
  it('rebinds on sidecar restart and drops the old tunnel', async () => {
    const { manager, forward, listener } = fixture()
    await manager.saveCredential('fake-token')
    await manager.start(PUBLIC_ACCESS_CONSENT_VERSION)
    await manager.serverUnavailable()
    expect(manager.getStatus().state).toBe('reconnecting')
    await manager.serverChanged()
    expect(listener.close).toHaveBeenCalledTimes(1)
    expect(forward).toHaveBeenCalledTimes(2)
    expect(manager.getStatus().state).toBe('online')
  })
  it('reflects SDK reconnect notifications and ignores callbacks after disable', async () => {
    const { manager, forward } = fixture()
    await manager.saveCredential('fake-token')
    await manager.start(PUBLIC_ACCESS_CONSENT_VERSION)
    const config = forward.mock.calls[0]![0] as { onStatusChange: (state: string) => void }
    config.onStatusChange('closed')
    expect(manager.getStatus().state).toBe('reconnecting')
    config.onStatusChange('connected')
    expect(manager.getStatus().state).toBe('online')
    await manager.stop()
    config.onStatusChange('connected')
    expect(manager.getStatus().state).toBe('disabled')
  })
  it('retries network failure with backoff but stops on auth and quota', async () => {
    vi.useFakeTimers()
    const { manager, forward } = fixture()
    await manager.saveCredential('fake-token')
    forward.mockRejectedValueOnce(new Error('network unavailable fake-token'))
    await manager.start(PUBLIC_ACCESS_CONSENT_VERSION)
    expect(manager.getStatus()).toMatchObject({ state: 'reconnecting', error: 'network' })
    await advance(1000)
    expect(manager.getStatus().state).toBe('online')
    await manager.stop()
    forward.mockRejectedValueOnce(new Error('authtoken invalid fake-token'))
    await manager.start(PUBLIC_ACCESS_CONSENT_VERSION)
    expect(manager.getStatus()).toMatchObject({ state: 'failed', error: 'auth' })
    await advance(60_000)
    expect(forward).toHaveBeenCalledTimes(3)
    expect(classifyPublicAccessError(new Error('ERR_NGROK_108 too many sessions'))).toBe('quota')
  })
  it('rechecks terminal auth after a stalled SDK reconnect and stops retrying', async () => {
    vi.useFakeTimers()
    const { manager, forward, listener } = fixture()
    await manager.saveCredential('fake-token')
    await manager.start(PUBLIC_ACCESS_CONSENT_VERSION)
    const config = forward.mock.calls[0]![0] as { onStatusChange: (state: string) => void }
    forward.mockRejectedValueOnce(new Error('ERR_NGROK_105 authentication denied'))
    config.onStatusChange('closed')
    await advance(15_000)
    config.onStatusChange('closed')
    await advance(15_000)
    expect(listener.close).toHaveBeenCalledTimes(1)
    expect(manager.getStatus()).toMatchObject({ state: 'failed', error: 'auth' })
    await advance(60_000)
    expect(forward).toHaveBeenCalledTimes(2)
  })
  it('preserves disconnect notifications received before origin publication', async () => {
    const { manager, forward, listener } = fixture()
    await manager.saveCredential('fake-token')
    forward.mockImplementation(async value => {
      (value as { onStatusChange: (state: string) => void }).onStatusChange('closed')
      return listener
    })
    await manager.start(PUBLIC_ACCESS_CONSENT_VERSION)
    expect(manager.getStatus().state).toBe('reconnecting')
  })
  it('disables the local entry immediately and bounds a hanging SDK close', async () => {
    vi.useFakeTimers()
    const { manager, listener, request } = fixture()
    await manager.saveCredential('fake-token')
    await manager.start(PUBLIC_ACCESS_CONSENT_VERSION)
    listener.close.mockImplementation(() => new Promise(() => {}))
    const stopped = manager.stop()
    expect(request).toHaveBeenLastCalledWith('/disable', 'POST')
    await advance(0)
    await advance(3000)
    await stopped
    expect(manager.getStatus().state).toBe('disabled')
  })
  it('does not publish an old connection error after stop during backend cleanup', async () => {
    const { manager, forward, request } = fixture()
    await manager.saveCredential('fake-token')
    forward.mockRejectedValueOnce(new Error('network unavailable'))
    let finishDisable!: () => void
    let disableCount = 0
    request.mockImplementation(async route => {
      if (route === '/enable') return { port: 32123 }
      if (route === '/disable' && ++disableCount === 1) await new Promise<void>(resolve => { finishDisable = resolve })
      return {}
    })
    const connecting = manager.start(PUBLIC_ACCESS_CONSENT_VERSION)
    for (let i = 0; i < 20; i++) await Promise.resolve()
    expect(finishDisable).toBeDefined()
    await manager.stop()
    finishDisable()
    await connecting
    expect(manager.getStatus()).toMatchObject({ state: 'disabled', error: null })
  })
  it('keeps auto-start opt-in across normal stop', async () => {
    const { manager, directory, request, forward } = fixture()
    await manager.saveCredential('fake-token')
    manager.setAutoStart(true)
    await manager.start(PUBLIC_ACCESS_CONSENT_VERSION)
    await manager.stop()
    const restored = new PublicAccessManager({ directory, backend: { request: request as never }, forward })
    managers.push(restored)
    await restored.restore()
    expect(restored.getStatus().state).toBe('online')
  })
})

// Models v1.7.0: forward() retains one session and its original credentials and
// callbacks after listener.close(). Explicit builders own independent sessions.
function sdkFixture() {
  type Session = { token: string, disconnected: () => boolean, heartbeat: (latency: number | null) => void, close: ReturnType<typeof vi.fn> }
  const sessions: Session[] = []
  const tokens: string[] = []
  const listenerCloses: ReturnType<typeof vi.fn>[] = []
  const listen = vi.fn(async (session: Session) => {
    tokens.push(session.token)
    const close = vi.fn(async () => {})
    listenerCloses.push(close)
    return { url: (): string => 'https://fixture.ngrok-free.app', close }
  })
  class SessionBuilder {
    token = ''
    disconnected = () => true
    heartbeat = (_latency: number | null) => {}
    authtoken(token: string) {
      this.token = token
      return this
    }
    handleDisconnection(handler: () => boolean) {
      this.disconnected = handler
      return this
    }
    handleHeartbeat(handler: (latency: number | null) => void) {
      this.heartbeat = handler
      return this
    }
    async connect() {
      const session = { token: this.token, disconnected: this.disconnected, heartbeat: this.heartbeat, close: vi.fn(async () => {}) }
      sessions.push(session)
      return { ...session, httpEndpoint: () => ({ listenAndForward: () => listen(session) }) }
    }
  }
  let singleton: Session | undefined
  const forward = vi.fn(async (config: { authtoken: string, onStatusChange: (status: string) => void }) => {
    if (!singleton) {
      singleton = {
        token: config.authtoken,
        disconnected: () => {
          config.onStatusChange('closed')
          return true
        },
        heartbeat: () => config.onStatusChange('connected'),
        close: vi.fn(async () => {}),
      }
      sessions.push(singleton)
    }
    return listen(singleton)
  })
  const sdk = { SessionBuilder, forward } as never
  return { sdk, sessions, tokens, listenerCloses, listen }
}

describe('ngrok SDK session ownership', () => {
  it('changes credentials and reconnect callbacks after reopening and closes owned sessions', async () => {
    const sdk = sdkFixture()
    const { directory, request } = fixture()
    const manager = new PublicAccessManager({ directory, backend: { request: request as never }, forward: config => forwardPublicAccess(config, sdk.sdk) })
    managers.push(manager)
    await manager.saveCredential('first-account')
    await manager.start(PUBLIC_ACCESS_CONSENT_VERSION)
    await manager.saveCredential('second-account')
    await manager.start(PUBLIC_ACCESS_CONSENT_VERSION)
    expect(sdk.tokens).toEqual(['first-account', 'second-account'])
    expect(sdk.sessions[0]!.close).toHaveBeenCalledTimes(1)
    sdk.sessions[0]!.disconnected()
    expect(manager.getStatus().state).toBe('online')
    sdk.sessions[1]!.disconnected()
    expect(manager.getStatus().state).toBe('reconnecting')
    sdk.sessions[1]!.heartbeat(null)
    expect(manager.getStatus().state).toBe('reconnecting')
    sdk.sessions[1]!.heartbeat(3)
    expect(manager.getStatus().state).toBe('online')
    await manager.deleteCredential()
    expect(sdk.sessions[1]!.close).toHaveBeenCalledTimes(1)
    expect(sdk.listenerCloses.every(close => close.mock.calls.length === 1)).toBe(true)
  })
  it('replaces a stalled session and retains callbacks on the replacement', async () => {
    vi.useFakeTimers()
    const sdk = sdkFixture()
    const { directory, request } = fixture()
    const manager = new PublicAccessManager({ directory, backend: { request: request as never }, forward: config => forwardPublicAccess(config, sdk.sdk) })
    managers.push(manager)
    await manager.saveCredential('fake-token')
    await manager.start(PUBLIC_ACCESS_CONSENT_VERSION)
    sdk.sessions[0]!.disconnected()
    await advance(30_000)
    for (let i = 0; i < 30; i++) await Promise.resolve()
    expect(sdk.sessions).toHaveLength(2)
    expect(sdk.sessions[0]!.close).toHaveBeenCalledTimes(1)
    expect(manager.getStatus().state).toBe('online')
    sdk.sessions[1]!.disconnected()
    expect(manager.getStatus().state).toBe('reconnecting')
    sdk.sessions[1]!.heartbeat(4)
    expect(manager.getStatus().state).toBe('online')
  })
  it('closes only the old owned session when its listener arrives after a new start', async () => {
    const sdk = sdkFixture()
    const { directory, request } = fixture()
    const manager = new PublicAccessManager({ directory, backend: { request: request as never }, forward: config => forwardPublicAccess(config, sdk.sdk) })
    managers.push(manager)
    await manager.saveCredential('fake-token')
    let finish!: (listener: Awaited<ReturnType<typeof sdk.listen>>) => void
    sdk.listen.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const first = manager.start(PUBLIC_ACCESS_CONSENT_VERSION)
    for (let i = 0; i < 20; i++) await Promise.resolve()
    await manager.stop()
    await manager.start(PUBLIC_ACCESS_CONSENT_VERSION)
    finish({ url: () => 'https://old.ngrok-free.app', close: vi.fn(async () => {}) })
    await first
    expect(sdk.sessions[0]!.close).toHaveBeenCalledTimes(1)
    expect(sdk.sessions[1]!.close).not.toHaveBeenCalled()
    expect(manager.getStatus()).toMatchObject({ state: 'online', publicUrl: 'https://fixture.ngrok-free.app' })
  })
  it('closes the session even when endpoint creation fails', async () => {
    const sdk = sdkFixture()
    sdk.listen.mockRejectedValueOnce(new Error('network unavailable'))
    await expect(forwardPublicAccess({ addr: '127.0.0.1:1', authtoken: 'fake', onStatusChange: () => {} }, sdk.sdk)).rejects.toThrow('network unavailable')
    expect(sdk.sessions[0]!.close).toHaveBeenCalledTimes(1)
  })
})
