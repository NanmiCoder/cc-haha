import { expect, test } from 'bun:test'
import { applySchedulePreset, createScheduleInput, newScheduleDraft, scheduleDraftForTask, scheduleFromDraft, scheduleUpdate, type ScheduleCreateOptions } from './scheduleDraft'
import type { ScheduledTask } from './operations'

const now = Date.parse('2035-10-26T18:00:00Z')
const options: ScheduleCreateOptions = { name: '', prompt: '检查构建\n报告结果', execution: { kind: 'new-session' }, folderPath: '/fixture/project', runtime: { providerId: 'fixture', modelId: 'fast' }, useWorktree: false, notificationPolicy: 'none', channels: [] }

test('quick presets use the selected timezone and tomorrow crosses months safely', () => {
  const draft = newScheduleDraft('Asia/Shanghai', now)
  expect(scheduleFromDraft(applySchedulePreset(draft, 'halfHour', now), now)).toEqual({ kind: 'once', runAt: '2035-10-26T18:30:00.000Z', timeZone: 'Asia/Shanghai' })
  expect(applySchedulePreset(draft, 'tomorrow', now).runAt).toBe('2035-10-28T09:00')
  expect(applySchedulePreset(draft, 'tomorrow', Date.parse('2035-12-31T08:00Z')).runAt).toBe('2036-01-01T09:00')
  expect(scheduleFromDraft(applySchedulePreset(draft, 'workdays', now), now)).toEqual({ kind: 'cron', expression: '0 9 * * 1-5', timeZone: 'Asia/Shanghai' })
})

test.each(['2026-11-01T05:45:00Z', '2026-11-01T06:15:00Z', '2026-04-04T14:45:00Z'])('half-hour preset preserves its instant across a DST overlap at %s', instant => {
  const at = Date.parse(instant)
  const zone = instant.startsWith('2026-04') ? 'Australia/Lord_Howe' : 'America/New_York'
  const draft = applySchedulePreset(newScheduleDraft(zone, at), 'halfHour', at)
  expect(scheduleFromDraft(draft, at)).toEqual({ kind: 'once', runAt: new Date(at + 30 * 60_000).toISOString(), timeZone: zone })
})

test('an unchanged one-time draft preserves seconds and the later side of a DST overlap', () => {
  const task: ScheduledTask = { id: 'overlap', prompt: 'check', cron: '', createdAt: 0, revision: 3, schedule: { kind: 'once', runAt: '2026-11-01T06:15:23Z', timeZone: 'America/New_York' } }
  const draft = scheduleDraftForTask(task)
  expect(scheduleFromDraft(draft, Date.parse('2026-11-01T05:45Z'))).toEqual(task.schedule!)
  expect(scheduleUpdate(draft, task, Date.parse('2026-11-01T05:45Z'))).toBeNull()
  // Editing either wall time or timezone must invalidate the preset's instant.
  const preset = applySchedulePreset(newScheduleDraft('UTC', now), 'halfHour', now)
  expect(scheduleFromDraft({ ...preset, runAt: '2035-10-27T09:00' }, now)).toEqual({ kind: 'once', runAt: '2035-10-27T09:00:00.000Z', timeZone: 'UTC' })
  expect(() => scheduleFromDraft({ ...preset, timeZone: 'Asia/Shanghai' }, now)).toThrow('未来')
})

test('a new quick choice replaces an old instant even when its repeated wall time is identical', () => {
  const at = Date.parse('2026-11-01T05:45:00Z')
  const task: ScheduledTask = { id: 'old-overlap', prompt: 'check', cron: '', createdAt: 0, revision: 3,
    schedule: { kind: 'once', runAt: '2026-11-01T05:15:23Z', timeZone: 'America/New_York' } }
  const draft = applySchedulePreset(scheduleDraftForTask(task), 'halfHour', at)
  expect(draft.runAt).toBe('2026-11-01T01:15')
  expect(scheduleFromDraft(draft, at, task.schedule)).toEqual({ kind: 'once', runAt: '2026-11-01T06:15:00.000Z', timeZone: 'America/New_York' })
  expect(scheduleUpdate(draft, task, at)).toEqual({ schedule: { kind: 'once', runAt: '2026-11-01T06:15:00.000Z', timeZone: 'America/New_York' }, recurring: false, expectedRevision: 3 })
})

test('following the native desktop runtime omits an explicit OAuth provider selection', () => {
  const input = createScheduleInput({ ...options, followDefaultRuntime: true, runtime: { providerId: null, modelId: 'native-api-model' } }, newScheduleDraft('UTC', now), now)
  expect(input.execution).toEqual({ kind: 'new-session' })
  expect(input).not.toHaveProperty('providerId')
  expect(input).not.toHaveProperty('model')
})

