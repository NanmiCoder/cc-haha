/**
 * Response transformation: Gemini `generateContent` → Anthropic Messages.
 *
 * One converter serves both the SSE stream (`:streamGenerateContent?alt=sse`)
 * and the non-stream document (`:generateContent`), which Gemini shapes exactly
 * like one streamed chunk. Gemini may split one response across requests: a
 * request then finishes with `CONTINUATION` and a token, the caller resends the
 * original body with that token, and the next request's chunks keep feeding the
 * same converter so the client sees a single message.
 */

import { encodeGeminiThoughtSignature } from '../transform/anthropicToGemini.js'
import type { AnthropicContentBlock, AnthropicResponse } from '../transform/types.js'

type AnthropicEvent = { event: string; data: Record<string, unknown> }

type GeminiUsage = {
  promptTokenCount?: unknown
  cachedContentTokenCount?: unknown
  candidatesTokenCount?: unknown
  thoughtsTokenCount?: unknown
}

const CONTINUATION = 'CONTINUATION'
// Finishes that leave the model's output unusable rather than complete.
const ERROR_FINISH_REASONS = new Set([
  'MALFORMED_FUNCTION_CALL',
  'UNEXPECTED_TOOL_CALL',
  'TOO_MANY_TOOL_CALLS',
  'MISSING_THOUGHT_SIGNATURE',
  'MALFORMED_RESPONSE',
])

export class GeminiUpstreamError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message)
    this.name = 'GeminiUpstreamError'
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined
}

