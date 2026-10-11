/**
 * Loopback Anthropic Messages endpoint backed by `scriptedModel.ts`.
 *
 * Speaks enough of the wire protocol for the real CLI: streamed and non-streamed
 * `/v1/messages`, plus `count_tokens`. Every request is recorded so a scenario can
 * assert on what actually went upstream — for example that a tool's real output
 * came back to the model in the next request, which no UI frame can prove.
 */

import { decideReply, type MockContentBlock, type MockRequest } from './scriptedModel'

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
  stop(): Promise<void>
}

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

function handleMessages(record: RecordedRequest): Response {
  const request = record.body
  const reply = decideReply(request)
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

export function startMockLlmServer(): MockLlmServer {
  const requests: RecordedRequest[] = []
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname
      if (req.method === 'GET' && path.endsWith('/v1/models')) {
        return Response.json({ data: [{ type: 'model', id: MODEL_FALLBACK, display_name: 'Mock model' }], has_more: false })
      }
      if (req.method !== 'POST') return new Response('not found', { status: 404 })

      const body = (await req.json().catch(() => ({}))) as MockRequest & { stream?: boolean }
      if (path.endsWith('/v1/messages/count_tokens')) {
        return Response.json({ input_tokens: 12 })
      }
      if (path.endsWith('/v1/messages')) {
        const record: RecordedRequest = { path, stream: body.stream === true, body, receivedAt: Date.now(), outcome: 'pending' }
        requests.push(record)
        return handleMessages(record)
      }
      return new Response('not found', { status: 404 })
    },
  })

  return {
    url: `http://127.0.0.1:${server.port}`,
    requests,
    async stop() {
      await server.stop(true)
    },
  }
}
