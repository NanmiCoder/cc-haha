import type { TrajectoryRow, TrajectoryRowKind } from '../../types/trajectory'

export type TrajectoryLane = 0 | 1 | 2

/** What a hidden run of tool calls did, shown on the response that issued them. */
export type HiddenToolSummary = {
  count: number
  errors: number
  /** `[toolName, calls]`, most frequent first. */
  names: Array<[string, number]>
}

export type TrajectoryItem =
  | { type: 'row'; key: string; row: TrajectoryRow; turnStart: boolean; hiddenTools: HiddenToolSummary | null }
  | { type: 'summary'; key: string; turn: number; hiddenRows: number; toolCount: number; errors: number; durationMs: number }

export type TrajectoryViewOptions = {
  /** Turns folded down to their first row plus a summary. */
  collapsedTurns: ReadonlySet<number>
  /** Hide tool rows; the issuing assistant row shows what they were. */
  hideTools: boolean
  query: string
}

export type TurnStats = { rows: number; tools: number; errors: number; durationMs: number }

const KIND_RANK: Record<TrajectoryRowKind, number> = {
  system: 0,
  user: 1,
  context: 2,
  compact: 3,
  assistant: 4,
  tool: 5,
}

function timeOf(value: string | undefined): number | null {
  if (!value) return null
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : null
}

function rowInterval(row: TrajectoryRow): [number, number] | null {
  if (row.kind === 'tool') {
    const start = timeOf(row.ts)
    const end = timeOf(row.resultTs)
    return start !== null && end !== null && end >= start ? [start, end] : null
  }
  if (row.kind === 'assistant') {
    const start = timeOf(row.startTs ?? row.ts)
    const end = timeOf(row.endTs ?? row.ts)
    return start !== null && end !== null && end >= start ? [start, end] : null
  }
  return null
}

/** Wall-clock duration a row represents, or null when it has none. */
export function rowDurationMs(row: TrajectoryRow): number | null {
  const interval = rowInterval(row)
  return interval ? interval[1] - interval[0] : null
}

/**
 * Wall-clock time covered by a set of rows. Parallel tool calls overlap, so
 * their durations are merged as intervals instead of summed.
 */
export function wallClockMs(rows: readonly TrajectoryRow[]): number {
  const intervals = rows.map(rowInterval).filter((value): value is [number, number] => value !== null)
  if (!intervals.length) return 0
  intervals.sort((a, b) => a[0] - b[0])
  let total = 0
  let [start, end] = intervals[0]!
  for (let index = 1; index < intervals.length; index++) {
    const [nextStart, nextEnd] = intervals[index]!
    if (nextStart > end) {
      total += end - start
      start = nextStart
      end = nextEnd
    } else if (nextEnd > end) {
      end = nextEnd
    }
  }
  return total + (end - start)
}

export function laneForKind(kind: TrajectoryRowKind): TrajectoryLane {
  if (kind === 'assistant' || kind === 'compact') return 1
  if (kind === 'tool') return 2
  return 0
}

/** A tool row whose call record is in history that has not been loaded. */
export function isOrphanTool(row: TrajectoryRow): boolean {
  return row.kind === 'tool' && !row.toolName
}

/** A tool row that will not get a result: the result exists, or the call finished without one. */
export function toolHasResult(row: TrajectoryRow): boolean {
  return Boolean(row.resultTs || row.resultPreview || row.resultOmittedBytes)
}

/**
 * Transcript rows keep file order (their first byte offset). Snapshot rows have
 * no offset: each is placed before the first transcript row written after it,
 * which puts "system prompt updated" between the prompt and the response it
 * was sent with. While older history is still unloaded, snapshots older than
 * the first loaded row belong to that history and are held back — placing
 * them would file them under the wrong turn.
 */
export function orderTrajectoryRows(
  rows: ReadonlyMap<string, TrajectoryRow>,
  snapshots: readonly TrajectoryRow[],
  options: { hasOlder?: boolean } = {},
): TrajectoryRow[] {
  const transcript = [...rows.values()].sort((a, b) => {
    const offsetA = a.loc[0]?.[0]
    const offsetB = b.loc[0]?.[0]
    if (offsetA !== undefined && offsetB !== undefined && offsetA !== offsetB) return offsetA - offsetB
    if (offsetA === offsetB && a.kind !== b.kind) return KIND_RANK[a.kind] - KIND_RANK[b.kind]
    if (a.ts !== b.ts) return a.ts < b.ts ? -1 : 1
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  })
  if (!snapshots.length) return transcript
  const firstTs = transcript[0]?.ts
  const pending = snapshots
    .filter((row) => !options.hasOlder || !firstTs || row.ts >= firstTs)
    .sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0))
  const ordered: TrajectoryRow[] = []
  let next = 0
  for (const row of transcript) {
    while (next < pending.length && pending[next]!.ts < row.ts) {
      ordered.push({ ...pending[next]!, turn: row.turn })
      next++
    }
    ordered.push(row)
  }
  const lastTurn = transcript.length ? transcript[transcript.length - 1]!.turn : null
  while (next < pending.length) {
    ordered.push({ ...pending[next]!, turn: lastTurn })
    next++
  }
  return ordered
}

export function rowSearchText(row: TrajectoryRow): string {
  return [
    row.kind,
    row.label,
    row.preview,
    row.toolName,
    row.inputSummary,
    row.inputPreview,
    row.resultPreview,
    row.model,
    row.attachmentType,
    row.toolUseId,
  ].filter(Boolean).join('\n').toLowerCase()
}

