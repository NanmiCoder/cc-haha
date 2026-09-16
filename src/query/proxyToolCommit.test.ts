import { expect, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createSandboxedTestEnvironment } from '../../scripts/pr/test-environment.js'
import type { Tool, ToolUseContext } from '../Tool.js'
import type { QueryParams } from '../query.js'

const scenarios = ['chat-eof', 'chat-length', 'chat-error', 'chat-completed', 'responses-incomplete', 'responses-failed', 'responses-done-only'] as const
type Scenario = typeof scenarios[number]
const resultPrefix = 'PROXY_TOOL_COMMIT_RESULT:'
const childScenario = process.env.CC_HAHA_PROXY_TOOL_COMMIT_SCENARIO

// Loading the real query graph in a shared Bun test process can cache runtime
// modules before later mock.module tests install their fixtures. Keep every
// production import and process-global bootstrap mutation in a fresh child.
async function runScenario(root: string, scenario: Scenario) {
  ;(globalThis as typeof globalThis & { MACRO?: { BUILD_TIME: string } }).MACRO = { BUILD_TIME: '' }
  const { randomUUID } = await import('node:crypto')
  const { writeFile } = await import('node:fs/promises')
  const { z } = await import('zod')
  const { openaiChatStreamToAnthropic } = await import('../server/proxy/streaming/openaiChatStreamToAnthropic.js')
  const { openaiResponsesStreamToAnthropic } = await import('../server/proxy/streaming/openaiResponsesStreamToAnthropic.js')
  const bootstrap = await import('../bootstrap/state.js')
  bootstrap.setCwdState(root)
  bootstrap.setOriginalCwd(root)
  bootstrap.setProjectRoot(root)
  process.chdir(root)
  const { query } = await import('../query.js')
  const { queryModelWithStreaming: callModel } = await import('../services/api/claude.js')
  const { getDefaultAppState } = await import('../state/AppStateStore.js')
  const { createUserMessage } = await import('../utils/messages.js')
  const { asSystemPrompt } = await import('../utils/systemPromptType.js')
  const { enableConfigs } = await import('../utils/config.js')
  enableConfigs()
  let executions = 0
  let requests = 0
  const target = join(root, `${scenario}.txt`)
  const input = { file_path: target, content: 'written exactly once' }
  const args = JSON.stringify(input)
  const isChat = scenario.startsWith('chat-')
  let wire = isChat
    ? chatTool(args, scenario === 'chat-completed' ? 'tool_calls' : scenario === 'chat-length' ? 'length' : undefined)
    : responsesTool(args, scenario === 'responses-done-only' ? 'completed' : scenario === 'responses-failed' ? 'failed' : 'incomplete', scenario === 'responses-done-only')
  if (scenario === 'chat-error') wire += `data: ${JSON.stringify({ error: { type: 'server_error', message: 'fixture upstream failure' } })}\n\n`
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    await request.json()
    requests++
    const stream = requests === 1
      ? (isChat ? openaiChatStreamToAnthropic(upstream(wire), 'fixture-model') : openaiResponsesStreamToAnthropic(upstream(wire), 'fixture-model'))
      : openaiChatStreamToAnthropic(upstream(`data: ${JSON.stringify({ choices: [{ delta: { content: 'complete' }, finish_reason: 'stop' }] })}\n\n`), 'fixture-model')
    return new Response(stream, { headers: { 'content-type': 'text/event-stream' } })
  } })
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${server.port}`
  const tool = {
    name: 'FixtureWrite', inputSchema: z.object({ file_path: z.string(), content: z.string() }),
    prompt: async () => 'Write a fixture file', maxResultSizeChars: 1000, isConcurrencySafe: () => false, isReadOnly: () => false,
    isEnabled: () => true, userFacingName: () => 'fixture write', description: async () => 'Write a fixture file',
    call: async (value: typeof input) => {
      executions++
      await writeFile(value.file_path, value.content)
      return { data: 'written' }
    },
    mapToolResultToToolResultBlockParam: (data: string, id: string) => ({ type: 'tool_result', tool_use_id: id, content: data }),
  } as unknown as Tool
  let state = getDefaultAppState()
  const toolUseContext = {
    options: { commands: [], debug: false, mainLoopModel: 'fixture-model', tools: [tool], verbose: false,
      thinkingConfig: { type: 'disabled' }, mcpClients: [], mcpResources: {}, isNonInteractiveSession: true,
      agentDefinitions: { activeAgents: [], allAgents: [] } },
    abortController: new AbortController(), readFileState: new Map(),
    getAppState: () => state, setAppState: (update: (value: typeof state) => typeof state) => { state = update(state) },
    setInProgressToolUseIDs: () => {}, setResponseLength: () => {},
    updateFileHistoryState: () => {}, updateAttributionState: () => {}, messages: [],
  } as unknown as ToolUseContext
  const params: QueryParams = {
    messages: [createUserMessage({ content: 'Run the fixture write once' })],
    systemPrompt: asSystemPrompt([]), userContext: {}, systemContext: {},
    canUseTool: async (_tool, value) => ({ behavior: 'allow', updatedInput: value }),
    toolUseContext, querySource: 'sdk', maxTurns: 2,
    deps: { callModel, microcompact: async messages => ({ messages }), autocompact: async () => ({}), uuid: randomUUID },
  }
  try {
    for await (const _message of query(params)) {
      // Drain the production query loop, including tool execution and continuation.
    }
    return { executions, requests }
  } finally {
    toolUseContext.abortController.abort()
    server.stop(true)
  }
}

function upstream(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text))
      controller.close()
    },
  })
}

function event(type: string, fields: Record<string, unknown>): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`
}

