import { expect, test } from 'bun:test'
import type { ServerWebSocket } from 'bun'
import { ApiClient, type FetchAdapter } from './client'
import { connectHost } from './connectHost'
import { buildSocketOptions, parseConnectionInput } from './connection'
import { SessionTransport, type SocketLike } from './sessionTransport'
import { HostRepository, type Storage } from '../state/storage'
import { connectionBlocker, needsToken, receivedConnection } from '../ui/connect/connectForm'

const token = 'h5_http_fixture_only'
const origin = 'http://workstation.fixture.ts.net'
const LoopbackSocket = WebSocket as unknown as new (
  url: string, options: { headers?: Record<string, string> }
) => SocketLike
const inputs = (url: string) => [
  `${url}/`,
  JSON.stringify({ serverUrl: `${url}/`, h5Token: token }),
  `${url}/?serverUrl=${encodeURIComponent(url)}&h5Token=${token}`,
]
const storage = (values: Map<string, string>): Storage => ({
  getItem: async key => values.get(key) ?? null,
  setItem: async (key, value) => { values.set(key, value) },
  removeItem: async key => { values.delete(key) },
})
async function until(check: () => boolean, label: string) {
  const deadline = Date.now() + 3000
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(`Timed out: ${label}`)
    await Bun.sleep(5)
  }
}

test.each(inputs(origin))('manual and QR HTTP input keeps its scheme and token connection: %s', value => {
  expect(parseConnectionInput(value)).toMatchObject({ url: origin, auth: 'lan' })
  expect(receivedConnection(value)).toMatchObject({ address: value, mode: 'lan' })
  expect(connectionBlocker('lan', value)).toBe('')
  expect(needsToken('lan', value)).toBe(value === `${origin}/`)
})

test.each([origin, 'http://100.101.102.103:60506', 'http://nas:60506'])('version 1 host metadata restores HTTP without changing credentials or schema: %s', async url => {
  const host = { id: 'http-fixture', name: 'Fixture', url, auth: 'lan' as const }
  const raw = JSON.stringify({ version: 1, hosts: [host], selectedId: host.id })
  const metadata = new Map([['cc-haha.hosts', raw]])
  const secrets = new Map([[`cc-haha.host.${host.id}`, token]])
  const repository = new HostRepository(storage(metadata), storage(secrets))
  expect((await repository.load()).hosts).toEqual([host])
  expect(metadata.get('cc-haha.hosts')).toBe(raw)
  expect(await repository.credential(host.id)).toBe(token)
  expect(buildSocketOptions(host, token, 'session', 'native')).toEqual({
    url: `${url.replace('http:', 'ws:')}/ws/session?media=ref`,
    headers: { Authorization: `Bearer ${token}`, Origin: '' },
  })
})

