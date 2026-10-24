import { afterAll, beforeAll, expect, spyOn, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSandboxedTestEnvironment } from '../../../scripts/pr/test-environment.js'
import type { ToolUseContext } from '../../Tool.js'

const originalEnvironment = { ...process.env }
const globals = globalThis as typeof globalThis & { MACRO?: { BUILD_TIME: string } }
const originalMacro = globals.MACRO
let sandbox: string
let server: ReturnType<typeof Bun.serve>
let WebSearchTool: typeof import('./WebSearchTool.js').WebSearchTool
let getEmptyToolPermissionContext: typeof import('../../Tool.js').getEmptyToolPermissionContext
let fetchMock: ReturnType<typeof spyOn>
const requests: Array<{ model: string; tools?: Array<{ name: string; type?: string }> }> = []

beforeAll(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'deepseek-native-search-'))
  for (const key of Object.keys(process.env)) delete process.env[key]
  Object.assign(process.env, createSandboxedTestEnvironment(sandbox, {
    NODE_ENV: 'production', CLAUDE_CODE_SIMPLE: '1', ANTHROPIC_API_KEY: 'offline-fixture-key',
    ANTHROPIC_MODEL: 'deepseek-flash', CLAUDE_CODE_MAX_RETRIES: '0',
    CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK: '1',
  }, originalEnvironment))
  server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    requests.push(await request.json())
    const events = [
      { type: 'message_start', message: { id: 'msg_search', type: 'message', role: 'assistant', model: 'deepseek-flash', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'web_search_tool_result', tool_use_id: 'search_fixture', content: [{ type: 'web_search_result', title: 'DeepSeek fixture', url: 'https://example.invalid/result', encrypted_content: 'fixture' }] } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } },
      { type: 'message_stop' },
    ]
    return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } })
  } })
  process.env.ANTHROPIC_BASE_URL = 'https://api.deepseek.com/anthropic'
  const fixtureFetch = globalThis.fetch
  fetchMock = spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const request = new Request(input, init)
    expect(new URL(request.url).origin + new URL(request.url).pathname).toBe('https://api.deepseek.com/anthropic/v1/messages')
    return fixtureFetch(new Request(`http://127.0.0.1:${server.port}/v1/messages`, request))
  })
  globals.MACRO = { BUILD_TIME: '' }
  ;({ WebSearchTool } = await import('./WebSearchTool.js'))
  ;({ getEmptyToolPermissionContext } = await import('../../Tool.js'))
  const { enableConfigs } = await import('../../utils/config.js')
  enableConfigs()
})

afterAll(async () => {
  server?.stop(true)
  fetchMock?.mockRestore()
  for (const key of Object.keys(process.env)) delete process.env[key]
  Object.assign(process.env, originalEnvironment)
  if (originalMacro === undefined) delete globals.MACRO
  else globals.MACRO = originalMacro
  await rm(sandbox, { recursive: true, force: true })
})

test('DeepSeek Auto WebSearch calls the native search schema and returns its results', async () => {
  expect(WebSearchTool.isEnabled()).toBe(true)
  const result = await WebSearchTool.call({ query: 'fixture search' }, {
    options: { mainLoopModel: 'deepseek-flash', thinkingConfig: { type: 'disabled' },
      isNonInteractiveSession: true, agentDefinitions: { activeAgents: [] } },
    abortController: new AbortController(),
    getAppState: () => ({ toolPermissionContext: getEmptyToolPermissionContext() }),
  } as unknown as ToolUseContext, undefined as never, undefined as never)

  expect(requests).toHaveLength(1)
  expect(requests[0]!.model).toBe('deepseek-flash')
  expect(requests[0]!.tools).toContainEqual(expect.objectContaining({ type: 'web_search_20250305', name: 'web_search' }))
  expect(result.data.results).toContainEqual({ tool_use_id: 'search_fixture', content: [{ title: 'DeepSeek fixture', url: 'https://example.invalid/result' }] })
})
