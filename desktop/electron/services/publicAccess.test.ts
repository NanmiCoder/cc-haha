import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { PublicAccessManager, PUBLIC_ACCESS_CONSENT_VERSION, classifyPublicAccessError, migratePublicAccessSettings, readPublicAccessControlResponse } from './publicAccess'
import { CloudflareTunnelError, type CloudflareTunnelExit, type CloudflareTunnelOptions } from './cloudflareTunnel'

const directories: string[] = []
const managers: PublicAccessManager[] = []
const quick = { mode: 'quick' as const, customUrl: '', localPort: 17463 }
const fakeToken = 'eyJhIjoiZmFrZS1maXh0dXJlLXRva2VuIiwicyI6ImZha2UifQ=='
const named = { mode: 'named' as const, customUrl: 'https://phone.example.test', localPort: 17463, tunnelToken: fakeToken }

afterEach(async () => {
  await Promise.all(managers.splice(0).map(manager => manager.dispose()))
  directories.splice(0).forEach(directory => rmSync(directory, { recursive: true, force: true }))
  vi.useRealTimers()
})

async function advance(milliseconds: number) {
  vi.advanceTimersByTime(milliseconds)
  for (let index = 0; index < 30; index++) await Promise.resolve()
}

function fixture(saved?: unknown) {
  const directory = mkdtempSync(path.join(tmpdir(), 'cloudflare-host-test-'))
  directories.push(directory)
  const file = path.join(directory, 'public-access-private.json')
  if (saved !== undefined) writeFileSync(file, typeof saved === 'string' ? saved : JSON.stringify(saved))
  let reachable = true
  let proxyUrl: string | null = null
  const request = vi.fn(async (route: string, _method?: string, body?: unknown): Promise<unknown> => {
    if (route === '/enable') return { port: (body as { port: number }).port }
    if (route === '/network') return { proxyUrl }
    if (route === '/verify') return { ok: reachable }
    return {}
  })
  const exits = new Set<(exit: CloudflareTunnelExit) => void>()
  const stop = vi.fn(async () => {})
  const startTunnel = vi.fn(async (options: CloudflareTunnelOptions) => ({
    url: options.mode === 'named' ? options.publicUrl! : 'https://fixture-phone.trycloudflare.com',
    stop,
    onExit(callback: (exit: CloudflareTunnelExit) => void) { exits.add(callback); return () => { exits.delete(callback) } },
  }))
  const manager = new PublicAccessManager({ directory, backend: { request: request as never }, startTunnel })
  managers.push(manager)
  return { directory, file, request, manager, startTunnel, stop,
    reachable(value: boolean) { reachable = value }, proxy(value: string | null) { proxyUrl = value },
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
    expect(persisted).toMatchObject({ version: 5, futureSetting: { enabled: true }, legacyRemoteConfiguration: original })
    expect(migratePublicAccessSettings(persisted)).toEqual(persisted)
    await expect(f.manager.start(PUBLIC_ACCESS_CONSENT_VERSION - 1)).rejects.toThrow('consent')
    await f.manager.start(PUBLIC_ACCESS_CONSENT_VERSION)
    expect(f.manager.getStatus()).toMatchObject({ state: 'online', migrationRequired: false })
    expect(JSON.parse(readFileSync(f.file, 'utf8')).legacyRemoteConfiguration).toEqual(original)
  })

  it('migrates a new profile into disabled Quick mode and preserves newer unknown fields', () => {
    expect(migratePublicAccessSettings({})).toEqual({ version: 5, ...quick, tunnelToken: '', autoStart: false, consentVersion: 0, migrationRequired: false })
    expect(migratePublicAccessSettings({ ...named, version: 8, future: 7, autoStart: true, consentVersion: 4 })).toMatchObject({ version: 8, future: 7, autoStart: true, consentVersion: 4 })
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
    await f.manager.configure({ ...named, customUrl: 'https://PHONE.example.test/' })
    await f.manager.start(PUBLIC_ACCESS_CONSENT_VERSION)
    expect(f.startTunnel.mock.calls[0]![0]).toMatchObject({ mode: 'named', publicUrl: named.customUrl, token: fakeToken })
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
    await f.manager.start(PUBLIC_ACCESS_CONSENT_VERSION)
    expect(f.manager.getStatus()).toMatchObject({ state: 'reconnecting', error: 'network', publicUrl: null })
    expect(f.stop).toHaveBeenCalledTimes(1)
    expect(f.request.mock.calls.filter(([route]) => route === '/verify')).toHaveLength(3)
    f.reachable(true)
    await advance(1000)
    expect(f.manager.getStatus()).toMatchObject({ state: 'online', error: null })
    await f.manager.stop()
    await advance(60000)
    expect(f.startTunnel).toHaveBeenCalledTimes(2)
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
    finish({ url: 'https://late.trycloudflare.com', stop: f.stop, onExit: () => () => {} })
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
    finishStartup({ url: 'https://late.trycloudflare.com', stop: f.stop, onExit: () => () => {} })
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
    finish({ url: 'https://cancelled.trycloudflare.com', stop: f.stop, onExit: () => () => {} })
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
    f.request.mockRejectedValueOnce(new Error('Server unavailable'))
    await f.manager.serverUnavailable()
    expect(f.manager.getStatus()).toMatchObject({ state: 'failed', error: 'stop' })
    await f.manager.serverChanged()
    expect(f.manager.getStatus().state).toBe('online')
    await f.manager.stop()
    await f.manager.serverChanged()
    expect(f.startTunnel).toHaveBeenCalledTimes(2)
  })
})

it('classifies actionable failures without using provider messages as UI content', () => {
  expect(classifyPublicAccessError(new CloudflareTunnelError('proxy', 'fake'))).toBe('proxy')
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