function chatTool(argumentsJson: string, finish?: string): string {
  return `data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{
    index: 0, id: 'call_fixture', type: 'function',
    function: { name: 'FixtureWrite', arguments: argumentsJson },
  }] }, finish_reason: finish ?? null }] })}\n\n`
}

function responsesTool(argumentsJson: string, terminal: 'completed' | 'incomplete' | 'failed', doneOnly = false): string {
  return event('response.created', { response: { id: 'resp_fixture', model: 'fixture-model' } })
    + event('response.output_item.added', { output_index: 0, item: {
      id: 'fc_fixture', type: 'function_call', call_id: 'call_fixture', name: 'FixtureWrite', arguments: '',
    } })
    + (doneOnly ? '' : event('response.function_call_arguments.delta', { item_id: 'fc_fixture', delta: argumentsJson }))
    + event('response.function_call_arguments.done', { item_id: 'fc_fixture', arguments: argumentsJson })
    + event(`response.${terminal}`, { response: {
      status: terminal,
      ...(terminal === 'incomplete' ? { incomplete_details: { reason: 'max_output_tokens' } } : {}),
      ...(terminal === 'failed' ? { error: { type: 'server_error', message: 'fixture upstream failure' } } : {}),
      usage: { input_tokens: 10, output_tokens: 5 },
    } })
}

for (const scenario of scenarios) {
  if (childScenario && childScenario !== scenario) continue
  test(`real API and query executor commit boundary: ${scenario}`, async () => {
    if (childScenario) {
      const result = await runScenario(process.env.HOME!, scenario)
      console.log(resultPrefix + JSON.stringify(result))
      return
    }
    const root = await mkdtemp(join(tmpdir(), 'proxy-tool-commit-'))
    const child = Bun.spawn([process.execPath, '--no-env-file', 'test', fileURLToPath(import.meta.url)], {
      cwd: root,
      env: createSandboxedTestEnvironment(root, {
        CC_HAHA_PROXY_TOOL_COMMIT_SCENARIO: scenario,
        NODE_ENV: 'production',
        CLAUDE_CODE_SIMPLE: '1',
        CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
        CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION: '0',
        CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK: '1',
        CLAUDE_CODE_MAX_RETRIES: '0',
        CLAUDE_STREAM_TRANSIENT_RETRY_MAX: '0',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        ANTHROPIC_API_KEY: 'loopback-fixture-key',
        ANTHROPIC_MODEL: 'fixture-model',
      }),
      stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
    })
    const timeout = setTimeout(() => child.kill('SIGKILL'), 15_000)
    try {
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
      ])
      expect(exitCode, stderr).toBe(0)
      const resultLine = stdout.split('\n').find(line => line.startsWith(resultPrefix))
      expect(resultLine, stdout + stderr).toBeDefined()
      const result = JSON.parse(resultLine!.slice(resultPrefix.length))
      const success = scenario === 'chat-completed' || scenario === 'responses-done-only'
      expect(result.executions).toBe(success ? 1 : 0)
      const target = join(root, `${scenario}.txt`)
      if (success) expect(await readFile(target, 'utf8')).toBe('written exactly once')
      else expect(await Bun.file(target).exists()).toBe(false)
      expect(result.requests).toBe(success ? 2 : 1)
    } finally {
      clearTimeout(timeout)
      child.kill()
      await child.exited
      await rm(root, { recursive: true, force: true })
    }
  }, 20_000)
}
