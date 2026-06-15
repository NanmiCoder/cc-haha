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

import { ProviderService } from '../services/providerService.js'
import { resolvePromptCacheKey } from './promptCacheKey.js'
import { anthropicToOpenaiChat } from './transform/anthropicToOpenaiChat.js'
import { anthropicToOpenaiResponses } from './transform/anthropicToOpenaiResponses.js'
import { openaiChatToAnthropic } from './transform/openaiChatToAnthropic.js'
import { openaiResponsesToAnthropic } from './transform/openaiResponsesToAnthropic.js'
import { openaiChatStreamToAnthropic } from './streaming/openaiChatStreamToAnthropic.js'
import { openaiResponsesStreamToAnthropic } from './streaming/openaiResponsesStreamToAnthropic.js'
import type { AnthropicRequest } from './transform/types.js'
import { getProxyFetchOptions } from '../../utils/proxy.js'
import { getManualNetworkProxyUrl, loadNetworkSettings } from '../services/networkSettings.js'
import { normalizeModelStringForAPI } from '../../utils/model/model.js'
import {
  createTraceCallId,
  createTraceBodySnapshot,
  TRACE_STREAM_CAPTURE_BYTES,
  traceCaptureService,
  type TraceBodySnapshot,
  type TraceProviderInfo,
} from '../services/traceCaptureService.js'

const providerService = new ProviderService()

type ProxyFetchOptions = ReturnType<typeof getProxyFetchOptions>
type UpstreamRequestInit = RequestInit & ProxyFetchOptions
type ProxyTraceContext = {
  sessionId: string
  provider: TraceProviderInfo
  anthropicRequest: AnthropicRequest
}

