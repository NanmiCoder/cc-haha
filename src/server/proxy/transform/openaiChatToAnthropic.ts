/**
 * Response transformation: OpenAI Chat Completions → Anthropic Messages
 * Derived from cc-switch (https://github.com/farion1231/cc-switch)
 * Original work by Jason Young, MIT License
 */

import type {
  OpenAIChatResponse,
  AnthropicResponse,
  AnthropicContentBlock,
} from './types.js'
import { openaiUsageToAnthropic } from './usage.js'

/**
 * Convert OpenAI Chat Completions response to Anthropic Messages response.
 */
export function openaiChatToAnthropic(response: OpenAIChatResponse, model: string): AnthropicResponse {
  const upstreamError = getChatResponseError(response)
  if (upstreamError) throw new Error(upstreamError)
  const choice = response.choices?.[0]
  if (!choice?.message) throw new Error('OpenAI Chat upstream response has no message choice')
  const stopReason = mapFinishReason(choice.finish_reason)

  const content: AnthropicContentBlock[] = []

  // Convert reasoning/thinking content (all provider formats)
  const msg = choice.message as Record<string, unknown>

  // Format 1: reasoning_content (DeepSeek, OpenRouter, XAI, Perplexity)
  if (typeof msg.reasoning_content === 'string' && msg.reasoning_content) {
    content.push({ type: 'thinking', thinking: msg.reasoning_content })
  }
  // Format 2: reasoning (GLM-5, Cerebras, Groq)
  else if (typeof msg.reasoning === 'string' && msg.reasoning) {
    content.push({ type: 'thinking', thinking: msg.reasoning })
  }
  // Format 3: thinking_blocks (OpenAI o-series)
  else if (Array.isArray(msg.thinking_blocks)) {
    for (const tb of msg.thinking_blocks as Array<Record<string, unknown>>) {
      if (tb.type === 'thinking' && typeof tb.thinking === 'string') {
        content.push({ type: 'thinking', thinking: tb.thinking, signature: tb.signature as string | undefined })
      }
    }
  }

  // Convert text content
  if (choice.message.content) {
    content.push({ type: 'text', text: choice.message.content })
  }

  // Convert tool calls
  if (choice.message.tool_calls) {
    const callIds = new Set<string>()
    for (const tc of choice.message.tool_calls) {
      // A truncated turn must not promote partial JSON into executable input.
      // The runtime receives max_tokens and can choose a fresh continuation.
      if (stopReason === 'max_tokens' || choice.finish_reason === 'content_filter') continue
      if (!tc.id?.trim() || !tc.function?.name?.trim() || callIds.has(tc.id)) {
        throw new Error('OpenAI Chat tool call has missing or duplicate identity')
      }
      callIds.add(tc.id)
      content.push({
        type: 'tool_use',
        id: tc.id,
        name: tc.function.name,
        input: parseCompleteChatToolArguments(tc.function.arguments),
      })
    }
  }

  if (stopReason === 'tool_use' && !content.some(block => block.type === 'tool_use')) {
    throw new Error('OpenAI Chat upstream finished with tool_calls but supplied no tool calls')
  }

  // If no content at all, add empty text
  if (content.length === 0) {
    content.push({ type: 'text', text: '' })
  }

  return {
    id: response.id || `msg_${Date.now()}`,
    type: 'message',
    role: 'assistant',
    content,
    model: response.model || model,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: openaiUsageToAnthropic(response.usage),
  }
}

function mapFinishReason(reason: string | null): string {
  switch (reason) {
    case 'stop': return 'end_turn'
    case 'tool_calls': return 'tool_use'
    case 'length': return 'max_tokens'
    case 'content_filter': return 'end_turn'
    default: throw new Error(`OpenAI Chat upstream returned missing or unknown finish_reason: ${reason}`)
  }
}

/** Completed tool input must be an object, never a repaired fragment. */
export function parseCompleteChatToolArguments(value: unknown): Record<string, unknown> {
  const parsed: unknown = value == null || value === '' ? {} : typeof value === 'string' ? JSON.parse(value) : value
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('OpenAI Chat completed tool arguments must be a JSON object')
  }
  return parsed as Record<string, unknown>
}

/** HTTP success does not imply a successful model response. */
export function getChatResponseError(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'OpenAI Chat upstream returned an invalid response'
  const body = value as Record<string, unknown>
  if (body.error != null) {
    if (typeof body.error === 'string' && body.error) return body.error
    const error = body.error as Record<string, unknown>
    return typeof error.message === 'string' && error.message ? error.message : 'OpenAI Chat upstream reported an error'
  }
  if (body.status === 'failed' || body.status === 'cancelled') return `OpenAI Chat upstream response ${body.status}`
  return null
}
