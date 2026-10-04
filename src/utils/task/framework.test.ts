import { afterEach, beforeEach, expect, test } from 'bun:test'
import {
  resetStateForTests,
  setIsInteractive,
  switchSession,
} from '../../bootstrap/state.js'
import type { AppState } from '../../state/AppState.js'
import type { RemoteAgentTaskState } from '../../tasks/RemoteAgentTask/RemoteAgentTask.js'
import type { TaskState } from '../../tasks/types.js'
import { isBackgroundTask } from '../../tasks/types.js'
import type { SessionId } from '../../types/ids.js'
import { drainSdkEvents, emitTaskTerminatedSdk } from '../sdkEventQueue.js'
import {
  applyTaskOffsetsAndEvictions,
  evictTerminalTask,
  generateTaskAttachments,
  registerTask,
} from './framework.js'
import { emitTaskProgress } from './sdkProgress.js'

beforeEach(() => {
  resetStateForTests()
  setIsInteractive(false)
  switchSession('remote-agent-task-started' as SessionId)
  drainSdkEvents()
})

afterEach(() => {
  drainSdkEvents()
  resetStateForTests()
})

test('includes the remote session id in remote Agent start events', () => {
  let state = { tasks: {} } as AppState
  const task = {
    id: 'remote-task-1',
    type: 'remote_agent',
    status: 'running',
    description: 'Review provider failures',
    sessionId: 'remote-session-1',
    toolUseId: 'remote-tool-1',
  } as RemoteAgentTaskState

  registerTask(task, (updater) => {
    state = updater(state)
  })

  expect(drainSdkEvents()).toContainEqual(expect.objectContaining({
    type: 'system',
    subtype: 'task_started',
    task_id: 'remote-task-1',
    task_type: 'remote_agent',
    remote_session_id: 'remote-session-1',
  }))
})

function makeTask(
  overrides: Partial<TaskState> & Pick<TaskState, 'id' | 'type'>,
): TaskState {
  return {
    status: 'running',
    description: 'Background work',
    startTime: 1,
    outputFile: '/tmp/task.output',
    outputOffset: 0,
    notified: false,
    ...overrides,
  } as unknown as TaskState
}

function makeHarness() {
  let state = { tasks: {} } as unknown as AppState
  return {
    get state() {
      return state
    },
    setAppState(updater: (prev: AppState) => AppState) {
      state = updater(state)
    },
  }
}

test('keeps a recovered unknown shell task visible as a background task', () => {
  const task = makeTask({
    id: 'unknown-shell-task',
    type: 'local_bash',
    status: 'unknown',
    notified: true,
    isBackgrounded: true,
  })

  expect(isBackgroundTask(task)).toBe(true)
})

test('does not evict a recovered unknown shell task', async () => {
  const task = makeTask({
    id: 'unknown-shell-task',
    type: 'local_bash',
    status: 'unknown',
    notified: true,
    isBackgrounded: true,
  })
  const harness = makeHarness()
  harness.setAppState(prev => ({ ...prev, tasks: { [task.id]: task } }))

  const result = await generateTaskAttachments(harness.state)
  applyTaskOffsetsAndEvictions(harness.setAppState, result.updatedTaskOffsets, result.evictedTaskIds)

  expect(harness.state.tasks[task.id]).toBe(task)
  applyTaskOffsetsAndEvictions(harness.setAppState, {}, [task.id])
  expect(harness.state.tasks[task.id]).toBe(task)
})

test('does not eagerly evict a recovered unknown shell task', () => {
  const task = makeTask({
    id: 'unknown-shell-task',
    type: 'local_bash',
    status: 'unknown',
    notified: true,
    isBackgrounded: true,
  })
  const harness = makeHarness()
  harness.setAppState(prev => ({ ...prev, tasks: { [task.id]: task } }))

  evictTerminalTask(task.id, harness.setAppState)

  expect(harness.state.tasks[task.id]).toBe(task)
})

test('emits a task_started event for a main-thread shell task', () => {
  const harness = makeHarness()
  const task = makeTask({
    id: 'main-shell-task',
    type: 'local_bash',
    toolUseId: 'main-shell-tool',
  })

  registerTask(task, harness.setAppState)

  expect(harness.state.tasks['main-shell-task']).toBe(task)
  expect(drainSdkEvents()).toContainEqual(expect.objectContaining({
    type: 'system',
    subtype: 'task_started',
    task_id: 'main-shell-task',
    tool_use_id: 'main-shell-tool',
    task_type: 'local_bash',
  }))
})

test('does not expose a subagent-owned shell task as a session background task', () => {
  const harness = makeHarness()
  const task = makeTask({
    id: 'subagent-shell-task',
    type: 'local_bash',
    toolUseId: 'subagent-shell-tool',
    agentId: 'subagent-1',
  })

  registerTask(task, harness.setAppState)

  expect(harness.state.tasks['subagent-shell-task']).toBe(task)
  expect(drainSdkEvents()).toEqual([])
})

test('still exposes a local agent task in the session activity stream', () => {
  const harness = makeHarness()
  const task = makeTask({
    id: 'subagent-task',
    type: 'local_agent',
    toolUseId: 'agent-tool',
    agentId: 'subagent-task',
  })

  registerTask(task, harness.setAppState)

  const [event] = drainSdkEvents()
  expect(event).toEqual(expect.objectContaining({
    type: 'system',
    subtype: 'task_started',
    task_id: 'subagent-task',
    tool_use_id: 'agent-tool',
    task_type: 'local_agent',
  }))
  expect(event).not.toHaveProperty('owner_agent_id')
})

