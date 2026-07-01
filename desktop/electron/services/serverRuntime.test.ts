import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import type { SidecarChild } from './sidecarManager'

// Hoisted mock state so vi.mock factories can share counters / fixtures across
// test cases without resorting to module-level globals.
const state = vi.hoisted(() => ({
  serverChild: null as (EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; pid?: number }) | null,
  tunnelChildren: [] as Array<EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; pid?: number; emitUrl?: (url: string) => void }>,
  reportPayloads: [] as Array<Record<string, unknown>>,
  fetchMock: vi.fn(),
}))

function makeChild(pid: number) {
  const child = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    pid,
  })
  return child as unknown as SidecarChild
}

// Wait until the runtime has actually spawned the Nth tunnel child. Avoids
// flaky "await Promise.resolve() N times" patterns when startTunnel's async
// path needs several microtasks to reach spawnTunnel.
async function waitForTunnelChild(index: number, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs
  while (state.tunnelChildren.length <= index) {
    if (Date.now() > deadline) throw new Error(`tunnel child ${index} never spawned`)
    await new Promise((r) => setTimeout(r, 5))
  }
  return state.tunnelChildren[index]!
}

vi.mock('./sidecarManager', () => {
  return {
    SERVER_BIND_HOST: '0.0.0.0',
    SERVER_CONTROL_HOST: '127.0.0.1',
    createAdapterPlan: vi.fn(() => ({ command: '/fake', args: [], env: {} })),
    createServerPlan: vi.fn(() => ({ command: '/fake', args: [], env: {} })),
    createTunnelPlan: vi.fn(({ mode }: { mode: 'quick' | 'named' }) => ({
      command: '/fake/cloudflared',
      args: ['--mode', mode],
      env: {},
    })),
    formatStartupError: (msg: string) => msg,
    killSidecar: vi.fn(),
    mergeProxyEnv: (env: NodeJS.ProcessEnv) => env,
    POWERSHELL_PATH_OVERRIDE_ENV: 'CLAUDE_CODE_POWERSHELL_PATH',
    preferredServerPorts: () => [],
    proxyUrlFromElectronProxyRules: () => undefined,
    pushStartupLog: () => {},
    reserveServerPort: async () => 28670,
    resolveCloudflaredPath: () => '/fake/cloudflared',
    spawnSidecar: vi.fn(() => {
      const c = makeChild(1000)
      state.serverChild = c as unknown as typeof state.serverChild
      return c
    }),
    spawnTunnel: vi.fn(() => {
      const pid = 2000 + state.tunnelChildren.length
      const c = makeChild(pid) as unknown as (typeof state.tunnelChildren)[number]
      c.emitUrl = (url: string) => c.stderr.emit('data', `inf | INF Your quick Tunnel: ${url}\n`)
      state.tunnelChildren.push(c)
      return c as unknown as SidecarChild
    }),
    waitForServer: vi.fn(async () => undefined),
    waitForTunnelUrl: vi.fn(async (child: SidecarChild) => {
      // Resolve when the mock test emits a URL onto the child stderr.
      return new Promise<string>((resolve, reject) => {
        const onData = (chunk: Buffer | string) => {
          const m = String(chunk).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i)
          if (m) {
            child.stderr.off('data', onData)
            resolve(m[0])
          }
        }
        child.stderr.on('data', onData)
        child.on('exit', () => reject(new Error('cloudflared exited before URL')))
      })
    }),
    windowsPowerShellOverride: () => null,
    writeLastServerPort: () => {},
  }
})

vi.mock('./terminal', () => ({
  readDesktopTerminalConfig: () => undefined,
  resolveDesktopTerminalShell: () => null,
}))

// Patch global fetch so reportTunnel calls don't hit the network — we capture
// the payloads to assert what the runtime told the server about each tunnel
// state transition.
const originalFetch = globalThis.fetch
beforeEach(() => {
  state.serverChild = null
  state.tunnelChildren = []
  state.reportPayloads = []
  state.fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.body && typeof init.body === 'string') {
      state.reportPayloads.push(JSON.parse(init.body))
    }
    return new Response(null, { status: 200 })
  })
  globalThis.fetch = state.fetchMock as unknown as typeof fetch
})

afterEach(() => {
  globalThis.fetch = originalFetch
  vi.clearAllMocks()
})

