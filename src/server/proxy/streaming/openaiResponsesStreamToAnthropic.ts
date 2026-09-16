/**
 * Streaming SSE transformation: OpenAI Responses API → Anthropic Messages
 * Derived from cc-switch (https://github.com/farion1231/cc-switch)
 * Original work by Jason Young, MIT License
 */

import { isDeepStrictEqual } from 'node:util'
import { parseResponsesToolArguments, responsesTerminalStop } from '../transform/openaiResponsesTerminal.js'
import { encodeOpenAIReasoningEnvelope } from '../transform/openaiReasoning.js'
import { stringifyOpenAIToolArguments } from '../transform/toolArguments.js'
import { openaiUsageToAnthropic } from '../transform/usage.js'
import type {
  OpenAICompatibleUsage,
  OpenAIResponsesReasoningItem,
} from '../transform/types.js'

export type OpenAIResponsesStreamOptions = {
  /**
   * Preserves encrypted reasoning for ChatGPT Codex OAuth. All providers share
   * the same terminal/error and tool completeness contract.
   */
  openAICodexOAuth?: boolean
  /** Internal lifecycle hooks used by the OAuth fetch adapter. */
  onTerminal?: (event: string) => void
  onCancel?: (reason: unknown) => void
  onSettled?: () => void
}

type StreamState = {
  nextContentIndex: number
  indexByKey: Map<string, number>
  reasoningIndexByOutputIndex: Map<number, number>
  toolIndexByItemId: Map<string, number>
  toolIndexByOutputIndex: Map<number, number>
  tools: Map<number, { id: string; name: string; arguments: string }>
  textByIndex: Map<number, string>
  openIndices: Set<number>
  reasoningDone: Set<number>
  model: string
  messageId: string
  messageStarted: boolean
  messageStopped: boolean
  terminalSeen: boolean
  lastUpstreamEvent: string | null
}

function formatSse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

/**
 * Transform an OpenAI Responses API SSE stream into an Anthropic Messages SSE stream.
 */
export function openaiResponsesStreamToAnthropic(
  upstream: ReadableStream<Uint8Array>,
  model: string,
  options: OpenAIResponsesStreamOptions = {},
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  const decoder = new TextDecoder()
  const reader = upstream.getReader()
  let buffer = ''
  let currentEvent = ''
  let dataLines: string[] = []
  let cancelled = false

  const state: StreamState = {
    nextContentIndex: 0,
    indexByKey: new Map(),
    reasoningIndexByOutputIndex: new Map(),
    toolIndexByItemId: new Map(),
    toolIndexByOutputIndex: new Map(),
    tools: new Map(),
    textByIndex: new Map(),
    openIndices: new Set(),
    reasoningDone: new Set(),
    model,
    messageId: `msg_${Date.now()}`,
    messageStarted: false,
    messageStopped: false,
    terminalSeen: false,
    lastUpstreamEvent: null,
  }

  const resetEvent = (): void => {
    currentEvent = ''
    dataLines = []
  }

  return new ReadableStream({
    start(controller) {
      const dispatchEvent = (): boolean => {
        if (dataLines.length === 0) {
          resetEvent()
          return false
        }

        const dataText = dataLines.join('\n')
        const eventName = currentEvent
        resetEvent()

        if (dataText === '[DONE]') {
          state.lastUpstreamEvent = '[DONE]'
          return true
        }

        let data: Record<string, unknown>
        try {
          const parsed = asRecord(JSON.parse(dataText))
          if (!parsed) throw new Error('Expected an event object')
          data = parsed
        } catch {
          throw new Error('Invalid OpenAI Responses SSE JSON')
        }

        const resolvedEvent = eventName || (typeof data.type === 'string' ? data.type : '')
        if (!resolvedEvent) return false
        state.lastUpstreamEvent = resolvedEvent
        const terminal = processEvent(
          resolvedEvent,
          data,
          state,
          controller,
          encoder,
          options,
        )
        if (terminal) options.onTerminal?.(resolvedEvent)
        return terminal
      }

      const processLine = (rawLine: string): boolean => {
        const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
        if (line === '') return dispatchEvent()
        if (line.startsWith(':')) return false

        const colon = line.indexOf(':')
        const field = colon === -1 ? line : line.slice(0, colon)
        let value = colon === -1 ? '' : line.slice(colon + 1)
        if (value.startsWith(' ')) value = value.slice(1)

        if (field === 'event') currentEvent = value
        if (field === 'data') dataLines.push(value)
        return false
      }

      const pump = async (): Promise<void> => {
        try {
          let terminal = false
          while (!terminal && !cancelled) {
            const { done, value } = await reader.read()
            if (done) break

            buffer += decoder.decode(value, { stream: true })
            let newline = buffer.indexOf('\n')
            while (newline !== -1) {
              terminal = processLine(buffer.slice(0, newline))
              buffer = buffer.slice(newline + 1)
              if (terminal) break
              newline = buffer.indexOf('\n')
            }
          }

          if (cancelled) return

          if (!state.terminalSeen) {
            buffer += decoder.decode()
            if (buffer) processLine(buffer)
            dispatchEvent()
          }

          if (!state.terminalSeen) {
            const error = new Error(
              `OpenAI Responses stream closed before response.completed (last event: ${state.lastUpstreamEvent ?? 'none'})`,
            ) as Error & { code: string }
            error.code = 'ERR_STREAM_PREMATURE_CLOSE'
            controller.error(error)
            return
          }

          controller.close()
        } catch (error) {
          if (!cancelled) controller.error(error)
        } finally {
          if (!cancelled) {
            await reader.cancel('OpenAI Responses terminal event received').catch(() => {})
          }
          options.onSettled?.()
        }
      }

      void pump()
    },
    async cancel(reason) {
      cancelled = true
      if (!state.terminalSeen) options.onCancel?.(reason)
      await reader.cancel(reason).catch(() => {})
    },
  })
}

