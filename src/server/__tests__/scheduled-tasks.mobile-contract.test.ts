import { expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSandboxedTestEnvironment, removeTestSandbox } from '../../../scripts/pr/test-environment'

test('mobile creates and edits desktop schedule contracts through the real REST handler', () => {
  const home = mkdtempSync(join(tmpdir(), 'mobile-schedule-contract-'))
  try {
    const script = `
      const assert = (await import('node:assert/strict')).default
      const { readFile } = await import('node:fs/promises')
      const { handleScheduledTasksApi } = await import(${JSON.stringify(import.meta.resolve('../api/scheduled-tasks'))})
      const { applySchedulePreset, createScheduleInput, newScheduleDraft, scheduleDraftForTask, scheduleUpdate } = await import(${JSON.stringify(import.meta.resolve('../../../mobile/src/core/scheduleDraft'))})
      const options = { name: '', prompt: 'Check build', execution: { kind: 'new-session' }, folderPath: '/fixture/project', runtime: { providerId: 'fixture', modelId: 'fast' }, useWorktree: true, notificationPolicy: 'failed', channels: ['desktop'] }
      async function api(method, suffix = '', body) {
        const url = new URL('http://127.0.0.1/api/scheduled-tasks' + suffix)
        const req = new Request(url, { method, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) })
        const response = await handleScheduledTasksApi(req, url, url.pathname.slice(1).split('/'))
        return { status: response.status, ...await response.json() }
      }
      const draft = newScheduleDraft('Asia/Shanghai')
      for (const patch of [
        { frequency: 'daily' }, { frequency: 'weekdays' }, { frequency: 'specificDays', selectedDays: [1,3,5] },
        { frequency: 'monthly', monthDay: 28 }, { frequency: 'everyNMinutes', minuteInterval: 15 },
        { frequency: 'everyNHours', hourInterval: 4, minuteOffset: 30 }, { frequency: 'customCron', customCron: '0 9 1,15 * *' },
      ]) {
        const payload = createScheduleInput(options, { ...draft, ...patch })
        const created = await api('POST', '', payload)
        assert.equal(created.status, 201, JSON.stringify(created))
        assert.deepEqual(created.task.schedule, payload.schedule)
        assert.equal(created.task.cron, payload.schedule.expression)
        assert.deepEqual(created.task.execution, { kind: 'new-session' })
        assert.equal(created.task.providerId, 'fixture')
        assert.equal(created.task.model, 'fast')
        assert.ok(created.task.nextRunAt > Date.now())
      }
      const onceInput = createScheduleInput({ ...options, runtime: { providerId: null, modelId: 'claude-fixture' } }, applySchedulePreset(draft, 'halfHour'))
      const once = await api('POST', '', onceInput)
      assert.equal(once.status, 201)
      assert.equal(once.task.cron, '')
      assert.equal(once.task.recurring, false)
      assert.equal(once.task.nextRunAt, Date.parse(onceInput.schedule.runAt))
      assert.equal(once.task.providerId, null)
      const desktop = await api('POST', '', { name: 'Desktop plan', prompt: 'Check', execution: { kind: 'session', targetSessionId: 'fixture-chat' }, schedule: { kind: 'cron', expression: '0 9 * * 1,3', timeZone: 'America/New_York' } })
      const mobileDraft = scheduleDraftForTask(desktop.task)
      assert.equal(scheduleUpdate(mobileDraft, desktop.task), null)
      const update = scheduleUpdate({ ...mobileDraft, time: '11:30' }, desktop.task)
      const saved = await api('PUT', '/' + desktop.task.id, update)
      assert.equal(saved.status, 200)
      assert.deepEqual(saved.task.schedule, { kind: 'cron', expression: '30 11 * * 1,3', timeZone: 'America/New_York' })
      assert.deepEqual(saved.task.execution, desktop.task.execution)
      assert.equal((await api('PUT', '/' + desktop.task.id, update)).status, 409)
      const legacy = await api('POST', '', { prompt: 'Legacy', cron: '0 9 * * *', recurring: false })
      assert.equal(scheduleUpdate(scheduleDraftForTask(legacy.task), legacy.task), null)
      const changedLegacy = await api('PUT', '/' + legacy.task.id, scheduleUpdate({ ...scheduleDraftForTask(legacy.task), time: '10:00' }, legacy.task))
      assert.equal(changedLegacy.task.recurring, false)
      assert.equal(changedLegacy.task.schedule, undefined)
      const persisted = JSON.parse(await readFile(process.env.CLAUDE_CONFIG_DIR + '/scheduled_tasks.json', 'utf8'))
      assert.deepEqual(persisted.tasks.find(task => task.id === desktop.task.id).schedule, saved.task.schedule)
      assert.equal((await api('POST', '', { prompt: 'Bad', schedule: { kind: 'cron', expression: '0 9 * * *', timeZone: 'Mars/Test' } })).status, 400)
    `
    execFileSync(process.execPath, ['--no-env-file', '-e', script], {
      env: createSandboxedTestEnvironment(home),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 20_000,
    })
    expect(true).toBe(true)
  } finally { removeTestSandbox(home, 'mobile-schedule-contract') }
})
