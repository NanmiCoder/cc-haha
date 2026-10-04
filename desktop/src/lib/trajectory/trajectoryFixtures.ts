import type { TrajectoryRow } from '../../types/trajectory'

let offset = 0

/** Test helper: a row with a unique, increasing byte offset unless one is given. */
export function makeRow(partial: Partial<TrajectoryRow> & Pick<TrajectoryRow, 'id' | 'kind'>): TrajectoryRow {
  offset += 100
  return {
    turn: 1,
    ts: '2026-10-04T10:00:00.000Z',
    preview: '',
    loc: [[offset, offset + 50]],
    ...partial,
  }
}

export function resetRowOffsets() {
  offset = 0
}
