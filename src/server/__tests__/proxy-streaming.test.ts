/**
 * Unit tests for proxy streaming SSE transformation
 */

import { describe, test, expect } from 'bun:test'
import { openaiChatStreamToAnthropic } from '../proxy/streaming/openaiChatStreamToAnthropic.js'
import { openaiResponsesStreamToAnthropic } from '../proxy/streaming/openaiResponsesStreamToAnthropic.js'
import { openaiResponsesStreamToAnthropicResponse } from '../proxy/streaming/openaiResponsesStreamToAnthropicResponse.js'

// ─── Helpers ────────────────────────────────────────────────────

function makeStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk))
      }
      controller.close()
    },
  })
}

async function collectSse(stream: ReadableStream<Uint8Array>): Promise<Array<{ event: string; data: Record<string, unknown> }>> {
  const decoder = new TextDecoder()
  const reader = stream.getReader()
  let text = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    text += decoder.decode(value, { stream: true })
  }

  const events: Array<{ event: string; data: Record<string, unknown> }> = []
  const blocks = text.split('\n\n').filter(Boolean)
  for (const block of blocks) {
    const lines = block.split('\n')
    let event = ''
    let data = ''
    for (const line of lines) {
      if (line.startsWith('event: ')) event = line.slice(7)
      if (line.startsWith('data: ')) data = line.slice(6)
    }
    if (event && data) {
      try {
        events.push({ event, data: JSON.parse(data) })
      } catch {
        // skip unparseable
      }
    }
  }
  return events
}

// ─── OpenAI Chat Completions SSE → Anthropic SSE ───────────────

