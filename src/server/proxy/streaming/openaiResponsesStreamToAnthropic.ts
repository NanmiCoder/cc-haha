/**
 * Streaming SSE transformation: OpenAI Responses API → Anthropic Messages
 * Derived from cc-switch (https://github.com/farion1231/cc-switch)
 * Original work by Jason Young, MIT License
 */

import { getOpenAIPolicyError } from '../../../services/openaiAuth/policyError.js'
import { encodeOpenAIReasoningEnvelope } from '../transform/openaiReasoning.js'
import { stringifyOpenAIToolArguments } from '../transform/toolArguments.js'
import { openaiUsageToAnthropic } from '../transform/usage.js'
import type {
  OpenAICompatibleUsage,
  OpenAIResponsesReasoningItem,
} from '../transform/types.js'

export type OpenAIResponsesStreamOptions = {
  /**
   * Enables the stricter ChatGPT Codex OAuth contract without changing generic
   * Responses-compatible providers: encrypted reasoning is preserved, HTTP 200
   * stream errors are surfaced, and EOF without response.completed is rejected.
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
  model: string
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
    model,
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
          if (options.openAICodexOAuth) {
            state.lastUpstreamEvent = '[DONE]'
            return true
          }
          if (!options.openAICodexOAuth && !state.messageStopped) {
            state.terminalSeen = true
            closeAllReasoningBlocks(state, controller, encoder)
            emitMessageStop(state, controller, encoder, model)
            return true
          }
          return false
        }

        let data: Record<string, unknown>
        try {
          data = JSON.parse(dataText) as Record<string, unknown>
        } catch {
          return false
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

          if (options.openAICodexOAuth && !state.terminalSeen) {
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
          if (state.terminalSeen && !cancelled) {
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
      id: `msg_${Date.now()}`,
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
      emitMessageStart(state, controller, encoder, state.model)
      break
    }

    case 'response.output_item.added': {
      if (!state.messageStarted) emitMessageStart(state, controller, encoder, state.model)
      const item = asRecord(data.item)
      if (!item) break

      if (item.type === 'function_call') {
        const index = state.nextContentIndex++
        const callId = (item.call_id as string) || (item.id as string) || ''
        const name = (item.name as string) || ''
        state.toolIndexByItemId.set((item.id as string) || callId, index)

        controller.enqueue(encoder.encode(formatSse('content_block_start', {
          type: 'content_block_start',
          index,
          content_block: {
            type: 'tool_use',
            id: callId,
            name,
            input: {},
          },
        })))
      } else if (item.type === 'reasoning' && !options.openAICodexOAuth) {
        ensureReasoningBlock(data, state, controller, encoder)
      }
      break
    }

    case 'response.output_item.done': {
      const item = asRecord(data.item)
      if (!item || item.type !== 'reasoning') break

      if (!options.openAICodexOAuth) {
        closeReasoningBlock(data, state, controller, encoder)
        break
      }

      const reasoning = item as OpenAIResponsesReasoningItem
      const reasoningData = encodeOpenAIReasoningEnvelope(reasoning)
      if (!reasoningData) break

      if (!state.messageStarted) emitMessageStart(state, controller, encoder, state.model)
      const index = state.nextContentIndex++
      controller.enqueue(encoder.encode(formatSse('content_block_start', {
        type: 'content_block_start',
        index,
        content_block: { type: 'redacted_thinking', data: reasoningData },
      })))
      controller.enqueue(encoder.encode(formatSse('content_block_stop', {
        type: 'content_block_stop',
        index,
      })))
      break
    }

    case 'response.content_part.added': {
      if (!state.messageStarted) emitMessageStart(state, controller, encoder, state.model)
      const part = asRecord(data.part)
      if (!part) break

      const contentIndex = (data.content_index as number) ?? 0
      const outputIndex = (data.output_index as number) ?? 0
      const key = `${outputIndex}:${contentIndex}`
      const index = state.nextContentIndex++
      state.indexByKey.set(key, index)

      controller.enqueue(encoder.encode(formatSse('content_block_start', {
        type: 'content_block_start',
        index,
        content_block: { type: 'text', text: '' },
      })))
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

    case 'response.output_text.delta': {
      const contentIndex = (data.content_index as number) ?? 0
      const outputIndex = (data.output_index as number) ?? 0
      const key = `${outputIndex}:${contentIndex}`
      const index = state.indexByKey.get(key)
      if (index === undefined) break

      const delta = (data.delta as string) || ''
      controller.enqueue(encoder.encode(formatSse('content_block_delta', {
        type: 'content_block_delta',
        index,
        delta: { type: 'text_delta', text: delta },
      })))
      break
    }

    case 'response.refusal.delta': {
      const contentIndex = (data.content_index as number) ?? 0
      const outputIndex = (data.output_index as number) ?? 0
      const key = `${outputIndex}:${contentIndex}`
      const index = state.indexByKey.get(key)
      if (index === undefined) break

      const delta = (data.delta as string) || ''
      controller.enqueue(encoder.encode(formatSse('content_block_delta', {
        type: 'content_block_delta',
        index,
        delta: { type: 'text_delta', text: delta },
      })))
      break
    }

    case 'response.function_call_arguments.delta': {
      const itemId = (data.item_id as string) || ''
      const index = state.toolIndexByItemId.get(itemId)
      if (index === undefined) break

      const delta = stringifyOpenAIToolArguments(data.delta)
      controller.enqueue(encoder.encode(formatSse('content_block_delta', {
        type: 'content_block_delta',
        index,
        delta: { type: 'input_json_delta', partial_json: delta },
      })))
      break
    }

    case 'response.output_text.done':
    case 'response.refusal.done': {
      const contentIndex = (data.content_index as number) ?? 0
      const outputIndex = (data.output_index as number) ?? 0
      const key = `${outputIndex}:${contentIndex}`
      const index = state.indexByKey.get(key)
      if (index === undefined) break

      controller.enqueue(encoder.encode(formatSse('content_block_stop', {
        type: 'content_block_stop',
        index,
      })))
      break
    }

    case 'response.function_call_arguments.done': {
      const itemId = (data.item_id as string) || ''
      const index = state.toolIndexByItemId.get(itemId)
      if (index === undefined) break

      controller.enqueue(encoder.encode(formatSse('content_block_stop', {
        type: 'content_block_stop',
        index,
      })))
      break
    }

    case 'response.incomplete':
      if (!options.openAICodexOAuth && !getOpenAIPolicyError(data)) break
      state.terminalSeen = true
      if (readIncompleteReason(asRecord(data.response)) === 'max_output_tokens') {
        const response = asRecord(data.response)
        if (!state.messageStarted) emitMessageStart(state, controller, encoder, state.model)
        controller.enqueue(encoder.encode(formatSse('message_delta', {
          type: 'message_delta',
          delta: { stop_reason: 'max_tokens', stop_sequence: null },
          usage: openaiUsageToAnthropic(response?.usage as OpenAICompatibleUsage | undefined),
        })))
        emitMessageStop(state, controller, encoder, state.model)
        return true
      }
      controller.enqueue(encoder.encode(formatSse('error', {
        type: 'error',
        error: readStreamError(event, data),
      })))
      return true

    case 'response.failed':
    case 'response.cancelled':
    case 'error': {
      if (!options.openAICodexOAuth && !getOpenAIPolicyError(data)) break
      state.terminalSeen = true
      const streamError = readStreamError(event, data)
      controller.enqueue(encoder.encode(formatSse('error', {
        type: 'error',
        error: streamError,
      })))
      return true
    }

    case 'response.completed': {
      state.terminalSeen = true
      const response = asRecord(data.response)
      const status = (response?.status as string) || 'completed'
      const usage = response?.usage as OpenAICompatibleUsage | undefined
      const hasToolUse = state.toolIndexByItemId.size > 0

      const stopReason = status === 'completed'
        ? (hasToolUse ? 'tool_use' : 'end_turn')
        : status === 'incomplete' ? 'max_tokens' : 'end_turn'

      if (!state.messageStarted) emitMessageStart(state, controller, encoder, state.model)
      closeAllReasoningBlocks(state, controller, encoder)
      controller.enqueue(encoder.encode(formatSse('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: stopReason, stop_sequence: null },
        usage: openaiUsageToAnthropic(usage),
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

function readStreamError(
  event: string,
  data: Record<string, unknown>,
): { type: 'api_error' | 'overloaded_error' | 'permission_error'; message: string; code?: string } {
  const policyError = getOpenAIPolicyError(data)
  if (policyError) return { type: 'permission_error', ...policyError }
  const response = asRecord(data.response)
  const error = asRecord(response?.error) ?? asRecord(data.error) ?? data
  const code = typeof error?.code === 'string' ? error.code : ''
  const errorType = typeof error?.type === 'string' ? error.type : ''
  const message = typeof error?.message === 'string' && error.message
    ? error.message
    : event === 'response.incomplete'
      ? `OpenAI response was incomplete: ${readIncompleteReason(response)}`
      : `OpenAI stream ended with ${event}`
  const overloaded = [code, errorType].some((value) => (
    value.includes('rate_limit') ||
    value.includes('capacity') ||
    value.includes('overload')
  ))

  return { type: overloaded ? 'overloaded_error' : 'api_error', message }
}

function readIncompleteReason(response: Record<string, unknown> | null): string {
  const details = asRecord(response?.incomplete_details)
  return typeof details?.reason === 'string' ? details.reason : 'unknown'
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}
