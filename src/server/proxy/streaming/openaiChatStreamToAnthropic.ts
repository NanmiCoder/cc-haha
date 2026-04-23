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

import type { OpenAIChatStreamChunk } from '../transform/types.js'

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
  let buffer = ''
  const state = createState(model)

  return new ReadableStream({
    async start(controller) {
      const reader = upstream.getReader()
      let errored = false

      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break

          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split('\n')
          buffer = lines.pop() || ''

          for (const line of lines) {
            const trimmed = line.trim()
            if (!trimmed || trimmed.startsWith(':')) continue

            if (trimmed === 'data: [DONE]') {
              finalizeStream(state)
              flushQueue(state, controller, encoder)
              continue
            }

            if (!trimmed.startsWith('data: ')) continue
            const jsonStr = trimmed.slice(6)

            let chunk: OpenAIChatStreamChunk
            try {
              chunk = JSON.parse(jsonStr)
            } catch {
              continue
            }

            processChunk(chunk, state)
            flushQueue(state, controller, encoder)
          }
        }
      } catch (err) {
        errored = true
        controller.error(err)
      } finally {
        if (!errored) {
          finalizeStream(state)
          flushQueue(state, controller, encoder)
          controller.close()
        }
      }
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
}

function closeAllOpenBlocks(state: StreamState): void {
  // Close current text/thinking block
  closeCurrentBlock(state)
  // Close all tool blocks
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

/**
 * Determine what block type this chunk carries and whether it's a new block.
 * Priority (matches LiteLLM): tool_calls > text > reasoning > ignore
 */
function detectBlockTransition(
  delta: DeltaEx,
  state: StreamState,
): { type: ContentBlockType; isNew: boolean } | null {
  // Priority 1: Tool calls
  if (delta.tool_calls && delta.tool_calls.length > 0) {
    const tc = delta.tool_calls[0]
    // A tool call with function.name signals a NEW tool block
    const isNew = state.currentBlockType !== 'tool_use' || !!(tc.function?.name)
    return { type: 'tool_use', isNew }
  }

  // Priority 2: Text content
  if (delta.content != null && delta.content !== '') {
    const isNew = state.currentBlockType !== 'text' || !state.blockStartSent
    return { type: 'text', isNew }
  }

  // Priority 3: Reasoning/thinking
  const reasoning = extractReasoning(delta)
  if (reasoning) {
    const isNew = state.currentBlockType !== 'thinking' || !state.blockStartSent
    return { type: 'thinking', isNew }
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

  const delta = choice.delta as DeltaEx

  // Detect what this chunk carries
  const transition = detectBlockTransition(delta, state)

  if (transition) {
    // Handle block transition: close previous block if type changed
    if (transition.isNew && state.blockStartSent && !state.blockStopSent) {
      if (transition.type !== 'tool_use') {
        // For text/thinking, close the current block
        closeCurrentBlock(state)
      } else if (state.currentBlockType !== 'tool_use') {
        // Switching TO tool_use from text/thinking: close current
        closeCurrentBlock(state)
      }
    }

    switch (transition.type) {
      case 'thinking':
        handleThinking(delta, state)
        break
      case 'text':
        handleText(delta, state)
        break
      case 'tool_use':
        handleToolCalls(delta, state)
        break
    }
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

  if (state.currentBlockType !== 'thinking' || !state.blockStartSent) {
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

  if (state.currentBlockType !== 'text' || !state.blockStartSent) {
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

    if (!state.toolBlocks.has(tcIndex)) {
      state.toolBlocks.set(tcIndex, {
        id: '', name: '', argsBuffer: '', started: false, anthropicIndex: -1,
      })
    }

    const block = state.toolBlocks.get(tcIndex)!
    if (tc.id) block.id = tc.id
    if (tc.function?.name) block.name += tc.function.name
    if (tc.function?.arguments) block.argsBuffer += tc.function.arguments

    // Start tool block once we have id + name
    if (!block.started && block.id && block.name) {
      block.started = true
      block.anthropicIndex = state.nextContentIndex++
      state.currentBlockType = 'tool_use'
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
    } else if (block.started && tc.function?.arguments) {
      emitDelta(state, block.anthropicIndex, {
        type: 'input_json_delta', partial_json: tc.function.arguments,
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
  if (state.messageDeltaSent) return

  // CRITICAL: close ALL content blocks BEFORE message_delta
  closeAllOpenBlocks(state)

  const stopReason = mapFinishReason(finishReason)
  const usage = chunk.usage
    ? { output_tokens: chunk.usage.completion_tokens || 0 }
    : { output_tokens: 0 }

  const messageDelta: SseEvent = {
    event: 'message_delta',
    data: {
      type: 'message_delta',
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage,
    },
  }

  // If usage is available in the same chunk, emit immediately
  if (chunk.usage) {
    state.messageDeltaSent = true
    state.queue.push(messageDelta)
  } else {
    // Hold message_delta, wait for usage chunk
    state.heldMessageDelta = messageDelta
  }
}

function mergeUsageIntoHeldDelta(
  state: StreamState,
  usage: NonNullable<OpenAIChatStreamChunk['usage']>,
): void {
  if (!state.heldMessageDelta) return

  const data = state.heldMessageDelta.data as Record<string, unknown>
  data.usage = { output_tokens: usage.completion_tokens || 0 }
  state.messageDeltaSent = true
  state.queue.push(state.heldMessageDelta)
  state.heldMessageDelta = null
}

function finalizeStream(state: StreamState): void {
  if (state.messageStopSent) return
  state.messageStopSent = true

  ensureMessageStart(state)

  // Close any remaining open blocks
  closeAllOpenBlocks(state)

  // Flush held message_delta if still waiting for usage
  if (state.heldMessageDelta && !state.messageDeltaSent) {
    state.messageDeltaSent = true
    state.queue.push(state.heldMessageDelta)
    state.heldMessageDelta = null
  }

  // Emit message_delta if never sent (e.g., stream ended without finish_reason)
  if (!state.messageDeltaSent) {
    state.messageDeltaSent = true
    enqueue(state, 'message_delta', {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 0 },
    })
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
    default: return 'end_turn'
  }
}
