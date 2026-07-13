import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SidecarChild, SidecarPlan } from './sidecarManager'
import { ElectronServerRuntime } from './serverRuntime'

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

function createRuntime(options: { appRoot?: string, diagnosticsFile?: string } = {}) {
  return new ElectronServerRuntime({
    desktopRoot: '/isolated/desktop',
    appRoot: options.appRoot,
    diagnosticsFile: options.diagnosticsFile,
    env: { CLAUDE_CONFIG_DIR: isolatedConfigDir },
    deps: {
      appendHostDiagnostic: sidecarMocks.appendHostDiagnostic,
      preferredServerPorts: () => [],
      reserveServerPort: async () => sidecarMocks.nextPort++,
      spawnSidecar: sidecarMocks.spawnSidecar,
      waitForServer: async () => await sidecarMocks.waitForServerImpl(),
      writeLastServerPort: () => undefined,
    },
  })
}

async function waitForServerChildren(count: number): Promise<void> {
  for (let attempt = 0; attempt < 20 && sidecarMocks.serverChildren.length !== count; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 0))
  }
  expect(sidecarMocks.serverChildren).toHaveLength(count)
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

  it('shares one unguessable local access token with server, adapters, and renderer', async () => {
    const runtime = createRuntime()

    await runtime.startServer()

    const token = runtime.getLocalAccessToken()
    expect(token.length).toBeGreaterThanOrEqual(32)
    expect(sidecarMocks.serverPlans[0]!.env.CC_HAHA_LOCAL_ACCESS_TOKEN).toBe(token)
    for (const adapter of sidecarMocks.spawnSidecar.mock.calls
      .map(([plan]) => plan)
      .filter(plan => plan.args[0] === 'adapters')) {
      expect(adapter.env.CC_HAHA_LOCAL_ACCESS_TOKEN).toBe(token)
    }
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

  it('stops active adapters immediately when the server exits without restart demand', async () => {
    const runtime = createRuntime()
    await runtime.startServer()
    const activeAdapters = [...sidecarMocks.adapterChildren]

    sidecarMocks.serverChildren[0]!.emit('exit', 19, null)

    for (const adapter of activeAdapters) {
      expect(adapter.kill).toHaveBeenCalledTimes(1)
    }
    expect(sidecarMocks.serverChildren).toHaveLength(1)
  })

  it('stops active adapters immediately when the server emits a process error', async () => {
    const runtime = createRuntime()
    await runtime.startServer()
    const activeAdapters = [...sidecarMocks.adapterChildren]

    sidecarMocks.serverChildren[0]!.emit('error', new Error('active server failed'))

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
