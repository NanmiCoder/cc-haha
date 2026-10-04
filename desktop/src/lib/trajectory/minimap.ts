import type { TrajectoryRow, TrajectoryRowKind } from '../../types/trajectory'
import { laneForKind, rowDurationMs, type TrajectoryLane } from './viewModel'

export type MinimapMode = 'sequence' | 'duration'

/** A run of adjacent buckets in one lane, rendered as one span. */
export type MinimapRun = {
  lane: TrajectoryLane
  /** Kind of the run's row; the span takes the same color as that kind's badge. */
  kind: TrajectoryRowKind
  /** Fractions of the plot width, 0..1. */
  x: number
  w: number
  /** Row selected when the run is clicked. */
  rowId: string
  error: boolean
  match: boolean
  selected: boolean
}

export type MinimapModel = {
  runs: MinimapRun[]
  /** Turn boundaries as fractions of the plot width. */
  turnMarks: number[]
  /** Failed rows as full-height marks, one per bucket, so they stand out at any scale. */
  errorMarks: Array<{ x: number; rowId: string }>
  /** Start/end fraction for every row, for the viewport indicator and hit testing. */
  positions: Map<string, { x: number; w: number; lane: TrajectoryLane }>
}

/**
 * Lay rows out on a 0..1 axis. `sequence` gives every row one slot;
 * `duration` sizes rows by wall-clock time with idle gaps removed, so a long
 * tool call or slow response stands out. Rows with no duration still get a
 * sliver so they stay clickable.
 */
export function layoutRows(rows: readonly TrajectoryRow[], mode: MinimapMode): Array<{ x: number; w: number }> {
  if (!rows.length) return []
  let widths: number[]
  if (mode === 'sequence') {
    widths = rows.map(() => 1)
  } else {
    const durations = rows.map((row) => rowDurationMs(row) ?? 0)
    const base = durations.reduce((sum, value) => sum + value, 0)
    const minWidth = base > 0 ? base * 0.002 : 1
    widths = durations.map((value) => Math.max(value, minWidth))
  }
  const total = widths.reduce((sum, value) => sum + value, 0)
  const layout: Array<{ x: number; w: number }> = []
  let cursor = 0
  for (const width of widths) {
    layout.push({ x: cursor / total, w: width / total })
    cursor += width
  }
  return layout
}

/**
 * Bucket the layout so the minimap renders at most `buckets` spans per lane
 * regardless of session size, then merge adjacent buckets of one lane into
 * runs. A 20k-row session costs the same DOM as a 600-row one.
 */
export function buildMinimap(
  rows: readonly TrajectoryRow[],
  mode: MinimapMode,
  options: { buckets?: number; selectedId?: string | null; isMatch?: (row: TrajectoryRow) => boolean } = {},
): MinimapModel {
  const layout = layoutRows(rows, mode)
  const positions = new Map<string, { x: number; w: number; lane: TrajectoryLane }>()
  const turnMarks: number[] = []
  const bucketCount = Math.max(1, Math.min(options.buckets ?? 600, rows.length))
  type Cell = { rowId: string; kind: TrajectoryRowKind; error: boolean; match: boolean; selected: boolean }
  const lanes: Array<Array<Cell | undefined>> = [[], [], []]
  const errorBuckets = new Map<number, string>()
  let previousTurn: number | null | undefined
  rows.forEach((row, index) => {
    const slot = layout[index]!
    const lane = laneForKind(row.kind)
    positions.set(row.id, { x: slot.x, w: slot.w, lane })
    if (index > 0 && row.turn !== previousTurn && row.turn !== null) turnMarks.push(slot.x)
    previousTurn = row.turn
    const first = Math.min(bucketCount - 1, Math.floor(slot.x * bucketCount))
    const last = Math.min(bucketCount - 1, Math.max(first, Math.ceil((slot.x + slot.w) * bucketCount) - 1))
    const error = Boolean(row.isError)
    const match = options.isMatch?.(row) ?? false
    const selected = row.id === options.selectedId
    if (error && !errorBuckets.has(first)) errorBuckets.set(first, row.id)
    for (let bucket = first; bucket <= last; bucket++) {
      const cell = lanes[lane]![bucket]
      if (!cell) {
        lanes[lane]![bucket] = { rowId: row.id, kind: row.kind, error, match, selected }
      } else {
        cell.error ||= error
        cell.match ||= match
        if (selected) {
          cell.selected = true
          cell.rowId = row.id
          cell.kind = row.kind
        } else if (!cell.selected && KIND_PRIORITY[row.kind] > KIND_PRIORITY[cell.kind]) {
          // A prompt sharing a bucket with injected context is what the input lane should show.
          cell.rowId = row.id
          cell.kind = row.kind
        }
      }
    }
  })

  const runs: MinimapRun[] = []
  lanes.forEach((cells, lane) => {
    let start = -1
    let current: Cell | undefined
    const flush = (end: number) => {
      if (start < 0 || !current) return
      runs.push({
        lane: lane as TrajectoryLane,
        kind: current.kind,
        x: start / bucketCount,
        w: (end - start) / bucketCount,
        rowId: current.rowId,
        error: current.error,
        match: current.match,
        selected: current.selected,
      })
      start = -1
      current = undefined
    }
    for (let bucket = 0; bucket < bucketCount; bucket++) {
      const cell = cells[bucket]
      // A run only continues across buckets of the same row, so a click on a
      // run always lands on a row inside it and state flags stay per-row.
      if (cell && current && cell.rowId === current.rowId && cell.kind === current.kind && cell.error === current.error && cell.match === current.match && cell.selected === current.selected) continue
      flush(bucket)
      if (cell) {
        start = bucket
        current = cell
      }
    }
    flush(bucketCount)
  })
  const errorMarks = [...errorBuckets].sort((a, b) => a[0] - b[0]).map(([bucket, rowId]) => ({ x: (bucket + 0.5) / bucketCount, rowId }))
  return { runs, turnMarks, errorMarks, positions }
}

const KIND_PRIORITY: Record<TrajectoryRowKind, number> = {
  user: 3,
  system: 2,
  context: 1,
  assistant: 1,
  compact: 2,
  tool: 1,
}

/** The row nearest to fraction `x` in `lane`, for clicks between runs. */
export function rowAtFraction(model: MinimapModel, x: number, lane: TrajectoryLane | null): string | null {
  let best: string | null = null
  let bestDistance = Infinity
  for (const [rowId, slot] of model.positions) {
    if (lane !== null && slot.lane !== lane) continue
    const distance = x < slot.x ? slot.x - x : x > slot.x + slot.w ? x - slot.x - slot.w : 0
    if (distance < bestDistance) {
      best = rowId
      bestDistance = distance
      if (distance === 0) break
    }
  }
  return best
}
