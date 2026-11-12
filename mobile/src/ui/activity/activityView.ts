import type { ActivityProgress } from '../../core/sessionActivityModel'

export type CapsuleInput = {
  progress: ActivityProgress
  runningCount: number
  tone: 'run' | 'attention'
  /** This turn is still running or background tasks are running. */
  active: boolean
  /** Team plan just approved and members getting in place. */
  launching?: boolean
}

/** Main text in the capsule: with a task list show "done/total", with only background running show the running count. */
export function capsuleText({ progress, runningCount }: Pick<CapsuleInput, 'progress' | 'runningCount'>) {
  return progress.total > 0 ? `${progress.done}/${progress.total}` : String(runningCount)
}

/** Badge: with a list and subagents/background running, overlay the running count; otherwise not shown twice. */
export function capsuleBadge({ progress, runningCount }: Pick<CapsuleInput, 'progress' | 'runningCount'>) {
  return progress.total > 0 && runningCount > 0 ? runningCount : null
}

export function capsuleLabel(input: CapsuleInput) {
  if (input.launching && input.tone !== 'attention') return 'Team starting, tap for details'
  const parts = [
    input.tone === 'attention' ? 'Waiting for your approval' : input.active ? 'Running' : 'Tasks',
    input.progress.total > 0 ? `task ${input.progress.done}/${input.progress.total}` : '',
    input.runningCount > 0 && input.tone !== 'attention' ? `${input.runningCount} running in background` : '',
    'tap for details',
  ]
  return parts.filter(Boolean).join(', ')
}

/** Text and color semantics of subagent / team / command states. */
export function agentStatusText(status: 'running' | 'completed' | 'failed' | 'stopped') {
  return status === 'running'
    ? 'Running'
    : status === 'completed'
      ? 'Done'
      : status === 'failed'
        ? 'Failed'
        : 'Stopped'
}

/** Milliseconds -> 1:12 / 1:02:03; returns an empty string without a start time. */
export function clock(startedAt: number | undefined, now: number) {
  if (startedAt === undefined) return ''
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1000))
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = String(seconds % 60).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`
}
