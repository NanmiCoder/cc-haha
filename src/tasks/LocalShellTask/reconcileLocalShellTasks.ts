import { getSessionId, getSessionProjectDir } from '../../bootstrap/state.js'
import type { SetAppState } from '../../Task.js'
import {
  listLocalShellMetadata,
  readLocalShellMetadata,
  writeLocalShellMetadata,
  type LocalShellMetadata,
} from '../../utils/sessionStorage.js'
import type { TaskState } from '../types.js'
import { logError } from '../../utils/log.js'
import { isLocalShellTask, LOCAL_SHELL_ERROR_MESSAGES } from './guards.js'
import type { ProcessProbeState } from '../../utils/genericProcessUtils.js'
import {
  createRecoveredLocalShellTask,
  createUnverifiedRecoveredLocalShellTask,
} from './resolveLocalShellTask.js'

function applyObservation(
  metadata: LocalShellMetadata,
  observation: ProcessProbeState | undefined,
  setAppState: SetAppState,
  isCurrentSnapshot: () => boolean,
): void {
  setAppState(prev => {
    if (!isCurrentSnapshot()) return prev
    const existing = prev.tasks?.[metadata.taskId]
    if (
      existing &&
      isLocalShellTask(existing) &&
      (existing.shellCommand || existing.status !== 'running')
    ) {
      return prev
    }
    const recovered = createRecoveredLocalShellTask(metadata, observation)
    const task = existing && isLocalShellTask(existing)
      ? {
          ...existing,
          status: recovered.status,
          error: recovered.error,
          result: recovered.result,
          shellCommand: null,
          unregisterCleanup: undefined,
          notified: recovered.notified,
          endTime: recovered.endTime,
          terminalReason: recovered.terminalReason,
          processObservation: recovered.processObservation,
          outcomeKnown: recovered.outcomeKnown,
          reconciledAt: recovered.reconciledAt,
          sessionId: recovered.sessionId,
          shellType: recovered.shellType,
        }
      : recovered
    return { ...prev, tasks: { ...prev.tasks, [metadata.taskId]: task } }
  })
}

export async function reconcileLocalShellTasks(
  setAppState: SetAppState,
): Promise<void> {
  const sessionId = getSessionId()
  const projectDir = getSessionProjectDir()
  const isCurrentSnapshot = (): boolean =>
    getSessionId() === sessionId && getSessionProjectDir() === projectDir
  let metadata: LocalShellMetadata[] = []
  try {
    metadata = await listLocalShellMetadata(sessionId, projectDir)
  } catch (error) {
    logError(error)
  }
  if (!isCurrentSnapshot()) return
  try {
    const metadataByTaskId = new Map(metadata.map(entry => [entry.taskId, entry]))
    const restoredRunningTasks: string[] = []
    setAppState(prev => {
      if (!isCurrentSnapshot()) return prev
      for (const task of Object.values(prev.tasks ?? {}) as TaskState[]) {
        if (isLocalShellTask(task) && task.status === 'running' && !task.shellCommand && !metadataByTaskId.has(task.id)) {
          restoredRunningTasks.push(task.id)
        }
      }
      return prev
    })
    for (const entry of metadata) {
      if (!isCurrentSnapshot()) return
      const isRunning = entry.lastKnownStatus === 'running'
      const observation = isRunning || entry.lastKnownStatus === 'unknown' ? 'unknown' : undefined
      const recoveredMetadata: LocalShellMetadata = isRunning
        ? {
            ...entry,
            lastKnownStatus: 'unknown',
            terminalReason: 'process_state_unverified',
            error: LOCAL_SHELL_ERROR_MESSAGES.processStateUnknown,
            lastObservedAt: Date.now(),
            outcomeKnown: false,
          }
        : entry
      if (isRunning) {
        await writeLocalShellMetadata(recoveredMetadata, projectDir).catch(logError)
        if (!isCurrentSnapshot()) return
        const persistedMetadata = await readLocalShellMetadata(entry.taskId, sessionId, projectDir)
        if (!isCurrentSnapshot()) return
        if (persistedMetadata) {
          applyObservation(persistedMetadata, persistedMetadata.lastKnownStatus === 'unknown' ? 'unknown' : undefined, setAppState, isCurrentSnapshot)
          continue
        }
      }
      applyObservation(recoveredMetadata, observation, setAppState, isCurrentSnapshot)
      if (!isCurrentSnapshot()) return
    }
    for (const taskId of restoredRunningTasks) {
      if (!isCurrentSnapshot()) return
      setAppState(prev => {
        if (!isCurrentSnapshot()) return prev
        const task = prev.tasks?.[taskId]
        if (!isLocalShellTask(task) || task.status !== 'running' || task.shellCommand) return prev
        return {
          ...prev,
          tasks: {
            ...prev.tasks,
            [taskId]: createUnverifiedRecoveredLocalShellTask(task),
          },
        }
      })
    }
  } catch (error) {
    logError(error)
  }
}
