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
import { parseResponsesToolArguments, responsesTerminalStop } from './openaiResponsesTerminal.js'
import { openaiUsageToAnthropic } from './usage.js'
import { encodeOpenAIReasoningEnvelope } from './openaiReasoning.js'

export type OpenAIResponsesToAnthropicOptions = {
  preserveOpenAIReasoning?: boolean
}

/**
 * Convert OpenAI Responses API response to Anthropic Messages response.
 */
export function openaiResponsesToAnthropic(
  response: OpenAIResponsesResponse,
  model: string,
  options: OpenAIResponsesToAnthropicOptions = {},
): AnthropicResponse {
  const terminal = responsesTerminalStop(response)
  if (!Array.isArray(response.output)) throw new Error('Invalid OpenAI Responses output: expected an array')
  const content: AnthropicContentBlock[] = []
  let hasToolUse = false

  for (const item of response.output) {
    if (item.type === 'function_call' && terminal === 'max_tokens') continue
    convertOutputItem(item, content, options)
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
    stop_reason: terminal === 'max_tokens' ? 'max_tokens' : hasToolUse ? 'tool_use' : 'end_turn',
    stop_sequence: null,
    usage: openaiUsageToAnthropic(response.usage),
  }
}

function convertOutputItem(
  item: OpenAIResponsesOutputItem,
  content: AnthropicContentBlock[],
  options: OpenAIResponsesToAnthropicOptions,
): void {
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
      if (!item.call_id || !item.name) throw new Error('Invalid OpenAI Responses tool identity')
      content.push({
        type: 'tool_use',
        id: item.call_id,
        name: item.name,
        input: parseResponsesToolArguments(item.arguments),
      })
      break
    }
    case 'reasoning': {
      if (options.preserveOpenAIReasoning) {
        const data = encodeOpenAIReasoningEnvelope(item)
        if (data) {
          content.push({ type: 'redacted_thinking', data })
          break
        }
      }
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
