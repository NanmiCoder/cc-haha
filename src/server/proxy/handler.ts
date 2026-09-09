/**
 * Proxy Handler — protocol-translating reverse proxy for OpenAI-compatible APIs.
 *
 * Receives Anthropic Messages API requests from the CLI, transforms them to
 * OpenAI Chat Completions or Responses API format, forwards to the upstream
 * provider, and transforms the response back to Anthropic format.
 *
 * Derived from cc-switch (https://github.com/farion1231/cc-switch)
 * Original work by Jason Young, MIT License
 */

import { getOpenAIPolicyError } from '../../services/openaiAuth/policyError.js'
import { buildOpenaiEndpoint } from './openaiEndpoint.js'
import { normalizeAnthropicBaseUrl } from '../../services/api/anthropicBaseUrl.js'
import { createGunzip, createInflate } from 'node:zlib'

import { ProviderService } from '../services/providerService.js'
import type { ProviderAuthStrategy } from '../types/provider.js'
import { resolvePromptCacheKey } from './promptCacheKey.js'
import { anthropicToOpenaiChat } from './transform/anthropicToOpenaiChat.js'
import { anthropicToOpenaiResponses } from './transform/anthropicToOpenaiResponses.js'
import { hoistToolResultMediaForCompatibility } from './transform/anthropicMediaHoist.js'
import { openaiChatToAnthropic } from './transform/openaiChatToAnthropic.js'
import { openaiResponsesToAnthropic } from './transform/openaiResponsesToAnthropic.js'
import { openaiChatStreamToAnthropic } from './streaming/openaiChatStreamToAnthropic.js'
import { openaiResponsesStreamToAnthropic } from './streaming/openaiResponsesStreamToAnthropic.js'
import type { AnthropicRequest } from './transform/types.js'
import { getProxyFetchOptions } from '../../utils/proxy.js'
import {
  getNetworkProxyFetchOptions,
  loadNetworkSettings,
  type NetworkSettings,
} from '../services/networkSettings.js'
import { normalizeModelStringForAPI } from '../../utils/model/model.js'
import {
  createTraceCallId,
  createTraceBodySnapshot,
  TRACE_STREAM_CAPTURE_BYTES,
  traceCaptureService,
  type TraceBodySnapshot,
  type TraceProviderInfo,
} from '../services/traceCaptureService.js'
import { resolveModelReasoningProfile } from '../../shared/modelReasoning.js'

const providerService = new ProviderService()

type ProxyFetchOptions = ReturnType<typeof getProxyFetchOptions>
// `decompress` is a Bun fetch option absent from the DOM RequestInit type.
type UpstreamRequestInit = RequestInit & ProxyFetchOptions & { decompress?: boolean }
type ProxyTraceContext = {
  sessionId: string
  provider: TraceProviderInfo
  anthropicRequest: AnthropicRequest
}

const TRACE_RECORDED_ERROR_MARKER = Symbol('cc-haha-trace-recorded-error')

// Per-context dedup for failures that rethrow a value that cannot carry a
// marker (stream errors may be any value, e.g. a string from
// `controller.error('...')`). The marker above still covers Error objects for
// paths that only see object throws.
const recordedTraceErrorContexts = new WeakSet<ProxyTraceContext>()

function markTraceErrorRecorded(error: unknown): void {
  if (error && typeof error === 'object') {
    try {
      Object.defineProperty(error, TRACE_RECORDED_ERROR_MARKER, {
        value: true,
        enumerable: false,
      })
    } catch {
      // Best effort only; proxy error handling must not depend on trace metadata.
    }
  }
}

function wasTraceErrorRecorded(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && (error as Record<symbol, unknown>)[TRACE_RECORDED_ERROR_MARKER])
}

function createTimeoutController(timeoutMs: number): {
  signal: AbortSignal
  clear: () => void
} {
  const controller = new AbortController()
  const timer = setTimeout(() => {
    controller.abort(new DOMException('The operation timed out.', 'TimeoutError'))
  }, timeoutMs)

  return {
    signal: controller.signal,
    clear: () => clearTimeout(timer),
  }
}

async function fetchUpstreamWithTimeout(
  url: string,
  init: Omit<UpstreamRequestInit, 'signal'>,
  timeoutMs: number,
  isStream: boolean,
): Promise<Response> {
  if (!isStream) {
    return fetch(url, {
      ...init,
      signal: AbortSignal.timeout(timeoutMs),
    })
  }

  // For streaming requests, this timeout should only cover the connection and
  // response headers. Keeping the signal alive aborts long generations mid-body.
  const timeout = createTimeoutController(timeoutMs)
  try {
    return await fetch(url, {
      ...init,
      signal: timeout.signal,
    })
  } finally {
    timeout.clear()
  }
}

export function withStreamIdleTimeout(
  upstream: ReadableStream<Uint8Array>,
  timeoutMs: number,
): ReadableStream<Uint8Array> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null
  let timer: ReturnType<typeof setTimeout> | null = null

  const clearIdleTimer = () => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
  }

  return new ReadableStream({
    async start(controller) {
      reader = upstream.getReader()
      let timedOut = false

      const armIdleTimer = () => {
        clearIdleTimer()
        timer = setTimeout(() => {
          timedOut = true
          void reader?.cancel('stream idle timeout').catch(() => undefined)
          controller.error(new Error(`Upstream stream idle timeout after ${timeoutMs}ms`))
        }, timeoutMs)
      }

      try {
        armIdleTimer()
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          if (timedOut) break

          controller.enqueue(value)
          armIdleTimer()
        }
        clearIdleTimer()
        if (!timedOut) controller.close()
      } catch (err) {
        clearIdleTimer()
        if (!timedOut) controller.error(err)
      } finally {
        reader?.releaseLock()
        reader = null
      }
    },
    cancel(reason) {
      clearIdleTimer()
      return reader?.cancel(reason)
    },
  })
}