describe('openaiChatStreamToAnthropic', () => {
  test('basic text streaming', async () => {
    const sseChunks = [
      'data: {"id":"c1","object":"chat.completion.chunk","created":0,"model":"gpt-4","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}\n\n',
      'data: {"id":"c1","object":"chat.completion.chunk","created":0,"model":"gpt-4","choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}\n\n',
      'data: {"id":"c1","object":"chat.completion.chunk","created":0,"model":"gpt-4","choices":[{"index":0,"delta":{"content":" world"},"finish_reason":null}]}\n\n',
      'data: {"id":"c1","object":"chat.completion.chunk","created":0,"model":"gpt-4","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
      'data: [DONE]\n\n',
    ]

    const upstream = makeStream(sseChunks)
    const anthropicStream = openaiChatStreamToAnthropic(upstream, 'gpt-4')
    const events = await collectSse(anthropicStream)

    // Should have: message_start, content_block_start, content_block_delta x2, message_delta, content_block_stop, message_stop
    const eventTypes = events.map((e) => e.event)
    expect(eventTypes[0]).toBe('message_start')
    expect(eventTypes).toContain('content_block_start')
    expect(eventTypes).toContain('content_block_delta')
    expect(eventTypes).toContain('message_delta')
    expect(eventTypes).toContain('message_stop')

    // Check message_start
    const msgStart = events.find((e) => e.event === 'message_start')!
    expect((msgStart.data.message as Record<string, unknown>).model).toBe('gpt-4')
    expect((msgStart.data.message as Record<string, unknown>).role).toBe('assistant')

    // Check text deltas
    const textDeltas = events.filter((e) => e.event === 'content_block_delta')
    const texts = textDeltas.map((e) => (e.data.delta as Record<string, unknown>).text)
    expect(texts).toContain('Hello')
    expect(texts).toContain(' world')

    // Check stop reason
    const msgDelta = events.find((e) => e.event === 'message_delta')!
    expect((msgDelta.data.delta as Record<string, unknown>).stop_reason).toBe('end_turn')
  })

  test('tool call streaming', async () => {
    const sseChunks = [
      'data: {"id":"c2","object":"chat.completion.chunk","created":0,"model":"gpt-4","choices":[{"index":0,"delta":{"role":"assistant","content":null},"finish_reason":null}]}\n\n',
      'data: {"id":"c2","object":"chat.completion.chunk","created":0,"model":"gpt-4","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"get_weather","arguments":""}}]},"finish_reason":null}]}\n\n',
      'data: {"id":"c2","object":"chat.completion.chunk","created":0,"model":"gpt-4","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"city\\""}}]},"finish_reason":null}]}\n\n',
      'data: {"id":"c2","object":"chat.completion.chunk","created":0,"model":"gpt-4","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":":\\"NYC\\"}"}}]},"finish_reason":null}]}\n\n',
      'data: {"id":"c2","object":"chat.completion.chunk","created":0,"model":"gpt-4","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n',
      'data: [DONE]\n\n',
    ]

    const upstream = makeStream(sseChunks)
    const anthropicStream = openaiChatStreamToAnthropic(upstream, 'gpt-4')
    const events = await collectSse(anthropicStream)

    // Should have content_block_start with type tool_use
    const toolStart = events.find(
      (e) => e.event === 'content_block_start' && (e.data.content_block as Record<string, unknown>)?.type === 'tool_use',
    )
    expect(toolStart).toBeDefined()
    expect((toolStart!.data.content_block as Record<string, unknown>).name).toBe('get_weather')
    expect((toolStart!.data.content_block as Record<string, unknown>).id).toBe('call_1')

    // Should have input_json_delta
    const jsonDeltas = events.filter(
      (e) => e.event === 'content_block_delta' && (e.data.delta as Record<string, unknown>)?.type === 'input_json_delta',
    )
    expect(jsonDeltas.length).toBeGreaterThan(0)

    // Stop reason should be tool_use
    const msgDelta = events.find((e) => e.event === 'message_delta')!
    expect((msgDelta.data.delta as Record<string, unknown>).stop_reason).toBe('tool_use')
  })

  test('tool call streaming preserves object arguments from local proxies', async () => {
    const sseChunks = [
      'data: {"id":"c-write","object":"chat.completion.chunk","created":0,"model":"gpt-4","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_write","type":"function","function":{"name":"Write","arguments":{"file_path":"/tmp/issue-288.txt","content":"ok"}}}]},"finish_reason":null}]}\n\n',
      'data: {"id":"c-write","object":"chat.completion.chunk","created":0,"model":"gpt-4","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n',
      'data: [DONE]\n\n',
    ]

    const events = await collectSse(openaiChatStreamToAnthropic(makeStream(sseChunks), 'gpt-4'))
    const jsonDeltas = events.filter(
      (e) => e.event === 'content_block_delta' && (e.data.delta as Record<string, unknown>)?.type === 'input_json_delta',
    )
    expect(jsonDeltas).toHaveLength(1)
    expect((jsonDeltas[0].data.delta as Record<string, unknown>).partial_json).toBe(
      '{"file_path":"/tmp/issue-288.txt","content":"ok"}',
    )

    const blockStops = events.filter((e) => e.event === 'content_block_stop')
    expect(blockStops).toHaveLength(1)
    expect(blockStops[0].data.index).toBe(0)
  })

  test('empty stream (just DONE)', async () => {
    const upstream = makeStream(['data: [DONE]\n\n'])
    const anthropicStream = openaiChatStreamToAnthropic(upstream, 'gpt-4')
    const events = await collectSse(anthropicStream)
    // Should at least have message_stop
    expect(events.some((e) => e.event === 'message_stop')).toBe(true)
  })

  test('event ordering: content_block_stop before message_delta', async () => {
    const sseChunks = [
      'data: {"id":"c3","object":"chat.completion.chunk","created":0,"model":"gpt-4","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}\n\n',
      'data: {"id":"c3","object":"chat.completion.chunk","created":0,"model":"gpt-4","choices":[{"index":0,"delta":{"content":"Hi"},"finish_reason":null}]}\n\n',
      'data: {"id":"c3","object":"chat.completion.chunk","created":0,"model":"gpt-4","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
      'data: [DONE]\n\n',
    ]

    const upstream = makeStream(sseChunks)
    const events = await collectSse(openaiChatStreamToAnthropic(upstream, 'gpt-4'))
    const types = events.map((e) => e.event)

    // content_block_stop MUST appear before message_delta
    const stopIdx = types.indexOf('content_block_stop')
    const deltaIdx = types.indexOf('message_delta')
    expect(stopIdx).toBeGreaterThan(-1)
    expect(deltaIdx).toBeGreaterThan(-1)
    expect(stopIdx).toBeLessThan(deltaIdx)

    // message_delta before message_stop
    const msgStopIdx = types.indexOf('message_stop')
    expect(deltaIdx).toBeLessThan(msgStopIdx)
  })

  test('reasoning_content (DeepSeek, OpenRouter, XAI)', async () => {
    const sseChunks = [
      'data: {"id":"c4","object":"chat.completion.chunk","created":0,"model":"deepseek-chat","choices":[{"index":0,"delta":{"role":"assistant","content":"","reasoning_content":"Let me think"},"finish_reason":null}]}\n\n',
      'data: {"id":"c4","object":"chat.completion.chunk","created":0,"model":"deepseek-chat","choices":[{"index":0,"delta":{"reasoning_content":" about this..."},"finish_reason":null}]}\n\n',
      'data: {"id":"c4","object":"chat.completion.chunk","created":0,"model":"deepseek-chat","choices":[{"index":0,"delta":{"content":"Hello!"},"finish_reason":null}]}\n\n',
      'data: {"id":"c4","object":"chat.completion.chunk","created":0,"model":"deepseek-chat","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
      'data: [DONE]\n\n',
    ]

    const upstream = makeStream(sseChunks)
    const events = await collectSse(openaiChatStreamToAnthropic(upstream, 'deepseek-chat'))

    // Should have thinking block
    const thinkingStart = events.find(
      (e) => e.event === 'content_block_start' && (e.data.content_block as Record<string, unknown>)?.type === 'thinking',
    )
    expect(thinkingStart).toBeDefined()

    // Should have thinking deltas
    const thinkingDeltas = events.filter(
      (e) => e.event === 'content_block_delta' && (e.data.delta as Record<string, unknown>)?.type === 'thinking_delta',
    )
    expect(thinkingDeltas.length).toBeGreaterThan(0)

    // Should have text block after thinking
    const textStart = events.find(
      (e) => e.event === 'content_block_start' && (e.data.content_block as Record<string, unknown>)?.type === 'text',
    )
    expect(textStart).toBeDefined()

    // Text should come after thinking in index order
    expect((textStart!.data as Record<string, unknown>).index).toBeGreaterThan(
      (thinkingStart!.data as Record<string, unknown>).index as number,
    )
  })

  test('reasoning field (GLM-5, Cerebras, Groq)', async () => {
    const sseChunks = [
      'data: {"id":"c5","object":"chat.completion.chunk","created":0,"model":"glm-5","choices":[{"index":0,"delta":{"role":"assistant","reasoning":"Thinking here"},"finish_reason":null}]}\n\n',
      'data: {"id":"c5","object":"chat.completion.chunk","created":0,"model":"glm-5","choices":[{"index":0,"delta":{"content":"Result"},"finish_reason":null}]}\n\n',
      'data: {"id":"c5","object":"chat.completion.chunk","created":0,"model":"glm-5","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
      'data: [DONE]\n\n',
    ]

    const upstream = makeStream(sseChunks)
    const events = await collectSse(openaiChatStreamToAnthropic(upstream, 'glm-5'))

    // Should produce thinking delta from "reasoning" field
    const thinkingDeltas = events.filter(
      (e) => e.event === 'content_block_delta' && (e.data.delta as Record<string, unknown>)?.type === 'thinking_delta',
    )
    expect(thinkingDeltas.length).toBe(1)
    expect((thinkingDeltas[0].data.delta as Record<string, unknown>).thinking).toBe('Thinking here')
  })

  test('thinking_blocks (OpenAI o-series)', async () => {
    const sseChunks = [
      'data: {"id":"c6","object":"chat.completion.chunk","created":0,"model":"o3","choices":[{"index":0,"delta":{"role":"assistant","thinking_blocks":[{"type":"thinking","thinking":"Deep thought"}]},"finish_reason":null}]}\n\n',
      'data: {"id":"c6","object":"chat.completion.chunk","created":0,"model":"o3","choices":[{"index":0,"delta":{"content":"Answer"},"finish_reason":null}]}\n\n',
      'data: {"id":"c6","object":"chat.completion.chunk","created":0,"model":"o3","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
      'data: [DONE]\n\n',
    ]

    const upstream = makeStream(sseChunks)
    const events = await collectSse(openaiChatStreamToAnthropic(upstream, 'o3'))

    const thinkingDeltas = events.filter(
      (e) => e.event === 'content_block_delta' && (e.data.delta as Record<string, unknown>)?.type === 'thinking_delta',
    )
    expect(thinkingDeltas.length).toBe(1)
    expect((thinkingDeltas[0].data.delta as Record<string, unknown>).thinking).toBe('Deep thought')
  })

  test('text + tool transition closes text block first', async () => {
    const sseChunks = [
      'data: {"id":"c7","object":"chat.completion.chunk","created":0,"model":"gpt-4","choices":[{"index":0,"delta":{"content":"Let me search"},"finish_reason":null}]}\n\n',
      'data: {"id":"c7","object":"chat.completion.chunk","created":0,"model":"gpt-4","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_x","type":"function","function":{"name":"search","arguments":"{\\"q\\":\\"test\\"}"}}]},"finish_reason":null}]}\n\n',
      'data: {"id":"c7","object":"chat.completion.chunk","created":0,"model":"gpt-4","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n',
      'data: [DONE]\n\n',
    ]

    const upstream = makeStream(sseChunks)
    const events = await collectSse(openaiChatStreamToAnthropic(upstream, 'gpt-4'))
    const types = events.map((e) => e.event)

    // Should see: text block start, text delta, text block stop, tool block start, ...
    const firstBlockStop = types.indexOf('content_block_stop')
    const toolBlockStart = types.findIndex(
      (_, i) => events[i].event === 'content_block_start' && (events[i].data.content_block as Record<string, unknown>)?.type === 'tool_use',
    )
    expect(firstBlockStop).toBeLessThan(toolBlockStart)
  })

  test('maps cached tokens from a trailing usage-only chunk', async () => {
    // stream_options.include_usage delivers usage in a final chunk with empty choices
    const sseChunks = [
      'data: {"id":"c8","object":"chat.completion.chunk","created":0,"model":"gpt-4","choices":[{"index":0,"delta":{"content":"Hi"},"finish_reason":null}]}\n\n',
      'data: {"id":"c8","object":"chat.completion.chunk","created":0,"model":"gpt-4","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
      'data: {"id":"c8","object":"chat.completion.chunk","created":0,"model":"gpt-4","choices":[],"usage":{"prompt_tokens":100,"completion_tokens":7,"prompt_tokens_details":{"cached_tokens":80}}}\n\n',
      'data: [DONE]\n\n',
    ]

    const events = await collectSse(openaiChatStreamToAnthropic(makeStream(sseChunks), 'gpt-4'))
    const msgDelta = events.find((e) => e.event === 'message_delta')!
    expect(msgDelta.data.usage).toEqual({
      input_tokens: 20,
      output_tokens: 7,
      cache_read_input_tokens: 80,
    })
  })

  test('maps cached tokens when usage arrives with finish_reason', async () => {
    const sseChunks = [
      'data: {"id":"c9","object":"chat.completion.chunk","created":0,"model":"gpt-4","choices":[{"index":0,"delta":{"content":"Hi"},"finish_reason":null}]}\n\n',
      'data: {"id":"c9","object":"chat.completion.chunk","created":0,"model":"gpt-4","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":50,"completion_tokens":3,"prompt_tokens_details":{"cached_tokens":40}}}\n\n',
      'data: [DONE]\n\n',
    ]

    const events = await collectSse(openaiChatStreamToAnthropic(makeStream(sseChunks), 'gpt-4'))
    const msgDelta = events.find((e) => e.event === 'message_delta')!
    expect(msgDelta.data.usage).toEqual({
      input_tokens: 10,
      output_tokens: 3,
      cache_read_input_tokens: 40,
    })
  })
})

