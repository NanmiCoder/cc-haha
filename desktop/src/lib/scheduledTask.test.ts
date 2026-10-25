import { describe, expect, it } from 'vitest'
import { dateTimeInZone, parseScheduledTaskResult, taskIsAttached, zonedDateTimeToIso } from './scheduledTask'
import type { CronTask } from '@/types/task'

const task: CronTask = { id: 'task-1', name: 'Check build', prompt: 'Check build', cron: '0 9 * * *', enabled: true, createdAt: 1 }
const result = { schemaVersion: 1, kind: 'scheduled_task', operation: 'created', taskId: task.id, task }

describe('scheduled task protocol', () => {
  it('accepts successful named tool JSON and rejects text, errors, wrong versions and mismatched IDs', () => {
    expect(parseScheduledTaskResult('ScheduledTask', JSON.stringify(result))).toEqual(result)
    expect(parseScheduledTaskResult('ScheduledTask', [{ type: 'text', text: JSON.stringify(result) }])).toEqual(result)
    expect(parseScheduledTaskResult('Bash', result)).toBeNull()
    expect(parseScheduledTaskResult('ScheduledTask', result, true)).toBeNull()
    expect(parseScheduledTaskResult('ScheduledTask', 'Task created')).toBeNull()
    expect(parseScheduledTaskResult('ScheduledTask', { ...result, schemaVersion: 2 })).toBeNull()
    expect(parseScheduledTaskResult('ScheduledTask', { ...result, taskId: 'other' })).toBeNull()
  })

  it('does not confuse run sessions with a live task attachment', () => {
    expect(taskIsAttached(task, 'session-1')).toBe(false)
    const attached = { ...task, execution: { kind: 'session' as const, targetSessionId: 'session-1' } }
    expect(taskIsAttached(attached, 'session-1')).toBe(true)
    expect(taskIsAttached({ ...attached, enabled: false }, 'session-1')).toBe(true)
    expect(taskIsAttached({ ...attached, scheduleState: 'completed' }, 'session-1')).toBe(false)
  })

  it('keeps run results distinct and rejects malformed session IDs', () => {
    const runs = { schemaVersion: 1, kind: 'scheduled_task_runs', runs: [{ id: 'run', taskId: 'task', status: 'completed', sessionId: 'session' }] }
    expect(parseScheduledTaskResult('ScheduledTask', runs)).toEqual(runs)
    expect(parseScheduledTaskResult('ScheduledTask', { ...runs, runs: [{ ...runs.runs[0], sessionId: {} }] })).toBeNull()
  })
})

describe('scheduled task time zones', () => {
  it('round trips the requested zone independently of the computer zone', () => {
    expect(zonedDateTimeToIso('2030-10-26T09:00', 'Asia/Shanghai')).toBe('2030-10-26T01:00:00.000Z')
    expect(dateTimeInZone('2030-10-26T01:00:00.000Z', 'Asia/Shanghai')).toBe('2030-10-26T09:00')
  })

  it('rejects invalid zones, dates and nonexistent spring-forward times', () => {
    expect(zonedDateTimeToIso('2030-10-26T09:00', 'invalid')).toBeNull()
    expect(zonedDateTimeToIso('2030-02-30T09:00', 'UTC')).toBeNull()
    expect(zonedDateTimeToIso('2030-03-10T02:30', 'America/New_York')).toBeNull()
  })
})
