import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSandboxedTestEnvironment } from '../../../scripts/pr/test-environment.js'
import type { AssistantMessage } from '../../types/message.js'

const originalEnvironment = { ...process.env }
let sandbox: string
let server: ReturnType<typeof Bun.serve>
let handler: (req: Request) => Response | Promise<Response>
let requestCount = 0
let queryModelWithStreaming: typeof import('./claude.js').queryModelWithStreaming
let createUserMessage: typeof import('../../utils/messages.js').createUserMessage
let asSystemPrompt: typeof import('../../utils/systemPromptType.js').asSystemPrompt
let getEmptyToolPermissionContext: typeof import('../../Tool.js').getEmptyToolPermissionContext
const globals = globalThis as typeof globalThis & { MACRO?: { BUILD_TIME: string } }
const originalMacro = globals.MACRO

beforeAll(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'claude-missing-role-1993-'))
  for (const key of Object.keys(process.env)) delete process.env[key]
  Object.assign(process.env, createSandboxedTestEnvironment(sandbox, {
    NODE_ENV: 'production',
    ANTHROPIC_API_KEY: 'offline-fixture-key',
  }, originalEnvironment))
  handler = () => new Response('unconfigured', { status: 500 })
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(req) {
      requestCount++
      return handler(req)
    },
  })
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

