import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test'
import { mkdtemp, rm } from 'fs/promises'
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
import type { CustomAgentDefinition } from '../../tools/AgentTool/loadAgentsDir.js'
import * as runAgentModule from '../../tools/AgentTool/runAgent.js'
import { spawnTeammate } from '../../tools/shared/spawnMultiAgent.js'
import { asAgentId, type SessionId } from '../../types/ids.js'
import { createFileStateCacheWithSizeLimit } from '../fileStateCache.js'
import { drainSdkEvents } from '../sdkEventQueue.js'
import {
  type AgentMetadata,
  readAgentMetadata,
  resetProjectForTesting,
  writeAgentMetadata,
} from '../sessionStorage.js'
import {
  hasResumableInProcessTeammate,
  resumeInProcessTeammate,
} from './inProcessRunner.js'
import { readTeamFile, type TeamFile, writeTeamFileAsync } from './teamHelpers.js'

const TEAM = 'resume-team'
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

async function writeTeam(
  members: TeamFile['members'],
  createdAt = Date.now(),
): Promise<void> {
  await writeTeamFileAsync(TEAM, {
    name: TEAM,
    createdAt,
    leadAgentId: `team-lead@${TEAM}`,
    members,
  })
}

const reviewer: CustomAgentDefinition = {
  agentType: 'deep-reviewer',
  whenToUse: 'Review deeply',
  rawSystemPrompt: 'Review carefully.',
  getSystemPrompt: () => 'Review carefully.',
  source: 'projectSettings',
  tools: ['Read'],
}

beforeEach(async () => {
  configDir = await mkdtemp(join(tmpdir(), 'cc-haha-runner-resume-'))
  process.env.CLAUDE_CONFIG_DIR = configDir
  process.env.TEST_ENABLE_SESSION_PERSISTENCE = '1'
  process.env.USER_TYPE = 'external'
  resetStateForTests()
  setIsInteractive(false)
  switchSession('9e8d7c6b-5a49-4382-9716-a5b4c3d2e1f0' as SessionId)
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
      agentDefinitions: { activeAgents: [reviewer], allAgents: [reviewer] },
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
  // Every teammate run ends after one turn
  const calls: RunAgentInput[] = []
  spyOn(runAgentModule, 'runAgent').mockImplementation(async function* (
    input: RunAgentInput,
  ) {
    calls.push(input)
    for (const task of teammates()) task.abortController?.abort()
    yield* []
  })
  return { context, teammates, calls }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt++) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('condition not reached')
}

async function resumeWorker(lead: ReturnType<typeof leadContext>, name = 'worker') {
  const before = lead.calls.length
  const outcome = await resumeInProcessTeammate({
    agentName: name,
    teamName: TEAM,
    prompt: 'Carry on',
    from: 'team-lead',
    context: lead.context,
  })
  await waitFor(() => lead.calls.length === before + 1 && lead.teammates().length === 0)
  return { outcome, run: lead.calls.at(-1)! }
}

describe('resuming an in-process teammate', () => {
  test('reads metadata written before the teammate fields existed', async () => {
    await writeTeam([])
    const lead = leadContext()
    await spawnTeammate({ name: 'worker', prompt: 'Start', team_name: TEAM }, lead.context)
    await waitFor(() => lead.calls.length === 1 && lead.teammates().length === 0)
    const transcriptId = asAgentId(lead.calls[0]!.override!.agentId!)

    // A sidecar from an older version: no taskKind, no permission mode
    await writeAgentMetadata(transcriptId, { agentType: 'worker', description: 'Start' })
    expect(await readAgentMetadata(transcriptId)).toEqual({ agentType: 'worker', description: 'Start' })
    const fromOld = await resumeWorker(lead)
    expect(fromOld.outcome).toMatchObject({ kind: 'resumed' })
    expect(fromOld.run.override?.agentId).toBe(transcriptId)
    expect(fromOld.run.agentDefinition.permissionMode).toBe('default')

    const teammateMetadata: AgentMetadata = {
      agentType: 'worker',
      taskKind: 'in_process_teammate',
      teamName: TEAM,
      name: 'worker',
      permissionMode: 'acceptEdits',
    }
    await writeAgentMetadata(transcriptId, teammateMetadata)
    expect((await resumeWorker(lead)).run.agentDefinition.permissionMode).toBe('acceptEdits')

    // A file on disk never grants bypassPermissions
    await writeAgentMetadata(transcriptId, { ...teammateMetadata, permissionMode: 'bypassPermissions' })
    expect((await resumeWorker(lead)).run.agentDefinition.permissionMode).toBe('default')
  })

  test('restarts a roster member this process never ran without earlier conversation', async () => {
    await writeTeam([
      {
        agentId: `scout@${TEAM}`,
        name: 'scout',
        agentType: 'deep-reviewer',
        model: 'gpt-5.6-luna',
        color: 'green',
        joinedAt: Date.now(),
        tmuxPaneId: 'in-process',
        cwd: configDir,
        subscriptions: [],
        backendType: 'in-process',
      },
    ])
    const lead = leadContext()

    const { outcome, run } = await resumeWorker(lead, 'scout')

    expect(outcome).toMatchObject({ kind: 'resumed', resumedMessageCount: 0 })
    expect(run.forkContextMessages).toBeUndefined()
    expect(run.model).toBe('gpt-5.6-luna')
    expect(run.agentDefinition.tools).toContain('Read')
    expect(run.extraMetadata).toMatchObject({
      color: 'green',
      customAgentType: 'deep-reviewer',
    })
  })

  test('does not bring back a teammate of an earlier team with the same name', async () => {
    await writeTeam([])
    const lead = leadContext()
    await spawnTeammate({ name: 'worker', prompt: 'Start', team_name: TEAM }, lead.context)
    await waitFor(() => lead.calls.length === 1 && lead.teammates().length === 0)
    const original = readTeamFile(TEAM)!
    expect(hasResumableInProcessTeammate('worker', TEAM, original.createdAt)).toBe(true)

    // The team is deleted and created again under the same name
    await writeTeam([], original.createdAt + 1)

    expect(hasResumableInProcessTeammate('worker', TEAM, original.createdAt + 1)).toBe(false)
    await expect(
      resumeInProcessTeammate({
        agentName: 'worker',
        teamName: TEAM,
        prompt: 'Carry on',
        from: 'team-lead',
        context: lead.context,
      }),
    ).rejects.toThrow('not an in-process teammate')
    expect(lead.teammates()).toEqual([])
  })
})
