import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CronService } from '../services/cronService.js'
import type { CronScheduler } from '../services/cronScheduler.js'
import { handleScheduledTaskToolsApi } from './scheduledTaskTools.js'
import { authenticateCollaborationCaller } from '../sessionCollaborationAuth.js'

let dir: string
const originalConfig = process.env.CLAUDE_CONFIG_DIR
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'scheduled-tool-api-')); process.env.CLAUDE_CONFIG_DIR = dir })
afterEach(async () => {
  if (originalConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = originalConfig
  await rm(dir, { recursive: true, force: true })
})
const tasks = new CronService()
const unusedRuns = {} as Pick<CronScheduler, 'getRunsPage' | 'getRunDetail'>
const create = { action: 'create', requestId: 'fixture-create', name: 'Continue tomorrow', prompt: 'Review the fixture', schedule: { kind: 'once', runAt: '2099-01-01T09:00:00+08:00', timeZone: 'Asia/Shanghai' } }
function request(input: unknown) { return new Request('http://127.0.0.1/api/scheduled-task-tools', { method: 'POST', body: JSON.stringify(input) }) }
function invoke(input: unknown, runs = unusedRuns) { return handleScheduledTaskToolsApi(request(input), 'authenticated-session', { tasks, runs, sessionExists: async id => id === 'other-session' }) }

test('creates in the same desktop store, binds the authenticated caller, and reuses uncertain creation receipts', async () => {
  const result = await invoke(create)
  expect(result.status).toBe(200)
  const body = await result.json() as any
  expect(body).toMatchObject({ schemaVersion: 1, kind: 'scheduled_task', operation: 'created', task: { sourceSessionId: 'authenticated-session', execution: { kind: 'session', targetSessionId: 'authenticated-session' } } })
  expect(body.task).toMatchObject({ notificationPolicy: 'important', notification: { enabled: true, channels: ['desktop'] } })
  const replay = await (await invoke(create)).json() as any
  expect(replay.taskId).toBe(body.taskId)
  expect(await tasks.listTasks()).toHaveLength(1)
  expect((await invoke({ ...create, sourceSessionId: 'spoofed' })).status).toBe(400)
  expect((await invoke({ ...create, execution: { kind: 'session', targetSessionId: 'missing' } })).status).toBe(404)
})

test('creation preserves explicit notification preferences and list pagination keeps all tasks discoverable', async () => {
  const silent = await (await invoke({ ...create, requestId: 'silent', notificationPolicy: 'none' })).json() as any
  expect(silent.task).toMatchObject({ notificationPolicy: 'none', notification: { enabled: false } })
  const disabled = await (await invoke({ ...create, requestId: 'disabled', notification: { enabled: false, channels: [] } })).json() as any
  expect(disabled.task.notification).toEqual({ enabled: false, channels: [] })
  const page = await (await invoke({ action: 'list', limit: 1 })).json() as any
  expect(page).toMatchObject({ totalCount: 2, truncated: true, nextOffset: 1 })
  const last = await (await invoke({ action: 'list', limit: 1, offset: page.nextOffset })).json() as any
  expect(last.tasks[0].id).not.toBe(page.tasks[0].id)
  expect(last).toMatchObject({ totalCount: 2, truncated: false })
})

test('update is a bounded patch and deletion returns a historical snapshot', async () => {
  const { task } = await (await invoke(create)).json() as any
  const updatedResponse = await invoke({ action: 'update', id: task.id, expectedRevision: task.revision, changes: { enabled: false } })
  expect(updatedResponse.status).toBe(200)
  const { task: updated } = await updatedResponse.json() as any
  expect(updated).toMatchObject({ prompt: task.prompt, schedule: task.schedule, enabled: false })
  expect((await invoke({ action: 'update', id: task.id, changes: { sourceSessionId: 'spoofed' } })).status).toBe(400)
  expect((await invoke({ action: 'delete', id: task.id, expectedRevision: task.revision })).status).toBe(409)
  const deleted = await (await invoke({ action: 'delete', id: task.id, expectedRevision: updated.revision })).json() as any
  expect(deleted).toMatchObject({ kind: 'scheduled_task', operation: 'deleted', taskId: task.id, task: { name: task.name } })
  expect(await tasks.listTasks()).toEqual([])
})

test('changing the notification policy keeps delivery enabled in step, as creation derives it', async () => {
  const { task } = await (await invoke({ ...create, notificationPolicy: 'none' })).json() as any
  expect(task.notification.enabled).toBe(false)
  const resumed = await (await invoke({ action: 'update', id: task.id, changes: { notificationPolicy: 'important' } })).json() as any
  expect(resumed.task).toMatchObject({ notificationPolicy: 'important', notification: { enabled: true, channels: ['desktop'] } })
  const muted = await (await invoke({ action: 'update', id: task.id, changes: { notificationPolicy: 'none' } })).json() as any
  expect(muted.task).toMatchObject({ notificationPolicy: 'none', notification: { enabled: false } })
  const explicit = await (await invoke({ action: 'update', id: task.id, changes: { notificationPolicy: 'all', notification: { enabled: true, channels: ['desktop', 'telegram'] } } })).json() as any
  expect(explicit.task.notification).toEqual({ enabled: true, channels: ['desktop', 'telegram'] })
})

test('result queries preserve status and session links and page bounded output without starting a task', async () => {
  const pageCalls: unknown[] = []
  const run = { id: 'r', taskId: 't', taskName: 'Review', prompt: 'Inspect', status: 'failed' as const, startedAt: '2026-01-01T00:00:00Z', sessionId: 's', output: 'a'.repeat(250), error: 'missing fixture' }
  const runs = {
    getRunsPage: async (options: unknown) => { pageCalls.push(options); return { runs: [{ id: 'r', taskId: 't', status: 'failed', sessionId: 's' }], nextCursor: 'next' } },
    getRunDetail: async (id: string) => id === 'r' ? run : null,
  } as unknown as Pick<CronScheduler, 'getRunsPage' | 'getRunDetail'>
  const listed = await (await invoke({ action: 'runs', taskId: 't', limit: 10, cursor: 'cursor' }, runs)).json() as any
  expect(listed).toMatchObject({ kind: 'scheduled_task_runs', nextCursor: 'next', runs: [{ status: 'failed', sessionId: 's' }] })
  expect(pageCalls).toEqual([{ taskId: 't', limit: 10, cursor: 'cursor', summaryOnly: true }])
  const first = await (await invoke({ action: 'run', runId: 'r', maxChars: 100 }, runs)).json() as any
  expect(first.runs[0]).toMatchObject({ output: 'a'.repeat(100), outputTruncated: true, nextOutputOffset: 100, outputTotalChars: 250, error: 'missing fixture', status: 'failed', sessionId: 's' })
  const last = await (await invoke({ action: 'run', runId: 'r', maxChars: 100, outputOffset: 200 }, runs)).json() as any
  expect(last.runs[0]).toMatchObject({ output: 'a'.repeat(50), outputTruncated: false })
  expect(last.runs[0]).not.toHaveProperty('nextOutputOffset')
  expect((await invoke({ action: 'run', runId: 'missing' }, runs)).status).toBe(404)
})

test('the tool endpoint authentication rejects browser requests and mismatched session tokens', () => {
  const req = (headers: Record<string, string>) => new Request('http://127.0.0.1/api/scheduled-task-tools', { method: 'POST', headers })
  const auth = (id: string, token: string) => id === 's' && token === 'fixture-token'
  expect(authenticateCollaborationCaller(req({ 'x-session-id': 's', authorization: 'Bearer fixture-token' }), auth)).toBe('s')
  expect(authenticateCollaborationCaller(req({ 'x-session-id': 'spoofed', authorization: 'Bearer fixture-token' }), auth)).toBeNull()
  expect(authenticateCollaborationCaller(req({ 'x-session-id': 's', authorization: 'Bearer fixture-token', origin: 'http://127.0.0.1' }), auth)).toBeNull()
})

test('desktop REST mutations validate the same schedule shape and reject protected or mistyped fields', async () => {
  const { handleScheduledTasksApi } = await import('./scheduled-tasks.js')
  const ui = (body: unknown, method = 'POST', id?: string) => {
    const url = new URL(`http://127.0.0.1/api/scheduled-tasks${id ? `/${id}` : ''}`)
    return handleScheduledTasksApi(new Request(url, { method, body: JSON.stringify(body) }), url, ['api', 'scheduled-tasks', ...(id ? [id] : [])])
  }
  expect((await ui(null)).status).toBe(400)
  expect((await ui({ cron: '* * * * *', prompt: 'Task', enabled: 'false' })).status).toBe(400)
  expect((await ui({ prompt: 'Task', schedule: { kind: 'once', runAt: '2099-01-01T00:00:00Z', timeZone: 'Invalid/Zone' } })).status).toBe(400)
  const created = await ui({ name: 'UI reminder', prompt: 'Task', schedule: create.schedule })
  expect(created.status).toBe(201)
  const { task } = await created.json() as any
  expect((await ui({ sourceSessionId: 'spoofed' }, 'PUT', task.id)).status).toBe(400)
  expect((await ui({ enabled: false, expectedRevision: task.revision }, 'PUT', task.id)).status).toBe(200)
})
