import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSandboxedTestEnvironment } from '../../../scripts/pr/test-environment.js'
import { openaiChatStreamToAnthropic } from '../../server/proxy/streaming/openaiChatStreamToAnthropic.js'
import type { AssistantMessage } from '../../types/message.js'

// Mid-stream failures through the real request path: SDK SSE parsing, the
// provider proxy's OpenAI Chat converter, queryModel's retry classification
// and withStreamRetry. One transport retry keeps each case to a single real
// backoff wait; growth and bounds are covered in streamRetry.test.ts.

const originalEnvironment = { ...process.env }
let sandbox: string
let server: ReturnType<typeof Bun.serve>
let responses: Array<() => Response> = []
let requests: Array<{ stream: unknown }> = []
let queryModelWithStreaming: typeof import('./claude.js').queryModelWithStreaming
let createUserMessage: typeof import('../../utils/messages.js').createUserMessage
let asSystemPrompt: typeof import('../../utils/systemPromptType.js').asSystemPrompt
let getEmptyToolPermissionContext: typeof import('../../Tool.js').getEmptyToolPermissionContext
const globals = globalThis as typeof globalThis & { MACRO?: { BUILD_TIME: string } }
const originalMacro = globals.MACRO

beforeAll(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'claude-stream-recovery-'))
  for (const key of Object.keys(process.env)) delete process.env[key]
  Object.assign(process.env, createSandboxedTestEnvironment(sandbox, {
    NODE_ENV: 'production',
    CLAUDE_CODE_SIMPLE: '1',
    ANTHROPIC_API_KEY: 'offline-fixture-key',
    CLAUDE_CODE_MAX_RETRIES: '1',
  }, originalEnvironment))
  server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const body = await request.json() as { stream?: unknown }
    requests.push({ stream: body.stream })
    const next = responses.shift()
    return next ? next() : new Response('unexpected request', { status: 500 })
  } })
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${server.port}`
  globals.MACRO = { BUILD_TIME: '' }
  ;({ queryModelWithStreaming } = await import('./claude.js'))
  ;({ createUserMessage } = await import('../../utils/messages.js'))
  ;({ asSystemPrompt } = await import('../../utils/systemPromptType.js'))
  ;({ getEmptyToolPermissionContext } = await import('../../Tool.js'))
  const { enableConfigs } = await import('../../utils/config.js')
  enableConfigs()
})

afterAll(async () => {
  server?.stop(true)
  for (const key of Object.keys(process.env)) delete process.env[key]
  Object.assign(process.env, originalEnvironment)
  if (originalMacro === undefined) delete globals.MACRO
  else globals.MACRO = originalMacro
  await rm(sandbox, { recursive: true, force: true })
})

const encoder = new TextEncoder()

function sse(events: Array<Record<string, unknown>>): string {
  return events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('')
}

function anthropicStream(events: Array<Record<string, unknown>>, holdOpen = false): () => Response {
  return () => new Response(holdOpen
    ? new ReadableStream({ start(controller) { controller.enqueue(encoder.encode(sse(events))) } })
    : sse(events), { headers: { 'content-type': 'text/event-stream' } })
}

/** An OpenAI Chat upstream piped through the provider proxy's converter. */
function proxiedChatStream(chunks: Array<Record<string, unknown>>, upstreamFailure?: Error): () => Response {
  return () => {
    let index = 0
    const upstream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (index < chunks.length) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunks[index++])}\n\n`))
        } else if (upstreamFailure) {
          controller.error(upstreamFailure)
        } else {
          controller.close()
        }
      },
    })
    return new Response(openaiChatStreamToAnthropic(upstream, 'fixture-model'), {
      headers: { 'content-type': 'text/event-stream' },
    })
  }
}

const messageStart = { type: 'message_start', message: {
  id: 'msg_recovery', type: 'message', role: 'assistant', model: 'fixture-model', content: [],
  stop_reason: null, stop_sequence: null, usage: { input_tokens: 7, output_tokens: 0 },
} }

