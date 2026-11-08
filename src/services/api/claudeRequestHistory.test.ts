import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSandboxedTestEnvironment } from '../../../scripts/pr/test-environment.js'
import type { AssistantMessage, Message } from '../../types/message.js'

// What queryModel replays to a provider after a model switch or a refusal,
// through the real request path: SDK error parsing, withRetry, queryModel's
// history preparation and the final error classification.

const originalEnvironment = { ...process.env }
let sandbox: string
let server: ReturnType<typeof Bun.serve>
let responses: Array<() => Response> = []
let requests: string[] = []
let queryModelWithStreaming: typeof import('./claude.js').queryModelWithStreaming
let createUserMessage: typeof import('../../utils/messages.js').createUserMessage
let createAssistantMessage: typeof import('../../utils/messages.js').createAssistantMessage
let asSystemPrompt: typeof import('../../utils/systemPromptType.js').asSystemPrompt
let getEmptyToolPermissionContext: typeof import('../../Tool.js').getEmptyToolPermissionContext
let resetImageInputRefusalsForTests: typeof import('./imageInputRefusals.js').resetImageInputRefusalsForTests
const globals = globalThis as typeof globalThis & { MACRO?: { BUILD_TIME: string } }
const originalMacro = globals.MACRO

beforeAll(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'claude-request-history-'))
  for (const key of Object.keys(process.env)) delete process.env[key]
  Object.assign(process.env, createSandboxedTestEnvironment(sandbox, {
    NODE_ENV: 'production',
    CLAUDE_CODE_SIMPLE: '1',
    ANTHROPIC_API_KEY: 'offline-fixture-key',
    CLAUDE_CODE_MAX_RETRIES: '1',
    CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK: '1',
  }, originalEnvironment))
  server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    requests.push(await request.text())
    const next = responses.shift()
    return next ? next() : new Response('unexpected request', { status: 500 })
  } })
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${server.port}`
  globals.MACRO = { BUILD_TIME: '' }
  ;({ queryModelWithStreaming } = await import('./claude.js'))
  ;({ createUserMessage, createAssistantMessage } = await import('../../utils/messages.js'))
  ;({ asSystemPrompt } = await import('../../utils/systemPromptType.js'))
  ;({ getEmptyToolPermissionContext } = await import('../../Tool.js'))
  ;({ resetImageInputRefusalsForTests } = await import('./imageInputRefusals.js'))
  const { enableConfigs } = await import('../../utils/config.js')
  enableConfigs()
})

beforeEach(() => {
  resetImageInputRefusalsForTests()
})

afterAll(async () => {
  server?.stop(true)
  for (const key of Object.keys(process.env)) delete process.env[key]
  Object.assign(process.env, originalEnvironment)
  if (originalMacro === undefined) delete globals.MACRO
  else globals.MACRO = originalMacro
  await rm(sandbox, { recursive: true, force: true })
})

const PNG_1X1 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

function sse(events: Array<Record<string, unknown>>): string {
  return events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('')
}

const answered = () => new Response(sse([
  { type: 'message_start', message: {
    id: 'msg_request_history', type: 'message', role: 'assistant', model: 'fixture-model', content: [],
    stop_reason: null, stop_sequence: null, usage: { input_tokens: 7, output_tokens: 0 },
  } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'answered' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } },
  { type: 'message_stop' },
]), { headers: { 'content-type': 'text/event-stream' } })

function rejected(status: number, message: string): () => Response {
  return () => Response.json(
    { type: 'error', error: { type: 'invalid_request_error', message } },
    { status },
  )
}

const IMAGE_REFUSAL = 'This model does not support image input'
// DeepSeek's Anthropic endpoint, given a Gemini signature block left in history.
const UNKNOWN_BLOCK_REJECTION =
  'Failed to deserialize the JSON body into the target type: messages[2].content: unknown variant `redacted_thinking`, expected one of `text`, `image`, `document`, `thinking`, `tool_use`, `tool_result` at line 1 column 9210'

function screenshotTurn() {
  return [createUserMessage({ content: [
    { type: 'text', text: 'what is in this screenshot?' },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG_1X1 } },
  ] })]
}

async function run(model: string, queued: Array<() => Response>, messages: Message[] = screenshotTurn()) {
  responses = [...queued]
  requests = []
  // biome-ignore lint/suspicious/noExplicitAny: collects heterogeneous stream messages
  const out: any[] = []
  for await (const message of queryModelWithStreaming({
    messages,
    systemPrompt: asSystemPrompt([]), thinkingConfig: { type: 'disabled' }, tools: [],
    signal: new AbortController().signal,
    options: { model, querySource: 'insights', agents: [], isNonInteractiveSession: true,
      hasAppendSystemPrompt: false, mcpTools: [], enablePromptCaching: false,
      getToolPermissionContext: async () => getEmptyToolPermissionContext() },
  })) {
    out.push(message)
  }
  const assistants: AssistantMessage[] = out.filter(message => message.type === 'assistant')
  return {
    replies: assistants.filter(message => !message.isApiErrorMessage),
    errors: assistants.filter(message => message.isApiErrorMessage),
    bodies: requests,
    sent: requests.map(body => ({
      image: body.includes('"type":"image"'),
      placeholder: body.includes('Image omitted'),
    })),
  }
}

test('an explicit image refusal is re-sent without images, then remembered for the model', async () => {
  const first = await run('text-only-model', [rejected(400, IMAGE_REFUSAL), answered])

  expect(first.sent).toEqual([
    { image: true, placeholder: false },
    { image: false, placeholder: true },
  ])
  expect(first.errors).toHaveLength(0)
  expect(first.replies.map(reply => reply.message.content)).toEqual([[{ type: 'text', text: 'answered' }]])

  const next = await run('text-only-model', [answered])
  expect(next.sent).toEqual([{ image: false, placeholder: true }])
  expect(next.errors).toHaveLength(0)
})

test('a refusal whose image-free re-send also fails surfaces that failure and is not remembered', async () => {
  const first = await run('text-only-model', [
    rejected(400, IMAGE_REFUSAL),
    rejected(400, 'messages.1.content: tool_result block references an unknown tool_use id'),
  ])

  expect(first.sent).toEqual([
    { image: true, placeholder: false },
    { image: false, placeholder: true },
  ])
  expect(first.errors).toHaveLength(1)
  expect(first.errors[0]?.businessErrorCode).toBeUndefined()
  expect(JSON.stringify(first.errors[0]?.message.content)).toContain('unknown tool_use id')

  const next = await run('text-only-model', [answered])
  expect(next.sent).toEqual([{ image: true, placeholder: false }])
})

test('a 400/422 that is not an image refusal is shown as the provider wrote it, and images keep flowing', async () => {
  for (const [status, wording] of [
    [422, UNKNOWN_BLOCK_REJECTION],
    [400, 'Provided image is not valid.'],
    [400, 'Could not process image'],
    [400, 'Upstream request failed, please retry'],
  ] as const) {
    resetImageInputRefusalsForTests()
    const first = await run('vision-model', [rejected(status, wording)])

    expect(first.sent).toEqual([{ image: true, placeholder: false }])
    expect(first.replies).toHaveLength(0)
    expect(first.errors).toHaveLength(1)
    expect(first.errors[0]?.businessErrorCode).toBeUndefined()
    expect(JSON.stringify(first.errors[0]?.message.content)).toContain(wording.slice(0, 24))

    const next = await run('vision-model', [answered])
    expect(next.sent).toEqual([{ image: true, placeholder: false }])
  }
})

test('history from another model loses its signed thinking on every caller, the current model keeps its own', async () => {
  // Streaming stores each block as its own same-id assistant message.
  const gemini = [
    createAssistantMessage({ content: [{ type: 'thinking', thinking: '', signature: '' }] }),
    createAssistantMessage({ content: [{ type: 'redacted_thinking', data: 'cc-haha:gemini-thought-signature:v1:abc' }] }),
    createAssistantMessage({ content: [{ type: 'text', text: 'gemini answer' }] }),
  ]
  const deepseek = [
    createAssistantMessage({ content: [{ type: 'thinking', thinking: 'deepseek plan', signature: 'deepseek-sig' }] }),
    createAssistantMessage({ content: [{ type: 'text', text: 'deepseek answer' }] }),
  ]
  for (const message of gemini) {
    message.message.id = 'gemini-turn'
    message.message.model = 'gemini-4-argon'
  }
  for (const message of deepseek) {
    message.message.id = 'deepseek-turn'
    message.message.model = 'deepseek-flash'
  }
  const history: Message[] = [
    createUserMessage({ content: 'start' }),
    ...gemini,
    createUserMessage({ content: 'continue' }),
    ...deepseek,
    createUserMessage({ content: 'summarize' }),
  ]

  const { bodies, errors } = await run('deepseek-flash', [answered], history)

  expect(errors).toHaveLength(0)
  expect(bodies).toHaveLength(1)
  expect(bodies[0]).not.toContain('redacted_thinking')
  expect(bodies[0]).not.toContain('gemini-thought-signature')
  expect(bodies[0]).toContain('gemini answer')
  expect(bodies[0]).toContain('deepseek plan')
})
