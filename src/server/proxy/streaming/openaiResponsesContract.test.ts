import { describe, expect, test } from 'bun:test'
import { openaiResponsesStreamToAnthropic } from './openaiResponsesStreamToAnthropic.js'
import { openaiResponsesStreamToAnthropicResponse } from './openaiResponsesStreamToAnthropicResponse.js'
import { openaiResponsesToAnthropic } from '../transform/openaiResponsesToAnthropic.js'
import type { OpenAIResponsesResponse } from '../transform/types.js'

const event = (type: string, data: Record<string, unknown> = {}) =>
  `event:${type}\ndata:${JSON.stringify({ type, ...data })}\n\n`
const stream = (input: string) => new ReadableStream<Uint8Array>({
  start(controller) {
    const bytes = new TextEncoder().encode(input)
    // Exercise UTF-8 and SSE framing across arbitrary transport boundaries.
    for (let offset = 0; offset < bytes.length; offset += 7) controller.enqueue(bytes.slice(offset, offset + 7))
    controller.close()
  },
})
const collect = async (input: string, oauth = false) => {
  const text = await new Response(openaiResponsesStreamToAnthropic(stream(input), 'fixture', { openAICodexOAuth: oauth })).text()
  return text.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)))
}
const tool = { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'Write', arguments: '{"path":"fixture","text":"你好"}' }
const startTool = event('response.output_item.added', { output_index: 0, item: { ...tool, arguments: '' } })
const completed = (output?: unknown[]) => event('response.completed', { response: { status: 'completed', ...(output ? { output } : {}) } })
const response = (values: Record<string, unknown>) => ({ id: 'fixture', object: 'response', created_at: 0, model: 'fixture', status: 'completed', output: [], ...values }) as OpenAIResponsesResponse

describe('Responses terminal contract independent of authentication', () => {
  for (const oauth of [false, true]) {
    for (const type of ['response.failed', 'response.cancelled', 'error']) {
      test(`${type} remains an error (oauth=${oauth})`, async () => {
        const input = event(type, { response: { error: { message: 'fixture upstream failed' } } })
        const events = await collect(input, oauth)
        expect(events.some(item => item.type === 'message_stop')).toBe(false)
        expect(events.find(item => item.type === 'error')?.error.message).toBe('fixture upstream failed')
        await expect(openaiResponsesStreamToAnthropicResponse(stream(input), 'fixture', { openAICodexOAuth: oauth })).rejects.toThrow('fixture upstream failed')
      })
    }
    test(`incomplete cause is preserved (oauth=${oauth})`, async () => {
      for (const reason of ['content_filter', 'unknown']) {
        const events = await collect(event('response.incomplete', { response: { status: 'incomplete', incomplete_details: { reason } } }), oauth)
        expect(events.find(item => item.type === 'error')?.error.message).toContain(reason)
        expect(events.some(item => item.type === 'message_stop')).toBe(false)
      }
    })
    test(`EOF and bare DONE require terminal evidence (oauth=${oauth})`, async () => {
      for (const input of [startTool, 'data:[DONE]\n\n']) {
        await expect(collect(input, oauth)).rejects.toThrow('before response.completed')
        await expect(openaiResponsesStreamToAnthropicResponse(stream(input), 'fixture', { openAICodexOAuth: oauth })).rejects.toMatchObject({ code: 'ERR_STREAM_PREMATURE_CLOSE' })
      }
    })
    test(`explicit budget termination closes partial tools before message_delta (oauth=${oauth})`, async () => {
      const input = startTool + event('response.function_call_arguments.delta', { item_id: 'fc_1', delta: '{"path":' }) + event('response.incomplete', { response: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, usage: { output_tokens: 12 } } })
      const events = await collect(input, oauth)
      const stop = events.findIndex(item => item.type === 'content_block_stop')
      const delta = events.findIndex(item => item.type === 'message_delta')
      expect(stop).toBeGreaterThan(-1)
      expect(stop).toBeLessThan(delta)
      expect(events[delta].delta.stop_reason).toBe('max_tokens')
      const result = await openaiResponsesStreamToAnthropicResponse(stream(input), 'fixture', { openAICodexOAuth: oauth })
      expect(result.stop_reason).toBe('max_tokens')
      expect(result.content.some(item => item.type === 'tool_use')).toBe(false)
    })
  }
})

