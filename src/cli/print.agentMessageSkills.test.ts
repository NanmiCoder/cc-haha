import { afterAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSandboxedTestEnvironment } from '../../scripts/pr/test-environment.js'
import type { ToolUseContext } from '../Tool.js'
import type { SDKControlResponse } from '../entrypoints/sdk/controlTypes.js'
import type { AppState } from '../state/AppState.js'
import { getAgentProfile, setAgentProfile } from '../utils/agentProfile.js'

const home = mkdtempSync(join(tmpdir(), 'lean-running-human-'))
const originalEnv = { ...process.env }
const originalProfile = getAgentProfile()
for (const key of Object.keys(process.env)) delete process.env[key]
Object.assign(process.env, createSandboxedTestEnvironment(home, { ANTHROPIC_API_KEY: 'fixture-control-key' }, originalEnv))
const { __runHeadlessStreamingForTests } = await import('./print.js')
const { StructuredIO } = await import('./structuredIO.js')
const { Stream } = await import('../utils/stream.js')
const { getDefaultAppState } = await import('../state/AppStateStore.js')
const { clearCommandQueue } = await import('../utils/messageQueueManager.js')
const { createUserMessage } = await import('../utils/messages.js')
const { getAgentPendingMessageAttachments } = await import('../utils/attachments.js')
const { getSkillSelectionMessages, isExplicitSkillRequest } = await import('../tools/SkillTool/explicitSkillRequest.js')
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

test.each(['lean', 'standard'] as const)('SDK running-agent messages preserve human skill provenance in %s mode', async profile => {
  setAgentProfile(profile)
  clearCommandQueue()
  const agentId = 'a0123456789abcdef'
  const input = new Stream<string>()
  let state: AppState = {
    ...getDefaultAppState(),
    tasks: { [agentId]: { type: 'local_agent', agentId, status: 'running', pendingMessages: [] } as never },
  }
  const getAppState = () => state
  const setAppState = (update: (value: typeof state) => typeof state) => { state = update(state) }
  const output = __runHeadlessStreamingForTests(new StructuredIO(input), [], [], [], [], (() => undefined) as never, {}, getAppState, setAppState, [], { outputFormat: 'stream-json' })
  const iterator = output[Symbol.asyncIterator]()
  async function request(id: string, request: unknown) {
    input.enqueue(JSON.stringify({ type: 'control_request', request_id: id, request }) + '\n')
    while (true) {
      const item = await iterator.next()
      if (item.done) throw new Error('Missing control response')
      if (item.value.type === 'control_response') return (item.value as SDKControlResponse).response
    }
  }
  const child = {
    agentId, getAppState, setAppState, messages: [],
    skillSelectionState: { messages: [createUserMessage({ content: 'Use $old.' })] },
  } as unknown as ToolUseContext
  const selects = (name: string) => isExplicitSkillRequest(getSkillSelectionMessages(child), name)
  try {
    expect(await request('select', {
      subtype: 'send_agent_message', agent_id: agentId, content: 'Use $new-review for this task.',
    })).toMatchObject({ subtype: 'success', response: { delivery: 'queued' } })
    expect(selects('old')).toBe(true)
    expect(selects('new-review')).toBe(false)
    expect(getAgentPendingMessageAttachments({ ...child })).toMatchObject([
      { prompt: 'Use $new-review for this task.', origin: { kind: 'coordinator' }, isMeta: true },
    ])
    expect(selects('new-review')).toBe(profile === 'lean')
    expect(selects('old')).toBe(profile === 'standard')

    expect(await request('new-task', {
      subtype: 'send_agent_message', agent_id: agentId, content: 'Now inspect a different file.',
    })).toMatchObject({ subtype: 'success', response: { delivery: 'queued' } })
    getAgentPendingMessageAttachments({ ...child })
    expect(selects('new-review')).toBe(false)
    expect(selects('old')).toBe(profile === 'standard')
    expect((await request('end', { subtype: 'end_session' })).subtype).toBe('success')
  } finally {
    input.done()
    await iterator.return?.()
    clearCommandQueue()
  }
})