function emitMessageStart(
  state: StreamState,
  controller: ReadableStreamDefaultController,
  encoder: TextEncoder,
  model: string,
): void {
  if (state.messageStarted) return
  state.messageStarted = true
  controller.enqueue(encoder.encode(formatSse('message_start', {
    type: 'message_start',
    message: {
      id: state.messageId,
      type: 'message',
      role: 'assistant',
      content: [],
      model,
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  })))
}

function emitMessageStop(
  state: StreamState,
  controller: ReadableStreamDefaultController,
  encoder: TextEncoder,
  model: string,
): void {
  if (state.messageStopped) return
  if (!state.messageStarted) emitMessageStart(state, controller, encoder, model)
  state.messageStopped = true
  controller.enqueue(encoder.encode(formatSse('message_stop', { type: 'message_stop' })))
}

function processEvent(
  event: string,
  data: Record<string, unknown>,
  state: StreamState,
  controller: ReadableStreamDefaultController,
  encoder: TextEncoder,
  options: OpenAIResponsesStreamOptions,
): boolean {
  switch (event) {
    case 'response.created': {
      const response = asRecord(data.response) ?? data
      state.model = (response.model as string) || state.model
      if (typeof response.id === 'string') state.messageId = response.id
      emitMessageStart(state, controller, encoder, state.model)
      break
    }

    case 'response.output_item.added': {
      if (!state.messageStarted) emitMessageStart(state, controller, encoder, state.model)
      const item = asRecord(data.item)
      if (!item) break

      if (item.type === 'function_call') {
        const index = ensureToolBlock(data, item, state, controller, encoder)
        if (item.arguments !== undefined && item.arguments !== '') {
          reconcileToolArguments(index, item.arguments, state, controller, encoder)
        }
      } else if (item.type === 'reasoning' && !options.openAICodexOAuth) {
        ensureReasoningBlock(data, state, controller, encoder)
      }
      break
    }

    case 'response.output_item.done': {
      const item = asRecord(data.item)
      if (!item) break
      if (item.type === 'function_call') {
        const index = ensureToolBlock(data, item, state, controller, encoder)
        if (item.arguments !== undefined && item.arguments !== '') {
          reconcileToolArguments(index, item.arguments, state, controller, encoder)
        }
        break
      }
      if (item.type === 'message') {
        const parts = Array.isArray(item.content) ? item.content : []
        for (const [contentIndex, value] of parts.entries()) {
          const part = asRecord(value)
          if (!part || !['output_text', 'text', 'refusal'].includes(String(part.type))) continue
          const partData = { ...data, content_index: contentIndex }
          const index = ensureTextBlock(partData, state, controller, encoder)
          const text = part.type === 'refusal' ? part.refusal : part.text
          if (typeof text === 'string') reconcileText(index, text, state, controller, encoder)
          closeBlock(index, state, controller, encoder)
        }
        break
      }
      if (item.type !== 'reasoning') break
      const outputIndex = (data.output_index as number) ?? 0
      if (state.reasoningDone.has(outputIndex)) break
      if (!options.openAICodexOAuth) {
        if (!state.reasoningIndexByOutputIndex.has(outputIndex)) {
          const summary = Array.isArray(item.summary) ? item.summary : []
          const text = summary.map(part => asRecord(part)?.text).filter(value => typeof value === 'string').join('')
          if (text) {
            const index = ensureReasoningBlock(data, state, controller, encoder)
            controller.enqueue(encoder.encode(formatSse('content_block_delta', {
              type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: text },
            })))
          }
        }
        closeReasoningBlock(data, state, controller, encoder)
        state.reasoningDone.add(outputIndex)
        break
      }
      const reasoning = item as OpenAIResponsesReasoningItem
      const reasoningData = encodeOpenAIReasoningEnvelope(reasoning)
      const summary = reasoning.summary?.map(part => part.text).join('') ?? ''
      if (!reasoningData && !summary) break
      if (!state.messageStarted) emitMessageStart(state, controller, encoder, state.model)
      const index = state.nextContentIndex++
      controller.enqueue(encoder.encode(formatSse('content_block_start', {
        type: 'content_block_start', index,
        content_block: reasoningData ? { type: 'redacted_thinking', data: reasoningData } : { type: 'thinking', thinking: summary },
      })))
      controller.enqueue(encoder.encode(formatSse('content_block_stop', { type: 'content_block_stop', index })))
      state.reasoningDone.add(outputIndex)
      break
    }

    case 'response.content_part.added': {
      const part = asRecord(data.part)
      if (!part || !['output_text', 'text', 'refusal'].includes(String(part.type))) break
      const index = ensureTextBlock(data, state, controller, encoder)
      const initial = part.type === 'refusal' ? part.refusal : part.text
      if (typeof initial === 'string') reconcileText(index, initial, state, controller, encoder)
      break
    }

    case 'response.reasoning_summary_part.added': {
      if (!options.openAICodexOAuth) {
        ensureReasoningBlock(data, state, controller, encoder)
      }
      break
    }

    case 'response.reasoning_summary_text.delta':
    case 'response.reasoning_text.delta': {
      if (options.openAICodexOAuth) break
      const index = ensureReasoningBlock(data, state, controller, encoder)
      const delta = typeof data.delta === 'string' ? data.delta : ''
      if (!delta) break

      controller.enqueue(encoder.encode(formatSse('content_block_delta', {
        type: 'content_block_delta',
        index,
        delta: { type: 'thinking_delta', thinking: delta },
      })))
      break
    }

    case 'response.output_text.delta':
    case 'response.refusal.delta': {
      const index = ensureTextBlock(data, state, controller, encoder)
      if (!state.openIndices.has(index)) throw new Error('OpenAI Responses text delta arrived after block completion')
      const delta = typeof data.delta === 'string' ? data.delta : ''
      reconcileText(index, (state.textByIndex.get(index) ?? '') + delta, state, controller, encoder)
      break
    }

    case 'response.function_call_arguments.delta': {
      const itemId = (data.item_id as string) || ''
      const index = state.toolIndexByItemId.get(itemId)
      if (index === undefined) throw new Error('OpenAI Responses tool arguments have no matching tool')

      const delta = stringifyOpenAIToolArguments(data.delta)
      const tool = state.tools.get(index)!
      tool.arguments += delta
      controller.enqueue(encoder.encode(formatSse('content_block_delta', {
        type: 'content_block_delta',
        index,
        delta: { type: 'input_json_delta', partial_json: delta },
      })))
      break
    }

    case 'response.output_text.done':
    case 'response.refusal.done': {
      const index = ensureTextBlock(data, state, controller, encoder)
      const text = event === 'response.refusal.done' ? data.refusal : data.text
      if (typeof text === 'string') reconcileText(index, text, state, controller, encoder)
      closeBlock(index, state, controller, encoder)
      break
    }

    case 'response.function_call_arguments.done': {
      const itemId = (data.item_id as string) || ''
      const index = state.toolIndexByItemId.get(itemId)
        ?? state.toolIndexByOutputIndex.get(data.output_index as number)
      if (index === undefined) throw new Error('OpenAI Responses tool arguments have no matching tool')
      const argumentsValue = data.arguments ?? asRecord(data.item)?.arguments
      if (argumentsValue !== undefined) reconcileToolArguments(index, argumentsValue, state, controller, encoder)
      // Keep tools open until the terminal event validates the entire response.
      // A final response snapshot can still supply missing argument suffixes.
      break
    }

    case 'response.incomplete':
    case 'response.failed':
    case 'response.cancelled':
    case 'error':
    case 'response.completed': {
      state.terminalSeen = true
      const response = asRecord(data.response) ?? data
      if (typeof response.model === 'string') state.model = response.model
      if (typeof response.id === 'string') state.messageId = response.id
      let terminal: 'completed' | 'max_tokens'
      try {
        terminal = responsesTerminalStop(response, event)
      } catch (error) {
        const failure = error as Error & { type?: string; code?: string }
        controller.enqueue(encoder.encode(formatSse('error', {
          type: 'error', error: {
            type: failure.type ?? 'api_error', message: failure.message,
            ...(failure.code ? { code: failure.code } : {}),
          },
        })))
        return true
      }
      const output = response.output
      if (terminal === 'completed' && output === undefined && state.nextContentIndex === 0) {
        throw new Error('Invalid OpenAI Responses completed response: missing output')
      }
      if (output !== undefined && !Array.isArray(output)) throw new Error('Invalid OpenAI Responses output: expected an array')
      if (Array.isArray(output)) {
        for (const [outputIndex, item] of output.entries()) {
          // Partial tool snapshots are not executable and need not be repaired.
          if (terminal === 'max_tokens' && asRecord(item)?.type === 'function_call') continue
          processEvent('response.output_item.done', { output_index: outputIndex, item }, state, controller, encoder, options)
        }
      }
      if (terminal === 'completed') {
        for (const tool of state.tools.values()) {
          if (!tool.id || !tool.name) throw new Error('Invalid OpenAI Responses tool identity')
          parseResponsesToolArguments(tool.arguments)
        }
      }
      if (!state.messageStarted) emitMessageStart(state, controller, encoder, state.model)
      closeAllReasoningBlocks(state, controller, encoder)
      for (const index of [...state.openIndices].sort((a, b) => a - b)) closeBlock(index, state, controller, encoder)
      const stopReason = terminal === 'max_tokens' ? 'max_tokens' : state.tools.size > 0 ? 'tool_use' : 'end_turn'
      controller.enqueue(encoder.encode(formatSse('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: stopReason, stop_sequence: null },
        usage: openaiUsageToAnthropic(response.usage as OpenAICompatibleUsage | undefined),
      })))
      emitMessageStop(state, controller, encoder, state.model)
      return true
    }
  }

  return false
}

