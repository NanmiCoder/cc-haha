import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSandboxedTestEnvironment } from '../../../scripts/pr/test-environment.js'
import type { AssistantMessage } from '../../types/message.js'

const originalEnvironment = { ...process.env }
let sandbox: string
let server: ReturnType<typeof Bun.serve>
let responseBody = ''
let requests = 0
let queryModelWithStreaming: typeof import('./claude.js').queryModelWithStreaming
let createUserMessage: typeof import('../../utils/messages.js').createUserMessage
let asSystemPrompt: typeof import('../../utils/systemPromptType.js').asSystemPrompt
let getEmptyToolPermissionContext: typeof import('../../Tool.js').getEmptyToolPermissionContext
const globals = globalThis as typeof globalThis & { MACRO?: { BUILD_TIME: string } }
const originalMacro = globals.MACRO

beforeAll(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'claude-trailing-usage-'))
  for (const key of Object.keys(process.env)) delete process.env[key]
  Object.assign(process.env, createSandboxedTestEnvironment(sandbox, {
    NODE_ENV: 'production',
    ANTHROPIC_API_KEY: 'offline-fixture-key',
    CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK: '1',
  }, originalEnvironment))
  server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch() {
    requests++
    return new Response(responseBody, { headers: { 'content-type': 'text/event-stream' } })
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

async function receiveResponse(deltas: Record<string, unknown>[], tool = false) {
  const model = 'claude-sonnet-4-6'
  const events = [
    { type: 'message_start', message: {
      id: 'msg_tail_fixture', type: 'message', role: 'assistant', model, content: [],
      stop_reason: null, stop_sequence: null, usage: { input_tokens: 7, output_tokens: 0 },
    } },
    { type: 'content_block_start', index: 0, content_block: tool
      ? { type: 'tool_use', id: 'tool_fixture', name: 'Bash', input: {} }
      : { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: tool
      ? { type: 'input_json_delta', partial_json: '{"command":"echo fixture"}' }
      : { type: 'text_delta', text: 'fixture' } },
    { type: 'content_block_stop', index: 0 },
    ...deltas.map((delta, index) => ({ type: 'message_delta', delta,
      usage: { output_tokens: index === 0 ? 2 : 9 } })),
    { type: 'message_stop' },
  ]
  requests = 0
  responseBody = events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('')
  const assistants: AssistantMessage[] = []
  let seenStopReason = false
  for await (const message of queryModelWithStreaming({
    messages: [createUserMessage({ content: 'fixture' })],
    systemPrompt: asSystemPrompt([]), thinkingConfig: { type: 'disabled' }, tools: [],
    signal: new AbortController().signal,
    options: { model, querySource: 'insights', agents: [], isNonInteractiveSession: true,
      hasAppendSystemPrompt: false, mcpTools: [], enablePromptCaching: false,
      getToolPermissionContext: async () => getEmptyToolPermissionContext() },
  })) {
    if (message.type === 'stream_event' && message.event.type === 'message_delta'
      && message.event.delta.stop_reason != null) seenStopReason = true
    if (message.type === 'assistant') {
      if (message.message.content.some(block => block.type === 'tool_use')) expect(seenStopReason).toBe(true)
      assistants.push(message)
    }
  }
  expect(requests).toBe(1)
  return assistants
}

for (const reason of ['end_turn', 'tool_use', 'max_tokens', 'model_context_window_exceeded', 'refusal']) {
  for (const tail of [{ stop_reason: null, stop_sequence: null }, {}]) {
    test(`preserves ${reason} through usage-only tail ${JSON.stringify(tail)}`, async () => {
      const messages = await receiveResponse([{ stop_reason: reason, stop_sequence: null }, tail], reason === 'tool_use')
      const response = messages.find(message => !message.isApiErrorMessage)!
      expect(response.message.stop_reason).toBe(reason)
      expect(response.message.usage).toMatchObject({ input_tokens: 7, output_tokens: 9 })
      if (reason === 'max_tokens' || reason === 'model_context_window_exceeded') {
        expect(messages.filter(message => message.error === 'max_output_tokens')).toHaveLength(1)
      } else if (reason === 'refusal') {
        expect(messages).toHaveLength(2)
      } else {
        expect(messages).toHaveLength(1)
      }
    })
  }
}

test('preserves a stop sequence through usage-only tails', async () => {
  const messages = await receiveResponse([
    { stop_reason: 'stop_sequence', stop_sequence: 'DONE' },
    { stop_reason: null, stop_sequence: null },
  ])
  expect(messages[0]?.message.stop_reason).toBe('stop_sequence')
  expect(messages[0]?.message.stop_sequence).toBe('DONE')
})

test('accepts a later non-null reason and clears its previous stop sequence', async () => {
  const messages = await receiveResponse([
    { stop_reason: 'stop_sequence', stop_sequence: 'DONE' },
    { stop_reason: 'end_turn', stop_sequence: null },
  ])
  expect(messages[0]?.message.stop_reason).toBe('end_turn')
  expect(messages[0]?.message.stop_sequence).toBeNull()
})

for (const reason of ['end_turn', 'tool_use']) {
  test(`standard ${reason} without a usage tail remains unchanged`, async () => {
    const messages = await receiveResponse([{ stop_reason: reason, stop_sequence: null }], reason === 'tool_use')
    expect(messages).toHaveLength(1)
    expect(messages[0]?.message.stop_reason).toBe(reason)
    expect(messages[0]?.message.usage.output_tokens).toBe(2)
  })
}
test('usage-only delta before the terminal reason remains supported', async () => {
  const messages = await receiveResponse([{}, { stop_reason: 'end_turn', stop_sequence: null }])
  expect(messages).toHaveLength(1)
  expect(messages[0]?.message.stop_reason).toBe('end_turn')
  expect(messages[0]?.message.usage.output_tokens).toBe(9)
})
