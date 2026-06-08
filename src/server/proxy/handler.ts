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

import { createHash } from 'node:crypto'
import { signClaudeCodeCCHInTransformedString } from '../../utils/claudeCodeCch.js'
import { ProviderService } from '../services/providerService.js'
import { ensureClaudeCodeAttribution } from './claudeCodeAttribution.js'
import { anthropicToOpenaiChat } from './transform/anthropicToOpenaiChat.js'
import { anthropicToOpenaiResponses } from './transform/anthropicToOpenaiResponses.js'
import { openaiChatToAnthropic } from './transform/openaiChatToAnthropic.js'
import { openaiResponsesToAnthropic } from './transform/openaiResponsesToAnthropic.js'
import { openaiChatStreamToAnthropic } from './streaming/openaiChatStreamToAnthropic.js'
import { openaiResponsesStreamToAnthropic } from './streaming/openaiResponsesStreamToAnthropic.js'
import type { AnthropicContentBlock, AnthropicRequest } from './transform/types.js'
import { getProxyFetchOptions } from '../../utils/proxy.js'
import { getManualNetworkProxyUrl, loadNetworkSettings } from '../services/networkSettings.js'
import { normalizeModelStringForAPI } from '../../utils/model/model.js'
import {
  formatRedteamConfirmationGate,
  prepareRedteamWorkflowPrompt,
  recordRedteamWorkflowCliMessage,
} from '../services/redteamWorkflowGuard.js'

const providerService = new ProviderService()

type ProxyFetchOptions = ReturnType<typeof getProxyFetchOptions>
type UpstreamRequestInit = RequestInit & ProxyFetchOptions

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

  body = ensureClaudeCodeAttribution({
    ...body,
    model: normalizeModelStringForAPI(body.model),
  })

  const redteamGuard = applyRedteamWorkflowGuard(req, body)
  if (redteamGuard.response) {
    return redteamGuard.response
  }
  body = redteamGuard.body

  const isStream = body.stream === true
  const baseUrl = config.baseUrl.replace(/\/+$/, '')
  const networkSettings = await loadNetworkSettings()
  const proxyUrl = getManualNetworkProxyUrl(networkSettings)

  try {
    if (config.apiFormat === 'openai_chat') {
      return await handleOpenaiChat(body, baseUrl, config.apiKey, isStream, networkSettings.aiRequestTimeoutMs, proxyUrl)
    } else {
      return await handleOpenaiResponses(body, baseUrl, config.apiKey, isStream, networkSettings.aiRequestTimeoutMs, proxyUrl)
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

function applyRedteamWorkflowGuard(
  req: Request,
  body: AnthropicRequest,
): { body: AnthropicRequest; response?: undefined } | { response: Response } {
  const latestUserText = getLatestUserText(body)
  if (!latestUserText) return { body }

  const sessionId = getRedteamSessionId(req, body)
  for (const message of body.messages) {
    recordRedteamWorkflowCliMessage(sessionId, { message })
  }

  const result = prepareRedteamWorkflowPrompt(
    sessionId,
    latestUserText,
    getRedteamWorkDir(req),
  )
  if (!result.injected) return { body }

  if (result.run?.awaitingGate) {
    return {
      response: createAnthropicTextResponse(
        body,
        formatRedteamConfirmationGate(result.run),
      ),
    }
  }

  return {
    body: replaceLatestUserText(body, result.content),
  }
}

function getLatestUserText(body: AnthropicRequest): string {
  for (let i = body.messages.length - 1; i >= 0; i -= 1) {
    const message = body.messages[i]
    if (message?.role !== 'user') continue
    return textFromAnthropicContent(message.content).trim()
  }
  return ''
}

function getRedteamSessionId(req: Request, body: AnthropicRequest): string {
  const explicit =
    req.headers.get('x-cc-haha-session-id') ||
    req.headers.get('x-cchaha-session-id') ||
    req.headers.get('x-session-id') ||
    req.headers.get('x-codex-session-id')
  if (explicit?.trim()) return `proxy:${explicit.trim()}`

  const conversationText = body.messages
    .map((message) => textFromAnthropicContent(message.content))
    .join('\n')
  const target = extractTargetHint(conversationText)
  if (target) return `proxy-target:${target}`

  const seed = conversationText || body.model || 'redteam-proxy'
  return `proxy:${createHash('sha256').update(seed).digest('hex').slice(0, 16)}`
}

function getRedteamWorkDir(req: Request): string {
  return (
    req.headers.get('x-cc-haha-work-dir') ||
    req.headers.get('x-cchaha-work-dir') ||
    req.headers.get('x-codex-cwd') ||
    process.cwd()
  )
}

function textFromAnthropicContent(content: AnthropicRequest['messages'][number]['content']): string {
  if (typeof content === 'string') return content
  return content.map(textFromAnthropicBlock).filter(Boolean).join('\n')
}

function textFromAnthropicBlock(block: AnthropicContentBlock): string {
  if (block.type === 'text') return block.text
  if (block.type === 'tool_result') {
    if (typeof block.content === 'string') return block.content
    return block.content.map(textFromAnthropicBlock).filter(Boolean).join('\n')
  }
  if (block.type === 'thinking') return block.thinking
  return ''
}

function replaceLatestUserText(body: AnthropicRequest, text: string): AnthropicRequest {
  const messages = body.messages.slice()
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]
    if (message?.role !== 'user') continue
    messages[i] = {
      ...message,
      content: replaceTextContent(message.content, text),
    }
    return { ...body, messages }
  }
  return body
}