function ensureReasoningBlock(
  data: Record<string, unknown>,
  state: StreamState,
  controller: ReadableStreamDefaultController,
  encoder: TextEncoder,
): number {
  if (!state.messageStarted) {
    emitMessageStart(state, controller, encoder, state.model)
  }

  const outputIndex = (data.output_index as number) ?? 0
  const existing = state.reasoningIndexByOutputIndex.get(outputIndex)
  if (existing !== undefined) return existing

  const index = state.nextContentIndex++
  state.reasoningIndexByOutputIndex.set(outputIndex, index)
  controller.enqueue(encoder.encode(formatSse('content_block_start', {
    type: 'content_block_start',
    index,
    content_block: { type: 'thinking', thinking: '' },
  })))
  return index
}

function closeReasoningBlock(
  data: Record<string, unknown>,
  state: StreamState,
  controller: ReadableStreamDefaultController,
  encoder: TextEncoder,
): void {
  const outputIndex = typeof data.output_index === 'number' ? data.output_index : 0
  const index = state.reasoningIndexByOutputIndex.get(outputIndex)
  if (index === undefined) return

  const item = asRecord(data.item)
  const signature = typeof item?.encrypted_content === 'string'
    ? item.encrypted_content
    : ''
  if (signature) {
    controller.enqueue(encoder.encode(formatSse('content_block_delta', {
      type: 'content_block_delta',
      index,
      delta: { type: 'signature_delta', signature },
    })))
  }
  controller.enqueue(encoder.encode(formatSse('content_block_stop', {
    type: 'content_block_stop',
    index,
  })))
  state.reasoningIndexByOutputIndex.delete(outputIndex)
}

