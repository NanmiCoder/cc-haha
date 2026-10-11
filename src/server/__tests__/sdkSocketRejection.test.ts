import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { handleWebSocket, type WebSocketData } from '../ws/handler.js'
import { WebSocketTransport } from '../../cli/transports/WebSocketTransport.js'

/**
 * Issue #1485: a CLI the server no longer tracks (an overwritten startup, a
 * runtime that survived a stop, a server restart on a fixed port) must not live
 * forever. The server upgrades its SDK socket and then rejects the token; the
 * close code decides whether the CLI's transport retries. Every accepted
 * upgrade resets the transport's 10-minute give-up budget, so a retryable code
 * meant a reconnect about once a second for as long as the server ran.
 *
 * This drives the real handler with the real CLI transport over loopback.
 */

const proxyEnvKeys = ['no_proxy', 'NO_PROXY'] as const
const savedProxyEnv = new Map<string, string | undefined>()
let server: ReturnType<typeof Bun.serve<WebSocketData>>
let upgrades = 0
let transport: WebSocketTransport | undefined

beforeAll(() => {
  // A developer HTTP(S)_PROXY must not capture the loopback socket.
  for (const key of proxyEnvKeys) {
    savedProxyEnv.set(key, process.env[key])
    process.env[key] = '127.0.0.1,localhost'
  }
  server = Bun.serve<WebSocketData>({
    port: 0,
    hostname: '127.0.0.1',
    fetch(req, srv) {
      const url = new URL(req.url)
      if (!url.pathname.startsWith('/sdk/')) return new Response('not found', { status: 404 })
      upgrades++
      const upgraded = srv.upgrade(req, {
        data: {
          sessionId: url.pathname.split('/').pop() || '',
          connectedAt: Date.now(),
          channel: 'sdk',
          clientKind: 'full',
          sdkToken: url.searchParams.get('token'),
          serverPort: srv.port,
          serverHost: '127.0.0.1',
        },
      })
      return upgraded ? undefined : new Response('upgrade failed', { status: 400 })
    },
    websocket: handleWebSocket,
  })
})

afterEach(() => {
  transport?.close()
  transport = undefined
  upgrades = 0
})

afterAll(() => {
  server.stop(true)
  for (const key of proxyEnvKeys) {
    const value = savedProxyEnv.get(key)
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

async function waitFor(condition: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (condition()) return true
    await Bun.sleep(25)
  }
  return condition()
}

test('a CLI whose SDK token the server does not recognise shuts its transport down instead of reconnecting', async () => {
  const sessionId = `forgotten-runtime-${crypto.randomUUID()}`
  const closeCodes: Array<number | undefined> = []
  // RemoteIO passes a refreshHeaders that only re-reads a session ingress
  // token; desktop runtimes have none, so a 4003 cannot be refreshed away.
  transport = new WebSocketTransport(
    new URL(`ws://127.0.0.1:${server.port}/sdk/${sessionId}?token=stale-token`),
    {},
    sessionId,
    () => ({}),
  )
  transport.setOnClose(code => { closeCodes.push(code) })
  await transport.connect()

  const closed = await waitFor(() => closeCodes.length > 0, 2_500)
  const firstUpgrades = upgrades
  // A retryable close reconnects after ~1s (base delay with jitter, at most 1.25s).
  await Bun.sleep(1_600)

  expect({ closed, closeCodes, state: transport.getStateLabel(), upgrades }).toEqual({
    closed: true,
    closeCodes: [4003],
    state: 'closed',
    upgrades: firstUpgrades,
  })
  expect(upgrades).toBe(1)
})