function replaceTextContent(
  content: AnthropicRequest['messages'][number]['content'],
  text: string,
): AnthropicRequest['messages'][number]['content'] {
  if (typeof content === 'string') return text

  let replaced = false
  const blocks = content.map((block) => {
    if (block.type !== 'text' || replaced) return block
    replaced = true
    return { ...block, text }
  })
  if (replaced) return blocks
  return [{ type: 'text', text }, ...blocks]
}

function extractTargetHint(content: string): string | null {
  const url = content.match(/https?:\/\/[^\s"'<>，。；、？！)）】》\]\u4e00-\u9fff]+/iu)?.[0]
  if (url) return url.replace(/[.,，。]+$/, '')

  const ip = content.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/)?.[0]
  if (ip) return ip

  const domain = content.match(/\b[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+\b/i)?.[0]
  return domain ?? null
}

function createAnthropicTextResponse(body: AnthropicRequest, text: string): Response {
  if (body.stream === true) {
    return new Response(createAnthropicTextStream(body, text), {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    })
  }

  return Response.json({
    id: `msg_redteam_guard_${Date.now()}`,
    type: 'message',
    role: 'assistant',
    model: body.model,
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: 0,
      output_tokens: estimateTokenCount(text),
    },
  })
}

function createAnthropicTextStream(body: AnthropicRequest, text: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  const messageId = `msg_redteam_guard_${Date.now()}`
  return new ReadableStream({
    start(controller) {
      const send = (event: string, data: unknown) => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`))
      }
      send('message_start', {
        type: 'message_start',
        message: {
          id: messageId,
          type: 'message',
          role: 'assistant',
          model: body.model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      })
      send('content_block_start', {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      })
      send('content_block_delta', {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text },
      })
      send('content_block_stop', { type: 'content_block_stop', index: 0 })
      send('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { output_tokens: estimateTokenCount(text) },
      })
      send('message_stop', { type: 'message_stop' })
      controller.close()
    },
  })
}

function estimateTokenCount(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4))
}

async function handleOpenaiChat(
  body: AnthropicRequest,
  baseUrl: string,
  apiKey: string,
  isStream: boolean,
  aiRequestTimeoutMs: number,
  proxyUrl: string | undefined,
): Promise<Response> {
  const deepSeekCompatible = shouldUseDeepSeekReasoningCompat(baseUrl)
  const transformed = anthropicToOpenaiChat(body, {
    roundTripReasoningContent: deepSeekCompatible,
    passThinkingToggle: deepSeekCompatible,
    imageContentMode: shouldUseTextOnlyOpenAIChatContent(baseUrl) ? 'text_only' : 'vision',
  })
  const url = `${baseUrl}/v1/chat/completions`
  const proxyOptions = getProxyFetchOptions({ proxyUrl })

  const upstream = await fetchUpstreamWithTimeout(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: signClaudeCodeCCHInTransformedString(JSON.stringify(transformed)),
    ...proxyOptions,
  }, aiRequestTimeoutMs, isStream)

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
    const upstreamBody = withStreamIdleTimeout(upstream.body, aiRequestTimeoutMs)
    const anthropicStream = openaiChatStreamToAnthropic(upstreamBody, body.model)
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
): Promise<Response> {
  const transformed = anthropicToOpenaiResponses(body)
  const url = `${baseUrl}/v1/responses`
  const proxyOptions = getProxyFetchOptions({ proxyUrl })

  const upstream = await fetchUpstreamWithTimeout(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: signClaudeCodeCCHInTransformedString(JSON.stringify(transformed)),
    ...proxyOptions,
  }, aiRequestTimeoutMs, isStream)

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
    const upstreamBody = withStreamIdleTimeout(upstream.body, aiRequestTimeoutMs)
    const anthropicStream = openaiResponsesStreamToAnthropic(upstreamBody, body.model)
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
