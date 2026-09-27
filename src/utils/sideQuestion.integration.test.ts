import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createSandboxedTestEnvironment } from '../../scripts/pr/test-environment.js'
import type { ToolUseContext, Tool } from '../Tool.js'

if (!process.env.BTW_LOOPBACK_FIXTURE) {
  test('side question real fork shares prefix, sees current context and never executes tools', async () => {
    const root = await mkdtemp(join(tmpdir(), 'btw-loopback-'))
    try {
      const child = Bun.spawn([process.execPath, '--no-env-file', 'test', fileURLToPath(import.meta.url)], {
        cwd: root, env: createSandboxedTestEnvironment(root, {
          BTW_LOOPBACK_FIXTURE: '1', NODE_ENV: 'production', ANTHROPIC_API_KEY: 'fixture',
          CLAUDE_CODE_SIMPLE: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
          CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1', CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION: '0',
          CLAUDE_CODE_MAX_RETRIES: '0', CLAUDE_STREAM_TRANSIENT_RETRY_MAX: '0',
          CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK: '1',
        }), stdout: 'pipe', stderr: 'pipe',
      })
      const timeout = setTimeout(() => child.kill(), 12_000)
      try {
        const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
        expect(code, stdout + stderr).toBe(0)
      } finally { clearTimeout(timeout) }
    } finally { await rm(root, { recursive: true, force: true }) }
  }, 15_000)
} else {
  test('real fork tools/cache/current context', async () => {
    ;(globalThis as any).MACRO = { BUILD_TIME: '' }
    const { z } = await import('zod')
    const bootstrap = await import('../bootstrap/state.js')
    bootstrap.setCwdState(process.env.HOME!)
    bootstrap.setOriginalCwd(process.env.HOME!)
    bootstrap.setProjectRoot(process.env.HOME!)
    const { runSideQuestion } = await import('./sideQuestion.js')
    const { createUserMessage, createAssistantMessage } = await import('./messages.js')
    const { getDefaultAppState } = await import('../state/AppStateStore.js')
    const { asSystemPrompt } = await import('./systemPromptType.js')
    const { createFileStateCacheWithSizeLimit } = await import('./fileStateCache.js')
    const { enableConfigs } = await import('./config.js')
    enableConfigs()
    let executions = 0
    let requests: any[] = []
    let useTool = false
    const tool = {
      name: 'FixtureWrite', inputSchema: z.object({ value: z.string() }), prompt: async () => 'Write a file',
      maxResultSizeChars: 1000, isConcurrencySafe: () => false, isReadOnly: () => false, isEnabled: () => true,
      userFacingName: () => 'fixture', description: async () => 'Write a file',
      call: async () => { executions++; return { data: 'done' } },
      mapToolResultToToolResultBlockParam: (data: string, id: string) => ({ type: 'tool_result', tool_use_id: id, content: data }),
    } as unknown as Tool
    const event = (data: any) => `event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
      requests.push(await request.json())
      const events = [
        { type: 'message_start', message: { id: 'msg_btw', type: 'message', role: 'assistant', model: 'fixture-model', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 7, output_tokens: 0 } } },
        { type: 'content_block_start', index: 0, content_block: useTool ? { type: 'tool_use', id: 'tool_btw', name: 'FixtureWrite', input: {} } : { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: useTool ? { type: 'input_json_delta', partial_json: '{"value":"forbidden"}' } : { type: 'text_delta', text: 'side answer' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: useTool ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } },
        { type: 'message_stop' },
      ]
      return new Response(events.map(event).join(''), { headers: { 'content-type': 'text/event-stream' } })
    } })
    process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${server.port}`
    const state = getDefaultAppState()
    const main = new AbortController()
    const context = {
      options: { commands: [], debug: false, mainLoopModel: 'fixture-model', tools: [tool], verbose: false,
        thinkingConfig: { type: 'disabled' }, mcpClients: [], mcpResources: {}, isNonInteractiveSession: true,
        agentDefinitions: { activeAgents: [], allAgents: [] } },
      abortController: main, readFileState: createFileStateCacheWithSizeLimit(100), getAppState: () => state, setAppState: () => {},
      setInProgressToolUseIDs: () => {}, setResponseLength: () => {}, updateFileHistoryState: () => {}, updateAttributionState: () => {}, messages: [],
    } as unknown as ToolUseContext
    const pending = createAssistantMessage({ content: [{ type: 'tool_use', id: 'pending_main', name: 'FixtureWrite', input: { value: 'main' } }] })
    pending.message.stop_reason = 'tool_use'
    const parentMessages = [createUserMessage({ content: 'latest live user context' }), pending]
    const before = JSON.stringify(parentMessages)
    const cache = { systemPrompt: asSystemPrompt(['cached system prefix']), userContext: {}, systemContext: {}, toolUseContext: context, forkContextMessages: parentMessages }
    try {
      const answer = await runSideQuestion({ question: 'side question', cacheSafeParams: cache, history: [{ question: 'prior side question', response: 'prior side answer' }] })
      expect(answer.response).toBe('side answer')
      expect(JSON.stringify(requests[0].system)).toContain('cached system prefix')
      expect(JSON.stringify(requests[0].tools)).toContain('FixtureWrite')
      expect(JSON.stringify(requests[0].messages)).toContain('latest live user context')
      expect(JSON.stringify(requests[0].messages)).toContain('prior side answer')
      expect(JSON.stringify(requests[0].messages)).toContain('tool_result')
      expect(JSON.stringify(parentMessages)).toBe(before)
      useTool = true
      await expect(runSideQuestion({ question: 'try tool', cacheSafeParams: cache })).rejects.toThrow('FixtureWrite')
      expect(executions).toBe(0)
      expect(requests).toHaveLength(2)
      expect(main.signal.aborted).toBe(false)
      expect(JSON.stringify(parentMessages)).toBe(before)
    } finally { server.stop(true) }
  })
}
