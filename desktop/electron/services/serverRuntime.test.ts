import { describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'

async function runIsolated(script: string) {
  const child = spawn('bun', ['-e', script], {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', chunk => {
    stdout += chunk
  })
  child.stderr.on('data', chunk => {
    stderr += chunk
  })

  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.on('error', reject)
    child.on('exit', code => resolve(code))
  })
  return { stdout, stderr, exitCode }
}

const harness = String.raw`
  import { mock } from 'bun:test'
  import { EventEmitter } from 'node:events'

  function assert(condition, message) {
    if (!condition) throw new Error(message)
  }

  function assertEqual(actual, expected, message) {
    const actualJson = JSON.stringify(actual)
    const expectedJson = JSON.stringify(expected)
    if (actualJson !== expectedJson) {
      throw new Error(message + '\nExpected: ' + expectedJson + '\nReceived: ' + actualJson)
    }
  }

  const state = {
    serverChild: null,
    tunnelChildren: [],
    reportPayloads: [],
    fetchMock: null,
  }

  function makeChild(pid) {
    return Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      pid,
    })
  }

  async function waitForTunnelChild(index, timeoutMs = 1000) {
    const deadline = Date.now() + timeoutMs
    while (state.tunnelChildren.length <= index) {
      if (Date.now() > deadline) throw new Error('tunnel child ' + index + ' never spawned')
      await new Promise((r) => setTimeout(r, 5))
    }
    return state.tunnelChildren[index]
  }

  mock.module('./electron/services/sidecarManager.ts', () => ({
    SERVER_BIND_HOST: '0.0.0.0',
    SERVER_CONTROL_HOST: '127.0.0.1',
    createAdapterPlan: () => ({ command: '/fake', args: [], env: {} }),
    createServerPlan: () => ({ command: '/fake', args: [], env: {} }),
    createTunnelPlan: ({ mode }) => ({
      command: '/fake/cloudflared',
      args: ['--mode', mode],
      env: {},
    }),
    formatStartupError: (msg) => msg,
    killSidecar: () => {},
    mergeProxyEnv: (env) => env,
    POWERSHELL_PATH_OVERRIDE_ENV: 'CLAUDE_CODE_POWERSHELL_PATH',
    preferredServerPorts: () => [],
    proxyUrlFromElectronProxyRules: () => undefined,
    pushStartupLog: () => {},
    reserveServerPort: async () => 28670,
    resolveCloudflaredPath: () => '/fake/cloudflared',
    spawnSidecar: () => {
      const child = makeChild(1000)
      state.serverChild = child
      return child
    },
    spawnTunnel: () => {
      const pid = 2000 + state.tunnelChildren.length
      const child = makeChild(pid)
      child.emitUrl = (url) => child.stderr.emit('data', 'inf | INF Your quick Tunnel: ' + url + '\n')
      state.tunnelChildren.push(child)
      return child
    },
    waitForServer: async () => undefined,
    waitForTunnelUrl: async (child) => {
      return new Promise((resolve, reject) => {
        const onData = (chunk) => {
          const match = String(chunk).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i)
          if (match) {
            child.stderr.off('data', onData)
            resolve(match[0])
          }
        }
        child.stderr.on('data', onData)
        child.on('exit', () => reject(new Error('cloudflared exited before URL')))
      })
    },
    windowsPowerShellOverride: () => null,
    writeLastServerPort: () => {},
  }))

  mock.module('./electron/services/terminal.ts', () => ({
    readDesktopTerminalConfig: () => undefined,
    resolveDesktopTerminalShell: () => null,
  }))

  const originalFetch = globalThis.fetch

  async function withRuntime(fn) {
    state.serverChild = null
    state.tunnelChildren = []
    state.reportPayloads = []
    state.fetchMock = async (_url, init) => {
      if (init?.body && typeof init.body === 'string') {
        state.reportPayloads.push(JSON.parse(init.body))
      }
      return new Response(null, { status: 200 })
    }
    globalThis.fetch = state.fetchMock
    try {
      const { ElectronServerRuntime } = await import('./electron/services/serverRuntime.ts')
      const runtime = new ElectronServerRuntime({ desktopRoot: '/fake/desktop' })
      await runtime.startServer()
      await fn(runtime)
    } finally {
      globalThis.fetch = originalFetch
    }
  }
`

