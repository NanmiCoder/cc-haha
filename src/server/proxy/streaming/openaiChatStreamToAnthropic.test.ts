import { describe, expect, test } from 'bun:test'
import { openaiChatStreamToAnthropic } from './openaiChatStreamToAnthropic.js'

function chunk(delta: Record<string, unknown>, finish: string | null = null): string {
  return `data: ${JSON.stringify({ id: 'fixture', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`
}

async function collect(input: string, bytewise = false) {
  const bytes = new TextEncoder().encode(input)
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      if (bytewise) for (const byte of bytes) controller.enqueue(Uint8Array.of(byte))
      else controller.enqueue(bytes)
      controller.close()
    },
  })
  const output = await new Response(openaiChatStreamToAnthropic(source, 'fixture')).text()
  return output.split('\n\n').filter(Boolean).map(frame => JSON.parse(frame.split('\ndata: ')[1]))
}

function tool(index = 0, extra: Record<string, unknown> = {}) {
  return { index, id: `call_${index}`, function: { name: 'Read', arguments: '{}' }, ...extra }
}

describe('Chat stream protocol boundaries', () => {
  test('SSE data without space, multiline JSON, CRLF and split UTF-8 preserve content', async () => {
    const input = 'event: message\r\ndata:{"id":"fixture",\r\ndata:"choices":[{"delta":{"content":"你好"},"finish_reason":null}]}\r\n\r\n'
      + chunk({}, 'stop') + 'data:[DONE]\n\n'
    const events = await collect(input, true)
    expect(events.filter(e => e.delta?.text).map(e => e.delta.text)).toEqual(['你好'])
    expect(events.at(-1).type).toBe('message_stop')
  })

  test('reasoning, text and tools in one delta are all preserved', async () => {
    const events = await collect(chunk({ reasoning_content: 'Think', content: 'Act', tool_calls: [tool()] }) + chunk({}, 'tool_calls'))
    expect(events.filter(e => e.type === 'content_block_start').map(e => e.content_block.type)).toEqual(['thinking', 'text', 'tool_use'])
    expect(events.filter(e => e.delta?.thinking).map(e => e.delta.thinking)).toEqual(['Think'])
    expect(events.filter(e => e.delta?.text).map(e => e.delta.text)).toEqual(['Act'])
  })

  for (const suffix of ['', 'data:[DONE]\n\n']) {
    test(`missing finish reason fails with ${suffix ? 'DONE' : 'EOF'}`, async () => {
      const events = await collect(chunk({ content: 'Partial' }) + suffix)
      expect(events.at(-1).error.type).toBe('stream_truncated')
      expect(events.some(e => e.type === 'message_stop')).toBe(false)
    })
  }

  test('upstream error envelope is an error without success', async () => {
    const events = await collect('data: {"error":{"type":"server_error","message":"Fixture backend failed"}}\n\ndata: [DONE]\n\n')
    expect(events.at(-1).error.message).toContain('Fixture backend failed')
    expect(events.some(e => e.type === 'message_stop')).toBe(false)
  })

  for (const broken of [tool(0, { id: '' }), tool(0, { function: { name: '', arguments: '{}' } }), tool(0, { function: { name: 'Read', arguments: '{"path":' } }), tool(0, { function: { name: 'Read', arguments: '[]' } })]) {
    test(`rejects completed invalid tool ${JSON.stringify(broken)}`, async () => {
      const events = await collect(chunk({ tool_calls: [broken] }) + chunk({}, 'tool_calls'))
      expect(events.at(-1).type).toBe('error')
      expect(events.some(e => e.type === 'message_stop')).toBe(false)
    })
  }

  test('length retains truncation cause without synthesizing tool success', async () => {
    const events = await collect(chunk({ tool_calls: [tool(0, { function: { name: 'Read', arguments: '{"path":' } })] }) + chunk({}, 'length'))
    expect(events.find(e => e.type === 'message_delta').delta.stop_reason).toBe('max_tokens')
  })

  test('content filter cannot commit a partial tool', async () => {
    const events = await collect(chunk({ tool_calls: [tool()] }) + chunk({}, 'content_filter'))
    expect(events.at(-1).type).toBe('error')
    expect(events.some(e => e.type === 'content_block_stop')).toBe(false)
  })

  test('unknown finish reason and malformed SSE JSON cannot become success', async () => {
    for (const input of [chunk({ content: 'text' }, 'future_reason'), 'data: {broken}\n\ndata: [DONE]\n\n']) {
      const events = await collect(input)
      expect(events.at(-1).type).toBe('error')
      expect(events.some(e => e.type === 'message_stop')).toBe(false)
    }
  })

  test('late provider error after finish reason prevents terminal success', async () => {
    const events = await collect(chunk({ content: 'text' }, 'stop') + 'data: {"error":"late failure"}\n\n')
    expect(events.at(-1).error.message).toBe('late failure')
    expect(events.some(e => e.type === 'message_delta')).toBe(false)
  })

  test('DONE terminates without waiting for an open socket', async () => {
    let cancelled = false
    const source = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode(chunk({ content: 'done' }, 'stop') + 'data:[DONE]\n\n')) },
      cancel() { cancelled = true },
    })
    const result = await new Response(openaiChatStreamToAnthropic(source, 'fixture')).text()
    expect(result).toContain('message_stop')
    expect(cancelled).toBe(true)
  })

  test('tool identity cannot change or collide across indexes', async () => {
    for (const second of [tool(0, { id: 'other' }), tool(0, { function: { name: 'Write', arguments: '' } }), tool(1, { id: 'call_0' }), { function: { arguments: '{}' } }]) {
      const events = await collect(chunk({ tool_calls: [tool()] }) + chunk({ tool_calls: [second] }) + chunk({}, 'tool_calls'))
      expect(events.at(-1).type).toBe('error')
      expect(events.some(e => e.type === 'message_stop')).toBe(false)
    }
  })

  test('empty reasoning placeholders do not fragment text blocks', async () => {
    const events = await collect(chunk({ reasoning_content: '', content: 'one' }) + chunk({ reasoning_content: '', content: 'two' }) + chunk({}, 'stop'))
    expect(events.filter(e => e.type === 'content_block_start').map(e => e.content_block.type)).toEqual(['text'])
  })

  test('parallel tool arguments remain associated across interleaved text and usage tail', async () => {
    const events = await collect(chunk({ tool_calls: [tool(0, { function: { name: 'Read', arguments: '{"a":' } }), tool(1, { function: { name: 'Read', arguments: '{"b":' } })] })
      + chunk({ content: 'working' })
      + chunk({ tool_calls: [{ index: 1, function: { arguments: '2}' } }, { index: 0, function: { arguments: '1}' } }] })
      + chunk({}, 'tool_calls')
      + 'data:{"choices":[],"usage":{"prompt_tokens":12,"completion_tokens":5}}\n\ndata:[DONE]\n\n')
    const starts = events.filter(e => e.content_block?.type === 'tool_use')
    expect(starts).toHaveLength(2)
    expect(starts.map(e => events.filter(d => d.index === e.index && d.delta?.partial_json).map(d => d.delta.partial_json).join(''))).toEqual(['{"a":1}', '{"b":2}'])
    expect(events.filter(e => e.type === 'content_block_stop').map(e => e.index).sort()).toEqual([0, 1, 2])
    expect(events.find(e => e.type === 'message_delta').usage.output_tokens).toBe(5)
  })

  test('downstream cancellation cancels pending upstream read', async () => {
    let cancelled = false
    const source = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode(chunk({ content: 'hello' }))) },
      cancel() { cancelled = true },
    })
    const reader = openaiChatStreamToAnthropic(source, 'fixture').getReader()
    await reader.read()
    await reader.cancel()
    expect(cancelled).toBe(true)
  })
})
