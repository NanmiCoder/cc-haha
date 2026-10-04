import type { TrajectoryLoc, TrajectoryRow, TrajectoryUsage } from '../../types/trajectory'

function mergeLoc(a: TrajectoryLoc[], b: TrajectoryLoc[]): TrajectoryLoc[] {
  if (!b.length) return a
  if (!a.length) return b
  const byStart = new Map<number, TrajectoryLoc>()
  for (const loc of a) byStart.set(loc[0], loc)
  let added = false
  for (const loc of b) {
    if (!byStart.has(loc[0])) {
      byStart.set(loc[0], loc)
      added = true
    }
  }
  if (!added) return a
  return [...byStart.values()].sort((x, y) => x[0] - y[0])
}

function earlier(a: string | undefined, b: string | undefined): string | undefined {
  if (!a) return b
  if (!b) return a
  return a <= b ? a : b
}

function later(a: string | undefined, b: string | undefined): string | undefined {
  if (!a) return b
  if (!b) return a
  return a >= b ? a : b
}

/**
 * Desktop transcripts write the final usage only on the last block line of a
 * response (earlier lines carry 0), so whichever piece arrived first may hold
 * the zeros. Usage only ever grows within one response: take the max.
 */
function maxUsage(a: TrajectoryUsage | undefined, b: TrajectoryUsage | undefined): TrajectoryUsage | undefined {
  if (!a) return b
  if (!b) return a
  return {
    input: Math.max(a.input, b.input),
    output: Math.max(a.output, b.output),
    cacheRead: Math.max(a.cacheRead, b.cacheRead),
    cacheWrite: Math.max(a.cacheWrite, b.cacheWrite),
  }
}

function minTurn(a: number | null, b: number | null): number | null {
  if (a === null) return b
  if (b === null) return a
  return Math.min(a, b)
}

/**
 * Merge two pieces of the same row. The server emits a piece per page/append
 * (an assistant message split by a page boundary, a tool_result that lands
 * after its tool_use was already delivered); merging must be idempotent so a
 * re-delivered piece changes nothing.
 */
export function mergeRowPieces(a: TrajectoryRow, b: TrajectoryRow): TrajectoryRow {
  const first = a.ts <= b.ts ? a : b
  const second = first === a ? b : a
  const loc = mergeLoc(a.loc, b.loc)
  return {
    ...second,
    ...first,
    turn: minTurn(a.turn, b.turn),
    ts: first.ts,
    endTs: later(later(a.endTs, b.endTs), second.ts > first.ts ? second.ts : undefined),
    loc,
    preview: first.preview || second.preview,
    partial: Boolean(a.partial && b.partial) || undefined,
    isError: a.isError || b.isError || undefined,
    toolName: a.toolName ?? b.toolName,
    toolUseId: a.toolUseId ?? b.toolUseId,
    parentId: a.parentId ?? b.parentId,
    inputPreview: a.inputPreview ?? b.inputPreview,
    inputSummary: a.inputSummary ?? b.inputSummary,
    resultPreview: a.resultPreview ?? b.resultPreview,
    resultTs: a.resultTs ?? b.resultTs,
    resultOmittedBytes: a.resultOmittedBytes ?? b.resultOmittedBytes,
    agentId: a.agentId ?? b.agentId,
    model: a.model ?? b.model,
    requestId: a.requestId ?? b.requestId,
    usage: maxUsage(a.usage, b.usage),
    startTs: earlier(a.startTs, b.startTs),
    toolOnly: a.toolOnly === undefined ? b.toolOnly : b.toolOnly === undefined ? a.toolOnly : a.toolOnly && b.toolOnly,
    hasThinking: a.hasThinking || b.hasThinking || undefined,
    stopReason: second.stopReason ?? first.stopReason,
  }
}

/** Returns a new map with `incoming` merged by id; `current` is not mutated. */
export function mergeRows(current: ReadonlyMap<string, TrajectoryRow>, incoming: readonly TrajectoryRow[]): Map<string, TrajectoryRow> {
  const next = new Map(current)
  for (const row of incoming) {
    const existing = next.get(row.id)
    next.set(row.id, existing ? mergeRowPieces(existing, row) : row)
  }
  return next
}
