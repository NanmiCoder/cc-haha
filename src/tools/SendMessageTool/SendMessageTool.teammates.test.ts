import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  resetStateForTests,
  setIsInteractive,
  switchSession,
} from '../../bootstrap/state.js'
import * as promptsModule from '../../constants/prompts.js'
import type { AppState } from '../../state/AppState.js'
import type { ToolUseContext } from '../../Tool.js'
import type { InProcessTeammateTaskState } from '../../tasks/InProcessTeammateTask/types.js'
import { asAgentId, type SessionId } from '../../types/ids.js'
import type { Message } from '../../types/message.js'
import { createFileStateCacheWithSizeLimit } from '../../utils/fileStateCache.js'
import {
  createAssistantMessage,
  createUserMessage,
} from '../../utils/messages.js'
import { drainSdkEvents } from '../../utils/sdkEventQueue.js'
import {
  flushSessionStorage,
  recordSidechainTranscript,
  resetProjectForTesting,
} from '../../utils/sessionStorage.js'
import { teamPlanRecordSchema } from '../../shared/teamPlan.js'
import {
  getTeamDir,
  readTeamFile,
  removeMemberByAgentId,
  type TeamFile,
  writeTeamFileAsync,
} from '../../utils/swarm/teamHelpers.js'
import { readMailbox } from '../../utils/teammateMailbox.js'
import * as runAgentModule from '../AgentTool/runAgent.js'
import { spawnTeammate } from '../shared/spawnMultiAgent.js'
import { SendMessageTool } from './SendMessageTool.js'

const TEAM = 'msg-team'
type RunAgentInput = Parameters<typeof runAgentModule.runAgent>[0]

const savedEnv = {
  configDir: process.env.CLAUDE_CONFIG_DIR,
  persistence: process.env.TEST_ENABLE_SESSION_PERSISTENCE,
  userType: process.env.USER_TYPE,
}
let configDir: string

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

async function writeTeam(members: TeamFile['members']): Promise<void> {
  await writeTeamFileAsync(TEAM, {
    name: TEAM,
    createdAt: Date.now(),
    leadAgentId: `team-lead@${TEAM}`,
    members,
  })
}

/** A desktop team plan whose members have no roster entry yet. */
async function writeTeamPlan(state: string, memberNames: string[]): Promise<void> {
  const runtime = { providerId: 'claude-official', modelId: 'claude-sonnet-4-6' }
  const plan = teamPlanRecordSchema.parse({
    schemaVersion: 1,
    planId: 'plan-1',
    sessionId: 'lead-session',
    teamName: TEAM,
    incarnationId: 'incarnation-1',
    revision: 1,
    state,
    workDir: configDir,
    leaderRuntime: runtime,
    members: memberNames.map(name => ({
      id: name,
      name,
      agentType: 'general-purpose',
      prompt: `Work as ${name}`,
      runtime,
    })),
    tasks: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  })
  await writeFile(join(getTeamDir(TEAM), 'plan.json'), JSON.stringify(plan))
}

function member(
  name: string,
  extra: Partial<TeamFile['members'][number]> = {},
): TeamFile['members'][number] {
  return {
    agentId: `${name}@${TEAM}`,
    name,
    joinedAt: Date.now(),
    tmuxPaneId: '',
    cwd: configDir,
    subscriptions: [],
    ...extra,
  }
}

beforeEach(async () => {
  configDir = await mkdtemp(join(tmpdir(), 'cc-haha-send-teammates-'))
  process.env.CLAUDE_CONFIG_DIR = configDir
  process.env.TEST_ENABLE_SESSION_PERSISTENCE = '1'
  process.env.USER_TYPE = 'external'
  resetStateForTests()
  setIsInteractive(false)
  switchSession('3c9d5a1e-6b7f-4c2d-8e9f-0a1b2c3d4e5f' as SessionId)
  resetProjectForTesting()
  spyOn(promptsModule, 'getSystemPrompt').mockResolvedValue(['System prompt'])
})

