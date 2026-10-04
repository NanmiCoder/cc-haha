import type { TraceCallRecord } from '../../types/trace'
import type { TraceCallsNear, TrajectoryRow } from '../../types/trajectory'

export type TraceCallsNearLoader = (from: string, to: string) => Promise<TraceCallsNear>

export type TraceCallLookup =
  | { status: 'matched'; call: TraceCallRecord; revisionKey?: string; at?: string }
  /** Captures exist for the session, but none explains this response. */
  | { status: 'unmatched' }
  /** The session has no capture at all (capture was off while it ran). */
  | { status: 'uncaptured' }

function timeOf(value: string | undefined | null): number | null {
  if (!value) return null
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : null
}

/** Slack for clock skew between the capture writer and the transcript writer. */
const START_SLACK_MS = 2_000
const END_SLACK_MS = 30_000
/** How far before the first response block a request may have started when its start is unknown. */
const UNKNOWN_START_LOOKBACK_MS = 10 * 60_000

/**
 * Score how well a captured call explains an assistant response: the call
 * must start no later than the response's first block, and the closer its
 * completion is to the response's last block the better. Lower is better;
 * null means "cannot be this response".
 */
export function scoreTraceCall(call: TraceCallRecord, row: TrajectoryRow): number | null {
  const responseStart = timeOf(row.ts)
  const responseEnd = timeOf(row.endTs ?? row.ts)
  const requestStart = timeOf(row.startTs) ?? (responseStart === null ? null : responseStart - UNKNOWN_START_LOOKBACK_MS)
  const startedAt = timeOf(call.startedAt)
  if (responseStart === null || responseEnd === null || requestStart === null || startedAt === null) return null
  if (startedAt < requestStart - START_SLACK_MS || startedAt > responseStart + START_SLACK_MS) return null
  const completedAt = timeOf(call.completedAt) ?? startedAt + (call.durationMs ?? 0)
  if (completedAt > responseEnd + END_SLACK_MS) return null
  let score = Math.abs(completedAt - responseEnd)
  if (row.model && call.model && row.model !== call.model) score += 60_000
  if (call.status === 'error') score += 30_000
  return score
}

/**
 * Find the captured call behind an assistant row. The capture is located by
 * time on the server (through its index), so this costs one request however
 * large the capture file is.
 */
export async function findTraceCallForRow(row: TrajectoryRow, loadNear: TraceCallsNearLoader): Promise<TraceCallLookup> {
  const responseStart = timeOf(row.ts)
  if (responseStart === null) return { status: 'unmatched' }
  const requestStart = timeOf(row.startTs) ?? responseStart - UNKNOWN_START_LOOKBACK_MS
  const from = new Date(requestStart - START_SLACK_MS).toISOString()
  const to = new Date(responseStart + START_SLACK_MS).toISOString()
  const near = await loadNear(from, to)
  if (!near.captured) return { status: 'uncaptured' }
  let best: TraceCallRecord | null = null
  let bestScore = Infinity
  for (const call of near.calls) {
    const score = scoreTraceCall(call, row)
    if (score !== null && score < bestScore) {
      best = call
      bestScore = score
    }
  }
  return best
    ? { status: 'matched', call: best, revisionKey: near.revisionToken, at: near.locs?.[best.id] }
    : { status: 'unmatched' }
}