async function expectIsolatedPass(script: string) {
  const result = await runIsolated(`${harness}\n${script}`)
  expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0)
}

describe('ElectronServerRuntime tunnel lifecycle', () => {
  it('restarts the tunnel cleanly: stop -> start yields a fresh URL, not the stale one', async () => {
    await expectIsolatedPass(String.raw`
      await withRuntime(async (runtime) => {
        const first = runtime.startTunnel({ mode: 'quick' })
        const child0 = await waitForTunnelChild(0)
        child0.emitUrl('https://owner-standards-answered-staff.trycloudflare.com')
        const firstStatus = await first
        assertEqual(firstStatus, {
          status: 'running',
          url: 'https://owner-standards-answered-staff.trycloudflare.com',
          mode: 'quick',
          error: null,
        }, 'first tunnel status mismatch')

        const stop = runtime.stopTunnel()
        state.tunnelChildren[0].emit('exit', 0, null)
        await stop
        assertEqual(runtime.getTunnelStatus(), { status: 'idle', url: null, mode: null, error: null }, 'stop status mismatch')

        const second = runtime.startTunnel({ mode: 'quick' })
        const child1 = await waitForTunnelChild(1)
        child1.emitUrl('https://aaaa-bbbb-cccc-dddd.trycloudflare.com')
        const secondStatus = await second
        assert(secondStatus.url === 'https://aaaa-bbbb-cccc-dddd.trycloudflare.com', 'second status returned stale URL')
        assert(runtime.getTunnelStatus().url === 'https://aaaa-bbbb-cccc-dddd.trycloudflare.com', 'runtime status returned stale URL')

        const lastRunning = [...state.reportPayloads].reverse().find((p) => p.status === 'running')
        assert(lastRunning?.url === 'https://aaaa-bbbb-cccc-dddd.trycloudflare.com', 'last running report returned stale URL')
      })
    `)
  })

  it('stopTunnel asks the server to clear (not just report idle), so the runtime URL is wiped on the server side', async () => {
    await expectIsolatedPass(String.raw`
      await withRuntime(async (runtime) => {
        const first = runtime.startTunnel({ mode: 'quick' })
        const child0 = await waitForTunnelChild(0)
        child0.emitUrl('https://stale.trycloudflare.com')
        await first

        const urlsHit = []
        globalThis.fetch = async (url, init) => {
          urlsHit.push(String(url))
          if (init?.body && typeof init.body === 'string') {
            state.reportPayloads.push(JSON.parse(init.body))
          }
          return new Response(null, { status: 200 })
        }

        const stop = runtime.stopTunnel()
        child0.emit('exit', 0, null)
        await stop

        assert(urlsHit.some((url) => url.endsWith('/api/h5-access/tunnel/clear')), 'stopTunnel did not call /api/h5-access/tunnel/clear')
      })
    `)
  })

  it('a delayed exit from the previous cloudflared does not clobber a running new tunnel', async () => {
    await expectIsolatedPass(String.raw`
      await withRuntime(async (runtime) => {
        const first = runtime.startTunnel({ mode: 'quick' })
        const oldChild = await waitForTunnelChild(0)
        oldChild.emitUrl('https://old.trycloudflare.com')
        await first

        const second = runtime.startTunnel({ mode: 'quick' })
        const newChild = await waitForTunnelChild(1)
        newChild.emitUrl('https://new.trycloudflare.com')
        await second
        assert(runtime.getTunnelStatus().url === 'https://new.trycloudflare.com', 'new tunnel did not start')

        oldChild.emit('exit', 0, null)
        await new Promise((resolve) => setTimeout(resolve, 10))
        assert(runtime.getTunnelStatus().url === 'https://new.trycloudflare.com', 'old exit clobbered new URL')
        assert(runtime.getTunnelStatus().status === 'running', 'old exit clobbered running status')
      })
    `)
  })
})
