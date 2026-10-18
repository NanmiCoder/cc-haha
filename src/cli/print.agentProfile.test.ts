import { afterAll, expect, test } from 'bun:test'
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

test('lean rejects SDK subagent resume at the streaming control boundary', async () => {
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
      error: '--agent-profile lean does not support SDK send_agent_message or resuming subagents.',
    })
    expect(state.tasks).toEqual({})
    expect(await request('plan', { subtype: 'set_permission_mode', mode: 'plan' })).toMatchObject({ subtype: 'error', request_id: 'plan' })
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
  }
})
