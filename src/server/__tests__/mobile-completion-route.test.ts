import { afterEach, beforeEach, expect, test, spyOn, mock } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { configureSessionCollaborationHost, getSessionCollaborationService, handleSessionCollaborationEvent } from '../services/sessionCollaborationHost.js'
import { cronScheduler } from '../services/cronScheduler.js'
import { handleSessionsApi } from '../api/sessions.js'
import { groupDashboard } from '../../../mobile/src/core/dashboard.js'
import type { Session } from '../../../mobile/src/core/types.js'

let directory: string
let previous: string | undefined
let dispose: () => void
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'mobile-completion-route-'))
  previous = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = directory
  dispose = configureSessionCollaborationHost('127.0.0.1', 1234)
})
afterEach(async () => {
  dispose()
  mock.restore()
  if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = previous
  await rm(directory, { recursive: true, force: true })
})

test('production mobile-status keeps successful completion after runtime/host recovery and a fresh phone snapshot', async () => {
  const service = await getSessionCollaborationService()
  const now = new Date()
  const runs = spyOn(cronScheduler, 'getRunsPage').mockResolvedValue({
    runs: [{ id: 'scheduled-run', taskId: 'task', taskName: 'Fixture', status: 'completed', sessionId: 'scheduled', startedAt: now.toISOString(), completedAt: now.toISOString() }],
    revisionToken: 'stable',
  })
  await handleSessionCollaborationEvent(service, { type: 'user-input', sessionId: 'manual' })
  await handleSessionCollaborationEvent(service, { type: 'output', sessionId: 'manual', message: { type: 'result', subtype: 'success', is_error: false, result: 'Fixture completed', uuid: 'completion-1' } })
  await handleSessionCollaborationEvent(service, { type: 'stopped', sessionId: 'stopped' })
  await handleSessionCollaborationEvent(service, { type: 'output', sessionId: 'stopped', message: { type: 'result', is_error: false, uuid: 'stopped-late-result' } })
  await handleSessionCollaborationEvent(service, { type: 'output', sessionId: 'failed', message: { type: 'result', is_error: true, uuid: 'failed-result' } })
  const sessions = ['manual', 'scheduled', 'stopped', 'failed', 'unknown'].map(id => ({
    id, title: id, createdAt: now.toISOString(), modifiedAt: now.toISOString(), messageCount: 2,
    projectPath: '/fixture', workDir: '/fixture', workDirExists: true,
  } satisfies Session))
  async function snapshot() {
    const url = new URL('http://127.0.0.1/api/sessions/mobile-status')
    const response = await handleSessionsApi(new Request(url), url, ['api', 'sessions', 'mobile-status'])
    expect(response.status).toBe(200)
    return (await response.json()).sessions
  }
  const initial = await snapshot()
  expect(groupDashboard(sessions, initial, now).completedToday).toBe(2)
  dispose()
  dispose = configureSessionCollaborationHost('127.0.0.1', 1234)
  const recovered = await snapshot()
  expect(recovered).toEqual(initial)
  expect(groupDashboard(sessions, recovered, now).completedToday).toBe(2)
  expect(groupDashboard(sessions, [], now).completedToday).toBe(0)
  expect(runs).toHaveBeenCalledTimes(2)
})
