import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { PublicAccessManager, PUBLIC_ACCESS_CONSENT_VERSION, classifyPublicAccessError, migratePublicAccessSettings, readPublicAccessControlResponse } from './publicAccess'
import { CloudflareTunnelError, type CloudflareTunnelExit, type CloudflareTunnelOptions, type CloudflareTunnelRoute, type CloudflareTunnelRouteWait } from './cloudflareTunnel'

const directories: string[] = []
const managers: PublicAccessManager[] = []
const quick = { mode: 'quick' as const, customUrl: '', localPort: 17463 }
const fakeToken = 'eyJhIjoiZmFrZS1maXh0dXJlLXRva2VuIiwicyI6ImZha2UifQ=='
const named = { mode: 'named' as const, customUrl: 'https://phone.example.test', localPort: 17463, tunnelToken: fakeToken }
const tokenOnly = { ...named, customUrl: '' }
const gatewayRoute = { hostname: 'phone.example.test', service: 'http://127.0.0.1:17463' }
const tunnelId = '0d9c6c2e-4f5a-4b7e-9c1d-2e3f4a5b6c7d'
const credential = btoa(JSON.stringify({ a: '0123456789abcdef0123456789abcdef', t: tunnelId, s: btoa('fake-tunnel-secret-for-tests') }))

afterEach(async () => {
  await Promise.all(managers.splice(0).map(manager => manager.dispose()))
  directories.splice(0).forEach(directory => rmSync(directory, { recursive: true, force: true }))
  vi.useRealTimers()
})

async function advance(milliseconds: number) {
  vi.advanceTimersByTime(milliseconds)
  for (let index = 0; index < 30; index++) await Promise.resolve()
}

/** The pauses before the 2nd–5th reachability checks of a public hostname. */
const VERIFY_PAUSES = [2_000, 4_000, 8_000, 15_000]
/** Runs every spaced reachability check of the current attempt. */
async function exhaustVerification() {
  for (const pause of VERIFY_PAUSES) await advance(pause)
}
const quickUrl = 'https://fixture-phone.trycloudflare.com'

function fixture(saved?: unknown) {
  const directory = mkdtempSync(path.join(tmpdir(), 'cloudflare-host-test-'))
  directories.push(directory)
  const file = path.join(directory, 'public-access-private.json')
  if (saved !== undefined) writeFileSync(file, typeof saved === 'string' ? saved : JSON.stringify(saved))
  let reachable: boolean | (() => boolean) = true
  let proxyUrl: string | null = null
  const request = vi.fn(async (route: string, _method?: string, body?: unknown): Promise<unknown> => {
    if (route === '/enable') return { port: (body as { port: number }).port }
    if (route === '/network') return { proxyUrl }
    if (route === '/verify') return { ok: typeof reachable === 'function' ? reachable() : reachable }
    return {}
  })
  const exits = new Set<(exit: CloudflareTunnelExit) => void>()
  const stop = vi.fn(async () => {})
  let routes: CloudflareTunnelRoute[] | null = null
  const routeWaiters = new Set<() => void>()
  // Same contract as the connector: wait while the caller has already seen the current routes.
  const publishedRoutes = vi.fn(async (seen: CloudflareTunnelRoute[] | null, wait: CloudflareTunnelRouteWait = {}) => {
    if (routes === seen && !wait.signal?.aborted) {
      await new Promise<void>(resolve => {
        let timer: ReturnType<typeof setTimeout> | undefined
        const release = () => { clearTimeout(timer); routeWaiters.delete(release); resolve() }
        routeWaiters.add(release)
        wait.signal?.addEventListener('abort', release, { once: true })
        if (wait.timeoutMs !== undefined) timer = setTimeout(release, wait.timeoutMs)
      })
    }
    return routes
  })
  const startTunnel = vi.fn(async (options: CloudflareTunnelOptions) => ({
    url: options.mode === 'named' ? null : 'https://fixture-phone.trycloudflare.com',
    publishedRoutes,
    stop,
    onExit(callback: (exit: CloudflareTunnelExit) => void) { exits.add(callback); return () => { exits.delete(callback) } },
  }))
  // Electron hands out a fresh id per assertion; `held` is what still keeps the computer awake.
  const held = new Set<number>()
  let nextBlockerId = 0
  const blocker = {
    start: vi.fn((_type: 'prevent-app-suspension' | 'prevent-display-sleep') => { const id = ++nextBlockerId; held.add(id); return id }),
    stop: vi.fn((id: number) => held.delete(id)),
  }
  const manager = new PublicAccessManager({ directory, backend: { request: request as never }, startTunnel, powerSaveBlocker: blocker })
  managers.push(manager)
  return { directory, file, request, manager, startTunnel, stop, publishedRoutes, blocker, held,
    verifies() { return request.mock.calls.filter(([route]) => route === '/verify').length },
    reachable(value: boolean | (() => boolean)) { reachable = value }, proxy(value: string | null) { proxyUrl = value },
    routes(value: CloudflareTunnelRoute[] | null) { routes = value; for (const release of [...routeWaiters]) release() },
    exit() { for (const callback of [...exits]) callback({ code: 1, signal: null }) },
  }
}

