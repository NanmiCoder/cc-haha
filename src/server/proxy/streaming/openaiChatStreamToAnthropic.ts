/**
 * Streaming SSE transformation: OpenAI Chat Completions → Anthropic Messages
 *
 * Converts an OpenAI-compatible streaming response into Anthropic Messages
 * streaming format. Follows the patterns established by LiteLLM's
 * AnthropicStreamWrapper for correctness across many providers.
 *
 * Anthropic event order:
 *   message_start
 *     → (content_block_start → content_block_delta* → content_block_stop)*
 *     → message_delta
 *     → message_stop
 *
 * Derived from cc-switch (https://github.com/farion1231/cc-switch)
 * Original work by Jason Young, MIT License
 *
 * Provider-specific reasoning formats handled:
 *   - delta.reasoning_content  (DeepSeek, OpenRouter, XAI, Perplexity, …)
 *   - delta.thinking_blocks    (OpenAI o-series)
 *   - delta.reasoning          (GLM-5, Cerebras, Groq — mapped to reasoning_content)
 */

import { getOpenAIPolicyError } from '../../../services/openaiAuth/policyError.js'
import type { OpenAIChatStreamChunk } from '../transform/types.js'
import { stringifyOpenAIToolArguments } from '../transform/toolArguments.js'
import { getChatResponseError, parseCompleteChatToolArguments } from '../transform/openaiChatToAnthropic.js'
import { openaiUsageToAnthropic } from '../transform/usage.js'

// ─── Types ─────────────────────────────────────────────────

type ContentBlockType = 'text' | 'thinking' | 'tool_use'

type ToolBlockState = {
  id: string
  name: string
  argsBuffer: string
  started: boolean
  anthropicIndex: number
}

type SseEvent = { event: string; data: unknown }

type StreamState = {
  // Event queue — guarantees correct multi-event ordering
  queue: SseEvent[]

  // Content block tracking (mirrors LiteLLM's state machine)
  currentBlockType: ContentBlockType
  currentBlockIndex: number
  nextContentIndex: number
  blockStartSent: boolean   // content_block_start emitted for current block?
  blockStopSent: boolean    // content_block_stop emitted for current block?

  // Tool call tracking
  toolBlocks: Map<number, ToolBlockState>

  // Message lifecycle
  model: string
  messageStartSent: boolean
  messageDeltaSent: boolean
  messageStopSent: boolean

  // Holding pattern: hold message_delta until usage arrives
  // (some providers send finish_reason and usage in separate chunks)
  heldMessageDelta: SseEvent | null
  finishReason: string | null
}

// ─── Helpers ───────────────────────────────────────────────

function formatSse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

function createState(model: string): StreamState {
  return {
    queue: [],
    currentBlockType: 'text',
    currentBlockIndex: -1,
    nextContentIndex: 0,
    blockStartSent: false,
    blockStopSent: false,
    toolBlocks: new Map(),
    model,
    messageStartSent: false,
    messageDeltaSent: false,
    messageStopSent: false,
    heldMessageDelta: null,
    finishReason: null,
  }
}

// ─── Public entry point ────────────────────────────────────

/**
 * Transform an OpenAI Chat Completions SSE stream into an Anthropic Messages SSE stream.
 */
