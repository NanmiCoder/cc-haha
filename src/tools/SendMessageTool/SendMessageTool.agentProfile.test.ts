import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getDefaultAppState } from '../../state/AppStateStore.js'
import type { ToolUseContext } from '../../Tool.js'
import * as localAgentTask from '../../tasks/LocalAgentTask/LocalAgentTask.js'
import { asAgentId } from '../../types/ids.js'
import { getAgentProfile, setAgentProfile } from '../../utils/agentProfile.js'
import { createAssistantMessage, createUserMessage } from '../../utils/messages.js'
import * as sessionStorage from '../../utils/sessionStorage.js'
import { resetSettingsCache } from '../../utils/settings/settingsCache.js'
import * as agentToolUtils from '../AgentTool/agentToolUtils.js'
import { GENERAL_PURPOSE_AGENT } from '../AgentTool/built-in/generalPurposeAgent.js'
import * as agentRunner from '../AgentTool/runAgent.js'
import { SendMessageTool } from './SendMessageTool.js'

const originalProfile = getAgentProfile()
const originalConfig = process.env.CLAUDE_CONFIG_DIR
const originalTeams = process.env.CC_HAHA_AGENT_TEAMS_ENABLED
const agentId = asAgentId('a0123456789abcdef')
let configDir: string
let context: ToolUseContext

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), 'cc-haha-lean-message-'))
  process.env.CLAUDE_CONFIG_DIR = configDir
  process.env.CC_HAHA_AGENT_TEAMS_ENABLED = '0'
  resetSettingsCache()
  setAgentProfile('lean')
  let state = {
    ...getDefaultAppState(),
    agentNameRegistry: new Map([['worker', agentId]]),
  }
  context = {
    options: {
      mainLoopModel: 'sonnet', tools: [], mcpClients: [],
      agentDefinitions: { activeAgents: [GENERAL_PURPOSE_AGENT], allAgents: [GENERAL_PURPOSE_AGENT] },
    },
    abortController: new AbortController(),
    getAppState: () => state,
    setAppState: update => { state = update(state) },
    setResponseLength: () => {},
    messages: [],
  } as unknown as ToolUseContext
})

afterEach(async () => {
  await new Promise<void>(resolve => setImmediate(resolve))
  mock.restore()
  setAgentProfile(originalProfile)
  resetSettingsCache()
  if (originalConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = originalConfig
  if (originalTeams === undefined) delete process.env.CC_HAHA_AGENT_TEAMS_ENABLED
  else process.env.CC_HAHA_AGENT_TEAMS_ENABLED = originalTeams
  rmSync(configDir, { recursive: true, force: true })
})

function send(input: Parameters<typeof SendMessageTool.call>[0]) {
  return SendMessageTool.call(input, context,
    (async () => ({ behavior: 'allow' })) as never,
    createAssistantMessage({ content: 'Continue the worker.' }))
}

describe('lean subagent follow-ups', () => {
  test('offers a compact plain-text schema even with teams disabled', async () => {
    expect(SendMessageTool.isEnabled()).toBe(true)
    expect(SendMessageTool.inputSchema.safeParse({ to: 'worker', message: 'Continue.' }).success).toBe(true)
    const structured = { to: 'worker', message: { type: 'shutdown_request' } }
    expect(SendMessageTool.inputSchema.safeParse(structured).success).toBe(false)
    expect((await SendMessageTool.prompt({} as never)).length).toBeLessThan(600)
    setAgentProfile('standard')
    expect(SendMessageTool.inputSchema.safeParse(structured).success).toBe(true)
    expect(SendMessageTool.isEnabled()).toBe(false)
    setAgentProfile('lean')
    expect(SendMessageTool.inputSchema.safeParse(structured).success).toBe(false)
  })

  test('queues follow-ups on a running ordinary subagent', async () => {
    context.setAppState(state => ({ ...state, tasks: {
      [agentId]: {
        type: 'local_agent', status: 'running', agentId,
        pendingMessages: [], isBackgrounded: true,
      } as unknown as localAgentTask.LocalAgentTaskState,
    } }))
    expect((await send({ to: 'worker', message: 'Also inspect the tests.' })).data.success).toBe(true)
    expect(localAgentTask.drainPendingMessages(agentId, context.getAppState, context.setAppState)).toEqual(['Also inspect the tests.'])
  })

  test.each(['*', 'worker@team', 'uds:/tmp/fixture', 'bridge:fixture', 'unknown-teammate'])('does not fall through to team or external messaging for %s', async to => {
    expect((await send({ to, message: 'Continue.' })).data.success).toBe(false)
    expect(context.getAppState().tasks).toEqual({})
  })

  test('rejects structured team controls even when called without schema validation', async () => {
    expect((await send({ to: 'worker', message: { type: 'shutdown_request' } })).data).toMatchObject({
      success: false, message: expect.stringContaining('ordinary subagents only'),
    })
  })

  test('resumes a completed subagent with its transcript and a lean built-in definition', async () => {
    const history = [createUserMessage({ content: 'Inspect source.' }), createAssistantMessage({ content: 'Inspected source.' })]
    spyOn(sessionStorage, 'getAgentTranscript').mockResolvedValue({ messages: history, contentReplacements: [] })
    spyOn(sessionStorage, 'readAgentMetadata').mockResolvedValue({ agentType: 'general-purpose', description: 'Original inspection' })
    spyOn(localAgentTask, 'registerAsyncAgent').mockReturnValue({ agentId, abortController: new AbortController() } as never)
    let lifecycle: Parameters<typeof agentToolUtils.runAsyncAgentLifecycle>[0] | undefined
    spyOn(agentToolUtils, 'runAsyncAgentLifecycle').mockImplementation(async params => { lifecycle = params })
    const runner = spyOn(agentRunner, 'runAgent').mockImplementation(async function* () {})
    expect((await send({ to: 'worker', message: 'Now inspect tests.' })).data.success).toBe(true)
    lifecycle?.makeStream(undefined)
    const params = runner.mock.calls[0]?.[0]
    expect(params?.agentDefinition.getSystemPrompt({ toolUseContext: context })).toContain('You are a subagent completing the assigned task')
    expect(params?.promptMessages.slice(0, 2)).toEqual(history)
    expect(JSON.stringify(params?.promptMessages.at(-1))).toContain('Now inspect tests.')
    expect(params?.isAsync).toBe(true)
    expect(params?.override?.systemPrompt).toBeUndefined()
  })

  test.each(['custom-agent', 'fork'])('does not restore unsupported %s metadata as a general-purpose agent', async agentType => {
    spyOn(sessionStorage, 'getAgentTranscript').mockResolvedValue({ messages: [], contentReplacements: [] })
    spyOn(sessionStorage, 'readAgentMetadata').mockResolvedValue({ agentType })
    const runner = spyOn(agentRunner, 'runAgent')
    expect((await send({ to: 'worker', message: 'Continue.' })).data).toMatchObject({
      success: false, message: expect.stringContaining('unavailable in lean mode'),
    })
    expect(runner).not.toHaveBeenCalled()
  })
})
