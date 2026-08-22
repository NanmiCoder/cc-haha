import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SidecarChild, SidecarPlan } from './sidecarManager'
import { SYSTEM_PROXY_ERROR_ENV } from './sidecarManager'
import { ElectronServerRuntime } from './serverRuntime'
import type { SystemProxyBridgeLike } from './systemProxyBridge'

const sidecarMocks = {
  nextPort: 49321,
  spawnError: null as Error | null,
  serverChildren: [] as FakeSidecarChild[],
  adapterChildren: [] as FakeSidecarChild[],
  serverPlans: [] as SidecarPlan[],
  appendHostDiagnostic: vi.fn(),
  waitForServerImpl: () => Promise.resolve(),
  onAdapterSpawn: null as (() => void) | null,
  spawnSidecar: vi.fn((plan: SidecarPlan) => {
    if (plan.args[0] === 'server' && sidecarMocks.spawnError) throw sidecarMocks.spawnError
    const child = new FakeSidecarChild()
    if (plan.args[0] === 'server') {
      sidecarMocks.serverChildren.push(child)
      sidecarMocks.serverPlans.push(plan)
    } else {
      sidecarMocks.adapterChildren.push(child)
      sidecarMocks.onAdapterSpawn?.()
    }
    return child as unknown as SidecarChild
  }),
}

let isolatedConfigDir = ''

class FakeSidecarChild extends EventEmitter {
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly kill = vi.fn()
}

function createRuntime(options: {
  appRoot?: string
  diagnosticsFile?: string
  env?: NodeJS.ProcessEnv
  now?: () => number
  resolveSystemProxy?: (url: string) => Promise<string>
  sleep?: (delayMs: number) => Promise<void>
  proxyBridge?: SystemProxyBridgeLike
} = {}) {
  return new ElectronServerRuntime({
    desktopRoot: '/isolated/desktop',
    appRoot: options.appRoot,
    diagnosticsFile: options.diagnosticsFile,
    env: { CLAUDE_CONFIG_DIR: isolatedConfigDir, ...options.env },
    resolveSystemProxy: options.resolveSystemProxy,
    deps: {
      appendHostDiagnostic: sidecarMocks.appendHostDiagnostic,
      ...(options.now ? { now: options.now } : {}),
      preferredServerPorts: () => [],
      reserveServerPort: async () => sidecarMocks.nextPort++,
      ...(options.sleep ? { sleep: options.sleep } : {}),
      spawnSidecar: sidecarMocks.spawnSidecar,
      waitForServer: async () => await sidecarMocks.waitForServerImpl(),
      writeLastServerPort: () => undefined,
      ...(options.proxyBridge
        ? { createSystemProxyBridge: () => options.proxyBridge! }
        : {}),
    },
  })
}

async function waitForServerChildren(count: number): Promise<void> {
  for (let attempt = 0; attempt < 20 && sidecarMocks.serverChildren.length !== count; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 0))
  }
  expect(sidecarMocks.serverChildren).toHaveLength(count)
}

async function waitForMockCalls(mock: ReturnType<typeof vi.fn>, count: number): Promise<void> {
  for (let attempt = 0; attempt < 20 && mock.mock.calls.length !== count; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 0))
  }
  expect(mock).toHaveBeenCalledTimes(count)
}