export async function handleProxyRequest(req: Request, url: URL): Promise<Response> {
  const providerMatch = url.pathname.match(/^\/proxy\/providers\/([^/]+)\/v1\/messages$/)
  const providerId = providerMatch ? decodeURIComponent(providerMatch[1]!) : undefined
  const isActiveProxyPath = url.pathname === '/proxy/v1/messages'

  // Only handle POST /proxy/v1/messages or POST /proxy/providers/:providerId/v1/messages
  if (req.method !== 'POST' || (!isActiveProxyPath && !providerMatch)) {
    return Response.json(
      {
        error: 'Not Found',
        message: 'Proxy only handles POST /proxy/v1/messages and POST /proxy/providers/:providerId/v1/messages',
      },
      { status: 404 },
    )
  }

  // Read active/default provider config or an explicitly-scoped provider config.
  const config = await providerService.getProviderForProxy(providerId)
  if (!config) {
    return Response.json(
      {
        type: 'error',
        error: {
          type: 'invalid_request_error',
          message: providerId
            ? `Provider "${providerId}" is not configured for proxy`
            : 'No active provider configured for proxy',
        },
      },
      { status: 400 },
    )
  }

  // Parse request body (needed by both the anthropic-compatible path and the
  // OpenAI-transforming paths).
  let body: AnthropicRequest
  try {
    body = (await req.json()) as AnthropicRequest
  } catch {
    return Response.json(
      { type: 'error', error: { type: 'invalid_request_error', message: 'Invalid JSON in request body' } },
      { status: 400 },
    )
  }

  body = {
    ...body,
    model: normalizeModelStringForAPI(body.model),
  }

  const isStream = body.stream === true
  const baseUrl = config.baseUrl.replace(/\/+$/, '')
  const networkSettings = await loadNetworkSettings()
  const traceContext = buildProxyTraceContext(req, config, body)
  const promptCacheKey = resolvePromptCacheKey(body, req.headers.get('x-claude-code-session-id'))

  try {
    if (config.apiFormat === 'anthropic') {
      // Anthropic-format providers normally connect directly to the upstream
      // endpoint (see providerRuntimeEnv). Only providers that explicitly opt out
      // of nested tool-result media (supportsNestedToolResultMedia=false) route
      // through the proxy so images/documents can be lifted out of tool_result
      // before the request reaches an endpoint that would drop them.
      if (config.supportsNestedToolResultMedia) {
        return Response.json(
          {
            type: 'error',
            error: {
              type: 'invalid_request_error',
              message: providerId
                ? `Provider "${providerId}" uses anthropic format — proxy not needed`
                : 'Active provider uses anthropic format — proxy not needed',
            },
          },
          { status: 400 },
        )
      }
      return await handleAnthropicCompatible(body, baseUrl, config.apiKey, config.authStrategy, req.headers, isStream, networkSettings, traceContext)
    }
    if (config.apiFormat === 'openai_chat') {
      return await handleOpenaiChat(body, baseUrl, config.apiKey, isStream, networkSettings, traceContext)
    }
    return await handleOpenaiResponses(body, baseUrl, config.apiKey, isStream, networkSettings, traceContext, promptCacheKey)
  } catch (err) {
    if (traceContext && !wasTraceErrorRecorded(err) && !recordedTraceErrorContexts.has(traceContext)) {
      void recordProxyTrace({
        context: traceContext,
        model: body.model,
        upstreamUrl: baseUrl,
        upstreamRequest: null,
        startedAt: new Date().toISOString(),
        startedAtMs: Date.now(),
        error: err,
      }).catch(() => {})
    }
    console.error('[Proxy] Upstream request failed:', err)
    const policyError = getOpenAIPolicyError(err)
    return Response.json(
      {
        type: 'error',
        error: policyError ? { type: 'permission_error', ...policyError } : {
          type: 'api_error',
          message: err instanceof Error ? err.message : String(err),
        },
      },
      { status: policyError ? 403 : 502 },
    )
  }
}

/**
 * Build the upstream auth headers for an anthropic-format provider, matching
 * the strategy semantics that providerRuntimeEnv normally encodes into the
 * CLI environment (see buildProviderAuthEnv). An empty key omits the auth
 * header entirely, same as the direct path where the SDK sends no
 * credential rather than an empty one.
 */
function buildAnthropicAuthHeaders(
  apiKey: string,
  authStrategy: ProviderAuthStrategy,
): Record<string, string> {
  switch (authStrategy) {
    case 'auth_token':
    case 'auth_token_empty_api_key':
      return apiKey ? { Authorization: `Bearer ${apiKey}` } : {}
    case 'dual_same_token':
      return apiKey ? { 'x-api-key': apiKey, Authorization: `Bearer ${apiKey}` } : {}
    case 'dual_dummy':
      return { 'x-api-key': 'dummy', Authorization: 'Bearer dummy' }
    case 'api_key':
    default:
      return apiKey ? { 'x-api-key': apiKey } : {}
  }
}

// Connection-management headers that must not be forwarded between hops (they
// describe the client↔proxy hop, not the proxy↔upstream hop). Per RFC 9110 the
// `Connection` header may also name additional connection-specific headers,
// which are added to the deny set dynamically.
const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'proxy-connection',
])

const INTERNAL_CLIENT_HEADERS = new Set([
  'x-claude-code-session-id',
  'x-claude-remote-container-id',
  'x-claude-remote-session-id',
  'x-client-app',
])