describe('Cloudflare settings migration', () => {
  it.each([
    { version: 1, authtoken: 'fake-retired-secret', autoStart: true, consentVersion: 2 },
    { version: 3, mode: 'ngrok', authtoken: 'fake-retired-secret', customUrl: '', localPort: 17463, autoStart: true, consentVersion: 2 },
    { version: 3, mode: 'custom', customUrl: 'https://old.example.test', localPort: 18321, autoStart: true, consentVersion: 2 },
    { version: 4, mode: 'tailscale', customUrl: 'https://desktop.fixture.ts.net', localPort: 17463, autoStart: true, consentVersion: 3 },
  ])('migrates the old transport without granting public access and preserves private data: %j', async saved => {
    const original = { ...saved, futureSetting: { enabled: true } }
    const f = fixture(original)
    expect(f.manager.getStatus()).toMatchObject({ state: 'disabled', mode: 'quick', customUrl: '', autoStart: false, consentVersion: 0, migrationRequired: true, tokenSet: false })
    await f.manager.restore()
    expect(f.request).not.toHaveBeenCalled()
    expect(f.startTunnel).not.toHaveBeenCalled()
    expect(JSON.stringify(f.manager.getStatus())).not.toContain('fake-retired-secret')
    const persisted = JSON.parse(readFileSync(f.file, 'utf8'))
    expect(persisted).toMatchObject({ version: 7, futureSetting: { enabled: true }, legacyRemoteConfiguration: original, p2pEnabled: true, keepAwake: true })
    expect(migratePublicAccessSettings(persisted)).toEqual(persisted)
    await expect(f.manager.start(PUBLIC_ACCESS_CONSENT_VERSION - 1)).rejects.toThrow('consent')
    await f.manager.start(PUBLIC_ACCESS_CONSENT_VERSION)
    expect(f.manager.getStatus()).toMatchObject({ state: 'online', migrationRequired: false })
    expect(JSON.parse(readFileSync(f.file, 'utf8')).legacyRemoteConfiguration).toEqual(original)
  })

  it('migrates a new profile into disabled Quick mode and preserves newer unknown fields', () => {
    expect(migratePublicAccessSettings({})).toEqual({ version: 7, ...quick, tunnelToken: '', autoStart: false, consentVersion: 0, migrationRequired: false, p2pEnabled: true, keepAwake: true })
    expect(migratePublicAccessSettings({ ...named, version: 8, future: 7, autoStart: true, consentVersion: 4 })).toMatchObject({ version: 8, future: 7, autoStart: true, consentVersion: 4 })
  })

  it('a version 5 file gains direct connections switched on and keeps everything else', async () => {
    const saved = { ...quick, version: 5, tunnelToken: '', autoStart: true, consentVersion: 4, migrationRequired: false, futureSetting: { kept: true } }
    const f = fixture(saved)
    expect(f.manager.getStatus().p2pEnabled).toBe(true)
    const persisted = JSON.parse(readFileSync(f.file, 'utf8'))
    expect(persisted).toEqual({ ...saved, version: 7, p2pEnabled: true, keepAwake: true })
    // An explicit opt-out survives every later migration.
    expect(migratePublicAccessSettings({ ...persisted, p2pEnabled: false }).p2pEnabled).toBe(false)
  })

  it('a version 6 file migrates to version 7 with keep awake switched on and keeps everything else', async () => {
    // Written by the release that added direct connections, before keep awake existed.
    const saved = { ...quick, version: 6, tunnelToken: '', autoStart: true, consentVersion: PUBLIC_ACCESS_CONSENT_VERSION, migrationRequired: false, p2pEnabled: false, futureSetting: { kept: true } }
    const f = fixture(saved)
    expect(f.manager.getStatus()).toMatchObject({ state: 'disabled', keepAwake: true, p2pEnabled: false, autoStart: true })
    const persisted = JSON.parse(readFileSync(f.file, 'utf8'))
    expect(persisted).toEqual({ ...saved, version: 7, keepAwake: true })
    expect(migratePublicAccessSettings(persisted)).toEqual(persisted)
    // An explicit opt-out survives every later migration.
    expect(migratePublicAccessSettings({ ...persisted, keepAwake: false }).keepAwake).toBe(false)
    await f.manager.restore()
    expect(f.manager.getStatus().state).toBe('online')
    expect(f.held.size).toBe(1)
  })

  it('switching keep awake persists, follows the connection and never touches the tunnel', async () => {
    const f = fixture()
    expect(f.manager.setKeepAwake(false).keepAwake).toBe(false)
    expect(JSON.parse(readFileSync(f.file, 'utf8')).keepAwake).toBe(false)
    await f.manager.start(PUBLIC_ACCESS_CONSENT_VERSION)
    expect(f.blocker.start).not.toHaveBeenCalled()
    f.request.mockClear()
    expect(f.manager.setKeepAwake(true).keepAwake).toBe(true)
    expect(f.blocker.start).toHaveBeenCalledOnce()
    expect(f.blocker.start).toHaveBeenCalledWith('prevent-app-suspension')
    expect(f.manager.setKeepAwake(true).keepAwake).toBe(true)
    expect(f.blocker.start).toHaveBeenCalledOnce()
    expect(f.manager.setKeepAwake(false).keepAwake).toBe(false)
    expect(f.held.size).toBe(0)
    expect(f.request).not.toHaveBeenCalled()
    expect(f.startTunnel).toHaveBeenCalledOnce()
    expect(f.manager.getStatus().state).toBe('online')
  })

  it('switching direct connections persists and notifies without touching the tunnel', async () => {
    const states: Array<boolean | undefined> = []
    const f = fixture()
    const manager = new PublicAccessManager({ directory: f.directory, backend: { request: f.request as never }, startTunnel: f.startTunnel, onState: status => states.push(status.p2pEnabled) })
    managers.push(manager)
    expect(manager.setP2PEnabled(false).p2pEnabled).toBe(false)
    expect(manager.setP2PEnabled(false).p2pEnabled).toBe(false)
    expect(JSON.parse(readFileSync(f.file, 'utf8')).p2pEnabled).toBe(false)
    expect(states).toEqual([false])
    expect(f.request).not.toHaveBeenCalled()
  })

  it('reports connection state changes so the P2P endpoint can follow them', async () => {
    const seen: string[] = []
    const f = fixture()
    const manager = new PublicAccessManager({ directory: f.directory, backend: { request: f.request as never }, startTunnel: f.startTunnel, onState: status => seen.push(status.state) })
    managers.push(manager)
    await manager.start(PUBLIC_ACCESS_CONSENT_VERSION)
    await manager.stop()
    expect(seen).toEqual(['connecting', 'online', 'disabled'])
  })

  it.each(['{broken', { mode: 'unknown' }, { ...quick, version: 5, localPort: null }, { ...named, tunnelToken: 'fake\nsecret' }, { version: 4, mode: 'tailscale', customUrl: 'http://unsafe.test', localPort: 17463 }])('preserves corrupt or invalid saved settings: %j', async saved => {
    const f = fixture(saved)
    const serialized = typeof saved === 'string' ? saved : JSON.stringify(saved)
    await f.manager.restore()
    expect(f.manager.getStatus()).toMatchObject({ state: 'unconfigured', error: 'configuration' })
    await expect(f.manager.start(PUBLIC_ACCESS_CONSENT_VERSION)).rejects.toThrow('Configuration')
    expect(f.request).not.toHaveBeenCalled()
    expect(readFileSync(f.file, 'utf8')).toBe(serialized)
    await f.manager.configure(quick)
    expect(f.manager.getStatus()).toMatchObject({ state: 'disabled', error: null })
  })

  it.each(['{broken', { ...named, version: 5, tunnelToken: 'fake\nsecret' }])('switching direct connections never overwrites invalid saved settings: %j', saved => {
    const f = fixture(saved)
    const serialized = typeof saved === 'string' ? saved : JSON.stringify(saved)
    expect(() => f.manager.setP2PEnabled(false)).toThrow('configuration')
    expect(readFileSync(f.file, 'utf8')).toBe(serialized)
    expect(f.manager.getStatus()).toMatchObject({ state: 'unconfigured', error: 'configuration', p2pEnabled: true })
  })

  it.each(['{broken', { ...named, version: 6, tunnelToken: 'fake\nsecret' }])('switching keep awake never overwrites invalid saved settings: %j', saved => {
    const f = fixture(saved)
    const serialized = typeof saved === 'string' ? saved : JSON.stringify(saved)
    expect(() => f.manager.setKeepAwake(false)).toThrow('configuration')
    expect(readFileSync(f.file, 'utf8')).toBe(serialized)
    expect(f.manager.getStatus()).toMatchObject({ state: 'unconfigured', error: 'configuration', keepAwake: true })
  })

  it.each(['{broken', { ...named, version: 5, tunnelToken: 'fake\nsecret' }])('switching auto start never overwrites invalid saved settings: %j', saved => {
    const f = fixture(saved)
    const serialized = typeof saved === 'string' ? saved : JSON.stringify(saved)
    expect(() => f.manager.setAutoStart(true)).toThrow('configuration')
    expect(readFileSync(f.file, 'utf8')).toBe(serialized)
    expect(f.manager.getStatus()).toMatchObject({ state: 'unconfigured', error: 'configuration' })
  })
})