test.each([
  ['*/15 * * * *', 'everyNMinutes'], ['30 */4 * * *', 'everyNHours'],
  ['5 9 * * *', 'daily'], ['0 8 * * 1-5', 'weekdays'],
  ['0 18 * * 1,3,5', 'specificDays'], ['0 9 28 * *', 'monthly'],
  ['0 9 1,15 * *', 'customCron'], ['0 9 * * 1-4', 'customCron'],
] as const)('desktop schedule %s survives a mobile edit', (expression, frequency) => {
  const task: ScheduledTask = { id: 'task', prompt: 'check', cron: '0 1 * * *', schedule: { kind: 'cron', expression, timeZone: 'America/New_York' }, createdAt: 0, revision: 3 }
  const draft = scheduleDraftForTask(task)
  expect(draft.frequency).toBe(frequency)
  expect(scheduleFromDraft(draft, now)).toEqual(task.schedule!)
  expect(scheduleUpdate(draft, task, now)).toBeNull()
  const update = scheduleUpdate({ ...draft, timeZone: 'Asia/Shanghai' }, task, now)
  expect(update).toEqual({ schedule: { kind: 'cron', expression, timeZone: 'Asia/Shanghai' }, cron: expression, recurring: true, expectedRevision: 3 })
})

test('single execution is sent using the same explicit schedule and execution target as desktop', () => {
  const draft = applySchedulePreset(newScheduleDraft('UTC', now), 'halfHour', now)
  const input = createScheduleInput(options, draft, now)
  expect(input).toMatchObject({ name: '检查构建', recurring: false, execution: { kind: 'new-session' }, folderPath: '/fixture/project', model: 'fast', providerId: 'fixture', permissionMode: 'bypassPermissions', schedule: { kind: 'once', runAt: '2035-10-26T18:30:00.000Z', timeZone: 'UTC' }, notificationPolicy: 'none', notification: { enabled: false, channels: [] } })
  expect(input).not.toHaveProperty('cron')
  const attached = createScheduleInput({ ...options, execution: { kind: 'session', targetSessionId: 'chat' }, notificationPolicy: 'failed', channels: ['desktop'] }, draft, now)
  expect(attached.execution).toEqual({ kind: 'session', targetSessionId: 'chat' })
  for (const key of ['folderPath', 'permissionMode', 'model', 'providerId', 'useWorktree']) expect(attached).not.toHaveProperty(key)
})

test('completed one-time edits preserve seconds without rearming, while changed times must be future', () => {
  const task: ScheduledTask = { id: 'once', prompt: 'check', cron: '', createdAt: 0, revision: 9, schedule: { kind: 'once', runAt: '2030-01-01T00:00:23Z', timeZone: 'UTC' } }
  const draft = scheduleDraftForTask(task)
  expect(scheduleUpdate(draft, task, now)).toBeNull()
  expect(() => scheduleUpdate({ ...draft, runAt: '2030-01-01T00:01' }, task, now)).toThrow('未来')
})

test('property order cannot rearm an unchanged recurring task', () => {
  const task: ScheduledTask = { id: 'cron', prompt: 'check', cron: '0 9 * * *', createdAt: 0, schedule: { timeZone: 'UTC', expression: '0 9 * * *', kind: 'cron' } }
  expect(scheduleUpdate(scheduleDraftForTask(task), task, now)).toBeNull()
  expect(() => applySchedulePreset({ ...newScheduleDraft('UTC', now), timeZone: 'invalid' }, 'tomorrow', now)).toThrow('时区')
})

test('legacy edits retain computer-local timing and one-shot recurrence until explicitly converted', () => {
  const task: ScheduledTask = { id: 'legacy', prompt: 'check', cron: '0 9 * * 5,1', createdAt: 0, recurring: false, revision: 3 }
  const draft = scheduleDraftForTask(task)
  expect(scheduleUpdate(draft, task, now)).toBeNull()
  expect(scheduleUpdate({ ...draft, time: '10:30' }, task, now)).toEqual({ cron: '30 10 * * 1,5', expectedRevision: 3 })
  expect(scheduleUpdate({ ...draft, legacy: false, timeZone: 'UTC' }, task, now)).toMatchObject({ schedule: { kind: 'cron', expression: '0 9 * * 1,5', timeZone: 'UTC' }, recurring: true })
  const scheduled = { ...task, schedule: { kind: 'cron' as const, expression: task.cron, timeZone: 'UTC' } }
  expect(scheduleUpdate(scheduleDraftForTask(scheduled), scheduled, now)).toBeNull()
})

test('validation rejects past, invalid calendar dates, DST gaps, invalid zones and unsupported cron', () => {
  const draft = newScheduleDraft('America/New_York', now)
  for (const runAt of ['2030-01-01T09:00', '2036-02-30T09:00', '2036-03-09T02:30']) expect(() => scheduleFromDraft({ ...draft, frequency: 'once', runAt }, now)).toThrow()
  expect(() => scheduleFromDraft({ ...draft, timeZone: 'Mars/Test' }, now)).toThrow('时区')
  expect(() => scheduleFromDraft({ ...draft, frequency: 'specificDays', selectedDays: [] }, now)).toThrow('一天')
  for (const customCron of ['*/0 * * * *', '0 24 * * *', '0 9 * * 5-1', '0/5 * * * *']) expect(() => scheduleFromDraft({ ...draft, frequency: 'customCron', customCron }, now)).toThrow()
  expect(() => createScheduleInput({ ...options, folderPath: '' }, draft, now)).toThrow('项目目录')
  expect(() => createScheduleInput({ ...options, notificationPolicy: 'all' }, draft, now)).toThrow('渠道')
})
