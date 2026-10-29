import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { PublicAccessManager, PUBLIC_ACCESS_CONSENT_VERSION, classifyPublicAccessError, migratePublicAccessSettings } from './publicAccess'

const directories: string[] = []
const managers: PublicAccessManager[] = []
const configuration = { mode: 'tailscale' as const, customUrl: 'https://desktop.example.ts.net', localPort: 17463 }
afterEach(async () => {
  await Promise.all(managers.splice(0).map(manager => manager.dispose()))
  directories.splice(0).forEach(directory => rmSync(directory, { recursive: true, force: true }))
  vi.useRealTimers()
})
async function advance(milliseconds: number) {
  vi.advanceTimersByTime(milliseconds)
  for (let i = 0; i < 20; i++) await Promise.resolve()
}
function fixture(saved?: unknown) {
  const directory = mkdtempSync(path.join(tmpdir(), 'tailscale-host-test-'))
  directories.push(directory)
  const file = path.join(directory, 'public-access-private.json')
  if (saved !== undefined) writeFileSync(file, typeof saved === 'string' ? saved : JSON.stringify(saved))
  const request = vi.fn(async (route: string, _method?: string, body?: unknown) => route === '/enable' ? { port: (body as { port: number }).port } : {})
  const manager = new PublicAccessManager({ directory, backend: { request: request as never } })
  managers.push(manager)
  return { directory, file, request, manager }
}

describe('Tailscale gateway settings migration', () => {
  it.each([
    { version: 1, authtoken: 'fake-secret', autoStart: true, consentVersion: 2 },
    { version: 3, mode: 'ngrok', authtoken: 'fake-secret', customUrl: '', localPort: 17463, ngrokDomain: 'https://old.ngrok.app', ngrokUrl: 'https://old.ngrok.app', autoStart: true, consentVersion: 2 },
    { version: 3, mode: 'custom', customUrl: 'https://old.example.test', localPort: 18321, autoStart: true, consentVersion: 2 },
  ])('migrates retired tunnels without starting them and preserves the original private data: %j', async saved => {
    const original = { ...saved, futureSetting: { enabled: true } }
    const { manager, file, request } = fixture(original)
    expect(manager.getStatus()).toMatchObject({ state: 'unconfigured', mode: 'tailscale', customUrl: '', autoStart: false, consentVersion: 0, migrationRequired: true })
    expect(JSON.stringify(manager.getStatus())).not.toContain('fake-secret')
    await manager.restore()
    await expect(manager.start(PUBLIC_ACCESS_CONSENT_VERSION)).rejects.toThrow('Configuration')
    expect(request).not.toHaveBeenCalled()
    const persisted = JSON.parse(readFileSync(file, 'utf8'))
    expect(persisted).toMatchObject({ version: 4, futureSetting: { enabled: true }, legacyRemoteConfiguration: original })
    expect(migratePublicAccessSettings(persisted)).toEqual(persisted)
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600)
    await manager.configure(configuration)
    await manager.start(PUBLIC_ACCESS_CONSENT_VERSION)
    expect(manager.getStatus()).toMatchObject({ state: 'online', migrationRequired: false })
    expect(JSON.parse(readFileSync(file, 'utf8')).legacyRemoteConfiguration).toEqual(original)
  })

  it('migrates an existing Serve URL and fixed port but requires fresh opt-in', async () => {
    const { manager, request } = fixture({ version: 3, mode: 'custom', customUrl: 'https://Desktop.Example.ts.net:8443/', localPort: 18321, autoStart: true, consentVersion: 2, future: 7 })
    expect(manager.getStatus()).toMatchObject({ customUrl: 'https://desktop.example.ts.net:8443', localPort: 18321, migrationRequired: false, autoStart: false, consentVersion: 0 })
    await manager.restore()
    expect(request).not.toHaveBeenCalled()
    await expect(manager.start(2)).rejects.toThrow('consent')
    await manager.start(PUBLIC_ACCESS_CONSENT_VERSION)
    expect(request).toHaveBeenCalledWith('/enable', 'POST', { publicUrl: 'https://desktop.example.ts.net:8443', port: 18321 })
  })

  it('migrates a new profile without granting access and preserves forward-version fields', () => {
    expect(migratePublicAccessSettings({})).toEqual({ version: 4, ...configuration, customUrl: '', autoStart: false, consentVersion: 0, migrationRequired: false })
    expect(migratePublicAccessSettings({ ...configuration, version: 5, future: 7, autoStart: true, consentVersion: 3 })).toMatchObject({ version: 5, future: 7, autoStart: true, consentVersion: 3 })
  })

  it.each([
    '{broken',
    { version: 4, ...configuration, customUrl: 'https://public.example.test', autoStart: true, consentVersion: 3 },
    { version: 4, ...configuration, localPort: null, autoStart: true, consentVersion: 3 },
    { version: 3, mode: 'custom', customUrl: 'http://old.example.test', localPort: 17463 },
    { version: 3, mode: 'custom', customUrl: 'https://old.example.test' },
    { mode: 'unknown', autoStart: true },
  ])('preserves corrupt or invalid saved settings and fails closed: %j', async saved => {
    const serialized = typeof saved === 'string' ? saved : JSON.stringify(saved)
    const { manager, request, file } = fixture(saved)
    await manager.restore()
    expect(manager.getStatus()).toMatchObject({ state: 'unconfigured', error: 'configuration' })
    expect(request).not.toHaveBeenCalled()
    expect(readFileSync(file, 'utf8')).toBe(serialized)
  })
})

