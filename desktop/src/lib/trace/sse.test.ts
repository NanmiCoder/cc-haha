import { describe, expect, it } from 'vitest'
import { looksLikeSseText, reassembleSseText } from './sse'

function sse(frames: Array<{ event?: string; data: string }>): string {
  return frames
    .map((frame) => (frame.event ? `event: ${frame.event}\ndata: ${frame.data}\n` : `data: ${frame.data}\n`))
    .join('\n') + '\n'
}

const anthropicTextStream = sse([
  {
    event: 'message_start',
    data: JSON.stringify({
      type: 'message_start',
      message: {
        id: 'msg_01',
        type: 'message',
        role: 'assistant',
        model: 'claude-sonnet-4-5',
        content: [],
        stop_reason: null,
        usage: { input_tokens: 25, output_tokens: 1, cache_read_input_tokens: 7, cache_creation_input_tokens: 3 },
      },
    }),
  },
  { event: 'content_block_start', data: JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }) },
  { event: 'content_block_delta', data: JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello' } }) },
  { event: 'content_block_delta', data: JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ' world' } }) },
  { event: 'content_block_stop', data: JSON.stringify({ type: 'content_block_stop', index: 0 }) },
  { event: 'message_delta', data: JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 42 } }) },
  { event: 'message_stop', data: JSON.stringify({ type: 'message_stop' }) },
])

describe('looksLikeSseText', () => {
  it('detects event and data prefixed streams', () => {
    expect(looksLikeSseText('event: message_start\ndata: {}\n')).toBe(true)
    expect(looksLikeSseText('\n\ndata: {"choices":[]}\n')).toBe(true)
    expect(looksLikeSseText('{"type":"message"}')).toBe(false)
    expect(looksLikeSseText('plain text')).toBe(false)
    expect(looksLikeSseText('')).toBe(false)
  })
})