describe('Cloudflare gateway lifecycle', () => {
  it('starts Quick without manual configuration and marks online only after verification', async () => {
    const f = fixture()
    await f.manager.restore()
    expect(f.request).not.toHaveBeenCalled()
    const results = await Promise.all([f.manager.start(PUBLIC_ACCESS_CONSENT_VERSION), f.manager.start(PUBLIC_ACCESS_CONSENT_VERSION)])
    expect(results[0]).toEqual(results[1])
    expect(f.startTunnel).toHaveBeenCalledTimes(1)
    expect(f.startTunnel.mock.calls[0]![0]).toMatchObject({ mode: 'quick', localPort: 17463 })
    expect(f.request.mock.calls.map(([route]) => route)).toEqual(['/enable', '/network', '/origin', '/verify'])
    expect(f.request).toHaveBeenCalledWith('/enable', 'POST', { port: 17463 })
    expect(f.request).toHaveBeenCalledWith('/origin', 'PUT', { publicUrl: 'https://fixture-phone.trycloudflare.com' })
    expect(f.manager.getStatus()).toMatchObject({ state: 'online', phase: null, publicUrl: 'https://fixture-phone.trycloudflare.com' })
    await f.manager.start(PUBLIC_ACCESS_CONSENT_VERSION)
    expect(f.startTunnel).toHaveBeenCalledTimes(1)
  })

  it('keeps the named token private, retains it on an empty save, and restores only opted-in access', async () => {
    const f = fixture()
    f.routes([gatewayRoute])
    await f.manager.configure({ ...named, customUrl: 'https://PHONE.example.test/' })
    await f.manager.start(PUBLIC_ACCESS_CONSENT_VERSION)
    expect(f.startTunnel.mock.calls[0]![0]).toMatchObject({ mode: 'named', token: fakeToken })
    expect(f.manager.getStatus()).toMatchObject({ mode: 'named', tokenSet: true, publicUrl: named.customUrl })
    expect(JSON.stringify(f.manager.getStatus())).not.toContain(fakeToken)
    expect(JSON.stringify(f.manager.getStatus())).not.toContain('tunnelToken')
    if (process.platform !== 'win32') expect(statSync(f.file).mode & 0o777).toBe(0o600)
    await f.manager.configure({ ...named, tunnelToken: '' })
    expect(f.manager.getStatus().state).toBe('online')
    f.manager.setAutoStart(true)
    await f.manager.stop()
    const restored = new PublicAccessManager({ directory: f.directory, backend: { request: f.request as never }, startTunnel: f.startTunnel })
    managers.push(restored)
    await restored.restore()
    expect(restored.getStatus().state).toBe('online')
    await restored.configure({ ...named, customUrl: 'https://second.example.test', tunnelToken: '' })
    expect(restored.getStatus()).toMatchObject({ state: 'disabled', consentVersion: 0 })
    f.startTunnel.mockClear()
    await restored.restore()
    expect(f.startTunnel).not.toHaveBeenCalled()
  })

  it('rejects malformed configuration before disturbing an active connection', async () => {
    const f = fixture()
    await f.manager.start(PUBLIC_ACCESS_CONSENT_VERSION)
    f.request.mockClear()
    for (const patch of [{ mode: 'tailscale' }, { mode: 'ngrok' }, { localHost: '0.0.0.0' }, { customUrl: 'https://wrong.example.test' }, { localPort: 80 }]) await expect(f.manager.configure({ ...quick, ...patch } as never)).rejects.toThrow('configuration')
    expect(f.request).not.toHaveBeenCalled()
    expect(f.manager.getStatus().state).toBe('online')
  })

  it('passes the saved network proxy to the connector without exposing it in status', async () => {
    const f = fixture()
    const proxy = 'http://fixture:fake-password@127.0.0.1:8888'
    f.proxy(proxy)
    await f.manager.start(PUBLIC_ACCESS_CONSENT_VERSION)
    expect(f.startTunnel.mock.calls[0]![0].proxyUrl).toBe(proxy)
    expect(JSON.stringify(f.manager.getStatus())).not.toContain('fake-password')
  })

  it('never advertises an unverified hostname and retries recoverable network failures', async () => {
    vi.useFakeTimers()
    const f = fixture()
    f.reachable(false)
    const started = f.manager.start(PUBLIC_ACCESS_CONSENT_VERSION)
    await advance(0)
    expect(f.manager.getStatus()).toMatchObject({ state: 'connecting', phase: 'checking', publicUrl: null })
    await exhaustVerification()
    await started
    expect(f.manager.getStatus()).toMatchObject({ state: 'reconnecting', error: 'network', publicUrl: null })
    expect(f.stop).toHaveBeenCalledTimes(1)
    expect(f.verifies()).toBe(5)
    f.reachable(true)
    await advance(1000)
    expect(f.manager.getStatus()).toMatchObject({ state: 'online', error: null })
    await f.manager.stop()
    await advance(60000)
    expect(f.startTunnel).toHaveBeenCalledTimes(2)
  })

  it('names the saved tunnel without exposing its credential', async () => {
    const f = fixture()
    expect(f.manager.getStatus().tunnelId).toBeNull()
    await f.manager.configure({ ...named, tunnelToken: credential })
    expect(f.manager.getStatus()).toMatchObject({ tokenSet: true, tunnelId })
    expect(JSON.stringify(f.manager.getStatus())).not.toContain(credential)
    await f.manager.configure({ ...named, tunnelToken: fakeToken })
    expect(f.manager.getStatus()).toMatchObject({ tokenSet: true, tunnelId: null })
  })

  it('reports a token Cloudflare refuses and does not retry it as a network outage', async () => {
    vi.useFakeTimers()
    const f = fixture()
    await f.manager.configure(named)
    f.startTunnel.mockRejectedValueOnce(new CloudflareTunnelError('token', 'fixture refusal'))
    await f.manager.start(PUBLIC_ACCESS_CONSENT_VERSION)
    expect(f.manager.getStatus()).toMatchObject({ state: 'failed', error: 'token', publicUrl: null })
    expect(f.request).toHaveBeenLastCalledWith('/disable', 'POST')
    await advance(60000)
    expect(f.startTunnel).toHaveBeenCalledTimes(1)
  })

  it('enables a fixed domain with only a token and keeps the connector registered until Cloudflare routes a hostname to it', async () => {
    vi.useFakeTimers()
    const f = fixture()
    await f.manager.configure(tokenOnly)
    expect(f.manager.getStatus()).toMatchObject({ state: 'disabled', tokenSet: true, customUrl: '' })
    f.request.mockClear()
    const started = f.manager.start(PUBLIC_ACCESS_CONSENT_VERSION)
    await advance(0)
    await advance(5000)
    // The setup wizard needs a live connector before it offers the route step, so start returns while waiting.
    expect(await started).toMatchObject({ state: 'connecting', phase: 'routing', error: null, publicUrl: null })
    expect(f.request.mock.calls.map(([route]) => route)).toEqual(['/enable', '/network'])
    await advance(10 * 60_000)
    expect(f.manager.getStatus()).toMatchObject({ state: 'connecting', phase: 'routing' })
    expect(f.stop).not.toHaveBeenCalled()
    f.routes([{ hostname: 'blog.example.test', service: 'http://127.0.0.1:2368' }, { service: 'http_status:404' }])
    await advance(0)
    expect(f.manager.getStatus()).toMatchObject({ state: 'connecting', phase: 'routing', error: 'route' })
    f.routes([{ hostname: 'blog.example.test', service: 'http://127.0.0.1:2368' }, { hostname: 'Phone.Example.test', service: 'http://localhost:17463' }, { service: 'http_status:404' }])
    await advance(0)
    expect(f.manager.getStatus()).toMatchObject({ state: 'online', phase: null, error: null, publicUrl: 'https://phone.example.test' })
    expect(f.request).toHaveBeenCalledWith('/origin', 'PUT', { publicUrl: 'https://phone.example.test' })
    expect(f.startTunnel).toHaveBeenCalledTimes(1)
    expect(f.stop).not.toHaveBeenCalled()
  })

  it('stops waiting for a route and closes the connector when the connection is turned off', async () => {
    vi.useFakeTimers()
    const f = fixture()
    await f.manager.configure(tokenOnly)
    const started = f.manager.start(PUBLIC_ACCESS_CONSENT_VERSION)
    await advance(0)
    await advance(5000)
    await started
    const signal = f.startTunnel.mock.calls[0]![0].signal!
    await f.manager.stop()
    expect(signal.aborted).toBe(true)
    expect(f.stop).toHaveBeenCalledTimes(1)
    expect(f.manager.getStatus()).toMatchObject({ state: 'disabled', phase: null, error: null, publicUrl: null })
    f.routes([gatewayRoute])
    await advance(60_000)
    expect(f.request.mock.calls.some(([route]) => route === '/origin')).toBe(false)
    expect(f.startTunnel).toHaveBeenCalledTimes(1)
  })

  it('keeps retrying an unreachable fixed domain whose route already reaches this gateway', async () => {
    vi.useFakeTimers()
    const f = fixture()
    await f.manager.configure(named)
    f.reachable(false)
    f.routes([{ hostname: 'phone.example.test', service: 'http://localhost:17463' }])
    const started = f.manager.start(PUBLIC_ACCESS_CONSENT_VERSION)
    await advance(0)
    await exhaustVerification()
    await started
    expect(f.manager.getStatus()).toMatchObject({ state: 'reconnecting', error: 'network' })
    f.reachable(true)
    await advance(1000)
    expect(f.manager.getStatus()).toMatchObject({ state: 'online', error: null })
  })

  it('fails a fixed-port mismatch without launching a connector', async () => {
    const f = fixture()
    f.request.mockResolvedValueOnce({ port: 32123 })
    await f.manager.start(PUBLIC_ACCESS_CONSENT_VERSION)
    expect(f.manager.getStatus()).toMatchObject({ state: 'failed', error: 'configuration' })
    expect(f.startTunnel).not.toHaveBeenCalled()
    expect(f.request).toHaveBeenLastCalledWith('/disable', 'POST')
  })

  it('reports missing runtime separately and never retries it as a network outage', async () => {
    vi.useFakeTimers()
    const f = fixture()
    f.startTunnel.mockRejectedValueOnce(new CloudflareTunnelError('runtime', 'fixture unavailable'))
    await f.manager.start(PUBLIC_ACCESS_CONSENT_VERSION)
    expect(f.manager.getStatus()).toMatchObject({ state: 'failed', error: 'runtime' })
    await advance(60000)
    expect(f.startTunnel).toHaveBeenCalledTimes(1)
  })

  it.each(['stop', 'dispose'] as const)('cancels a pending connector and discards a late result after %s', async action => {
    const f = fixture()
    let finish!: (value: Awaited<ReturnType<typeof f.startTunnel>>) => void
    let entered!: () => void
    const entering = new Promise<void>(resolve => { entered = resolve })
    f.startTunnel.mockImplementationOnce(async () => { entered(); return await new Promise(resolve => { finish = resolve }) })
    const connecting = f.manager.start(PUBLIC_ACCESS_CONSENT_VERSION)
    await entering
    const signal = f.startTunnel.mock.calls[0]![0].signal!
    const stopping = f.manager[action]()
    expect(signal.aborted).toBe(true)
    finish({ url: 'https://late.trycloudflare.com', stop: f.stop, publishedRoutes: f.publishedRoutes, onExit: () => () => {} })
    await Promise.all([connecting, stopping])
    expect(f.stop).toHaveBeenCalled()
    expect(f.manager.getStatus()).toMatchObject({ state: 'disabled', publicUrl: null })
    expect(f.request.mock.calls.some(([route]) => route === '/origin')).toBe(false)
  })

  it('waits for aborted startup cleanup before disposal completes', async () => {
    const f = fixture()
    let entered!: () => void
    let aborted!: () => void
    let finishCleanup!: () => void
    const entering = new Promise<void>(resolve => { entered = resolve })
    const aborting = new Promise<void>(resolve => { aborted = resolve })
    const cleanup = new Promise<void>(resolve => { finishCleanup = resolve })
    f.startTunnel.mockImplementationOnce(async options => {
      entered()
      await new Promise<void>(resolve => options.signal!.addEventListener('abort', () => { aborted(); resolve() }, { once: true }))
      await cleanup
      const error = new Error('Fixture connector cancelled')
      error.name = 'AbortError'
      throw error
    })
    const connecting = f.manager.start(PUBLIC_ACCESS_CONSENT_VERSION)
    await entering
    let disposed = false
    const disposing = f.manager.dispose().then(() => { disposed = true })
    await aborting
    for (let index = 0; index < 30; index++) await Promise.resolve()
    const disposedBeforeCleanup = disposed
    finishCleanup()
    await Promise.all([connecting, disposing])
    expect(disposedBeforeCleanup).toBe(false)
    expect(disposed).toBe(true)
    expect(f.manager.getStatus()).toMatchObject({ state: 'disabled', error: null, publicUrl: null })
    expect(f.request).toHaveBeenCalledWith('/disable', 'POST')
  })

  it('waits for a late connector to close before disposal completes', async () => {
    const f = fixture()
    let entered!: () => void
    let finishStartup!: (value: Awaited<ReturnType<typeof f.startTunnel>>) => void
    let closing!: () => void
    let finishShutdown!: () => void
    const entering = new Promise<void>(resolve => { entered = resolve })
    const closeStarted = new Promise<void>(resolve => { closing = resolve })
    const shutdown = new Promise<void>(resolve => { finishShutdown = resolve })
    f.startTunnel.mockImplementationOnce(async () => { entered(); return await new Promise(resolve => { finishStartup = resolve }) })
    f.stop.mockImplementationOnce(async () => { closing(); await shutdown })
    const connecting = f.manager.start(PUBLIC_ACCESS_CONSENT_VERSION)
    await entering
    let disposed = false
    const disposing = f.manager.dispose().then(() => { disposed = true })
    finishStartup({ url: 'https://late.trycloudflare.com', stop: f.stop, publishedRoutes: f.publishedRoutes, onExit: () => () => {} })
    await closeStarted
    for (let index = 0; index < 30; index++) await Promise.resolve()
    const disposedBeforeShutdown = disposed
    finishShutdown()
    await Promise.all([connecting, disposing])
    expect(disposedBeforeShutdown).toBe(false)
    expect(disposed).toBe(true)
    expect(f.stop).toHaveBeenCalledOnce()
    expect(f.manager.getStatus()).toMatchObject({ state: 'disabled', publicUrl: null })
  })

  it('reconnects after an unexpected process exit and honors an explicit stop', async () => {
    vi.useFakeTimers()
    const f = fixture()
    await f.manager.start(PUBLIC_ACCESS_CONSENT_VERSION)
    f.exit()
    await advance(0)
    expect(f.manager.getStatus().state).toBe('reconnecting')
    await advance(1000)
    expect(f.manager.getStatus().state).toBe('online')
    expect(f.startTunnel).toHaveBeenCalledTimes(2)
    await f.manager.stop()
    f.exit()
    await advance(60000)
    expect(f.startTunnel).toHaveBeenCalledTimes(2)
  })

  it('a recovery restart keeps phone streams resumable; an explicit stop ends them', async () => {
    vi.useFakeTimers()
    const f = fixture()
    await f.manager.start(PUBLIC_ACCESS_CONSENT_VERSION)
    f.exit()
    await advance(0)
    expect(f.request.mock.calls.filter(([route]) => route === '/disable')).toEqual([['/disable', 'POST', { reason: 'restart' }]])
    await advance(1000)
    f.request.mockClear()
    // A sidecar restart keeps the tunnel: nothing ends phone streams, and the new
    // gateway is opened without closing anything first.
    await f.manager.serverUnavailable()
    await f.manager.serverChanged()
    expect(f.request.mock.calls.some(([route]) => route === '/disable')).toBe(false)
    expect(f.manager.getStatus().state).toBe('online')
    f.request.mockClear()
    await f.manager.stop()
    expect(f.request).toHaveBeenLastCalledWith('/disable', 'POST')
  })

  it('a failed automatic retry keeps phone streams resumable while it keeps retrying', async () => {
    vi.useFakeTimers()
    const f = fixture()
    await f.manager.start(PUBLIC_ACCESS_CONSENT_VERSION)
    f.request.mockClear()
    // cloudflared exits and the network is still down on the first retry.
    f.reachable(false)
    f.exit()
    await advance(0)
    await advance(1000)
    await exhaustVerification()
    expect(f.manager.getStatus()).toMatchObject({ state: 'reconnecting', error: 'network' })
    const disables = f.request.mock.calls.filter(([route]) => route === '/disable')
    expect(disables).toEqual([['/disable', 'POST', { reason: 'restart' }], ['/disable', 'POST', { reason: 'restart' }]])
    f.reachable(true)
    await advance(2000)
    expect(f.manager.getStatus().state).toBe('online')
  })

  it('a failure that will not be retried ends phone streams', async () => {
    const f = fixture()
    // The gateway came up on another port: a configuration problem, not a network blip.
    f.request.mockImplementation(async (route: string) => route === '/enable' ? { port: 17464 } : {})
    await f.manager.start(PUBLIC_ACCESS_CONSENT_VERSION)
    expect(f.manager.getStatus()).toMatchObject({ state: 'failed', error: 'configuration' })
    expect(f.request).toHaveBeenLastCalledWith('/disable', 'POST')
  })

  it('a tunnel recovery stays reconnecting until it is back online, without passing through disabled or failed', async () => {
    vi.useFakeTimers()
    const f = fixture()
    const states: string[] = []
    const manager = new PublicAccessManager({ directory: f.directory, backend: { request: f.request as never }, startTunnel: f.startTunnel, onState: status => states.push(status.state) })
    managers.push(manager)
    await manager.start(PUBLIC_ACCESS_CONSENT_VERSION)
    f.reachable(false)
    f.exit()
    await advance(0)
    await advance(1000)
    await exhaustVerification()
    f.reachable(true)
    await advance(2000)
    expect(manager.getStatus().state).toBe('online')
    expect(states).toEqual(['connecting', 'online', 'reconnecting', 'online'])
    states.length = 0
    await manager.serverUnavailable()
    expect(states).toEqual(['reconnecting'])
  })

  it('waits for cancelled startup cleanup before honoring a new enable request', async () => {
    const f = fixture()
    let finish!: (value: Awaited<ReturnType<typeof f.startTunnel>>) => void
    let entered!: () => void
    const entering = new Promise<void>(resolve => { entered = resolve })
    f.startTunnel.mockImplementationOnce(async () => { entered(); return await new Promise(resolve => { finish = resolve }) })
    const first = f.manager.start(PUBLIC_ACCESS_CONSENT_VERSION)
    await entering
    await f.manager.stop()
    const second = f.manager.start(PUBLIC_ACCESS_CONSENT_VERSION)
    expect(f.startTunnel).toHaveBeenCalledTimes(1)
    finish({ url: 'https://cancelled.trycloudflare.com', stop: f.stop, publishedRoutes: f.publishedRoutes, onExit: () => () => {} })
    await Promise.all([first, second])
    expect(f.stop).toHaveBeenCalledTimes(1)
    expect(f.startTunnel).toHaveBeenCalledTimes(2)
    expect(f.manager.getStatus().state).toBe('online')
  })

  it('closes the gateway even when connector shutdown fails and blocks another launch', async () => {
    const f = fixture()
    await f.manager.start(PUBLIC_ACCESS_CONSENT_VERSION)
    f.stop.mockRejectedValueOnce(new Error('fixture process did not exit'))
    await f.manager.stop()
    expect(f.request).toHaveBeenLastCalledWith('/disable', 'POST')
    expect(f.manager.getStatus()).toMatchObject({ state: 'failed', error: 'stop' })
    await expect(f.manager.start(PUBLIC_ACCESS_CONSENT_VERSION)).rejects.toThrow('stop')
    await f.manager.stop()
    expect(f.stop).toHaveBeenCalledTimes(2)
    expect(f.manager.getStatus()).toMatchObject({ state: 'disabled', error: null })
  })

  it('cannot clear the stop error while a retained connector still refuses to exit', async () => {
    const f = fixture()
    await f.manager.start(PUBLIC_ACCESS_CONSENT_VERSION)
    f.stop.mockRejectedValueOnce(new Error('fixture still alive')).mockRejectedValueOnce(new Error('fixture still alive'))
    await f.manager.stop()
    await f.manager.stop()
    expect(f.stop).toHaveBeenCalledTimes(2)
    expect(f.manager.getStatus()).toMatchObject({ state: 'failed', error: 'stop' })
    await expect(f.manager.start(PUBLIC_ACCESS_CONSENT_VERSION)).rejects.toThrow('stop')
    await f.manager.stop()
    expect(f.stop).toHaveBeenCalledTimes(3)
    expect(f.manager.getStatus().state).toBe('disabled')
  })

  it('retains failed startup cleanup and blocks new launches until its child exits', async () => {
    const f = fixture()
    const retryStop = vi.fn(async () => {})
    f.startTunnel.mockRejectedValueOnce(new CloudflareTunnelError('runtime', 'fixture shutdown unconfirmed', retryStop))
    await f.manager.start(PUBLIC_ACCESS_CONSENT_VERSION)
    expect(f.manager.getStatus()).toMatchObject({ state: 'failed', error: 'stop' })
    await expect(f.manager.start(PUBLIC_ACCESS_CONSENT_VERSION)).rejects.toThrow('stop')
    await f.manager.stop()
    expect(retryStop).toHaveBeenCalledOnce()
    expect(f.manager.getStatus().state).toBe('disabled')
  })

  it('restores the tunnel after a sidecar restart without reviving an explicitly stopped connection', async () => {
    const f = fixture()
    await f.manager.start(PUBLIC_ACCESS_CONSENT_VERSION)
    await f.manager.serverUnavailable()
    // Turned off while the sidecar is away: the gateway is already gone with it.
    f.request.mockRejectedValueOnce(new Error('Server unavailable'))
    await f.manager.stop()
    expect(f.stop).toHaveBeenCalledOnce()
    expect(f.manager.getStatus()).toMatchObject({ state: 'failed', error: 'stop' })
    // The new sidecar confirms its gateway is closed and nothing is revived.
    await f.manager.serverChanged()
    expect(f.manager.getStatus()).toMatchObject({ state: 'disabled', error: null })
    expect(f.request).toHaveBeenLastCalledWith('/disable', 'POST')
    await f.manager.serverChanged()
    expect(f.manager.getStatus().state).toBe('disabled')
    expect(f.startTunnel).toHaveBeenCalledOnce()
  })

  it('a sidecar that is not connected yet still rebuilds the connection once it is back', async () => {
    const f = fixture()
    let finish!: (value: Awaited<ReturnType<typeof f.startTunnel>>) => void
    let entered!: () => void
    const entering = new Promise<void>(resolve => { entered = resolve })
    f.startTunnel.mockImplementationOnce(async () => { entered(); return await new Promise(resolve => { finish = resolve }) })
    const connecting = f.manager.start(PUBLIC_ACCESS_CONSENT_VERSION)
    await entering
    // Nothing verified yet, so there is no address worth keeping.
    f.request.mockRejectedValueOnce(new Error('Server unavailable'))
    const unavailable = f.manager.serverUnavailable()
    finish({ url: 'https://late.trycloudflare.com', stop: f.stop, publishedRoutes: f.publishedRoutes, onExit: () => () => {} })
    await Promise.all([connecting, unavailable])
    expect(f.manager.getStatus()).toMatchObject({ state: 'failed', error: 'stop' })
    await f.manager.serverChanged()
    expect(f.manager.getStatus()).toMatchObject({ state: 'online', publicUrl: quickUrl })
    expect(f.startTunnel).toHaveBeenCalledTimes(2)
  })
})