test('tags a nested local agent start and progress with its owning agent', () => {
  const harness = makeHarness()
  const task = makeTask({
    id: 'nested-agent-task',
    type: 'local_agent',
    toolUseId: 'nested-agent-tool',
    agentId: 'nested-agent-task',
    ownerAgentId: 'parent-agent',
  })

  registerTask(task, harness.setAppState)
  emitTaskProgress({
    taskId: task.id,
    toolUseId: task.toolUseId,
    description: task.description,
    startTime: task.startTime,
    totalTokens: 10,
    toolUses: 1,
    ownerAgentId: 'parent-agent',
  })

  expect(drainSdkEvents()).toEqual([
    expect.objectContaining({
      subtype: 'task_started',
      task_id: 'nested-agent-task',
      owner_agent_id: 'parent-agent',
    }),
    expect.objectContaining({
      subtype: 'task_progress',
      task_id: 'nested-agent-task',
      owner_agent_id: 'parent-agent',
    }),
  ])
})

test('scopes an in-process teammate container lifecycle to the member run', () => {
  const harness = makeHarness()
  const task = makeTask({
    id: 'team-member-container',
    type: 'in_process_teammate',
    toolUseId: 'team-member-tool',
    identity: { agentId: 'reviewer@audit-team' },
  } as Partial<TaskState> & Pick<TaskState, 'id' | 'type'>)

  registerTask(task, harness.setAppState)
  emitTaskTerminatedSdk(task.id, 'completed', {
    toolUseId: task.toolUseId,
    ownerAgentId: 'reviewer@audit-team',
  })

  expect(harness.state.tasks[task.id]).toBe(task)
  expect(drainSdkEvents()).toEqual([
    expect.objectContaining({
      subtype: 'task_started',
      task_id: task.id,
      task_type: 'in_process_teammate',
      owner_agent_id: 'reviewer@audit-team',
    }),
    expect.objectContaining({
      subtype: 'task_notification',
      task_id: task.id,
      owner_agent_id: 'reviewer@audit-team',
    }),
  ])
})

test('includes the stable run id in workflow start events', () => {
  const harness = makeHarness()
  const task = makeTask({
    id: 'workflow-task-1',
    type: 'local_workflow',
    workflowName: 'review-codebase',
    workflowRunId: 'wf_shared-run-1',
  } as Partial<TaskState> & Pick<TaskState, 'id' | 'type'>)

  registerTask(task, harness.setAppState)

  expect(drainSdkEvents()).toContainEqual(expect.objectContaining({
    type: 'system',
    subtype: 'task_started',
    task_id: 'workflow-task-1',
    task_type: 'local_workflow',
    workflow_name: 'review-codebase',
    workflow_run_id: 'wf_shared-run-1',
  }))
})

test('includes the stable run id in workflow progress events', () => {
  emitTaskProgress({
    taskId: 'workflow-task-1',
    toolUseId: 'workflow-tool-1',
    description: 'Verify: verify:3',
    startTime: Date.now(),
    totalTokens: 1200,
    toolUses: 4,
    workflowRunId: 'wf_shared-run-1',
    workflowProgress: [],
  })

  expect(drainSdkEvents()).toContainEqual(expect.objectContaining({
    type: 'system',
    subtype: 'task_progress',
    task_id: 'workflow-task-1',
    workflow_run_id: 'wf_shared-run-1',
  }))
})

test('keeps the original Agent tool_use id but routes a warm resume to its current owner', () => {
  const harness = makeHarness()
  const spawned = makeTask({
    id: 'resumable-agent',
    type: 'local_agent',
    toolUseId: 'toolu_agent',
    agentId: 'resumable-agent',
    retain: true,
    ownerAgentId: 'parent-agent',
  })
  registerTask(spawned, harness.setAppState)
  drainSdkEvents()

  // SendMessage resumes a stopped agent and re-registers it with its own id.
  const resumed = makeTask({
    id: 'resumable-agent',
    type: 'local_agent',
    toolUseId: 'toolu_sendmessage',
    agentId: 'resumable-agent',
    retain: false,
    ownerAgentId: 'current-parent-agent',
  })
  registerTask(resumed, harness.setAppState)

  expect(harness.state.tasks['resumable-agent']?.toolUseId).toBe('toolu_agent')
  expect(
    (harness.state.tasks['resumable-agent'] as { ownerAgentId?: string })
      .ownerAgentId,
  ).toBe('current-parent-agent')
  expect(drainSdkEvents()).toEqual([])
})

test('keeps the existing owner when a resume has no current owner', () => {
  const harness = makeHarness()
  registerTask(makeTask({
    id: 'resumable-agent',
    type: 'local_agent',
    agentId: 'resumable-agent',
    retain: true,
    ownerAgentId: 'parent-agent',
  }), harness.setAppState)
  drainSdkEvents()

  registerTask(makeTask({
    id: 'resumable-agent',
    type: 'local_agent',
    agentId: 'resumable-agent',
    retain: false,
  }), harness.setAppState)

  expect(
    (harness.state.tasks['resumable-agent'] as { ownerAgentId?: string })
      .ownerAgentId,
  ).toBe('parent-agent')
  expect(drainSdkEvents()).toEqual([])
})