export function matchesQuery(searchText: string, terms: readonly string[]): boolean {
  return terms.every((term) => searchText.includes(term))
}

export function queryTerms(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean)
}

function summarizeTools(tools: readonly TrajectoryRow[]): HiddenToolSummary {
  const counts = new Map<string, number>()
  let errors = 0
  for (const tool of tools) {
    const name = tool.toolName ?? '?'
    counts.set(name, (counts.get(name) ?? 0) + 1)
    if (tool.isError) errors++
  }
  return {
    count: tools.length,
    errors,
    names: [...counts].sort((a, b) => b[1] - a[1]),
  }
}

/** Per-turn counts for the folded summaries and the sticky turn bar. */
export function computeTurnStats(ordered: readonly TrajectoryRow[]): Map<number, TurnStats> {
  const groups = new Map<number, TrajectoryRow[]>()
  for (const row of ordered) {
    if (row.turn === null) continue
    let group = groups.get(row.turn)
    if (!group) groups.set(row.turn, (group = []))
    group.push(row)
  }
  const stats = new Map<number, TurnStats>()
  for (const [turn, group] of groups) {
    stats.set(turn, {
      rows: group.length,
      tools: group.filter((row) => row.kind === 'tool').length,
      errors: group.filter((row) => row.isError).length,
      durationMs: wallClockMs(group),
    })
  }
  return stats
}

/**
 * Turn the ordered rows into what the table renders. Search ignores folding:
 * a match inside a folded turn must still be visible.
 */
export function buildTrajectoryItems(
  ordered: readonly TrajectoryRow[],
  options: TrajectoryViewOptions,
  searchTextOf: (row: TrajectoryRow) => string = rowSearchText,
): TrajectoryItem[] {
  const terms = queryTerms(options.query)
  const items: TrajectoryItem[] = []
  if (terms.length) {
    let previousTurn: number | null | undefined
    for (const row of ordered) {
      if (!matchesQuery(searchTextOf(row), terms)) continue
      items.push({ type: 'row', key: row.id, row, turnStart: row.turn !== previousTurn, hiddenTools: null })
      previousTurn = row.turn
    }
    return items
  }

  const hiddenToolsByParent = new Map<string, TrajectoryRow[]>()
  if (options.hideTools) {
    for (const row of ordered) {
      if (row.kind === 'tool' && row.parentId) {
        const list = hiddenToolsByParent.get(row.parentId)
        if (list) list.push(row)
        else hiddenToolsByParent.set(row.parentId, [row])
      }
    }
  }

  let index = 0
  while (index < ordered.length) {
    const turn = ordered[index]!.turn
    let end = index
    while (end < ordered.length && ordered[end]!.turn === turn) end++
    const group = ordered.slice(index, end)
    if (turn !== null && options.collapsedTurns.has(turn) && group.length > 1) {
      const head = group.find((row) => row.kind === 'user') ?? group[0]!
      items.push({ type: 'row', key: head.id, row: head, turnStart: true, hiddenTools: null })
      items.push({
        type: 'summary',
        key: `summary:${turn}`,
        turn,
        hiddenRows: group.length - 1,
        toolCount: group.filter((row) => row.kind === 'tool').length,
        errors: group.filter((row) => row.isError).length,
        durationMs: wallClockMs(group),
      })
    } else {
      let first = true
      for (const row of group) {
        if (options.hideTools && row.kind === 'tool') continue
        const hidden = row.kind === 'assistant' ? hiddenToolsByParent.get(row.id) : undefined
        items.push({
          type: 'row',
          key: row.id,
          row,
          turnStart: first,
          hiddenTools: hidden?.length ? summarizeTools(hidden) : null,
        })
        first = false
      }
    }
    index = end
  }
  return items
}

export function listTurns(ordered: readonly TrajectoryRow[]): number[] {
  const turns: number[] = []
  let previous: number | null | undefined
  for (const row of ordered) {
    if (row.turn !== previous && row.turn !== null) turns.push(row.turn)
    previous = row.turn
  }
  return turns
}

export type TrajectoryTotals = {
  turns: number
  /** Lowest loaded turn, for "from turn N" when older history is not loaded. */
  firstTurn: number | null
  steps: number
  tools: number
  errors: number
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

export function computeTotals(ordered: readonly TrajectoryRow[]): TrajectoryTotals {
  const totals: TrajectoryTotals = { turns: 0, firstTurn: null, steps: 0, tools: 0, errors: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  const turns = new Set<number>()
  for (const row of ordered) {
    if (row.turn !== null && row.turn > 0) {
      turns.add(row.turn)
      if (totals.firstTurn === null || row.turn < totals.firstTurn) totals.firstTurn = row.turn
    }
    if (row.isError) totals.errors++
    if (row.kind === 'tool') totals.tools++
    if (row.kind === 'assistant') {
      totals.steps++
      if (row.usage) {
        totals.input += row.usage.input
        totals.output += row.usage.output
        totals.cacheRead += row.usage.cacheRead
        totals.cacheWrite += row.usage.cacheWrite
      }
    }
  }
  totals.turns = turns.size
  return totals
}

export function hasUsage(row: TrajectoryRow): boolean {
  const usage = row.usage
  return Boolean(usage && (usage.input || usage.output || usage.cacheRead || usage.cacheWrite))
}
