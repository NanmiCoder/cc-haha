import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import type { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import type { AntigravityMcpServerConfig } from './antigravityAcp.js'

const MCP_PATH = '/mcp'

type McpSessionEntry = {
  server: Server
  transport: WebStandardStreamableHTTPServerTransport
}

export type AntigravityMcpHttpHostOptions = {
  serverName: string
  createServer: () => Server
  onBeforeClose?: () => Promise<void> | void
}

export type AntigravityMcpHttpHost = {
  readonly serverName: string
  readonly url: string
  readonly token: string
  readonly mcpServerConfig: AntigravityMcpServerConfig
  isClosed(): boolean
  close(): Promise<void>
}

function tokensEqual(expected: string, actual: string): boolean {
  const a = Buffer.from(expected, 'utf8')
  const b = Buffer.from(actual, 'utf8')
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/**
 * Per-session loopback Streamable HTTP host for injecting cc-haha MCP servers
 * into `agy acp`. Handles bearer auth, unauthenticated `/.well-known/*` probes,
 * `agy`'s pre-initialize `server/discover` RPC, and per-session transport cleanup.
 */
export function createAntigravityMcpHttpHost(
  options: AntigravityMcpHttpHostOptions,
): AntigravityMcpHttpHost {
  const { serverName, createServer, onBeforeClose } = options
  let closed = false
  let closePromise: Promise<void> | null = null
  const sessions = new Map<string, McpSessionEntry>()
  const token = randomBytes(24).toString('hex')
  const expectedAuth = `Bearer ${token}`

  const httpServer = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    // Tool calls (e.g. BrowserNavigate 30-60s, BrowserAct multi-step waits, Computer Use REPL)
    // legitimately exceed Bun's 10s default idle timeout; per-tool timeouts and turnAbort govern lifetime.
    idleTimeout: 0,
    async fetch(req: Request): Promise<Response> {
      const url = new URL(req.url)
      // agy probes OAuth protected-resource metadata unauthenticated on HTTP MCP.
      if (req.method === 'GET' && url.pathname.startsWith('/.well-known/')) {
        return new Response('Not Found', { status: 404 })
      }
      if (url.pathname !== MCP_PATH) {
        return new Response('Not Found', { status: 404 })
      }
      const authHeader = req.headers.get('authorization') ?? ''
      if (!tokensEqual(expectedAuth, authHeader)) {
        return new Response('Unauthorized', { status: 401 })
      }
      if (closed) {
        return new Response('Bridge closed', { status: 503 })
      }

      let parsedBody: unknown
      if (req.method === 'POST') {
        const rawText = await req.text()
        if (rawText.trim()) {
          try {
            parsedBody = JSON.parse(rawText)
          } catch {
            return Response.json(
              { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } },
              { status: 400 },
            )
          }
        }
        // agy 1.5.17+ sends `server/discover` before `initialize`; reply -32601 cleanly so it falls back to standard initialize.
        if (
          parsedBody &&
          typeof parsedBody === 'object' &&
          !Array.isArray(parsedBody) &&
          (parsedBody as Record<string, unknown>).method === 'server/discover'
        ) {
          const rpcId = (parsedBody as Record<string, unknown>).id ?? null
          return Response.json({
            jsonrpc: '2.0',
            id: rpcId,
            error: { code: -32601, message: 'Method not found' },
          })
        }
      }

      const mcpSessionId = req.headers.get('mcp-session-id')?.trim() || undefined
      if (mcpSessionId) {
        const entry = sessions.get(mcpSessionId)
        if (!entry) {
          return Response.json(
            { jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Session not found' } },
            { status: 404 },
          )
        }
        return entry.transport.handleRequest(req, parsedBody !== undefined ? { parsedBody } : undefined)
      }

      const server = createServer()
      let initializedSessionId: string | undefined
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        enableJsonResponse: true,
        onsessioninitialized: (id) => {
          initializedSessionId = id
          if (!closed) {
            sessions.set(id, { server, transport })
          }
        },
        onsessionclosed: (id) => {
          sessions.delete(id)
          void server.close().catch(() => {})
        },
      })
      await server.connect(transport)
      try {
        return await transport.handleRequest(req, parsedBody !== undefined ? { parsedBody } : undefined)
      } finally {
        if (!initializedSessionId || closed) {
          if (initializedSessionId) sessions.delete(initializedSessionId)
          await transport.close().catch(() => {})
          await server.close().catch(() => {})
        }
      }
    },
  })

  const url = `http://127.0.0.1:${httpServer.port}${MCP_PATH}`
  const mcpServerConfig: AntigravityMcpServerConfig = {
    type: 'http',
    name: serverName,
    url,
    headers: [{ name: 'Authorization', value: expectedAuth }],
  }

  return {
    serverName,
    url,
    token,
    mcpServerConfig,
    isClosed: () => closed,
    close: async () => {
      if (closePromise) return closePromise
      closed = true
      closePromise = (async () => {
        try {
          await onBeforeClose?.()
        } finally {
          const entries = [...sessions.values()]
          sessions.clear()
          await Promise.allSettled(entries.map(async ({ server, transport }) => {
            await transport.close().catch(() => {})
            await server.close().catch(() => {})
          }))
          httpServer.stop(true)
        }
      })()
      return closePromise
    },
  }
}
