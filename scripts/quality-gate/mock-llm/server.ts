/**
 * Loopback Anthropic Messages endpoint backed by `scriptedModel.ts`.
 *
 * Speaks enough of the wire protocol for the real CLI: streamed and non-streamed
 * `/v1/messages`, plus `count_tokens`. Every request is recorded so a scenario can
 * assert on what actually went upstream — for example that a tool's real output
 * came back to the model in the next request, which no UI frame can prove.
 */

import { decideReply, type MockContentBlock, type MockRequest, type MockReply } from './scriptedModel'
import { GEMINI_IMAGE_ASPECT_RATIOS } from '../../../src/tools/ImageGenTool/aspectRatios'

export type RecordedRequest = {
  path: string
  stream: boolean
  body: MockRequest & { stream?: boolean }
  receivedAt: number
  /**
   * How the reply ended. `cancelled` means the client hung up mid-stream — the only
   * upstream-side proof that a user's stop actually closed the connection.
   */
  outcome: 'pending' | 'completed' | 'cancelled' | 'error'
}

export type MockLlmServer = {
  url: string
  requests: RecordedRequest[]
  imageRequests: Array<{ path: string; body: Record<string, unknown>; headers: Headers }>
  stop(): Promise<void>
}

export const MOCK_IMAGE_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg=='
const MODEL_FALLBACK = 'mock-model'

function usage(outputTokens: number) {
  return {
    input_tokens: 12,
    output_tokens: outputTokens,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  }
}

function sse(event: string, data: unknown) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

/** Splits text into small pieces so the stream looks like a stream. */
function chunks(value: string) {
  const pieces = value.match(/[^\n]*\n|[^\n]+/g) ?? [value]
  return pieces.length > 0 ? pieces : ['']
}

function messageId() {
  return `msg_mock_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
}

function streamReply(
  record: RecordedRequest,
  model: string,
  content: MockContentBlock[],
  stopReason: string,
  chunkDelayMs: number,
): Response {
  const encoder = new TextEncoder()
  let cancelled = false
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const push = (event: string, data: unknown) => {
        if (!cancelled) controller.enqueue(encoder.encode(sse(event, data)))
      }
      push('message_start', {
        type: 'message_start',
        message: {
          id: messageId(),
          type: 'message',
          role: 'assistant',
          model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: usage(1),
        },
      })
      for (const [index, block] of content.entries()) {
        if (block.type === 'text') {
          push('content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } })
          for (const piece of chunks(block.text)) {
            if (cancelled) return
            push('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: piece } })
            if (chunkDelayMs > 0) await Bun.sleep(chunkDelayMs)
          }
        } else {
          push('content_block_start', {
            type: 'content_block_start',
            index,
            content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} },
          })
          push('content_block_delta', {
            type: 'content_block_delta',
            index,
            delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) },
          })
        }
        push('content_block_stop', { type: 'content_block_stop', index })
      }
      push('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: stopReason, stop_sequence: null },
        usage: { output_tokens: 8 },
      })
      push('message_stop', { type: 'message_stop' })
      if (cancelled) return
      record.outcome = 'completed'
      controller.close()
    },
    cancel() {
      cancelled = true
      record.outcome = 'cancelled'
    },
  })
  return new Response(body, {
    headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
  })
}

function handleMessages(record: RecordedRequest, replyFor: (request: MockRequest) => MockReply): Response {
  const request = record.body
  const reply = replyFor(request)
  if (reply.kind === 'error') {
    record.outcome = 'error'
    return Response.json(
      { type: 'error', error: { type: reply.errorType, message: reply.message } },
      { status: reply.status },
    )
  }

  const model = request.model || MODEL_FALLBACK
  if (request.stream) {
    return streamReply(record, model, reply.content, reply.stopReason, reply.chunkDelayMs ?? 0)
  }
  record.outcome = 'completed'
  return Response.json({
    id: messageId(),
    type: 'message',
    role: 'assistant',
    model,
    content: reply.content,
    stop_reason: reply.stopReason,
    stop_sequence: null,
    usage: usage(8),
  })
}

export function startMockLlmServer(replyFor = decideReply): MockLlmServer {
  const requests: RecordedRequest[] = []
  const imageRequests: MockLlmServer['imageRequests'] = []
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname
      if (req.method === 'GET' && path.endsWith('/v1/models')) {
        return Response.json({ data: [{ type: 'model', id: MODEL_FALLBACK, display_name: 'Mock model' }], has_more: false })
      }
      if (req.method !== 'POST') return new Response('not found', { status: 404 })

      const isGeminiLiteImage = path === '/v1beta/models/gemini-3.1-flash-lite-image:generateContent'
      const isGeminiImage = path === '/v1beta/models/mock-image:generateContent' || isGeminiLiteImage
      if (path === '/v1/images/generations' || path === '/v1/images/edits' || isGeminiImage) {
        const contentType = req.headers.get('content-type') ?? ''
        const body = contentType.startsWith('multipart/form-data')
          ? Object.fromEntries((await req.formData()).entries())
          : await req.json() as Record<string, unknown>
        imageRequests.push({ path, body, headers: req.headers })
        const credential = isGeminiImage ? req.headers.get('x-goog-api-key') : req.headers.get('authorization')
        if (credential !== (isGeminiImage ? 'mock-image-key' : 'Bearer mock-image-key')) {
          return Response.json({ error: 'image credentials were not wired' }, { status: 401 })
        }
        if (isGeminiImage) {
          const { generationConfig } = body as { generationConfig?: { imageConfig?: { aspectRatio?: unknown; imageSize?: unknown } } }
          const imageSize = generationConfig?.imageConfig?.imageSize
          if (isGeminiLiteImage && imageSize !== undefined && imageSize !== '1K') {
            return Response.json({ error: 'Gemini Lite images require 1K resolution' }, { status: 400 })
          }
          const ratio = generationConfig?.imageConfig?.aspectRatio
          if (ratio !== undefined && (ratio === 'auto' || !GEMINI_IMAGE_ASPECT_RATIOS.some(supported => supported === ratio))) {
            return Response.json({ error: 'unsupported Gemini image aspect ratio' }, { status: 400 })
          }
          return Response.json({ candidates: [{ content: { parts: [
            { text: 'Fixture image' },
            { inlineData: { mimeType: 'image/png', data: MOCK_IMAGE_PNG_BASE64 } },
          ] } }] })
        }
        return Response.json({ data: [{ url: `data:image/png;base64,${MOCK_IMAGE_PNG_BASE64}`, revised_prompt: 'Fixture image' }] })
      }

      const body = (await req.json().catch(() => ({}))) as MockRequest & { stream?: boolean }
      if (path.endsWith('/v1/messages/count_tokens')) {
        return Response.json({ input_tokens: 12 })
      }
      if (path.endsWith('/v1/messages')) {
        const record: RecordedRequest = { path, stream: body.stream === true, body, receivedAt: Date.now(), outcome: 'pending' }
        requests.push(record)
        return handleMessages(record, replyFor)
      }
      return new Response('not found', { status: 404 })
    },
  })

  return {
    url: `http://127.0.0.1:${server.port}`,
    requests,
    imageRequests,
    async stop() {
      await server.stop(true)
    },
  }
}
