import { afterAll, afterEach, beforeAll, beforeEach, expect, mock, test } from 'bun:test'
import * as gracefulShutdownModule from '../utils/gracefulShutdown.js'

/**
 * Issue #1485: when the desktop server rejects a CLI's SDK socket for good (it
 * replaced that runtime, deleted its session, or restarted without it), ending
 * the input is not enough — a run still waiting on a background task (a dev
 * server, a watcher) keeps the process, its MCP servers and its shells alive
 * with nothing left to observe or stop them. The CLI has to shut down.
 *
 * Drives the real RemoteIO and WebSocketTransport over loopback; only the
 * process exit is intercepted.
 */

// Copied before mocking: bun's mock.module is process-wide, so the real module
// is put back afterwards for any file sharing this process.
const realGracefulShutdown = { ...gracefulShutdownModule }
const shutdowns: Array<[number | undefined, string | undefined]> = []
mock.module('../utils/gracefulShutdown.js', () => ({
  ...realGracefulShutdown,
  gracefulShutdown: async (exitCode?: number, reason?: string) => {
    shutdowns.push([exitCode, reason])
  },
}))
const { RemoteIO } = await import('./remoteIO.js')

const proxyEnvKeys = ['no_proxy', 'NO_PROXY'] as const
const savedProxyEnv = new Map<string, string | undefined>()
let server: ReturnType<typeof Bun.serve>
let rejectWith = 4003
let upgrades = 0
let io: InstanceType<typeof RemoteIO> | undefined

beforeAll(() => {
  // A developer HTTP(S)_PROXY must not capture the loopback socket.
  for (const key of proxyEnvKeys) {
    savedProxyEnv.set(key, process.env[key])
    process.env[key] = '127.0.0.1,localhost'
  }
  server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(req, srv) {
      upgrades++
      return srv.upgrade(req) ? undefined : new Response('upgrade failed', { status: 400 })
    },
    websocket: {
      open(ws) {
        ws.close(rejectWith, 'Invalid SDK token')
      },
      message() {},
    },
  })
})

beforeEach(() => {
  shutdowns.length = 0
  upgrades = 0
})

afterEach(() => {
  io?.close()
  io = undefined
})

afterAll(() => {
  server.stop(true)
  for (const key of proxyEnvKeys) {
    const value = savedProxyEnv.get(key)
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  mock.module('../utils/gracefulShutdown.js', () => realGracefulShutdown)
})

async function waitFor(condition: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (condition()) return true
    await Bun.sleep(25)
  }
  return condition()
}

test('a CLI whose SDK socket the server rejects for good shuts down', async () => {
  rejectWith = 4003
  io = new RemoteIO(`ws://127.0.0.1:${server.port}/sdk/forgotten-runtime?token=retired`)

  expect(await waitFor(() => shutdowns.length > 0, 3_000)).toBe(true)
  expect(shutdowns).toEqual([[0, 'other']])
  expect(upgrades).toBe(1)
})

test('a connection drop the transport retries does not shut the CLI down', async () => {
  rejectWith = 1011
  io = new RemoteIO(`ws://127.0.0.1:${server.port}/sdk/live-runtime?token=current`)

  // The retry (about a second later) proves the transport did not give up.
  expect(await waitFor(() => upgrades >= 2, 3_000)).toBe(true)
  expect(shutdowns).toEqual([])
})
