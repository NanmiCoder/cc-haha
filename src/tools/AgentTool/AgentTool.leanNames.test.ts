import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getSessionId, getSessionProjectDir, switchSession } from '../../bootstrap/state.js'
import * as prompts from '../../constants/prompts.js'
import type { ToolUseContext } from '../../Tool.js'
import { getDefaultAppState } from '../../state/AppStateStore.js'
import * as tasks from '../../tasks/LocalAgentTask/LocalAgentTask.js'
import { asAgentId, type SessionId } from '../../types/ids.js'
import { getAgentProfile, setAgentProfile } from '../../utils/agentProfile.js'
import { AbortError } from '../../utils/errors.js'
import { createFileStateCacheWithSizeLimit } from '../../utils/fileStateCache.js'
import { createAssistantMessage, createUserInterruptionMessage, createUserMessage } from '../../utils/messages.js'
import { flushSessionStorage, recordSidechainTranscript, resetProjectForTesting, writeAgentMetadata } from '../../utils/sessionStorage.js'
import { resetSettingsCache } from '../../utils/settings/settingsCache.js'
import { SendMessageTool } from '../SendMessageTool/SendMessageTool.js'
import { AgentTool } from './AgentTool.js'
import { EXPLORE_AGENT } from './built-in/exploreAgent.js'
import { GENERAL_PURPOSE_AGENT } from './built-in/generalPurposeAgent.js'
import * as agentRunner from './runAgent.js'

const allow = (async () => ({ behavior: 'allow' })) as never
const sourceMessage = createAssistantMessage({ content: 'Inspect the parser.' })
const tick = () => new Promise<void>(resolve => setImmediate(resolve))
const originalProfile = getAgentProfile()
const savedEnv = {
  configDir: process.env.CLAUDE_CONFIG_DIR,
  persistence: process.env.TEST_ENABLE_SESSION_PERSISTENCE,
}
let previousSession: { id: SessionId; projectDir: string | null }
let configDir: string
let context: ToolUseContext
let runner: ReturnType<typeof spyOn<typeof agentRunner, 'runAgent'>>

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(r => { resolve = r })
  return { promise, resolve }
}

function spawn(input: Partial<Parameters<typeof AgentTool.call>[0]> = {}) {
  return AgentTool.call({
    description: 'Inspect parser', prompt: 'Inspect the parser.',
    subagent_type: 'general-purpose', name: 'researcher', ...input,
  }, context, allow, sourceMessage)
}

function send(to: string) {
  return SendMessageTool.call({ to, message: 'Also inspect tests.' }, context, allow, sourceMessage)
}

function holdNextRun() {
  const started = deferred<string>()
  const terminal = deferred<void>()
  runner.mockImplementationOnce(async function* (params) {
    started.resolve(params.override!.agentId!)
    await terminal.promise
    yield createAssistantMessage({ content: 'Inspection complete.' })
  })
  return { started: started.promise, finish: () => terminal.resolve() }
}

beforeEach(() => {
  previousSession = { id: getSessionId(), projectDir: getSessionProjectDir() }
  configDir = mkdtempSync(join(tmpdir(), 'cc-haha-lean-names-'))
  process.env.CLAUDE_CONFIG_DIR = configDir
  process.env.TEST_ENABLE_SESSION_PERSISTENCE = '1'
  switchSession('62b92be7-2304-43f0-9dd5-7c78ad20a1ef' as SessionId, join(configDir, 'project'))
  resetProjectForTesting()
  resetSettingsCache()
  setAgentProfile('lean')
  const agents = [GENERAL_PURPOSE_AGENT, EXPLORE_AGENT]
  let state = {
    ...getDefaultAppState(),
    agentDefinitions: { activeAgents: agents, allAgents: agents },
  }
  context = {
    options: {
      commands: [], mainLoopModel: 'sonnet', tools: [], mcpClients: [],
      mcpResources: {}, isNonInteractiveSession: true, agentDefinitions: state.agentDefinitions,
    },
    abortController: new AbortController(),
    readFileState: createFileStateCacheWithSizeLimit(),
    getAppState: () => state,
    setAppState: update => { state = update(state) },
    setResponseLength: () => {},
    messages: [createUserMessage({ content: 'Inspect the parser.' })],
    toolUseId: 'lean-name-fixture',
  } as unknown as ToolUseContext
  spyOn(prompts, 'enhanceSystemPromptWithEnvDetails').mockResolvedValue(['Fixture system prompt'])
  spyOn(tasks, 'enqueueAgentNotification').mockImplementation(() => {})
  runner = spyOn(agentRunner, 'runAgent').mockImplementation(async function* (params) {
    const agentId = params.override!.agentId!
    const answer = createAssistantMessage({ content: 'Inspection complete.' })
    await recordSidechainTranscript([...params.promptMessages, answer], agentId)
    await writeAgentMetadata(agentId, { agentType: params.agentDefinition.agentType })
    yield answer
  })
})