function closeAllReasoningBlocks(
  state: StreamState,
  controller: ReadableStreamDefaultController,
  encoder: TextEncoder,
): void {
  for (const [outputIndex, index] of state.reasoningIndexByOutputIndex) {
    controller.enqueue(encoder.encode(formatSse('content_block_stop', {
      type: 'content_block_stop',
      index,
    })))
    state.reasoningIndexByOutputIndex.delete(outputIndex)
  }
}

function closeBlock(index: number, state: StreamState, controller: ReadableStreamDefaultController, encoder: TextEncoder): void {
  if (!state.openIndices.delete(index)) return
  controller.enqueue(encoder.encode(formatSse('content_block_stop', { type: 'content_block_stop', index })))
}

function ensureTextBlock(data: Record<string, unknown>, state: StreamState, controller: ReadableStreamDefaultController, encoder: TextEncoder): number {
  const key = `${data.output_index ?? 0}:${data.content_index ?? 0}`
  const existing = state.indexByKey.get(key)
  if (existing !== undefined) return existing
  if (!state.messageStarted) emitMessageStart(state, controller, encoder, state.model)
  const index = state.nextContentIndex++
  state.indexByKey.set(key, index)
  state.textByIndex.set(index, '')
  state.openIndices.add(index)
  controller.enqueue(encoder.encode(formatSse('content_block_start', {
    type: 'content_block_start', index, content_block: { type: 'text', text: '' },
  })))
  return index
}