function isInternalClientHeader(name: string, value: string): boolean {
  if (INTERNAL_CLIENT_HEADERS.has(name)) return true
  if (name === 'x-app') return value === 'cli'
  return name === 'user-agent' && /^claude-cli\/[^\s]+\s+\(/i.test(value)
}

function hopByHopDenySet(headers: Headers): Set<string> {
  const deny = new Set<string>(HOP_BY_HOP_HEADERS)
  const connection = headers.get('connection')
  if (connection) {
    for (const token of connection.split(',')) {
      const trimmed = token.trim().toLowerCase()
      if (trimmed) deny.add(trimmed)
    }
  }
  return deny
}

/**
 * Copy a response's entity headers minus hop-by-hop headers. The upstream's
 * `Connection`-scoped headers describe the proxy↔upstream hop and must not
 * leak into the proxy↔client hop.
 */
/**
 * Parse a `Content-Encoding` header into the codecs to unwind, in decoding
 * order. `Content-Encoding` lists encodings in application order, so decoding
 * unwinds them in reverse; `identity` is a no-op.
 */
function parseContentEncodings(contentEncoding: string | undefined): string[] {
  return (contentEncoding ?? '')
    .split(',')
    .map(encoding => encoding.trim().toLowerCase())
    .filter(encoding => encoding !== '' && encoding !== 'identity')
    .reverse()
}

/** Codecs the trace decoder can unwind. Anything else (br, zstd, stacked
 * combinations) is marked unavailable instead of decoding raw bytes as UTF-8. */
const SUPPORTED_TRACE_CODECS = new Set(['gzip', 'x-gzip', 'deflate'])

/**
 * Decode captured upstream bytes for trace storage. The passthrough keeps the
 * raw bytes (`decompress: false`) so Content-Encoding/Length stay valid for
 * the client, but the trace should store readable text — decompress a copy
 * when the upstream compressed the body.
 *
 * Unknown encodings (for example `br`) and failed decompression of a known
 * codec are both marked unavailable — trace capture must never fail the
 * request, but it must not store bytes decoded as UTF-8 either.
 */
function decodeTraceBytes(bytes: Uint8Array, contentEncoding: string | undefined): string {
  const encodings = parseContentEncodings(contentEncoding)
  // An unknown codec (br, zstd, …) or a stacked combination cannot be
  // unwound — mark the trace unavailable instead of storing compressed bytes
  // decoded as UTF-8, matching the streaming branch.
  if (encodings.some(codec => !SUPPORTED_TRACE_CODECS.has(codec))) {
    return '[trace body unavailable: unsupported content encoding]'
  }
  // Copy into an ArrayBuffer-backed view: Bun's sync decompressors require
  // Uint8Array<ArrayBuffer> (a view over a non-shared buffer).
  let data: Uint8Array<ArrayBuffer> = new Uint8Array(bytes)
  for (const encoding of encodings) {
    try {
      if (encoding === 'gzip' || encoding === 'x-gzip') {
        data = Bun.gunzipSync(data)
      } else if (encoding === 'deflate') {
        data = Bun.inflateSync(data)
      } else {
        return '[trace body unavailable: unsupported content encoding]'
      }
    } catch {
      // The header names a codec the decoder supports, but the body is not
      // valid for it (corrupt member, truncated stream). Decoding whatever
      // was unwound so far as UTF-8 would store binary garbage — mark the
      // trace unavailable instead.
      return '[trace body unavailable: decompression failed]'
    }
  }
  return new TextDecoder().decode(data)
}

function decodeTraceResponseBody(bytes: ArrayBuffer, headers: Headers | undefined): string {
  return decodeTraceBytes(new Uint8Array(bytes), headers?.get('content-encoding') ?? undefined)
}

function stripHopByHopHeaders(headers: Headers): Headers {
  const deny = hopByHopDenySet(headers)
  const stripped = new Headers()
  for (const [name, value] of headers.entries()) {
    if (!deny.has(name.toLowerCase())) stripped.set(name, value)
  }
  return stripped
}

/**
 * Forward an Anthropic Messages request to an anthropic-format upstream after
 * lifting media out of nested tool results (provider opted out of nested media).
 * The wire format stays Anthropic; only the media placement changes. Protocol
 * headers and error responses are passed through so SDK classification and
 * retry behavior are preserved.
 */
async function handleAnthropicCompatible(
  body: AnthropicRequest,
  baseUrl: string,
  apiKey: string,
  authStrategy: ProviderAuthStrategy,
  incomingHeaders: Headers,
  isStream: boolean,
  networkSettings: NetworkSettings,
  traceContext: ProxyTraceContext | null,
): Promise<Response> {
  const transformed = hoistToolResultMediaForCompatibility(body)
  const url = `${normalizeAnthropicBaseUrl(baseUrl)}/v1/messages`
  const proxyOptions = getNetworkProxyFetchOptions(networkSettings, url)

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...buildAnthropicAuthHeaders(apiKey, authStrategy),
  }
  // Preserve protocol and custom headers from the incoming request
  // (anthropic-version is required; anthropic-beta and custom headers such as
  // those injected via ANTHROPIC_CUSTOM_HEADERS carry real semantics for the
  // upstream endpoint). Hop-by-hop and auth headers are not forwarded.
  const deny = hopByHopDenySet(incomingHeaders)
  for (const [name, value] of incomingHeaders.entries()) {
    const lower = name.toLowerCase()
    if (deny.has(lower) || isInternalClientHeader(lower, value)) continue
    // The local proxy's authority must not replace the upstream host.
    if (lower === 'host' || lower === 'content-type' || lower === 'content-length') continue
    if (lower === 'x-api-key' || lower === 'authorization') continue
    if (value) headers[name] = value
  }

  const traceHeaders = Object.fromEntries(
    Object.entries(headers).map(([name, value]) => {
      const lower = name.toLowerCase()
      return [
        name,
        lower === 'content-type' || lower === 'anthropic-version' || lower === 'anthropic-beta'
          ? value
          : '[redacted]',
      ]
    }),
  )

  const startedAtMs = Date.now()
  const startedAt = new Date(startedAtMs).toISOString()
  const traceCallId = traceContext
    ? startProxyTraceCall({
        context: traceContext,
        model: body.model,
        upstreamUrl: url,
        upstreamRequest: transformed,
        requestHeaders: traceHeaders,
        startedAt,
      })
    : undefined

  // Close the pending trace started above when the upstream call fails, so the
  // caller's unified error handling does not record a second trace for the
  // same request.
  const recordTraceError = (err: unknown): void => {
    if (!traceContext) return
    recordProxyTraceInBackground({
      callId: traceCallId,
      context: traceContext,
      model: body.model,
      upstreamUrl: url,
      upstreamRequest: transformed,
      requestHeaders: traceHeaders,
      startedAt,
      startedAtMs,
      error: err,
    })
    markTraceErrorRecorded(err)
    recordedTraceErrorContexts.add(traceContext)
  }

  let upstream: Response
  try {
    upstream = await fetchUpstreamWithTimeout(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(transformed),
      // Keep the raw bytes: Bun decompresses by default, which would leave a
      // decompressed body behind the upstream Content-Encoding/Length headers
      // when forwarding the response unchanged.
      decompress: false,
      ...proxyOptions,
    }, networkSettings.aiRequestTimeoutMs, isStream)
  } catch (err) {
    recordTraceError(err)
    console.error('[Proxy] Upstream anthropic request failed:', err)
    return Response.json(
      {
        type: 'error',
        error: {
          type: 'api_error',
          message: err instanceof Error ? err.message : String(err),
        },
      },
      { status: 502 },
    )
  }

  try {
    if (!upstream.ok) {
      // Pass the upstream error body and headers through unchanged so the SDK
      // keeps error classification (authentication_error, rate_limit_error, …),
      // request_id, and retry-after semantics. A body read failure here closes
      // the pending trace and surfaces to the caller's unified error handling
      // (structured 502) like any other upstream failure.
      const errBody = await upstream.arrayBuffer()
      if (traceContext) {
        recordProxyTraceInBackground({
          callId: traceCallId,
          context: traceContext,
          model: body.model,
          upstreamUrl: url,
          upstreamRequest: transformed,
          requestHeaders: traceHeaders,
          startedAt,
          startedAtMs,
          responseStatus: upstream.status,
          upstreamResponseBody: decodeTraceResponseBody(errBody, upstream.headers),
          responseHeaders: upstream.headers,
        })
      }
      return new Response(errBody, {
        status: upstream.status,
        headers: stripHopByHopHeaders(upstream.headers),
      })
    }

    if (isStream) {
      if (!upstream.body) {
        if (traceContext) {
          recordProxyTraceInBackground({
            callId: traceCallId,
            context: traceContext,
            model: body.model,
            upstreamUrl: url,
            upstreamRequest: transformed,
            requestHeaders: traceHeaders,
            startedAt,
            startedAtMs,
            error: new Error('Upstream returned no body for stream'),
          })
        }
        return Response.json(
          { type: 'error', error: { type: 'api_error', message: 'Upstream returned no body for stream' } },
          { status: 502 },
        )
      }
      // Keep SSE framing headers while passing through request/rate-limit
      // metadata from the upstream (request_id, ratelimit-*, custom headers).
      const responseHeaders = stripHopByHopHeaders(upstream.headers)
      responseHeaders.set('Content-Type', 'text/event-stream')
      responseHeaders.set('Cache-Control', 'no-cache')
      responseHeaders.set('Connection', 'keep-alive')
      const anthropicStream = withStreamIdleTimeout(upstream.body, networkSettings.aiRequestTimeoutMs)
      const tracedStream = traceContext
        ? captureTraceStream(anthropicStream, async (bodySnapshot, error) => {
            await recordProxyTrace({
              callId: traceCallId,
              context: traceContext,
              model: body.model,
              upstreamUrl: url,
              upstreamRequest: transformed,
              requestHeaders: traceHeaders,
              startedAt,
              startedAtMs,
              responseStatus: 200,
              responseBodySnapshot: bodySnapshot,
              responseHeaders: upstream.headers,
              ...(error ? { error } : {}),
            })
          }, upstream.headers.get('content-encoding') ?? undefined)
        : anthropicStream
      return new Response(tracedStream, {
        status: 200,
        headers: responseHeaders,
      })
    }

    // Byte-for-byte passthrough: re-serializing the body would invalidate
    // Content-Length/ETag entity headers from the upstream.
    const responseBody = await upstream.arrayBuffer()
    if (traceContext) {
      recordProxyTraceInBackground({
        callId: traceCallId,
        context: traceContext,
        model: body.model,
        upstreamUrl: url,
        upstreamRequest: transformed,
        requestHeaders: traceHeaders,
        startedAt,
        startedAtMs,
        responseStatus: upstream.status,
        upstreamResponseBody: decodeTraceResponseBody(responseBody, upstream.headers),
        responseHeaders: upstream.headers,
      })
    }
    return new Response(responseBody, {
      status: upstream.status,
      headers: stripHopByHopHeaders(upstream.headers),
    })
  } catch (err) {
    // A body read failure closes the pending trace with the original call id
    // (so no trace stays pending and no second trace is created), then
    // rethrows so the caller returns the same structured 502 as any other
    // upstream failure.
    recordTraceError(err)
    throw err
  }
}