export function openaiChatStreamToAnthropic(
  upstream: ReadableStream<Uint8Array>,
  model: string,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  const decoder = new TextDecoder()
  const state = createState(model)
  const reader = upstream.getReader()
  let cancelled = false

  return new ReadableStream({
    async start(controller) {
      let buffer = ''
      let dataLines: string[] = []
      let eventName = ''
      let ended = false

      const dispatch = () => {
        if (ended || dataLines.length === 0) {
          eventName = ''
          return
        }
        const data = dataLines.join('\n')
        dataLines = []
        if (data.trim() === '[DONE]') {
          finalizeStream(state)
          ended = true
          return
        }
        let chunk: OpenAIChatStreamChunk
        try {
          chunk = JSON.parse(data)
        } catch {
          throw new Error('OpenAI Chat upstream sent malformed SSE JSON')
        }
        const policyError = getOpenAIPolicyError(chunk)
        const upstreamError = getChatResponseError(chunk)
        if (policyError || upstreamError || eventName === 'error') {
          enqueue(state, 'error', {
            type: 'error',
            error: policyError
              ? { type: 'permission_error', ...policyError }
              : { type: 'api_error', message: upstreamError || 'OpenAI Chat upstream reported an error' },
          })
          ended = true
          return
        }
        eventName = ''
        processChunk(chunk, state)
      }
      const consumeLine = (line: string) => {
        if (line === '') {
          dispatch()
          flushQueue(state, controller, encoder)
          return
        }
        if (line.startsWith(':')) return
        const colon = line.indexOf(':')
        const field = colon < 0 ? line : line.slice(0, colon)
        let value = colon < 0 ? '' : line.slice(colon + 1)
        if (value.startsWith(' ')) value = value.slice(1)
        if (field === 'data') dataLines.push(value)
        if (field === 'event') eventName = value
      }
      const consumeBuffer = (eof = false) => {
        while (!ended) {
          const newline = buffer.search(/[\r\n]/)
          if (newline < 0) break
          // A trailing CR may be the first half of CRLF in the next byte chunk.
          if (!eof && buffer[newline] === '\r' && newline === buffer.length - 1) break
          const width = buffer[newline] === '\r' && buffer[newline + 1] === '\n' ? 2 : 1
          const line = buffer.slice(0, newline)
          buffer = buffer.slice(newline + width)
          consumeLine(line)
        }
        if (eof && !ended) {
          if (buffer) consumeLine(buffer)
          buffer = ''
          dispatch()
        }
      }

      try {
        while (!ended && !cancelled) {
          const { done, value } = await reader.read()
          if (cancelled) return
          buffer += done ? decoder.decode() : decoder.decode(value, { stream: true })
          consumeBuffer(done)
          flushQueue(state, controller, encoder)
          if (done) break
        }
        if (!cancelled) {
          if (!ended) finalizeStream(state)
          flushQueue(state, controller, encoder)
          controller.close()
        }
      } catch (err) {
        if (!cancelled) {
          // A transport or conversion failure must never be followed by success.
          state.queue.length = 0
          enqueue(state, 'error', {
            type: 'error',
            error: { type: 'stream_error', message: err instanceof Error ? err.message : String(err) },
          })
          flushQueue(state, controller, encoder)
          controller.close()
        }
      } finally {
        await reader.cancel().catch(() => {})
        reader.releaseLock()
      }
    },
    async cancel(reason) {
      cancelled = true
      await reader.cancel(reason)
    },
  })
}

// ─── Queue management ──────────────────────────────────────

function enqueue(state: StreamState, event: string, data: unknown): void {
  state.queue.push({ event, data })
}

function flushQueue(
  state: StreamState,
  controller: ReadableStreamDefaultController,
  encoder: TextEncoder,
): void {
  for (const item of state.queue) {
    controller.enqueue(encoder.encode(formatSse(item.event, item.data)))
  }
  state.queue.length = 0
}

// ─── Message lifecycle events ──────────────────────────────

function ensureMessageStart(state: StreamState, chunkId?: string): void {
  if (state.messageStartSent) return
  state.messageStartSent = true
  enqueue(state, 'message_start', {
    type: 'message_start',
    message: {
      id: chunkId || `msg_${Date.now()}`,
      type: 'message',
      role: 'assistant',
      content: [],
      model: state.model,
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  })
}

// ─── Content block lifecycle ───────────────────────────────

function openBlock(state: StreamState, blockType: ContentBlockType, block: Record<string, unknown>): number {
  const index = state.nextContentIndex++
  state.currentBlockType = blockType
  state.currentBlockIndex = index
  state.blockStartSent = true
  state.blockStopSent = false
  enqueue(state, 'content_block_start', {
    type: 'content_block_start',
    index,
    content_block: block,
  })
  return index
}

function emitDelta(state: StreamState, index: number, delta: Record<string, unknown>): void {
  enqueue(state, 'content_block_delta', {
    type: 'content_block_delta',
    index,
    delta,
  })
}

function closeCurrentBlock(state: StreamState): void {
  if (!state.blockStartSent || state.blockStopSent) return
  state.blockStopSent = true
  enqueue(state, 'content_block_stop', {
    type: 'content_block_stop',
    index: state.currentBlockIndex,
  })
}

function closeAllToolBlocks(state: StreamState): void {
  for (const [, block] of state.toolBlocks) {
    if (block.started) {
      enqueue(state, 'content_block_stop', {
        type: 'content_block_stop',
        index: block.anthropicIndex,
      })
    }
  }
  state.toolBlocks.clear()
  if (state.currentBlockType === 'tool_use') {
    state.blockStopSent = true
  }
}

function closeCurrentNonToolBlock(state: StreamState): void {
  if (state.currentBlockType !== 'tool_use') closeCurrentBlock(state)
}

function closeAllOpenBlocks(state: StreamState): void {
  // Close current text/thinking block. Tool blocks are tracked separately
  // because providers can stream multiple tool calls in parallel.
  if (state.currentBlockType !== 'tool_use') {
    closeCurrentBlock(state)
  }
  closeAllToolBlocks(state)
}

// ─── Block type detection (follows LiteLLM priority) ───────

type DeltaEx = Record<string, unknown> & {
  content?: string | null
  tool_calls?: Array<{
    index: number
    id?: string
    type?: string
    function?: { name?: string; arguments?: string }
  }>
}

/**
 * Extract reasoning/thinking content from delta regardless of provider format.
 *
 * Handles:
 *   delta.reasoning_content  — DeepSeek, OpenRouter, XAI, Perplexity
 *   delta.reasoning          — GLM-5, Cerebras, Groq
 *   delta.thinking_blocks    — OpenAI o-series
 */
function extractReasoning(delta: DeltaEx): { thinking: string; signature: string } | null {
  // Format 1: reasoning_content (most common)
  if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
    return { thinking: delta.reasoning_content, signature: '' }
  }

  // Format 2: reasoning (GLM-5, Cerebras, Groq)
  if (typeof delta.reasoning === 'string' && delta.reasoning) {
    return { thinking: delta.reasoning, signature: '' }
  }

  // Format 3: thinking_blocks (OpenAI o-series)
  const thinkingBlocks = delta.thinking_blocks as Array<Record<string, unknown>> | undefined
  if (Array.isArray(thinkingBlocks) && thinkingBlocks.length > 0) {
    const block = thinkingBlocks[0]
    if (block.type === 'thinking') {
      const thinking = (block.thinking as string) || ''
      const signature = (block.signature as string) || ''
      if (thinking || signature) {
        return { thinking, signature }
      }
    }
  }

  return null
}

