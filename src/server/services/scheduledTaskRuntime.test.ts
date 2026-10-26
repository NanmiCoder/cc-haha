import { afterEach, beforeEach, describe, expect, setSystemTime, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { migrationMaintenance } from '../migrationMaintenance.js'
import { CronService } from './cronService.js'
import { CronScheduler, shouldNotifyScheduledRun, type TaskRun } from './cronScheduler.js'
import { setScheduledSessionTaskExecutor, type ScheduledSessionTaskExecutor } from './scheduledTaskExecution.js'
import { nextScheduledTime, validateTaskSchedule } from './scheduledTaskSchedule.js'
import { claimScheduledTaskReceipt, readScheduledTaskReceipts, scheduledTaskReceiptsDir } from './scheduledTaskReceipts.js'
import { ensurePersistentStorageUpgraded, resetPersistentStorageMigrationsForTests } from './persistentStorageMigrations.js'

let directory: string
let service: CronService
let scheduler: CronScheduler
let dispose: (() => void) | undefined
const previousConfig = process.env.CLAUDE_CONFIG_DIR
const previousIndex = process.env.CC_HAHA_LOCAL_INDEX
beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'scheduled-session-test-'))
  process.env.CLAUDE_CONFIG_DIR = directory
  process.env.CC_HAHA_LOCAL_INDEX = 'off'
  service = new CronService()
  scheduler = new CronScheduler(service)
})
afterEach(async () => {
  scheduler.stop()
  await migrationMaintenance.drain()
  dispose?.()
  dispose = undefined
  resetPersistentStorageMigrationsForTests()
  if (previousConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = previousConfig
  if (previousIndex === undefined) delete process.env.CC_HAHA_LOCAL_INDEX
  else process.env.CC_HAHA_LOCAL_INDEX = previousIndex
  await fs.rm(directory, { recursive: true, force: true })
})
function install(executor: ScheduledSessionTaskExecutor) { dispose = setScheduledSessionTaskExecutor(executor) }
async function task() {
  return service.createTask({
    name: 'Fixture reminder', prompt: 'Check fixture', permissionMode: 'ask',
    schedule: { kind: 'once', runAt: '2099-01-01T01:00:00Z', timeZone: 'Asia/Shanghai' },
    execution: { kind: 'session', targetSessionId: 'fixture-session' },
  })
}
async function until(check: () => Promise<boolean>) {
  for (let i = 0; i < 200; i++) { if (await check()) return; await Bun.sleep(2) }
  throw new Error('Timed out waiting for fixture')
}

describe('scheduled task persistence', () => {
  test('creates idempotently, rejects changed retries and stale edits without elevating permissions', async () => {
    const input = { prompt: 'Fixture', schedule: { kind: 'once' as const, runAt: '2099-01-01T00:00:00Z', timeZone: 'UTC' }, execution: { kind: 'session' as const, targetSessionId: 'fixture' }, permissionMode: 'ask' }
    const options = { sourceSessionId: 'caller', requestId: 'request-1' }
    const a = await service.createTask(input, options)
    const b = await service.createTask(input, options)
    expect(b.id).toBe(a.id)
    expect((await service.listTasks())).toHaveLength(1)
    expect(b.permissionMode).toBe('ask')
    expect(b.nextRunAt).toBe(Date.parse(input.schedule.runAt))
    await expect(service.createTask({ ...input, prompt: 'Different' }, options)).rejects.toThrow('different task input')
    const edited = await service.updateTask(a.id, { name: 'Edited' }, { expectedRevision: 1 })
    expect(edited.revision).toBe(2)
    expect(edited.permissionMode).toBe('ask')
    await expect(service.updateTask(a.id, { name: 'Stale' }, { expectedRevision: 1 })).rejects.toThrow('changed')
    await expect(service.deleteTask(a.id, { expectedRevision: 1 })).rejects.toThrow('changed')
  })

  test('migration preserves old independent tasks and unknown fields, with a backup', async () => {
    const original = { futureRoot: { keep: true }, tasks: [{ id: 'old', cron: '0 9 * * *', prompt: 'old fixture', createdAt: 1, recurring: true, future: 'keep' }] }
    const file = path.join(directory, 'scheduled_tasks.json')
    await fs.writeFile(file, JSON.stringify(original))
    resetPersistentStorageMigrationsForTests()
    const report = await ensurePersistentStorageUpgraded()
    expect(report.failures).toEqual([])
    expect(report.migratedEntries).toContain('scheduled_tasks.json')
    const migrated = JSON.parse(await fs.readFile(file, 'utf8'))
    expect(migrated).toMatchObject({ schemaVersion: 1, futureRoot: { keep: true }, tasks: [{ revision: 1, future: 'keep' }] })
    expect(migrated.tasks[0].execution).toBeUndefined()
    expect(migrated.tasks[0].schedule).toBeUndefined()
    expect((await fs.readdir(directory)).some(name => name.startsWith('scheduled_tasks.json.bak-before-migration'))).toBe(true)
    await service.updateTask('old', { name: 'new' })
    expect(JSON.parse(await fs.readFile(file, 'utf8')).futureRoot).toEqual({ keep: true })
    expect((await service.getTask('old'))?.permissionMode).toBe('bypassPermissions')
  })

  test('malformed task migration preserves the original bytes', async () => {
    const file = path.join(directory, 'scheduled_tasks.json')
    await fs.writeFile(file, '{unfinished')
    resetPersistentStorageMigrationsForTests()
    expect((await ensurePersistentStorageUpgraded()).failures).toHaveLength(1)
    expect(await fs.readFile(file, 'utf8')).toBe('{unfinished')
  })
})

describe('schedule instants', () => {
  test('requires valid timezone and unambiguous one-time instant', () => {
    expect(() => validateTaskSchedule({ kind: 'once', runAt: '2099-01-01T09:00:00', timeZone: 'Asia/Shanghai' })).toThrow('offset')
    expect(() => validateTaskSchedule({ kind: 'cron', expression: '0 9 * * *', timeZone: 'Mars/Test' })).toThrow('timeZone')
  })
  test('uses the task timezone regardless of host timezone and preserves the year for once', () => {
    expect(nextScheduledTime({ kind: 'cron', expression: '0 9 * * *', timeZone: 'Asia/Shanghai' }, Date.parse('2026-10-25T02:00:00Z'))).toBe(Date.parse('2026-10-26T01:00:00Z'))
    expect(nextScheduledTime({ kind: 'once', runAt: '2099-01-01T09:00:00+08:00', timeZone: 'Asia/Shanghai' }, 0)).toBe(Date.parse('2099-01-01T01:00:00Z'))
  })
  test('skips a nonexistent DST local time and finds the second overlap occurrence', () => {
    expect(nextScheduledTime({ kind: 'cron', expression: '30 2 * * *', timeZone: 'America/New_York' }, Date.parse('2026-03-08T05:00:00Z'))).toBe(Date.parse('2026-03-09T06:30:00Z'))
    expect(nextScheduledTime({ kind: 'cron', expression: '30 1 * * *', timeZone: 'America/New_York' }, Date.parse('2026-11-01T05:30:00Z'))).toBe(Date.parse('2026-11-01T06:30:00Z'))
  })
})

describe('session execution', () => {
  test('a sparse task created years earlier fires at successive leap-day occurrences', async () => {
    try {
      setSystemTime(new Date('2026-10-26T00:00:00Z'))
      const created = await service.createTask({
        prompt: 'Leap-day fixture',
        schedule: { kind: 'cron', expression: '0 9 29 2 *', timeZone: 'UTC' },
        execution: { kind: 'session', targetSessionId: 'fixture-session' },
      })
      let calls = 0
      install({ canStart: async () => true, execute: async () => {
        calls++
        return { status: 'completed', sessionId: 'fixture-session', output: 'Done' }
      } })
      expect(created.nextRunAt).toBe(Date.parse('2028-02-29T09:00:00Z'))
      setSystemTime(new Date('2028-02-29T09:00:00Z'))
      await scheduler.tick()
      await migrationMaintenance.drain()
      expect(calls).toBe(1)
      expect((await service.getTask(created.id))?.nextRunAt).toBe(Date.parse('2032-02-29T09:00:00Z'))
      setSystemTime(new Date('2032-02-29T09:00:00Z'))
      await scheduler.tick()
      await migrationMaintenance.drain()
      expect(calls).toBe(2)
      expect(await scheduler.getTaskRuns(created.id)).toHaveLength(2)
    } finally {
      await migrationMaintenance.drain()
      setSystemTime()
    }
  })

  test('defers while busy then executes exactly once across two scheduler instances', async () => {
    const created = await task()
    let busy = true
    let calls = 0
    install({ canStart: async () => !busy, execute: async input => {
      calls++
      expect(input.task.permissionMode).toBe('ask')
      expect(await input.canSend()).toBe(true)
      return { status: 'completed', sessionId: 'fixture-session', output: 'fixture result' }
    } })
    const due = new Date('2099-01-01T01:00:01Z')
    await scheduler.tick(due)
    await Bun.sleep(10)
    expect(calls).toBe(0)
    expect(await readScheduledTaskReceipts()).toHaveLength(0)
    busy = false
    await Promise.all([scheduler.tick(due), new CronScheduler(service).tick(due)])
    await until(async () => (await service.getTask(created.id))?.enabled === false)
    expect(calls).toBe(1)
    const runs = await scheduler.getTaskRuns(created.id)
    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({ status: 'completed', sessionId: 'fixture-session', output: 'fixture result', scheduledFor: '2099-01-01T01:00:00.000Z' })
    await scheduler.tick(due)
    expect(calls).toBe(1)
  })

  test('two due tasks sharing a session defer the second without claiming or failing it', async () => {
    const first = await task()
    const second = await task()
    let running = false
    let calls = 0
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    install({ canStart: async () => !running, execute: async () => {
      calls++
      if (running) throw new Error('Session already has an active turn')
      running = true
      await gate
      running = false
      return { status: 'completed', sessionId: 'fixture-session' }
    } })
    const due = new Date('2099-01-01T01:00:01Z')
    await scheduler.tick(due)
    try {
      await until(async () => running)
      await Bun.sleep(15)
      expect(calls).toBe(1)
      expect(await readScheduledTaskReceipts()).toHaveLength(1)
      expect((await service.getTask(second.id))?.lastFiredAt).toBeUndefined()
    } finally { release(); await migrationMaintenance.drain() }
    expect((await service.getTask(first.id))?.enabled).toBe(false)
    await scheduler.tick(due)
    await until(async () => (await service.getTask(second.id))?.enabled === false)
    expect(calls).toBe(2)
    expect((await scheduler.getTaskRuns(second.id))[0]?.status).toBe('completed')
  })

  test('records a new session while running and a rename cannot retrigger a one-shot', async () => {
    const created = await task()
    let entered = false
    let calls = 0
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    install({ canStart: async () => true, execute: async input => {
      calls++
      await input.onSessionResolved?.('new-fixture-session')
      entered = true
      await gate
      return { status: 'completed', sessionId: 'new-fixture-session', output: 'done' }
    } })
    const runPromise = scheduler.executeTask(created)
    await until(async () => entered)
    expect((await scheduler.getTaskRuns(created.id))[0]).toMatchObject({ status: 'running', sessionId: 'new-fixture-session' })
    await service.updateTask(created.id, { name: 'Renamed while running' })
    await new CronScheduler(service).tick(new Date('2099-01-01T01:00:01Z'))
    await Bun.sleep(5)
    expect(calls).toBe(1)
    release()
    await runPromise
    expect((await service.getTask(created.id))?.scheduleState).toBe('completed')
  })

  test('pausing during host startup revokes delivery without stopping unrelated turns', async () => {
    const created = await task()
    let entered = false
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    install({ canStart: async () => true, execute: async input => {
      entered = true
      await gate
      expect(await input.canSend()).toBe(false)
      return { status: 'failed', error: 'Task changed before delivery' }
    } })
    const execution = scheduler.executeTask(created)
    await until(async () => entered)
    await service.updateTask(created.id, { enabled: false })
    release()
    expect((await execution).status).toBe('failed')
  })

  test('recovers an uncertain interrupted receipt as failure without replaying it', async () => {
    const created = await task()
    const occurrenceId = `${created.id}:1:2099-01-01T01:00:00.000Z`
    await claimScheduledTaskReceipt({ version: 1, occurrenceId, taskId: created.id, taskRevision: 1, runId: 'interrupted-run', scheduledFor: '2099-01-01T01:00:00.000Z', claimedAt: new Date().toISOString(), ownerPid: 2147483647, state: 'claimed' })
    let calls = 0
    install({ canStart: async () => true, execute: async () => { calls++; return { status: 'completed' } } })
    scheduler.start()
    await until(async () => (await scheduler.getRunDetail('interrupted-run'))?.status === 'failed')
    await until(async () => (await service.getTask(created.id))?.enabled === false)
    expect(calls).toBe(0)
    expect((await scheduler.getRunDetail('interrupted-run'))?.error).toContain('automatic replay was suppressed')
    await until(async () => (await readScheduledTaskReceipts())[0]?.historyWritten === true)
    expect((await fs.readdir(scheduledTaskReceiptsDir())).filter(name => name.endsWith('.json'))).toHaveLength(1)
  })

  test('recovers a claim written before the run log and advances a recurring task past that occurrence', async () => {
    const now = Math.floor(Date.now() / 60_000) * 60_000
    const scheduledFor = new Date(now - 240_000).toISOString()
    const claimedAt = new Date(now - 230_000).toISOString()
    const fixture = { id: 'claim-gap', revision: 1, cron: '* * * * *', prompt: 'Fixture', createdAt: now - 300_000, recurring: true,
      schedule: { kind: 'cron', expression: '* * * * *', timeZone: 'UTC' }, execution: { kind: 'session', targetSessionId: 'fixture' } }
    await fs.writeFile(path.join(directory, 'scheduled_tasks.json'), JSON.stringify({ tasks: [fixture] }))
    await claimScheduledTaskReceipt({ version: 1, occurrenceId: `claim-gap:1:${scheduledFor}`, taskId: 'claim-gap', taskRevision: 1, runId: 'claim-gap-run', scheduledFor, claimedAt, ownerPid: 2147483647, state: 'claimed' })
    let busy = true
    const delivered: string[] = []
    install({ canStart: async () => !busy, execute: async input => { delivered.push(input.scheduledFor); return { status: 'completed', output: 'next occurrence' } } })
    scheduler.start()
    await until(async () => (await scheduler.getRunDetail('claim-gap-run'))?.status === 'failed')
    await until(async () => (await service.getTask('claim-gap'))?.lastFiredAt === claimedAt)
    expect((await service.getTask('claim-gap'))?.nextRunAt).toBe(now - 180_000)
    busy = false
    await scheduler.tick(new Date(now))
    await until(async () => (await scheduler.getTaskRuns('claim-gap')).some(run => run.output === 'next occurrence'))
    expect(delivered).toEqual([new Date(now - 180_000).toISOString()])
  })

  test('two startup recoveries upsert one interrupted run without colliding temporary files', async () => {
    const created = await task()
    await claimScheduledTaskReceipt({ version: 1, occurrenceId: `${created.id}:1:fixture`, taskId: created.id, taskRevision: 1, runId: 'recovery-race', scheduledFor: '2099-01-01T01:00:00Z', claimedAt: new Date().toISOString(), ownerPid: 2147483647, state: 'claimed' })
    install({ canStart: async () => false, execute: async () => { throw new Error('Must not deliver') } })
    const other = new CronScheduler(service)
    scheduler.start()
    other.start()
    try {
      await until(async () => (await readScheduledTaskReceipts())[0]?.historyWritten === true)
      await until(async () => (await service.getTask(created.id))?.enabled === false)
      expect((await scheduler.getTaskRuns(created.id)).filter(run => run.id === 'recovery-race')).toHaveLength(1)
    } finally { await Promise.all([scheduler.stopAndWait(), other.stopAndWait()]); other.stop(); await migrationMaintenance.drain() }
  })

  test('recovery anchor cannot overwrite a newer task revision or move last-fired time backwards', async () => {
    const created = await service.createTask({ cron: '* * * * *', prompt: 'Fixture', recurring: true })
    await service.updateTask(created.id, { cron: '0 9 * * *' }, { expectedRevision: 1 })
    await service.updateLastFired(created.id, '2026-10-26T00:00:00Z', { expectedRevision: 1 })
    expect((await service.getTask(created.id))?.lastFiredAt).toBeUndefined()
    await service.updateLastFired(created.id, '2026-10-26T01:00:00Z', { expectedRevision: 2 })
    await service.updateLastFired(created.id, '2026-10-26T00:00:00Z', { expectedRevision: 2 })
    expect((await service.getTask(created.id))?.lastFiredAt).toBe('2026-10-26T01:00:00Z')
  })

  test('notification policy suppresses quiet successes but retains failures', async () => {
    const created = await task()
    const run = { status: 'completed', notificationDecision: 'silent' } as TaskRun
    expect(shouldNotifyScheduledRun({ ...created, notificationPolicy: 'important' }, run)).toBe(false)
    expect(shouldNotifyScheduledRun({ ...created, notificationPolicy: 'all' }, run)).toBe(true)
    expect(shouldNotifyScheduledRun({ ...created, notificationPolicy: 'failed' }, run)).toBe(false)
    expect(shouldNotifyScheduledRun({ ...created, notificationPolicy: 'important' }, { ...run, status: 'failed' })).toBe(true)
    expect(shouldNotifyScheduledRun({ ...created, notificationPolicy: 'none' }, { ...run, status: 'failed' })).toBe(false)
  })
})