async function handleOpenaiChat(
  body: AnthropicRequest,
  baseUrl: string,
  apiKey: string,
  isStream: boolean,
  networkSettings: NetworkSettings,
  traceContext: ProxyTraceContext | null,
): Promise<Response> {
  const knownDeepSeekHost = shouldUseDeepSeekReasoningCompat(baseUrl)
  const reasoningProfile = resolveModelReasoningProfile(body.model, 'openai_chat')
  const transformed = anthropicToOpenaiChat(body, {
    roundTripReasoningContent: knownDeepSeekHost || reasoningProfile?.family === 'deepseek-v4',
    passThinkingToggle: knownDeepSeekHost,
    imageContentMode: shouldUseTextOnlyOpenAIChatContent(baseUrl, body.model) ? 'text_only' : 'vision',
  })
  const url = buildOpenaiEndpoint(baseUrl, 'chat/completions')
  const upstreamRequestHeaders = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`,
  }
  const proxyOptions = getNetworkProxyFetchOptions(networkSettings, url)
  const startedAtMs = Date.now()
  const startedAt = new Date(startedAtMs).toISOString()
  const traceCallId = traceContext
    ? startProxyTraceCall({
        context: traceContext,
        model: body.model,
        upstreamUrl: url,
        upstreamRequest: transformed,
        requestHeaders: upstreamRequestHeaders,
        startedAt,
      })
    : undefined

  let upstream: Response
  try {
    upstream = await fetchUpstreamWithTimeout(url, {
      method: 'POST',
      headers: upstreamRequestHeaders,
      body: JSON.stringify(transformed),
      ...proxyOptions,
    }, networkSettings.aiRequestTimeoutMs, isStream)
  } catch (err) {
    if (traceContext) {
      recordProxyTraceInBackground({
        callId: traceCallId,
        context: traceContext,
        model: body.model,
        upstreamUrl: url,
        upstreamRequest: transformed,
        requestHeaders: upstreamRequestHeaders,
        startedAt,
        startedAtMs,
        error: err,
      })
      markTraceErrorRecorded(err)
    }
    throw err
  }

  if (!upstream.ok) {
    const errText = await upstream.text().catch(() => '')
    let policyError = null
    try {
      policyError = getOpenAIPolicyError(JSON.parse(errText))
    } catch {
      // Unstructured upstream failures keep their existing error classification.
    }
    const errorBody = {
      type: 'error',
      error: policyError ? { type: 'permission_error', ...policyError } : {
        type: 'api_error',
        message: `Upstream returned HTTP ${upstream.status}: ${errText.slice(0, 500)}`,
      },
    }
    if (traceContext) {
      recordProxyTraceInBackground({
        context: traceContext,
        callId: traceCallId,
        model: body.model,
        upstreamUrl: url,
        upstreamRequest: transformed,
        requestHeaders: upstreamRequestHeaders,
        startedAt,
        startedAtMs,
        responseStatus: upstream.status,
        upstreamResponseBody: errText,
        anthropicResponseBody: errorBody,
        responseHeaders: upstream.headers,
      })
    }
    return Response.json(
      errorBody,
      { status: policyError ? 403 : upstream.status },
    )
  }

  if (isStream) {
    if (!upstream.body) {
      if (traceContext) {
        recordProxyTraceInBackground({
          callId: traceCallId,
          context: traceContext,
          model: body.model,
          upstreamUrl: url,
          upstreamRequest: transformed,
          requestHeaders: upstreamRequestHeaders,
          startedAt,
          startedAtMs,
          error: new Error('Upstream returned no body for stream'),
        })
      }
      return Response.json(
        { type: 'error', error: { type: 'api_error', message: 'Upstream returned no body for stream' } },
        { status: 502 },
      )
    }
    const upstreamBody = withStreamIdleTimeout(upstream.body, networkSettings.aiRequestTimeoutMs)
    const anthropicStream = openaiChatStreamToAnthropic(upstreamBody, body.model)
    const tracedStream = traceContext
      ? captureTraceStream(anthropicStream, async (bodySnapshot, error) => {
          await recordProxyTrace({
            callId: traceCallId,
            context: traceContext,
            model: body.model,
            upstreamUrl: url,
            upstreamRequest: transformed,
            requestHeaders: upstreamRequestHeaders,
            startedAt,
            startedAtMs,
            responseStatus: 200,
            responseBodySnapshot: bodySnapshot,
            responseHeaders: upstream.headers,
            ...(error ? { error } : {}),
          })
        })
      : anthropicStream
    return new Response(tracedStream, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    })
  }

  // Non-streaming
  const responseBody = await upstream.json()
  const policyError = getOpenAIPolicyError(responseBody)
  const anthropicResponse = policyError
    ? { type: 'error', error: { type: 'permission_error', ...policyError } }
    : openaiChatToAnthropic(responseBody, body.model)
  if (traceContext) {
    recordProxyTraceInBackground({
      callId: traceCallId,
      context: traceContext,
      model: body.model,
      upstreamUrl: url,
      upstreamRequest: transformed,
      requestHeaders: upstreamRequestHeaders,
      startedAt,
      startedAtMs,
      responseStatus: 200,
      upstreamResponseBody: responseBody,
      anthropicResponseBody: anthropicResponse,
      responseHeaders: upstream.headers,
    })
  }
  return Response.json(anthropicResponse, { status: policyError ? 403 : 200 })
}

function shouldUseDeepSeekReasoningCompat(baseUrl: string): boolean {
  return (
    /(^|[./-])deepseek([./-]|$)/i.test(baseUrl) ||
    /(^|[./-])opencode\.ai([:/]|$)/i.test(baseUrl)
  )
}

function shouldUseTextOnlyOpenAIChatContent(baseUrl: string, model: string): boolean {
  // Keep classic DeepSeek text models compatible without dropping images for
  // explicitly vision-capable models served by the same Chat endpoint.
  if (/(^|[./-])deepseek([./-]|$)/i.test(baseUrl)) {
    return !hasExplicitVisionModelMarker(model)
  }

  // image_url inside a tool message is a gateway extension, not a universal
  // Chat Completions contract. Only opt opencode models in when their id
  // explicitly advertises vision capability; unknown gateway models stay safe.
  if (/(^|[./-])opencode\.ai([:/]|$)/i.test(baseUrl)) {
    return !hasExplicitVisionModelMarker(model)
  }

  // Preserve the existing behavior for generic compatible providers whose
  // capabilities are not controlled by either compatibility policy above.
  return false
}

function hasExplicitVisionModelMarker(model: string): boolean {
  return /(^|[/:._-])vision([/:._-]|$)/i.test(model)
}

async function handleOpenaiResponses(
  body: AnthropicRequest,
  baseUrl: string,
  apiKey: string,
  isStream: boolean,
  networkSettings: NetworkSettings,
  traceContext: ProxyTraceContext | null,
  promptCacheKey?: string,
): Promise<Response> {
  const transformed = anthropicToOpenaiResponses(body, { cacheKey: promptCacheKey })
  const url = buildOpenaiEndpoint(baseUrl, 'responses')
  const upstreamRequestHeaders = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`,
  }
  const proxyOptions = getNetworkProxyFetchOptions(networkSettings, url)
  const startedAtMs = Date.now()
  const startedAt = new Date(startedAtMs).toISOString()
  const traceCallId = traceContext
    ? startProxyTraceCall({
        context: traceContext,
        model: body.model,
        upstreamUrl: url,
        upstreamRequest: transformed,
        requestHeaders: upstreamRequestHeaders,
        startedAt,
      })
    : undefined

  let upstream: Response
  try {
    upstream = await fetchUpstreamWithTimeout(url, {
      method: 'POST',
      headers: upstreamRequestHeaders,
      body: JSON.stringify(transformed),
      ...proxyOptions,
    }, networkSettings.aiRequestTimeoutMs, isStream)
  } catch (err) {
    if (traceContext) {
      recordProxyTraceInBackground({
        callId: traceCallId,
        context: traceContext,
        model: body.model,
        upstreamUrl: url,
        upstreamRequest: transformed,
        requestHeaders: upstreamRequestHeaders,
        startedAt,
        startedAtMs,
        error: err,
      })
      markTraceErrorRecorded(err)
    }
    throw err
  }

  if (!upstream.ok) {
    const errText = await upstream.text().catch(() => '')
    let policyError = null
    try {
      policyError = getOpenAIPolicyError(JSON.parse(errText))
    } catch {
      // Unstructured upstream failures keep their existing error classification.
    }
    const errorBody = {
      type: 'error',
      error: policyError ? { type: 'permission_error', ...policyError } : {
        type: 'api_error',
        message: `Upstream returned HTTP ${upstream.status}: ${errText.slice(0, 500)}`,
      },
    }
    if (traceContext) {
      recordProxyTraceInBackground({
        context: traceContext,
        callId: traceCallId,
        model: body.model,
        upstreamUrl: url,
        upstreamRequest: transformed,
        requestHeaders: upstreamRequestHeaders,
        startedAt,
        startedAtMs,
        responseStatus: upstream.status,
        upstreamResponseBody: errText,
        anthropicResponseBody: errorBody,
        responseHeaders: upstream.headers,
      })
    }
    return Response.json(
      errorBody,
      { status: policyError ? 403 : upstream.status },
    )
  }

  if (isStream) {
    if (!upstream.body) {
      if (traceContext) {
        recordProxyTraceInBackground({
          callId: traceCallId,
          context: traceContext,
          model: body.model,
          upstreamUrl: url,
          upstreamRequest: transformed,
          requestHeaders: upstreamRequestHeaders,
          startedAt,
          startedAtMs,
          error: new Error('Upstream returned no body for stream'),
        })
      }
      return Response.json(
        { type: 'error', error: { type: 'api_error', message: 'Upstream returned no body for stream' } },
        { status: 502 },
      )
    }
    const upstreamBody = withStreamIdleTimeout(upstream.body, networkSettings.aiRequestTimeoutMs)
    const anthropicStream = openaiResponsesStreamToAnthropic(upstreamBody, body.model)
    const tracedStream = traceContext
      ? captureTraceStream(anthropicStream, async (bodySnapshot, error) => {
          await recordProxyTrace({
            callId: traceCallId,
            context: traceContext,
            model: body.model,
            upstreamUrl: url,
            upstreamRequest: transformed,
            requestHeaders: upstreamRequestHeaders,
            startedAt,
            startedAtMs,
            responseStatus: 200,
            responseBodySnapshot: bodySnapshot,
            responseHeaders: upstream.headers,
            ...(error ? { error } : {}),
          })
        })
      : anthropicStream
    return new Response(tracedStream, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    })
  }

  // Non-streaming
  const responseBody = await upstream.json()
  const policyError = getOpenAIPolicyError(responseBody)
  const anthropicResponse = policyError
    ? { type: 'error', error: { type: 'permission_error', ...policyError } }
    : openaiResponsesToAnthropic(responseBody, body.model)
  if (traceContext) {
    recordProxyTraceInBackground({
      callId: traceCallId,
      context: traceContext,
      model: body.model,
      upstreamUrl: url,
      upstreamRequest: transformed,
      requestHeaders: upstreamRequestHeaders,
      startedAt,
      startedAtMs,
      responseStatus: 200,
      upstreamResponseBody: responseBody,
      anthropicResponseBody: anthropicResponse,
      responseHeaders: upstream.headers,
    })
  }
  return Response.json(anthropicResponse, { status: policyError ? 403 : 200 })
}

