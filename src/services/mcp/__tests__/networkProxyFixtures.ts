import { spyOn } from 'bun:test'
import { createServer, request } from 'node:http'
import { connect, type AddressInfo, type Socket } from 'node:net'
import * as secureStorage from '../../../utils/secureStorage/index.js'
import { MCP_FIXTURE_CERT, MCP_FIXTURE_KEY } from './networkProxyTls.js'
export { MCP_FIXTURE_CERT }

/** A host name that never resolves: only a proxied request can reach the fixture. */
export const UNREACHABLE_MCP_HOST = 'mcp.blocked.test'

export function isolateMcpFixtureCredentials(): () => void {
  let credentials: Record<string, unknown> | null = null
  const storage = spyOn(secureStorage, 'getSecureStorage').mockReturnValue({
    name: 'mcp-network-fixture', read: () => credentials, readAsync: async () => credentials,
    update: (next: Record<string, unknown>) => {
      credentials = next
      return { success: true }
    },
    delete: () => {
      credentials = null
      return true
    },
  } as never)
  return () => storage.mockRestore()
}

type JsonRpcMessage = { id?: number | string, method?: string, params?: { protocolVersion?: string, arguments?: { value?: string } } }
type FixtureOptions = { openGetStream?: boolean, tls?: boolean, emptyTools?: boolean, status?: number }
export type FixtureRequest = { method: string, path: string, headers: Record<string, string>, rpc?: string }

function replyTo(message: JsonRpcMessage, options: FixtureOptions = {}): Record<string, unknown> | undefined {
  if (message.id === undefined) return undefined
  if (message.method === 'initialize') {
    return { jsonrpc: '2.0', id: message.id, result: {
      protocolVersion: message.params?.protocolVersion ?? '2025-03-26',
      capabilities: { tools: {} },
      serverInfo: { name: 'proxy-fixture', version: '1.0.0' },
    } }
  }
  if (message.method === 'tools/list') {
    return { jsonrpc: '2.0', id: message.id, result: { tools: options.emptyTools ? [] : [
      { name: 'echo', description: 'Echo a value', inputSchema: { type: 'object', properties: {} } },
    ] } }
  }
  if (message.method === 'tools/call') {
    return { jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: `echo:${message.params?.arguments?.value ?? ''}` }] } }
  }
  return { jsonrpc: '2.0', id: message.id, result: {} }
}

export type McpFixture = { port: number, methods: string[], requests: FixtureRequest[], activeStreams(): number, stop(): Promise<void> }

/**
 * Streamable HTTP MCP server with one callable tool and a real GET stream. A 202 for
 * notifications/initialized makes the SDK try its GET stream right after
 * connecting; pass openGetStream: false to answer 200 so it never does.
 */
export function startStreamableMcpServer(options: FixtureOptions = {}): McpFixture {
  const methods: string[] = []
  const requests: FixtureRequest[] = []
  const streams = new Set<ReadableStreamDefaultController<Uint8Array>>()
  const notificationStatus = options.openGetStream === false ? 200 : 202
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    idleTimeout: 0,
    ...(options.tls ? { tls: { cert: MCP_FIXTURE_CERT, key: MCP_FIXTURE_KEY } } : {}),
    async fetch(req) {
      const recorded: FixtureRequest = { method: req.method, path: new URL(req.url).pathname, headers: Object.fromEntries(req.headers) }
      requests.push(recorded)
      if (options.status) return Response.json({ error: 'fixture-credential-must-not-be-displayed' }, { status: options.status })
      if (req.method === 'GET' && options.openGetStream !== false) {
        let controller: ReadableStreamDefaultController<Uint8Array>
        return new Response(new ReadableStream<Uint8Array>({
          start(next) {
            controller = next
            streams.add(next)
            next.enqueue(new TextEncoder().encode(': fixture-stream-open\n\n'))
          },
          cancel() { streams.delete(controller) },
        }), { headers: { 'Content-Type': 'text/event-stream' } })
      }
      if (req.method !== 'POST') return new Response(null, { status: 405 })
      const message = await req.json() as JsonRpcMessage
      recorded.rpc = message.method
      methods.push(message.method ?? '')
      const reply = replyTo(message, options)
      return reply ? Response.json(reply) : new Response(null, { status: notificationStatus })
    },
  })
  return { port: server.port!, methods, requests, activeStreams: () => streams.size, async stop() {
    for (const stream of streams) { try { stream.close() } catch { /* cancelled */ } }
    streams.clear()
    await server.stop(true)
  } }
}

