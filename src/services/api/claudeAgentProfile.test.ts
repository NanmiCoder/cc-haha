import { afterAll, beforeAll, expect, spyOn, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSandboxedTestEnvironment } from '../../../scripts/pr/test-environment.js'

const originalEnvironment = { ...process.env }
let sandbox: string
let server: ReturnType<typeof Bun.serve>
let queryModelWithStreaming: typeof import('./claude.js').queryModelWithStreaming
let createUserMessage: typeof import('../../utils/messages.js').createUserMessage
let asSystemPrompt: typeof import('../../utils/systemPromptType.js').asSystemPrompt
let getEmptyToolPermissionContext: typeof import('../../Tool.js').getEmptyToolPermissionContext
let profile: typeof import('../../utils/agentProfile.js')
let advisor: typeof import('../../utils/advisor.js')
const requests: Array<{ tools?: Array<{ name: string; type?: string }> }> = []
const globals = globalThis as typeof globalThis & { MACRO?: { BUILD_TIME: string } }
const originalMacro = globals.MACRO

beforeAll(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'claude-profile-request-'))
  for (const key of Object.keys(process.env)) delete process.env[key]
  Object.assign(process.env, createSandboxedTestEnvironment(sandbox, {
    NODE_ENV: 'production', CLAUDE_CODE_SIMPLE: '1', ANTHROPIC_API_KEY: 'offline-fixture-key',
    CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK: '1', CLAUDE_CODE_MAX_RETRIES: '0',
  }, originalEnvironment))
  server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    requests.push(await request.json())
    const events = [
      { type: 'message_start', message: { id: 'msg_profile', type: 'message', role: 'assistant', model: 'claude-sonnet-4-6', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'fixture' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } },
      { type: 'message_stop' },
    ]
    return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } })
  } })
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${server.port}`
  globals.MACRO = { BUILD_TIME: '' }
  ;({ queryModelWithStreaming } = await import('./claude.js'))
  ;({ createUserMessage } = await import('../../utils/messages.js'))
  ;({ asSystemPrompt } = await import('../../utils/systemPromptType.js'))
  ;({ getEmptyToolPermissionContext } = await import('../../Tool.js'))
  profile = await import('../../utils/agentProfile.js')
  advisor = await import('../../utils/advisor.js')
  const { enableConfigs } = await import('../../utils/config.js')
  enableConfigs()
})

afterAll(async () => {
  profile?.setAgentProfile('standard')
  server?.stop(true)
  for (const key of Object.keys(process.env)) delete process.env[key]
  Object.assign(process.env, originalEnvironment)
  if (originalMacro === undefined) delete globals.MACRO
  else globals.MACRO = originalMacro
  await rm(sandbox, { recursive: true, force: true })
})

test('lean excludes experiment-injected advisor from the final API request while standard retains it', async () => {
  const enabled = spyOn(advisor, 'isAdvisorEnabled').mockReturnValue(true)
  const experiment = spyOn(advisor, 'getExperimentAdvisorModels').mockReturnValue({ baseModel: 'claude-sonnet-4-6', advisorModel: 'claude-opus-4-6' })
  try {
    for (const selected of ['standard', 'lean'] as const) {
      profile.setAgentProfile(selected)
      requests.length = 0
      for await (const _ of queryModelWithStreaming({
        messages: [createUserMessage({ content: 'fixture' })], systemPrompt: asSystemPrompt([]),
        thinkingConfig: { type: 'disabled' }, tools: [], signal: new AbortController().signal,
        options: { model: 'claude-sonnet-4-6', querySource: 'sdk', agents: [], isNonInteractiveSession: true,
          hasAppendSystemPrompt: false, mcpTools: [], enablePromptCaching: false,
          getToolPermissionContext: async () => getEmptyToolPermissionContext() },
      })) { /* Consume the actual streaming API call. */ }
      expect(requests).toHaveLength(1)
      expect(requests[0]!.tools?.some(tool => tool.name === 'advisor') ?? false).toBe(selected === 'standard')
    }
  } finally {
    enabled.mockRestore()
    experiment.mockRestore()
    profile.setAgentProfile('standard')
  }
})
