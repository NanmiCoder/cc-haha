import { parseResponsesToolArguments } from '../transform/openaiResponsesTerminal.js'
import type { AnthropicContentBlock, AnthropicResponse } from '../transform/types.js'
import { openaiResponsesStreamToAnthropic } from './openaiResponsesStreamToAnthropic.js'

export type OpenAIResponsesCollectOptions = {
  openAICodexOAuth?: boolean
}

/** Collect the same validated stream contract used by streaming callers. */
export async function openaiResponsesStreamToAnthropicResponse(
  upstream: ReadableStream<Uint8Array>,
  model: string,
  options: OpenAIResponsesCollectOptions = {},
): Promise<AnthropicResponse> {
  const reader = openaiResponsesStreamToAnthropic(upstream, model, options).getReader()
  const decoder = new TextDecoder()
  const blocks = new Map<number, Record<string, unknown>>()
  const argumentsByIndex = new Map<number, string>()
  const response: AnthropicResponse = {
    id: `msg_${Date.now()}`, type: 'message', role: 'assistant', model,
    content: [], stop_reason: null, stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0 },
  }
  let stopped = false
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      // Our converter emits each Anthropic event as a complete encoded frame.
      // Upstream chunking and SSE field syntax are handled there, once.
      const frame = decoder.decode(value)
      const line = frame.split('\n').find(item => item.startsWith('data: '))
      if (!line) continue
      const event = JSON.parse(line.slice(6))
      if (event.type === 'error') {
        const error = event.error
        throw Object.assign(new Error(error.message), error, error.type === 'permission_error' ? { status: 403 } : {})
      }
      if (event.type === 'message_start') {
        response.id = event.message.id
        response.model = event.message.model
      } else if (event.type === 'content_block_start') {
        blocks.set(event.index, { ...event.content_block })
        if (event.content_block.type === 'tool_use') argumentsByIndex.set(event.index, '')
      } else if (event.type === 'content_block_delta') {
        const block = blocks.get(event.index)
        if (!block) throw new Error('OpenAI Responses delta has no content block')
        const delta = event.delta
        if (delta.type === 'input_json_delta') {
          argumentsByIndex.set(event.index, (argumentsByIndex.get(event.index) ?? '') + delta.partial_json)
        } else if (delta.type === 'text_delta') {
          block.text = String(block.text ?? '') + delta.text
        } else if (delta.type === 'thinking_delta') {
          block.thinking = String(block.thinking ?? '') + delta.thinking
        } else if (delta.type === 'signature_delta') {
          block.signature = String(block.signature ?? '') + delta.signature
        }
      } else if (event.type === 'message_delta') {
        response.stop_reason = event.delta.stop_reason
        response.usage = { ...response.usage, ...event.usage }
      } else if (event.type === 'message_stop') {
        stopped = true
      }
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
  if (!stopped || response.stop_reason === null) {
    throw Object.assign(new Error('OpenAI Responses stream closed before response.completed'), { code: 'ERR_STREAM_PREMATURE_CLOSE' })
  }
  for (const [index, block] of [...blocks.entries()].sort(([a], [b]) => a - b)) {
    if (block.type === 'tool_use') {
      if (response.stop_reason === 'max_tokens') continue
      block.input = parseResponsesToolArguments(argumentsByIndex.get(index))
    }
    response.content.push(block as AnthropicContentBlock)
  }
  if (response.content.length === 0) response.content.push({ type: 'text', text: '' })
  return response
}