function sseEncode(events: Array<Record<string, unknown>>): string {
  return events.map(event => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`).join('')
}

test('Issue #1993 write-path (content_block_stop): streaming message_start omitting role still yields assistant messages with message.role="assistant"', async () => {
  const model = 'qwen3.5-27b-uncensored'
  // Mimics vLLM Anthropic-compatible streaming response serialized with exclude_unset=True
  const events: Array<Record<string, unknown>> = [
    {
      type: 'message_start',
      message: {
        id: 'chatcmpl-96b23cb0ee3c414e',
        type: 'message',
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 12, output_tokens: 0 },
      },
    },
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Let me think.' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig_fixture' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Final answer.' } },
    { type: 'content_block_stop', index: 1 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 10 } },
    { type: 'message_stop' },
  ]

  requestCount = 0
  handler = () => new Response(sseEncode(events), { headers: { 'content-type': 'text/event-stream' } })

  const assistants: AssistantMessage[] = []
  for await (const message of queryModelWithStreaming({
    messages: [createUserMessage({ content: 'hello' })],
    systemPrompt: asSystemPrompt([]),
    thinkingConfig: { type: 'disabled' },
    tools: [],
    signal: new AbortController().signal,
    options: {
      model,
      querySource: 'insights',
      agents: [],
      isNonInteractiveSession: true,
      hasAppendSystemPrompt: false,
      mcpTools: [],
      enablePromptCaching: false,
      getToolPermissionContext: async () => getEmptyToolPermissionContext(),
    },
  })) {
    if (message.type === 'assistant') {
      assistants.push(message)
    }
  }

  expect(requestCount).toBe(1)
  expect(assistants).toHaveLength(2)
  for (const assistant of assistants) {
    expect(assistant.type).toBe('assistant')
    expect(assistant.message.role).toBe('assistant')
  }
})

test('Issue #1993 write-path (preservePartialText): aborted stream after message_start without role preserves message.role="assistant"', async () => {
  const model = 'qwen3.5-27b-uncensored'
  const controller = new AbortController()
  const encoder = new TextEncoder()

  requestCount = 0
  handler = () => new Response(new ReadableStream({
    start(streamController) {
      streamController.enqueue(encoder.encode(sseEncode([
        {
          type: 'message_start',
          message: {
            id: 'chatcmpl-abort-missing-role',
            type: 'message',
            model,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 8, output_tokens: 0 },
          },
        },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Partial answer before stop' } },
      ])))
    },
  }), { headers: { 'content-type': 'text/event-stream' } })

  const assistants: AssistantMessage[] = []
  try {
    for await (const message of queryModelWithStreaming({
      messages: [createUserMessage({ content: 'hello' })],
      systemPrompt: asSystemPrompt([]),
      thinkingConfig: { type: 'disabled' },
      tools: [],
      signal: controller.signal,
      options: {
        model,
        querySource: 'insights',
        agents: [],
        isNonInteractiveSession: true,
        hasAppendSystemPrompt: false,
        mcpTools: [],
        enablePromptCaching: false,
        getToolPermissionContext: async () => getEmptyToolPermissionContext(),
      },
    })) {
      if (message.type === 'stream_event' && message.event.type === 'content_block_delta') {
        controller.abort()
      }
      if (message.type === 'assistant') {
        assistants.push(message)
      }
    }
  } catch {
    // Expected APIUserAbortError after preserving partial text
  }

  expect(requestCount).toBe(1)
  expect(assistants).toHaveLength(1)
  expect(assistants[0]?.message.role).toBe('assistant')
})

test('Issue #1993 write-path (commitFallbackResponse): non-streaming fallback response omitting role still yields message.role="assistant"', async () => {
  const model = 'qwen3.5-27b-uncensored'
  requestCount = 0
  handler = async (req) => {
    const body = await req.json() as { stream?: boolean }
    if (body.stream === true) {
      return new Response(JSON.stringify({
        type: 'error',
        error: { type: 'not_found_error', message: 'streaming endpoint unavailable' },
      }), { status: 404, headers: { 'content-type': 'application/json' } })
    }
    return new Response(JSON.stringify({
      id: 'chatcmpl-fallback-missing-role',
      type: 'message',
      model,
      content: [{ type: 'text', text: 'Non-streaming fallback reply' }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 6 },
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  }

  const assistants: AssistantMessage[] = []
  for await (const message of queryModelWithStreaming({
    messages: [createUserMessage({ content: 'hello' })],
    systemPrompt: asSystemPrompt([]),
    thinkingConfig: { type: 'disabled' },
    tools: [],
    signal: new AbortController().signal,
    options: {
      model,
      querySource: 'insights',
      agents: [],
      isNonInteractiveSession: true,
      hasAppendSystemPrompt: false,
      mcpTools: [],
      enablePromptCaching: false,
      getToolPermissionContext: async () => getEmptyToolPermissionContext(),
    },
  })) {
    if (message.type === 'assistant') {
      assistants.push(message)
    }
  }

  expect(requestCount).toBe(2)
  expect(assistants).toHaveLength(1)
  expect(assistants[0]?.message.role).toBe('assistant')
})

test('Issue #1993 write-path normalization: blank, padded, and non-string roles normalize to "assistant" on streaming and fallback paths', async () => {
  const model = 'qwen3.5-27b-uncensored'
  const malformedRoles: unknown[] = ['   ', ' assistant ', 123, { bad: true }]

  for (const [idx, rawRole] of malformedRoles.entries()) {
    const events: Array<Record<string, unknown>> = [
      {
        type: 'message_start',
        message: {
          id: `chatcmpl-malformed-stream-${idx}`,
          type: 'message',
          role: rawRole,
          model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 5, output_tokens: 0 },
        },
      },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: `Reply ${idx}` } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 4 } },
      { type: 'message_stop' },
    ]

    requestCount = 0
    handler = () => new Response(sseEncode(events), { headers: { 'content-type': 'text/event-stream' } })

    const streamAssistants: AssistantMessage[] = []
    for await (const message of queryModelWithStreaming({
      messages: [createUserMessage({ content: 'hello' })],
      systemPrompt: asSystemPrompt([]),
      thinkingConfig: { type: 'disabled' },
      tools: [],
      signal: new AbortController().signal,
      options: {
        model,
        querySource: 'insights',
        agents: [],
        isNonInteractiveSession: true,
        hasAppendSystemPrompt: false,
        mcpTools: [],
        enablePromptCaching: false,
        getToolPermissionContext: async () => getEmptyToolPermissionContext(),
      },
    })) {
      if (message.type === 'assistant') {
        streamAssistants.push(message)
      }
    }

    expect(streamAssistants).toHaveLength(1)
    expect(streamAssistants[0]?.message.role).toBe('assistant')

    // Non-streaming fallback with the same malformed role
    requestCount = 0
    handler = async (req) => {
      const body = await req.json() as { stream?: boolean }
      if (body.stream === true) {
        return new Response(JSON.stringify({
          type: 'error',
          error: { type: 'not_found_error', message: 'streaming endpoint unavailable' },
        }), { status: 404, headers: { 'content-type': 'application/json' } })
      }
      return new Response(JSON.stringify({
        id: `chatcmpl-malformed-fallback-${idx}`,
        type: 'message',
        role: rawRole,
        model,
        content: [{ type: 'text', text: `Fallback ${idx}` }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 5, output_tokens: 4 },
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }

    const fallbackAssistants: AssistantMessage[] = []
    for await (const message of queryModelWithStreaming({
      messages: [createUserMessage({ content: 'hello' })],
      systemPrompt: asSystemPrompt([]),
      thinkingConfig: { type: 'disabled' },
      tools: [],
      signal: new AbortController().signal,
      options: {
        model,
        querySource: 'insights',
        agents: [],
        isNonInteractiveSession: true,
        hasAppendSystemPrompt: false,
        mcpTools: [],
        enablePromptCaching: false,
        getToolPermissionContext: async () => getEmptyToolPermissionContext(),
      },
    })) {
      if (message.type === 'assistant') {
        fallbackAssistants.push(message)
      }
    }

    expect(fallbackAssistants).toHaveLength(1)
    expect(fallbackAssistants[0]?.message.role).toBe('assistant')
  }
})