describe('Keeping the public address', () => {
  it('waits for a fresh hostname with spaced checks instead of rebuilding the tunnel under a new address', async () => {
    vi.useFakeTimers()
    const f = fixture()
    f.reachable(false)
    const started = f.manager.start(PUBLIC_ACCESS_CONSENT_VERSION)
    await advance(0)
    expect(f.verifies()).toBe(1)
    await advance(1_999)
    expect(f.verifies()).toBe(1)
    await advance(1)
    await advance(4_000)
    expect(f.verifies()).toBe(3)
    expect(f.stop).not.toHaveBeenCalled()
    expect(f.manager.getStatus()).toMatchObject({ state: 'connecting', phase: 'checking', publicUrl: null })
    // Cloudflare's edge starts answering for the new hostname.
    f.reachable(true)
    await advance(8_000)
    expect(await started).toMatchObject({ state: 'online', publicUrl: quickUrl, error: null })
    expect(f.verifies()).toBe(4)
    expect(f.startTunnel).toHaveBeenCalledOnce()
    expect(f.stop).not.toHaveBeenCalled()
  })

  it('cancels the spaced checks on stop without leaving a timer behind', async () => {
    vi.useFakeTimers()
    const f = fixture()
    f.reachable(false)
    const started = f.manager.start(PUBLIC_ACCESS_CONSENT_VERSION)
    await advance(0)
    await advance(2_000)
    expect(f.verifies()).toBe(2)
    expect(vi.getTimerCount()).toBe(1)
    await f.manager.stop()
    await started
    expect(vi.getTimerCount()).toBe(0)
    await advance(60_000)
    expect(f.verifies()).toBe(2)
    expect(f.startTunnel).toHaveBeenCalledOnce()
    expect(f.manager.getStatus()).toMatchObject({ state: 'disabled', publicUrl: null })
  })

  it.each([
    ['quick', quickUrl],
    ['named', named.customUrl],
  ] as const)('a sidecar restart keeps the %s tunnel and re-attaches the new gateway to the same address', async (mode, publicUrl) => {
    const f = fixture()
    if (mode === 'named') {
      f.routes([gatewayRoute])
      await f.manager.configure(named)
    }
    await f.manager.start(PUBLIC_ACCESS_CONSENT_VERSION)
    expect(f.manager.getStatus()).toMatchObject({ state: 'online', publicUrl })
    f.request.mockClear()
    await f.manager.serverUnavailable()
    expect(f.manager.getStatus()).toMatchObject({ state: 'reconnecting', publicUrl: null, error: null })
    // The old gateway went down with its sidecar; cloudflared keeps running.
    expect(f.stop).not.toHaveBeenCalled()
    expect(f.request).not.toHaveBeenCalled()
    await f.manager.serverChanged()
    expect(f.request.mock.calls).toEqual([
      ['/enable', 'POST', { port: 17463 }],
      ['/origin', 'PUT', { publicUrl }],
      ['/verify', 'POST'],
    ])
    expect(f.manager.getStatus()).toMatchObject({ state: 'online', publicUrl, phase: null, error: null })
    expect(f.startTunnel).toHaveBeenCalledOnce()
    expect(f.stop).not.toHaveBeenCalled()
  })

  it('a start request while the tunnel waits for the next sidecar launches no second connector', async () => {
    const f = fixture()
    await f.manager.start(PUBLIC_ACCESS_CONSENT_VERSION)
    await f.manager.serverUnavailable()
    expect(await f.manager.start(PUBLIC_ACCESS_CONSENT_VERSION)).toMatchObject({ state: 'reconnecting' })
    expect(f.startTunnel).toHaveBeenCalledOnce()
    await f.manager.serverChanged()
    expect(f.manager.getStatus()).toMatchObject({ state: 'online', publicUrl: quickUrl })
    expect(f.startTunnel).toHaveBeenCalledOnce()
  })

  it('rebuilds the tunnel when the new sidecar opens its gateway on another port', async () => {
    const f = fixture()
    await f.manager.start(PUBLIC_ACCESS_CONSENT_VERSION)
    await f.manager.serverUnavailable()
    f.request.mockClear()
    f.request.mockResolvedValueOnce({ port: 32123 })
    await f.manager.serverChanged()
    // Re-attaching is tried first; only its failure stops the kept connector.
    expect(f.request.mock.calls[0]).toEqual(['/enable', 'POST', { port: 17463 }])
    expect(f.request.mock.calls[1]![0]).toBe('/disable')
    expect(f.stop).toHaveBeenCalledOnce()
    expect(f.startTunnel).toHaveBeenCalledTimes(2)
    // The rebuild keeps phone streams resumable.
    expect(f.request.mock.calls.filter(([route]) => route === '/disable')).toEqual([['/disable', 'POST', { reason: 'restart' }]])
    expect(f.manager.getStatus()).toMatchObject({ state: 'online', publicUrl: quickUrl })
  })

  it('rebuilds the tunnel when the kept address no longer reaches the new gateway', async () => {
    vi.useFakeTimers()
    const f = fixture()
    const started = f.manager.start(PUBLIC_ACCESS_CONSENT_VERSION)
    await advance(0)
    await started
    await f.manager.serverUnavailable()
    // Every patient check of the kept address fails; the rebuilt tunnel answers at once.
    let checks = 0
    f.reachable(() => ++checks > 5)
    f.request.mockClear()
    const changed = f.manager.serverChanged()
    await advance(0)
    expect(f.manager.getStatus()).toMatchObject({ state: 'reconnecting', phase: 'checking' })
    expect(f.request.mock.calls.map(([route]) => route)).toEqual(['/enable', '/origin', '/verify'])
    await advance(2_000)
    await advance(4_000)
    await advance(8_000)
    expect(f.stop).not.toHaveBeenCalled()
    await advance(15_000)
    await changed
    expect(checks).toBe(6)
    expect(f.stop).toHaveBeenCalledOnce()
    expect(f.startTunnel).toHaveBeenCalledTimes(2)
    expect(f.request.mock.calls.filter(([route]) => route === '/disable')).toEqual([['/disable', 'POST', { reason: 'restart' }]])
    expect(f.manager.getStatus()).toMatchObject({ state: 'online', publicUrl: quickUrl })
  })

  it('a stop during re-attach wins and nothing is rebuilt', async () => {
    vi.useFakeTimers()
    const f = fixture()
    const started = f.manager.start(PUBLIC_ACCESS_CONSENT_VERSION)
    await advance(0)
    await started
    await f.manager.serverUnavailable()
    f.reachable(false)
    const changed = f.manager.serverChanged()
    await advance(0)
    await advance(2_000)
    await f.manager.stop()
    await changed
    expect(vi.getTimerCount()).toBe(0)
    await advance(60_000)
    expect(f.stop).toHaveBeenCalledOnce()
    expect(f.startTunnel).toHaveBeenCalledOnce()
    expect(f.manager.getStatus()).toMatchObject({ state: 'disabled', publicUrl: null })
  })

  it('a sidecar that leaves again during re-attach keeps the tunnel for the next one', async () => {
    const f = fixture()
    await f.manager.start(PUBLIC_ACCESS_CONSENT_VERSION)
    await f.manager.serverUnavailable()
    let answer!: (value: unknown) => void
    f.request.mockImplementationOnce(() => new Promise(resolve => { answer = resolve }))
    const changed = f.manager.serverChanged()
    await f.manager.serverUnavailable()
    answer({ port: 17463 })
    await changed
    expect(f.manager.getStatus()).toMatchObject({ state: 'reconnecting', publicUrl: null })
    expect(f.stop).not.toHaveBeenCalled()
    await f.manager.serverChanged()
    expect(f.manager.getStatus()).toMatchObject({ state: 'online', publicUrl: quickUrl })
    expect(f.startTunnel).toHaveBeenCalledOnce()
  })

  it('a cloudflared exit while the sidecar is away is rebuilt once the sidecar is back', async () => {
    vi.useFakeTimers()
    const f = fixture()
    const started = f.manager.start(PUBLIC_ACCESS_CONSENT_VERSION)
    await advance(0)
    await started
    await f.manager.serverUnavailable()
    // No sidecar can confirm the gateway closed, so nothing launches until one can.
    f.request.mockRejectedValueOnce(new Error('Server unavailable'))
    f.exit()
    await advance(0)
    expect(f.stop).toHaveBeenCalledOnce()
    expect(f.manager.getStatus()).toMatchObject({ state: 'failed', error: 'stop' })
    await advance(60_000)
    expect(f.startTunnel).toHaveBeenCalledOnce()
    const changed = f.manager.serverChanged()
    await advance(0)
    await changed
    expect(f.manager.getStatus()).toMatchObject({ state: 'online', publicUrl: quickUrl })
    expect(f.startTunnel).toHaveBeenCalledTimes(2)
  })
})

