// Shared logic for stopping a running task.
// Used by TaskStopTool (LLM-invoked) and SDK stop_task control request.

import type { AppState } from '../state/AppState.js'
import type { TaskStateBase } from '../Task.js'
import { getTaskByType } from '../tasks.js'
import { emitTaskTerminatedSdk } from '../utils/sdkEventQueue.js'
import { isLocalShellTask } from './LocalShellTask/guards.js'

export class StopTaskError extends Error {
  constructor(
    message: string,
    public readonly code: 'not_found' | 'not_running' | 'unsupported_type',
  ) {
    super(message)
    this.name = 'StopTaskError'
  }
}

type StopTaskContext = {
  getAppState: () => AppState
  setAppState: (f: (prev: AppState) => AppState) => void
}

type StopTaskResult = {
  taskId: string
  taskType: string
  command: string | undefined
}

/**
 * Look up a task by ID, validate it is running, kill it, and mark it as notified.
 *
 * Throws {@link StopTaskError} when the task cannot be stopped (not found,
 * not running, or unsupported type). Callers can inspect `error.code` to
 * distinguish the failure reason.
 */
export async function stopTask(
  taskId: string,
  context: StopTaskContext,
): Promise<StopTaskResult> {
  const { getAppState, setAppState } = context
  const appState = getAppState()
  const task = appState.tasks?.[taskId] as TaskStateBase | undefined

  if (!task) {
    throw new StopTaskError(`No task found with ID: ${taskId}`, 'not_found')
  }

  if (task.status !== 'running') {
    throw new StopTaskError(
      `Task ${taskId} is not running (status: ${task.status})`,
      'not_running',
    )
  }

  const taskImpl = getTaskByType(task.type)
  if (!taskImpl) {
    throw new StopTaskError(
      `Unsupported task type: ${task.type}`,
      'unsupported_type',
    )
  }

  // LocalShellTask.kill() atomically marks the task notified before returning.
  // Capture the pre-kill state so the desktop SDK bookend is not suppressed by
  // that implementation detail.
  const shouldEmitShellTermination =
    isLocalShellTask(task) && !task.agentId && !task.notified

  await taskImpl.kill(taskId, setAppState)

  // Bash: suppress the "exit code 137" notification (noise). Agent tasks: don't
  // suppress — the AbortError catch sends a notification carrying
  // extractPartialResult(agentMessages), which is the payload not noise.
  if (isLocalShellTask(task)) {
    setAppState(prev => {
      const prevTask = prev.tasks[taskId]
      if (!prevTask || prevTask.notified) {
        return prev
      }
      return {
        ...prev,
        tasks: {
          ...prev.tasks,
          [taskId]: { ...prevTask, notified: true },
        },
      }
    })
    // Suppressing the XML notification also suppresses print.ts's parsed
    // task_notification SDK event — emit it directly so SDK consumers see
    // the task close.
    if (shouldEmitShellTermination) {
      emitTaskTerminatedSdk(taskId, 'stopped', {
        toolUseId: task.toolUseId,
        summary: task.description,
      })
    }
  }

  const command = isLocalShellTask(task) ? task.command : task.description

  return { taskId, taskType: task.type, command }
}

export type StopTaskControlResult =
  | { ok: true; alreadyGone: boolean }
  | { ok: false; message: string }

/**
 * stop_task control-request variant of {@link stopTask}. The LLM-facing
 * TaskStop tool must keep erroring on unknown ids so the model learns its
 * handle is stale, but the control channel is driven by UI Stop buttons whose
 * view of the task list lags the registry: shell tasks are evicted the turn
 * after they terminate, and a process restart clears the registry entirely.
 * A not_found there means the stop's goal state — not running — already
 * holds, so it reports success instead of an error. Callers key off
 * `alreadyGone` to converge any still-"running" entry of their own.
 */
export async function stopTaskFromControlRequest(
  taskId: string,
  context: StopTaskContext,
): Promise<StopTaskControlResult> {
  try {
    await stopTask(taskId, context)
    return { ok: true, alreadyGone: false }
  } catch (error) {
    if (error instanceof StopTaskError && error.code === 'not_found') {
      return { ok: true, alreadyGone: true }
    }
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    }
  }
}