// ─── OpenAI Responses SSE → Anthropic SSE ──────────────────────

describe('openaiResponsesStreamToAnthropic', () => {
  test('maps reasoning summary deltas to Anthropic thinking blocks', async () => {
    const sseChunks = [
      'event: response.created\ndata: {"sequence_number":0,"type":"response.created","response":{"id":"r-reasoning","model":"grok-4.5","status":"in_progress"}}\n\n',
      'event: response.output_item.added\ndata: {"sequence_number":1,"type":"response.output_item.added","output_index":0,"item":{"id":"rs_1","type":"reasoning","status":"in_progress","summary":[]}}\n\n',
      'event: response.reasoning_summary_part.added\ndata: {"sequence_number":2,"type":"response.reasoning_summary_part.added","item_id":"rs_1","output_index":0,"summary_index":0,"part":{"type":"summary_text","text":""}}\n\n',
      'event: response.reasoning_summary_text.delta\ndata: {"sequence_number":3,"type":"response.reasoning_summary_text.delta","item_id":"rs_1","output_index":0,"summary_index":0,"delta":"Inspecting the repository"}\n\n',
      'event: response.reasoning_summary_text.delta\ndata: {"sequence_number":4,"type":"response.reasoning_summary_text.delta","item_id":"rs_1","output_index":0,"summary_index":0,"delta":" and recent changes."}\n\n',
      'event: response.reasoning_summary_text.done\ndata: {"sequence_number":5,"type":"response.reasoning_summary_text.done","item_id":"rs_1","output_index":0,"summary_index":0,"text":"Inspecting the repository and recent changes."}\n\n',
      'event: response.reasoning_summary_part.done\ndata: {"sequence_number":6,"type":"response.reasoning_summary_part.done","item_id":"rs_1","output_index":0,"summary_index":0,"part":{"type":"summary_text","text":"Inspecting the repository and recent changes."}}\n\n',
      'event: response.output_item.done\ndata: {"sequence_number":7,"type":"response.output_item.done","output_index":0,"item":{"id":"rs_1","type":"reasoning","status":"completed","summary":[],"encrypted_content":"reasoning-signature"}}\n\n',
      'event: response.output_item.added\ndata: {"sequence_number":8,"type":"response.output_item.added","output_index":1,"item":{"id":"msg_1","type":"message","role":"assistant","status":"in_progress","content":[]}}\n\n',
      'event: response.content_part.added\ndata: {"sequence_number":9,"type":"response.content_part.added","item_id":"msg_1","output_index":1,"content_index":0,"part":{"type":"output_text","text":""}}\n\n',
      'event: response.output_text.delta\ndata: {"sequence_number":10,"type":"response.output_text.delta","item_id":"msg_1","output_index":1,"content_index":0,"delta":"Done"}\n\n',
      'event: response.output_text.done\ndata: {"sequence_number":11,"type":"response.output_text.done","item_id":"msg_1","output_index":1,"content_index":0,"text":"Done"}\n\n',
      'event: response.completed\ndata: {"sequence_number":12,"type":"response.completed","response":{"id":"r-reasoning","model":"grok-4.5","status":"completed","usage":{"input_tokens":10,"output_tokens":8}}}\n\n',
    ]

    const events = await collectSse(
      openaiResponsesStreamToAnthropic(makeStream(sseChunks), 'grok-4.5'),
    )
    const thinkingStart = events.find(
      (event) => event.event === 'content_block_start'
        && (event.data.content_block as Record<string, unknown>)?.type === 'thinking',
    )
    const thinkingDeltas = events.filter(
      (event) => event.event === 'content_block_delta'
        && (event.data.delta as Record<string, unknown>)?.type === 'thinking_delta',
    )
    const signatureDelta = events.find(
      (event) => event.event === 'content_block_delta'
        && (event.data.delta as Record<string, unknown>)?.type === 'signature_delta',
    )
    const textStart = events.find(
      (event) => event.event === 'content_block_start'
        && (event.data.content_block as Record<string, unknown>)?.type === 'text',
    )

    expect(thinkingStart).toBeDefined()
    expect(thinkingDeltas.map(
      (event) => (event.data.delta as Record<string, unknown>).thinking,
    )).toEqual(['Inspecting the repository', ' and recent changes.'])
    expect((signatureDelta!.data.delta as Record<string, unknown>).signature).toBe(
      'reasoning-signature',
    )
    expect(textStart).toBeDefined()
    expect(thinkingStart!.data.index).toBeLessThan(textStart!.data.index as number)
    expect(events.filter((event) => event.event === 'content_block_stop')).toHaveLength(2)
  })

  test('maps the Responses reasoning text delta alias', async () => {
    const events = await collectSse(openaiResponsesStreamToAnthropic(makeStream([
      'event: response.created\ndata: {"type":"response.created","response":{"id":"r-reasoning-alias","model":"grok-4.5","status":"in_progress"}}\n\n',
      'event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":0,"item":{"id":"rs_alias","type":"reasoning","status":"in_progress"}}\n\n',
      'event: response.reasoning_text.delta\ndata: {"type":"response.reasoning_text.delta","item_id":"rs_alias","output_index":0,"delta":"Still working"}\n\n',
      'event: response.output_item.done\ndata: {"type":"response.output_item.done","output_index":0,"item":{"id":"rs_alias","type":"reasoning","status":"completed"}}\n\n',
      'event: response.completed\ndata: {"type":"response.completed","response":{"id":"r-reasoning-alias","model":"grok-4.5","status":"completed"}}\n\n',
    ]), 'grok-4.5'))

    const thinkingDelta = events.find(
      (event) => event.event === 'content_block_delta'
        && (event.data.delta as Record<string, unknown>)?.type === 'thinking_delta',
    )
    expect((thinkingDelta!.data.delta as Record<string, unknown>).thinking).toBe('Still working')
  })

  test('basic text streaming', async () => {
    const sseChunks = [
      'event: response.created\ndata: {"id":"r1","model":"gpt-4o","status":"in_progress"}\n\n',
      'event: response.output_item.added\ndata: {"output_index":0,"item":{"type":"message","role":"assistant"}}\n\n',
      'event: response.content_part.added\ndata: {"output_index":0,"content_index":0,"part":{"type":"output_text","text":""}}\n\n',
      'event: response.output_text.delta\ndata: {"output_index":0,"content_index":0,"delta":"Hello"}\n\n',
      'event: response.output_text.delta\ndata: {"output_index":0,"content_index":0,"delta":" world"}\n\n',
      'event: response.output_text.done\ndata: {"output_index":0,"content_index":0,"text":"Hello world"}\n\n',
      'event: response.completed\ndata: {"response":{"id":"r1","model":"gpt-4o","status":"completed","usage":{"input_tokens":10,"output_tokens":5}}}\n\n',
    ]

    const upstream = makeStream(sseChunks)
    const anthropicStream = openaiResponsesStreamToAnthropic(upstream, 'gpt-4o')
    const events = await collectSse(anthropicStream)

    const eventTypes = events.map((e) => e.event)
    expect(eventTypes[0]).toBe('message_start')
    expect(eventTypes).toContain('content_block_start')
    expect(eventTypes).toContain('content_block_delta')
    expect(eventTypes).toContain('content_block_stop')
    expect(eventTypes).toContain('message_delta')
    expect(eventTypes).toContain('message_stop')

    // Check text deltas
    const textDeltas = events.filter((e) => e.event === 'content_block_delta')
    const texts = textDeltas.map((e) => (e.data.delta as Record<string, unknown>).text)
    expect(texts).toContain('Hello')
    expect(texts).toContain(' world')

    const msgDelta = events.find((e) => e.event === 'message_delta')!
    expect(msgDelta.data.usage).toEqual({
      input_tokens: 10,
      output_tokens: 5,
    })
  })

  test('function call streaming', async () => {
    const sseChunks = [
      'event: response.created\ndata: {"id":"r2","model":"gpt-4o","status":"in_progress"}\n\n',
      'event: response.output_item.added\ndata: {"output_index":0,"item":{"type":"function_call","id":"fc_1","call_id":"call_1","name":"search"}}\n\n',
      'event: response.function_call_arguments.delta\ndata: {"item_id":"fc_1","delta":"{\\"q\\":"}\n\n',
      'event: response.function_call_arguments.delta\ndata: {"item_id":"fc_1","delta":"\\"test\\"}"}\n\n',
      'event: response.function_call_arguments.done\ndata: {"item_id":"fc_1","arguments":"{\\"q\\":\\"test\\"}"}\n\n',
      'event: response.completed\ndata: {"response":{"id":"r2","model":"gpt-4o","status":"completed","usage":{"input_tokens":10,"output_tokens":5}}}\n\n',
    ]

    const upstream = makeStream(sseChunks)
    const anthropicStream = openaiResponsesStreamToAnthropic(upstream, 'gpt-4o')
    const events = await collectSse(anthropicStream)

    // Should have tool_use content_block_start
    const toolStart = events.find(
      (e) => e.event === 'content_block_start' && (e.data.content_block as Record<string, unknown>)?.type === 'tool_use',
    )
    expect(toolStart).toBeDefined()
    expect((toolStart!.data.content_block as Record<string, unknown>).name).toBe('search')

    // Should have input_json_delta
    const jsonDeltas = events.filter(
      (e) => e.event === 'content_block_delta' && (e.data.delta as Record<string, unknown>)?.type === 'input_json_delta',
    )
    expect(jsonDeltas.length).toBeGreaterThan(0)

    // Stop reason should be tool_use
    const msgDelta = events.find((e) => e.event === 'message_delta')!
    expect((msgDelta.data.delta as Record<string, unknown>).stop_reason).toBe('tool_use')
  })

  test('maps cached tokens from response.completed usage', async () => {
    const sseChunks = [
      'event: response.created\ndata: {"id":"r3","model":"gpt-5.4","status":"in_progress"}\n\n',
      'event: response.output_item.added\ndata: {"output_index":0,"item":{"type":"message","role":"assistant"}}\n\n',
      'event: response.content_part.added\ndata: {"output_index":0,"content_index":0,"part":{"type":"output_text","text":""}}\n\n',
      'event: response.output_text.delta\ndata: {"output_index":0,"content_index":0,"delta":"Hi"}\n\n',
      'event: response.output_text.done\ndata: {"output_index":0,"content_index":0,"text":"Hi"}\n\n',
      'event: response.completed\ndata: {"response":{"id":"r3","model":"gpt-5.4","status":"completed","usage":{"input_tokens":1200,"output_tokens":40,"input_tokens_details":{"cached_tokens":1000}}}}\n\n',
    ]

    const events = await collectSse(openaiResponsesStreamToAnthropic(makeStream(sseChunks), 'gpt-5.4'))
    const msgDelta = events.find((e) => e.event === 'message_delta')!
    expect(msgDelta.data.usage).toEqual({
      input_tokens: 200,
      output_tokens: 40,
      cache_read_input_tokens: 1000,
    })
  })

  test('OpenAI OAuth mode preserves encrypted reasoning as redacted thinking', async () => {
    const sseChunks = [
      'event: response.created\ndata: {"response":{"id":"r4","model":"gpt-5.6-terra","status":"in_progress"}}\n\n',
      'event: response.output_item.added\ndata: {"output_index":0,"item":{"type":"reasoning","id":"rs_1","summary":[]}}\n\n',
      'event: response.reasoning_summary_part.added\ndata: {"item_id":"rs_1","output_index":0,"summary_index":0,"part":{"type":"summary_text","text":""}}\n\n',
      'event: response.reasoning_summary_text.delta\ndata: {"item_id":"rs_1","output_index":0,"summary_index":0,"delta":"private summary"}\n\n',
      'event: response.output_item.done\ndata: {"output_index":0,"item":{"type":"reasoning","id":"rs_1","summary":[],"encrypted_content":"encrypted-reasoning"}}\n\n',
      'event: response.output_item.added\ndata: {"output_index":1,"item":{"type":"message","role":"assistant"}}\n\n',
      'event: response.content_part.added\ndata: {"output_index":1,"content_index":0,"part":{"type":"output_text","text":""}}\n\n',
      'event: response.output_text.delta\ndata: {"output_index":1,"content_index":0,"delta":"done"}\n\n',
      'event: response.output_text.done\ndata: {"output_index":1,"content_index":0,"text":"done"}\n\n',
      'event: response.completed\ndata: {"response":{"id":"r4","model":"gpt-5.6-terra","status":"completed","usage":{"input_tokens":10,"output_tokens":5}}}\n\n',
    ]

    const events = await collectSse(openaiResponsesStreamToAnthropic(
      makeStream(sseChunks),
      'gpt-5.6-terra',
      { openAICodexOAuth: true },
    ))
    const reasoningStart = events.find((event) =>
      event.event === 'content_block_start' &&
      (event.data.content_block as Record<string, unknown>)?.type === 'redacted_thinking')

    expect(reasoningStart).toBeDefined()
    expect((reasoningStart!.data.content_block as Record<string, unknown>).data).toContain('encrypted-reasoning')
    expect(events.some((event) =>
      event.event === 'content_block_start' &&
      (event.data.content_block as Record<string, unknown>)?.type === 'thinking')).toBe(false)
    expect(events.at(-1)?.event).toBe('message_stop')
  })

  test('OpenAI OAuth mode rejects EOF before response.completed', async () => {
    const incomplete = [
      'event: response.created\ndata: {"response":{"id":"r5","model":"gpt-5.6-terra","status":"in_progress"}}\n\n',
      'event: response.output_item.done\ndata: {"output_index":0,"item":{"type":"reasoning","id":"rs_2","summary":[],"encrypted_content":"still-thinking"}}\n\n',
    ]

    await expect(collectSse(openaiResponsesStreamToAnthropic(
      makeStream(incomplete),
      'gpt-5.6-terra',
      { openAICodexOAuth: true },
    ))).rejects.toThrow('before response.completed')
  })

  test('OpenAI OAuth mode rejects DONE without waiting for socket EOF', async () => {
    const encoder = new TextEncoder()
    const upstream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: [DONE]\n\n'))
      },
    })

    await expect(collectSse(openaiResponsesStreamToAnthropic(
      upstream,
      'gpt-5.6-terra',
      { openAICodexOAuth: true },
    ))).rejects.toThrow('before response.completed')
  })

  test('OpenAI OAuth mode turns response.failed inside HTTP 200 into a retryable stream error', async () => {
    const failed = [
      'event: response.created\ndata: {"response":{"id":"r6","model":"gpt-5.6-terra","status":"in_progress"}}\n\n',
      'event: response.failed\ndata: {"response":{"id":"r6","status":"failed","error":{"code":"rate_limit_exceeded","message":"Too many requests"}}}\n\n',
    ]

    const events = await collectSse(openaiResponsesStreamToAnthropic(
      makeStream(failed),
      'gpt-5.6-terra',
      { openAICodexOAuth: true },
    ))
    const error = events.find((event) => event.event === 'error')

    expect(error?.data).toEqual({
      type: 'error',
      error: { type: 'overloaded_error', message: 'Too many requests' },
    })
    expect(events.some((event) => event.event === 'message_stop')).toBe(false)
  })

  test('OpenAI OAuth mode maps a max-token incomplete response to a clean Anthropic stop', async () => {
    const incomplete = [
      'event: response.created\ndata: {"response":{"id":"r8","model":"gpt-5.6-terra","status":"in_progress"}}\n\n',
      'event: response.incomplete\ndata: {"response":{"id":"r8","status":"incomplete","incomplete_details":{"reason":"max_output_tokens"},"usage":{"input_tokens":12,"output_tokens":64}}}\n\n',
    ]

    const events = await collectSse(openaiResponsesStreamToAnthropic(
      makeStream(incomplete),
      'gpt-5.6-terra',
      { openAICodexOAuth: true },
    ))

    expect(events.find((event) => event.event === 'message_delta')?.data).toMatchObject({
      delta: { stop_reason: 'max_tokens' },
    })
    expect(events.at(-1)?.event).toBe('message_stop')
    expect(events.some((event) => event.event === 'error')).toBe(false)
  })

  test('OpenAI OAuth mode propagates downstream cancellation to the upstream body', async () => {
    const encoder = new TextEncoder()
    let cancelReason: unknown
    const upstream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(
          'event: response.created\ndata: {"response":{"id":"r7","model":"gpt-5.6-terra","status":"in_progress"}}\n\n',
        ))
      },
      cancel(reason) {
        cancelReason = reason
      },
    })
    const reader = openaiResponsesStreamToAnthropic(
      upstream,
      'gpt-5.6-terra',
      { openAICodexOAuth: true },
    ).getReader()

    await reader.read()
    await reader.cancel('user-abort')
    await Promise.resolve()

    expect(cancelReason).toBe('user-abort')
  })

  test('generic mode still accepts a bare DONE sentinel', async () => {
    const events = await collectSse(openaiResponsesStreamToAnthropic(
      makeStream(['data: [DONE]\n\n']),
      'gpt-4o',
    ))

    expect(events.map(event => event.event)).toEqual(['message_start', 'message_stop'])
  })

  test('ignores malformed events and converts refusal deltas', async () => {
    const events = await collectSse(openaiResponsesStreamToAnthropic(
      makeStream([
        'data: not-json\n\n',
        'event: response.created\ndata: {"response":{"id":"r9","model":"gpt-5.6-terra","status":"in_progress"}}\n\n',
        'event: response.content_part.added\ndata: {"output_index":0,"content_index":0,"part":{"type":"refusal","refusal":""}}\n\n',
        'event: response.refusal.delta\ndata: {"output_index":0,"content_index":0,"delta":"cannot comply"}\n\n',
        'event: response.refusal.done\ndata: {"output_index":0,"content_index":0,"refusal":"cannot comply"}\n\n',
        'event: response.completed\ndata: {"response":{"id":"r9","status":"completed"}}\n\n',
      ]),
      'gpt-5.6-terra',
      { openAICodexOAuth: true },
    ))

    expect(events.find(event => event.event === 'content_block_delta')?.data).toMatchObject({
      delta: { type: 'text_delta', text: 'cannot comply' },
    })
  })

  test('OpenAI OAuth mode surfaces non-limit incomplete responses as errors', async () => {
    const events = await collectSse(openaiResponsesStreamToAnthropic(
      makeStream([
        'event: response.incomplete\ndata: {"response":{"status":"incomplete","incomplete_details":{"reason":"content_filter"}}}\n\n',
      ]),
      'gpt-5.6-terra',
      { openAICodexOAuth: true },
    ))

    expect(events).toEqual([{
      event: 'error',
      data: {
        type: 'error',
        error: {
          type: 'api_error',
          message: 'OpenAI response was incomplete: content_filter',
        },
      },
    }])
  })
})