afterEach(async () => {
  mock.restore()
  drainSdkEvents()
  resetProjectForTesting()
  resetStateForTests()
  restoreEnv('CLAUDE_CONFIG_DIR', savedEnv.configDir)
  restoreEnv('TEST_ENABLE_SESSION_PERSISTENCE', savedEnv.persistence)
  restoreEnv('USER_TYPE', savedEnv.userType)
  await rm(configDir, { recursive: true, force: true })
})

function leadContext() {
  let state = {
    mainLoopModel: 'claude-sonnet-4-6',
    toolPermissionContext: { mode: 'default' },
    teamContext: {
      teamName: TEAM,
      teamFilePath: '',
      leadAgentId: `team-lead@${TEAM}`,
      teammates: {},
    },
    agentNameRegistry: new Map(),
    tasks: {},
  } as unknown as AppState
  const context = {
    getAppState: () => state,
    setAppState: (updater: (previous: AppState) => AppState) => {
      state = updater(state)
    },
    options: {
      agentDefinitions: { activeAgents: [], allAgents: [] },
      tools: [],
      mainLoopModel: 'claude-sonnet-4-6',
      mcpClients: [],
      thinkingConfig: { type: 'disabled' },
    },
    abortController: new AbortController(),
    readFileState: createFileStateCacheWithSizeLimit(10),
    messages: [],
  } as unknown as ToolUseContext
  const teammates = () =>
    Object.values(state.tasks).filter(
      (task): task is InProcessTeammateTaskState =>
        task.type === 'in_process_teammate',
    )
  return { context, teammates }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt++) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('condition not reached')
}

async function send(
  context: ToolUseContext,
  to: string,
  message: string,
): Promise<{ success: boolean; message: string }> {
  const result = await SendMessageTool.call(
    { to, summary: 'next step', message } as never,
    context,
    undefined as never,
    undefined as never,
  )
  return result.data as { success: boolean; message: string }
}

/** Spawns `worker` as an in-process teammate whose runner then stops. */
async function spawnAndStopWorker(lead: ReturnType<typeof leadContext>) {
  const calls: RunAgentInput[] = []
  spyOn(runAgentModule, 'runAgent').mockImplementation(async function* (
    input: RunAgentInput,
  ) {
    calls.push(input)
    // Every run ends its teammate after one turn
    for (const task of lead.teammates()) task.abortController?.abort()
    yield* []
  })
  await spawnTeammate(
    { name: 'worker', prompt: 'Fix the parser', team_name: TEAM },
    lead.context,
  )
  await waitFor(() => calls.length === 1 && lead.teammates().length === 0)
  return calls
}

describe('SendMessage to an in-process teammate that is not running', () => {
  test('resumes it from its transcript with the message as its next prompt', async () => {
    await writeTeam([])
    const lead = leadContext()
    const calls = await spawnAndStopWorker(lead)
    const transcriptId = calls[0]!.override?.agentId
    // What the teammate's runs recorded before it stopped
    const earlier: Message[] = [
      createUserMessage({ content: 'Fix the parser' }),
      createAssistantMessage({ content: 'Fixed the parser.' }),
    ]
    if (transcriptId) {
      await recordSidechainTranscript(earlier, transcriptId)
      await flushSessionStorage()
    }
    // It also left the roster, as a teammate that approved shutdown does
    await removeMemberByAgentId(TEAM, `worker@${TEAM}`)

    const result = await send(lead.context, 'worker', 'Please update the docs too')

    expect(result).toEqual({
      success: true,
      message:
        'Teammate "worker" was not running; resumed it as an in-process teammate with 2 prior messages and your message as its next prompt.',
    })
    expect(transcriptId).toBeString()
    await waitFor(() => calls.length === 2)
    const resumed = calls[1]!
    expect(resumed.override?.agentId).toBe(asAgentId(transcriptId!))
    expect(resumed.forkContextMessages?.map(message => message.uuid)).toEqual(
      earlier.map(message => message.uuid),
    )
    const prompt = resumed.promptMessages[0]!.message.content as string
    expect(prompt).toContain('Please update the docs too')
    expect(prompt).toContain('teammate_id="team-lead"')
    expect(readTeamFile(TEAM)?.members).toContainEqual(
      expect.objectContaining({ agentId: `worker@${TEAM}`, backendType: 'in-process' }),
    )
    // Delivered as the prompt, not left in an inbox nobody reads
    expect((await readMailbox('worker', TEAM)).filter(m => !m.read)).toEqual([])
    await waitFor(() => lead.teammates().length === 0)
  })

  test('resumes only once when two messages race, and keeps the second for its next turn', async () => {
    await writeTeam([])
    const lead = leadContext()
    const calls = await spawnAndStopWorker(lead)
    // Keep the resumed teammate alive so the second message has a live target
    let releaseResumed: (() => void) | undefined
    spyOn(runAgentModule, 'runAgent').mockImplementation(async function* (
      input: RunAgentInput,
    ) {
      calls.push(input)
      await new Promise<void>(resolve => {
        releaseResumed = resolve
      })
      for (const task of lead.teammates()) task.abortController?.abort()
      yield* []
    })

    const results = await Promise.all([
      send(lead.context, 'worker', 'First follow-up'),
      send(lead.context, 'worker', 'Second follow-up'),
    ])

    const resumedResults = results.filter(result =>
      result.message.includes('was not running; resumed it'),
    )
    expect(resumedResults).toHaveLength(1)
    expect(results.every(result => result.success)).toBe(true)
    expect(lead.teammates().filter(task => task.status === 'running')).toHaveLength(1)
    const queued = (await readMailbox('worker', TEAM)).filter(m => !m.read)
    expect(queued).toHaveLength(1)
    await waitFor(() => releaseResumed !== undefined)
    releaseResumed!()
    await waitFor(() => lead.teammates().length === 0)
  })
})