const TRACE_RECORDED_ERROR_MARKER = Symbol('cc-haha-trace-recorded-error')

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

  if (config.apiFormat === 'anthropic') {
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

  // Parse request body
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
  const proxyUrl = getManualNetworkProxyUrl(networkSettings)
  const traceContext = buildProxyTraceContext(req, config, body)
  const promptCacheKey = resolvePromptCacheKey(body, req.headers.get('x-claude-code-session-id'))

  try {
    if (config.apiFormat === 'openai_chat') {
      return await handleOpenaiChat(body, baseUrl, config.apiKey, isStream, networkSettings.aiRequestTimeoutMs, proxyUrl, traceContext)
    } else {
      return await handleOpenaiResponses(body, baseUrl, config.apiKey, isStream, networkSettings.aiRequestTimeoutMs, proxyUrl, traceContext, promptCacheKey)
    }
  } catch (err) {
    if (traceContext && !wasTraceErrorRecorded(err)) {
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
}

async function handleOpenaiChat(
  body: AnthropicRequest,
  baseUrl: string,
  apiKey: string,
  isStream: boolean,
  aiRequestTimeoutMs: number,
  proxyUrl: string | undefined,
  traceContext: ProxyTraceContext | null,
): Promise<Response> {
  const deepSeekCompatible = shouldUseDeepSeekReasoningCompat(baseUrl)
  const transformed = anthropicToOpenaiChat(body, {
    roundTripReasoningContent: deepSeekCompatible,
    passThinkingToggle: deepSeekCompatible,
    imageContentMode: shouldUseTextOnlyOpenAIChatContent(baseUrl) ? 'text_only' : 'vision',
  })
  const url = `${baseUrl}/v1/chat/completions`
  const proxyOptions = getProxyFetchOptions({ proxyUrl })
  const startedAtMs = Date.now()
  const startedAt = new Date(startedAtMs).toISOString()
  const traceCallId = traceContext
    ? startProxyTraceCall({
        context: traceContext,
        model: body.model,
        upstreamUrl: url,
        upstreamRequest: transformed,
        startedAt,
      })
    : undefined

  let upstream: Response
  try {
    upstream = await fetchUpstreamWithTimeout(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(transformed),
      ...proxyOptions,
    }, aiRequestTimeoutMs, isStream)
  } catch (err) {
    if (traceContext) {
      await recordProxyTrace({
        callId: traceCallId,
        context: traceContext,
        model: body.model,
        upstreamUrl: url,
        upstreamRequest: transformed,
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
    const errorBody = {
      type: 'error',
      error: {
        type: 'api_error',
        message: `Upstream returned HTTP ${upstream.status}: ${errText.slice(0, 500)}`,
      },
    }
    if (traceContext) {
      await recordProxyTrace({
        context: traceContext,
        callId: traceCallId,
        model: body.model,
        upstreamUrl: url,
        upstreamRequest: transformed,
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
      { status: upstream.status },
    )
  }

  if (isStream) {
    if (!upstream.body) {
      if (traceContext) {
        await recordProxyTrace({
          callId: traceCallId,
          context: traceContext,
          model: body.model,
          upstreamUrl: url,
          upstreamRequest: transformed,
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
    const upstreamBody = withStreamIdleTimeout(upstream.body, aiRequestTimeoutMs)
    const anthropicStream = openaiChatStreamToAnthropic(upstreamBody, body.model)
    const tracedStream = traceContext
      ? captureTraceStream(anthropicStream, async (bodySnapshot, error) => {
          await recordProxyTrace({
            callId: traceCallId,
            context: traceContext,
            model: body.model,
            upstreamUrl: url,
            upstreamRequest: transformed,
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
  const anthropicResponse = openaiChatToAnthropic(responseBody, body.model)
  if (traceContext) {
    await recordProxyTrace({
      callId: traceCallId,
      context: traceContext,
      model: body.model,
      upstreamUrl: url,
      upstreamRequest: transformed,
      startedAt,
      startedAtMs,
      responseStatus: 200,
      upstreamResponseBody: responseBody,
      anthropicResponseBody: anthropicResponse,
      responseHeaders: upstream.headers,
    })
  }
  return Response.json(anthropicResponse)
}

function shouldUseDeepSeekReasoningCompat(baseUrl: string): boolean {
  return (
    /(^|[./-])deepseek([./-]|$)/i.test(baseUrl) ||
    /(^|[./-])opencode\.ai([:/]|$)/i.test(baseUrl)
  )
}

function shouldUseTextOnlyOpenAIChatContent(baseUrl: string): boolean {
  return shouldUseDeepSeekReasoningCompat(baseUrl)
}

async function handleOpenaiResponses(
  body: AnthropicRequest,
  baseUrl: string,
  apiKey: string,
  isStream: boolean,
  aiRequestTimeoutMs: number,
  proxyUrl: string | undefined,
  traceContext: ProxyTraceContext | null,
  promptCacheKey?: string,
): Promise<Response> {
  const transformed = anthropicToOpenaiResponses(body, { cacheKey: promptCacheKey })
  const url = `${baseUrl}/v1/responses`
  const proxyOptions = getProxyFetchOptions({ proxyUrl })
  const startedAtMs = Date.now()
  const startedAt = new Date(startedAtMs).toISOString()
  const traceCallId = traceContext
    ? startProxyTraceCall({
        context: traceContext,
        model: body.model,
        upstreamUrl: url,
        upstreamRequest: transformed,
        startedAt,
      })
    : undefined

  let upstream: Response
  try {
    upstream = await fetchUpstreamWithTimeout(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(transformed),
      ...proxyOptions,
    }, aiRequestTimeoutMs, isStream)
  } catch (err) {
    if (traceContext) {
      await recordProxyTrace({
        callId: traceCallId,
        context: traceContext,
        model: body.model,
        upstreamUrl: url,
        upstreamRequest: transformed,
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
    const errorBody = {
      type: 'error',
      error: {
        type: 'api_error',
        message: `Upstream returned HTTP ${upstream.status}: ${errText.slice(0, 500)}`,
      },
    }
    if (traceContext) {
      await recordProxyTrace({
        context: traceContext,
        callId: traceCallId,
        model: body.model,
        upstreamUrl: url,
        upstreamRequest: transformed,
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
      { status: upstream.status },
    )
  }

  if (isStream) {
    if (!upstream.body) {
      if (traceContext) {
        await recordProxyTrace({
          callId: traceCallId,
          context: traceContext,
          model: body.model,
          upstreamUrl: url,
          upstreamRequest: transformed,
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
    const upstreamBody = withStreamIdleTimeout(upstream.body, aiRequestTimeoutMs)
    const anthropicStream = openaiResponsesStreamToAnthropic(upstreamBody, body.model)
    const tracedStream = traceContext
      ? captureTraceStream(anthropicStream, async (bodySnapshot, error) => {
          await recordProxyTrace({
            callId: traceCallId,
            context: traceContext,
            model: body.model,
            upstreamUrl: url,
            upstreamRequest: transformed,
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
  const anthropicResponse = openaiResponsesToAnthropic(responseBody, body.model)
  if (traceContext) {
    await recordProxyTrace({
      callId: traceCallId,
      context: traceContext,
      model: body.model,
      upstreamUrl: url,
      upstreamRequest: transformed,
      startedAt,
      startedAtMs,
      responseStatus: 200,
      upstreamResponseBody: responseBody,
      anthropicResponseBody: anthropicResponse,
      responseHeaders: upstream.headers,
    })
  }
  return Response.json(anthropicResponse)
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
  startedAt,
}: {
  context: ProxyTraceContext
  model: string
  upstreamUrl: string
  upstreamRequest: unknown
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

async function recordProxyTrace({
  callId,
  context,
  model,
  upstreamUrl,
  upstreamRequest,
  startedAt,
  startedAtMs,
  responseStatus,
  upstreamResponseBody,
  anthropicResponseBody,
  responseBodySnapshot,
  responseHeaders,
  error,
}: {
  callId?: string
  context: ProxyTraceContext
  model: string
  upstreamUrl: string
  upstreamRequest: unknown
  startedAt: string
  startedAtMs: number
  responseStatus?: number
  upstreamResponseBody?: unknown
  anthropicResponseBody?: unknown
  responseBodySnapshot?: TraceBodySnapshot
  responseHeaders?: Headers
  error?: unknown
}): Promise<void> {
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
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder()
  let captured = ''
  let bytes = 0
  let truncated = false
  let finalized = false
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null

  const captureChunk = (chunk: Uint8Array) => {
    bytes += chunk.byteLength
    if (bytes <= TRACE_STREAM_CAPTURE_BYTES) {
      captured += decoder.decode(chunk, { stream: true })
    } else {
      truncated = true
    }
  }

  const finalize = async (error?: unknown) => {
    if (finalized) return
    finalized = true
    captured += decoder.decode()
    const snapshot = createTraceBodySnapshot(captured, { alreadyTruncated: truncated })
    await onComplete(snapshot, error).catch(() => {})
  }

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      reader = stream.getReader()
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          captureChunk(value)
          controller.enqueue(value)
        }
        await finalize()
        controller.close()
      } catch (err) {
        await finalize(err)
        controller.error(err)
      } finally {
        reader?.releaseLock()
        reader = null
      }
    },
    async cancel(reason) {
      const error = reason instanceof Error
        ? reason
        : new Error(reason ? `Stream cancelled: ${String(reason)}` : 'Stream cancelled')
      await finalize(error)
      await reader?.cancel(reason).catch(() => undefined)
    },
  })
}
