import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TeamDeleteTool } from './TeamDeleteTool.js'
import { existsSync } from 'node:fs'
import { getSessionId } from '../../bootstrap/state.js'
import { getTeamDir, readTeamFile, writeTeamFileAsync } from '../../utils/swarm/teamHelpers.js'
import { beginTaskListLifecycle, withTaskListLifecycleLock, clearLeaderTeamName, getTasksDir, readTaskListLifecycleState } from '../../utils/tasks.js'

let home: string
let oldHome: string | undefined
let oldConfig: string | undefined
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'team-delete-process-'))
  oldHome = process.env.HOME
  oldConfig = process.env.CLAUDE_CONFIG_DIR
  process.env.HOME = home
  process.env.CLAUDE_CONFIG_DIR = home
})
afterEach(async () => {
  clearLeaderTeamName()
  if (oldHome === undefined) delete process.env.HOME
  else process.env.HOME = oldHome
  if (oldConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = oldConfig
  await rm(home, { recursive: true, force: true })
})

async function prepare(backendType: 'process' | 'in-process', terminated: boolean, leadSessionId = 'parent') {
  await withTaskListLifecycleLock('team', () => beginTaskListLifecycle('team', { teamName: 'team', createdAt: 1, leadSessionId }))
  await writeTeamFileAsync('team', { name: 'team', createdAt: 1, leadAgentId: 'team-lead@team', leadSessionId, members: [{ agentId: 'worker@team', name: 'worker', joinedAt: 1, tmuxPaneId: '', cwd: home, subscriptions: [], backendType, isActive: false, terminated }] })
  let state: any = { teamContext: { teamName: 'team' }, inbox: { messages: [] } }
  return { getAppState: () => state, setAppState: (update: any) => { state = update(state) } } as any
}

test('terminated process workers retain transcript identity until team cleanup', async () => {
  const context = await prepare('process', true)
  const result: any = await TeamDeleteTool.call({}, context)
  expect(result.data.success).toBe(true)
  expect(readTeamFile('team')).toBeNull()
})

test.each([['process', false], ['in-process', true]] as const)('idle %s worker with terminated=%s still blocks deletion', async (backend, terminated) => {
  const context = await prepare(backend, terminated)
  const result: any = await TeamDeleteTool.call({}, context)
  expect(result.data.success).toBe(false)
  expect(result.data.message).toContain('then end your turn')
  expect(readTeamFile('team')).not.toBeNull()
})

// A desktop lead process restarts on model or permission changes, crashes and
// reopens; only the durable record still says which session leads the team.
async function removeByHand(context: any, options: { keepTasks?: boolean } = {}) {
  await rm(getTeamDir('team'), { recursive: true, force: true })
  if (!options.keepTasks) await rm(getTasksDir('team'), { recursive: true, force: true })
  return (await TeamDeleteTool.call({}, context) as any).data
}

test('a restarted lead still ends a team whose directories were removed by hand', async () => {
  const context = await prepare('process', true, getSessionId())
  const result = await removeByHand(context)
  expect(result).toMatchObject({ success: true, message: 'Cleaned up directories and worktrees for team "team"' })
  expect(context.getAppState().teamContext).toBeUndefined()
  expect((await readTaskListLifecycleState('team')).deleted).toBe(true)
})

test("a lead lets go of a removed team without touching what may be another session's", async () => {
  const context = await prepare('process', true, 'another-lead')
  await mkdir(getTasksDir('team'), { recursive: true })
  await writeFile(join(getTasksDir('team'), '1.json'), '{}')
  const result = await removeByHand(context, { keepTasks: true })
  expect(result).toMatchObject({ success: true, message: 'Team "team" was already removed; this session no longer leads it' })
  expect(context.getAppState().teamContext).toBeUndefined()
  expect(existsSync(join(getTasksDir('team'), '1.json'))).toBe(true)
  expect((await readTaskListLifecycleState('team')).deleted).toBe(false)
})
