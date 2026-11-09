import { createServer, request } from 'node:http'
import type { AddressInfo } from 'node:net'

/** A host name that never resolves: only a proxied request can reach the fixture. */
export const UNREACHABLE_MCP_HOST = 'mcp.blocked.test'

type JsonRpcMessage = { id?: number | string, method?: string, params?: { protocolVersion?: string } }

function replyTo(message: JsonRpcMessage): Record<string, unknown> | undefined {
  if (message.id === undefined) return undefined
  if (message.method === 'initialize') {
    return { jsonrpc: '2.0', id: message.id, result: {
      protocolVersion: message.params?.protocolVersion ?? '2025-03-26',
      capabilities: { tools: {} },
      serverInfo: { name: 'proxy-fixture', version: '1.0.0' },
    } }
  }
  if (message.method === 'tools/list') {
    return { jsonrpc: '2.0', id: message.id, result: { tools: [
      { name: 'echo', description: 'Echo a value', inputSchema: { type: 'object', properties: {} } },
    ] } }
  }
  return { jsonrpc: '2.0', id: message.id, result: {} }
}

export type McpFixture = { port: number, methods: string[], stop(): Promise<void> }

/**
 * Streamable HTTP MCP server with one tool. It answers GET with 405. A 202 for
 * notifications/initialized makes the SDK try its GET stream right after
 * connecting; pass openGetStream: false to answer 200 so it never does.
 */
export function startStreamableMcpServer(options: { openGetStream?: boolean } = {}): McpFixture {
  const methods: string[] = []
  const notificationStatus = options.openGetStream === false ? 200 : 202
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) {
      if (req.method !== 'POST') return new Response(null, { status: 405 })
      const message = await req.json() as JsonRpcMessage
      methods.push(message.method ?? '')
      const reply = replyTo(message)
      return reply ? Response.json(reply) : new Response(null, { status: notificationStatus })
    },
  })
  return { port: server.port!, methods, stop: () => server.stop(true) }
}

/** Legacy SSE MCP server: GET /sse streams replies to POST /messages. */
export function startLegacySseMcpServer(): McpFixture {
  const methods: string[] = []
  const encoder = new TextEncoder()
  const streams = new Set<ReadableStreamDefaultController<Uint8Array>>()
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    idleTimeout: 0,
    async fetch(req) {
      const { pathname } = new URL(req.url)
      if (req.method === 'GET' && pathname === '/sse') {
        let controller: ReadableStreamDefaultController<Uint8Array> | undefined
        const stream = new ReadableStream<Uint8Array>({
          start(next) {
            controller = next
            streams.add(next)
            next.enqueue(encoder.encode('event: endpoint\ndata: /messages\n\n'))
          },
          cancel() {
            if (controller) streams.delete(controller)
          },
        })
        return new Response(stream, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' } })
      }
      if (req.method === 'POST' && pathname === '/messages') {
        const message = await req.json() as JsonRpcMessage
        methods.push(message.method ?? '')
        const reply = replyTo(message)
        if (reply) {
          for (const stream of streams) stream.enqueue(encoder.encode(`event: message\ndata: ${JSON.stringify(reply)}\n\n`))
        }
        return new Response('Accepted', { status: 202 })
      }
      return new Response(null, { status: 404 })
    },
  })
  return {
    port: server.port!,
    methods,
    async stop() {
      for (const stream of streams) {
        try { stream.close() } catch { /* already closed */ }
      }
      await server.stop(true)
    },
  }
}

export type RecordingProxy = { url: string, requests: string[], close(): Promise<void> }

/**
 * Forward proxy that records each request line and forwards
 * UNREACHABLE_MCP_HOST to a loopback port. CONNECT tunnels are recorded and
 * refused, which is enough to show an HTTPS request chose this proxy.
 */
export async function startRecordingProxy(targetPort: number): Promise<RecordingProxy> {
  const requests: string[] = []
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
    req.pipe(upstream)
  })
  proxy.on('connect', (req, socket) => {
    requests.push(`CONNECT ${req.url}`)
    socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n')
  })
  await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve))
  const { port } = proxy.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((resolve) => {
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
