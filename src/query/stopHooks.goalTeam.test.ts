import { afterAll, afterEach, beforeEach, expect, mock, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const GOAL_COMMAND = '<cc-haha-goal-hook>\nreviews/SUMMARY.md exists'
let hookResults: Array<Record<string, unknown>> = []

const actualHooks = await import('../utils/hooks.js')
const originalHooks = { ...actualHooks }
mock.module('../utils/hooks.js', () => ({
  ...actualHooks,
  executeStopHooks: async function* () {
    for (const result of hookResults) yield result
  },
}))
afterAll(() => {
  // mock.restore does not undo mock.module; later files in the same run
  // must see the real hooks.
  mock.module('../utils/hooks.js', () => originalHooks)
  mock.restore()
})

const { handleStopHooks } = await import('./stopHooks.js')
const { writeTeamFileAsync } = await import('../utils/swarm/teamHelpers.js')

let configDir: string
const savedConfigDir = process.env.CLAUDE_CONFIG_DIR
beforeEach(async () => {
  configDir = await mkdtemp(join(tmpdir(), 'goal-team-stop-'))
  process.env.CLAUDE_CONFIG_DIR = configDir
  hookResults = [
    { preventContinuation: true, stopReason: 'goal' },
    { blockingError: { blockingError: 'Prompt hook condition was not met: reviewers are still writing', command: GOAL_COMMAND } },
  ]
})
afterEach(async () => {
  if (savedConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = savedConfigDir
  await rm(configDir, { recursive: true, force: true })
})

async function runLeadStopHooks(teamWorking: boolean) {
  await writeTeamFileAsync('review', {
    name: 'review', createdAt: 1, leadAgentId: 'team-lead@review', leadSessionId: 'lead-session',
    members: [
      { agentId: 'team-lead@review', name: 'team-lead', joinedAt: 1, tmuxPaneId: '', cwd: configDir, subscriptions: [] },
      { agentId: 'reader@review', name: 'reader', joinedAt: 1, tmuxPaneId: '', cwd: configDir, subscriptions: [], backendType: 'process', sessionId: 'worker', isActive: teamWorking },
    ],
  })
  const appState = {
    toolPermissionContext: { mode: 'default' },
    tasks: {},
    teamContext: { teamName: 'review', leadAgentId: 'team-lead@review', isLeader: true, teammates: {} },
  }
  const toolUseContext = {
    getAppState: () => appState,
    setAppState: () => {},
    abortController: new AbortController(),
    options: { tools: [], mainLoopModel: 'fixture-model' },
  }
  const yielded: unknown[] = []
  const generator = handleStopHooks([], [], [] as never, {}, {}, toolUseContext as never, 'sdk')
  let next = await generator.next()
  while (!next.done) {
    yielded.push(next.value)
    next = await generator.next()
  }
  const text = JSON.stringify(yielded)
  return { result: next.value, text }
}

test('an unmet goal ends the lead turn while its team is still working, to be re-checked when a member reports', async () => {
  const { result, text } = await runLeadStopHooks(true)
  expect(result).toEqual({ blockingErrors: [], preventContinuation: false })
  expect(text).toContain('Goal waiting for teammates: reviewers are still writing')
})

test('an unmet goal keeps the lead working once its team is idle', async () => {
  const { result, text } = await runLeadStopHooks(false)
  expect(result.preventContinuation).toBe(false)
  expect(result.blockingErrors).toHaveLength(1)
  expect(text).toContain('Goal continuing: reviewers are still writing')
})

test('a non-goal blocking hook still blocks even while the team works', async () => {
  hookResults = [{ blockingError: { blockingError: 'lint must pass', command: 'npm run lint' } }]
  const { result } = await runLeadStopHooks(true)
  expect(result.blockingErrors).toHaveLength(1)
})
