import { getSessionId, getSessionProjectDir } from '../../bootstrap/state.js'
import type { AppState } from '../../state/AppState.js'
import type { TaskState } from '../types.js'
import { readLocalShellMetadata, writeLocalShellMetadata, type LocalShellMetadata } from '../../utils/sessionStorage.js'
import { getTaskOutputPath } from '../../utils/task/diskOutput.js'
import type { ProcessProbeState } from '../../utils/genericProcessUtils.js'
import { isLocalShellTask, LOCAL_SHELL_ERROR_MESSAGES, type LocalShellTaskState, type TerminalReason } from './guards.js'

export type ResolvedLocalShellTask = {
  task: TaskState
  metadata?: LocalShellMetadata
  processObservation?: ProcessProbeState
  canStop: boolean
}

export function createRecoveredLocalShellTask(
  metadata: LocalShellMetadata,
  processObservation?: ProcessProbeState,
): LocalShellTaskState {
  const isUnverified = metadata.lastKnownStatus === 'running' || metadata.lastKnownStatus === 'unknown'
  const outcomeKnown = isUnverified ? false : metadata.outcomeKnown
  const status = isUnverified ? 'unknown' : metadata.lastKnownStatus
  const terminalReason: TerminalReason | undefined = isUnverified
    ? 'process_state_unverified'
    : metadata.terminalReason as TerminalReason | undefined

  const reconciledAt = Date.now()
  return {
    id: metadata.taskId,
    type: 'local_bash',
    status,
    error: isUnverified ? LOCAL_SHELL_ERROR_MESSAGES.processStateUnknown : metadata.error ?? '',
    description: 'Recovered shell task',
    command: '',
    startTime: metadata.startTime,
    outputFile: getTaskOutputPath(metadata.taskId),
    outputOffset: 0,
    notified: true,
    completionStatusSentInAttachment: false,
    shellCommand: null,
    lastReportedTotalLines: 0,
    isBackgrounded: true,
    terminalReason,
    processObservation: isUnverified ? 'unknown' : processObservation,
    outcomeKnown,
    reconciledAt,
    endTime: isUnverified ? reconciledAt : metadata.lastObservedAt,
    sessionId: metadata.sessionId,
    shellType: metadata.shellType,
    ...(metadata.exitCode === undefined
      ? {}
      : { result: { code: metadata.exitCode, interrupted: status === 'killed' } }),
  }
}

export function createUnverifiedRecoveredLocalShellTask(
  task: LocalShellTaskState,
): LocalShellTaskState {
  const reconciledAt = Date.now()
  return {
    ...task,
    status: 'unknown',
    error: LOCAL_SHELL_ERROR_MESSAGES.processStateUnknown,
    outcomeKnown: false,
    processObservation: 'unknown',
    terminalReason: 'process_state_unverified',
    shellCommand: null,
    notified: true,
    reconciledAt,
    endTime: reconciledAt,
  }
}

export async function resolveLocalShellTask(
  taskId: string,
  getAppState: () => AppState,
): Promise<ResolvedLocalShellTask | null> {
  const sessionId = getSessionId()
  const projectDir = getSessionProjectDir()
  const isCurrentSnapshot = (): boolean =>
    getSessionId() === sessionId && getSessionProjectDir() === projectDir
  const current = getAppState().tasks?.[taskId]
  if (!isCurrentSnapshot()) return null
  if (current && isLocalShellTask(current) && !(current.status === 'running' && !current.shellCommand)) {
    return {
      task: current,
      processObservation: current.processObservation,
      canStop: current.status === 'running' && current.shellCommand !== null,
    }
  }

  const metadata = await readLocalShellMetadata(taskId, sessionId, projectDir)
  if (!isCurrentSnapshot()) return null
  if (!metadata) {
    if (current && isLocalShellTask(current) && current.status === 'running' && !current.shellCommand) {
      return {
        task: createUnverifiedRecoveredLocalShellTask(current),
        processObservation: 'unknown',
        canStop: false,
      }
    }
    return null
  }

  const isUnverified = metadata.lastKnownStatus === 'running' || metadata.lastKnownStatus === 'unknown'
  const processObservation = isUnverified ? 'unknown' : undefined
  const recoveredMetadata: LocalShellMetadata = isUnverified
    ? {
        ...metadata,
        lastKnownStatus: 'unknown',
        terminalReason: 'process_state_unverified',
        error: LOCAL_SHELL_ERROR_MESSAGES.processStateUnknown,
        outcomeKnown: false,
        lastObservedAt: Date.now(),
      }
    : metadata
  if (metadata.lastKnownStatus === 'running') {
    await writeLocalShellMetadata(recoveredMetadata, projectDir).catch(() => undefined)
    if (!isCurrentSnapshot()) return null
    const persistedMetadata = await readLocalShellMetadata(taskId, sessionId, projectDir)
    if (!isCurrentSnapshot()) return null
    if (persistedMetadata && persistedMetadata.lastKnownStatus !== 'running') {
      const task = createRecoveredLocalShellTask(persistedMetadata)
      return {
        task,
        metadata: persistedMetadata,
        processObservation: task.processObservation,
        canStop: false,
      }
    }
  }
  const task = createRecoveredLocalShellTask(recoveredMetadata, processObservation)
  return {
    task,
    metadata: recoveredMetadata,
    processObservation,
    canStop: false,
  }
}