function textBlock(text: string, index = 0) {
  return [
    { type: 'content_block_start', index, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index, delta: { type: 'text_delta', text } },
    { type: 'content_block_stop', index },
  ]
}

function toolBlock(id: string, index = 0, blockType = 'tool_use') {
  return [
    { type: 'content_block_start', index, content_block: { type: blockType, id, name: blockType === 'tool_use' ? 'Bash' : 'web_search', input: {} } },
    { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: '{"command":"echo fixture"}' } },
    { type: 'content_block_stop', index },
  ]
}

function terminal(reason: string) {
  return [
    { type: 'message_delta', delta: { stop_reason: reason, stop_sequence: null }, usage: { output_tokens: 5 } },
    { type: 'message_stop' },
  ]
}

function errorEvent(type: string, message = 'fixture failure') {
  return { type: 'error', error: { type, message } }
}

const recovered = anthropicStream([messageStart, ...textBlock('recovered'), ...terminal('end_turn')])

function chatText(content: string) {
  return { id: 'chatcmpl-recovery', model: 'fixture-model', choices: [{ index: 0, delta: { content }, finish_reason: null }] }
}

async function run(queued: Array<() => Response>, env: Record<string, string | undefined> = {}) {
  const saved = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]))
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  process.env.CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK ??= '1'
  responses = [...queued]
  requests = []
  // biome-ignore lint/suspicious/noExplicitAny: collects heterogeneous stream messages
  const out: any[] = []
  try {
    for await (const message of queryModelWithStreaming({
      messages: [createUserMessage({ content: 'fixture' })],
      systemPrompt: asSystemPrompt([]), thinkingConfig: { type: 'disabled' }, tools: [],
      signal: new AbortController().signal,
      options: { model: 'fixture-model', querySource: 'insights', agents: [], isNonInteractiveSession: true,
        hasAppendSystemPrompt: false, mcpTools: [], enablePromptCaching: false,
        getToolPermissionContext: async () => getEmptyToolPermissionContext() },
    })) {
      out.push(message)
    }
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    delete process.env.CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK
  }
  const assistants: AssistantMessage[] = out.filter(message => message.type === 'assistant')
  return {
    out,
    assistants,
    replies: assistants.filter(message => !message.isApiErrorMessage),
    errors: assistants.filter(message => message.isApiErrorMessage),
  }
}

function contentOf(messages: AssistantMessage[]): string {
  return JSON.stringify(messages.map(message => message.message.content))
}

// biome-ignore lint/suspicious/noExplicitAny: inspects heterogeneous stream messages
function expectRetriedOnce(out: any[]) {
  expect(out.filter(message => message.type === 'system' && message.subtype === 'streaming_fallback')
    .map(message => message.cause)).toEqual(['stream_retry'])
  const statuses = out.filter(message => message.type === 'system' && message.subtype === 'api_error')
  expect(statuses.map(message => [message.retryAttempt, message.maxRetries])).toEqual([[1, 1]])
  expect(statuses[0].retryInMs).toBeGreaterThanOrEqual(500)
}

test('a proxy stream_truncated event is re-sent and only the retry reaches the transcript', async () => {
  const { out, replies, errors } = await run([
    proxiedChatStream([chatText('partial-attempt')]),
    recovered,
  ])

  expect(requests).toHaveLength(2)
  expectRetriedOnce(out)
  expect(errors).toHaveLength(0)
  expect(replies).toHaveLength(1)
  expect(replies[0]?.message.content).toEqual([{ type: 'text', text: 'recovered' }])
  expect(contentOf(replies)).not.toContain('partial-attempt')
}, 15_000)

test('a proxy stream_error event is re-sent', async () => {
  const { out, replies, errors } = await run([
    proxiedChatStream([chatText('partial-attempt')], Object.assign(new Error('upstream reset'), { code: 'ECONNRESET' })),
    recovered,
  ])

  expect(requests).toHaveLength(2)
  expectRetriedOnce(out)
  expect(errors).toHaveLength(0)
  expect(contentOf(replies)).toBe(JSON.stringify([[{ type: 'text', text: 'recovered' }]]))
}, 15_000)