function buildProxyTraceContext(
  req: Request,
  config: { id: string; name: string; apiFormat: string },
  anthropicRequest: AnthropicRequest,
): ProxyTraceContext | null {
  const sessionId = req.headers.get('x-claude-code-session-id')?.trim()
  if (!sessionId) return null
  return {
    sessionId,
    provider: {
      id: config.id,
      name: config.name,
      format: config.apiFormat,
    },
    anthropicRequest,
  }
}

function createProxyTraceRequestBody(context: ProxyTraceContext, upstreamRequest: unknown): Record<string, unknown> {
  return upstreamRequest
    ? {
        anthropic: context.anthropicRequest,
        upstream: upstreamRequest,
      }
    : {
        anthropic: context.anthropicRequest,
      }
}

function startProxyTraceCall({
  context,
  model,
  upstreamUrl,
  upstreamRequest,
  requestHeaders,
  startedAt,
}: {
  context: ProxyTraceContext
  model: string
  upstreamUrl: string
  upstreamRequest: unknown
  requestHeaders: Record<string, string>
  startedAt: string
}): string {
  const callId = createTraceCallId()
  void traceCaptureService.recordCall({
    id: callId,
    sessionId: context.sessionId,
    source: 'proxy',
    provider: context.provider,
    model,
    status: 'pending',
    startedAt,
    request: {
      method: 'POST',
      url: upstreamUrl,
      headers: requestHeaders,
      bodySnapshot: createTraceBodySnapshot({
        pending: true,
        note: 'proxy request body captured on call completion',
      }),
    },
    metadata: {
      phase: 'upstream_fetch_started',
    },
  })
  void traceCaptureService.recordEvent({
    sessionId: context.sessionId,
    callId,
    source: 'proxy',
    provider: context.provider,
    model,
    timestamp: startedAt,
    phase: 'upstream_fetch_started',
    severity: 'info',
    title: 'Upstream fetch started',
    metadata: {
      url: upstreamUrl,
    },
  })
  return callId
}

