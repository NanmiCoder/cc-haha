import { Fragment, useMemo, useState } from 'react'
import { Button } from '@/components/ui/Button'
import { useTranslation } from '@/i18n'
import type { Grid, GridCell } from './spreadsheetEngine'

/** How many cells are put on the page at once. A sheet has room for far more than a page can hold. */
export const MAX_RENDERED_CELLS = 30_000
/**
 * How many cell positions are marked as covered by merged ranges, over all merges. A
 * workbook of a few kilobytes can list hundreds of ranges that each span the whole
 * sheet; marking every cell of each one froze the panel for seconds. Merges past this
 * budget are drawn unmerged, which no real workbook comes near.
 */
export const MERGE_SCAN_BUDGET = 2_000_000
/** The row-number column. */
const ROW_HEADER_WIDTH = 44
const HEADER_HEIGHT = 24
const MIN_ROW_HEIGHT = 22

/** A, B, … Z, AA, AB, … as a spreadsheet numbers its columns. */
export function columnLabel(index: number): string {
  let label = ''
  let rest = index
  do {
    label = String.fromCharCode(65 + (rest % 26)) + label
    rest = Math.floor(rest / 26) - 1
  } while (rest >= 0)
  return label
}

/**
 * Which cells a sheet's merged ranges start at, and which they cover, for the first
 * `rows` rows: the only ones that are drawn.
 *
 * A range inside another, or listed twice, is not a merge Excel would have written and
 * is skipped rather than marked again. Marking is bounded by `budget` cell positions
 * over all ranges; ranges past it are left unmerged.
 */
export function mergeCoverage(
  merges: Grid['merges'],
  columns: number,
  rows: number,
  budget = MERGE_SCAN_BUDGET,
): { origins: Map<number, Grid['merges'][number]>; covered: Set<number> } {
  const origins = new Map<number, Grid['merges'][number]>()
  const covered = new Set<number>()
  let remaining = budget
  for (const merge of merges) {
    if (remaining <= 0) break
    const key = merge.row * columns + merge.column
    if (merge.row >= rows || origins.has(key) || covered.has(key)) continue
    origins.set(key, merge)
    const lastRow = Math.min(merge.row + merge.rowSpan, rows)
    const lastColumn = Math.min(merge.column + merge.columnSpan, columns)
    for (let row = merge.row; row < lastRow; row += 1) {
      for (let column = merge.column; column < lastColumn; column += 1) {
        if (row !== merge.row || column !== merge.column) covered.add(row * columns + column)
      }
    }
    remaining -= (lastRow - merge.row) * (lastColumn - merge.column)
  }
  return { origins, covered }
}

const ALIGN_CLASS: Record<GridCell['align'], string> = {
  left: 'text-left',
  right: 'text-right tabular-nums',
  center: 'text-center',
}

const HEADER_CELL =
  'flex items-center justify-center border-b border-r border-[var(--color-border)] bg-[var(--color-surface-container)] text-[11px] text-[var(--color-text-tertiary)] select-none'

/**
 * One worksheet as a grid of text.
 *
 * Every cell is a text node, never markup: a cell that holds `<img onerror=…>` shows those
 * characters. Merged cells span tracks; a hidden row or column is a track of no size with no
 * cells in it. Row and column headings stay put while the sheet scrolls under them.
 *
 * Only as many rows are drawn as fit a budget of cells; the reader asks for more.
 */
