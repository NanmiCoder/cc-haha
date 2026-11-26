/**
 * Response transformation: AWS Bedrock Runtime Converse / ConverseStream → Anthropic Messages.
 *
 * Decodes official AWS binary EventStream frames (`application/vnd.amazon.eventstream`)
 * via `@smithy/eventstream-codec` (matching `@ai-sdk/amazon-bedrock`'s
 * `amazon-bedrock-event-stream-decoder.ts`) and translates both streaming and
 * non-streaming Bedrock Converse responses into Anthropic Messages SSE / JSON.
 */

import { EventStreamCodec } from '@smithy/eventstream-codec'
import { fromUtf8, toUtf8 } from '@smithy/util-utf8'
import type { AnthropicContentBlock, AnthropicResponse } from '../transform/types.js'
import { isBedrockMistralModel, normalizeBedrockToolCallId } from '../transform/anthropicToBedrockConverse.js'

type AnthropicEvent = { event: string; data: Record<string, unknown> }

type BedrockUsage = {
  inputTokens?: unknown
  outputTokens?: unknown
  cacheReadInputTokens?: unknown
  cacheWriteInputTokens?: unknown
}

export class BedrockUpstreamError extends Error {
  constructor(message: string, readonly errorType?: string) {
    super(message)
    this.name = 'BedrockUpstreamError'
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function tokens(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

function mapStopReason(stopReason: string | undefined, hasToolCalls: boolean): string {
  switch (stopReason) {
    case 'tool_use':
    case 'tool-calls':
      return 'tool_use'
    case 'max_tokens':
    case 'length':
      return 'max_tokens'
    case 'model_context_window_exceeded':
      return stopReason
    case 'malformed_tool_use':
    case 'malformed_model_output':
      throw new BedrockUpstreamError(`Amazon Bedrock stopped with ${stopReason}`, stopReason)
    case 'stop_sequence':
      return 'stop_sequence'
    case 'guardrail_intervened':
    case 'content_filtered':
    case 'content-filter':
      return 'refusal'
    case 'end_turn':
    case 'stop':
      return hasToolCalls ? 'tool_use' : 'end_turn'
    default:
      return hasToolCalls ? 'tool_use' : 'end_turn'
  }
}

function formatSse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

function toAnthropicUsage(usage: BedrockUsage | undefined): AnthropicResponse['usage'] {
  const inputTokens = tokens(usage?.inputTokens)
  const outputTokens = tokens(usage?.outputTokens)
  const cacheRead = tokens(usage?.cacheReadInputTokens)
  const cacheWrite = tokens(usage?.cacheWriteInputTokens)
  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    ...(cacheRead > 0 ? { cache_read_input_tokens: cacheRead } : {}),
    ...(cacheWrite > 0 ? { cache_creation_input_tokens: cacheWrite } : {}),
  }
}

/**
 * Encode one AWS EventStream binary frame. Used by tests and official-spec
 * local Bedrock mock servers.
 */
export function encodeBedrockEventStreamFrame(
  eventType: string,
  payload: unknown,
  messageType: 'event' | 'exception' = 'event',
): Uint8Array {
  const codec = new EventStreamCodec(toUtf8, fromUtf8)
  const typeHeaderKey = messageType === 'exception' ? ':exception-type' : ':event-type'
  return codec.encode({
    headers: {
      ':message-type': { type: 'string', value: messageType },
      [typeHeaderKey]: { type: 'string', value: eventType },
      ':content-type': { type: 'string', value: 'application/json' },
    },
    body: fromUtf8(JSON.stringify(payload)),
  })
}

type ActiveBlock =
  | { kind: 'text'; anthropicIndex: number }
  | { kind: 'thinking'; anthropicIndex: number }
  | { kind: 'redacted_thinking'; data: string }
  | { kind: 'tool_use'; anthropicIndex: number; toolUseId: string; name: string; receivedInput: boolean }

export class BedrockConverseToAnthropicConverter {
  private readonly events: AnthropicEvent[] = []
  private readonly isMistral: boolean
  private started = false
  private nextAnthropicIndex = 0
  private readonly activeBlocks = new Map<number, ActiveBlock>()
  private hasToolCalls = false
  private stopReason: string | undefined
  private stopSequence: string | null = null
  private usage: BedrockUsage | undefined

  constructor(private readonly model: string, private readonly requestId?: string) {
    this.isMistral = isBedrockMistralModel(model)
  }

  pushEvent(eventType: string, payload: unknown, messageType: string = 'event'): void {
    const body = record(payload) ?? {}

    if (messageType === 'exception' || /Exception$/i.test(eventType)) {
      const message = typeof body.message === 'string' && body.message
        ? body.message
        : `Amazon Bedrock stream failed with ${eventType}`
      throw new BedrockUpstreamError(message, eventType)
    }

    switch (eventType) {
      case 'messageStart':
        this.ensureMessageStart()
        return

      case 'contentBlockStart': {
        this.ensureMessageStart()
        const blockIndex = typeof body.contentBlockIndex === 'number' ? body.contentBlockIndex : 0
        const start = record(body.start)
        const toolUse = record(start?.toolUse)
        if (toolUse) {
          const rawId = typeof toolUse.toolUseId === 'string' && toolUse.toolUseId
            ? toolUse.toolUseId
            : `toolu_${crypto.randomUUID().replaceAll('-', '')}`
          const id = normalizeBedrockToolCallId(rawId, this.isMistral)
          const name = typeof toolUse.name === 'string' && toolUse.name ? toolUse.name : 'tool'
          const anthropicIndex = this.nextAnthropicIndex++
          this.activeBlocks.set(blockIndex, {
            kind: 'tool_use',
            anthropicIndex,
            toolUseId: id,
            name,
            receivedInput: false,
          })
          this.hasToolCalls = true
          this.emit('content_block_start', {
            type: 'content_block_start',
            index: anthropicIndex,
            content_block: { type: 'tool_use', id, name, input: {} },
          })
        }
        return
      }

      case 'contentBlockDelta': {
        this.ensureMessageStart()
        const blockIndex = typeof body.contentBlockIndex === 'number' ? body.contentBlockIndex : 0
        const delta = record(body.delta)
        if (!delta) return

        // Text delta
        if (typeof delta.text === 'string' && delta.text.length > 0) {
          let active = this.activeBlocks.get(blockIndex)
          if (!active) {
            const anthropicIndex = this.nextAnthropicIndex++
            active = { kind: 'text', anthropicIndex }
            this.activeBlocks.set(blockIndex, active)
            this.emit('content_block_start', {
              type: 'content_block_start',
              index: anthropicIndex,
              content_block: { type: 'text', text: '' },
            })
          }
          if (active.kind === 'text') {
            this.emit('content_block_delta', {
              type: 'content_block_delta',
              index: active.anthropicIndex,
              delta: { type: 'text_delta', text: delta.text },
            })
          }
          return
        }

        // Tool use input JSON delta
        const toolUseDelta = record(delta.toolUse)
        if (toolUseDelta && typeof toolUseDelta.input === 'string') {
          const active = this.activeBlocks.get(blockIndex)
          if (active?.kind === 'tool_use' && toolUseDelta.input.length > 0) {
            active.receivedInput = true
            this.emit('content_block_delta', {
              type: 'content_block_delta',
              index: active.anthropicIndex,
              delta: { type: 'input_json_delta', partial_json: toolUseDelta.input },
            })
          }
          return
        }

        // Reasoning / thinking delta (text and signature may arrive in the same frame)
        const reasoning = record(delta.reasoningContent)
        if (reasoning) {
          if (typeof reasoning.text === 'string' && reasoning.text.length > 0) {
            const active = this.ensureThinkingBlock(blockIndex)
            this.emit('content_block_delta', {
              type: 'content_block_delta',
              index: active.anthropicIndex,
              delta: { type: 'thinking_delta', thinking: reasoning.text },
            })
          }
          if (typeof reasoning.signature === 'string' && reasoning.signature.length > 0) {
            const active = this.ensureThinkingBlock(blockIndex)
            this.emit('content_block_delta', {
              type: 'content_block_delta',
              index: active.anthropicIndex,
              delta: { type: 'signature_delta', signature: reasoning.signature },
            })
          }
          if (typeof reasoning.redactedContent === 'string' && reasoning.redactedContent.length > 0) {
            const existing = this.activeBlocks.get(blockIndex)
            if (existing?.kind === 'redacted_thinking') {
              existing.data += reasoning.redactedContent
            } else {
              this.activeBlocks.set(blockIndex, {
                kind: 'redacted_thinking',
                data: reasoning.redactedContent,
              })
            }
          } else if (typeof reasoning.data === 'string' && reasoning.data.length > 0) {
            const existing = this.activeBlocks.get(blockIndex)
            if (existing?.kind === 'redacted_thinking') {
              existing.data += reasoning.data
            } else {
              this.activeBlocks.set(blockIndex, {
                kind: 'redacted_thinking',
                data: reasoning.data,
              })
            }
          }
        }
        return
      }

      case 'contentBlockStop': {
        const blockIndex = typeof body.contentBlockIndex === 'number' ? body.contentBlockIndex : 0
        this.closeBlockIndex(blockIndex)
        return
      }

      case 'messageStop': {
        if (typeof body.stopReason === 'string' && body.stopReason) {
          this.stopReason = body.stopReason
        }
        const additional = record(body.additionalModelResponseFields)
        const stopSeq = record(additional?.delta)?.stop_sequence
        if (typeof stopSeq === 'string') {
          this.stopSequence = stopSeq
        }
        return
      }

      case 'metadata': {
        const usage = record(body.usage)
        if (usage) this.usage = usage
        return
      }
    }
  }

  finish(): void {
    if (this.stopReason === undefined) {
      throw new BedrockUpstreamError('Amazon Bedrock stream ended without a messageStop event')
    }
    for (const blockIndex of [...this.activeBlocks.keys()]) {
      this.closeBlockIndex(blockIndex)
    }
    this.ensureMessageStart()
    const stopReason = mapStopReason(this.stopReason, this.hasToolCalls)
    this.emit('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: stopReason, stop_sequence: this.stopSequence },
      usage: toAnthropicUsage(this.usage),
    })
    this.emit('message_stop', { type: 'message_stop' })
  }

  drain(): AnthropicEvent[] {
    return this.events.splice(0)
  }

  private ensureMessageStart(): void {
    if (this.started) return
    this.started = true
    this.emit('message_start', {
      type: 'message_start',
      message: {
        id: this.requestId ? `msg_${this.requestId}` : `msg_${Date.now()}`,
        type: 'message',
        role: 'assistant',
        content: [],
        model: this.model,
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    })
  }

  private ensureThinkingBlock(blockIndex: number): Extract<ActiveBlock, { kind: 'thinking' }> {
    const existing = this.activeBlocks.get(blockIndex)
    if (existing?.kind === 'thinking') return existing
    const anthropicIndex = this.nextAnthropicIndex++
    const created: Extract<ActiveBlock, { kind: 'thinking' }> = { kind: 'thinking', anthropicIndex }
    this.activeBlocks.set(blockIndex, created)
    this.emit('content_block_start', {
      type: 'content_block_start',
      index: anthropicIndex,
      content_block: { type: 'thinking', thinking: '' },
    })
    return created
  }

  private closeBlockIndex(blockIndex: number): void {
    const active = this.activeBlocks.get(blockIndex)
    if (!active) return
    this.activeBlocks.delete(blockIndex)

    if (active.kind === 'redacted_thinking') {
      const anthropicIndex = this.nextAnthropicIndex++
      this.emit('content_block_start', {
        type: 'content_block_start',
        index: anthropicIndex,
        content_block: { type: 'redacted_thinking', data: active.data },
      })
      this.emit('content_block_stop', { type: 'content_block_stop', index: anthropicIndex })
      return
    }

    if (active.kind === 'tool_use' && !active.receivedInput) {
      this.emit('content_block_delta', {
        type: 'content_block_delta',
        index: active.anthropicIndex,
        delta: { type: 'input_json_delta', partial_json: '{}' },
      })
    }

    this.emit('content_block_stop', {
      type: 'content_block_stop',
      index: active.anthropicIndex,
    })
  }

  private emit(event: string, data: Record<string, unknown>): void {
    this.events.push({ event, data })
  }
}

/**
 * Transform an AWS Bedrock ConverseStream binary EventStream (`application/vnd.amazon.eventstream`)
 * into an Anthropic Messages SSE stream.
 */
export function bedrockConverseStreamToAnthropic(
  upstream: ReadableStream<Uint8Array>,
  model: string,
  options?: {
    requestId?: string
    onEvent?: (eventType: string, payload: unknown, messageType: string) => void
  },
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  const textDecoder = new TextDecoder()
  const codec = new EventStreamCodec(toUtf8, fromUtf8)
  const converter = new BedrockConverseToAnthropicConverter(model, options?.requestId)
  const reader = upstream.getReader()
  let cancelled = false
  let buffer = new Uint8Array(0)

  const flush = (controller: ReadableStreamDefaultController<Uint8Array>) => {
    for (const { event, data } of converter.drain()) {
      controller.enqueue(encoder.encode(formatSse(event, data)))
    }
  }

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (cancelled) return
          if (done) break

          if (value && value.byteLength > 0) {
            const combined = new Uint8Array(buffer.byteLength + value.byteLength)
            combined.set(buffer)
            combined.set(value, buffer.byteLength)
            buffer = combined
          }

          while (buffer.byteLength >= 4) {
            const totalLength = new DataView(
              buffer.buffer,
              buffer.byteOffset,
              buffer.byteLength,
            ).getUint32(0, false)

            if (totalLength < 16) {
              throw new BedrockUpstreamError(`Invalid AWS EventStream frame length: ${totalLength}`)
            }
            if (buffer.byteLength < totalLength) break

            const frame = buffer.subarray(0, totalLength)
            const decoded = codec.decode(frame)
            buffer = buffer.slice(totalLength)

            const messageType = String(decoded.headers[':message-type']?.value ?? 'event')
            const rawText = textDecoder.decode(decoded.body).trim()

            // AWS EventStream protocol-level `:message-type: "error"` frames carry
            // `:error-code` and `:error-message` headers (no `:event-type`).
            if (messageType === 'error') {
              const errorCode = String(decoded.headers[':error-code']?.value ?? 'InternalFailure')
              const headerMessage = typeof decoded.headers[':error-message']?.value === 'string'
                ? decoded.headers[':error-message'].value
                : ''
              let bodyMessage = ''
              if (rawText) {
                try {
                  const parsed = record(JSON.parse(rawText))
                  if (typeof parsed?.message === 'string') bodyMessage = parsed.message
                } catch {
                  bodyMessage = rawText
                }
              }
              const message = headerMessage || bodyMessage || `Amazon Bedrock stream failed with ${errorCode}`
              options?.onEvent?.(errorCode, { message }, 'error')
              throw new BedrockUpstreamError(message, errorCode)
            }

            const eventType = messageType === 'exception'
              ? String(decoded.headers[':exception-type']?.value ?? 'unknownException')
              : String(decoded.headers[':event-type']?.value ?? '')
            if (!eventType) continue

            let parsedPayload: unknown = {}
            if (rawText) {
              try {
                parsedPayload = JSON.parse(rawText)
              } catch {
                throw new BedrockUpstreamError(`Amazon Bedrock sent malformed EventStream JSON for ${eventType}`)
              }
            }
            if (record(parsedPayload)) {
              delete (parsedPayload as Record<string, unknown>).p
            }

            options?.onEvent?.(eventType, parsedPayload, messageType)
            converter.pushEvent(eventType, parsedPayload, messageType)
            flush(controller)
          }
        }

        if (buffer.byteLength > 0) {
          throw new BedrockUpstreamError(
            `Incomplete Amazon Bedrock EventStream frame: ${buffer.byteLength} trailing bytes.`,
          )
        }

        converter.finish()
        flush(controller)
        controller.close()
      } catch (err) {
        if (cancelled) return
        converter.drain()
        controller.enqueue(encoder.encode(formatSse('error', {
          type: 'error',
          error: {
            type: err instanceof BedrockUpstreamError ? 'api_error' : 'stream_error',
            message: err instanceof Error ? err.message : String(err),
          },
        })))
        controller.close()
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

/**
 * Convert a non-streaming AWS Bedrock `Converse` JSON response into an Anthropic Message.
 */
export function bedrockConverseResponseToAnthropic(
  body: unknown,
  model: string,
  requestId?: string,
): AnthropicResponse {
  const root = record(body)
  const output = record(root?.output)
  const message = record(output?.message)
  const rawParts = Array.isArray(message?.content) ? message.content : []
  const isMistral = isBedrockMistralModel(model)

  const content: AnthropicContentBlock[] = []
  let hasToolCalls = false

  for (const rawPart of rawParts) {
    const part = record(rawPart)
    if (!part) continue

    const reasoning = record(part.reasoningContent)
    if (reasoning) {
      const reasoningText = record(reasoning.reasoningText)
      if (reasoningText && typeof reasoningText.text === 'string') {
        content.push({
          type: 'thinking',
          thinking: reasoningText.text,
          ...(typeof reasoningText.signature === 'string' && reasoningText.signature
            ? { signature: reasoningText.signature }
            : {}),
        })
      } else if (typeof reasoning.redactedContent === 'string' && reasoning.redactedContent) {
        content.push({
          type: 'redacted_thinking',
          data: reasoning.redactedContent,
        })
      } else {
        const redactedReasoning = record(reasoning.redactedReasoning)
        if (redactedReasoning && typeof redactedReasoning.data === 'string' && redactedReasoning.data) {
          content.push({
            type: 'redacted_thinking',
            data: redactedReasoning.data,
          })
        }
      }
      continue
    }

    if (typeof part.text === 'string') {
      content.push({ type: 'text', text: part.text })
      continue
    }

    const citations = record(part.citationsContent)
    if (citations && Array.isArray(citations.content)) {
      const joined = citations.content
        .map((item) => record(item)?.text)
        .filter((text): text is string => typeof text === 'string')
        .join('')
      if (joined) content.push({ type: 'text', text: joined })
      continue
    }

    const toolUse = record(part.toolUse)
    if (toolUse && typeof toolUse.name === 'string' && toolUse.name) {
      hasToolCalls = true
      const rawId = typeof toolUse.toolUseId === 'string' && toolUse.toolUseId
        ? toolUse.toolUseId
        : `toolu_${crypto.randomUUID().replaceAll('-', '')}`
      content.push({
        type: 'tool_use',
        id: normalizeBedrockToolCallId(rawId, isMistral),
        name: toolUse.name,
        input: record(toolUse.input) ?? {},
      })
    }
  }

  if (content.length === 0) {
    content.push({ type: 'text', text: '' })
  }

  const stopReason = typeof root?.stopReason === 'string' ? root.stopReason : undefined
  const additional = record(root?.additionalModelResponseFields)
  const stopSeq = record(additional?.delta)?.stop_sequence

  return {
    id: requestId ? `msg_${requestId}` : `msg_${Date.now()}`,
    type: 'message',
    role: 'assistant',
    content,
    model,
    stop_reason: mapStopReason(stopReason, hasToolCalls),
    stop_sequence: typeof stopSeq === 'string' ? stopSeq : null,
    usage: toAnthropicUsage(record(root?.usage)),
  }
}
