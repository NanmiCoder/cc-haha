import { describe, expect, test } from 'bun:test'
import { EventStreamCodec } from '@smithy/eventstream-codec'
import { fromUtf8, toUtf8 } from '@smithy/util-utf8'
import {
  bedrockConverseResponseToAnthropic,
  bedrockConverseStreamToAnthropic,
  encodeBedrockEventStreamFrame,
} from './bedrockConverseToAnthropic.js'

async function collectSseEvents(stream: ReadableStream<Uint8Array>): Promise<Array<{ event: string; data: Record<string, unknown> }>> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let text = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    text += decoder.decode(value, { stream: true })
  }
  text += decoder.decode()

  const events: Array<{ event: string; data: Record<string, unknown> }> = []
  for (const frame of text.split('\n\n')) {
    if (!frame.trim()) continue
    let event = ''
    let data = ''
    for (const line of frame.split('\n')) {
      if (line.startsWith('event: ')) event = line.slice(7)
      else if (line.startsWith('data: ')) data += line.slice(6)
    }
    if (event && data) events.push({ event, data: JSON.parse(data) as Record<string, unknown> })
  }
  return events
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, item) => sum + item.byteLength, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}

describe('bedrockConverseToAnthropic', () => {
  test.each(['model_context_window_exceeded', 'malformed_model_output', 'malformed_tool_use'])(
    'keeps the upstream %s outcome in streaming and non-streaming responses',
    async stopReason => {
      const model = 'us.anthropic.claude-sonnet-4-6-v1:0'
      const response = {
        output: { message: { role: 'assistant', content: [{ text: 'Partial reply' }] } },
        stopReason,
      }
      const frames = concatBytes([
        encodeBedrockEventStreamFrame('messageStart', { role: 'assistant' }),
        encodeBedrockEventStreamFrame('contentBlockDelta', { contentBlockIndex: 0, delta: { text: 'Partial reply' } }),
        encodeBedrockEventStreamFrame('contentBlockStop', { contentBlockIndex: 0 }),
        encodeBedrockEventStreamFrame('messageStop', { stopReason }),
      ])
      const upstream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(frames)
          controller.close()
        },
      })
      const events = await collectSseEvents(bedrockConverseStreamToAnthropic(upstream, model))
      if (stopReason === 'model_context_window_exceeded') {
        expect(bedrockConverseResponseToAnthropic(response, model).stop_reason).toBe(stopReason)
        expect(events.find(e => e.event === 'message_delta')?.data.delta).toMatchObject({ stop_reason: stopReason })
      } else {
        expect(() => bedrockConverseResponseToAnthropic(response, model)).toThrow(stopReason)
        expect(events.at(-1)?.data.error).toMatchObject({ type: 'api_error', message: expect.stringContaining(stopReason) })
        expect(events.some(e => e.event === 'message_stop')).toBe(false)
      }
    },
  )

  test('decodes chunked binary AWS EventStream with thinking, signature, redactedContent, toolUse, text, and cache usage', async () => {
    const payload = concatBytes([
      encodeBedrockEventStreamFrame('messageStart', { role: 'assistant' }),
      encodeBedrockEventStreamFrame('contentBlockDelta', {
        contentBlockIndex: 0,
        delta: { reasoningContent: { text: 'Let me check the file.' } },
      }),
      encodeBedrockEventStreamFrame('contentBlockDelta', {
        contentBlockIndex: 0,
        delta: { reasoningContent: { signature: 'sig-bedrock-001' } },
      }),
      encodeBedrockEventStreamFrame('contentBlockStop', { contentBlockIndex: 0 }),
      encodeBedrockEventStreamFrame('contentBlockDelta', {
        contentBlockIndex: 1,
        delta: { reasoningContent: { redactedContent: 'cmVkYQ==' } },
      }),
      encodeBedrockEventStreamFrame('contentBlockDelta', {
        contentBlockIndex: 1,
        delta: { reasoningContent: { redactedContent: 'Y3RlZA==' } },
      }),
      encodeBedrockEventStreamFrame('contentBlockStop', { contentBlockIndex: 1 }),
      encodeBedrockEventStreamFrame('contentBlockStart', {
        contentBlockIndex: 2,
        start: { toolUse: { toolUseId: 'tooluse_abc', name: 'Read' } },
      }),
      encodeBedrockEventStreamFrame('contentBlockDelta', {
        contentBlockIndex: 2,
        delta: { toolUse: { input: '{"path":' } },
      }),
      encodeBedrockEventStreamFrame('contentBlockDelta', {
        contentBlockIndex: 2,
        delta: { toolUse: { input: '"index.ts"}' } },
      }),
      encodeBedrockEventStreamFrame('contentBlockStop', { contentBlockIndex: 2 }),
      encodeBedrockEventStreamFrame('contentBlockDelta', {
        contentBlockIndex: 3,
        delta: { text: 'Calling Read now.' },
        p: 'padding-ignored',
      }),
      encodeBedrockEventStreamFrame('contentBlockStop', { contentBlockIndex: 3 }),
      encodeBedrockEventStreamFrame('messageStop', { stopReason: 'tool_use' }),
      encodeBedrockEventStreamFrame('metadata', {
        usage: {
          inputTokens: 120,
          outputTokens: 45,
          cacheReadInputTokens: 30,
          cacheWriteInputTokens: 10,
        },
      }),
    ])

    // Deliberately split binary stream into arbitrary 11-byte TCP chunks
    const binaryStream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let offset = 0; offset < payload.byteLength; offset += 11) {
          controller.enqueue(payload.subarray(offset, Math.min(offset + 11, payload.byteLength)))
        }
        controller.close()
      },
    })

    const observed: string[] = []
    const anthropicStream = bedrockConverseStreamToAnthropic(binaryStream, 'us.anthropic.claude-sonnet-4-6-v1:0', {
      requestId: 'req-123',
      onEvent: (eventType) => observed.push(eventType),
    })

    const events = await collectSseEvents(anthropicStream)
    expect(observed).toContain('messageStop')
    expect(observed).toContain('metadata')

    expect(events[0]?.event).toBe('message_start')
    expect((events[0]?.data.message as Record<string, unknown>).id).toBe('msg_req-123')

    // Thinking + signature
    expect(events.some((e) => e.event === 'content_block_delta' && (e.data.delta as Record<string, unknown>).thinking === 'Let me check the file.')).toBe(true)
    expect(events.some((e) => e.event === 'content_block_delta' && (e.data.delta as Record<string, unknown>).signature === 'sig-bedrock-001')).toBe(true)

    // Redacted thinking accumulated across chunks
    const redactedStart = events.find(
      (e) => e.event === 'content_block_start' && (e.data.content_block as Record<string, unknown>).type === 'redacted_thinking',
    )
    expect((redactedStart?.data.content_block as Record<string, unknown>).data).toBe('cmVkYQ==Y3RlZA==')

    // Tool use block
    const toolStart = events.find(
      (e) => e.event === 'content_block_start' && (e.data.content_block as Record<string, unknown>).type === 'tool_use',
    )
    expect(toolStart?.data.content_block).toEqual({
      type: 'tool_use',
      id: 'tooluse_abc',
      name: 'Read',
      input: {},
    })
    const partialJsons = events
      .filter((e) => e.event === 'content_block_delta' && (e.data.delta as Record<string, unknown>).type === 'input_json_delta')
      .map((e) => (e.data.delta as Record<string, unknown>).partial_json)
      .join('')
    expect(partialJsons).toBe('{"path":"index.ts"}')

    // Message delta + stop
    const msgDelta = events.find((e) => e.event === 'message_delta')
    expect(msgDelta?.data.delta).toEqual({ stop_reason: 'tool_use', stop_sequence: null })
    expect(msgDelta?.data.usage).toEqual({
      input_tokens: 120,
      output_tokens: 45,
      cache_read_input_tokens: 30,
      cache_creation_input_tokens: 10,
    })
    expect(events.at(-1)?.event).toBe('message_stop')
  })

  test('emits Anthropic SSE error event on Bedrock stream exception', async () => {
    const payload = encodeBedrockEventStreamFrame(
      'throttlingException',
      { message: 'Too many requests, please wait.' },
      'exception',
    )
    const binaryStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(payload)
        controller.close()
      },
    })

    const events = await collectSseEvents(bedrockConverseStreamToAnthropic(binaryStream, 'amazon.nova-pro-v1:0'))
    expect(events).toHaveLength(1)
    expect(events[0]?.event).toBe('error')
    expect((events[0]?.data.error as Record<string, unknown>).message).toBe('Too many requests, please wait.')
  })

  test('emits Anthropic SSE error on truncated stream without messageStop, handles EventStream error frames, and emits both text and signature when combined', async () => {
    // 1) Truncated stream ending cleanly before messageStop must fail instead of emitting message_stop
    const truncatedPayload = concatBytes([
      encodeBedrockEventStreamFrame('messageStart', { role: 'assistant' }),
      encodeBedrockEventStreamFrame('contentBlockDelta', {
        contentBlockIndex: 0,
        delta: { text: 'Partial reply' },
      }),
    ])
    const truncatedStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(truncatedPayload)
        controller.close()
      },
    })
    const truncatedEvents = await collectSseEvents(bedrockConverseStreamToAnthropic(truncatedStream, 'us.anthropic.claude-sonnet-4-6-v1:0'))
    expect(truncatedEvents.some((e) => e.event === 'message_stop')).toBe(false)
    expect(truncatedEvents.at(-1)?.event).toBe('error')
    expect((truncatedEvents.at(-1)?.data.error as Record<string, unknown>).message).toContain('without a messageStop event')

    // 2) AWS EventStream `:message-type: "error"` frame emits Anthropic SSE error
    const codec = new EventStreamCodec(toUtf8, fromUtf8)
    const errorFrame = codec.encode({
      headers: {
        ':message-type': { type: 'string', value: 'error' },
        ':error-code': { type: 'string', value: 'InternalFailure' },
        ':error-message': { type: 'string', value: 'Upstream internal error' },
      },
      body: new Uint8Array(),
    })
    const errorStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(errorFrame)
        controller.close()
      },
    })
    const errorEvents = await collectSseEvents(bedrockConverseStreamToAnthropic(errorStream, 'us.anthropic.claude-sonnet-4-6-v1:0'))
    expect(errorEvents).toHaveLength(1)
    expect(errorEvents[0]?.event).toBe('error')
    expect((errorEvents[0]?.data.error as Record<string, unknown>).message).toContain('Upstream internal error')

    // 3) Combined reasoningContent `{ text, signature }` emits both thinking_delta and signature_delta
    const combinedPayload = concatBytes([
      encodeBedrockEventStreamFrame('messageStart', { role: 'assistant' }),
      encodeBedrockEventStreamFrame('contentBlockDelta', {
        contentBlockIndex: 0,
        delta: { reasoningContent: { text: 'Combined thought', signature: 'sig-combined' } },
      }),
      encodeBedrockEventStreamFrame('contentBlockStop', { contentBlockIndex: 0 }),
      encodeBedrockEventStreamFrame('messageStop', { stopReason: 'end_turn' }),
    ])
    const combinedStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(combinedPayload)
        controller.close()
      },
    })
    const combinedEvents = await collectSseEvents(bedrockConverseStreamToAnthropic(combinedStream, 'us.anthropic.claude-sonnet-4-6-v1:0'))
    expect(combinedEvents.some((e) => e.event === 'content_block_delta' && (e.data.delta as Record<string, unknown>).thinking === 'Combined thought')).toBe(true)
    expect(combinedEvents.some((e) => e.event === 'content_block_delta' && (e.data.delta as Record<string, unknown>).signature === 'sig-combined')).toBe(true)
  })

  test('converts non-streaming Bedrock Converse response into Anthropic Message', () => {
    const result = bedrockConverseResponseToAnthropic(
      {
        output: {
          message: {
            role: 'assistant',
            content: [
              { reasoningContent: { reasoningText: { text: 'Step 1', signature: 'sig-nonstream' } } },
              { reasoningContent: { redactedContent: 'cmVkYWN0ZWQ=' } },
              { text: 'All done.' },
              { toolUse: { toolUseId: 'tooluse_99', name: 'Bash', input: { command: 'echo ok' } } },
            ],
          },
        },
        stopReason: 'tool_use',
        usage: {
          inputTokens: 88,
          outputTokens: 21,
          cacheReadInputTokens: 12,
        },
      },
      'us.anthropic.claude-sonnet-4-6-v1:0',
      'amzn-req-9',
    )

    expect(result).toEqual({
      id: 'msg_amzn-req-9',
      type: 'message',
      role: 'assistant',
      model: 'us.anthropic.claude-sonnet-4-6-v1:0',
      content: [
        { type: 'thinking', thinking: 'Step 1', signature: 'sig-nonstream' },
        { type: 'redacted_thinking', data: 'cmVkYWN0ZWQ=' },
        { type: 'text', text: 'All done.' },
        { type: 'tool_use', id: 'tooluse_99', name: 'Bash', input: { command: 'echo ok' } },
      ],
      stop_reason: 'tool_use',
      stop_sequence: null,
      usage: {
        input_tokens: 88,
        output_tokens: 21,
        cache_read_input_tokens: 12,
      },
    })
  })

  test('returns matching Converse and ConverseStream stop sequences for native and gateway fields', async () => {
    const model = 'us.anthropic.claude-sonnet-4-6-v1:0'
    for (const [stopReason, additionalModelResponseFields, expected] of [
      ['stop_sequence', { stop_sequence: 'SUCCESS' }, 'SUCCESS'],
      ['stop_sequence', { stop_sequence: 'SUCCESS', delta: { stop_sequence: 'legacy' } }, 'SUCCESS'],
      ['stop_sequence', { delta: { stop_sequence: 'legacy' } }, 'legacy'],
      ['stop_sequence', undefined, null],
      ['stop_sequence', { stop_sequence: 12 }, null],
      ['end_turn', { stop_sequence: 'irrelevant' }, null],
      ['max_tokens', undefined, null],
      [undefined, { stop_sequence: 'unconfirmed' }, null],
    ] as const) {
      const stop = { stopReason, additionalModelResponseFields }
      const delta = { stop_reason: stopReason ?? 'end_turn', stop_sequence: expected }
      const output = { message: { role: 'assistant', content: [{ text: 'done' }] } }
      expect(bedrockConverseResponseToAnthropic({ output, ...stop }, model)).toMatchObject(delta)
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encodeBedrockEventStreamFrame('messageStop', stop))
          controller.close()
        },
      })
      const events = await collectSseEvents(bedrockConverseStreamToAnthropic(stream, model))
      if (stopReason === undefined) {
        expect(events.at(-1)?.event).toBe('error')
        expect(events.some(e => e.event === 'message_delta')).toBe(false)
      } else {
        expect(events.find(e => e.event === 'message_delta')?.data.delta).toEqual(delta)
      }
    }
  })
})
