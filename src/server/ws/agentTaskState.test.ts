import { afterEach, describe, expect, test } from 'bun:test'
import { clearAgentRuntimeState, getCliBackgroundTaskLifecycle, getOfficialSdkTaskLifecycles, markTaskAuthoritativelyStopped, officialSdkTaskStates } from './agentTaskState.js'

describe('getCliBackgroundTaskLifecycle ownership', () => {
  test('keeps root task ownership implicit', () => {
    expect(getCliBackgroundTaskLifecycle({
      type: 'system',
      subtype: 'task_started',
      task_id: 'root-agent',
      task_type: 'local_agent',
    })).toEqual({
      taskId: 'root-agent',
      running: true,
      taskType: 'local_agent',
      toolUseId: undefined,
      remoteSessionId: undefined,
      description: undefined,
      ownerAgentId: undefined,
    })
  })

  test('carries nested ownership from start through terminal lifecycle', () => {
    expect(getCliBackgroundTaskLifecycle({
      type: 'system',
      subtype: 'task_started',
      task_id: 'nested-agent',
      task_type: 'local_agent',
      owner_agent_id: 'parent-agent',
    })).toEqual(expect.objectContaining({
      taskId: 'nested-agent',
      running: true,
      ownerAgentId: 'parent-agent',
    }))

    expect(getCliBackgroundTaskLifecycle({
      type: 'system',
      subtype: 'task_notification',
      task_id: 'nested-agent',
      status: 'completed',
      owner_agent_id: 'parent-agent',
    })).toEqual({
      taskId: 'nested-agent',
      running: false,
      status: 'completed',
      ownerAgentId: 'parent-agent',
    })
  })
})

describe('native task generation tracking', () => {
  const session = 'native-task-fixture'
  const observe = (subtype: string, data: Record<string, unknown>) =>
    getOfficialSdkTaskLifecycles(session, { type: 'system', cc_haha_agent_sdk: true, subtype, ...data })
  afterEach(() => clearAgentRuntimeState(session))

  test('retains stopped generation and admits only a newer native resume', () => {
    observe('task_started', { task_id: 'agent', run_id: '2', task_type: 'local_agent', tool_use_id: 'tool' })
    markTaskAuthoritativelyStopped(session, 'agent')
    expect(observe('task_progress', { task_id: 'agent', run_id: '2' })?.stale).toBe(true)
    expect(observe('task_started', { task_id: 'agent', run_id: '3' })?.lifecycles).toEqual([
      expect.objectContaining({ taskId: 'agent', runId: '3', newRun: true, running: true, taskType: 'local_agent', toolUseId: 'tool' }),
    ])
    for (const subtype of ['task_started', 'task_progress', 'task_notification', 'task_updated']) {
      expect(observe(subtype, { task_id: 'agent', run_id: '2', status: 'failed', patch: { status: 'failed' } })?.stale).toBe(true)
    }
    expect(observe('task_notification', { task_id: 'agent', status: 'failed' })?.stale).toBe(true)
  })

  test('merges foreground/background and pause patches, then settles terminal patches', () => {
    observe('task_started', { task_id: 'agent', run_id: '1', is_backgrounded: false })
    expect(observe('task_updated', { task_id: 'agent', run_id: '1', patch: { is_backgrounded: true, status: 'paused' } })?.lifecycles).toEqual([
      expect.objectContaining({ backgrounded: true, running: true, status: 'paused' }),
    ])
    expect(observe('task_updated', { task_id: 'agent', run_id: '1', patch: { status: 'killed' } })?.lifecycles).toEqual([
      expect.objectContaining({ running: false, status: 'killed' }),
    ])
    expect(observe('task_started', { task_id: 'agent', run_id: '1' })?.stale).toBe(true)
  })

  test('snapshots replace native background membership without killing foreground or a newer run', () => {
    observe('task_started', { task_id: 'foreground', run_id: '1', is_backgrounded: false })
    observe('task_started', { task_id: 'missing', run_id: '1', is_backgrounded: true })
    observe('task_started', { task_id: 'newer', run_id: '2', is_backgrounded: true })
    const result = observe('background_tasks_changed', { tasks: [
      { task_id: 'newer', run_id: '1', task_type: 'local_agent' },
      { task_id: 'recovered', run_id: '1', task_type: 'mcp_task' },
    ] })!
    expect(result.snapshot).toBe(true)
    expect(result.stale).toBeUndefined()
    expect(result.lifecycles).toHaveLength(2)
    expect(result.lifecycles).toContainEqual(expect.objectContaining({ taskId: 'missing', running: false }))
    expect(result.lifecycles).toContainEqual(expect.objectContaining({ taskId: 'recovered', running: true, backgrounded: true }))
    expect(officialSdkTaskStates.get(session)?.get('foreground')?.status).toBe('running')
    expect(officialSdkTaskStates.get(session)?.get('newer')?.runId).toBe('2')
  })

  test('malformed snapshots leave native tasks intact and cleanup releases generations', () => {
    observe('task_started', { task_id: 'agent', run_id: '1' })
    expect(observe('background_tasks_changed', { tasks: [{}] })).toBeNull()
    expect(officialSdkTaskStates.get(session)?.get('agent')?.status).toBe('running')
    clearAgentRuntimeState(session)
    expect(officialSdkTaskStates.has(session)).toBe(false)
  })
})
