import { afterAll, expect, mock, spyOn, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSandboxedTestEnvironment } from '../../scripts/pr/test-environment.js'
import { getAgentProfile, setAgentProfile } from '../utils/agentProfile.js'

const home = mkdtempSync(join(tmpdir(), 'lean-control-'))
const originalEnv = { ...process.env }
const originalProfile = getAgentProfile()
for (const key of Object.keys(process.env)) delete process.env[key]
Object.assign(process.env, createSandboxedTestEnvironment(home, { ANTHROPIC_API_KEY: 'fixture-lean-control-key' }, originalEnv))
const { __runHeadlessStreamingForTests } = await import('./print.js')
const { StructuredIO } = await import('./structuredIO.js')
const { Stream } = await import('../utils/stream.js')
const { getDefaultAppState } = await import('../state/AppStateStore.js')
const { clearCommandQueue } = await import('../utils/messageQueueManager.js')
const { setIsInteractive, getIsInteractive } = await import('../bootstrap/state.js')
const sessionStorage = await import('../utils/sessionStorage.js')
const localAgentTask = await import('../tasks/LocalAgentTask/LocalAgentTask.js')
const agentToolUtils = await import('../tools/AgentTool/agentToolUtils.js')
const agentRunner = await import('../tools/AgentTool/runAgent.js')
const wasInteractive = getIsInteractive()
setIsInteractive(false)
afterAll(() => {
  clearCommandQueue()
  setAgentProfile(originalProfile)
  setIsInteractive(wasInteractive)
  for (const key of Object.keys(process.env)) delete process.env[key]
  Object.assign(process.env, originalEnv)
  rmSync(home, { recursive: true, force: true })
})

test('lean permits ordinary SDK subagent follow-ups while preserving unavailable capability boundaries', async () => {
  setAgentProfile('lean')
  clearCommandQueue()
  const input = new Stream<string>()
  let state = getDefaultAppState()
  const output = __runHeadlessStreamingForTests(new StructuredIO(input), [], [], [], [], (() => undefined) as any, {}, () => state, update => { state = update(state) }, [], { outputFormat: 'stream-json' })
  const iterator = output[Symbol.asyncIterator]()
  async function request(id: string, request: unknown) {
    input.enqueue(JSON.stringify({ type: 'control_request', request_id: id, request }) + '\n')
    while (true) {
      const item = await iterator.next()
      if (item.done) throw new Error('Missing control response')
      if ((item.value as any).type === 'control_response') return (item.value as any).response
    }
  }
  try {
    expect(await request('resume-agent', {
      subtype: 'send_agent_message', agent_id: 'old-agent', content: 'continue',
    })).toMatchObject({
      subtype: 'error', request_id: 'resume-agent',
      error: 'No transcript found for agent ID: old-agent',
    })
    expect(state.tasks).toEqual({})

    spyOn(sessionStorage, 'getAgentTranscript').mockResolvedValue({ messages: [], contentReplacements: [] })
    const metadata = spyOn(sessionStorage, 'readAgentMetadata').mockResolvedValue({ agentType: 'general-purpose' })
    spyOn(localAgentTask, 'registerAsyncAgent').mockImplementation(params => ({ agentId: params.agentId, abortController: new AbortController() }) as never)
    let lifecycle: Parameters<typeof agentToolUtils.runAsyncAgentLifecycle>[0] | undefined
    spyOn(agentToolUtils, 'runAsyncAgentLifecycle').mockImplementation(async params => { lifecycle = params })
    const runner = spyOn(agentRunner, 'runAgent').mockImplementation(async function* () {})
    expect(await request('resume-builtin', {
      subtype: 'send_agent_message', agent_id: 'a0123456789abcdef', content: 'continue',
    })).toMatchObject({ subtype: 'success', request_id: 'resume-builtin', response: { delivery: 'resumed' } })
    lifecycle?.makeStream(undefined)
    expect(runner.mock.calls[0]?.[0].agentDefinition.getSystemPrompt({ toolUseContext: {} as never })).toContain('You are a subagent completing the assigned task')

    metadata.mockResolvedValueOnce({ agentType: 'custom-sentinel' })
    expect(await request('resume-custom', {
      subtype: 'send_agent_message', agent_id: 'a1123456789abcdef', content: 'continue',
    })).toMatchObject({ subtype: 'error', request_id: 'resume-custom', error: expect.stringContaining('unavailable in lean mode') })
    expect(runner).toHaveBeenCalledTimes(1)

    state = { ...state, tasks: {
      'a0123456789abcdef': { type: 'local_agent', agentId: 'a0123456789abcdef', status: 'running', pendingMessages: [] } as never,
    } }
    expect(await request('message-running', {
      subtype: 'send_agent_message', agent_id: 'a0123456789abcdef', content: 'check tests too',
    })).toMatchObject({ subtype: 'success', response: { delivery: 'queued' } })
    expect(localAgentTask.drainPendingMessages('a0123456789abcdef', () => state, update => { state = update(state) })).toEqual(['check tests too'])
    state = { ...state, tasks: {} }
    expect(await request('plan', { subtype: 'set_permission_mode', mode: 'plan' })).toMatchObject({ subtype: 'error', request_id: 'plan' })
    // Lean has no MCP runtime: adding servers over the control channel is refused,
    // while clearing the dynamic set stays harmless.
    expect(await request('mcp-add', {
      subtype: 'mcp_set_servers', servers: { fixture: { type: 'stdio', command: 'unused', args: [] } },
    })).toMatchObject({
      subtype: 'error', request_id: 'mcp-add', error: '--agent-profile lean does not use MCP servers.',
    })
    expect((await request('mcp-clear', { subtype: 'mcp_set_servers', servers: {} })).subtype).toBe('success')
    // Invalid overrides are rejected before initialize state changes; a later
    // control request can still be processed on the same stream.
    expect(await request('override', {
      subtype: 'initialize', systemPrompt: 'replace the lean profile',
    })).toMatchObject({ subtype: 'error', request_id: 'override' })
    // Exercise the actual reload control path: refreshed command discovery must
    // obey the same headless/profile boundary as the initial command pool.
    const reload = await request('reload', { subtype: 'reload_plugins' })
    expect(reload.subtype).toBe('success')
    const names = reload.response.commands.map((command: { name: string }) => command.name)
    expect(names).toContain('cost')
    expect(names).not.toContain('plan')
    expect(names).not.toContain('advisor')
    expect(names).not.toContain('goal')
    expect((await request('end', { subtype: 'end_session' })).subtype).toBe('success')
  } finally {
    input.done()
    await iterator.return?.()
    clearCommandQueue()
    setAgentProfile(originalProfile)
    mock.restore()
  }
})
