/**
 * Response transformation: OpenAI Responses API → Anthropic Messages
 * Derived from cc-switch (https://github.com/farion1231/cc-switch)
 * Original work by Jason Young, MIT License
 */

import type {
  OpenAIResponsesResponse,
  OpenAIResponsesOutputItem,
  AnthropicResponse,
  AnthropicContentBlock,
} from './types.js'

/**
 * Convert OpenAI Responses API response to Anthropic Messages response.
 */
export function openaiResponsesToAnthropic(response: OpenAIResponsesResponse, model: string): AnthropicResponse {
  const content: AnthropicContentBlock[] = []
  let hasToolUse = false

  for (const item of response.output || []) {
    convertOutputItem(item, content)
    if (item.type === 'function_call') hasToolUse = true
  }

  // If no content, add empty text
  if (content.length === 0) {
    content.push({ type: 'text', text: '' })
  }

  return {
    id: response.id || `msg_${Date.now()}`,
    type: 'message',
    role: 'assistant',
    content,
    model: response.model || model,
    stop_reason: mapStatus(response.status, hasToolUse),
    stop_sequence: null,
    usage: {
      input_tokens: response.usage?.input_tokens || 0,
      output_tokens: response.usage?.output_tokens || 0,
    },
  }
}

function convertOutputItem(item: OpenAIResponsesOutputItem, content: AnthropicContentBlock[]): void {
  switch (item.type) {
    case 'message': {
      for (const part of item.content || []) {
        if (part.type === 'output_text' || part.type === 'text') {
          content.push({ type: 'text', text: part.text || '' })
        } else if (part.type === 'refusal') {
          content.push({ type: 'text', text: part.refusal || '[Refusal]' })
        }
      }
      break
    }
    case 'function_call': {
      let input: Record<string, unknown> = {}
      try {
        input = JSON.parse(item.arguments)
      } catch {
        input = { raw: item.arguments }
      }
      content.push({
        type: 'tool_use',
        id: item.call_id,
        name: item.name,
        input,
      })
      break
    }
    case 'reasoning': {
      if (item.summary) {
        for (const s of item.summary) {
          if (s.text) {
            content.push({
              type: 'thinking',
              thinking: s.text,
            })
          }
        }
      }
      break
    }
  }
}

function mapStatus(status: string, hasToolUse: boolean): string {
  switch (status) {
    case 'completed': return hasToolUse ? 'tool_use' : 'end_turn'
    case 'failed': return 'end_turn'
    case 'cancelled': return 'end_turn'
    case 'incomplete': return 'max_tokens'
    default: return 'end_turn'
  }
}
