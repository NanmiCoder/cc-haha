import { describe, expect, it } from 'vitest'
import { parseTraceRequestBody, parseTraceResponseBody } from './requestParse'

const anthropicRequest = {
  model: 'claude-sonnet-4-5',
  max_tokens: 4096,
  temperature: 0.7,
  stream: true,
  system: 'You are helpful.',
  messages: [
    { role: 'user', content: 'hello' },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'hi' },
        { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls' } },
      ],
    },
    {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'toolu_1', content: 'total 8', is_error: false },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAA' } },
      ],
    },
  ],
  tools: [{ name: 'Bash', description: 'Run a command', input_schema: { type: 'object' } }],
}

const anthropicResponse = {
  id: 'msg_1',
  type: 'message',
  role: 'assistant',
  model: 'claude-sonnet-4-5',
  content: [{ type: 'text', text: 'done' }],
  stop_reason: 'end_turn',
  usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 2 },
}

describe('parseTraceRequestBody', () => {
  it('parses an anthropic request into normalized messages, tools and params', () => {
    const parsed = parseTraceRequestBody(JSON.stringify(anthropicRequest), 'anthropic')

    expect(parsed).not.toBeNull()
    expect(parsed?.model).toBe('claude-sonnet-4-5')
    expect(parsed?.system).toBe('You are helpful.')
    expect(parsed?.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'hello' }] },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'hi' },
          { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls' } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', toolUseId: 'toolu_1', content: 'total 8' },
          { type: 'image', mediaType: 'image/png', dataUrl: 'data:image/png;base64,AAA' },
        ],
      },
    ])
    expect(parsed?.tools).toEqual([{ name: 'Bash', description: 'Run a command', schema: { type: 'object' } }])
    expect(parsed?.params).toEqual({ max_tokens: 4096, temperature: 0.7, stream: true })
  })

  it('unwraps the proxy {anthropic, upstream} envelope', () => {
    const wrapped = JSON.stringify({ anthropic: anthropicRequest, upstream: { model: 'gpt-4o', messages: [] } })
    const parsed = parseTraceRequestBody(wrapped, 'proxy')

    expect(parsed?.model).toBe('claude-sonnet-4-5')
    expect(parsed?.messages).toHaveLength(3)
  })

  it('joins system content block arrays into plain text', () => {
    const body = JSON.stringify({
      model: 'claude-sonnet-4-5',
      system: [
        { type: 'text', text: 'Part A' },
        { type: 'text', text: 'Part B' },
      ],
      messages: [],
    })
    expect(parseTraceRequestBody(body, 'anthropic')?.system).toBe('Part A\n\nPart B')
  })

  it('marks tool_result errors and keeps unknown blocks visible as text', () => {
    const body = JSON.stringify({
      messages: [
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'toolu_9', content: 'boom', is_error: true },
            { type: 'server_tool_use', id: 'srvtoolu_1' },
          ],
        },
      ],
    })
    const parsed = parseTraceRequestBody(body, 'anthropic')
    expect(parsed?.messages[0]?.content).toEqual([
      { type: 'tool_result', toolUseId: 'toolu_9', content: 'boom', isError: true },
      { type: 'text', text: '{"type":"server_tool_use","id":"srvtoolu_1"}' },
    ])
  })

  it('returns null for truncated json', () => {
    const full = JSON.stringify(anthropicRequest)
    expect(parseTraceRequestBody(full.slice(0, full.length - 20), 'anthropic')).toBeNull()
    expect(parseTraceRequestBody('', 'anthropic')).toBeNull()
    expect(parseTraceRequestBody('not json', 'proxy')).toBeNull()
  })
})

describe('parseTraceResponseBody', () => {
  it('parses an anthropic json message response', () => {
    const parsed = parseTraceResponseBody(JSON.stringify(anthropicResponse), 'anthropic')

    expect(parsed).toEqual({
      kind: 'json',
      message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
      usage: { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 2 },
      stopReason: 'end_turn',
      model: 'claude-sonnet-4-5',
    })
  })

  it('unwraps the proxy {upstream, anthropic} response envelope', () => {
    const wrapped = JSON.stringify({
      upstream: { id: 'chatcmpl-1', object: 'chat.completion', choices: [] },
      anthropic: anthropicResponse,
    })
    const parsed = parseTraceResponseBody(wrapped, 'proxy')

    expect(parsed?.kind).toBe('json')
    expect(parsed?.message?.content).toEqual([{ type: 'text', text: 'done' }])
    expect(parsed?.usage?.inputTokens).toBe(10)
  })

  it('detects sse responses and reassembles the stream', () => {
    const stream = [
      'event: message_start',
      `data: ${JSON.stringify({ type: 'message_start', message: { role: 'assistant', model: 'claude-sonnet-4-5', content: [], usage: { input_tokens: 4, output_tokens: 1 } } })}`,
      '',
      'event: content_block_start',
      `data: ${JSON.stringify({ index: 0, content_block: { type: 'text', text: '' } })}`,
      '',
      'event: content_block_delta',
      `data: ${JSON.stringify({ index: 0, delta: { type: 'text_delta', text: 'streamed' } })}`,
      '',
      'event: message_delta',
      `data: ${JSON.stringify({ delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 6 } })}`,
      '',
    ].join('\n')

    const parsed = parseTraceResponseBody(stream, 'anthropic')
    expect(parsed?.kind).toBe('sse')
    expect(parsed?.message?.content).toEqual([{ type: 'text', text: 'streamed' }])
    expect(parsed?.usage).toEqual({ inputTokens: 4, outputTokens: 6 })
    expect(parsed?.stopReason).toBe('end_turn')
  })

  it('normalizes an openai chat completion json response', () => {
    const body = JSON.stringify({
      id: 'chatcmpl-2',
      object: 'chat.completion',
      model: 'gpt-4o',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: 'sure',
            tool_calls: [{ id: 'call_9', type: 'function', function: { name: 'Bash', arguments: '{"command":"pwd"}' } }],
          },
          finish_reason: 'tool_calls',
        },
      ],
      usage: { prompt_tokens: 30, completion_tokens: 12 },
    })

    const parsed = parseTraceResponseBody(body, 'anthropic')
    expect(parsed?.kind).toBe('json')
    expect(parsed?.message?.content).toEqual([
      { type: 'text', text: 'sure' },
      { type: 'tool_use', id: 'call_9', name: 'Bash', input: { command: 'pwd' } },
    ])
    expect(parsed?.usage).toEqual({ inputTokens: 30, outputTokens: 12 })
    expect(parsed?.stopReason).toBe('tool_calls')
    expect(parsed?.model).toBe('gpt-4o')
  })

  it('keeps non-message json visible without a normalized message', () => {
    const parsed = parseTraceResponseBody(JSON.stringify({ type: 'error', error: { message: 'overloaded' } }), 'anthropic')
    expect(parsed).toEqual({ kind: 'json', message: null, usage: null })
  })

  it('returns null for truncated or empty payloads', () => {
    const full = JSON.stringify(anthropicResponse)
    expect(parseTraceResponseBody(full.slice(0, full.length - 8), 'anthropic')).toBeNull()
    expect(parseTraceResponseBody('', 'anthropic')).toBeNull()
    expect(parseTraceResponseBody('   ', 'proxy')).toBeNull()
  })
})
