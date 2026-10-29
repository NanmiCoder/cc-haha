import { expect, test } from 'bun:test'
import { FIXTURE_TOKEN, startFixtureServer } from './fixture-server'
import { applySchedulePreset, createScheduleInput, newScheduleDraft, scheduleDraftForTask, scheduleUpdate } from '../src/core/scheduleDraft'
import type { ScheduledTask } from '../src/core/operations'

test('local mobile fixture supports single executions and revision-checked schedule edits', async () => {
  const fixture = startFixtureServer({ port: 0, quiet: true })
  const base = `http://127.0.0.1:${fixture.server.port}/api/scheduled-tasks`
  const headers = { authorization: `Bearer ${FIXTURE_TOKEN}`, 'content-type': 'application/json' }
  try {
    const capabilities = await fetch(base + '/notification-capabilities', { headers })
    expect(capabilities.status).toBe(200)
    expect(await capabilities.json()).toEqual({ channels: { desktop: true, feishu: false, telegram: false } })
    expect((await fetch(base + '/notification-capabilities', { method: 'POST', headers, body: '{}' })).status).toBe(405)
    const draft = applySchedulePreset(newScheduleDraft('Asia/Shanghai'), 'halfHour')
    const input = createScheduleInput({ name: 'Fixture once', prompt: 'check', execution: { kind: 'session', targetSessionId: 'fixture-chat' }, folderPath: '', useWorktree: false, channels: ['desktop'], notificationPolicy: 'failed' }, draft)
    const response = await fetch(base, { method: 'POST', headers, body: JSON.stringify(input) })
    expect(response.status).toBe(201)
    const { task } = await response.json() as { task: ScheduledTask }
    expect(task.schedule).toEqual(input.schedule)
    expect(task.execution).toEqual(input.execution)
    expect(task.nextRunAt).toBe(Date.parse(task.schedule!.kind === 'once' ? task.schedule!.runAt : ''))
    const update = scheduleUpdate({ ...scheduleDraftForTask(task), frequency: 'specificDays', selectedDays: [1, 3, 5], time: '10:30' }, task)
    const save = () => fetch(`${base}/${task.id}`, { method: 'PUT', headers, body: JSON.stringify(update) })
    const saved = await save()
    expect(saved.status).toBe(200)
    expect((await saved.json() as { task: ScheduledTask }).task.schedule).toEqual({ kind: 'cron', expression: '30 10 * * 1,3,5', timeZone: 'Asia/Shanghai' })
    expect((await save()).status).toBe(409)
  } finally { await fixture.close() }
})
