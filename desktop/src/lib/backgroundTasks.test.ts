import { describe, expect, it } from 'vitest'
import type { BackgroundAgentTask } from '../types/chat'
import {
  formatDurationMs,
  formatDurationSeconds,
  hasRunningBackgroundTasks,
  hasRunningSubagentTasks,
  isVisibleSessionBackgroundTask,
  listRunningBackgroundTasks,
} from './backgroundTasks'
import { translate } from '../i18n'

function task(
  taskId: string,
  overrides: Partial<BackgroundAgentTask> = {},
): BackgroundAgentTask {
  return {
    taskId,
    status: 'running',
    startedAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

it('does not mark native ambient, paused or foreground work as busy background work', () => {
  for (const metadata of [{ ambient: true }, { skipTranscript: true }, { nativeStatus: 'paused' as const }, { isBackgrounded: false }]) {
    const tasks = { native: task('native', { taskType: 'local_agent', nativeTask: true, ...metadata }) }
    expect(hasRunningBackgroundTasks(tasks)).toBe(false)
    expect(hasRunningSubagentTasks(tasks)).toBe(false)
  }
})

describe('hasRunningBackgroundTasks', () => {
  it('does not treat AutoDream as foreground session activity', () => {
    expect(hasRunningBackgroundTasks({
      dream: task('dream', { taskType: 'dream' }),
    })).toBe(false)
  })

  it('still reports user-started background tasks as running', () => {
    expect(hasRunningBackgroundTasks({
      shell: task('shell', { taskType: 'local_bash' }),
      dream: task('dream', { taskType: 'dream' }),
    })).toBe(true)
  })

  it('does not keep a session busy for teammate runtime containers', () => {
    const teammate = task('teammate', { taskType: 'in_process_teammate' })
    expect(isVisibleSessionBackgroundTask(teammate)).toBe(false)
    expect(hasRunningBackgroundTasks({ teammate })).toBe(false)
    expect(hasRunningSubagentTasks({ teammate })).toBe(false)
  })
})

describe('listRunningBackgroundTasks', () => {
  it('lists user-started tasks that are still running, in insertion order', () => {
    const tasks = {
      shell: task('shell', { taskType: 'local_bash' }),
      agent: task('agent', { taskType: 'local_agent' }),
      workflow: task('workflow', { taskType: 'local_workflow' }),
    }
    expect(listRunningBackgroundTasks(tasks).map((entry) => entry.taskId)).toEqual(['shell', 'agent', 'workflow'])
  })

  it('leaves out finished tasks, AutoDream and teammate runtime containers', () => {
    const tasks = {
      shell: task('shell', { taskType: 'local_bash' }),
      completed: task('completed', { taskType: 'local_bash', status: 'completed' }),
      failed: task('failed', { taskType: 'local_bash', status: 'failed' }),
      stopped: task('stopped', { taskType: 'local_bash', status: 'stopped' }),
      dream: task('dream', { taskType: 'dream' }),
      teammate: task('teammate', { taskType: 'in_process_teammate' }),
    }
    expect(listRunningBackgroundTasks(tasks).map((entry) => entry.taskId)).toEqual(['shell'])
  })

  it('is empty for a missing task record', () => {
    expect(listRunningBackgroundTasks(undefined)).toEqual([])
    expect(listRunningBackgroundTasks({})).toEqual([])
  })

  it('agrees with hasRunningBackgroundTasks about what counts as running', () => {
    const records: Array<Record<string, BackgroundAgentTask>> = [
      {},
      { dream: task('dream', { taskType: 'dream' }) },
      { teammate: task('teammate', { taskType: 'in_process_teammate' }) },
      { done: task('done', { status: 'completed' }) },
      { shell: task('shell', { taskType: 'local_bash' }) },
      { shell: task('shell', { taskType: 'local_bash' }), dream: task('dream', { taskType: 'dream' }) },
    ]
    for (const record of records) {
      expect(listRunningBackgroundTasks(record).length > 0).toBe(hasRunningBackgroundTasks(record))
    }
  })
})

describe('hasRunningSubagentTasks', () => {
  it.each(['local_agent', 'remote_agent'])('reports a running %s as stoppable', (taskType) => {
    expect(hasRunningSubagentTasks({
      agent: task('agent', { taskType }),
    })).toBe(true)
  })

  it.each(['local_bash', 'dream', undefined])('does not treat %s as a stoppable SubAgent', (taskType) => {
    expect(hasRunningSubagentTasks({
      task: task('task', { taskType }),
    })).toBe(false)
  })

  it('ignores an Agent that already reached a terminal status', () => {
    expect(hasRunningSubagentTasks({
      agent: task('agent', { taskType: 'local_agent', status: 'stopped' }),
    })).toBe(false)
  })
})

describe('formatDurationSeconds', () => {
  const t = (key: Parameters<typeof translate>[1], params?: Record<string, string | number>) =>
    translate('en', key, params)

  it.each([
    [0, '0s'],
    [45, '45s'],
    [59.4, '59s'],
    [60, '1m 0s'],
    [739, '12m 19s'],
  ])('writes %ss as %s', (seconds, expected) => {
    expect(formatDurationSeconds(seconds, t)).toBe(expected)
  })

  it('carries into hours instead of printing three-digit minutes', () => {
    expect(formatDurationSeconds(75 * 60 + 30, t)).toBe('1h 15m')
    expect(formatDurationSeconds(2 * 3600, t)).toBe('2h 0m')
  })

  it('respects the minimum floor used by still-running tasks', () => {
    expect(formatDurationSeconds(0.2, t, 1)).toBe('1s')
  })
})

describe('formatDurationMs', () => {
  const t = (key: Parameters<typeof translate>[1], params?: Record<string, string | number>) =>
    translate('en', key, params)

  it('returns null for a missing or negative duration', () => {
    expect(formatDurationMs(undefined, t)).toBeNull()
    expect(formatDurationMs(-1, t)).toBeNull()
  })

  it('rounds milliseconds to whole seconds', () => {
    expect(formatDurationMs(739_000, t)).toBe('12m 19s')
  })
})