test('a clean EOF before message_stop is re-sent without committing the first attempt', async () => {
  const { out, replies, errors } = await run([
    anthropicStream([messageStart, ...textBlock('partial-attempt')]),
    recovered,
  ])

  expect(requests).toHaveLength(2)
  expectRetriedOnce(out)
  expect(errors).toHaveLength(0)
  expect(contentOf(replies)).toBe(JSON.stringify([[{ type: 'text', text: 'recovered' }]]))
}, 15_000)

test('an empty stream is re-sent when the non-streaming fallback is disabled', async () => {
  const { out, replies, errors } = await run([anthropicStream([]), recovered])

  expect(requests).toHaveLength(2)
  expectRetriedOnce(out)
  expect(errors).toHaveLength(0)
  expect(replies).toHaveLength(1)
}, 15_000)

test('a completed but uncommitted tool call is re-sent and released only once', async () => {
  const { replies, errors } = await run([
    anthropicStream([messageStart, ...toolBlock('toolu_first')]),
    anthropicStream([messageStart, ...toolBlock('toolu_second'), ...terminal('tool_use')]),
  ])

  expect(requests).toHaveLength(2)
  expect(errors).toHaveLength(0)
  const toolIds = replies.flatMap(message => message.message.content)
    .flatMap(block => block.type === 'tool_use' ? [block.id] : [])
  expect(toolIds).toEqual(['toolu_second'])
}, 15_000)

test('a proxied tool call cut off after finish_reason is re-sent, never released twice', async () => {
  const toolCall = {
    id: 'chatcmpl-tool', model: 'fixture-model', choices: [{ index: 0, delta: { tool_calls: [{
      index: 0, id: 'call_first', type: 'function',
      function: { name: 'Bash', arguments: '{"command":"echo fixture"}' },
    }] }, finish_reason: null }],
  }
  const finished = { id: 'chatcmpl-tool', model: 'fixture-model', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }
  const { out, replies, errors } = await run([
    // The converter has already closed the tool block when the upstream dies.
    proxiedChatStream([toolCall, finished], Object.assign(new Error('upstream reset'), { code: 'ECONNRESET' })),
    anthropicStream([messageStart, ...toolBlock('toolu_second'), ...terminal('tool_use')]),
  ])

  expect(out.some(message => message.type === 'stream_event'
    && message.event.type === 'content_block_stop')).toBe(true)
  expect(requests).toHaveLength(2)
  expect(errors).toHaveLength(0)
  const toolIds = replies.flatMap(message => message.message.content)
    .flatMap(block => block.type === 'tool_use' ? [block.id] : [])
  expect(toolIds).toEqual(['toolu_second'])
}, 15_000)

test('an idle stall after a completed tool block is re-sent on the watchdog budget', async () => {
  const { out, replies, errors } = await run([
    anthropicStream([messageStart, ...toolBlock('toolu_first')], true),
    anthropicStream([messageStart, ...toolBlock('toolu_second'), ...terminal('tool_use')]),
  ], {
    CLAUDE_ENABLE_STREAM_WATCHDOG: '1',
    CLAUDE_STREAM_IDLE_TIMEOUT_MS: '300',
    CLAUDE_STREAM_FIRST_TOKEN_TIMEOUT_MS: '300',
  })

  expect(requests).toHaveLength(2)
  expect(errors).toHaveLength(0)
  const statuses = out.filter(message => message.type === 'system' && message.subtype === 'api_error')
  expect(statuses.map(message => message.maxRetries)).toEqual([2])
  const toolIds = replies.flatMap(message => message.message.content)
    .flatMap(block => block.type === 'tool_use' ? [block.id] : [])
  expect(toolIds).toEqual(['toolu_second'])
}, 15_000)

