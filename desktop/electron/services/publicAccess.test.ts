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
  const request = vi.fn(async (route: string, _method?: string, body?: unknown) => route === '/enable' ? { port: (body as { port?: number } | undefined)?.port ?? 32123 } : {})
  const listener = { url: () => 'https://fixture.ngrok-free.app', close: vi.fn(async () => {}) }
  const forward = vi.fn(async (_config: unknown) => listener)
  const manager = new PublicAccessManager({ directory, backend: { request: request as never }, forward })
  managers.push(manager)
  return { directory, request, listener, forward, manager }
}

describe('ngrok host management', () => {
  it.each(['serverUnavailable', 'serverChanged', 'stop'] as const)('rejects a configuration interrupted by %s instead of enabling the old endpoint', async interrupt => {
    const { manager, request, forward, directory } = fixture()
    const previous = { mode: 'custom' as const, customUrl: 'https://old.example.test', localPort: 17463, ngrokDomain: '' }
    const requested = { ...previous, customUrl: 'https://new.example.test', localPort: 18463 }
    await manager.configure(previous)
    const file = path.join(directory, 'public-access-private.json')
    const saved = readFileSync(file, 'utf8')
    let queue: Promise<object> = Promise.resolve({})
    let blockDisable = true
    let entered!: () => void
    let release!: () => void
    const disabling = new Promise<void>(resolve => { entered = resolve })
    request.mockClear()
    request.mockImplementation((route, _method, body) => {
      // Keep the production main-process backend queue: the lifecycle callback
      // invalidates configuration even though its second disable is queued.
      const operation = queue.catch(() => ({})).then(async () => {
        if (route === '/disable' && blockDisable) {
          blockDisable = false
          entered()
          await new Promise<void>(resolve => { release = resolve })
        }
        return route === '/enable' ? { port: (body as { port: number }).port } : {}
      })
      queue = operation
      return operation
    })
    const enabling = manager.configure(requested).then(() => manager.start(PUBLIC_ACCESS_CONSENT_VERSION))
    const outcome = enabling.then(() => null, (error: unknown) => error)
    await disabling
    const interrupted = manager[interrupt]()
    release()
    await interrupted
    const error = await outcome
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain('interrupted')
    expect(request.mock.calls.some(([route]) => route === '/enable')).toBe(false)
    expect(forward).not.toHaveBeenCalled()
    expect(manager.getStatus()).toMatchObject({ state: 'disabled', publicUrl: null, ...previous })
    expect(readFileSync(file, 'utf8')).toBe(saved)

    // An explicit retry saves and starts the requested endpoint normally.
    await manager.configure(requested)
    await manager.start(PUBLIC_ACCESS_CONSENT_VERSION)
    expect(request).toHaveBeenLastCalledWith('/enable', 'POST', { port: 18463, publicUrl: requested.customUrl })
    expect(manager.getStatus()).toMatchObject({ state: 'online', publicUrl: requested.customUrl, ...requested })
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject(requested)
  })
  it('does not try to reserve an arbitrary randomly assigned ngrok address on reconnect', async () => {
    const { manager, listener, forward } = fixture()
    forward.mockResolvedValueOnce({ ...listener, url: () => 'https://first-random.ngrok.app' })
    await manager.saveCredential('fake-token')
    await manager.start(PUBLIC_ACCESS_CONSENT_VERSION)
    expect(manager.getStatus().ngrokUrl).toBe('https://first-random.ngrok.app')
    await manager.stop()
    forward.mockResolvedValueOnce({ ...listener, url: () => 'https://next-random.ngrok.app' })
    await manager.start(PUBLIC_ACCESS_CONSENT_VERSION)
    expect(forward).toHaveBeenLastCalledWith(expect.objectContaining({ publicUrl: null }))
    expect(manager.getStatus()).toMatchObject({ state: 'online', publicUrl: 'https://next-random.ngrok.app' })
  })
  it('migrates an observed v2 ngrok URL without treating it as an explicitly registered domain', async () => {
    const { directory, request, forward } = fixture()
    writeFileSync(path.join(directory, 'public-access-private.json'), JSON.stringify({
      version: 2, authtoken: 'fake-token', mode: 'ngrok', customUrl: '', localPort: 17463,
      ngrokUrl: 'https://old-random.ngrok.app', autoStart: true, consentVersion: 2, future: 'preserve',
    }))
    const restored = new PublicAccessManager({ directory, backend: { request: request as never }, forward })
    managers.push(restored)
    expect(restored.getStatus()).toMatchObject({ ngrokUrl: 'https://old-random.ngrok.app', ngrokDomain: '' })
    await restored.restore()
    expect(forward).toHaveBeenLastCalledWith(expect.objectContaining({ publicUrl: null }))
    expect(restored.getStatus().state).toBe('online')
    expect(JSON.parse(readFileSync(path.join(directory, 'public-access-private.json'), 'utf8'))).toMatchObject({ version: 3, future: 'preserve' })
  })
  it('uses an explicitly registered domain ahead of an observed dev address and preserves it on token rotation', async () => {
    const { manager, listener, forward, directory, request } = fixture()
    await manager.saveCredential('fake-token')
    await manager.start(PUBLIC_ACCESS_CONSENT_VERSION)
    await manager.configure({ mode: 'ngrok', customUrl: '', localPort: 17463, ngrokDomain: 'https://Registered.ngrok.app/' })
    forward.mockResolvedValueOnce({ ...listener, url: () => 'https://registered.ngrok.app' })
    await manager.start(PUBLIC_ACCESS_CONSENT_VERSION)
    expect(forward).toHaveBeenLastCalledWith(expect.objectContaining({ publicUrl: 'https://registered.ngrok.app' }))
    await manager.saveCredential('rotated-token')
    expect(manager.getStatus()).toMatchObject({ ngrokDomain: 'https://registered.ngrok.app', ngrokUrl: null })
    const restored = new PublicAccessManager({ directory, backend: { request: request as never }, forward })
    managers.push(restored)
    expect(restored.getStatus().ngrokDomain).toBe('https://registered.ngrok.app')
    await restored.start(PUBLIC_ACCESS_CONSENT_VERSION)
    expect(restored.getStatus()).toMatchObject({ state: 'failed', error: 'configuration' })
  })
  it('recognizes a newly assigned ngrok-free.dev address as an account dev domain', async () => {
    const { manager, listener, forward } = fixture()
    forward.mockResolvedValue({ ...listener, url: () => 'https://fixture.ngrok-free.dev' })
    await manager.saveCredential('fake-token')
    await manager.start(PUBLIC_ACCESS_CONSENT_VERSION)
    await manager.stop()
    await manager.start(PUBLIC_ACCESS_CONSENT_VERSION)
    expect(forward).toHaveBeenLastCalledWith(expect.objectContaining({ publicUrl: 'https://fixture.ngrok-free.dev' }))
    expect(manager.getStatus().state).toBe('online')
  })
  it('migrates an explicitly supplied domain without replacing it with a cached ngrok address', () => {
    expect(migratePublicAccessSettings({ version: 2, ngrokDomain: 'https://Registered.Example.test/', ngrokUrl: 'https://random.ngrok.app', future: 7 })).toMatchObject({
      version: 3, ngrokDomain: 'https://registered.example.test', ngrokUrl: 'https://random.ngrok.app', future: 7, autoStart: false, consentVersion: 0,
    })
  })
  it('fails an unavailable registered domain without retrying with a different domain', async () => {
    const { manager, forward, request } = fixture()
    await manager.saveCredential('fake-token')
    await manager.configure({ mode: 'ngrok', customUrl: '', localPort: 17463, ngrokDomain: 'https://registered.ngrok.app' })
    forward.mockRejectedValueOnce(new Error('registered domain is not available'))
    await manager.start(PUBLIC_ACCESS_CONSENT_VERSION)
    expect(forward).toHaveBeenCalledTimes(1)
    expect(manager.getStatus()).toMatchObject({ state: 'failed', error: 'configuration', ngrokDomain: 'https://registered.ngrok.app', publicUrl: null })
    expect(request).toHaveBeenLastCalledWith('/disable', 'POST')
  })
  it('preserves a malformed explicit saved domain and fails closed during migration', async () => {
    const { directory, request, forward } = fixture()
    const file = path.join(directory, 'public-access-private.json')
    const saved = JSON.stringify({ version: 2, authtoken: 'fake-token', ngrokDomain: 'https://registered.ngrok.app:8443', autoStart: true, consentVersion: 2, extra: 'preserve' })
    writeFileSync(file, saved)
    const restored = new PublicAccessManager({ directory, backend: { request: request as never }, forward })
    managers.push(restored)
    await restored.restore()
    expect(restored.getStatus()).toMatchObject({ state: 'unconfigured', error: 'configuration' })
    expect(request).not.toHaveBeenCalled()
    expect(readFileSync(file, 'utf8')).toBe(saved)
  })
  it('migrates an existing ngrok profile without changing consent, auto start or unknown fields', () => {
    expect(migratePublicAccessSettings({ version: 1, authtoken: 'fake-token', autoStart: true, consentVersion: 2, extra: 'preserve' })).toEqual({
      version: 3, authtoken: 'fake-token', autoStart: true, consentVersion: 2, extra: 'preserve',
      mode: 'ngrok', customUrl: '', localPort: 17463, ngrokDomain: '', ngrokUrl: null,
    })
  })
  it('starts an external tunnel gateway without ngrok and keeps its fixed port across restart', async () => {
    const { manager, request, forward, directory } = fixture()
    const configuration = { mode: 'custom' as const, customUrl: 'https://relay.example.test/', localPort: 17463, ngrokDomain: '' }
    await manager.configure(configuration)
    await manager.start(PUBLIC_ACCESS_CONSENT_VERSION)
    expect(request).toHaveBeenLastCalledWith('/enable', 'POST', { port: 17463, publicUrl: 'https://relay.example.test' })
    expect(forward).not.toHaveBeenCalled()
    expect(manager.getStatus()).toMatchObject({ mode: 'custom', state: 'online', localPort: 17463, publicUrl: 'https://relay.example.test', hasCredential: false })
    request.mockClear()
    await manager.start(PUBLIC_ACCESS_CONSENT_VERSION)
    await manager.configure({ ...configuration, customUrl: 'https://relay.example.test' })
    expect(request).not.toHaveBeenCalled()
    manager.setAutoStart(true)
    await manager.stop()
    const restored = new PublicAccessManager({ directory, backend: { request: request as never }, forward })
    managers.push(restored)
    await restored.restore()
    expect(restored.getStatus()).toMatchObject({ state: 'online', mode: 'custom', publicUrl: 'https://relay.example.test' })
    expect(request).toHaveBeenLastCalledWith('/enable', 'POST', { port: 17463, publicUrl: 'https://relay.example.test' })
  })
  it('does not revive an external gateway status after disable during a pending enable', async () => {
    const { manager, request } = fixture()
    await manager.configure({ mode: 'custom', customUrl: 'https://relay.example.test', localPort: 17463, ngrokDomain: '' })
    let finish!: (value: { port: number }) => void
    request.mockImplementation(async route => route === '/enable' ? new Promise(resolve => { finish = resolve }) : {})
    const connecting = manager.start(PUBLIC_ACCESS_CONSENT_VERSION)
    await manager.stop()
    finish({ port: 17463 })
    await connecting
    expect(manager.getStatus()).toMatchObject({ state: 'disabled', publicUrl: null })
  })
  it('preserves the ngrok credential and opted-in recovery when changing connection mode', async () => {
    const { manager, directory, forward } = fixture()
    await manager.saveCredential('fake-token')
    manager.setAutoStart(true)
    await manager.configure({ mode: 'custom', customUrl: 'https://relay.example.test', localPort: 17463, ngrokDomain: '' })
    await manager.start(PUBLIC_ACCESS_CONSENT_VERSION)
    await manager.serverUnavailable()
    await manager.serverChanged()
    expect(manager.getStatus().state).toBe('online')
    expect(forward).not.toHaveBeenCalled()
    expect(JSON.parse(readFileSync(path.join(directory, 'public-access-private.json'), 'utf8'))).toMatchObject({ authtoken: 'fake-token', autoStart: true })
    await manager.configure({ mode: 'ngrok', customUrl: 'https://relay.example.test', localPort: 17463, ngrokDomain: '' })
    await manager.start(PUBLIC_ACCESS_CONSENT_VERSION)
    expect(forward).toHaveBeenCalledTimes(1)
  })
  it('rejects unsafe external tunnel configuration before stopping the active connection', async () => {
    const { manager, request } = fixture()
    await manager.saveCredential('fake-token')
    await manager.start(PUBLIC_ACCESS_CONSENT_VERSION)
    request.mockClear()
    const valid = { mode: 'custom', customUrl: 'https://relay.example.test', localPort: 17463, ngrokDomain: '' }
    for (const patch of [{ customUrl: 'http://relay.example.test' }, { customUrl: 'https://user:pass@relay.example.test' }, { customUrl: 'https://relay.example.test/path' }, { customUrl: 'https://relay.example.test?token=x' }, { localPort: 0 }, { localPort: 65536 }, { localPort: '17463' }, { localPort: 17463.5 }, { mode: 'unknown' }, { localHost: '0.0.0.0' }]) {
      await expect(manager.configure({ ...valid, ...patch } as never)).rejects.toThrow('configuration')
    }
    expect(request).not.toHaveBeenCalled()
    expect(manager.getStatus().state).toBe('online')
  })
  it('fails a fixed-port mismatch without starting ngrok or silently using another local target', async () => {
    const { manager, request, forward } = fixture()
    await manager.configure({ mode: 'custom', customUrl: 'https://relay.example.test', localPort: 17463, ngrokDomain: '' })
    request.mockImplementation(async route => route === '/enable' ? { port: 32123 } : {})
    await manager.start(PUBLIC_ACCESS_CONSENT_VERSION)
    expect(manager.getStatus()).toMatchObject({ state: 'failed', error: 'configuration' })
    expect(request).toHaveBeenLastCalledWith('/disable', 'POST')
    expect(forward).not.toHaveBeenCalled()
  })
  it.each([
    { customUrl: 'http://relay.example.test', localPort: 17463, ngrokDomain: '' },
    { customUrl: 'https://relay.example.test', localPort: undefined },
    { customUrl: 'https://relay.example.test', localPort: null },
  ])('preserves invalid saved external configuration instead of restoring a different endpoint: %j', async configuration => {
    const { directory, request, forward } = fixture()
    const file = path.join(directory, 'public-access-private.json')
    const saved = JSON.stringify({ version: 2, mode: 'custom', ...configuration, autoStart: true, consentVersion: 2, extra: 'preserve' })
    writeFileSync(file, saved)
    const manager = new PublicAccessManager({ directory, backend: { request: request as never }, forward })
    managers.push(manager)
    await manager.restore()
    expect(manager.getStatus()).toMatchObject({ state: 'unconfigured', error: 'configuration' })
    expect(request).not.toHaveBeenCalled()
    expect(readFileSync(file, 'utf8')).toBe(saved)
  })
  it('reuses the saved account dev origin after restart and refuses an unexpected replacement', async () => {
    const { manager, directory, request, forward, listener } = fixture()
    await manager.saveCredential('fake-token')
    await manager.start(PUBLIC_ACCESS_CONSENT_VERSION)
    expect(manager.getStatus().ngrokUrl).toBe('https://fixture.ngrok-free.app')
    await manager.stop()
    const restored = new PublicAccessManager({ directory, backend: { request: request as never }, forward })
    managers.push(restored)
    await restored.start(PUBLIC_ACCESS_CONSENT_VERSION)
    expect(forward).toHaveBeenLastCalledWith(expect.objectContaining({ publicUrl: 'https://fixture.ngrok-free.app' }))
    await restored.stop()
    forward.mockResolvedValueOnce({ ...listener, url: () => 'https://unexpected.ngrok-free.app' })
    await restored.start(PUBLIC_ACCESS_CONSENT_VERSION)
    expect(restored.getStatus()).toMatchObject({ state: 'failed', error: 'configuration', ngrokUrl: 'https://fixture.ngrok-free.app', publicUrl: null })
  })
  it('keeps a known ngrok address for the same credential and resets it only when the credential changes', async () => {
    const { manager } = fixture()
    await manager.saveCredential('fake-token')
    await manager.start(PUBLIC_ACCESS_CONSENT_VERSION)
    await manager.saveCredential('fake-token')
    expect(manager.getStatus().ngrokUrl).toBe('https://fixture.ngrok-free.app')
    await manager.saveCredential('different-account')
    expect(manager.getStatus().ngrokUrl).toBeNull()
  })
  it('migrates old fixtures additively with no implicit consent or auto start', () => {
    expect(migratePublicAccessSettings({ authtoken: 'fake-token', future: 7 })).toEqual({ version: 3, authtoken: 'fake-token', autoStart: false, consentVersion: 0, future: 7, mode: 'ngrok', customUrl: '', localPort: 17463, ngrokDomain: '', ngrokUrl: null })
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
    expect(JSON.parse(readFileSync(path.join(directory, 'public-access-private.json'), 'utf8'))).toMatchObject({ version: 3, extra: true })
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
  const domains: string[] = []
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
      return {
        ...session,
        httpEndpoint: () => ({
          domain(value: string) {
            domains.push(value)
            return this
          },
          listenAndForward: () => listen(session),
        }),
      }
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
  return { sdk, sessions, tokens, listenerCloses, listen, domains }
}

describe('ngrok SDK session ownership', () => {
  it('leaves domain allocation to ngrok when reopening an arbitrary random address', async () => {
    const sdk = sdkFixture()
    sdk.listen.mockResolvedValue({ url: () => 'https://random.ngrok.app', close: vi.fn(async () => {}) })
    const { directory, request } = fixture()
    const manager = new PublicAccessManager({ directory, backend: { request: request as never }, forward: config => forwardPublicAccess(config, sdk.sdk) })
    managers.push(manager)
    await manager.saveCredential('fake-token')
    await manager.start(PUBLIC_ACCESS_CONSENT_VERSION)
    await manager.stop()
    await manager.start(PUBLIC_ACCESS_CONSENT_VERSION)
    expect(sdk.domains).toEqual([])
    expect(manager.getStatus().state).toBe('online')
  })
  it('passes the persisted HTTPS hostname to the real builder seam on reconnect', async () => {
    const sdk = sdkFixture()
    const { directory, request } = fixture()
    const manager = new PublicAccessManager({ directory, backend: { request: request as never }, forward: config => forwardPublicAccess(config, sdk.sdk) })
    managers.push(manager)
    await manager.saveCredential('fake-token')
    await manager.start(PUBLIC_ACCESS_CONSENT_VERSION)
    expect(sdk.domains).toEqual([])
    await manager.stop()
    await manager.start(PUBLIC_ACCESS_CONSENT_VERSION)
    expect(sdk.domains).toEqual(['fixture.ngrok-free.app'])
  })
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
