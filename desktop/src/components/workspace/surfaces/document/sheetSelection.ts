import type { Grid } from '@/components/workspace/surfaces/document/spreadsheetEngine'

type Bounds = { firstRow: number; firstColumn: number; lastRow: number; lastColumn: number }

/** Index only merges the renderer accepted, clipped to the cells currently drawn. */
export function indexSheetMerges(origins: Map<number, Grid['merges'][number]>, grid: Grid, rows: number) {
  const ranges: Bounds[] = []
  const cells = new Uint32Array(rows * grid.columns)
  for (const merge of origins.values()) {
    if (grid.rowHeights[merge.row] === 0 || grid.columnWidths[merge.column] === 0) continue
    const range = {
      firstRow: merge.row,
      firstColumn: merge.column,
      lastRow: Math.min(rows, merge.row + merge.rowSpan) - 1,
      lastColumn: Math.min(grid.columns, merge.column + merge.columnSpan) - 1,
    }
    ranges.push(range)
    for (let row = range.firstRow; row <= range.lastRow; row += 1) {
      cells.fill(ranges.length, row * grid.columns + range.firstColumn, row * grid.columns + range.lastColumn + 1)
    }
  }
  return { ranges, cells, columns: grid.columns }
}

/** Visit each newly included cell once, so cascading merges cannot cause quadratic rescans. */
export function expandSheetSelection(initial: Bounds, index: ReturnType<typeof indexSheetMerges>): Bounds {
  let bounds = initial
  const pending = [initial]
  const visited = new Set<number>()
  while (pending.length > 0) {
    const area = pending.pop()!
    for (let row = area.firstRow; row <= area.lastRow; row += 1) {
      for (let column = area.firstColumn; column <= area.lastColumn; column += 1) {
        const id = index.cells[row * index.columns + column] ?? 0
        if (id === 0 || visited.has(id)) continue
        visited.add(id)
        const merge = index.ranges[id - 1]!
        const next = {
          firstRow: Math.min(bounds.firstRow, merge.firstRow),
          firstColumn: Math.min(bounds.firstColumn, merge.firstColumn),
          lastRow: Math.max(bounds.lastRow, merge.lastRow),
          lastColumn: Math.max(bounds.lastColumn, merge.lastColumn),
        }
        // Top/bottom use the new width; side strips use the old height. No overlap.
        if (next.firstRow < bounds.firstRow) pending.push({ ...next, lastRow: bounds.firstRow - 1 })
        if (next.lastRow > bounds.lastRow) pending.push({ ...next, firstRow: bounds.lastRow + 1 })
        if (next.firstColumn < bounds.firstColumn) pending.push({ ...bounds, firstColumn: next.firstColumn, lastColumn: bounds.firstColumn - 1 })
        if (next.lastColumn > bounds.lastColumn) pending.push({ ...bounds, firstColumn: bounds.lastColumn + 1, lastColumn: next.lastColumn })
        bounds = next
      }
    }
  }
  return bounds
}
