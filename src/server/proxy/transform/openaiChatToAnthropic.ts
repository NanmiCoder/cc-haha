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

/**
 * Convert OpenAI Chat Completions response to Anthropic Messages response.
 */
export function openaiChatToAnthropic(response: OpenAIChatResponse, model: string): AnthropicResponse {
  const choice = response.choices?.[0]
  if (!choice) {
    return createEmptyResponse(response, model)
  }

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
    for (const tc of choice.message.tool_calls) {
      let input: Record<string, unknown> = {}
      try {
        input = JSON.parse(tc.function.arguments)
      } catch {
        input = { raw: tc.function.arguments }
      }
      content.push({
        type: 'tool_use',
        id: tc.id,
        name: tc.function.name,
        input,
      })
    }
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
    stop_reason: mapFinishReason(choice.finish_reason),
    stop_sequence: null,
    usage: mapUsage(response.usage),
  }
}

function mapFinishReason(reason: string | null): string {
  switch (reason) {
    case 'stop': return 'end_turn'
    case 'tool_calls': return 'tool_use'
    case 'length': return 'max_tokens'
    case 'content_filter': return 'end_turn'
    default: return 'end_turn'
  }
}

function mapUsage(usage?: OpenAIChatResponse['usage']): AnthropicResponse['usage'] {
  if (!usage) {
    return { input_tokens: 0, output_tokens: 0 }
  }
  return {
    input_tokens: usage.prompt_tokens || 0,
    output_tokens: usage.completion_tokens || 0,
    cache_read_input_tokens: usage.prompt_tokens_details?.cached_tokens || 0,
  }
}

function createEmptyResponse(response: OpenAIChatResponse, model: string): AnthropicResponse {
  return {
    id: response.id || `msg_${Date.now()}`,
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text: '' }],
    model: response.model || model,
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: mapUsage(response.usage),
  }
}
