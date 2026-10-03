import { expect, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createSandboxedTestEnvironment } from '../../../scripts/pr/test-environment.js'
import type { Tool, ToolUseContext } from '../../Tool.js'
import type { QueryParams } from '../../query.js'

// The first response dies after its tool call already completed in the stream.
// The re-sent request must run that tool exactly once, through the real query
// loop and tool executor, never from the failed attempt.
const scenarios = ['chat-error-after-finish', 'anthropic-eof-after-tool', 'chat-truncated-mid-tool'] as const
type Scenario = typeof scenarios[number]
const resultPrefix = 'STREAM_RETRY_TOOL_RESULT:'
const childScenario = process.env.CC_HAHA_STREAM_RETRY_TOOL_SCENARIO

// Loading the real query graph in a shared Bun test process can cache runtime
// modules before later mock.module tests install their fixtures, so every
// production import runs in a fresh child.
async function runScenario(root: string, scenario: Scenario) {
  ;(globalThis as typeof globalThis & { MACRO?: { BUILD_TIME: string } }).MACRO = { BUILD_TIME: '' }
  const { randomUUID } = await import('node:crypto')
  const { writeFile } = await import('node:fs/promises')
  const { z } = await import('zod')
  const { openaiChatStreamToAnthropic } = await import('../../server/proxy/streaming/openaiChatStreamToAnthropic.js')
  const bootstrap = await import('../../bootstrap/state.js')
  bootstrap.setCwdState(root)
  bootstrap.setOriginalCwd(root)
  bootstrap.setProjectRoot(root)
  process.chdir(root)
  const { query } = await import('../../query.js')
  const { queryModelWithStreaming: callModel } = await import('./claude.js')
  const { getDefaultAppState } = await import('../../state/AppStateStore.js')
  const { createUserMessage } = await import('../../utils/messages.js')
  const { asSystemPrompt } = await import('../../utils/systemPromptType.js')
  const { enableConfigs } = await import('../../utils/config.js')
  enableConfigs()

  let executions = 0
  let requests = 0
  const committedToolIds: string[] = []
  const target = join(root, `${scenario}.txt`)
  const args = JSON.stringify({ file_path: target, content: 'written exactly once' })
  const encoder = new TextEncoder()

  const proxied = (lines: unknown[], failure?: Error) => {
    let index = 0
    const upstream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (index < lines.length) controller.enqueue(encoder.encode(`data: ${JSON.stringify(lines[index++])}\n\n`))
        else if (failure) controller.error(failure)
        else controller.close()
      },
    })
    return openaiChatStreamToAnthropic(upstream, 'fixture-model')
  }
  const chatToolCall = { id: 'chatcmpl-fixture', model: 'fixture-model', choices: [{ index: 0, delta: { tool_calls: [{
    index: 0, id: 'call_fixture', type: 'function', function: { name: 'FixtureWrite', arguments: args },
  }] }, finish_reason: null }] }
  const chatFinish = { id: 'chatcmpl-fixture', model: 'fixture-model', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }
  const chatDone = { id: 'chatcmpl-fixture', model: 'fixture-model', choices: [{ index: 0, delta: { content: 'complete' }, finish_reason: 'stop' }] }
  const event = (type: string, fields: Record<string, unknown>) =>
    `event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`
  const anthropicToolWithoutStop = event('message_start', { message: {
    id: 'msg_fixture', type: 'message', role: 'assistant', model: 'fixture-model',
    content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 },
  } })
    + event('content_block_start', { index: 0, content_block: { type: 'tool_use', id: 'call_fixture', name: 'FixtureWrite', input: {} } })
    + event('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: args } })
    + event('content_block_stop', { index: 0 })
    + event('message_delta', { delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 5 } })

  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    await request.json()
    requests++
    let body: ReadableStream<Uint8Array> | string
    if (requests === 1) {
      const reset = Object.assign(new Error('upstream reset'), { code: 'ECONNRESET' })
      body = scenario === 'chat-error-after-finish'
        ? proxied([chatToolCall, chatFinish], reset)
        : scenario === 'chat-truncated-mid-tool'
          ? proxied([chatToolCall])
          : anthropicToolWithoutStop
    } else if (requests === 2) {
      body = proxied([chatToolCall, chatFinish])
    } else {
      body = proxied([chatDone])
    }
    return new Response(body, { headers: { 'content-type': 'text/event-stream' } })
  } })
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${server.port}`

  const input = z.object({ file_path: z.string(), content: z.string() })
  const tool = {
    name: 'FixtureWrite', inputSchema: input,
    prompt: async () => 'Write a fixture file', maxResultSizeChars: 1000, isConcurrencySafe: () => false, isReadOnly: () => false,
    isEnabled: () => true, userFacingName: () => 'fixture write', description: async () => 'Write a fixture file',
    call: async (value: z.infer<typeof input>) => {
      executions++
      await writeFile(value.file_path, value.content, { flag: 'a' })
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
    toolUseContext, querySource: 'sdk', maxTurns: 3,
    deps: { callModel, microcompact: async messages => ({ messages }), autocompact: async () => ({}), uuid: randomUUID },
  }
  try {
    for await (const message of query(params)) {
      if (message.type !== 'assistant') continue
      for (const block of message.message.content) {
        if (block.type === 'tool_use') committedToolIds.push(block.id)
      }
    }
    return { executions, requests, committedToolIds }
  } finally {
    toolUseContext.abortController.abort()
    server.stop(true)
  }
}

for (const scenario of scenarios) {
  if (childScenario && childScenario !== scenario) continue
  test(`a re-sent stream runs its tool exactly once: ${scenario}`, async () => {
    if (childScenario) {
      const result = await runScenario(process.env.HOME!, scenario)
      console.log(resultPrefix + JSON.stringify(result))
      return
    }
    const root = await mkdtemp(join(tmpdir(), 'stream-retry-tool-'))
    const child = Bun.spawn([process.execPath, '--no-env-file', 'test', fileURLToPath(import.meta.url)], {
      cwd: root,
      env: createSandboxedTestEnvironment(root, {
        CC_HAHA_STREAM_RETRY_TOOL_SCENARIO: scenario,
        NODE_ENV: 'production',
        CLAUDE_CODE_SIMPLE: '1',
        CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
        CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION: '0',
        CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK: '1',
        CLAUDE_CODE_MAX_RETRIES: '1',
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
      // Request 1 dies, request 2 is the re-send, request 3 carries the tool result.
      expect(result.requests).toBe(3)
      expect(result.committedToolIds).toEqual(['call_fixture'])
      expect(result.executions).toBe(1)
      expect(await readFile(join(root, `${scenario}.txt`), 'utf8')).toBe('written exactly once')
    } finally {
      clearTimeout(timeout)
      child.kill()
      await child.exited
      await rm(root, { recursive: true, force: true })
    }
  }, 20_000)
}