describe('openaiResponsesStreamToAnthropicResponse', () => {
  test('preserves encrypted reasoning from a completed OAuth response', async () => {
    const result = await openaiResponsesStreamToAnthropicResponse(
      makeStream([
        'event: response.completed\ndata: {"response":{"id":"resp_collect","object":"response","created_at":1,"model":"gpt-5.6-terra","status":"completed","output":[{"type":"reasoning","id":"rs_collect","summary":[],"encrypted_content":"opaque-collect"}],"usage":{"input_tokens":3,"output_tokens":2}}}\n\n',
      ]),
      'gpt-5.6-terra',
      { openAICodexOAuth: true },
    )

    expect(result.content).toHaveLength(1)
    expect(result.content[0]).toMatchObject({ type: 'redacted_thinking' })
    if (result.content[0].type === 'redacted_thinking') {
      expect(result.content[0].data).toContain('opaque-collect')
    }
  })

  test('accepts max-token incomplete OAuth responses as normal completion', async () => {
    const result = await openaiResponsesStreamToAnthropicResponse(
      makeStream([
        'event: response.incomplete\ndata: {"response":{"id":"resp_limit","object":"response","created_at":1,"model":"gpt-5.6-terra","status":"incomplete","incomplete_details":{"reason":"max_output_tokens"},"output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"partial"}]}]}}\n\n',
      ]),
      'gpt-5.6-terra',
      { openAICodexOAuth: true },
    )

    expect(result.stop_reason).toBe('max_tokens')
    expect(result.content).toEqual([{ type: 'text', text: 'partial' }])
  })

  test('throws the embedded OAuth failure message', async () => {
    await expect(openaiResponsesStreamToAnthropicResponse(
      makeStream([
        'event: response.failed\ndata: {"response":{"status":"failed","error":{"message":"upstream exploded"}}}\n\n',
      ]),
      'gpt-5.6-terra',
      { openAICodexOAuth: true },
    )).rejects.toThrow('upstream exploded')
  })

  test('describes incomplete OAuth failures without an error object', async () => {
    await expect(openaiResponsesStreamToAnthropicResponse(
      makeStream([
        'event: response.incomplete\ndata: {"response":{"status":"incomplete","incomplete_details":{"reason":"content_filter"}}}\n\n',
      ]),
      'gpt-5.6-terra',
      { openAICodexOAuth: true },
    )).rejects.toThrow('OpenAI response was incomplete: content_filter')
  })

  test('rejects OAuth EOF before a terminal response event', async () => {
    const error = await openaiResponsesStreamToAnthropicResponse(
      makeStream([
        'event: response.created\ndata: {"response":{"id":"resp_eof","status":"in_progress"}}\n\n',
      ]),
      'gpt-5.6-terra',
      { openAICodexOAuth: true },
    ).catch(value => value as Error & { code?: string })

    expect(error.message).toContain('before response.completed')
    expect(error.code).toBe('ERR_STREAM_PREMATURE_CLOSE')
  })
})


