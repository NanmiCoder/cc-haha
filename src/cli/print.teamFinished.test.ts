import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { writeTeamFileAsync, type TeamFile } from '../utils/swarm/teamHelpers.js'
import {
  beginTaskListLifecycle,
  createTask,
  getCanonicalTeamTaskListId,
  updateTask,
  withTaskListLifecycleLock,
} from '../utils/tasks.js'
import {
  takeTeamFinishedPrompt,
  TEAM_FINISHED_SETTLE_MS,
  type TeamFinishedReminderState,
} from './print.js'

const TEAM = 'print-finished-team'
const CREATED_AT = 1_790_000_000_000

let configDir: string
let originalConfigDir: string | undefined

beforeEach(async () => {
  originalConfigDir = process.env.CLAUDE_CONFIG_DIR
  configDir = await mkdtemp(join(tmpdir(), 'cc-haha-print-team-finished-'))
  process.env.CLAUDE_CONFIG_DIR = configDir
  const taskListId = getCanonicalTeamTaskListId(TEAM)
  await withTaskListLifecycleLock(taskListId, () => beginTaskListLifecycle(taskListId, {
    teamName: TEAM, createdAt: CREATED_AT, leadSessionId: 'lead-session',
  }))
})

afterEach(async () => {
  if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = originalConfigDir
  await rm(configDir, { recursive: true, force: true })
})

type MemberState = Pick<TeamFile['members'][number], 'isActive' | 'terminated' | 'autoRetry'>

async function writeTeam(members: Record<string, MemberState>, reviewRequired = true): Promise<void> {
  await writeTeamFileAsync(TEAM, {
    name: TEAM, createdAt: CREATED_AT, leadAgentId: `team-lead@${TEAM}`, leadSessionId: 'lead-session',
    ...(reviewRequired ? { reviewRequired: true } : {}),
    members: [
      { agentId: `team-lead@${TEAM}`, name: 'team-lead', joinedAt: CREATED_AT, tmuxPaneId: '', cwd: configDir, subscriptions: [] },
      ...Object.entries(members).map(([name, state]) => ({
        agentId: `${name}@${TEAM}`, name, joinedAt: CREATED_AT, tmuxPaneId: '', cwd: configDir, subscriptions: [],
        backendType: 'process' as const, sessionId: `${name}-session`, ...state,
      })),
    ],
  })
}

async function addTask(status: 'pending' | 'in_progress' | 'completed'): Promise<string> {
  return createTask(getCanonicalTeamTaskListId(TEAM), {
    subject: 'work', description: '', status, blocks: [], blockedBy: [],
  })
}

/** Polls the way the idle lead does, from first sight of a state until it settles. */
async function settle(state: TeamFinishedReminderState, start: number) {
  expect(await takeTeamFinishedPrompt(state, TEAM, start)).toBeNull()
  expect(await takeTeamFinishedPrompt(state, TEAM, start + TEAM_FINISHED_SETTLE_MS - 1)).toBeNull()
  return takeTeamFinishedPrompt(state, TEAM, start + TEAM_FINISHED_SETTLE_MS)
}

describe('desktop lead reminder once its approved team has finished', () => {
  test('reminds the idle lead once, naming only the members still running', async () => {
    await writeTeam({
      builder: { isActive: false },
      reviewer: { isActive: false },
      releaser: { isActive: false, terminated: true },
    })
    await addTask('completed')
    await addTask('completed')
    const state: TeamFinishedReminderState = {}

    const prompt = await settle(state, 1_000)

    expect(prompt?.isMeta).toBe(true)
    expect(prompt?.mode).toBe('prompt')
    expect(prompt?.value).toContain(`your team ${TEAM} is completed`)
    expect(prompt?.value).toContain('send each of builder, reviewer its own shutdown_request')
    expect(prompt?.value).not.toContain('releaser')
    expect(prompt?.value).toContain('TeamDelete')
    // The same finished state never brings the lead back.
    expect(await takeTeamFinishedPrompt(state, TEAM, 60_000)).toBeNull()
    expect(await takeTeamFinishedPrompt(state, TEAM, 600_000)).toBeNull()
  })

  test('waits while any task is open or any member is still in a turn', async () => {
    await writeTeam({ builder: { isActive: false }, reviewer: { isActive: true } })
    await addTask('completed')
    const open = await addTask('in_progress')
    const state: TeamFinishedReminderState = {}

    expect(await settle(state, 1_000)).toBeNull()

    await updateTask(getCanonicalTeamTaskListId(TEAM), open, { status: 'completed' })
    // The last member is still finishing its turn.
    expect(await settle(state, 10_000)).toBeNull()

    await writeTeam({ builder: { isActive: false }, reviewer: { isActive: false, autoRetry: { attempt: 1, max: 3, nextAt: 99_000 } } })
    // A member waiting on an automatic retry is not done either.
    expect(await settle(state, 20_000)).toBeNull()

    await writeTeam({ builder: { isActive: false }, reviewer: { isActive: false } })
    expect((await settle(state, 30_000))?.value).toContain('builder, reviewer')
  })

  test('a finished state that changes before it settles restarts the wait', async () => {
    await writeTeam({ builder: { isActive: false } })
    await addTask('completed')
    const state: TeamFinishedReminderState = {}

    expect(await takeTeamFinishedPrompt(state, TEAM, 1_000)).toBeNull()
    // The member picks up new work, which it finishes almost at once.
    await addTask('completed')
    expect(await takeTeamFinishedPrompt(state, TEAM, 1_000 + TEAM_FINISHED_SETTLE_MS)).toBeNull()
    expect(await takeTeamFinishedPrompt(state, TEAM, 1_000 + 2 * TEAM_FINISHED_SETTLE_MS)).not.toBeNull()
  })

  test('work assigned after the reminder earns a new one when it finishes', async () => {
    await writeTeam({ builder: { isActive: false } })
    await addTask('completed')
    const state: TeamFinishedReminderState = {}
    expect(await settle(state, 1_000)).not.toBeNull()

    const followUp = await addTask('in_progress')
    expect(await settle(state, 10_000)).toBeNull()
    await updateTask(getCanonicalTeamTaskListId(TEAM), followUp, { status: 'completed' })

    expect(await settle(state, 20_000)).not.toBeNull()
  })

  test('asks only for TeamDelete when every member has already stopped', async () => {
    await writeTeam({ builder: { isActive: false, terminated: true } })
    await addTask('completed')

    const prompt = await settle({}, 1_000)

    expect(prompt?.value).toContain('every teammate has already stopped, so call TeamDelete')
    expect(prompt?.value).not.toContain('shutdown_request')
  })

  test('leaves teams the desktop did not approve, and teams without tasks, alone', async () => {
    await writeTeam({ builder: { isActive: false } }, false)
    await addTask('completed')
    expect(await settle({}, 1_000)).toBeNull()

    await rm(join(configDir, 'tasks'), { recursive: true, force: true })
    await writeTeam({ builder: { isActive: false } })
    expect(await settle({}, 10_000)).toBeNull()
    expect(await settle({}, 20_000)).toBeNull()
    expect(await takeTeamFinishedPrompt({}, undefined, 30_000)).toBeNull()
  })
})
