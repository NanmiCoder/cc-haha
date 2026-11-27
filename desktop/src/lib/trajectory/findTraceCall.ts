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

function normalizeAgentId(value: string | undefined): string | undefined {
  if (!value) return undefined
  const trimmed = value.trim()
  if (!trimmed) return undefined
  return trimmed.startsWith('agent-') ? trimmed.slice('agent-'.length) : trimmed
}

function isMainConversationQuerySource(qs: string): boolean {
  return qs === 'sdk' || qs === 'repl_main_thread' || qs.startsWith('repl_main_thread:')
}

function isSubagentQuerySource(qs: string): boolean {
  return qs.startsWith('agent:') || qs === 'workflow_agent'
}

export type TraceCallMatchOptions = {
  /** Subagent id when viewing a subagent trajectory; absent for the main session. */
  agentId?: string
}

/**
 * Score how well a captured call explains an assistant response: the call
 * must start no later than the response's first block, and the closer its
 * completion is to the response's last block the better. Lower is better;
 * null means "cannot be this response".
 */
export function scoreTraceCall(call: TraceCallRecord, row: TrajectoryRow, options: TraceCallMatchOptions = {}): number | null {
  const targetAgentId = normalizeAgentId(options.agentId)
  const callAgentId = normalizeAgentId(call.agentId)
  const callQuerySource = call.querySource?.trim()
  if (targetAgentId) {
    if (callAgentId && callAgentId !== targetAgentId) return null
    if (!callAgentId && callQuerySource && !isSubagentQuerySource(callQuerySource)) return null
  } else {
    if (callAgentId) return null
    if (callQuerySource && isSubagentQuerySource(callQuerySource)) return null
  }

  const responseStart = timeOf(row.ts)
  const responseEnd = timeOf(row.endTs ?? row.ts)
  const requestStart = timeOf(row.startTs) ?? (responseStart === null ? null : responseStart - UNKNOWN_START_LOOKBACK_MS)
  const startedAt = timeOf(call.startedAt)
  if (responseStart === null || responseEnd === null || requestStart === null || startedAt === null) return null
  if (startedAt < requestStart - START_SLACK_MS || startedAt > responseStart + START_SLACK_MS) return null
  const completedAt = timeOf(call.completedAt) ?? startedAt + (call.durationMs ?? 0)
  if (completedAt > responseEnd + END_SLACK_MS) return null
  // A legacy untagged call (e.g. a main-session proxy call that emitted tool_use: Agent)
  // that already completed before this subagent's response even started cannot explain it.
  if (targetAgentId && !callAgentId && !callQuerySource && completedAt < responseStart - START_SLACK_MS) return null
  let score = Math.abs(completedAt - responseEnd)
  // Prefer an explicit matching agentId over untagged/legacy calls in subagent views.
  if (targetAgentId && !callAgentId) score += callQuerySource ? 120_000 : 240_000
  if (row.model && call.model && row.model !== call.model) score += 60_000
  if (!targetAgentId && callQuerySource && !isMainConversationQuerySource(callQuerySource)) score += 60_000
  if (call.status === 'error') score += 30_000
  return score
}

/**
 * Find the captured call behind an assistant row. The capture is located by
 * time on the server (through its index), so this costs one request however
 * large the capture file is.
 */
export async function findTraceCallForRow(
  row: TrajectoryRow,
  loadNear: TraceCallsNearLoader,
  options: TraceCallMatchOptions = {},
): Promise<TraceCallLookup> {
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
    const score = scoreTraceCall(call, row, options)
    if (score !== null && score < bestScore) {
      best = call
      bestScore = score
    }
  }
  return best
    ? { status: 'matched', call: best, revisionKey: near.revisionToken, at: near.locs?.[best.id] }
    : { status: 'unmatched' }
}