describe('Keeping the computer awake', () => {
  it('holds one sleep assertion while remote access is wanted, across a sidecar restart, and releases it on stop', async () => {
    const f = fixture()
    expect(f.blocker.start).not.toHaveBeenCalled()
    await f.manager.start(PUBLIC_ACCESS_CONSENT_VERSION)
    expect(f.blocker.start).toHaveBeenCalledOnce()
    expect(f.blocker.start).toHaveBeenCalledWith('prevent-app-suspension')
    await f.manager.serverUnavailable()
    await f.manager.serverChanged()
    expect(f.manager.getStatus().state).toBe('online')
    expect(f.blocker.start).toHaveBeenCalledOnce()
    expect(f.held.size).toBe(1)
    await f.manager.stop()
    expect(f.held.size).toBe(0)
    expect(f.blocker.stop).toHaveBeenCalledOnce()
    await f.manager.start(PUBLIC_ACCESS_CONSENT_VERSION)
    expect(f.held.size).toBe(1)
    expect(f.blocker.start).toHaveBeenCalledTimes(2)
  })

  it('keeps holding while a network failure is retried and releases a final failure', async () => {
    vi.useFakeTimers()
    const f = fixture()
    f.reachable(false)
    const started = f.manager.start(PUBLIC_ACCESS_CONSENT_VERSION)
    await advance(0)
    await exhaustVerification()
    await started
    expect(f.manager.getStatus().state).toBe('reconnecting')
    expect(f.held.size).toBe(1)
    await f.manager.stop()
    expect(f.held.size).toBe(0)
    f.startTunnel.mockRejectedValueOnce(new CloudflareTunnelError('runtime', 'fixture unavailable'))
    await f.manager.start(PUBLIC_ACCESS_CONSENT_VERSION)
    expect(f.manager.getStatus()).toMatchObject({ state: 'failed', error: 'runtime' })
    expect(f.held.size).toBe(0)
    expect(f.blocker.start).toHaveBeenCalledTimes(2)
  })

  it('releases the assertion on dispose', async () => {
    const f = fixture()
    await f.manager.start(PUBLIC_ACCESS_CONSENT_VERSION)
    expect(f.held.size).toBe(1)
    await f.manager.dispose()
    expect(f.held.size).toBe(0)
    expect(f.blocker.start).toHaveBeenCalledOnce()
  })
})

it('classifies actionable failures without using provider messages as UI content', () => {
  expect(classifyPublicAccessError(new CloudflareTunnelError('proxy', 'fake'))).toBe('proxy')
  expect(classifyPublicAccessError(new CloudflareTunnelError('token', 'fake'))).toBe('token')
  expect(classifyPublicAccessError(new CloudflareTunnelError('route', 'fake'))).toBe('route')
  expect(classifyPublicAccessError(new Error('EADDRINUSE'))).toBe('configuration')
  expect(classifyPublicAccessError(new Error('connection refused'))).toBe('network')
})

it('preserves the controlled proxy error across the loopback host boundary without raw errors', async () => {
  const response = Response.json({ code: 'proxy', error: 'fake-user:fake-secret@proxy.invalid' }, { status: 503 })
  const error = await readPublicAccessControlResponse(response).catch(value => value)
  expect(classifyPublicAccessError(error)).toBe('proxy')
  expect(String(error)).not.toContain('fake-secret')
  expect(await readPublicAccessControlResponse(Response.json({ ok: true }))).toEqual({ ok: true })
})
