import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TeamDeleteTool } from './TeamDeleteTool.js'
import { readTeamFile, writeTeamFileAsync } from '../../utils/swarm/teamHelpers.js'
import { beginTaskListLifecycle, withTaskListLifecycleLock, clearLeaderTeamName } from '../../utils/tasks.js'

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

async function prepare(backendType: 'process' | 'in-process', terminated: boolean) {
  await withTaskListLifecycleLock('team', () => beginTaskListLifecycle('team', { teamName: 'team', createdAt: 1, leadSessionId: 'parent' }))
  await writeTeamFileAsync('team', { name: 'team', createdAt: 1, leadAgentId: 'team-lead@team', leadSessionId: 'parent', members: [{ agentId: 'worker@team', name: 'worker', joinedAt: 1, tmuxPaneId: '', cwd: home, subscriptions: [], backendType, isActive: false, terminated }] })
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
  expect(readTeamFile('team')).not.toBeNull()
})
