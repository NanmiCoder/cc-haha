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
let holdResponseOpen = false
let requests = 0
let queryModelWithStreaming: typeof import('./claude.js').queryModelWithStreaming
let createUserMessage: typeof import('../../utils/messages.js').createUserMessage
let asSystemPrompt: typeof import('../../utils/systemPromptType.js').asSystemPrompt
let getEmptyToolPermissionContext: typeof import('../../Tool.js').getEmptyToolPermissionContext
const globals = globalThis as typeof globalThis & { MACRO?: { BUILD_TIME: string } }
const originalMacro = globals.MACRO

beforeAll(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'claude-stream-integrity-'))
  for (const key of Object.keys(process.env)) delete process.env[key]
  Object.assign(process.env, createSandboxedTestEnvironment(sandbox, {
    NODE_ENV: 'production',
    CLAUDE_CODE_SIMPLE: '1',
    ANTHROPIC_API_KEY: 'offline-fixture-key',
    CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK: '1',
    CLAUDE_STREAM_TRANSIENT_RETRY_MAX: '0',
    CLAUDE_CODE_MAX_RETRIES: '0',
  }, originalEnvironment))
  server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch() {
    requests++
    if (holdResponseOpen) {
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(responseBody))
        },
      }), { headers: { 'content-type': 'text/event-stream' } })
    }
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

function fixtureEvents(blockType = 'text') {
  return [
    { type: 'message_start', message: {
      id: 'msg_integrity', type: 'message', role: 'assistant', model: 'fixture-model', content: [],
      stop_reason: null, stop_sequence: null, usage: { input_tokens: 7, output_tokens: 0 },
    } },
    { type: 'content_block_start', index: 0, content_block: blockType === 'text'
      ? { type: 'text', text: '' }
      : { type: blockType, id: 'tool_fixture', name: blockType === 'server_tool_use' ? 'web_search' : 'Bash', input: {} } },
    { type: 'content_block_delta', index: 0, delta: blockType === 'text'
      ? { type: 'text_delta', text: 'partial fixture' }
      : { type: 'input_json_delta', partial_json: '{"command":"echo fixture"}' } },
    { type: 'content_block_stop', index: 0 },
  ]
}

function terminal(reason = 'end_turn') {
  return { type: 'message_delta', delta: { stop_reason: reason, stop_sequence: null }, usage: { output_tokens: 5 } }
}