test('HTTP manual/QR verification, save/reload, REST and reconnect preserve the address and bearer contract over a loopback fixture', async () => {
  const sockets = new Set<ServerWebSocket<unknown>>()
  const seen: { url: string; authorization: string | null }[] = []
  const page = { messages: [], page: { sourceVersion: 'fixture-v1', nextCursor: null, hasMore: false, historyComplete: true } }
  const server = Bun.serve({
    hostname: '127.0.0.1', port: 0,
    fetch(request, server) {
      const url = new URL(request.url)
      seen.push({ url: request.url, authorization: request.headers.get('Authorization') })
      if (request.headers.get('Authorization') !== `Bearer ${token}`)
        return Response.json({ error: 'Fixture token rejected' }, { status: 401 })
      if (url.pathname === '/ws/session') {
        if (server.upgrade(request)) return
        return new Response('Upgrade failed', { status: 400 })
      }
      if (url.pathname === '/api/h5-access/verify' && request.method === 'POST')
        return Response.json({ ok: true })
      if (url.pathname === '/api/sessions/session/messages') return Response.json(page)
      return new Response('Not found', { status: 404 })
    },
    websocket: {
      open(socket) { sockets.add(socket) },
      close(socket) { sockets.delete(socket) },
      message(socket, data) {
        if (JSON.parse(String(data)).type !== 'sync_state') return
        socket.send(JSON.stringify({ type: 'connected', sessionId: 'session' }))
        socket.send(JSON.stringify({ type: 'permission_requests_snapshot', toolRequestIds: [], computerUseRequestIds: [], turnActive: false }))
        socket.send(JSON.stringify({ type: 'session_state', turnState: 'idle', activeBackgroundTaskIds: [] }))
      },
    },
  })
  const customOrigin = `${origin}:${server.port}`
  const fetchUrls: string[] = []
  // Test-only authority mapping keeps all traffic on loopback: no DNS/Tailscale
  // changes or native transport claims. Production receives the .ts.net URL.
  const fetch: FetchAdapter = async (input, init) => {
    const url = new URL(input)
    fetchUrls.push(input)
    expect(url.origin).toBe(customOrigin)
    expect(url.protocol).toBe('http:')
    const response = await globalThis.fetch(`http://127.0.0.1:${server.port}${url.pathname}${url.search}`, init)
    return {
      ok: response.ok, status: response.status, redirected: response.redirected,
      // The authority mapping is a fixture transport, not a server redirect.
      url: input, text: () => response.text(),
    }
  }
  let transport: SessionTransport | undefined
  try {
    for (const platform of ['ios', 'android']) {
      for (const value of inputs(customOrigin)) {
        const result = await connectHost({
          value, token, name: 'Fixture', id: 'http-fixture', platform,
          signal: new AbortController().signal, onStatus() {},
        }, { client: (host, credential) => new ApiClient(host, credential, { fetch }) })
        expect(result.host).toMatchObject({ url: customOrigin, auth: 'lan' })
        const metadata = new Map<string, string>()
        const secrets = new Map<string, string>()
        const repository = new HostRepository(storage(metadata), storage(secrets))
        await repository.add(result.host, result.credential)
        const host = (await repository.load()).hosts[0]!
        expect(host.url).toBe(customOrigin)
        expect(metadata.get('cc-haha.hosts')).not.toContain(token)
        const credential = (await repository.credential(host.id))!
        const client = new ApiClient(host, credential, { fetch })
        expect(await client.history('session')).toMatchObject(page)
        await expect(new ApiClient(host, 'wrong-fixture-token', { fetch }).verify())
          .rejects.toMatchObject({ status: 401, message: 'Fixture token rejected' })
      }
    }
    const client = new ApiClient({ id: 'http-fixture', name: 'Fixture', url: customOrigin, auth: 'lan' }, token, { fetch })
    const socketOptions: { url: string; headers?: Record<string, string> }[] = []
    const errors: Error[] = []
    transport = new SessionTransport({
      client, credential: token, sessionId: 'session', platform: 'native',
      socketFactory(options) {
        socketOptions.push(options)
        expect(options).toEqual({
          url: `${customOrigin.replace('http:', 'ws:')}/ws/session?media=ref`,
          headers: { Authorization: `Bearer ${token}`, Origin: '' },
        })
        return new LoopbackSocket(options.url.replace('workstation.fixture.ts.net', '127.0.0.1'), { headers: options.headers })
      },
      onState() {}, onConnection() {}, onError(error) { errors.push(error) },
    })
    transport.start()
    await until(() => transport?.connection === 'ready', 'initial socket ready')
    for (const socket of sockets) socket.close(1012, 'Fixture reconnect')
    await until(() => socketOptions.length === 2 && transport?.connection === 'ready', 'HTTP socket reconnect ready')
    expect(socketOptions[1]).toEqual(socketOptions[0])
    expect(errors).toEqual([])
    expect(fetchUrls.length).toBeGreaterThan(0)
    expect(seen.every(request => new URL(request.url).hostname === '127.0.0.1')).toBe(true)
    expect(seen.filter(request => new URL(request.url).pathname === '/ws/session')).toHaveLength(2)
    expect(seen.filter(request => new URL(request.url).pathname === '/ws/session').every(request => request.authorization === `Bearer ${token}`)).toBe(true)
  } finally {
    transport?.dispose()
    for (const socket of sockets) socket.close()
    await server.stop(true)
  }
}, 10000)
