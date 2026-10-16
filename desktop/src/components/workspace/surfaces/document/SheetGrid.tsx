import { Fragment, useMemo, useState } from 'react'
import { Button } from '@/components/ui/Button'
import { useTranslation } from '@/i18n'
import type { DocumentAnnotationSelection } from '@/components/workspace/surfaces/document/DocumentAnnotation'
import type { Grid, GridCell } from './spreadsheetEngine'
import { expandSheetSelection, indexSheetMerges } from '@/components/workspace/surfaces/document/sheetSelection'

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

const KEY_DIRECTION: Record<string, [number, number]> = {
  ArrowRight: [0, 1], ArrowLeft: [0, -1], ArrowDown: [1, 0], ArrowUp: [-1, 0],
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
  onAnnotate,
  selectionResetKey,
}: {
  grid: Grid
  /** The sheet's name. */
  label: string
  /** Cells drawn at first, and added by each "show more rows". A parameter so a test need not draw thirty thousand. */
  cellBudget?: number
  onAnnotate?: (selection: DocumentAnnotationSelection) => void
  selectionResetKey?: unknown
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

  type Position = { row: number; column: number }
  const [selection, setSelection] = useState<{
    anchor: Position; end: Position; grid: Grid; resetKey: unknown
  } | null>(null)
  const active = selection?.grid === grid && selection.resetKey === selectionResetKey ? selection : null
  const selectCell = (row: number, column: number, extend: boolean, keyboardAnchor?: Position) => {
    const end = { row, column }
    setSelection({ anchor: extend ? active?.anchor ?? keyboardAnchor ?? end : end, end, grid, resetKey: selectionResetKey })
  }
  const annotationEnabled = onAnnotate !== undefined
  const mergeIndex = useMemo(
    () => annotationEnabled ? indexSheetMerges(origins, grid, rows) : null,
    [annotationEnabled, origins, grid, rows],
  )
  const bounds = active && mergeIndex ? expandSheetSelection({
    firstRow: Math.min(active.anchor.row, active.end.row),
    firstColumn: Math.min(active.anchor.column, active.end.column),
    lastRow: Math.max(active.anchor.row, active.end.row),
    lastColumn: Math.max(active.anchor.column, active.end.column),
  }, mergeIndex) : null
  const address = bounds ? (() => {
    const first = `${columnLabel(bounds.firstColumn)}${bounds.firstRow + 1}`
    const last = `${columnLabel(bounds.lastColumn)}${bounds.lastRow + 1}`
    return first === last ? first : `${first}:${last}`
  })() : ''
  const annotate = () => {
    if (!bounds || !onAnnotate) return
    const lines: string[] = []
    for (let row = bounds.firstRow; row <= bounds.lastRow; row += 1) {
      const values: string[] = []
      for (let column = bounds.firstColumn; column <= bounds.lastColumn; column += 1) {
        values.push(covered.has(row * grid.columns + column) ? '' : grid.cells[row]?.[column]?.text ?? '')
      }
      lines.push(values.join('\t'))
    }
    onAnnotate({ text: lines.join('\n'), location: `${label}!${address}` })
  }

  const templateColumns = `${ROW_HEADER_WIDTH}px ${grid.columnWidths.map((width) => `${width}px`).join(' ')}`
  const templateRows = [
    `${HEADER_HEIGHT}px`,
    ...grid.rowHeights.slice(0, rows).map((height) => (height === undefined ? `minmax(${MIN_ROW_HEIGHT}px, auto)` : `${height}px`)),
  ].join(' ')

  const cells = []
  let firstVisibleCell = true
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
          const tabStop = active ? active.end.row === row && active.end.column === column : firstVisibleCell
          firstVisibleCell = false
          return (
            <div
              key={column}
              role={onAnnotate ? 'gridcell' : 'cell'}
              data-sheet-row={row}
              data-sheet-column={column}
              aria-label={onAnnotate ? `${columnLabel(column)}${row + 1}${cell?.text ? `: ${cell.text}` : ''}` : undefined}
              aria-selected={onAnnotate ? Boolean(bounds && row <= bounds.lastRow && row + rowSpan - 1 >= bounds.firstRow && column <= bounds.lastColumn && column + (merge?.columnSpan ?? 1) - 1 >= bounds.firstColumn) : undefined}
              tabIndex={onAnnotate ? (tabStop ? 0 : -1) : undefined}
              onClick={onAnnotate ? (event) => selectCell(row, column, event.shiftKey) : undefined}
              onKeyDown={onAnnotate ? (event) => {
                if (event.key === 'Escape') {
                  setSelection(null)
                  return
                }
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  selectCell(row, column, event.shiftKey)
                  return
                }
                const direction = KEY_DIRECTION[event.key]
                if (!direction) return
                event.preventDefault()
                let nextRow = row + direction[0]
                let nextColumn = column + direction[1]
                while (nextRow >= 0 && nextRow < rows && nextColumn >= 0 && nextColumn < grid.columns) {
                  const next = event.currentTarget.closest('[role="grid"]')?.querySelector<HTMLElement>(`[data-sheet-row="${nextRow}"][data-sheet-column="${nextColumn}"]`)
                  if (next) {
                    selectCell(nextRow, nextColumn, event.shiftKey, { row, column })
                    next.focus()
                    break
                  }
                  nextRow += direction[0]
                  nextColumn += direction[1]
                }
              } : undefined}
              title={cell && cell.text.length > 24 ? cell.text : undefined}
              className={`aria-selected:bg-[var(--color-brand-soft)] aria-selected:ring-1 aria-selected:ring-inset aria-selected:ring-[var(--color-brand)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)] min-w-0 overflow-hidden text-ellipsis whitespace-nowrap border-b border-r border-[var(--color-border)] px-2 py-0.5 text-xs leading-[18px] text-[var(--color-text-primary)] ${ALIGN_CLASS[cell?.align ?? 'left']}`}
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
      {onAnnotate ? (
        <div className="sticky left-0 top-0 z-[var(--z-sticky)] flex h-10 items-center gap-2 bg-[var(--color-surface)] px-3 py-2 text-[12px] text-[var(--color-text-secondary)]">
          <span className="min-w-0 flex-1 truncate">{address || t('workspace.annotation.selectCells')}</span>
          <Button variant="secondary" size="sm" disabled={!bounds} onClick={annotate}>
            {t('workspace.annotation.add')}
          </Button>
        </div>
      ) : null}
      <div
        role={onAnnotate ? 'grid' : 'table'}
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
          <div className={`${HEADER_CELL} sticky left-0 ${onAnnotate ? 'top-10' : 'top-0'} z-[2]`} style={{ gridRow: 1, gridColumn: 1 }} />
          {Array.from({ length: grid.columns }, (_, column) => (
            grid.columnWidths[column] === 0 ? null : (
              <div
                key={column}
                role="columnheader"
                className={`${HEADER_CELL} sticky ${onAnnotate ? 'top-10' : 'top-0'} z-[1]`}
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