/** Legacy SSE MCP server: GET /sse streams replies to POST /messages. */
export function startLegacySseMcpServer(options: FixtureOptions = {}): McpFixture {
  const methods: string[] = []
  const requests: FixtureRequest[] = []
  const encoder = new TextEncoder()
  const streams = new Set<ReadableStreamDefaultController<Uint8Array>>()
  const sessions = new Map<string, ReadableStreamDefaultController<Uint8Array>>()
  let session = 0
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    idleTimeout: 0,
    ...(options.tls ? { tls: { cert: MCP_FIXTURE_CERT, key: MCP_FIXTURE_KEY } } : {}),
    async fetch(req) {
      const url = new URL(req.url)
      const { pathname } = url
      const recorded: FixtureRequest = { method: req.method, path: pathname, headers: Object.fromEntries(req.headers) }
      requests.push(recorded)
      if (options.status) return Response.json({ error: 'fixture-credential-must-not-be-displayed' }, { status: options.status })
      if (req.method === 'GET' && pathname === '/sse') {
        let controller: ReadableStreamDefaultController<Uint8Array> | undefined
        const id = String(++session)
        const stream = new ReadableStream<Uint8Array>({
          start(next) {
            controller = next
            streams.add(next)
            sessions.set(id, next)
            next.enqueue(encoder.encode(`event: endpoint\ndata: /messages?session=${id}\n\n`))
          },
          cancel() {
            if (controller) streams.delete(controller)
            sessions.delete(id)
          },
        })
        return new Response(stream, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' } })
      }
      if (req.method === 'POST' && pathname === '/messages') {
        const message = await req.json() as JsonRpcMessage
        recorded.rpc = message.method
        methods.push(message.method ?? '')
        const reply = replyTo(message, options)
        if (reply) {
          sessions.get(url.searchParams.get('session') ?? '')?.enqueue(encoder.encode(`event: message\ndata: ${JSON.stringify(reply)}\n\n`))
        }
        return new Response('Accepted', { status: 202 })
      }
      return new Response(null, { status: 404 })
    },
  })
  return {
    port: server.port!,
    methods,
    requests,
    activeStreams: () => streams.size,
    async stop() {
      for (const stream of streams) {
        try { stream.close() } catch { /* already closed */ }
      }
      streams.clear()
      sessions.clear()
      await server.stop(true)
    },
  }
}

export type RecordingProxy = { url: string, requests: string[], close(): Promise<void> }

/**
 * Forward proxy that records each request line and forwards
 * UNREACHABLE_MCP_HOST to a loopback port. TLS tests opt into a real CONNECT
 * tunnel; no target can forward anywhere outside loopback.
 */
export async function startRecordingProxy(targetPort: number, options: { tunnelTls?: boolean } = {}): Promise<RecordingProxy> {
  const requests: string[] = []
  const sockets = new Set<Socket>()
  const proxy = createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`)
    let target: URL
    try {
      target = new URL(req.url ?? '')
    } catch {
      res.writeHead(400).end()
      return
    }
    if (target.hostname !== UNREACHABLE_MCP_HOST) {
      res.writeHead(502).end()
      return
    }
    const upstream = request({
      host: '127.0.0.1',
      port: targetPort,
      method: req.method,
      path: `${target.pathname}${target.search}`,
      headers: { ...req.headers, host: `127.0.0.1:${targetPort}` },
    }, (reply) => {
      res.writeHead(reply.statusCode ?? 502, reply.headers)
      reply.pipe(res)
    })
    upstream.on('error', () => {
      if (!res.headersSent) res.writeHead(502)
      res.end()
    })
    res.on('close', () => upstream.destroy())
    req.pipe(upstream)
  })
  proxy.on('connection', socket => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  proxy.on('connect', (req, socket, head) => {
    requests.push(`CONNECT ${req.url}`)
    if (!options.tunnelTls || req.url !== `${UNREACHABLE_MCP_HOST}:443`) {
      socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n')
      return
    }
    const upstream = connect({ host: '127.0.0.1', port: targetPort }, () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.length) upstream.write(head)
      socket.pipe(upstream)
      upstream.pipe(socket)
    })
    sockets.add(upstream)
    upstream.on('close', () => {
      sockets.delete(upstream)
      socket.destroy()
    })
    upstream.on('error', () => socket.destroy())
    socket.on('close', () => upstream.destroy())
  })
  await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve))
  const { port } = proxy.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((resolve) => {
      for (const socket of sockets) socket.destroy()
      proxy.closeAllConnections()
      proxy.close(() => resolve())
    }),
  }
}

export async function waitFor(check: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for the proxy fixture')
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}