describe('ElectronServerRuntime tunnel lifecycle', () => {
  it('restarts the tunnel cleanly: stop -> start yields a fresh URL, not the stale one', async () => {
    const { ElectronServerRuntime } = await import('./serverRuntime')
    const runtime = new ElectronServerRuntime({ desktopRoot: '/fake/desktop' })
    await runtime.startServer()

    // First tunnel: emit a quick URL, runtime reports it as running.
    const first = runtime.startTunnel({ mode: 'quick' })
    const child0 = await waitForTunnelChild(0)
    child0.emitUrl!('https://owner-standards-answered-staff.trycloudflare.com')
    const firstStatus = await first
    expect(firstStatus).toEqual({
      status: 'running',
      url: 'https://owner-standards-answered-staff.trycloudflare.com',
      mode: 'quick',
      error: null,
    })

    // User clicks Stop. The first cloudflared "exits" right after killSidecar.
    const stop = runtime.stopTunnel()
    state.tunnelChildren[0]!.emit('exit', 0, null)
    await stop
    expect(runtime.getTunnelStatus()).toEqual({ status: 'idle', url: null, mode: null, error: null })

    // User clicks Start again. The OLD child's exit handler must NOT clobber
    // the new tunnel's running state or report a stale URL.
    const second = runtime.startTunnel({ mode: 'quick' })
    const child1 = await waitForTunnelChild(1)
    child1.emitUrl!('https://aaaa-bbbb-cccc-dddd.trycloudflare.com')
    const secondStatus = await second
    // CRITICAL: this must be the NEW URL, not the stale first one.
    expect(secondStatus.url).toBe('https://aaaa-bbbb-cccc-dddd.trycloudflare.com')
    expect(runtime.getTunnelStatus().url).toBe('https://aaaa-bbbb-cccc-dddd.trycloudflare.com')

    // The last status reported to the server must reflect the new URL too.
    const lastRunning = [...state.reportPayloads].reverse().find((p) => p.status === 'running')
    expect(lastRunning?.url).toBe('https://aaaa-bbbb-cccc-dddd.trycloudflare.com')
  })

  it('stopTunnel asks the server to clear (not just report idle), so the runtime URL is wiped on the server side', async () => {
    const { ElectronServerRuntime } = await import('./serverRuntime')
    const runtime = new ElectronServerRuntime({ desktopRoot: '/fake/desktop' })
    await runtime.startServer()

    const first = runtime.startTunnel({ mode: 'quick' })
    const child0 = await waitForTunnelChild(0)
    child0.emitUrl!('https://stale.trycloudflare.com')
    await first

    state.fetchMock.mockClear()
    state.reportPayloads.length = 0

    const stop = runtime.stopTunnel()
    child0.emit('exit', 0, null)
    await stop

    // Look at what stopTunnel actually told the server.
    const urlsHit = state.fetchMock.mock.calls.map((c: unknown[]) => String(c[0]))
    // The CRITICAL invariant: stopTunnel must reach an endpoint that wipes the
    // server-side runtime URL. /tunnel/clear is the contract for clearing
    // (POST'ing report with url:null is a no-op because the handler maps a
    // missing/null url to "don't touch"). So stopTunnel must call /tunnel/clear
    // — otherwise the old trycloudflare URL persists as the effective publicBaseUrl
    // and phones see Cloudflare error 1033 after the tunnel stops.
    expect(urlsHit.some((u: string) => u.endsWith('/api/h5-access/tunnel/clear'))).toBe(true)
  })

  it('a delayed exit from the previous cloudflared does not clobber a running new tunnel', async () => {
    const { ElectronServerRuntime } = await import('./serverRuntime')
    const runtime = new ElectronServerRuntime({ desktopRoot: '/fake/desktop' })
    await runtime.startServer()

    const first = runtime.startTunnel({ mode: 'quick' })
    const oldChild = await waitForTunnelChild(0)
    oldChild.emitUrl!('https://old.trycloudflare.com')
    await first

    // User immediately restarts; old child has NOT emitted exit yet (Windows
    // taskkill can be slow / async). startTunnel must replace the tunnel and
    // the stale exit must not bring us back to idle later.
    const second = runtime.startTunnel({ mode: 'quick' })
    const newChild = await waitForTunnelChild(1)
    newChild.emitUrl!('https://new.trycloudflare.com')
    await second
    expect(runtime.getTunnelStatus().url).toBe('https://new.trycloudflare.com')

    // Now the OLD child finally exits. The new running tunnel must survive.
    oldChild.emit('exit', 0, null)
    await new Promise((r) => setTimeout(r, 10))
    expect(runtime.getTunnelStatus().url).toBe('https://new.trycloudflare.com')
    expect(runtime.getTunnelStatus().status).toBe('running')
  })
})
