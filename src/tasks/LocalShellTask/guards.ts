// Pure type + type guard for LocalShellTask state.
// Extracted from LocalShellTask.tsx so non-React consumers (stopTask.ts via
// print.ts) don't pull React/ink into the module graph.

import type { TaskStateBase } from '../../Task.js'
import type { AgentId } from '../../types/ids.js'
import type { ExecResult, ShellCommand } from '../../utils/ShellCommand.js'

export type BashTaskKind = 'bash' | 'monitor'

export type TerminalReason =
  | 'command_exited'
  | 'spawn_error'
  | 'termination_confirmed'
  | 'timeout_termination_confirmed'
  | 'abort_termination_confirmed'
  | 'output_limit_termination_confirmed'
  | 'termination_requested'
  | 'termination_request_failed'
  | 'termination_timeout'
  | 'process_disappeared'
  | 'process_disappeared_after_restart'
  | 'process_state_unverified'
  | 'reconciled_after_restart'

export const LOCAL_SHELL_ERROR_MESSAGES = {
  userTerminationConfirmed: 'User termination confirmed.',
  userTerminationFailed: 'User termination failed.',
  agentTerminationConfirmed: 'Agent termination confirmed.',
  agentTerminationFailed: 'Agent termination failed.',
  processStateUnknown: 'Process state unknown.',
} as const

type LocalShellFinalization = {
  promise: Promise<void>
  resolve: () => void
  claimed: boolean
}

const localShellFinalizations = new Map<string, LocalShellFinalization>()

export function createLocalShellFinalization(taskId: string): Promise<void> {
  const existing = localShellFinalizations.get(taskId)
  if (existing) return existing.promise
  let resolve!: () => void
  const promise = new Promise<void>(resolvePromise => {
    resolve = resolvePromise
  })
  localShellFinalizations.set(taskId, {
    promise,
    resolve,
    claimed: false,
  })
  return promise
}

export function claimLocalShellFinalization(taskId: string): boolean {
  const finalization = localShellFinalizations.get(taskId)
  if (!finalization || finalization.claimed) return false
  finalization.claimed = true
  return true
}

export function settleLocalShellFinalization(taskId: string): void {
  const finalization = localShellFinalizations.get(taskId)
  if (!finalization) return
  finalization.resolve()
  localShellFinalizations.delete(taskId)
}

export function getLocalShellFinalization(taskId: string): Promise<void> {
  const finalization = localShellFinalizations.get(taskId)
  if (!finalization) {
    throw new Error(`Missing finalization barrier for LocalShellTask ${taskId}`)
  }
  return finalization.promise
}

export type LocalShellTerminalLifecycle = {
  status: 'completed' | 'failed' | 'killed' | 'unknown'
  error: string
  outcomeKnown: boolean
  result?: {
    code: number
    interrupted: boolean
  }
  processObservation?: ExecResult['processObservation']
  terminalReason?: TerminalReason
  terminationRequested?: boolean
}

export function getLocalShellTerminalLifecycle(
  shellCommand: ShellCommand,
  result: ExecResult,
): LocalShellTerminalLifecycle {
  const outcomeKnown = result.outcomeKnown !== false && result.code !== undefined
  const status = shellCommand.status === 'killed'
    ? 'killed'
    : outcomeKnown && result.code === 0
      ? 'completed'
      : 'failed'
  return {
    status,
    error: '',
    outcomeKnown,
    result: outcomeKnown
      ? { code: result.code!, interrupted: result.interrupted }
      : undefined,
    processObservation: result.processObservation,
    terminalReason: status === 'killed'
      ? result.terminationReason === 'timeout'
        ? 'timeout_termination_confirmed'
        : result.terminationReason === 'abort'
          ? 'abort_termination_confirmed'
          : result.terminationReason === 'output_limit'
            ? 'output_limit_termination_confirmed'
            : 'termination_confirmed'
      : result.processObservation === 'dead'
        ? 'process_disappeared'
        : undefined,
    terminationRequested: status === 'killed' ? true : shellCommand.terminationRequested || undefined,
  }
}

export type LocalShellTaskState = TaskStateBase & {
  type: 'local_bash' // Keep as 'local_bash' for backward compatibility with persisted session state
  command: string
  result?: {
    code: number
    interrupted: boolean
  }
  completionStatusSentInAttachment: boolean
  shellCommand: ShellCommand | null
  unregisterCleanup?: () => void
  cleanupTimeoutId?: NodeJS.Timeout
  // Track what we last reported for computing deltas (total lines from TaskOutput)
  lastReportedTotalLines: number
  // Whether the task has been backgrounded (false = foreground running, true = backgrounded)
  isBackgrounded: boolean
  /** Task-level error or termination reason. */
  error: string
  /** A termination signal was requested but process exit is not confirmed yet. */
  terminationRequested?: boolean
  /** Prevents duplicate termination requests while process exit is pending. */
  terminationPending?: boolean
  /** Identifies who requested termination. */
  terminationSource?: 'user' | 'agent'
  /** Explains a non-command terminal or termination observation. */
  terminalReason?: TerminalReason
  processObservation?: 'alive' | 'dead' | 'unknown'
  outcomeKnown?: boolean
  reconciledAt?: number
  sessionId?: string
  projectDir?: string | null
  shellType?: 'bash' | 'powershell'
  // Agent that spawned this task. Used to kill orphaned bash tasks when the
  // agent exits (see killShellTasksForAgent). Undefined = main thread.
  agentId?: AgentId
  // UI display variant. 'monitor' → shows description instead of command,
  // 'Monitor details' dialog title, distinct status bar pill.
  kind?: BashTaskKind
}

export function isLocalShellTask(task: unknown): task is LocalShellTaskState {
  return (
    typeof task === 'object' &&
    task !== null &&
    'type' in task &&
    task.type === 'local_bash'
  )
}