describe('ElectronServerRuntime', () => {
  beforeEach(() => {
    isolatedConfigDir = mkdtempSync(path.join(tmpdir(), 'cc-haha-electron-runtime-'))
    sidecarMocks.nextPort = 49321
    sidecarMocks.spawnError = null
    sidecarMocks.serverChildren.length = 0
    sidecarMocks.adapterChildren.length = 0
    sidecarMocks.serverPlans.length = 0
    sidecarMocks.appendHostDiagnostic.mockClear()
    sidecarMocks.waitForServerImpl = () => Promise.resolve()
    sidecarMocks.onAdapterSpawn = null
    sidecarMocks.spawnSidecar.mockClear()
  })

  afterEach(() => {
    rmSync(isolatedConfigDir, { recursive: true, force: true })
  })

  it('restarts after the active healthy server exits and ignores its late exit', async () => {
    const runtime = createRuntime({
      appRoot: '/isolated/app',
    })

    const firstUrl = await runtime.getServerUrl()
    const firstChild = sidecarMocks.serverChildren[0]!
    const firstAdapters = [...sidecarMocks.adapterChildren]
    expect(firstAdapters).toHaveLength(5)
    firstChild.emit('exit', 7, null)

    const [secondUrl, coalescedUrl] = await Promise.all([
      runtime.getServerUrl(),
      runtime.getServerUrl(),
    ])
    const secondChild = sidecarMocks.serverChildren[1]!
    firstChild.emit('exit', 9, 'SIGTERM')

    expect(firstUrl).toBe('http://127.0.0.1:49321')
    expect(secondUrl).toBe('http://127.0.0.1:49322')
    expect(coalescedUrl).toBe(secondUrl)
    expect(sidecarMocks.serverChildren).toHaveLength(2)
    expect(sidecarMocks.adapterChildren).toHaveLength(10)
    for (const adapter of firstAdapters) expect(adapter.kill).toHaveBeenCalledTimes(1)
    for (const adapter of sidecarMocks.adapterChildren.slice(5)) {
      expect(adapter.kill).not.toHaveBeenCalled()
    }
    expect(await runtime.getServerUrl()).toBe(secondUrl)
    expect(secondChild).toBeDefined()
  })

  it('passes the isolated Electron host diagnostics file to the server sidecar', async () => {
    const runtime = createRuntime({
      diagnosticsFile: '/isolated/user-data/diagnostics/electron-host.log',
    })

    await runtime.startServer()

    expect(sidecarMocks.serverPlans[0]!.env.CC_HAHA_ELECTRON_DIAGNOSTICS_FILE)
      .toBe('/isolated/user-data/diagnostics/electron-host.log')
    expect(sidecarMocks.serverPlans[0]!.env.CLAUDE_CONFIG_DIR).toBe(isolatedConfigDir)
    expect(sidecarMocks.serverPlans[0]!.env.CLAUDE_CONFIG_DIR)
      .not.toBe(path.join(homedir(), '.claude'))
  })

  it('keeps the pet capability independent and exposes it only to the server sidecar', async () => {
    const runtime = createRuntime()

    await runtime.startServer()

    const localToken = runtime.getLocalAccessToken()
    const petToken = runtime.getPetAccessToken()
    expect(localToken.length).toBeGreaterThanOrEqual(32)
    expect(petToken.length).toBeGreaterThanOrEqual(32)
    expect(petToken).not.toBe(localToken)
    expect(sidecarMocks.serverPlans[0]!.env.CC_HAHA_LOCAL_ACCESS_TOKEN).toBe(localToken)
    expect(sidecarMocks.serverPlans[0]!.env.CC_HAHA_PET_ACCESS_TOKEN).toBe(petToken)
    for (const adapter of sidecarMocks.spawnSidecar.mock.calls
      .map(([plan]) => plan)
      .filter(plan => plan.args[0] === 'adapters')) {
      expect(adapter.env.CC_HAHA_LOCAL_ACCESS_TOKEN).toBe(localToken)
      expect(adapter.env.CC_HAHA_PET_ACCESS_TOKEN).toBeUndefined()
    }
  })

  it('gives the server only the dynamic bridge URL while adapters explicitly inherit it', async () => {
    const bridge = {
      start: vi.fn(async () => 'http://127.0.0.1:49123'),
      stop: vi.fn(async () => undefined),
    }
    const runtime = createRuntime({
      env: {
        HTTP_PROXY: 'http://stale.example:8080',
        HTTPS_PROXY: 'http://stale.example:8080',
        ALL_PROXY: 'socks5://stale.example:1080',
        all_proxy: 'socks5://stale.example:1080',
      },
      resolveSystemProxy: async () => 'DIRECT',
      proxyBridge: bridge,
    })

    await runtime.startServer()

    const serverEnv = sidecarMocks.serverPlans[0]!.env
    expect(serverEnv.CC_HAHA_SYSTEM_PROXY_URL).toBe('http://127.0.0.1:49123')
    expect(serverEnv.HTTP_PROXY).toBeUndefined()
    expect(serverEnv.HTTPS_PROXY).toBeUndefined()
    expect(serverEnv.ALL_PROXY).toBeUndefined()
    expect(serverEnv.all_proxy).toBeUndefined()
    const adapterPlans = sidecarMocks.spawnSidecar.mock.calls
      .map(([plan]) => plan)
      .filter(plan => plan.args[0] === 'adapters')
    expect(adapterPlans).toHaveLength(5)
    for (const plan of adapterPlans) {
      expect(plan.env.HTTP_PROXY).toBe('http://127.0.0.1:49123')
      expect(plan.env.HTTPS_PROXY).toBe('http://127.0.0.1:49123')
      expect(plan.env.ALL_PROXY).toBe('http://127.0.0.1:49123')
      expect(plan.env.all_proxy).toBe('http://127.0.0.1:49123')
    }

    runtime.stopAll()
    expect(bridge.stop).toHaveBeenCalledTimes(1)
  })

  it('does not spawn a server when stopAll races with proxy bridge startup', async () => {
    let releaseBridge!: (url: string) => void
    const bridge = {
      start: vi.fn(() => new Promise<string>(resolve => { releaseBridge = resolve })),
      stop: vi.fn(async () => undefined),
    }
    const runtime = createRuntime({
      resolveSystemProxy: async () => 'DIRECT',
      proxyBridge: bridge,
    })

    const starting = runtime.startServer()
    for (let attempt = 0; attempt < 10 && bridge.start.mock.calls.length === 0; attempt++) {
      await Promise.resolve()
    }
    expect(bridge.start).toHaveBeenCalledTimes(1)
    runtime.stopAll()
    releaseBridge('http://127.0.0.1:49123')

    await expect(starting).rejects.toThrow('server startup stopped')
    expect(sidecarMocks.spawnSidecar).not.toHaveBeenCalled()
    expect(bridge.stop).toHaveBeenCalledTimes(1)
  })

  it('passes a sanitized bridge startup failure to the server without silently using direct mode', async () => {
    const bridge = {
      start: vi.fn(async () => {
        throw new Error('failed via https://user:password@proxy.example/path with sk-secret12345678')
      }),
      stop: vi.fn(async () => undefined),
    }
    const runtime = createRuntime({
      env: {
        HTTP_PROXY: 'http://stale.example:8080',
        HTTPS_PROXY: 'http://stale.example:8080',
        ALL_PROXY: 'socks5://stale.example:1080',
      },
      resolveSystemProxy: async () => 'DIRECT',
      proxyBridge: bridge,
    })

    await runtime.startServer()

    const serverEnv = sidecarMocks.serverPlans[0]!.env
    expect(serverEnv.HTTP_PROXY).toBeUndefined()
    expect(serverEnv.HTTPS_PROXY).toBeUndefined()
    expect(serverEnv.ALL_PROXY).toBeUndefined()
    expect(serverEnv.CC_HAHA_SYSTEM_PROXY_URL).toBeUndefined()
    expect(serverEnv[SYSTEM_PROXY_ERROR_ENV]).toContain('System proxy bridge unavailable: failed via')
    expect(serverEnv[SYSTEM_PROXY_ERROR_ENV]).not.toContain('password')
    expect(serverEnv[SYSTEM_PROXY_ERROR_ENV]).not.toContain('sk-secret')
    expect(sidecarMocks.serverChildren).toHaveLength(1)
  })

  it('persists a server startup failure through the sanitized host-log boundary', async () => {
    sidecarMocks.spawnError = new Error('spawn failed')
    const runtime = createRuntime({
      diagnosticsFile: '/isolated/user-data/diagnostics/electron-host.log',
    })

    await expect(runtime.startServer()).rejects.toThrow('spawn failed')

    expect(sidecarMocks.appendHostDiagnostic).toHaveBeenCalledWith(
      '/isolated/user-data/diagnostics/electron-host.log',
      expect.stringContaining('[startup-error] spawn failed'),
    )
  })

  it('rejects an in-flight start when the child exits before health publication', async () => {
    sidecarMocks.waitForServerImpl = () => new Promise(() => undefined)
    const runtime = createRuntime()

    const starting = runtime.startServer()
    await waitForServerChildren(1)
    sidecarMocks.serverChildren[0]!.emit('exit', 17, null)

    await expect(starting).rejects.toThrow('code=17, signal=null')
    sidecarMocks.waitForServerImpl = () => Promise.resolve()
    await expect(runtime.getServerUrl()).resolves.toBe('http://127.0.0.1:49322')
    expect(sidecarMocks.serverChildren).toHaveLength(2)
  })

  it('kills the attempted server child when the health wait rejects', async () => {
    sidecarMocks.waitForServerImpl = () => Promise.reject(new Error('health wait timed out'))
    const runtime = createRuntime()

    await expect(runtime.startServer()).rejects.toThrow('health wait timed out')

    expect(sidecarMocks.serverChildren).toHaveLength(1)
    expect(sidecarMocks.serverChildren[0]!.kill).toHaveBeenCalledTimes(1)
    expect(sidecarMocks.adapterChildren).toHaveLength(0)
  })

  it('kills an unpublished server exactly once when stopAll runs during health wait', async () => {
    let releaseHealth!: () => void
    sidecarMocks.waitForServerImpl = () => new Promise<void>(resolve => {
      releaseHealth = resolve
    })
    const runtime = createRuntime()

    const starting = runtime.startServer()
    await waitForServerChildren(1)
    runtime.stopAll(true)

    expect(sidecarMocks.serverChildren[0]!.kill).toHaveBeenCalledTimes(1)
    await expect(starting).rejects.toThrow('stopped')
    releaseHealth()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(sidecarMocks.serverChildren).toHaveLength(1)
    expect(sidecarMocks.adapterChildren).toHaveLength(0)
    expect(sidecarMocks.serverChildren[0]!.kill).toHaveBeenCalledTimes(1)
  })

  it('stops active adapters and waits for the replacement server to become healthy', async () => {
    const runtime = createRuntime()
    await runtime.startServer()
    const activeAdapters = [...sidecarMocks.adapterChildren]
    let releaseReplacementHealth!: () => void
    sidecarMocks.waitForServerImpl = () => new Promise<void>(resolve => {
      releaseReplacementHealth = resolve
    })

    sidecarMocks.serverChildren[0]!.emit('exit', 19, null)
    await waitForServerChildren(2)

    for (const adapter of activeAdapters) {
      expect(adapter.kill).toHaveBeenCalledTimes(1)
    }
    let recoveredUrl: string | null = null
    const recovery = runtime.getServerUrl().then((url) => {
      recoveredUrl = url
    })
    await Promise.resolve()
    expect(recoveredUrl).toBeNull()

    releaseReplacementHealth()
    await recovery
    expect(recoveredUrl).toBe('http://127.0.0.1:49322')
    expect(sidecarMocks.adapterChildren).toHaveLength(10)
  })

  it('keeps demand recovery available after an immediate restart fails transiently', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const runtime = createRuntime()
    await runtime.startServer()
    let replacementAttempts = 0
    sidecarMocks.waitForServerImpl = () => {
      replacementAttempts += 1
      return replacementAttempts === 1
        ? Promise.reject(new Error('port release race'))
        : Promise.resolve()
    }

    sidecarMocks.serverChildren[0]!.emit('exit', 24, null)
    await waitForServerChildren(2)
    await waitForMockCalls(sidecarMocks.serverChildren[1]!.kill, 1)

    await expect(runtime.getServerUrl()).resolves.toBe('http://127.0.0.1:49323')
    expect(sidecarMocks.serverChildren).toHaveLength(3)
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining('failed to restart server sidecar after exit'),
    )
  })

  it('opens a circuit after three consecutive automatic restarts', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    let now = 0
    const restartDelays: number[] = []
    const runtime = createRuntime({
      now: () => now,
      sleep: async (delayMs) => {
        restartDelays.push(delayMs)
        now += delayMs
      },
    })
    await runtime.startServer()

    for (let crash = 0; crash < 3; crash++) {
      sidecarMocks.serverChildren[crash]!.emit('exit', 30 + crash, null)
      await waitForServerChildren(crash + 2)
    }
    sidecarMocks.serverChildren[3]!.emit('exit', 33, null)
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(sidecarMocks.serverChildren).toHaveLength(4)
    await expect(runtime.getServerUrl()).rejects.toThrow('automatic restart paused')
    expect(restartDelays).toEqual([250, 1_000])
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining('automatic restart paused after 3 consecutive crashes'),
    )

    now += 60_000
    await expect(runtime.getServerUrl()).resolves.toBe('http://127.0.0.1:49325')
    expect(sidecarMocks.serverChildren).toHaveLength(5)
  })

  it('resets the automatic restart budget after a stable server window', async () => {
    let now = 0
    const restartDelays: number[] = []
    const runtime = createRuntime({
      now: () => now,
      sleep: async (delayMs) => {
        restartDelays.push(delayMs)
      },
    })
    await runtime.startServer()

    sidecarMocks.serverChildren[0]!.emit('exit', 40, null)
    await waitForServerChildren(2)
    now = 60_000
    sidecarMocks.serverChildren[1]!.emit('exit', 41, null)
    await waitForServerChildren(3)

    expect(restartDelays).toEqual([])
  })

  it('cancels a delayed automatic restart when the runtime stops', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    let releaseBackoff!: () => void
    const sleep = vi.fn(() => new Promise<void>(resolve => {
      releaseBackoff = resolve
    }))
    const runtime = createRuntime({ now: () => 0, sleep })
    await runtime.startServer()

    sidecarMocks.serverChildren[0]!.emit('exit', 42, null)
    await waitForServerChildren(2)
    sidecarMocks.serverChildren[1]!.emit('exit', 43, null)
    await waitForMockCalls(sleep, 1)
    runtime.stopAll()
    releaseBackoff()
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(sidecarMocks.serverChildren).toHaveLength(2)
  })

  it('stops active adapters immediately when the server emits a process error', async () => {
    const runtime = createRuntime()
    await runtime.startServer()
    const activeAdapters = [...sidecarMocks.adapterChildren]

    sidecarMocks.serverChildren[0]!.emit('error', new Error('active server failed'))
    await waitForServerChildren(2)

    for (const adapter of activeAdapters) {
      expect(adapter.kill).toHaveBeenCalledTimes(1)
    }
  })

  it('does not let a stale server exit stop replacement adapters', async () => {
    const runtime = createRuntime()
    await runtime.startServer()
    const firstServer = sidecarMocks.serverChildren[0]!
    firstServer.emit('exit', 20, null)
    await runtime.getServerUrl()
    const replacementAdapters = sidecarMocks.adapterChildren.slice(5)

    firstServer.emit('exit', 21, 'SIGTERM')

    expect(replacementAdapters).toHaveLength(5)
    for (const adapter of replacementAdapters) {
      expect(adapter.kill).not.toHaveBeenCalled()
    }
  })

  it('stops the current adapter generation after an explicit adapter restart', async () => {
    const runtime = createRuntime()
    await runtime.startServer()
    const firstAdapters = [...sidecarMocks.adapterChildren]

    await runtime.restartAdaptersSidecars()
    const restartedAdapters = sidecarMocks.adapterChildren.slice(5)
    sidecarMocks.serverChildren[0]!.emit('exit', 22, null)
    await waitForServerChildren(2)

    for (const adapter of firstAdapters) {
      expect(adapter.kill).toHaveBeenCalledTimes(1)
    }
    for (const adapter of restartedAdapters) {
      expect(adapter.kill).toHaveBeenCalledTimes(1)
    }
  })

  it('coalesces overlapping manual adapter restarts into one live generation', async () => {
    const runtime = createRuntime()
    await runtime.startServer()
    const originalAdapters = [...sidecarMocks.adapterChildren]

    const firstRestart = runtime.restartAdaptersSidecars()
    const secondRestart = runtime.restartAdaptersSidecars()

    expect(secondRestart).toBe(firstRestart)
    await Promise.all([firstRestart, secondRestart])
    expect(sidecarMocks.adapterChildren).toHaveLength(10)
    for (const adapter of originalAdapters) {
      expect(adapter.kill).toHaveBeenCalledTimes(1)
    }
    for (const adapter of sidecarMocks.adapterChildren.slice(5)) {
      expect(adapter.kill).not.toHaveBeenCalled()
    }
  })

  it('cancels a manual adapter restart when its server exits after the first spawn', async () => {
    const runtime = createRuntime()
    await runtime.startServer()
    const firstServer = sidecarMocks.serverChildren[0]!
    const originalAdapters = [...sidecarMocks.adapterChildren]
    sidecarMocks.onAdapterSpawn = () => {
      sidecarMocks.onAdapterSpawn = null
      firstServer.emit('exit', 23, null)
    }

    await runtime.restartAdaptersSidecars()

    expect(sidecarMocks.adapterChildren).toHaveLength(6)
    for (const adapter of originalAdapters) {
      expect(adapter.kill).toHaveBeenCalledTimes(1)
    }
    expect(sidecarMocks.adapterChildren[5]!.kill).toHaveBeenCalledTimes(1)

    await expect(runtime.getServerUrl()).resolves.toBe('http://127.0.0.1:49322')
    expect(sidecarMocks.serverChildren).toHaveLength(2)
    expect(sidecarMocks.adapterChildren).toHaveLength(11)
    for (const adapter of sidecarMocks.adapterChildren.slice(6)) {
      expect(adapter.kill).not.toHaveBeenCalled()
    }
  })

  it('rejects when the published child exits during adapter startup', async () => {
    const runtime = createRuntime()
    sidecarMocks.onAdapterSpawn = () => {
      sidecarMocks.onAdapterSpawn = null
      sidecarMocks.serverChildren[0]!.emit('exit', 18, 'SIGTERM')
    }

    await expect(runtime.startServer()).rejects.toThrow('code=18, signal=SIGTERM')

    expect(sidecarMocks.adapterChildren).toHaveLength(1)
    expect(sidecarMocks.adapterChildren[0]!.kill).toHaveBeenCalledTimes(1)

    await expect(runtime.getServerUrl()).resolves.toBe('http://127.0.0.1:49322')
    expect(sidecarMocks.serverChildren).toHaveLength(2)
    expect(sidecarMocks.adapterChildren).toHaveLength(6)
    for (const adapter of sidecarMocks.adapterChildren.slice(1)) {
      expect(adapter.kill).not.toHaveBeenCalled()
    }
  })

  it('handles an asynchronous child process error without crashing Electron', async () => {
    sidecarMocks.waitForServerImpl = () => new Promise(() => undefined)
    const runtime = createRuntime({
      diagnosticsFile: '/isolated/user-data/diagnostics/electron-host.log',
    })

    const starting = runtime.startServer()
    await waitForServerChildren(1)
    expect(() => sidecarMocks.serverChildren[0]!.emit(
      'error',
      new Error('spawn error OPENAI_API_KEY=unsafe-value'),
    )).not.toThrow()

    const rejection = await starting.then(
      () => null,
      error => error as Error,
    )
    expect(rejection?.message).toContain('spawn error')
    expect(rejection?.message).not.toContain('unsafe-value')
    expect(sidecarMocks.appendHostDiagnostic).toHaveBeenCalledWith(
      '/isolated/user-data/diagnostics/electron-host.log',
      expect.stringContaining('[process-error] sidecar process error: spawn error'),
    )
  })
})