test('retries are bounded, then the original error surfaces with the last attempt\'s text once', async () => {
  const truncatedAfterText = anthropicStream([
    messageStart,
    ...textBlock('kept-once'),
    errorEvent('stream_truncated', 'OpenAI Chat upstream stream ended without finish_reason'),
  ])
  const { replies, errors } = await run([truncatedAfterText, truncatedAfterText])

  expect(requests).toHaveLength(2)
  expect(contentOf(replies)).toBe(JSON.stringify([[{ type: 'text', text: 'kept-once' }]]))
  expect(errors).toHaveLength(1)
  expect(contentOf(errors)).toContain('ended without finish_reason')
}, 15_000)

test('a clean EOF that persists through every retry names the upstream and the retries spent', async () => {
  const cutMidText = anthropicStream([messageStart, ...textBlock('cut-attempt').slice(0, 2)])
  const { errors } = await run([cutMidText, cutMidText])

  expect(requests).toHaveLength(2)
  expect(errors).toHaveLength(1)
  expect(errors[0]?.businessErrorCode).toBe('upstream_stream_interrupted')
  expect(contentOf(errors)).toContain('The upstream model provider closed the stream')
  expect(contentOf(errors)).toContain('retried 1 time · 3 events · last content_block_delta')
  expect(JSON.parse(errors[0]!.errorDetails!)).toMatchObject({ reason: 'incomplete', retries: 1, openBlockCount: 1 })
}, 15_000)

for (const type of ['invalid_request_error', 'authentication_error', 'permission_error', 'billing_error']) {
  test(`a mid-stream ${type} is not retried`, async () => {
    const { errors } = await run([
      anthropicStream([messageStart, errorEvent(type)]),
      recovered,
    ])

    expect(requests).toHaveLength(1)
    expect(errors).toHaveLength(1)
  })
}

test('server-side tool activity is never replayed', async () => {
  const { errors } = await run([
    anthropicStream([messageStart, ...toolBlock('srvtoolu_first', 0, 'server_tool_use').slice(0, 2),
      errorEvent('stream_truncated')]),
    recovered,
  ])

  expect(requests).toHaveLength(1)
  expect(errors).toHaveLength(1)
})

test('an attempt that already committed output is never replayed', async () => {
  const { assistants } = await run([
    anthropicStream([
      messageStart,
      ...textBlock('committed'),
      { type: 'message_delta', delta: { stop_reason: 'refusal', stop_sequence: null }, usage: { output_tokens: 5 } },
      errorEvent('stream_truncated'),
    ]),
    recovered,
  ])

  expect(requests).toHaveLength(1)
  expect(contentOf(assistants).match(/committed/g)).toHaveLength(1)
  expect(contentOf(assistants)).not.toContain('recovered')
})

test('with the non-streaming fallback available, a proxy truncation still goes to it', async () => {
  const fallbackReply = () => Response.json({
    id: 'msg_fallback', type: 'message', role: 'assistant', model: 'fixture-model',
    content: [{ type: 'text', text: 'fallback' }], stop_reason: 'end_turn', stop_sequence: null,
    usage: { input_tokens: 7, output_tokens: 1 },
  })
  const { out, replies } = await run([
    proxiedChatStream([chatText('partial-attempt')]),
    fallbackReply,
  ], { CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK: '0' })

  expect(requests.map(request => request.stream === true)).toEqual([true, false])
  expect(out.some(message => message.subtype === 'streaming_fallback' && message.cause === 'stream_retry')).toBe(false)
  expect(contentOf(replies)).toBe(JSON.stringify([[{ type: 'text', text: 'fallback' }]]))
}, 15_000)

test('with the non-streaming fallback available, a response cut off mid-way is re-streamed', async () => {
  const { out, replies, errors } = await run([
    anthropicStream([messageStart, ...textBlock('partial-attempt')]),
    recovered,
  ], { CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK: '0' })

  expect(requests.map(request => request.stream === true)).toEqual([true, true])
  expectRetriedOnce(out)
  expect(errors).toHaveLength(0)
  expect(contentOf(replies)).toBe(JSON.stringify([[{ type: 'text', text: 'recovered' }]]))
}, 15_000)