type RecordProxyTraceInput = {
  callId?: string
  context: ProxyTraceContext
  model: string
  upstreamUrl: string
  upstreamRequest: unknown
  requestHeaders?: Record<string, string>
  startedAt: string
  startedAtMs: number
  responseStatus?: number
  upstreamResponseBody?: unknown
  anthropicResponseBody?: unknown
  responseBodySnapshot?: TraceBodySnapshot
  responseHeaders?: Headers
  error?: unknown
}

function recordProxyTraceInBackground(input: RecordProxyTraceInput): void {
  void recordProxyTrace(input).catch(() => {})
}

async function recordProxyTrace({
  callId,
  context,
  model,
  upstreamUrl,
  upstreamRequest,
  requestHeaders,
  startedAt,
  startedAtMs,
  responseStatus,
  upstreamResponseBody,
  anthropicResponseBody,
  responseBodySnapshot,
  responseHeaders,
  error,
}: RecordProxyTraceInput): Promise<void> {
  const completedAt = new Date().toISOString()
  const requestBody = createProxyTraceRequestBody(context, upstreamRequest)
  const responseBody = anthropicResponseBody === undefined && upstreamResponseBody === undefined
    ? undefined
    : {
        ...(upstreamResponseBody !== undefined ? { upstream: upstreamResponseBody } : {}),
        ...(anthropicResponseBody !== undefined ? { anthropic: anthropicResponseBody } : {}),
      }

  await traceCaptureService.recordCall({
    ...(callId ? { id: callId } : {}),
    sessionId: context.sessionId,
    source: 'proxy',
    provider: context.provider,
    model,
    startedAt,
    completedAt,
    durationMs: Date.now() - startedAtMs,
    request: {
      method: 'POST',
      url: upstreamUrl,
      headers: requestHeaders,
      body: requestBody,
    },
    ...(responseStatus !== undefined
      ? {
          response: {
            status: responseStatus,
            headers: responseHeaders,
            ...(responseBodySnapshot ? { bodySnapshot: responseBodySnapshot } : { body: responseBody }),
          },
        }
      : {}),
    ...(error ? { error } : {}),
    metadata: {
      phase: error ? 'upstream_fetch_failed' : 'upstream_fetch_completed',
    },
  })
  await traceCaptureService.recordEvent({
    sessionId: context.sessionId,
    ...(callId ? { callId } : {}),
    source: 'proxy',
    provider: context.provider,
    model,
    timestamp: completedAt,
    phase: error ? 'upstream_fetch_failed' : 'upstream_fetch_completed',
    severity: error ? 'error' : responseStatus !== undefined && responseStatus >= 400 ? 'warning' : 'info',
    title: error ? 'Upstream fetch failed' : 'Upstream fetch completed',
    message: error instanceof Error ? error.message : error ? String(error) : undefined,
    metadata: {
      status: responseStatus,
      url: upstreamUrl,
    },
  })
}

