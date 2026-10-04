// Pure (non-React) kill helpers for LocalShellTask.
// Extracted so runAgent.ts can kill agent-scoped bash tasks without pulling
// React/Ink into its module graph (same rationale as guards.ts).

import type { AppState } from '../../state/AppState.js'
import type { AgentId } from '../../types/ids.js'
import type { ShellCommand } from '../../utils/ShellCommand.js'
import { logForDebugging } from '../../utils/debug.js'
import { logError } from '../../utils/log.js'
import { dequeueAllMatching } from '../../utils/messageQueueManager.js'
import { updateTaskState } from '../../utils/task/framework.js'
import { getLocalShellFinalization, isLocalShellTask, LOCAL_SHELL_ERROR_MESSAGES, type LocalShellTaskState } from './guards.js'
import { writeLocalShellMetadata } from '../../utils/sessionStorage.js'

type SetAppStateFn = (updater: (prev: AppState) => AppState) => void

const TERMINATION_WAIT_MS = 5_000

function getTerminationFailureMessage(source: 'user' | 'agent'): string {
  return source === 'agent'
    ? LOCAL_SHELL_ERROR_MESSAGES.agentTerminationFailed
    : LOCAL_SHELL_ERROR_MESSAGES.userTerminationFailed
}

function persistTerminationState(
  taskId: string,
  task: LocalShellTaskState,
  shellCommand: ShellCommand,
): void {
  const pid = shellCommand.pid
  if (pid === undefined || task.startTime === undefined || !task.sessionId) return
  const outcomeKnown = task.status !== 'running' && task.outcomeKnown === true && task.result?.code !== undefined
  void writeLocalShellMetadata({
    schemaVersion: 1,
    taskId,
    sessionId: task.sessionId,
    shellType: task.shellType ?? 'bash',
    pid,
    startTime: task.startTime,
    lastKnownStatus: task.status === 'running' || task.status === 'pending' ? 'running' : task.status === 'paused' ? 'failed' : task.status,
    error: task.error,
    lastObservedAt: Date.now(),
    outcomeKnown,
    ...(outcomeKnown ? { exitCode: task.result!.code } : {}),
  }, task.projectDir ?? null).catch(logError)
}

export async function killTask(
  taskId: string,
  setAppState: SetAppStateFn,
  terminationSource: 'user' | 'agent' = 'user',
): Promise<boolean> {
  let shellCommand: ShellCommand | null = null
  updateTaskState(taskId, setAppState, task => {
    if (
      task.status !== 'running' ||
      !isLocalShellTask(task) ||
      task.terminationPending ||
      !task.shellCommand
    ) {
      return task
    }

    shellCommand = task.shellCommand
    return {
      ...task,
      terminationRequested: true,
      terminationPending: true,
      terminationSource,
      terminalReason: 'termination_requested',
    }
  })

  if (!shellCommand) {
    return false
  }

  let finalization: Promise<void> | undefined
  try {
    finalization = getLocalShellFinalization(taskId)
  } catch (error) {
    logError(error)
  }

  const failureMessage = getTerminationFailureMessage(terminationSource)
  const settleFailedTermination = async (
    exited: boolean,
    terminalReason: 'termination_request_failed' | 'termination_timeout' = 'termination_request_failed',
  ): Promise<void> => {
    if (exited) {
      await shellCommand!.result
      if (finalization) await finalization
    }

    let cleanupFn: (() => void) | undefined
    let failedTask: LocalShellTaskState | undefined
    updateTaskState(taskId, setAppState, task => {
      if (!isLocalShellTask(task)) return task
      if (exited && task.status !== 'running') {
        failedTask = {
          ...task,
          error: task.error || failureMessage,
          terminationRequested: false,
          terminationPending: false,
          terminationSource: undefined,
          terminalReason: task.terminalReason ?? terminalReason,
        }
        return failedTask
      }
      if (task.status !== 'running') return task
      if (exited) {
        cleanupFn = task.unregisterCleanup
        failedTask = {
          ...task,
          status: 'failed',
          error: failureMessage,
          result: undefined,
          outcomeKnown: false,
          processObservation: 'dead',
          shellCommand: null,
          unregisterCleanup: undefined,
          endTime: Date.now(),
          terminationRequested: false,
          terminationPending: false,
          terminationSource: undefined,
          terminalReason,
        }
        return failedTask
      }
      failedTask = {
        ...task,
        error: failureMessage,
        terminationRequested: false,
        terminationPending: false,
        terminationSource: undefined,
        terminalReason,
      }
      return failedTask
    })

    cleanupFn?.()
    if (exited && cleanupFn) {
      try {
        shellCommand!.cleanup()
      } catch (error) {
        logError(error)
      }
    }
    if (failedTask) {
      persistTerminationState(taskId, failedTask, shellCommand!)
    }
  }

  let terminationConfirmed = false
  let exitObserved = false
  let terminationThrew = false
  try {
    logForDebugging(`LocalShellTask ${taskId} termination requested`)
    if (shellCommand.terminateAndWait) {
      terminationConfirmed = await shellCommand.terminateAndWait(
        TERMINATION_WAIT_MS,
        terminationSource === 'agent' ? 'user' : terminationSource,
      )
      exitObserved = shellCommand.processExited && shellCommand.status !== 'running'
    } else {
      shellCommand.kill()
      exitObserved = await shellCommand.waitForExit(TERMINATION_WAIT_MS)
      terminationConfirmed = exitObserved && shellCommand.status === 'killed'
    }
  } catch (error) {
    terminationThrew = true
    logError(error)
  }

  if (!terminationConfirmed) {
    const exited = shellCommand.processExited || exitObserved
    await settleFailedTermination(exited, terminationThrew ? 'termination_request_failed' : 'termination_timeout')
    return false
  }

  if (!finalization) {
    await settleFailedTermination(true)
    return false
  }

  await (shellCommand.completion ?? shellCommand.result)
  await finalization
  let killed = false
  updateTaskState(taskId, setAppState, task => {
    killed = isLocalShellTask(task) && task.status === 'killed'
    return task
  })
  return killed
}

/**
 * Kill all running bash tasks spawned by a given agent.
 * Called from runAgent.ts finally block so background processes don't outlive
 * the agent that started them (prevents 10-day fake-logs.sh zombies).
 */
export function killShellTasksForAgent(
  agentId: AgentId,
  getAppState: () => AppState,
  setAppState: SetAppStateFn,
): void {
  const tasks = getAppState().tasks ?? {}
  for (const [taskId, task] of Object.entries(tasks)) {
    if (
      isLocalShellTask(task) &&
      task.agentId === agentId &&
      task.status === 'running'
    ) {
      logForDebugging(
        `killShellTasksForAgent: killing orphaned shell task ${taskId} (agent ${agentId} exiting)`,
      )
      void killTask(taskId, setAppState, 'agent').catch(error => {
        logError(error)
      })
    }
  }
  // Purge any queued notifications addressed to this agent — its query loop
  // has exited and won't drain them. killTask fires 'killed' notifications
  // asynchronously; drop the ones already queued and any that land later sit
  // harmlessly (no consumer matches a dead agentId).
  dequeueAllMatching(cmd => cmd.agentId === agentId)
}
