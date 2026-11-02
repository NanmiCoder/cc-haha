import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolUseContext } from '../../Tool.js'
import { teamPlanRecordSchema } from '../../shared/teamPlan.js'
import { getTeamDir, writeTeamFileAsync } from '../../utils/swarm/teamHelpers.js'
import { clearLeaderTeamName, createTask, getTask, updateTask } from '../../utils/tasks.js'
import { readMailbox } from '../../utils/teammateMailbox.js'
import { TaskUpdateTool } from './TaskUpdateTool.js'

const teamName = 'task-owner-validation'
const savedEnv = {
  HOME: process.env.HOME,
  CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
  CLAUDE_CODE_TASK_LIST_ID: process.env.CLAUDE_CODE_TASK_LIST_ID,
  USER_TYPE: process.env.USER_TYPE,
}
let root: string
let taskId: string
let context: ToolUseContext

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'task-owner-validation-'))
  process.env.HOME = root
  process.env.CLAUDE_CONFIG_DIR = root
  process.env.CLAUDE_CODE_TASK_LIST_ID = teamName
  process.env.USER_TYPE = 'ant'
  clearLeaderTeamName()
  await writeTeamFileAsync(teamName, {
    name: teamName, createdAt: 1, leadAgentId: `team-lead@${teamName}`,
    members: [{ agentId: `builder@${teamName}`, name: 'builder', joinedAt: 1, tmuxPaneId: '', cwd: root, subscriptions: [] }],
  })
  taskId = await createTask(teamName, { subject: 'Fix Guide state', description: '', status: 'pending', owner: 'builder', blocks: [], blockedBy: [] })
  context = {
    getAppState: () => ({ teamContext: { teamName, teammates: { reviewer: { name: 'reviewer' } } } }),
    setAppState: () => {},
    abortController: new AbortController(),
  } as unknown as ToolUseContext
})

afterEach(async () => {
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  clearLeaderTeamName()
  await rm(root, { recursive: true, force: true })
})

test('rejects an unknown unfinished-task owner without mutating the task or creating an orphan inbox', async () => {
  const result = await TaskUpdateTool.call({ taskId, owner: 'patcher', status: 'in_progress' }, context)
  expect(result.data).toMatchObject({ success: false, updatedFields: [] })
  expect(result.data.error).toContain("No teammate named 'patcher'")
  expect(await getTask(teamName, taskId)).toMatchObject({ owner: 'builder', status: 'pending' })
  expect(await readMailbox('patcher', teamName)).toEqual([])
})

test.each(['builder', 'reviewer', 'team-lead'])('accepts an existing teammate or lead: %s', async owner => {
  await updateTask(teamName, taskId, { owner: undefined })
  expect((await TaskUpdateTool.call({ taskId, owner }, context)).data.success).toBe(true)
  expect((await getTask(teamName, taskId))?.owner).toBe(owner)
  expect(await readMailbox(owner, teamName)).toHaveLength(1)
})

test.each(['draft', 'review_pending', 'launching'])('allows assignment to a staged member in %s', async state => {
  const runtime = { providerId: 'fixture', modelId: 'fixture' }
  const plan = teamPlanRecordSchema.parse({
    schemaVersion: 1, planId: 'plan', sessionId: 'session', teamName,
    incarnationId: 'incarnation', revision: 1, state, workDir: root,
    leaderRuntime: runtime,
    members: [{ id: 'patcher', name: 'patcher', agentType: 'general-purpose', prompt: 'Fix fixture', runtime }],
    tasks: [], createdAt: 1, updatedAt: 1,
  })
  await writeFile(join(getTeamDir(teamName), 'plan.json'), JSON.stringify(plan))
  expect((await TaskUpdateTool.call({ taskId, owner: 'patcher' }, context)).data.success).toBe(true)
  expect((await getTask(teamName, taskId))?.owner).toBe('patcher')
})

test('keeps legacy assignments usable when no roster can be read', async () => {
  await rm(getTeamDir(teamName), { recursive: true, force: true })
  expect((await TaskUpdateTool.call({ taskId, owner: 'patcher' }, context)).data.success).toBe(true)
})

test('keeps legacy assignments usable when the stored JSON has no valid roster', async () => {
  await writeFile(join(getTeamDir(teamName), 'config.json'), '{}')
  expect((await TaskUpdateTool.call({ taskId, owner: 'patcher' }, context)).data.success).toBe(true)
  expect((await getTask(teamName, taskId))?.owner).toBe('patcher')
})

test('allows clearing an owner, updating an existing orphan, and recording completed historical ownership', async () => {
  expect((await TaskUpdateTool.call({ taskId, owner: '' }, context)).data.success).toBe(true)
  await updateTask(teamName, taskId, { owner: 'old-worker', status: 'in_progress' })
  expect((await TaskUpdateTool.call({ taskId, owner: 'old-worker', description: 'Recover old task' }, context)).data.success).toBe(true)
  expect((await TaskUpdateTool.call({ taskId, status: 'completed', owner: 'patcher' }, context)).data.success).toBe(true)
  expect((await getTask(teamName, taskId))?.owner).toBe('patcher')
  expect(await readMailbox('patcher', teamName)).toEqual([])
  expect((await TaskUpdateTool.call({ taskId, owner: 'archived-worker' }, context)).data.success).toBe(true)
})