describe('Responses tool finalization and snapshots', () => {
  for (const terminal of ['arguments.done', 'output_item.done', 'completed']) {
    test(`recovers complete arguments from ${terminal} once`, async () => {
      const done = terminal === 'arguments.done' ? event('response.function_call_arguments.done', { item_id: 'fc_1', arguments: tool.arguments })
        : terminal === 'output_item.done' ? event('response.output_item.done', { output_index: 0, item: tool }) : ''
      const events = await collect(startTool + done + done + completed([tool]))
      expect(events.filter(item => item.type === 'content_block_start')).toHaveLength(1)
      expect(events.filter(item => item.type === 'content_block_stop')).toHaveLength(1)
      expect(events.filter(item => item.delta?.type === 'input_json_delta').map(item => item.delta.partial_json).join('')).toBe(tool.arguments)
    })
  }
  test('snapshot-only response recovers text and tool in output order', async () => {
    const input = completed([{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hello' }] }, tool])
    const result = await openaiResponsesStreamToAnthropicResponse(stream(input), 'fixture')
    expect(result.content).toEqual([{ type: 'text', text: 'hello' }, { type: 'tool_use', id: 'call_1', name: 'Write', input: { path: 'fixture', text: '你好' } }])
  })
  test('partial arguments are completed by a matching final snapshot', async () => {
    const events = await collect(startTool + event('response.function_call_arguments.delta', { item_id: 'fc_1', delta: '{"path":' }) + completed([tool]))
    expect(events.filter(item => item.delta?.type === 'input_json_delta').map(item => item.delta.partial_json).join('')).toBe(tool.arguments)
  })
  test('completed malformed, missing and conflicting arguments are rejected', async () => {
    for (const argumentsValue of ['{"path":', '[]', 'null']) {
      await expect(collect(startTool + event('response.function_call_arguments.delta', { item_id: 'fc_1', delta: argumentsValue }) + completed())).rejects.toThrow('tool arguments')
    }
    await expect(collect(startTool + completed())).rejects.toThrow('tool arguments')
    await expect(collect(startTool + event('response.function_call_arguments.delta', { item_id: 'fc_1', delta: '{"different":true}' }) + completed([tool]))).rejects.toThrow('arguments')
  })
  test('streamed text plus completed snapshot is not duplicated', async () => {
    const input = event('response.content_part.added', { output_index: 0, content_index: 0, part: { type: 'output_text', text: '' } }) + event('response.output_text.delta', { output_index: 0, content_index: 0, delta: 'hello' }) + event('response.output_text.done', { output_index: 0, content_index: 0, text: 'hello' }) + completed([{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hello' }] }])
    const result = await openaiResponsesStreamToAnthropicResponse(stream(input), 'fixture')
    expect(result.content).toEqual([{ type: 'text', text: 'hello' }])
  })
})

describe('Responses non-streaming terminal validation', () => {
  test('failure, cancellation and unknown incomplete never become successful output', () => {
    for (const status of ['failed', 'cancelled', 'incomplete', 'in_progress']) {
      expect(() => openaiResponsesToAnthropic(response({ status }), 'fixture')).toThrow()
    }
  })
  test('content_filter is not labeled as a token limit', () => {
    expect(() => openaiResponsesToAnthropic(response({ status: 'incomplete', incomplete_details: { reason: 'content_filter' } }), 'fixture')).toThrow('content_filter')
  })
  test('malformed completed tool input is not converted into raw or empty objects', () => {
    for (const argumentsValue of ['{"path":', '', null, '[]']) {
      expect(() => openaiResponsesToAnthropic(response({ output: [{ ...tool, arguments: argumentsValue }] }), 'fixture')).toThrow('tool arguments')
    }
  })
  test('explicit token-limited response retains text but excludes tool calls', () => {
    const result = openaiResponsesToAnthropic(response({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [{ ...tool, arguments: '{"path":' }] }), 'fixture')
    expect(result.stop_reason).toBe('max_tokens')
    expect(result.content.some(item => item.type === 'tool_use')).toBe(false)
  })
})

describe('Responses collection and lifecycle', () => {
  test('snapshot metadata, reasoning envelope and usage survive collection', async () => {
    const input = event('response.completed', { response: { id: 'upstream-id', model: 'upstream-model', status: 'completed', output: [{ type: 'reasoning', id: 'rs_1', encrypted_content: 'opaque', summary: [] }], usage: { input_tokens: 10, output_tokens: 4 } } })
    const result = await openaiResponsesStreamToAnthropicResponse(stream(input), 'fixture', { openAICodexOAuth: true })
    expect(result.id).toBe('upstream-id')
    expect(result.model).toBe('upstream-model')
    expect(result.usage).toEqual({ input_tokens: 10, output_tokens: 4 })
    expect(result.content).toHaveLength(1)
    expect(result.content[0]).toMatchObject({ type: 'redacted_thinking' })
  })
  test('OAuth reasoning without encryption preserves the summary', async () => {
    const result = await openaiResponsesStreamToAnthropicResponse(stream(completed([{ type: 'reasoning', summary: [{ type: 'summary_text', text: 'reason' }] }])), 'fixture', { openAICodexOAuth: true })
    expect(result.content).toEqual([{ type: 'thinking', thinking: 'reason' }])
  })
  test('completed snapshot cannot silently turn missing or invalid output into success', async () => {
    for (const output of [undefined, {}, null]) {
      const input = event('response.completed', { response: { status: 'completed', ...(output !== undefined ? { output } : {}) } })
      await expect(collect(input)).rejects.toThrow('output')
      await expect(openaiResponsesStreamToAnthropicResponse(stream(input), 'fixture')).rejects.toThrow('output')
    }
  })
  test('terminal event stops upstream reads, calls hooks once and ignores trailing errors', async () => {
    const terminalEvents: string[] = []
    let settled = 0
    let cancelled = 0
    const upstream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(completed([tool]) + event('response.failed', { response: { error: { message: 'late failure' } } })))
      },
      cancel() { cancelled++ },
    })
    const text = await new Response(openaiResponsesStreamToAnthropic(upstream, 'fixture', {
      onTerminal: value => terminalEvents.push(value), onSettled: () => { settled++ },
    })).text()
    await Promise.resolve()
    expect(text).not.toContain('late failure')
    expect(terminalEvents).toEqual(['response.completed'])
    expect(settled).toBe(1)
    expect(cancelled).toBe(1)
  })
  test('downstream cancellation propagates reason and lifecycle hooks', async () => {
    let reason: unknown
    let hookReason: unknown
    let settled = 0
    const upstream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode(event('response.created', { response: { id: 'fixture' } }))) },
      cancel(value) { reason = value },
    })
    const reader = openaiResponsesStreamToAnthropic(upstream, 'fixture', {
      onCancel: value => { hookReason = value }, onSettled: () => { settled++ },
    }).getReader()
    await reader.read()
    await reader.cancel('fixture cancelled')
    await Promise.resolve()
    expect(reason).toBe('fixture cancelled')
    expect(hookReason).toBe('fixture cancelled')
    expect(settled).toBe(1)
  })
})

test('equivalent final object arguments do not overwrite or duplicate streamed JSON', async () => {
  const input = startTool + event('response.function_call_arguments.delta', { item_id: 'fc_1', delta: tool.arguments }) + completed([{ ...tool, arguments: { text: '你好', path: 'fixture' } }])
  const events = await collect(input)
  expect(events.filter(item => item.delta?.type === 'input_json_delta').map(item => item.delta.partial_json).join('')).toBe(tool.arguments)
  expect(events.filter(item => item.type === 'content_block_stop')).toHaveLength(1)
})

test('corrupt SSE frames cannot be hidden by a later completed tool snapshot', async () => {
  const input = startTool + 'event:response.function_call_arguments.delta\ndata:broken-json\n\n' + completed([tool])
  for (const oauth of [false, true]) {
    await expect(collect(input, oauth)).rejects.toThrow('Invalid OpenAI Responses SSE JSON')
    await expect(openaiResponsesStreamToAnthropicResponse(stream(input), 'fixture', { openAICodexOAuth: oauth })).rejects.toThrow('Invalid OpenAI Responses SSE JSON')
  }
})
