import { formatDuration } from '../../core/dashboard'
import { clockLabel, dayTimeLabel } from '../../core/schedulesView'
import type {
  WorkflowHistoryPhase,
  WorkflowHistoryRun,
  WorkflowRunDetail,
} from '../../core/workflows'

function sameLocalDay(a: number, b: number) {
  const left = new Date(a)
  const right = new Date(b)
  return (
    left.getFullYear() === right.getFullYear() &&
    left.getMonth() === right.getMonth() &&
    left.getDate() === right.getDate()
  )
}

export type WorkflowTimeSummary = {
  /** Compact range for list rows, e.g. `今天 14:20 – 14:25`. */
  range: string
  /** Detailed start label for detail card. */
  start: string
  /** Detailed end label for detail card, empty when unknown. */
  end: string
  /** Formatted duration (e.g. `5:12`), empty when start or end is absent. */
  duration: string
}

export function formatWorkflowTime(
  startedAt: number,
  endedAt?: number,
  now = new Date()
): WorkflowTimeSummary {
  const hasStart = Number.isFinite(startedAt) && startedAt > 0
  const hasEnd = endedAt !== undefined && Number.isFinite(endedAt) && endedAt > 0
  const start = hasStart ? dayTimeLabel(startedAt, now) : ''
  const end = hasEnd ? dayTimeLabel(endedAt, now) : ''
  const endCompact = hasEnd
    ? hasStart && sameLocalDay(startedAt, endedAt)
      ? clockLabel(new Date(endedAt))
      : end
    : ''
  const range =
    start && endCompact ? `${start} – ${endCompact}` : start ? `开始 ${start}` : end ? `结束 ${end}` : ''
  const duration =
    hasStart && hasEnd && endedAt >= startedAt ? formatDuration((endedAt - startedAt) / 1000) : ''
  return { range, start, end, duration }
}

export function formatPhaseCount(count: number): string {
  return count > 0 ? `${count} 个阶段` : '未记录阶段'
}

export function resolveHistoryPhases(
  run: Pick<WorkflowHistoryRun, 'phases'>,
  detail: Pick<WorkflowRunDetail, 'phases'> | null | undefined
): WorkflowHistoryPhase[] {
  if (run.phases.length > 0) return run.phases
  if (detail?.phases?.length) {
    return detail.phases
      .map((phase, index) => ({ index: index + 1, title: phase.title.trim() }))
      .filter((phase) => phase.title.length > 0)
  }
  return []
}
