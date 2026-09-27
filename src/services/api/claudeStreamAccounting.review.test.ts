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
let useFallback = false
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
    ANTHROPIC_API_KEY: 'offline-fixture-key',
    CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK: '1',
    CLAUDE_STREAM_TRANSIENT_RETRY_MAX: '0',
    CLAUDE_CODE_MAX_RETRIES: '0',
  }, originalEnvironment))
  server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    requests++
    const body = await request.json() as { stream?: boolean }
    if (useFallback && !body.stream) return Response.json({ id: 'fallback', type: 'message', role: 'assistant', model: 'fixture-model', content: [{ type: 'text', text: 'fallback' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 11, output_tokens: 13 } })
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

async function receiveResponse(events: unknown[], fallback = false, earlyReturn = false) {
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
    if (message.type === 'assistant') {
      assistants.push(message)
      if (earlyReturn) break
    }
  }
  expect(requests).toBe(useFallback ? 2 : 1)
  return assistants
}


test('review: generator.return at terminal assistant yield records cumulative usage exactly once', async () => {
  const { getTotalInputTokens, getTotalOutputTokens } = await import('../../bootstrap/state.js')
  const before = { input: getTotalInputTokens(), output: getTotalOutputTokens() }
  await receiveResponse([...fixtureEvents(), terminal('max_tokens'), { type: 'message_stop' }], false, true)
  expect(getTotalInputTokens() - before.input).toBe(7)
  expect(getTotalOutputTokens() - before.output).toBe(5)
})

test('review: streaming and non-streaming fallback bill their own cumulative usage once', async () => {
  const { getTotalInputTokens, getTotalOutputTokens } = await import('../../bootstrap/state.js')
  const before = { input: getTotalInputTokens(), output: getTotalOutputTokens() }
  useFallback = true
  try {
    const messages = await receiveResponse([fixtureEvents()[0], terminal(), {
      type: 'error', error: { type: 'invalid_request_error', message: 'fixture stream error' },
    }], true)
    expect(JSON.stringify(messages)).toContain('fallback')
    expect(getTotalInputTokens() - before.input).toBe(18)
    expect(getTotalOutputTokens() - before.output).toBe(18)
  } finally {
    useFallback = false
  }
})