afterEach(async () => {
  await tick()
  await flushSessionStorage()
  mock.restore()
  setAgentProfile(originalProfile)
  resetProjectForTesting()
  resetSettingsCache()
  restoreEnv('CLAUDE_CONFIG_DIR', savedEnv.configDir)
  restoreEnv('TEST_ENABLE_SESSION_PERSISTENCE', savedEnv.persistence)
  switchSession(previousSession.id, previousSession.projectDir)
  rmSync(configDir, { recursive: true, force: true })
})

describe('lean Agent names and continuation addresses', () => {
  test.each(['general-purpose', 'Explore'])('continues a completed foreground %s by name using its transcript', async subagent_type => {
    const result = await spawn({ subagent_type })
    expect(result.data.status).toBe('completed')
    expect(context.getAppState().agentNameRegistry.get('researcher')).toBe(result.data.agentId)
    expect(context.getAppState().tasks[result.data.agentId]).toBeUndefined()
    expect((await send('researcher')).data.success).toBe(true)
    await tick()
    const resumed = runner.mock.calls[1]![0]
    expect(resumed.override?.agentId).toBe(result.data.agentId)
    expect(resumed.agentDefinition.agentType).toBe(subagent_type)
    expect(resumed.promptMessages).toHaveLength(3)
    expect(JSON.stringify(resumed.promptMessages)).toContain('Inspection complete.')
    expect(JSON.stringify(resumed.promptMessages.at(-1))).toContain('Also inspect tests.')
  })

  test('returns a usable continuation address for an unnamed foreground Explore', async () => {
    const result = await spawn({ subagent_type: 'Explore', name: undefined })
    const mapped = AgentTool.mapToolResultToToolResultBlockParam(result.data, 'fixture-result')
    const continuationId = JSON.stringify(mapped).match(/agentId: (a[0-9a-f]+)/)?.[1]
    expect(continuationId).toBe(result.data.agentId)
    expect((await send(continuationId!)).data.success).toBe(true)
    await tick()
    expect(runner.mock.calls[1]![0].override?.agentId).toBe(result.data.agentId)
  })

  test.each([false, true])('routes names while a worker is in the background (started there: %s)', async startedInBackground => {
    const held = holdNextRun()
    const running = spawn({ run_in_background: startedInBackground })
    try {
      const agentId = await held.started
      if (!startedInBackground) {
        expect(tasks.backgroundAgentTask(agentId, context.getAppState, context.setAppState)).toBe(true)
      }
      expect((await running).data.status).toBe('async_launched')
      expect(context.getAppState().agentNameRegistry.get('researcher')).toBe(agentId)
      expect((await send('researcher')).data.success).toBe(true)
      expect(tasks.drainPendingMessages(agentId, context.getAppState, context.setAppState)).toEqual(['Also inspect tests.'])
      held.finish()
      await tick()
      expect(context.getAppState().tasks[agentId]?.status).toBe('completed')
      expect(context.getAppState().agentNameRegistry.get('researcher')).toBe(agentId)
    } finally {
      held.finish()
      await running
      await tick()
    }
  })

  test.each(['error', 'partial-error', 'abort', 'interruption'] as const)('preserves the previous name mapping when foreground execution ends with %s', async outcome => {
    const previousId = asAgentId('a0123456789abcdef')
    context.setAppState(state => ({ ...state, agentNameRegistry: new Map([['researcher', previousId]]) }))
    runner.mockImplementationOnce(async function* () {
      if (outcome === 'partial-error') yield createAssistantMessage({ content: 'Partial inspection.' })
      if (outcome === 'interruption') {
        yield createUserInterruptionMessage({})
        return
      }
      if (outcome === 'abort') throw new AbortError()
      throw new Error('Fixture worker failed')
    })
    if (outcome === 'partial-error') expect((await spawn()).data.status).toBe('completed')
    else await expect(spawn()).rejects.toThrow()
    expect(context.getAppState().agentNameRegistry.get('researcher')).toBe(previousId)
  })

  test.each([false, true])('does not register a name if task registration fails (background: %s)', async run_in_background => {
    const register = run_in_background ? 'registerAsyncAgent' : 'registerAgentForeground'
    spyOn(tasks, register).mockImplementationOnce(() => { throw new Error('Fixture registration failed') })
    await expect(spawn({ run_in_background })).rejects.toThrow('Fixture registration failed')
    expect(context.getAppState().agentNameRegistry.has('researcher')).toBe(false)
    expect(runner).not.toHaveBeenCalled()
  })

  test('preserves standard foreground name and one-shot result behavior', async () => {
    setAgentProfile('standard')
    const result = await spawn({ subagent_type: 'Explore' })
    expect(context.getAppState().agentNameRegistry.has('researcher')).toBe(false)
    const mapped = AgentTool.mapToolResultToToolResultBlockParam(result.data, 'fixture-result')
    expect(JSON.stringify(mapped)).not.toContain(result.data.agentId)
    expect(JSON.stringify(mapped)).toContain('Inspection complete.')
  })
})