export function SheetGrid({
  grid,
  label,
  cellBudget = MAX_RENDERED_CELLS,
}: {
  grid: Grid
  /** The sheet's name. */
  label: string
  /** Cells drawn at first, and added by each "show more rows". A parameter so a test need not draw thirty thousand. */
  cellBudget?: number
}) {
  const t = useTranslation()
  const chunk = Math.max(1, Math.floor(cellBudget / Math.max(grid.columns, 1)))
  // Rows the reader has asked for, kept across a refresh of the same sheet.
  const [limit, setLimit] = useState(chunk)
  const rows = Math.min(grid.rows, limit)

  const { origins, covered } = useMemo(
    () => mergeCoverage(grid.merges, grid.columns, rows),
    [grid.merges, grid.columns, rows],
  )

  const templateColumns = `${ROW_HEADER_WIDTH}px ${grid.columnWidths.map((width) => `${width}px`).join(' ')}`
  const templateRows = [
    `${HEADER_HEIGHT}px`,
    ...grid.rowHeights.slice(0, rows).map((height) => (height === undefined ? `minmax(${MIN_ROW_HEIGHT}px, auto)` : `${height}px`)),
  ].join(' ')

  const cells = []
  for (let row = 0; row < rows; row += 1) {
    if (grid.rowHeights[row] === 0) continue
    cells.push(
      <div key={`r${row}`} role="row" className="contents">
        <div
          role="rowheader"
          className={`${HEADER_CELL} sticky left-0 z-[1]`}
          style={{ gridRow: row + 2, gridColumn: 1 }}
        >
          {row + 1}
        </div>
        {Array.from({ length: grid.columns }, (_, column) => {
          if (grid.columnWidths[column] === 0 || covered.has(row * grid.columns + column)) return null
          const cell = grid.cells[row]?.[column]
          const merge = origins.get(row * grid.columns + column)
          const rowSpan = merge ? Math.min(merge.rowSpan, rows - row) : 1
          return (
            <div
              key={column}
              role="cell"
              title={cell && cell.text.length > 24 ? cell.text : undefined}
              className={`min-w-0 overflow-hidden text-ellipsis whitespace-nowrap border-b border-r border-[var(--color-border)] px-2 py-0.5 text-xs leading-[18px] text-[var(--color-text-primary)] ${ALIGN_CLASS[cell?.align ?? 'left']}`}
              style={{
                gridRow: merge ? `${row + 2} / span ${rowSpan}` : row + 2,
                gridColumn: merge ? `${column + 2} / span ${merge.columnSpan}` : column + 2,
              }}
            >
              {cell?.text}
            </div>
          )
        })}
      </div>,
    )
  }

  return (
    <Fragment>
      <div
        role="table"
        aria-label={label}
        aria-rowcount={grid.rows}
        aria-colcount={grid.columns}
        className="grid w-max bg-[var(--color-surface)] border-l border-t border-[var(--color-border)]"
        style={{ gridTemplateColumns: templateColumns, gridTemplateRows: templateRows }}
      >
        <div
          role="row"
          className="contents"
        >
          <div className={`${HEADER_CELL} sticky left-0 top-0 z-[2]`} style={{ gridRow: 1, gridColumn: 1 }} />
          {Array.from({ length: grid.columns }, (_, column) => (
            grid.columnWidths[column] === 0 ? null : (
              <div
                key={column}
                role="columnheader"
                className={`${HEADER_CELL} sticky top-0 z-[1]`}
                style={{ gridRow: 1, gridColumn: column + 2 }}
              >
                {columnLabel(column)}
              </div>
            )
          ))}
        </div>
        {cells}
      </div>
      {rows < grid.rows || grid.truncatedRows || grid.truncatedColumns ? (
        <div className="sticky left-0 flex flex-wrap items-center gap-3 px-3 py-2 text-[12px] text-[var(--color-text-tertiary)]">
          {rows < grid.rows ? (
            <Button variant="secondary" size="sm" onClick={() => setLimit((current) => current + chunk)}>
              {t('workspace.sheet.showMoreRows')}
            </Button>
          ) : null}
          {grid.truncatedRows || grid.truncatedColumns ? (
            <span>{t('workspace.sheet.truncated', { rows: grid.rows, columns: grid.columns })}</span>
          ) : null}
        </div>
      ) : null}
    </Fragment>
  )
}