// ─── Main chunk processing ─────────────────────────────────

function processChunk(chunk: OpenAIChatStreamChunk, state: StreamState): void {
  const choice = chunk.choices?.[0]

  // Handle chunks with empty/missing choices (some providers send these)
  if (!choice) {
    // Check if this is a usage-only chunk (no choices but has usage)
    if (chunk.usage && state.heldMessageDelta) {
      mergeUsageIntoHeldDelta(state, chunk.usage)
    }
    return
  }

  // Update model from first chunk
  state.model = chunk.model || state.model
  ensureMessageStart(state, chunk.id)

  const delta = (choice.delta || {}) as DeltaEx
  if (state.finishReason) {
    if (chunk.usage) mergeUsageIntoHeldDelta(state, chunk.usage)
    if (extractReasoning(delta) || delta.content || delta.tool_calls?.length) {
      throw new Error('OpenAI Chat upstream sent content after finish_reason')
    }
    return
  }

  // One delta may carry reasoning, text and calls together. Preserve each part.
  if (extractReasoning(delta)) {
    if (state.currentBlockType !== 'thinking') closeCurrentNonToolBlock(state)
    handleThinking(delta, state)
  }
  if (delta.content != null && delta.content !== '') {
    if (state.currentBlockType !== 'text') closeCurrentNonToolBlock(state)
    handleText(delta, state)
  }
  if (delta.tool_calls?.length) {
    closeCurrentNonToolBlock(state)
    handleToolCalls(delta, state)
  }

  // Handle finish_reason
  if (choice.finish_reason) {
    handleFinishReason(choice.finish_reason, chunk, state)
  }
}

// ─── Content handlers ──────────────────────────────────────

function handleThinking(delta: DeltaEx, state: StreamState): void {
  const reasoning = extractReasoning(delta)
  if (!reasoning) return

  if (state.currentBlockType !== 'thinking' || !state.blockStartSent || state.blockStopSent) {
    openBlock(state, 'thinking', { type: 'thinking', thinking: '' })
  }

  if (reasoning.thinking) {
    emitDelta(state, state.currentBlockIndex, {
      type: 'thinking_delta', thinking: reasoning.thinking,
    })
  }
  if (reasoning.signature) {
    emitDelta(state, state.currentBlockIndex, {
      type: 'signature_delta', signature: reasoning.signature,
    })
  }
}

function handleText(delta: DeltaEx, state: StreamState): void {
  if (delta.content == null || delta.content === '') return

  if (state.currentBlockType !== 'text' || !state.blockStartSent || state.blockStopSent) {
    openBlock(state, 'text', { type: 'text', text: '' })
  }

  emitDelta(state, state.currentBlockIndex, {
    type: 'text_delta', text: delta.content,
  })
}