describe('Tailscale local gateway lifecycle', () => {
  it('enables only the fixed local gateway and restores it with current opt-in', async () => {
    const { manager, request, directory } = fixture()
    await manager.configure(configuration)
    await Promise.all([manager.start(PUBLIC_ACCESS_CONSENT_VERSION), manager.start(PUBLIC_ACCESS_CONSENT_VERSION)])
    expect(request.mock.calls.filter(([route]) => route === '/enable')).toHaveLength(1)
    expect(request).toHaveBeenLastCalledWith('/enable', 'POST', { publicUrl: configuration.customUrl, port: 17463 })
    expect(manager.getStatus()).toMatchObject({ state: 'online', publicUrl: configuration.customUrl })
    request.mockClear()
    await manager.start(PUBLIC_ACCESS_CONSENT_VERSION)
    await manager.configure({ ...configuration, customUrl: configuration.customUrl + '/' })
    expect(request).not.toHaveBeenCalled()
    manager.setAutoStart(true)
    await manager.stop()
    const restored = new PublicAccessManager({ directory, backend: { request: request as never } })
    managers.push(restored)
    await restored.restore()
    expect(restored.getStatus()).toMatchObject({ state: 'online', publicUrl: configuration.customUrl })
  })

  it('does not auto-enable a fresh profile or accept old consent', async () => {
    const { manager, request } = fixture()
    await manager.restore()
    await expect(manager.start(PUBLIC_ACCESS_CONSENT_VERSION)).rejects.toThrow('Configuration')
    await manager.configure(configuration)
    request.mockClear()
    await expect(manager.start(PUBLIC_ACCESS_CONSENT_VERSION - 1)).rejects.toThrow('consent')
    expect(request).not.toHaveBeenCalled()
  })

  it('rejects an unsafe endpoint before disturbing an active gateway', async () => {
    const { manager, request } = fixture()
    await manager.configure(configuration)
    await manager.start(PUBLIC_ACCESS_CONSENT_VERSION)
    request.mockClear()
    for (const patch of [{ customUrl: 'http://desktop.example.ts.net' }, { customUrl: 'https://public.example.test' }, { customUrl: 'https://desktop.example.ts.net/path' }, { localPort: 80 }, { localPort: '17463' }, { mode: 'ngrok' }, { localHost: '0.0.0.0' }]) await expect(manager.configure({ ...configuration, ...patch } as never)).rejects.toThrow('configuration')
    expect(request).not.toHaveBeenCalled()
    expect(manager.getStatus().state).toBe('online')
  })

  it('requires fresh consent after changing the origin or fixed port', async () => {
    const { manager } = fixture()
    await manager.configure(configuration)
    await manager.start(PUBLIC_ACCESS_CONSENT_VERSION)
    manager.setAutoStart(true)
    await manager.configure({ ...configuration, customUrl: 'https://second.example.ts.net:8443', localPort: 18321 })
    await manager.restore()
    expect(manager.getStatus()).toMatchObject({ state: 'disabled', consentVersion: 0, publicUrl: null })
  })

  it.each(['serverUnavailable', 'serverChanged', 'stop'] as const)('rejects a configuration interrupted by %s instead of enabling the old endpoint', async interrupt => {
    const { manager, request, file } = fixture()
    await manager.configure(configuration)
    const saved = readFileSync(file, 'utf8')
    let queue: Promise<object> = Promise.resolve({})
    let blockDisable = true
    let entered!: () => void
    let release!: () => void
    const disabling = new Promise<void>(resolve => { entered = resolve })
    request.mockClear()
    request.mockImplementation((route, _method, body) => {
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
    const enabling = manager.configure({ ...configuration, customUrl: 'https://new.example.ts.net' }).then(() => manager.start(PUBLIC_ACCESS_CONSENT_VERSION))
    const outcome = enabling.then(() => null, (error: unknown) => error)
    await disabling
    const interruption = manager[interrupt]()
    release()
    await interruption
    const error = await outcome
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain('configuration interrupted')
    expect(request.mock.calls.some(([route]) => route === '/enable')).toBe(false)
    expect(readFileSync(file, 'utf8')).toBe(saved)
    await manager.configure({ ...configuration, customUrl: 'https://new.example.ts.net' })
    await manager.start(PUBLIC_ACCESS_CONSENT_VERSION)
    expect(manager.getStatus()).toMatchObject({ state: 'online', publicUrl: 'https://new.example.ts.net' })
  })

  it.each(['stop', 'dispose'] as const)('ignores a late enable after %s', async action => {
    const { manager, request } = fixture()
    await manager.configure(configuration)
    let finish!: (value: { port: number }) => void
    request.mockImplementation(async route => route === '/enable' ? new Promise(resolve => { finish = resolve }) : {})
    const connecting = manager.start(PUBLIC_ACCESS_CONSENT_VERSION)
    await manager[action]()
    finish({ port: 17463 })
    await connecting
    expect(manager.getStatus()).toMatchObject({ state: 'disabled', publicUrl: null })
    if (action === 'dispose') {
      const count = request.mock.calls.length
      await manager.start(PUBLIC_ACCESS_CONSENT_VERSION)
      expect(request).toHaveBeenCalledTimes(count)
    }
  })

  it('re-enables the same gateway after a sidecar restart but respects an explicit stop', async () => {
    const { manager, request } = fixture()
    await manager.configure(configuration)
    await manager.start(PUBLIC_ACCESS_CONSENT_VERSION)
    await manager.serverUnavailable()
    expect(manager.getStatus().state).toBe('reconnecting')
    await manager.serverChanged()
    expect(manager.getStatus()).toMatchObject({ state: 'online', publicUrl: configuration.customUrl })
    expect(request.mock.calls.filter(([route]) => route === '/enable')).toHaveLength(2)
    await manager.stop()
    await manager.serverChanged()
    expect(request.mock.calls.filter(([route]) => route === '/enable')).toHaveLength(2)
  })

  it('fails a fixed-port mismatch without silently using another endpoint', async () => {
    const { manager, request } = fixture()
    await manager.configure(configuration)
    request.mockImplementation(async route => route === '/enable' ? { port: 32123 } : {})
    await manager.start(PUBLIC_ACCESS_CONSENT_VERSION)
    expect(manager.getStatus()).toMatchObject({ state: 'failed', error: 'configuration' })
    expect(request).toHaveBeenLastCalledWith('/disable', 'POST')
  })

  it.each([false, true])('restores saved access after a startup outage, including another failed shutdown: %s', async failRecoveryShutdown => {
    const { manager, request } = fixture({ ...configuration, version: 4, autoStart: true, consentVersion: PUBLIC_ACCESS_CONSENT_VERSION })
    request.mockRejectedValueOnce(new Error('Server unavailable'))
    request.mockRejectedValueOnce(new Error('Server unavailable'))
    await manager.restore()
    expect(manager.getStatus()).toMatchObject({ state: 'failed', error: 'stop', autoStart: true })
    await expect(manager.start(PUBLIC_ACCESS_CONSENT_VERSION)).rejects.toThrow('stop')

    if (failRecoveryShutdown) {
      request.mockRejectedValueOnce(new Error('Server unavailable'))
      await manager.serverChanged()
      expect(manager.getStatus()).toMatchObject({ state: 'failed', error: 'stop' })
    }

    let acknowledge!: () => void
    request.mockImplementationOnce(() => new Promise(resolve => { acknowledge = () => resolve({}) }))
    const recovering = manager.serverChanged()
    expect(request.mock.calls.filter(([route]) => route === '/enable')).toHaveLength(1)
    await expect(manager.start(PUBLIC_ACCESS_CONSENT_VERSION)).rejects.toThrow('stop')
    acknowledge()
    await recovering
    expect(manager.getStatus()).toMatchObject({ state: 'online', error: null, publicUrl: configuration.customUrl, autoStart: true })
    expect(request.mock.calls.map(([route]) => route)).toEqual([
      '/enable', '/disable', ...(failRecoveryShutdown ? ['/disable'] : []), '/disable', '/enable',
    ])
  })

  it.each(['stop', 'dispose'] as const)('cancels startup recovery when the user calls %s while shutdown is pending', async action => {
    const { manager, request } = fixture({ ...configuration, version: 4, autoStart: true, consentVersion: PUBLIC_ACCESS_CONSENT_VERSION })
    request.mockRejectedValueOnce(new Error('Server unavailable'))
    request.mockRejectedValueOnce(new Error('Server unavailable'))
    await manager.restore()

    let acknowledge!: () => void
    request.mockImplementationOnce(() => new Promise(resolve => { acknowledge = () => resolve({}) }))
    const recovering = manager.serverChanged()
    await manager[action]()
    acknowledge()
    await recovering
    await manager.serverChanged()
    expect(manager.getStatus()).toMatchObject({ state: 'disabled', error: null, publicUrl: null, autoStart: true })
    expect(request.mock.calls.filter(([route]) => route === '/enable')).toHaveLength(1)
  })

  it('keeps an explicit stop cancelled even if its shutdown fails before the sidecar recovers', async () => {
    const { manager, request } = fixture({ ...configuration, version: 4, autoStart: true, consentVersion: PUBLIC_ACCESS_CONSENT_VERSION })
    request.mockRejectedValueOnce(new Error('Server unavailable'))
    request.mockRejectedValueOnce(new Error('Server unavailable'))
    await manager.restore()
    request.mockRejectedValueOnce(new Error('Server unavailable'))
    await manager.stop()
    await manager.serverChanged()
    expect(manager.getStatus()).toMatchObject({ state: 'disabled', error: null, publicUrl: null, autoStart: true })
    expect(request.mock.calls.filter(([route]) => route === '/enable')).toHaveLength(1)
  })

  it('retries a local backend outage with backoff and cancels retries on stop', async () => {
    vi.useFakeTimers()
    const { manager, request } = fixture()
    await manager.configure(configuration)
    request.mockRejectedValueOnce(new Error('Server unavailable'))
    await manager.start(PUBLIC_ACCESS_CONSENT_VERSION)
    expect(manager.getStatus()).toMatchObject({ state: 'reconnecting', error: 'network' })
    await advance(1000)
    expect(manager.getStatus().state).toBe('online')
    await manager.stop()
    request.mockRejectedValueOnce(new Error('Server unavailable'))
    await manager.start(PUBLIC_ACCESS_CONSENT_VERSION)
    await manager.stop()
    const calls = request.mock.calls.length
    await advance(60_000)
    expect(request).toHaveBeenCalledTimes(calls)
  })

  it('keeps configuration failures terminal and returns no raw backend error', async () => {
    vi.useFakeTimers()
    const { manager, request } = fixture()
    await manager.configure(configuration)
    request.mockRejectedValueOnce(new Error('Public access configuration failed private-token'))
    await manager.start(PUBLIC_ACCESS_CONSENT_VERSION)
    const count = request.mock.calls.length
    await advance(60_000)
    expect(request).toHaveBeenCalledTimes(count)
    expect(manager.getStatus()).toMatchObject({ state: 'failed', error: 'configuration' })
    expect(JSON.stringify(manager.getStatus())).not.toContain('private-token')
    expect(classifyPublicAccessError(new Error('EADDRINUSE'))).toBe('configuration')
  })

  it('reports an unconfirmed stop while the gateway remains reachable and allows a retry', async () => {
    const { manager, request } = fixture()
    await manager.configure(configuration)
    let active = false
    let failDisable = true
    request.mockImplementation(async route => {
      if (route === '/enable') { active = true; return { port: 17463 } }
      if (route === '/disable') {
        if (failDisable) throw new Error('Backend unavailable private-token')
        active = false
      }
      return {}
    })
    await manager.start(PUBLIC_ACCESS_CONSENT_VERSION)
    await expect(manager.stop()).resolves.toMatchObject({ state: 'failed', error: 'stop', publicUrl: configuration.customUrl })
    expect(active).toBe(true)
    await expect(manager.start(PUBLIC_ACCESS_CONSENT_VERSION)).rejects.toThrow('stop')
    expect(JSON.stringify(manager.getStatus())).not.toContain('private-token')
    failDisable = false
    await expect(manager.stop()).resolves.toMatchObject({ state: 'disabled', error: null, publicUrl: null })
    expect(active).toBe(false)
    await manager.start(PUBLIC_ACCESS_CONSENT_VERSION)
    expect(active).toBe(true)
  })

  it('does not publish disabled while awaiting the stop acknowledgement', async () => {
    const { manager, request } = fixture()
    await manager.configure(configuration)
    await manager.start(PUBLIC_ACCESS_CONSENT_VERSION)
    let release!: () => void
    request.mockImplementationOnce(() => new Promise(resolve => { release = () => resolve({}) }))
    const stopping = manager.stop()
    expect(manager.getStatus()).toMatchObject({ state: 'online', publicUrl: configuration.customUrl })
    const attempt = manager.start(PUBLIC_ACCESS_CONSENT_VERSION).then(() => null, (error: unknown) => error)
    release()
    await stopping
    expect(await attempt).toBeInstanceOf(Error)
    expect(manager.getStatus()).toMatchObject({ state: 'disabled', publicUrl: null })
  })

  it('does not save replacement settings or start them after stop fails', async () => {
    const { manager, request, file } = fixture()
    await manager.configure(configuration)
    await manager.start(PUBLIC_ACCESS_CONSENT_VERSION)
    const saved = readFileSync(file, 'utf8')
    request.mockClear()
    request.mockRejectedValueOnce(new Error('Backend unavailable'))
    await expect(manager.configure({ ...configuration, customUrl: 'https://new.example.ts.net' }).then(() => manager.start(PUBLIC_ACCESS_CONSENT_VERSION))).rejects.toThrow('stop')
    expect(readFileSync(file, 'utf8')).toBe(saved)
    expect(request.mock.calls.some(([route]) => route === '/enable')).toBe(false)
    expect(manager.getStatus()).toMatchObject({ state: 'failed', error: 'stop', customUrl: configuration.customUrl })
  })

  it('does not re-enable on sidecar changes until shutdown is confirmed', async () => {
    const { manager, request } = fixture()
    await manager.configure(configuration)
    await manager.start(PUBLIC_ACCESS_CONSENT_VERSION)
    request.mockClear()
    request.mockRejectedValueOnce(new Error('Backend unavailable'))
    await manager.serverChanged()
    expect(manager.getStatus()).toMatchObject({ state: 'failed', error: 'stop' })
    expect(request.mock.calls.some(([route]) => route === '/enable')).toBe(false)
  })

  it('keeps an unsuccessful connection cleanup visible instead of retrying an uncertain gateway', async () => {
    vi.useFakeTimers()
    const { manager, request } = fixture()
    await manager.configure(configuration)
    request.mockRejectedValue(new Error('Backend unavailable'))
    await manager.start(PUBLIC_ACCESS_CONSENT_VERSION)
    expect(manager.getStatus()).toMatchObject({ state: 'failed', error: 'stop' })
    const count = request.mock.calls.length
    await advance(60_000)
    expect(request).toHaveBeenCalledTimes(count)
    request.mockResolvedValue({})
  })

  it('settles dispose even if shutdown fails so later server cleanup can proceed', async () => {
    const { manager, request } = fixture()
    await manager.configure(configuration)
    await manager.start(PUBLIC_ACCESS_CONSENT_VERSION)
    request.mockRejectedValueOnce(new Error('Backend unavailable'))
    await expect(manager.dispose()).resolves.toBeUndefined()
    expect(manager.getStatus()).toMatchObject({ state: 'failed', error: 'stop' })
    const count = request.mock.calls.length
    await manager.start(PUBLIC_ACCESS_CONSENT_VERSION)
    expect(request).toHaveBeenCalledTimes(count)
  })

  it('does not publish a stale error after stop during cleanup', async () => {
    const { manager, request } = fixture()
    await manager.configure(configuration)
    let finishDisable!: () => void
    let disableCount = 0
    request.mockImplementation(async route => {
      if (route === '/enable') throw new Error('Server unavailable')
      if (route === '/disable' && ++disableCount === 1) await new Promise<void>(resolve => { finishDisable = resolve })
      return {}
    })
    const connecting = manager.start(PUBLIC_ACCESS_CONSENT_VERSION)
    for (let i = 0; i < 20; i++) await Promise.resolve()
    await manager.stop()
    finishDisable()
    await connecting
    expect(manager.getStatus()).toMatchObject({ state: 'disabled', error: null })
  })
})