function captureTraceStream(
  stream: ReadableStream<Uint8Array>,
  onComplete: (snapshot: TraceBodySnapshot, error?: unknown) => Promise<void>,
  contentEncoding?: string,
): ReadableStream<Uint8Array> {
  // The Anthropic passthrough forwards raw upstream bytes (`decompress:
  // false`), so a compressed SSE body would otherwise be stored as binary
  // garbage. Decompress the *trace copy* while it streams — the capture cap
  // applies to decoded output, so truncation, client cancellation, or an
  // upstream error leave a readable plain-text prefix instead of an
  // unterminated gzip member, and a highly compressible body cannot blow past
  // the memory cap before it is counted.
  const chunks: Uint8Array[] = []
  let bytes = 0
  let truncated = false
  let finalized = false
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null

  const captureDecoded = (chunk: Uint8Array) => {
    bytes += chunk.byteLength
    if (bytes <= TRACE_STREAM_CAPTURE_BYTES) {
      chunks.push(chunk)
    } else {
      truncated = true
    }
  }

  const finalize = async (error?: unknown) => {
    if (finalized) return
    finalized = true
    const joined = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0))
    let offset = 0
    for (const chunk of chunks) {
      joined.set(chunk, offset)
      offset += chunk.byteLength
    }
    const snapshot = createTraceBodySnapshot(
      unsupportedEncoding
        ? '[trace body unavailable: unsupported content encoding]'
        : unexpectedDecompressionFailure
          ? '[trace body unavailable: decompression failed]'
          : new TextDecoder().decode(joined),
      { alreadyTruncated: truncated },
    )
    await onComplete(snapshot, error).catch(() => {})
  }

  // The streaming branch decodes a *single* known codec (gzip/x-gzip or
  // deflate). Stacked or unknown encodings cannot be unwound here — mark the
  // trace unavailable instead of storing compressed bytes decoded as UTF-8.
  // The buffered path still unwinds every codec via decodeTraceBytes.
  const encodings = parseContentEncodings(contentEncoding)
  const singleKnownCodec = encodings.length === 1 && SUPPORTED_TRACE_CODECS.has(encodings[0]!)
  const unsupportedEncoding = encodings.length > 0 && !singleKnownCodec
  const decompressor = singleKnownCodec
    ? encodings[0] === 'deflate'
      ? createInflate()
      : createGunzip()
    : null
  // node:zlib streams honor the Writable backpressure contract: write()
  // returns false when the writable buffer is full and the caller must wait
  // for 'drain' before writing more. The trace copy is a side channel, but it
  // still must not buffer an unbounded amount of compressed input.
  let decompressorFailed = false
  let decompressorEnded = false
  // Explicitly ended by design (client cancel, capture cap, upstream read
  // error): an end() on an unterminated gzip member then errors as expected
  // and the decoded plain-text prefix is kept. Only a body that fails to
  // decompress while ending normally marks the trace unavailable — an error
  // from zlib is delivered asynchronously, so "ended before the error" is not
  // a reliable signal, but the ending path itself is.
  let activelyEnded = false
  let unexpectedDecompressionFailure = false
  let decompressEnded: Promise<void> = Promise.resolve()
  if (decompressor) {
    decompressor.on('data', captureDecoded)
    // Partial data is already captured; an error mid-stream must not surface
    // beyond the trace copy.
    decompressor.on('error', () => {
      if (!activelyEnded) {
        unexpectedDecompressionFailure = true
      }
      decompressorFailed = true
    })
    decompressEnded = new Promise(resolve => {
      decompressor.on('end', resolve)
      decompressor.on('error', resolve)
    })
  }

  // Resolve when the decompressor is ready for more input. An errored stream
  // never drains and rejects further writes, so failure also resolves — the
  // loop must stop feeding it afterwards. An end() from the cancel/cap path
  // may finish through 'finish'/'close' without ever emitting 'drain', so the
  // waiter settles on any of the terminal events or the read loop would hang
  // with the upstream reader lock never released.
  const waitForDecompressorDrain = (): Promise<void> => {
    if (!decompressor || decompressorFailed || decompressorEnded) return Promise.resolve()
    return new Promise<void>(resolve => {
      const settle = () => {
        decompressor.off('drain', settle)
        decompressor.off('error', settle)
        decompressor.off('finish', settle)
        decompressor.off('close', settle)
        resolve()
      }
      decompressor.once('drain', settle)
      decompressor.once('error', settle)
      decompressor.once('finish', settle)
      decompressor.once('close', settle)
    })
  }

  // End the decompressor gracefully instead of destroying it: destroy()
  // would drop data already written but not yet flushed as 'data', so a
  // cancelled or errored stream would lose the decoded prefix. end() flushes
  // what was received; an unterminated gzip member then errors, which
  // resolves decompressEnded through the error branch.
  const finishDecompressor = async () => {
    if (!decompressor) return
    if (!decompressorEnded) {
      decompressorEnded = true
      try {
        decompressor.end()
      } catch {
        decompressor.destroy()
        return
      }
    }
    await decompressEnded
  }

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      reader = stream.getReader()
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          controller.enqueue(value)
          if (decompressor) {
            if (!decompressorFailed && !decompressorEnded) {
              if (truncated) {
                // The decoded trace already exceeded the capture cap: stop
                // feeding the decompressor so the trace side work cannot
                // grow without bound or delay upstream cancellation. end()
                // flushes the bytes already accepted, preserving the
                // captured plain-text prefix.
                decompressorEnded = true
                activelyEnded = true
                decompressor.end()
              } else if (!decompressor.write(value)) {
                await waitForDecompressorDrain()
              }
            }
          } else if (!unsupportedEncoding) {
            captureDecoded(value)
          }
        }
        controller.close()
        await finishDecompressor()
        void finalize()
      } catch (err) {
        controller.error(err)
        activelyEnded = true
        await finishDecompressor()
        void finalize(err)
      } finally {
        reader?.releaseLock()
        reader = null
      }
    },
    async cancel(reason) {
      const error = reason instanceof Error
        ? reason
        : new Error(reason ? `Stream cancelled: ${String(reason)}` : 'Stream cancelled')
      activelyEnded = true
      await finishDecompressor()
      void finalize(error)
      await reader?.cancel(reason).catch(() => undefined)
    },
  })
}
