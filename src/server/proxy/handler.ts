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
import { anthropicToOpenaiChat } from './transform/anthropicToOpenaiChat.js'
import { anthropicToOpenaiResponses } from './transform/anthropicToOpenaiResponses.js'
import { openaiChatToAnthropic } from './transform/openaiChatToAnthropic.js'
import { openaiResponsesToAnthropic } from './transform/openaiResponsesToAnthropic.js'
import { openaiChatStreamToAnthropic } from './streaming/openaiChatStreamToAnthropic.js'
import { openaiResponsesStreamToAnthropic } from './streaming/openaiResponsesStreamToAnthropic.js'
import type { AnthropicRequest } from './transform/types.js'

const providerService = new ProviderService()

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

  // Anthropic-format providers also route through the proxy for error
  // normalization. Third-party APIs often return non-standard error shapes
  // like {"error":{"message":"...","type":"input_invalid"}} that cause
  // conversation history corruption and cascade failures if passed through
  // directly. The passthrough handler normalizes these to proper Anthropic
  // error format: {type:"error", error:{type:"...", message:"..."}}.

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

  const isStream = body.stream === true
  const baseUrl = config.baseUrl.replace(/\/+$/, '')

  try {
    if (config.apiFormat === 'openai_chat') {
      return await handleOpenaiChat(body, baseUrl, config.apiKey, isStream)
    } else if (config.apiFormat === 'openai_responses') {
      return await handleOpenaiResponses(body, baseUrl, config.apiKey, isStream)
    } else {
      // anthropic passthrough with error normalization
      return await handleAnthropicPassthrough(body, baseUrl, config.apiKey, isStream)
    }
  } catch (err) {
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
): Promise<Response> {
  const transformed = anthropicToOpenaiChat(body)
  const url = `${baseUrl}/v1/chat/completions`

  const upstream = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(transformed),
    signal: isStream ? AbortSignal.timeout(30_000) : AbortSignal.timeout(300_000),
  })

  if (!upstream.ok) {
    const errText = await upstream.text().catch(() => '')
    return Response.json(
      {
        type: 'error',
        error: {
          type: 'api_error',
          message: `Upstream returned HTTP ${upstream.status}: ${errText.slice(0, 500)}`,
        },
      },
      { status: upstream.status },
    )
  }

  if (isStream) {
    if (!upstream.body) {
      return Response.json(
        { type: 'error', error: { type: 'api_error', message: 'Upstream returned no body for stream' } },
        { status: 502 },
      )
    }
    const anthropicStream = openaiChatStreamToAnthropic(upstream.body, body.model)
    return new Response(anthropicStream, {
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
  return Response.json(anthropicResponse)
}

async function handleOpenaiResponses(
  body: AnthropicRequest,
  baseUrl: string,
  apiKey: string,
  isStream: boolean,
): Promise<Response> {
  const transformed = anthropicToOpenaiResponses(body)
  const url = `${baseUrl}/v1/responses`

  const upstream = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(transformed),
    signal: isStream ? AbortSignal.timeout(30_000) : AbortSignal.timeout(300_000),
  })

  if (!upstream.ok) {
    const errText = await upstream.text().catch(() => '')
    return Response.json(
      {
        type: 'error',
        error: {
          type: 'api_error',
          message: `Upstream returned HTTP ${upstream.status}: ${errText.slice(0, 500)}`,
        },
      },
      { status: upstream.status },
    )
  }

  if (isStream) {
    if (!upstream.body) {
      return Response.json(
        { type: 'error', error: { type: 'api_error', message: 'Upstream returned no body for stream' } },
        { status: 502 },
      )
    }
    const anthropicStream = openaiResponsesStreamToAnthropic(upstream.body, body.model)
    return new Response(anthropicStream, {
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
  return Response.json(anthropicResponse)
}

/**
 * Anthropic passthrough handler — forwards requests as-is to the upstream
 * Anthropic-compatible API, but intercepts error responses and normalizes them
 * to proper Anthropic format.
 *
 * Many third-party Anthropic-compatible APIs return errors in non-standard
 * shapes like:
 *   {"error":{"message":"The input you provided is invalid","type":"input_invalid"}}
 *
 * These non-standard errors cause cc-haha's error handler to produce a malformed
 * AssistantMessage which, when injected into conversation history, triggers a
 * cascade failure: every subsequent request also fails. Normalizing to the
 * standard {type:"error", error:{type:"...", message:"..."}} shape prevents
 * this corruption.
 */
async function handleAnthropicPassthrough(
  body: AnthropicRequest,
  baseUrl: string,
  apiKey: string,
  isStream: boolean,
): Promise<Response> {
  const url = `${baseUrl}/v1/messages`

  const upstream = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
    signal: isStream ? AbortSignal.timeout(30_000) : AbortSignal.timeout(300_000),
  })

  if (!upstream.ok) {
    const errText = await upstream.text().catch(() => '')
    return Response.json(
      normalizeAnthropicError(upstream.status, errText),
      { status: upstream.status },
    )
  }

  // Pass through successful response as-is
  if (isStream) {
    if (!upstream.body) {
      return Response.json(
        { type: 'error', error: { type: 'api_error', message: 'Upstream returned no body for stream' } },
        { status: 502 },
      )
    }
    return new Response(upstream.body, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    })
  }

  return new Response(upstream.body, {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

/**
 * Normalize a non-standard API error response body into proper Anthropic format.
 *
 * Recognizes upstream error shapes:
 *   {"error":{"message":"...","type":"input_invalid"}}  → standard format
 *   {"error":{"message":"..."}}                          → standard format
 *   Any other JSON or plain text                         → wrapped as api_error
 */
function normalizeAnthropicError(status: number, rawBody: string): {
  type: string
  error: { type: string; message: string }
} {
  try {
    const parsed = JSON.parse(rawBody)
    if (parsed?.error?.message) {
      const errType = parsed.error.type || 'invalid_request_error'
      return {
        type: 'error',
        error: {
          type: errType,
          message: String(parsed.error.message),
        },
      }
    }
  } catch {
    // Not JSON — use raw body as message
  }

  return {
    type: 'error',
    error: {
      type: status >= 500 ? 'api_error' : 'invalid_request_error',
      message: rawBody.slice(0, 500) || `HTTP ${status}`,
    },
  }
}
