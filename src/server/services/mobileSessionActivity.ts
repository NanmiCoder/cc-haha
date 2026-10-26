import { ApiError } from '../middleware/errorHandler.js'
import type { SessionCompletionState } from './sessionCollaborationService.js'
import type { CronScheduler } from './cronScheduler.js'

export type MobileSessionActivity = {
  id: string
  activityState: 'running' | 'waiting' | 'failed' | 'idle' | 'review'
  completedAt?: number
  terminalOutcome?: 'completed' | 'failed' | 'stopped'
  startedAt?: number
  lastProgressAt?: number
  stalled?: boolean
  requestId?: string
  toolName?: string
  preview?: string
  autoAnswerDeadline?: number | null
}
type ScheduledRun = Awaited<ReturnType<CronScheduler['getRunsPage']>>['runs'][number]
type Dependencies = {
  live(): MobileSessionActivity[]
  completions(): Promise<SessionCompletionState[]>
  runs: CronScheduler['getRunsPage']
  now?: () => number
}

/** Durable completion evidence supplements live state; it never invents running work. */
export function projectMobileSessionActivity(
  live: MobileSessionActivity[],
  completions: SessionCompletionState[],
  runs: ScheduledRun[],
  since: number,
): MobileSessionActivity[] {
  const rows = new Map<string, MobileSessionActivity>()
  const outcomes = new Map<string, MobileSessionActivity['terminalOutcome']>()
  const latestRun = new Map<string, ScheduledRun>()
  for (const run of runs) {
    if (!run.sessionId) continue
    const previous = latestRun.get(run.sessionId)
    if (!previous || Date.parse(run.startedAt) > Date.parse(previous.startedAt)) latestRun.set(run.sessionId, run)
  }
  for (const [id, run] of latestRun) {
    const completedAt = Date.parse(run.completedAt ?? '')
    if (run.status === 'completed' && Number.isFinite(completedAt) && completedAt >= since) {
      rows.set(id, { id, activityState: 'idle', terminalOutcome: 'completed', completedAt })
    }
  }
  for (const completion of completions) {
    const completedAt = Date.parse(completion.completedAt ?? '')
    if (completion.state === 'completed' && Number.isFinite(completedAt) && completedAt >= since) {
      rows.set(completion.id, { id: completion.id, activityState: 'idle', terminalOutcome: 'completed', completedAt })
    } else if (completion.state !== 'idle' && completion.state !== 'completed') {
      // A newer failed/stopped/in-flight foreground turn must not inherit the
      // scheduled run's earlier success on the same session.
      rows.delete(completion.id)
    }
    if (completion.state === 'failed' || completion.state === 'stopped') outcomes.set(completion.id, completion.state)
  }
  for (const activity of live) {
    // The runtime clock also finishes failed/stopped work. Only the persistent
    // successful-result projection may supply the dashboard completion field.
    const { completedAt: _runtimeFinishedAt, terminalOutcome: _runtimeOutcome, ...current } = activity
    const completedAt = rows.get(activity.id)?.completedAt
    const settled = ['idle', 'review', 'failed'].includes(activity.activityState)
    const terminalOutcome = activity.activityState === 'failed' ? 'failed'
      : completedAt !== undefined ? 'completed' : outcomes.get(activity.id)
    rows.set(activity.id, {
      ...current,
      ...(settled && terminalOutcome ? { terminalOutcome } : {}),
      ...(['idle', 'review'].includes(activity.activityState) && completedAt !== undefined ? { completedAt } : {}),
    })
  }
  return [...rows.values()]
}

export async function loadMobileSessionActivity(deps: Dependencies): Promise<MobileSessionActivity[]> {
  // Covers today's local date in every phone timezone, including DST, without
  // loading the entire scheduled execution history on every foreground poll.
  const since = (deps.now?.() ?? Date.now()) - 48 * 60 * 60 * 1000
  const runs: ScheduledRun[] = []
  const cursors = new Set<string>()
  let cursor: string | undefined
  let revision: string | undefined
  do {
    const page = await deps.runs({ summaryOnly: true, completedAfterMs: since, limit: 500, ...(cursor ? { cursor } : {}) })
    if (page.reset || (revision !== undefined && page.revisionToken !== revision)) {
      throw ApiError.conflict('Scheduled history changed while reading mobile activity')
    }
    revision = page.revisionToken
    runs.push(...page.runs)
    cursor = page.nextCursor
    if (cursor && cursors.has(cursor)) throw ApiError.conflict('Scheduled history cursor did not advance')
    if (cursor) cursors.add(cursor)
  } while (cursor)
  // Read live state last so history I/O cannot age an approval snapshot.
  const completions = await deps.completions()
  return projectMobileSessionActivity(deps.live(), completions, runs, since)
}
