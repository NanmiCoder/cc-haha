import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js'
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js'
import { ErrorCode, isJSONRPCRequest, McpError } from '@modelcontextprotocol/sdk/types.js'

export type McpConnectionErrorKind = 'network' | 'proxy' | 'timeout' | 'authentication' | 'permission' | 'discovery'

const messages: Record<McpConnectionErrorKind, string> = {
  network: 'Remote connector network connection failed. Check the network and retry.',
  proxy: 'Remote connector proxy connection failed. Check the proxy settings and retry.',
  timeout: 'Remote connector connection timed out. Check the network or proxy settings and retry.',
  authentication: 'Remote connector authentication failed. Check the credentials or sign in again.',
  permission: 'Remote connector access was denied. Check account permissions and API key scopes.',
  discovery: 'Remote connector tool discovery failed. The service did not provide usable tools.',
}

/** Only an allowlisted kind crosses the connector's existing error-string boundary. */
export class McpConnectionError extends Error {
  constructor(readonly kind: McpConnectionErrorKind) {
    super(messages[kind])
    this.name = 'McpConnectionError'
  }
}

function httpFailureKind(status: unknown): McpConnectionErrorKind | undefined {
  if (status === 401) return 'authentication'
  if (status === 403) return 'permission'
  if (status === 407) return 'proxy'
  if (status === 408 || status === 504) return 'timeout'
  if (typeof status === 'number' && status >= 500 && status <= 599) return 'network'
  return undefined
}

const timeoutCodes = new Set(['ETIMEDOUT', 'ESOCKETTIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT'])
const networkCodes = new Set(['ECONNREFUSED', 'ECONNRESET', 'ECONNABORTED', 'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH', 'EPIPE', 'ERR_NETWORK', 'ERR_SOCKET_CLOSED'])

function isMcpRequest(init?: RequestInit): boolean {
  if (init?.method?.toUpperCase() !== 'POST' || typeof init.body !== 'string') return false
  try { return isJSONRPCRequest(JSON.parse(init.body)) }
  catch { return false }
}

function structuredFailureKind(error: unknown): McpConnectionErrorKind | undefined {
  // Fetch errors can carry the system error in cause. Bound traversal also
  // handles cyclic/untrusted causes without inspecting messages or bodies.
  for (let depth = 0; depth < 5 && error && typeof error === 'object'; depth++) {
    if (error instanceof McpConnectionError) return error.kind
    if (error instanceof UnauthorizedError) return 'authentication'
    if (error instanceof McpError) {
      if (error.code === ErrorCode.RequestTimeout) return 'timeout'
      if (error.code === ErrorCode.ConnectionClosed) return 'network'
    }
    const fields = error as { name?: unknown, code?: unknown, status?: unknown, statusCode?: unknown, cause?: unknown }
    const httpKind = httpFailureKind(fields.status) ?? httpFailureKind(fields.statusCode) ?? httpFailureKind(fields.code)
    if (httpKind) return httpKind
    if (fields.name === 'TimeoutError' || (typeof fields.code === 'string' && timeoutCodes.has(fields.code))) return 'timeout'
    if (typeof fields.code === 'string' && networkCodes.has(fields.code)) return 'network'
    error = fields.cause
  }
  return undefined
}

export function classifyMcpConnectionError(error: unknown, fallback: McpConnectionErrorKind = 'discovery'): McpConnectionError {
  // Always rebuild the message: even a typed error's message may have been
  // replaced by a caller. Never retain the upstream error as cause or data.
  return new McpConnectionError(structuredFailureKind(error) ?? fallback)
}

const connectionErrors = new WeakMap<object, McpConnectionError>()

/** Transient metadata only: no fields are added to MCP connections or DTOs. */
export function setMcpConnectionError(connection: object, error: McpConnectionError): void {
  connectionErrors.set(connection, classifyMcpConnectionError(error))
}

export function getMcpConnectionError(connection: object): McpConnectionError | undefined {
  return connectionErrors.get(connection)
}

/**
 * SDK auth/discovery and EventSource can replace the original transport error.
 * Retain only a safe enum, scoped to one connection/discovery attempt. Responses
 * are returned untouched so SDK authentication, headers and streaming still work.
 */
export class McpConnectionErrorContext {
  private failureKind: McpConnectionErrorKind | undefined

  reset(): void { this.failureKind = undefined }

  classify(error: unknown): McpConnectionError {
    if (error instanceof McpConnectionError) return classifyMcpConnectionError(error)
    return new McpConnectionError(this.failureKind ?? structuredFailureKind(error) ?? 'discovery')
  }

  wrapFetch(baseFetch: FetchLike, route: 'network' | 'proxy' = 'network'): FetchLike {
    return async (url, init) => {
      try {
        const response = await baseFetch(url, init)
        const kind = httpFailureKind(response.status)
        if (kind) this.failureKind = kind
        // A successful MCP request has recovered from the prior HTTP failure.
        // OAuth metadata/token responses, notifications and stream GETs do not
        // prove recovery. Inspect only the structured request, never the body
        // of the response the SDK still needs to validate or stream.
        else if (response.ok && this.failureKind && isMcpRequest(init)) this.reset()
        return response
      } catch (error) {
        const reason = init?.signal?.aborted ? init.signal.reason : undefined
        const kind = structuredFailureKind(reason) ?? classifyMcpConnectionError(error, route).kind
        this.failureKind = route === 'proxy' && kind === 'network' ? 'proxy' : kind
        // Preserve the SDK's cancellation and transport handling; only the
        // eventual connector-facing error is rebuilt from the safe kind.
        throw error
      }
    }
  }
}