describe('reassembleSseText', () => {
  it('rebuilds a full anthropic text stream with merged usage', () => {
    const result = reassembleSseText(anthropicTextStream)
    expect(result).not.toBeNull()
    expect(result?.message).toEqual({
      role: 'assistant',
      content: [{ type: 'text', text: 'Hello world' }],
    })
    expect(result?.usage).toEqual({
      inputTokens: 25,
      outputTokens: 42,
      cacheReadInputTokens: 7,
      cacheCreationInputTokens: 3,
    })
    expect(result?.stopReason).toBe('end_turn')
    expect(result?.model).toBe('claude-sonnet-4-5')
  })

  it('accumulates input_json_delta and parses tool input on content_block_stop', () => {
    const stream = sse([
      {
        event: 'message_start',
        data: JSON.stringify({
          type: 'message_start',
          message: { role: 'assistant', model: 'claude-sonnet-4-5', content: [], usage: { input_tokens: 10, output_tokens: 1 } },
        }),
      },
      { event: 'content_block_start', data: JSON.stringify({ index: 0, content_block: { type: 'text', text: '' } }) },
      { event: 'content_block_delta', data: JSON.stringify({ index: 0, delta: { type: 'text_delta', text: 'Checking.' } }) },
      { event: 'content_block_stop', data: JSON.stringify({ index: 0 }) },
      { event: 'content_block_start', data: JSON.stringify({ index: 1, content_block: { type: 'tool_use', id: 'toolu_01', name: 'Bash', input: {} } }) },
      { event: 'content_block_delta', data: JSON.stringify({ index: 1, delta: { type: 'input_json_delta', partial_json: '{"comm' } }) },
      { event: 'content_block_delta', data: JSON.stringify({ index: 1, delta: { type: 'input_json_delta', partial_json: 'and":"ls"}' } }) },
      { event: 'content_block_stop', data: JSON.stringify({ index: 1 }) },
      { event: 'message_delta', data: JSON.stringify({ delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 9 } }) },
    ])

    const result = reassembleSseText(stream)
    expect(result?.message?.content).toEqual([
      { type: 'text', text: 'Checking.' },
      { type: 'tool_use', id: 'toolu_01', name: 'Bash', input: { command: 'ls' } },
    ])
    expect(result?.stopReason).toBe('tool_use')
    expect(result?.usage).toEqual({ inputTokens: 10, outputTokens: 9 })
  })

  it('accumulates thinking deltas', () => {
    const stream = sse([
      {
        event: 'message_start',
        data: JSON.stringify({ type: 'message_start', message: { role: 'assistant', content: [], usage: { input_tokens: 5, output_tokens: 1 } } }),
      },
      { event: 'content_block_start', data: JSON.stringify({ index: 0, content_block: { type: 'thinking', thinking: '' } }) },
      { event: 'content_block_delta', data: JSON.stringify({ index: 0, delta: { type: 'thinking_delta', thinking: 'Let me ' } }) },
      { event: 'content_block_delta', data: JSON.stringify({ index: 0, delta: { type: 'thinking_delta', thinking: 'reason.' } }) },
      { event: 'content_block_stop', data: JSON.stringify({ index: 0 }) },
    ])

    const result = reassembleSseText(stream)
    expect(result?.message?.content).toEqual([{ type: 'thinking', thinking: 'Let me reason.' }])
  })

  it('tolerates a truncated trailing frame without throwing', () => {
    const truncated = anthropicTextStream.slice(0, anthropicTextStream.indexOf(' world') + 2)
    const result = reassembleSseText(truncated)
    expect(result).not.toBeNull()
    expect(result?.message?.content).toEqual([{ type: 'text', text: 'Hello' }])
  })

  it('keeps the initial tool input when the stream truncates before content_block_stop', () => {
    const stream = [
      'event: message_start',
      `data: ${JSON.stringify({ type: 'message_start', message: { role: 'assistant', content: [] } })}`,
      '',
      'event: content_block_start',
      `data: ${JSON.stringify({ index: 0, content_block: { type: 'tool_use', id: 'toolu_02', name: 'Read', input: {} } })}`,
      '',
      'event: content_block_delta',
      `data: ${JSON.stringify({ index: 0, delta: { type: 'input_json_delta', partial_json: '{"file_path":"/tm' } })}`,
      '',
    ].join('\n')

    const result = reassembleSseText(stream)
    expect(result?.message?.content).toEqual([{ type: 'tool_use', id: 'toolu_02', name: 'Read', input: {} }])
  })

  it('rebuilds an openai chat completions stream into an anthropic-shaped message', () => {
    const chunk = (payload: Record<string, unknown>) => JSON.stringify({ id: 'chatcmpl-1', object: 'chat.completion.chunk', model: 'gpt-4o', ...payload })
    const stream = sse([
      { data: chunk({ choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] }) },
      { data: chunk({ choices: [{ index: 0, delta: { content: 'Hel' }, finish_reason: null }] }) },
      { data: chunk({ choices: [{ index: 0, delta: { content: 'lo' }, finish_reason: null }] }) },
      { data: chunk({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '' } }] }, finish_reason: null }] }) },
      { data: chunk({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"city":' } }] }, finish_reason: null }] }) },
      { data: chunk({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"SF"}' } }] }, finish_reason: null }] }) },
      { data: chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }) },
      { data: chunk({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 60 } } }) },
      { data: '[DONE]' },
    ])

    const result = reassembleSseText(stream)
    expect(result?.message?.content).toEqual([
      { type: 'text', text: 'Hello' },
      { type: 'tool_use', id: 'call_1', name: 'get_weather', input: { city: 'SF' } },
    ])
    expect(result?.usage).toEqual({ inputTokens: 100, outputTokens: 20, cacheReadInputTokens: 60 })
    expect(result?.stopReason).toBe('tool_calls')
    expect(result?.model).toBe('gpt-4o')
  })

  it('mirrors openai reasoning_content into a leading thinking block', () => {
    const stream = sse([
      { data: JSON.stringify({ id: 'c1', model: 'deepseek-r1', choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: 'pondering' }, finish_reason: null }] }) },
      { data: JSON.stringify({ id: 'c1', choices: [{ index: 0, delta: { content: 'answer' }, finish_reason: 'stop' }] }) },
      { data: '[DONE]' },
    ])

    const result = reassembleSseText(stream)
    expect(result?.message?.content).toEqual([
      { type: 'thinking', thinking: 'pondering' },
      { type: 'text', text: 'answer' },
    ])
    expect(result?.stopReason).toBe('stop')
  })

  it('returns null for non-SSE input', () => {
    expect(reassembleSseText('{"type":"message","content":[]}')).toBeNull()
    expect(reassembleSseText('plain text response')).toBeNull()
    expect(reassembleSseText('')).toBeNull()
  })

  it('returns null when no snapshot can be reconstructed', () => {
    expect(reassembleSseText('event: ping\ndata: {}\n\n')).toBeNull()
    expect(reassembleSseText('data: [DONE]\n\n')).toBeNull()
    expect(reassembleSseText('data: {broken json\n\n')).toBeNull()
  })
})