function handleToolCalls(delta: DeltaEx, state: StreamState): void {
  if (!delta.tool_calls) return

  for (const tc of delta.tool_calls) {
    const tcIndex = tc.index
    if (!Number.isInteger(tcIndex) || tcIndex < 0) {
      throw new Error('OpenAI Chat tool delta is missing a valid index')
    }

    if (!state.toolBlocks.has(tcIndex)) {
      state.toolBlocks.set(tcIndex, {
        id: '', name: '', argsBuffer: '', started: false, anthropicIndex: -1,
      })
    }

    const block = state.toolBlocks.get(tcIndex)!
    if (tc.id) {
      if (block.id && block.id !== tc.id) throw new Error('OpenAI Chat tool id changed within one index')
      if ([...state.toolBlocks.values()].some(other => other !== block && other.id === tc.id)) {
        throw new Error('OpenAI Chat tool id was reused for another index')
      }
      block.id = tc.id
    }
    if (tc.function?.name) {
      if (block.started && block.name !== tc.function.name) throw new Error('OpenAI Chat tool name changed after its block started')
      if (!block.started && block.name !== tc.function.name) block.name += tc.function.name
    }
    const argumentsDelta = stringifyOpenAIToolArguments(tc.function?.arguments)
    if (argumentsDelta) block.argsBuffer += argumentsDelta

    // Start tool block once we have id + name
    if (!block.started && block.id && block.name) {
      block.started = true
      block.anthropicIndex = state.nextContentIndex++
      state.currentBlockType = 'tool_use'
      state.currentBlockIndex = block.anthropicIndex
      state.blockStartSent = true
      state.blockStopSent = false

      enqueue(state, 'content_block_start', {
        type: 'content_block_start',
        index: block.anthropicIndex,
        content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} },
      })

      // Flush buffered arguments
      if (block.argsBuffer) {
        emitDelta(state, block.anthropicIndex, {
          type: 'input_json_delta', partial_json: block.argsBuffer,
        })
      }
    } else if (block.started && argumentsDelta) {
      state.currentBlockType = 'tool_use'
      state.currentBlockIndex = block.anthropicIndex
      state.blockStopSent = false
      emitDelta(state, block.anthropicIndex, {
        type: 'input_json_delta', partial_json: argumentsDelta,
      })
    }
  }
}

// ─── Finish & usage handling ───────────────────────────────

function handleFinishReason(
  finishReason: string,
  chunk: OpenAIChatStreamChunk,
  state: StreamState,
): void {
  if (state.finishReason) return
  const stopReason = mapFinishReason(finishReason)
  if (finishReason === 'content_filter' && state.toolBlocks.size > 0) {
    throw new Error('OpenAI Chat upstream filtered a tool-call turn before it could be committed')
  }
  if (finishReason !== 'length' && finishReason !== 'content_filter') {
    for (const block of state.toolBlocks.values()) {
      if (!block.id.trim() || !block.name.trim()) throw new Error('OpenAI Chat tool call is missing its id or function name')
      parseCompleteChatToolArguments(block.argsBuffer)
    }
    if (stopReason === 'tool_use' && state.toolBlocks.size === 0) {
      throw new Error('OpenAI Chat upstream finished with tool_calls but supplied no tool calls')
    }
  }
  state.finishReason = finishReason

  // CRITICAL: close ALL content blocks BEFORE message_delta
  closeAllOpenBlocks(state)

  const usage = chunk.usage
    ? openaiUsageToAnthropic(chunk.usage)
    : { output_tokens: 0 }

  const messageDelta: SseEvent = {
    event: 'message_delta',
    data: {
      type: 'message_delta',
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage,
    },
  }

  // Keep the terminal event until DONE/EOF so usage tails can update it and
  // a late upstream failure cannot follow an already advertised success.
  state.heldMessageDelta = messageDelta
}

function mergeUsageIntoHeldDelta(
  state: StreamState,
  usage: NonNullable<OpenAIChatStreamChunk['usage']>,
): void {
  if (!state.heldMessageDelta) return

  const data = state.heldMessageDelta.data as Record<string, unknown>
  data.usage = openaiUsageToAnthropic(usage)
}

function finalizeStream(state: StreamState): void {
  if (state.messageStopSent) return
  state.messageStopSent = true
  if (!state.finishReason) {
    enqueue(state, 'error', {
      type: 'error',
      error: { type: 'stream_truncated', message: 'OpenAI Chat upstream stream ended without finish_reason' },
    })
    return
  }

  ensureMessageStart(state)

  // Close any remaining open blocks
  closeAllOpenBlocks(state)

  // Flush held message_delta if still waiting for usage
  if (state.heldMessageDelta && !state.messageDeltaSent) {
    state.messageDeltaSent = true
    state.queue.push(state.heldMessageDelta)
    state.heldMessageDelta = null
  }

  enqueue(state, 'message_stop', { type: 'message_stop' })
}

// ─── Utilities ─────────────────────────────────────────────

function mapFinishReason(reason: string): string {
  switch (reason) {
    case 'stop': return 'end_turn'
    case 'tool_calls': return 'tool_use'
    case 'length': return 'max_tokens'
    case 'content_filter': return 'end_turn'
    default: throw new Error(`OpenAI Chat upstream returned unknown finish_reason: ${reason}`)
  }
}