function tokens(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

/** The message Gemini puts in `{ error: { code, message, status } }`. */
export function geminiErrorMessage(body: unknown): string | undefined {
  const error = record(record(body)?.error)
  if (!error) return undefined
  if (typeof error.message === 'string' && error.message) return error.message
  return typeof error.status === 'string' && error.status ? error.status : 'Gemini upstream reported an error'
}

export class GeminiToAnthropicConverter {
  private readonly events: AnthropicEvent[] = []
  private started = false
  private openBlock: { type: 'text' | 'thinking'; index: number; signature?: string } | undefined
  private nextIndex = 0
  private emittedContent = false
  private hasToolCalls = false
  private readonly seenCallIds = new Set<string>()
  private finishReason: string | undefined
  private continuationToken: string | undefined
  private blockReason: string | undefined
  private usage: GeminiUsage | undefined
  private readonly earlierUsage: GeminiUsage[] = []

  // The requested id is reported rather than Gemini's `modelVersion`: the CLI
  // drops replayed thinking blocks — and with them the signatures — whenever
  // the recorded model differs from the one it asks for next.
  constructor(private readonly model: string) {}

  push(chunk: unknown): void {
    const body = record(chunk)
    if (!body) throw new GeminiUpstreamError('Gemini upstream sent a malformed response')
    const errorMessage = geminiErrorMessage(body)
    if (errorMessage) {
      const code = record(body.error)?.code
      throw new GeminiUpstreamError(errorMessage, typeof code === 'number' ? code : undefined)
    }
    this.ensureMessageStart(body.responseId)

    const usage = record(body.usageMetadata)
    if (usage) this.usage = usage
    const blockReason = record(body.promptFeedback)?.blockReason
    if (typeof blockReason === 'string' && blockReason) this.blockReason = blockReason

    const candidate = record(Array.isArray(body.candidates) ? body.candidates[0] : undefined)
    if (!candidate) return
    const parts = record(candidate.content)?.parts
    for (const part of Array.isArray(parts) ? parts : []) this.pushPart(part)
    if (typeof candidate.finishReason === 'string' && candidate.finishReason) {
      this.finishReason = candidate.finishReason
      // Only the finishing chunk's token resumes the response.
      this.continuationToken = typeof candidate.continuationToken === 'string' && candidate.continuationToken
        ? candidate.continuationToken
        : undefined
    }
  }

  /** The token to resend the request with, when the request just read was continued. */
  pendingContinuation(): string | undefined {
    return this.finishReason === CONTINUATION ? this.continuationToken : undefined
  }

  /** Usage is cumulative within one request, so the next request counts from zero. */
  startContinuation(): void {
    this.earlierUsage.push(this.usage ?? {})
    this.usage = undefined
    this.finishReason = undefined
    this.continuationToken = undefined
  }

  /** Close the message, or throw when the upstream did not finish it usably. */
  finish(): void {
    this.closeBlock()
    const reason = this.finishReason
    if (reason === undefined) {
      throw new GeminiUpstreamError(this.blockReason
        ? `Gemini blocked the request (${this.blockReason})`
        : 'Gemini upstream stream ended without a finish reason')
    }
    if (reason === CONTINUATION) {
      throw new GeminiUpstreamError('Gemini continued the response without a continuation token')
    }
    let stopReason: string
    if (reason === 'STOP') {
      stopReason = this.hasToolCalls ? 'tool_use' : 'end_turn'
    } else if (reason === 'MAX_TOKENS') {
      stopReason = 'max_tokens'
    } else if (ERROR_FINISH_REASONS.has(reason) || !this.emittedContent || this.hasToolCalls) {
      // A safety or recitation stop keeps partial text, like OpenAI Chat's
      // content_filter, but never becomes a silent empty reply or a
      // half-committed tool turn.
      throw new GeminiUpstreamError(`Gemini stopped with ${reason}`)
    } else {
      stopReason = 'end_turn'
    }
    this.ensureMessageStart(undefined)
    this.emit('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: this.anthropicUsage(),
    })
    this.emit('message_stop', { type: 'message_stop' })
  }

  /** Take the events produced so far. */
  drain(): AnthropicEvent[] {
    return this.events.splice(0)
  }

  private pushPart(value: unknown): void {
    const part = record(value)
    if (!part) return
    const signature = typeof part.thoughtSignature === 'string' && part.thoughtSignature
      ? part.thoughtSignature : undefined
    const call = record(part.functionCall)
    if (call) {
      this.pushFunctionCall(call, signature)
      return
    }
    // Inline data, code execution and other part kinds are outside this contract.
    if (typeof part.text !== 'string') return
    if (part.thought === true) {
      if (part.text) {
        this.ensureBlock('thinking')
        this.emitDelta({ type: 'thinking_delta', thinking: part.text })
      }
      if (signature && this.openBlock?.type === 'thinking') this.openBlock.signature = signature
      return
    }
    // A signature on visible text is optional to replay (Gemini validates only
    // function calls) and an Anthropic text block has no field to carry it.
    if (!part.text) return
    this.ensureBlock('text')
    this.emitDelta({ type: 'text_delta', text: part.text })
  }

  private pushFunctionCall(call: Record<string, unknown>, signature: string | undefined): void {
    if (typeof call.name !== 'string' || !call.name) {
      throw new GeminiUpstreamError('Gemini function call is missing its name')
    }
    this.closeBlock()
    // A repeated id would replay as two identical calls, so only its first use keeps it.
    const supplied = typeof call.id === 'string' && call.id ? call.id : undefined
    const id = supplied && !this.seenCallIds.has(supplied)
      ? supplied
      : `toolu_${crypto.randomUUID().replaceAll('-', '')}`
    if (supplied) this.seenCallIds.add(supplied)

    if (signature) {
      // Kept ahead of its call: the request side attaches it to the next call.
      const index = this.nextIndex++
      this.emit('content_block_start', {
        type: 'content_block_start',
        index,
        content_block: { type: 'redacted_thinking', data: encodeGeminiThoughtSignature(signature) },
      })
      this.emit('content_block_stop', { type: 'content_block_stop', index })
    }
    const index = this.nextIndex++
    this.emit('content_block_start', {
      type: 'content_block_start',
      index,
      content_block: { type: 'tool_use', id, name: call.name, input: {} },
    })
    this.emit('content_block_delta', {
      type: 'content_block_delta',
      index,
      delta: { type: 'input_json_delta', partial_json: JSON.stringify(record(call.args) ?? {}) },
    })
    this.emit('content_block_stop', { type: 'content_block_stop', index })
    this.hasToolCalls = true
    this.emittedContent = true
  }

  private ensureMessageStart(responseId: unknown): void {
    if (this.started) return
    this.started = true
    this.emit('message_start', {
      type: 'message_start',
      message: {
        id: typeof responseId === 'string' && responseId ? `msg_${responseId}` : `msg_${Date.now()}`,
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

  private ensureBlock(type: 'text' | 'thinking'): void {
    if (this.openBlock?.type === type) return
    this.closeBlock()
    const index = this.nextIndex++
    this.openBlock = { type, index }
    this.emittedContent = true
    this.emit('content_block_start', {
      type: 'content_block_start',
      index,
      content_block: type === 'text' ? { type: 'text', text: '' } : { type: 'thinking', thinking: '' },
    })
  }

  private closeBlock(): void {
    const block = this.openBlock
    if (!block) return
    this.openBlock = undefined
    if (block.signature) {
      this.emit('content_block_delta', {
        type: 'content_block_delta',
        index: block.index,
        delta: { type: 'signature_delta', signature: encodeGeminiThoughtSignature(block.signature) },
      })
    }
    this.emit('content_block_stop', { type: 'content_block_stop', index: block.index })
  }

  private emitDelta(delta: Record<string, unknown>): void {
    this.emit('content_block_delta', { type: 'content_block_delta', index: this.openBlock!.index, delta })
  }

  private emit(event: string, data: Record<string, unknown>): void {
    this.events.push({ event, data })
  }

  /**
   * `promptTokenCount` includes the cached subset, and `candidatesTokenCount`
   * excludes thoughts. A continued response reports the first request's prompt
   * (later ones re-bill the output so far as input) with every request's output.
   */
  private anthropicUsage(): AnthropicResponse['usage'] {
    const requests = [...this.earlierUsage, this.usage ?? {}]
    const first = requests[0]!
    const cached = Math.min(tokens(first.cachedContentTokenCount), tokens(first.promptTokenCount))
    const usage: AnthropicResponse['usage'] = {
      input_tokens: tokens(first.promptTokenCount) - cached,
      output_tokens: requests.reduce(
        (sum, item) => sum + tokens(item.candidatesTokenCount) + tokens(item.thoughtsTokenCount),
        0,
      ),
    }
    if (cached > 0) usage.cache_read_input_tokens = cached
    return usage
  }
}

function formatSse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

/** Yield each SSE event's data, joined across its `data:` lines. */
async function* readSseData(reader: ReadableStreamDefaultReader<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder()
  let buffer = ''
  let data: string[] = []
  while (true) {
    const { done, value } = await reader.read()
    buffer += done ? decoder.decode() : decoder.decode(value, { stream: true })
    while (true) {
      const newline = buffer.search(/[\r\n]/)
      if (newline < 0) break
      // A trailing CR may be the first half of CRLF in the next byte chunk.
      if (!done && buffer[newline] === '\r' && newline === buffer.length - 1) break
      const width = buffer[newline] === '\r' && buffer[newline + 1] === '\n' ? 2 : 1
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + width)
      if (line === '') {
        if (data.length > 0) yield data.join('\n')
        data = []
      } else if (line.startsWith('data:')) {
        data.push(line.slice(line[5] === ' ' ? 6 : 5))
      }
    }
    if (done) {
      if (buffer.startsWith('data:')) data.push(buffer.slice(buffer[5] === ' ' ? 6 : 5))
      if (data.length > 0) yield data.join('\n')
      return
    }
  }
}

/**
 * Transform a Gemini SSE stream into an Anthropic Messages SSE stream.
 * `continueResponse` resends the original request with a continuation token.
 */
export function geminiStreamToAnthropic(
  upstream: ReadableStream<Uint8Array>,
  model: string,
  continueResponse: (continuationToken: string) => Promise<ReadableStream<Uint8Array>>,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  const converter = new GeminiToAnthropicConverter(model)
  let reader = upstream.getReader()
  let cancelled = false
  const flush = (controller: ReadableStreamDefaultController<Uint8Array>) => {
    for (const { event, data } of converter.drain()) controller.enqueue(encoder.encode(formatSse(event, data)))
  }

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        while (true) {
          for await (const data of readSseData(reader)) {
            if (cancelled) return
            let chunk: unknown
            try {
              chunk = JSON.parse(data)
            } catch {
              throw new Error('Gemini upstream sent malformed SSE JSON')
            }
            converter.push(chunk)
            flush(controller)
          }
          if (cancelled) return
          const token = converter.pendingContinuation()
          if (!token) break
          converter.startContinuation()
          const next = await continueResponse(token)
          if (cancelled) {
            await next.cancel().catch(() => {})
            return
          }
          reader.releaseLock()
          reader = next.getReader()
        }
        converter.finish()
        flush(controller)
        controller.close()
      } catch (err) {
        if (cancelled) return
        // A transport or conversion failure must never be followed by success.
        converter.drain()
        controller.enqueue(encoder.encode(formatSse('error', {
          type: 'error',
          error: {
            type: err instanceof GeminiUpstreamError ? 'api_error' : 'stream_error',
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
 * Convert a non-stream `generateContent` response, following continuations
 * through `continueResponse`, into one Anthropic message.
 */
export async function geminiResponseToAnthropic(
  first: unknown,
  model: string,
  continueResponse: (continuationToken: string) => Promise<unknown>,
): Promise<AnthropicResponse> {
  const converter = new GeminiToAnthropicConverter(model)
  converter.push(first)
  for (let token = converter.pendingContinuation(); token; token = converter.pendingContinuation()) {
    converter.startContinuation()
    converter.push(await continueResponse(token))
  }
  converter.finish()

  const response: AnthropicResponse = {
    id: `msg_${Date.now()}`, type: 'message', role: 'assistant', model,
    content: [], stop_reason: null, stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0 },
  }
  const blocks = new Map<number, Record<string, unknown>>()
  for (const { data } of converter.drain()) {
    if (data.type === 'message_start') {
      response.id = String(record(data.message)?.id ?? response.id)
    } else if (data.type === 'content_block_start') {
      blocks.set(data.index as number, { ...record(data.content_block) })
    } else if (data.type === 'content_block_delta') {
      const block = blocks.get(data.index as number)!
      const delta = record(data.delta)!
      if (delta.type === 'text_delta') block.text = String(block.text ?? '') + delta.text
      else if (delta.type === 'thinking_delta') block.thinking = String(block.thinking ?? '') + delta.thinking
      else if (delta.type === 'signature_delta') block.signature = delta.signature
      else if (delta.type === 'input_json_delta') block.input = JSON.parse(String(delta.partial_json))
    } else if (data.type === 'message_delta') {
      response.stop_reason = String(record(data.delta)?.stop_reason)
      response.usage = data.usage as AnthropicResponse['usage']
    }
  }
  response.content = [...blocks.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, block]) => block as AnthropicContentBlock)
  if (response.content.length === 0) response.content.push({ type: 'text', text: '' })
  return response
}