async function receiveResponse(events: unknown[], fallback = false) {
  const model = 'fixture-model'
  process.env.CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK = fallback ? '0' : '1'
  requests = 0
  responseBody = events.map((event: any) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('')
  const assistants: AssistantMessage[] = []
  for await (const message of queryModelWithStreaming({
    messages: [createUserMessage({ content: 'fixture' })],
    systemPrompt: asSystemPrompt([]), thinkingConfig: { type: 'disabled' }, tools: [],
    signal: new AbortController().signal,
    options: { model, querySource: 'insights', agents: [], isNonInteractiveSession: true,
      hasAppendSystemPrompt: false, mcpTools: [], enablePromptCaching: false,
      getToolPermissionContext: async () => getEmptyToolPermissionContext() },
  })) {
    if (message.type === 'assistant') assistants.push(message)
  }
  expect(requests).toBe(1)
  return assistants
}

for (const block of ['text', 'tool_use']) {
  test(`missing message_stop rejects completed ${block} without replay`, async () => {
    const messages = await receiveResponse([...fixtureEvents(block), terminal(block === 'text' ? 'end_turn' : 'tool_use')], true)
    expect(messages.some(message => message.isApiErrorMessage)).toBe(true)
    expect(messages.flatMap(message => message.message.content).some(block => block.type === 'tool_use')).toBe(false)
    if (block === 'text') expect(JSON.stringify(messages)).toContain('partial fixture')
  })
  test(`duplicate ${block} stop releases only one block`, async () => {
    const events = fixtureEvents(block)
    const messages = await receiveResponse([...events, events.at(-1), terminal(block === 'text' ? 'end_turn' : 'tool_use'), { type: 'message_stop' }])
    expect(messages).toHaveLength(1)
    expect(messages[0]?.isApiErrorMessage).not.toBe(true)
  })
}
for (const reason of ['max_tokens', 'model_context_window_exceeded', 'refusal']) {
  test(`duplicate ${reason} terminal frame produces one terminal error`, async () => {
    const messages = await receiveResponse([...fixtureEvents(), terminal(reason), terminal(reason), { type: 'message_stop' }])
    expect(messages).toHaveLength(2)
  })
}
test('explicit output truncation stays legal without message_stop', async () => {
  const messages = await receiveResponse([...fixtureEvents('tool_use'), terminal('max_tokens')], true)
  expect(messages).toHaveLength(1)
  expect(messages[0]?.error).toBe('max_output_tokens')
  expect(JSON.stringify(messages)).toContain('tool call was truncated')
})
test('server tool start followed by EOF is never replayed', async () => {
  const messages = await receiveResponse(fixtureEvents('server_tool_use').slice(0, 3), true)
  expect(messages.some(message => message.isApiErrorMessage)).toBe(true)
})
test('server tool start followed by error is never replayed', async () => {
  const messages = await receiveResponse([...fixtureEvents('server_tool_use').slice(0, 3), {
    type: 'error', error: { type: 'overloaded_error', message: 'fixture failure' },
  }], true)
  expect(messages.some(message => message.isApiErrorMessage)).toBe(true)
})
test('message_stop without a reason is incomplete', async () => {
  const messages = await receiveResponse([...fixtureEvents(), { type: 'message_stop' }], true)
  expect(messages.some(message => message.isApiErrorMessage)).toBe(true)
})
test('normal complete response is unchanged', async () => {
  const messages = await receiveResponse([...fixtureEvents(), terminal(), { type: 'message_stop' }])
  expect(messages).toHaveLength(1)
  expect(messages[0]?.message.stop_reason).toBe('end_turn')
})

test('open text block survives EOF as displayable partial text with an error', async () => {
  const messages = await receiveResponse(fixtureEvents().slice(0, 3), true)
  expect(messages).toHaveLength(2)
  expect(messages[0]?.message.content).toEqual([{ type: 'text', text: 'partial fixture' }])
  expect(messages[1]?.isApiErrorMessage).toBe(true)
})
test('user stop preserves streamed text without a provider error', async () => {
  holdResponseOpen = true
  responseBody = fixtureEvents().slice(0, 3).map((event: any) =>
    `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
  ).join('')
  const abort = new AbortController()
  const assistants: AssistantMessage[] = []
  try {
    for await (const message of queryModelWithStreaming({
      messages: [createUserMessage({ content: 'fixture' })],
      systemPrompt: asSystemPrompt([]), thinkingConfig: { type: 'disabled' }, tools: [],
      signal: abort.signal,
      options: { model: 'fixture-model', querySource: 'insights', agents: [], isNonInteractiveSession: true,
        hasAppendSystemPrompt: false, mcpTools: [], enablePromptCaching: false,
        getToolPermissionContext: async () => getEmptyToolPermissionContext() },
    })) {
      if (message.type === 'stream_event' && message.event.type === 'content_block_delta') {
        abort.abort('interrupt')
      }
      if (message.type === 'assistant') assistants.push(message)
    }
  } finally {
    holdResponseOpen = false
  }
  expect(assistants.map(message => message.message.content)).toEqual([
    [{ type: 'text', text: 'partial fixture' }],
  ])
  expect(assistants.some(message => message.isApiErrorMessage)).toBe(false)
})
test('user stop after a clean partial EOF does not become a provider error', async () => {
  responseBody = fixtureEvents().slice(0, 3).map((event: any) =>
    `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
  ).join('')
  const abort = new AbortController()
  const assistants: AssistantMessage[] = []
  for await (const message of queryModelWithStreaming({
    messages: [createUserMessage({ content: 'fixture' })],
    systemPrompt: asSystemPrompt([]), thinkingConfig: { type: 'disabled' }, tools: [],
    signal: abort.signal,
    options: { model: 'fixture-model', querySource: 'insights', agents: [], isNonInteractiveSession: true,
      hasAppendSystemPrompt: false, mcpTools: [], enablePromptCaching: false,
      getToolPermissionContext: async () => getEmptyToolPermissionContext() },
  })) {
    if (message.type === 'stream_event' && message.event.type === 'content_block_delta') {
      abort.abort('interrupt')
    }
    if (message.type === 'assistant') assistants.push(message)
  }
  expect(assistants.map(message => message.message.content)).toEqual([
    [{ type: 'text', text: 'partial fixture' }],
  ])
  expect(assistants.some(message => message.isApiErrorMessage)).toBe(false)
})
test('duplicate tool id at another index is emitted only once', async () => {
  const events = fixtureEvents('tool_use')
  const repeated = events.slice(1).map(event => ({ ...event, index: 1 }))
  const messages = await receiveResponse([...events, ...repeated, terminal('tool_use'), { type: 'message_stop' }])
  expect(messages).toHaveLength(1)
})

test('empty structured-output completion remains valid', async () => {
  const messages = await receiveResponse([fixtureEvents()[0], terminal(), { type: 'message_stop' }])
  expect(messages).toHaveLength(0)
})
test('duplicate terminal and growing usage tails account cumulative tokens once', async () => {
  const { getTotalInputTokens, getTotalOutputTokens, getTotalCostUSD } = await import('../../bootstrap/state.js')
  const { calculateUSDCost } = await import('../../utils/modelCost.js')
  const before = { input: getTotalInputTokens(), output: getTotalOutputTokens(), cost: getTotalCostUSD() }
  const messages = await receiveResponse([...fixtureEvents(), terminal(), terminal(), {
    type: 'message_delta', delta: {}, usage: { output_tokens: 9 },
  }, { type: 'message_stop' }])
  expect(getTotalInputTokens() - before.input).toBe(7)
  expect(getTotalOutputTokens() - before.output).toBe(9)
  expect(getTotalCostUSD() - before.cost).toBeCloseTo(calculateUSDCost('fixture-model', messages[0]!.message.usage), 10)
})
