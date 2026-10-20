import { describe, expect, test } from 'bun:test'

import { decodeGeminiThoughtSignature } from '../transform/anthropicToGemini.js'
import { geminiResponseToAnthropic, geminiStreamToAnthropic } from './geminiStreamToAnthropic.js'

const MODEL = 'gemini-4-argon-contributor'

function sse(...chunks: unknown[]): ReadableStream<Uint8Array> {
  // CRLF framing, as Google sends it, split mid-frame to exercise reassembly.
  const text = chunks.map(chunk => `data: ${JSON.stringify(chunk)}\r\n\r\n`).join('')
  const bytes = new TextEncoder().encode(text)
  const middle = Math.floor(bytes.length / 2)
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes.slice(0, middle))
      controller.enqueue(bytes.slice(middle))
      controller.close()
    },
  })
}

async function events(stream: ReadableStream<Uint8Array>): Promise<Array<Record<string, any>>> {
  const text = await new Response(stream).text()
  return text.split('\n\n').filter(Boolean).map(frame => JSON.parse(frame.split('\n')[1]!.slice('data: '.length)))
}

const noContinuation = async (): Promise<never> => {
  throw new Error('unexpected continuation')
}

describe('geminiStreamToAnthropic', () => {
  test('streams thought summaries, text and usage as one Anthropic message', async () => {
    const output = await events(geminiStreamToAnthropic(sse(
      { responseId: 'r1', candidates: [{ content: { role: 'model', parts: [{ text: 'Considering', thought: true }] } }] },
      { candidates: [{ content: { role: 'model', parts: [{ text: ' it.', thought: true, thoughtSignature: 'sig-1' }] } }] },
      { candidates: [{ content: { role: 'model', parts: [{ text: 'Hel' }] } }] },
      {
        candidates: [{ content: { role: 'model', parts: [{ text: 'lo' }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 1200, cachedContentTokenCount: 1000, candidatesTokenCount: 5, thoughtsTokenCount: 40 },
      },
    ), MODEL, noContinuation))

    expect(output.map(event => event.type)).toEqual([
      'message_start',
      'content_block_start', 'content_block_delta', 'content_block_delta', 'content_block_delta', 'content_block_stop',
      'content_block_start', 'content_block_delta', 'content_block_delta', 'content_block_stop',
      'message_delta', 'message_stop',
    ])
    expect(output[0]!.message).toMatchObject({ id: 'msg_r1', model: MODEL })
    expect(output[1]!.content_block).toEqual({ type: 'thinking', thinking: '' })
    expect(output[2]!.delta).toEqual({ type: 'thinking_delta', thinking: 'Considering' })
    expect(decodeGeminiThoughtSignature(output[4]!.delta.signature)).toBe('sig-1')
    expect(output[7]!.delta).toEqual({ type: 'text_delta', text: 'Hel' })
    expect(output[10]).toEqual({
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      // promptTokenCount includes the cached part; output includes thoughts.
      usage: { input_tokens: 200, output_tokens: 45, cache_read_input_tokens: 1000 },
    })
  })

  test('keeps a function call signature ahead of its tool_use and ends the turn as tool_use', async () => {
    const output = await events(geminiStreamToAnthropic(sse({
      candidates: [{
        content: {
          role: 'model',
          parts: [
            { functionCall: { id: 'call_1', name: 'Read', args: { file_path: 'a.txt' } }, thoughtSignature: 'sig-call' },
            { functionCall: { id: 'call_1', name: 'Read', args: { file_path: 'b.txt' } } },
          ],
        },
        finishReason: 'STOP',
      }],
    }), MODEL, noContinuation))

    const starts = output.filter(event => event.type === 'content_block_start').map(event => event.content_block)
    expect(starts[0].type).toBe('redacted_thinking')
    expect(decodeGeminiThoughtSignature(starts[0].data)).toBe('sig-call')
    expect(starts[1]).toEqual({ type: 'tool_use', id: 'call_1', name: 'Read', input: {} })
    // A repeated supplier id would replay as two identical calls.
    expect(starts[2].id).toMatch(/^toolu_[0-9a-f]{32}$/)
    expect(output.filter(event => event.delta?.type === 'input_json_delta').map(event => event.delta.partial_json))
      .toEqual(['{"file_path":"a.txt"}', '{"file_path":"b.txt"}'])
    expect(output.find(event => event.type === 'message_delta')!.delta.stop_reason).toBe('tool_use')
  })

  test('follows a response Gemini split across requests and reports it as one message', async () => {
    const tokens: string[] = []
    const output = await events(geminiStreamToAnthropic(
      sse(
        { candidates: [{ content: { role: 'model', parts: [{ text: 'THIRTEEN THOUSAND' }] } }] },
        {
          candidates: [{ content: { role: 'model', parts: [{ text: '' }] }, finishReason: 'CONTINUATION', continuationToken: 'token-1' }],
          usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 10 },
        },
      ),
      MODEL,
      async (token) => {
        tokens.push(token)
        return sse({
          candidates: [{ content: { role: 'model', parts: [{ text: ' TWO' }] }, finishReason: 'STOP' }],
          usageMetadata: { promptTokenCount: 110, candidatesTokenCount: 2 },
        })
      },
    ))

    expect(tokens).toEqual(['token-1'])
    expect(output.filter(event => event.type === 'message_start')).toHaveLength(1)
    expect(output.filter(event => event.type === 'content_block_start')).toHaveLength(1)
    expect(output.filter(event => event.delta?.type === 'text_delta').map(event => event.delta.text).join(''))
      .toBe('THIRTEEN THOUSAND TWO')
    // The first request's prompt with every request's output.
    expect(output.find(event => event.type === 'message_delta')!.usage).toEqual({ input_tokens: 100, output_tokens: 12 })
  })

  test('fails instead of succeeding when the upstream does not finish usably', async () => {
    const cases: Array<[ReadableStream<Uint8Array>, string]> = [
      [sse({ error: { code: 429, message: 'Resource exhausted', status: 'RESOURCE_EXHAUSTED' } }), 'Resource exhausted'],
      [sse({ candidates: [{ content: { role: 'model', parts: [{ text: 'partial' }] } }] }), 'without a finish reason'],
      [sse({ candidates: [{ content: { role: 'model', parts: [{ text: 'x' }] }, finishReason: 'MALFORMED_FUNCTION_CALL' }] }), 'MALFORMED_FUNCTION_CALL'],
      [sse({ candidates: [{ finishReason: 'SAFETY' }] }), 'Gemini stopped with SAFETY'],
      [sse({ promptFeedback: { blockReason: 'PROHIBITED_CONTENT' } }), 'blocked the request (PROHIBITED_CONTENT)'],
      [sse({ candidates: [{ finishReason: 'CONTINUATION' }] }), 'without a continuation token'],
    ]
    for (const [stream, message] of cases) {
      const output = await events(geminiStreamToAnthropic(stream, MODEL, noContinuation))
      expect(output.some(event => event.type === 'message_stop'), message).toBe(false)
      expect(output.at(-1), message).toMatchObject({ type: 'error', error: { message: expect.stringContaining(message) } })
    }
  })

  test('cancels the upstream request when the client stops reading', async () => {
    let upstreamCancelled: unknown
    const encoder = new TextEncoder()
    const upstream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: 'Working' }] } }] })}\n\n`))
        // Never closes: the model is still generating.
      },
      cancel(reason) {
        upstreamCancelled = reason ?? 'cancelled'
      },
    })
    const reader = geminiStreamToAnthropic(upstream, MODEL, noContinuation).getReader()
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('message_start')
    await reader.cancel('user stopped')
    expect(upstreamCancelled).toBe('user stopped')
  })

  test('keeps partial text when a safety stop follows visible output', async () => {
    const output = await events(geminiStreamToAnthropic(sse(
      { candidates: [{ content: { role: 'model', parts: [{ text: 'Here is' }] }, finishReason: 'RECITATION' }] },
    ), MODEL, noContinuation))
    expect(output.find(event => event.type === 'message_delta')!.delta.stop_reason).toBe('end_turn')
  })
})

describe('geminiResponseToAnthropic', () => {
  test('converts a non-stream response, following its continuation', async () => {
    const response = await geminiResponseToAnthropic(
      {
        candidates: [{
          content: { role: 'model', parts: [{ text: 'Checking.', thought: true }, { text: 'Let me look' }] },
          finishReason: 'CONTINUATION',
          continuationToken: 'token-1',
        }],
        usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 4 },
      },
      MODEL,
      async () => ({
        candidates: [{
          content: { role: 'model', parts: [{ text: '.' }, { functionCall: { name: 'Glob', args: { pattern: '*.ts' } }, thoughtSignature: 'sig' }] },
          finishReason: 'STOP',
        }],
        usageMetadata: { promptTokenCount: 60, candidatesTokenCount: 3, thoughtsTokenCount: 2 },
      }),
    )
    expect(response).toMatchObject({
      type: 'message',
      model: MODEL,
      stop_reason: 'tool_use',
      usage: { input_tokens: 50, output_tokens: 9 },
    })
    expect(response.content.map(block => block.type)).toEqual(['thinking', 'text', 'redacted_thinking', 'tool_use'])
    expect(response.content[1]).toEqual({ type: 'text', text: 'Let me look.' })
    expect(response.content[3]).toMatchObject({ type: 'tool_use', name: 'Glob', input: { pattern: '*.ts' } })
  })
})