describe('OpenAI policy failures', () => {
  for (const code of ['cyber_policy', 'content_policy', 'content_policy_violation']) {
    for (const oauth of [true, false]) {
      test(`preserves ${code} as a terminal permission error (OAuth=${oauth})`, async () => {
        const chunk = `event: response.failed\ndata: ${JSON.stringify({ response: { error: { code, message: 'Request denied' } } })}\n\n`
        const events = await collectSse(openaiResponsesStreamToAnthropic(
          makeStream([chunk]), 'test-model', { openAICodexOAuth: oauth },
        ))
        expect(events.find((event) => event.event === 'error')?.data).toEqual({
          type: 'error', error: { type: 'permission_error', code, message: 'Request denied' },
        })
        expect(events.some((event) => event.event === 'message_stop')).toBe(false)
        await expect(openaiResponsesStreamToAnthropicResponse(
          makeStream([chunk]), 'test-model', { openAICodexOAuth: oauth },
        )).rejects.toMatchObject({ code, type: 'permission_error', status: 403 })
      })
    }
  }
})


test('Chat SSE policy errors stop without a successful completion', async () => {
  const events = await collectSse(openaiChatStreamToAnthropic(makeStream([
    'data: {"error":{"code":"cyber_policy","message":"Request denied"}}\n\n',
    'data: [DONE]\n\n',
  ]), 'test-model'))
  expect(events).toEqual([{ event: 'error', data: {
    type: 'error', error: { type: 'permission_error', code: 'cyber_policy', message: 'Request denied' },
  } }])
})
