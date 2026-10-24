import { describe, expect, it } from 'vitest'
import { applyOfficialSdkTaskEvent, type OfficialSdkBackgroundTask } from './officialAgentSdkEvents'

const initial = (extra: Partial<OfficialSdkBackgroundTask> = {}): OfficialSdkBackgroundTask => ({
  taskId: 'task', status: 'running', startedAt: 10, updatedAt: 10, ...extra,
})

describe('official SDK task notifications', () => {
  it('merges patches without replacing absent metadata and keeps explicit false, empty and zero', () => {
    const current = { task: initial({ nativeTask: true, runId: 'r2', toolUseId: 'tool', description: 'Before', usage: { totalTokens: 9 } }) }
    const next = applyOfficialSdkTaskEvent(current, 'task_updated', {
      task_id: 'task', run_id: 'r2',
      patch: { description: '', is_backgrounded: false, total_paused_ms: 0, status: 'paused' },
    }, 20)!
    expect(next.task).toMatchObject({ description: '', isBackgrounded: false, totalPausedMs: 0,
      nativeStatus: 'paused', status: 'running', toolUseId: 'tool', usage: { totalTokens: 9 }, startedAt: 10, updatedAt: 20 })
    expect(current.task.description).toBe('Before')
  })

  it('orders native run ids lexically and rejects late or unversioned events', () => {
    const current = { task: initial({ nativeTask: true, runId: 'a-2' }) }
    for (const subtype of ['task_started', 'task_progress', 'task_notification', 'task_updated']) {
      for (const run_id of ['a-1', undefined]) {
        expect(applyOfficialSdkTaskEvent(current, subtype, { task_id: 'task', run_id, status: 'failed', patch: { status: 'failed' } }, 20)).toBe(current)
      }
    }
    // Plain lexical order is documented; numeric suffix interpretation is wrong.
    expect(applyOfficialSdkTaskEvent(current, 'task_started', { task_id: 'task', run_id: 'a-10' }, 20)).toBe(current)
  })

  it('starts a fresh run without old results, terminal summaries or usage', () => {
    const current = { task: initial({ runId: 'r1', status: 'failed', nativeStatus: 'failed',
      toolUseId: 'tool', taskType: 'local_agent', parentTaskId: 'parent',
      result: 'old result', summary: 'old summary', error: 'old error', outputFile: '/old',
      usage: { totalTokens: 999 }, endedAt: 15, totalPausedMs: 5, completionInferred: true }) }
    const next = applyOfficialSdkTaskEvent(current, 'task_progress', {
      task_id: 'task', run_id: 'r2', description: 'New run', usage: { total_tokens: 3 },
    }, 30)!
    expect(next.task).toMatchObject({ runId: 'r2', status: 'running', nativeStatus: 'running',
      taskType: 'local_agent', toolUseId: 'tool', parentTaskId: 'parent', startedAt: 30,
      usage: { totalTokens: 3 } })
    for (const field of ['result', 'summary', 'error', 'outputFile', 'endedAt', 'totalPausedMs', 'completionInferred']) {
      expect(next.task).not.toHaveProperty(field)
    }
  })

  it('does not reopen a completed run on duplicate start, progress, running patch or stale snapshot', () => {
    const current = { task: initial({ nativeTask: true, runId: 'r2', status: 'completed', nativeStatus: 'completed' }) }
    for (const subtype of ['task_started', 'task_progress', 'task_updated']) {
      expect(applyOfficialSdkTaskEvent(current, subtype, { task_id: 'task', run_id: 'r2', patch: { status: 'running' } }, 30)).toBe(current)
    }
    expect(applyOfficialSdkTaskEvent(current, 'background_tasks_changed', {
      tasks: [{ task_id: 'task', run_id: 'r2' }],
    }, 30)).toBe(current)
    expect(applyOfficialSdkTaskEvent(current, 'task_updated', {
      task_id: 'task', run_id: 'r2', patch: { description: 'Final description', end_time: 15 },
    }, 30)!.task).toMatchObject({ status: 'completed', description: 'Final description', endedAt: 15 })
  })

  it('applies complete background snapshots while keeping foreground and legacy tasks', () => {
    const current = {
      ended: initial({ taskId: 'ended', nativeTask: true, isBackgrounded: true, runId: 'r1' }),
      foreground: initial({ taskId: 'foreground', nativeTask: true, isBackgrounded: false }),
      legacy: initial({ taskId: 'legacy' }),
    }
    const next = applyOfficialSdkTaskEvent(current, 'background_tasks_changed', { tasks: [{
      task_id: 'fresh', run_id: 'r2', task_type: 'mcp_task', description: 'Reading',
      parent_task_id: 'parent', ambient: true,
    }] }, 40)!
    expect(next.ended).toMatchObject({ status: 'completed', completionInferred: true })
    expect(next.foreground).toBe(current.foreground)
    expect(next.legacy).toBe(current.legacy)
    expect(next.fresh).toMatchObject({ taskId: 'fresh', runId: 'r2', status: 'running', taskType: 'mcp_task',
      parentTaskId: 'parent', description: 'Reading', ambient: true, nativeTask: true, isBackgrounded: true })
    const afterTerminal = applyOfficialSdkTaskEvent(next, 'task_notification', {
      task_id: 'ended', run_id: 'r1', status: 'failed', summary: 'Actual error',
    }, 45)!
    expect(afterTerminal.ended).toMatchObject({ status: 'failed', summary: 'Actual error', completionInferred: false })
    expect(applyOfficialSdkTaskEvent(afterTerminal, 'background_tasks_changed', { tasks: [] }, 50)!.fresh?.status).toBe('completed')
  })

  it('preserves the newer run when an older run remains in a snapshot', () => {
    const current = { task: initial({ nativeTask: true, runId: 'r2', isBackgrounded: true }) }
    expect(applyOfficialSdkTaskEvent(current, 'background_tasks_changed', {
      tasks: [{ task_id: 'task', run_id: 'r1' }],
    }, 50)).toBe(current)
  })

  it('preserves native ambient/task details and merges progress usage', () => {
    const started = applyOfficialSdkTaskEvent({}, 'task_started', {
      task_id: 'task', run_id: 'r1', is_backgrounded: true, skip_transcript: true,
      ambient: false, subagent_type: 'researcher', spawn_depth: 2, tool_use_id: 'tool',
    }, 10)!
    expect(started.task).toMatchObject({ ambient: true, skipTranscript: true, subagentType: 'researcher', spawnDepth: 2 })
    const progress = applyOfficialSdkTaskEvent(started, 'task_progress', {
      task_id: 'task', run_id: 'r1', summary: 'Reading sources',
      usage: { total_tokens: 10, tool_uses: 2, duration_ms: 3 },
    }, 20)!
    const ended = applyOfficialSdkTaskEvent(progress, 'task_updated', {
      task_id: 'task', run_id: 'r1', patch: { status: 'killed', error: 'Worker restarted' },
    }, 30)!
    expect(ended.task).toMatchObject({ status: 'stopped', nativeStatus: 'killed', error: 'Worker restarted',
      summary: 'Reading sources', usage: { totalTokens: 10, toolUses: 2, durationMs: 3 } })
  })

  it('accepts legacy task starts but rejects malformed level snapshots without clearing activity', () => {
    const current = { task: initial({ nativeTask: true, status: 'completed' }) }
    expect(applyOfficialSdkTaskEvent(current, 'task_started', { task_id: 'task' }, 20)!.task).toMatchObject({ status: 'running', startedAt: 20 })
    for (const data of [{ tasks: null }, { tasks: [{}] }, { tasks: [null] }]) {
      expect(applyOfficialSdkTaskEvent(current, 'background_tasks_changed', data, 30)).toBeNull()
    }
    expect(applyOfficialSdkTaskEvent(current, 'init', {}, 30)).toBeNull()
  })
})