describe('SendMessage to other recipients', () => {
  test('rejects a name that is not on the team instead of writing an orphan inbox', async () => {
    await writeTeam([member('worker', { backendType: 'tmux' })])
    const lead = leadContext()

    expect(await send(lead.context, 'ghost', 'Anyone there?')).toEqual({
      success: false,
      message:
        "No teammate named 'ghost' is currently on team 'msg-team'. Spawn one with the Agent tool (name: 'ghost') first.",
    })
    expect(await readMailbox('ghost', TEAM)).toEqual([])
  })

  test('queues a message for a member whose team plan awaits approval', async () => {
    await writeTeam([])
    await writeTeamPlan('review_pending', ['reviewer'])
    const lead = leadContext()

    expect(await send(lead.context, 'reviewer', 'Start with the parser')).toMatchObject({
      success: true,
      message:
        'reviewer has not started yet; it reads your message once the user approves the team plan.',
    })
    expect((await readMailbox('reviewer', TEAM)).map(m => m.text)).toEqual([
      'Start with the parser',
    ])
  })

  test('rejects a member of a team plan that was cancelled', async () => {
    await writeTeam([])
    await writeTeamPlan('cancelled', ['reviewer'])
    const lead = leadContext()

    expect(await send(lead.context, 'reviewer', 'Start with the parser')).toMatchObject({
      success: false,
    })
    expect(await readMailbox('reviewer', TEAM)).toEqual([])
  })

  test('tells the lead a stopped desktop member is restarting to read the message', async () => {
    await writeTeam([member('builder', { backendType: 'process', terminated: true })])
    const lead = leadContext()

    const result = await send(lead.context, 'builder', 'Rebuild with the fix')

    expect(result).toMatchObject({
      success: true,
      message:
        'builder was stopped; it is restarting from its saved conversation to read your message.',
    })
    expect((await readMailbox('builder', TEAM)).map(m => m.text)).toEqual([
      'Rebuild with the fix',
    ])
    // The server restarts process members; they never run in-process here
    expect(lead.teammates()).toEqual([])
  })

  test('writes to a running desktop member and a pane teammate as before', async () => {
    await writeTeam([
      member('builder', { backendType: 'process' }),
      member('painter', { backendType: 'tmux' }),
    ])
    const lead = leadContext()

    expect(await send(lead.context, 'builder', 'Status?')).toMatchObject({
      success: true,
      message: "Message sent to builder's inbox",
    })
    expect(await send(lead.context, 'painter', 'Status?')).toMatchObject({
      success: true,
      message: "Message sent to painter's inbox",
    })
    expect(lead.teammates()).toEqual([])
  })
})