function reconcileText(index: number, text: string, state: StreamState, controller: ReadableStreamDefaultController, encoder: TextEncoder): void {
  const previous = state.textByIndex.get(index) ?? ''
  if (text === previous) return
  if (!text.startsWith(previous) || !state.openIndices.has(index)) throw new Error('OpenAI Responses text snapshot conflicts with streamed content')
  state.textByIndex.set(index, text)
  controller.enqueue(encoder.encode(formatSse('content_block_delta', {
    type: 'content_block_delta', index, delta: { type: 'text_delta', text: text.slice(previous.length) },
  })))
}

function ensureToolBlock(data: Record<string, unknown>, item: Record<string, unknown>, state: StreamState, controller: ReadableStreamDefaultController, encoder: TextEncoder): number {
  const id = typeof item.id === 'string' ? item.id : ''
  const callId = typeof item.call_id === 'string' ? item.call_id : id
  const name = typeof item.name === 'string' ? item.name : ''
  const outputIndex = typeof data.output_index === 'number' ? data.output_index : undefined
  const existing = state.toolIndexByItemId.get(id || callId)
    ?? (outputIndex === undefined ? undefined : state.toolIndexByOutputIndex.get(outputIndex))
  if (existing !== undefined) {
    const tool = state.tools.get(existing)!
    if ((callId && callId !== tool.id) || (name && name !== tool.name)) throw new Error('OpenAI Responses tool snapshot conflicts with tool identity')
    if (id) state.toolIndexByItemId.set(id, existing)
    return existing
  }
  if (!callId || !name) throw new Error('Invalid OpenAI Responses tool identity')
  if (!state.messageStarted) emitMessageStart(state, controller, encoder, state.model)
  const index = state.nextContentIndex++
  state.toolIndexByItemId.set(id || callId, index)
  if (outputIndex !== undefined) state.toolIndexByOutputIndex.set(outputIndex, index)
  state.tools.set(index, { id: callId, name, arguments: '' })
  state.openIndices.add(index)
  controller.enqueue(encoder.encode(formatSse('content_block_start', {
    type: 'content_block_start', index, content_block: { type: 'tool_use', id: callId, name, input: {} },
  })))
  return index
}

function reconcileToolArguments(index: number, value: unknown, state: StreamState, controller: ReadableStreamDefaultController, encoder: TextEncoder): void {
  const text = stringifyOpenAIToolArguments(value)
  const tool = state.tools.get(index)!
  if (text === tool.arguments) return
  if (!text.startsWith(tool.arguments)) {
    // Compatible providers can serialize the same final object differently.
    // Keep the emitted representation when the parsed inputs are identical.
    try {
      if (isDeepStrictEqual(parseResponsesToolArguments(text), parseResponsesToolArguments(tool.arguments))) return
    } catch {
      // Partial JSON cannot establish semantic equality.
    }
    throw new Error('OpenAI Responses tool arguments snapshot conflicts with streamed arguments')
  }
  const suffix = text.slice(tool.arguments.length)
  tool.arguments = text
  if (suffix) controller.enqueue(encoder.encode(formatSse('content_block_delta', {
    type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: suffix },
  })))
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}
