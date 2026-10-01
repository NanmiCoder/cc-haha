import type * as SheetJs from 'xlsx'
import { OfficeZipError, inspectOfficeZip, type OfficeZipLimits } from '@/lib/workspace/officeZipGuard'

type SheetJsLibrary = typeof SheetJs

/**
 * Why a workbook could not be shown, in the terms the reader can act on.
 *
 * - `invalid`: not a workbook, damaged, or half-written by an agent that is still at it.
 * - `tooComplex`: a well-formed archive that promises to inflate to more than the page can hold.
 * - `unavailable`: SheetJS itself could not be loaded.
 */
export type SpreadsheetErrorKind = 'invalid' | 'tooComplex' | 'unavailable'

export class SpreadsheetError extends Error {
  readonly kind: SpreadsheetErrorKind
  readonly reason: unknown

  constructor(kind: SpreadsheetErrorKind, message: string, reason?: unknown) {
    super(message)
    this.name = 'SpreadsheetError'
    this.kind = kind
    this.reason = reason
  }
}

/** How much of a sheet is read. The rest is said to be there, not held. */
export type SpreadsheetLimits = {
  maxRows: number
  maxColumns: number
  /** A cell longer than this is cut. Excel allows 32,767 characters in one. */
  maxCellChars: number
}

export const DEFAULT_SPREADSHEET_LIMITS: SpreadsheetLimits = {
  maxRows: 5_000,
  maxColumns: 100,
  maxCellChars: 2_000,
}

export type CellAlign = 'left' | 'right' | 'center'

/** What a cell shows: its formatted text, as Excel would print it, and where Excel would put it. */
export type GridCell = { text: string; align: CellAlign }

export type Merge = {
  row: number
  column: number
  rowSpan: number
  columnSpan: number
}

/** One worksheet, as much of it as was read. Coordinates are 0-based. */
export type Grid = {
  /** Rows by columns; a hole is an empty cell. */
  cells: Array<Array<GridCell | undefined>>
  rows: number
  columns: number
  merges: Merge[]
  /** Pixels per column; 0 for a hidden one. */
  columnWidths: number[]
  /** Pixels per row where the sheet sets one, 0 for a hidden one, `undefined` to fit the text. */
  rowHeights: Array<number | undefined>
  truncatedRows: boolean
  truncatedColumns: boolean
}

export type SheetInfo = {
  /** Its place among all the workbook's sheets, hidden ones included. */
  index: number
  name: string
}

export type SpreadsheetDocument = {
  /** The visible worksheets, in order. */
  sheets: SheetInfo[]
  readSheet(index: number): Promise<Grid>
}

export type SpreadsheetEngine = {
  open(bytes: Uint8Array): Promise<SpreadsheetDocument>
}

export type SpreadsheetEngineOptions = {
  loadSheetJs: () => Promise<SheetJsLibrary>
  limits?: SpreadsheetLimits
  /** What an archive may promise to inflate to. For tests; the defaults are what the app uses. */
  zipLimits?: OfficeZipLimits
}

const DEFAULT_COLUMN_WIDTH = 72
const MIN_COLUMN_WIDTH = 28
const MAX_COLUMN_WIDTH = 480
/** A column grows to fit its text or numbers, up to this. */
const MAX_AUTO_COLUMN_WIDTH = 360
const CELL_PADDING = 18
const MIN_ROW_HEIGHT = 16
const MAX_ROW_HEIGHT = 400

/** `PK`, the start of a zip: .xlsx and .xlsm. */
function isZip(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04
}

/** The start of an OLE compound file: .xls, and also an encrypted .xlsx. */
function isCompoundFile(bytes: Uint8Array): boolean {
  const magic = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]
  return bytes.length >= magic.length && magic.every((byte, index) => bytes[index] === byte)
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

function cellText(cell: SheetJs.CellObject, maxChars: number): string {
  const text = cell.w ?? (cell.v === undefined || cell.v === null ? '' : String(cell.v))
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text
}

function cellAlign(cell: SheetJs.CellObject): CellAlign {
  if (cell.t === 'n') return 'right'
  if (cell.t === 'b' || cell.t === 'e') return 'center'
  return 'left'
}

/** Rendered width of cell text at the grid's 12px size; a CJK character is about twice a Latin one. */
function textWidth(text: string): number {
  let width = 0
  for (const char of text) width += (char.codePointAt(0) ?? 0) >= 0x2e80 ? 12 : 6.6
  return width
}

/**
 * How wide a column must be to show its cells whole. Excel would draw a number that does
 * not fit as `####`; a preview that cuts it to `12,000…` hides the value just the same, and
 * the preview's font is wider than the one the width was chosen for. `numbersOnly` is for a
 * column whose width the file states: its text may still be clipped, as Excel clips it, but
 * a number may not. A merged cell's text spills over its span, so it takes no part.
 */
function fitColumnWidth(cells: Grid['cells'], column: number, spilling: ReadonlySet<string>, numbersOnly: boolean): number {
  let widest = 0
  for (let row = 0; row < cells.length; row += 1) {
    const cell = cells[row]?.[column]
    if (!cell || spilling.has(`${row}:${column}`)) continue
    if (numbersOnly && cell.align !== 'right') continue
    widest = Math.max(widest, textWidth(cell.text))
  }
  return widest === 0 ? 0 : Math.min(Math.ceil(widest + CELL_PADDING), MAX_AUTO_COLUMN_WIDTH)
}

/** Turn a dense SheetJS worksheet into the grid the viewer draws, and let SheetJS's objects go. */
function toGrid(sheet: SheetJs.WorkSheet, limits: SpreadsheetLimits): Grid {
  const data = ((sheet as SheetJs.DenseSheet)['!data'] ?? []) as Array<Array<SheetJs.CellObject | undefined> | undefined>

  // Merged titles often have only their top-left cell stored. Their empty span still
  // belongs to the sheet, otherwise a multi-column heading becomes one narrow cell.
  let rowExtent = data.length
  let widest = 0
  for (let row = 0; row < Math.min(data.length, limits.maxRows); row += 1) widest = Math.max(widest, data[row]?.length ?? 0)
  for (const range of sheet['!merges'] ?? []) {
    if (range.s.r >= limits.maxRows || range.s.c >= limits.maxColumns) continue
    rowExtent = Math.max(rowExtent, range.e.r + 1)
    widest = Math.max(widest, range.e.c + 1)
  }
  // One row more than the limit was asked for; merged extents obey the same limits.
  const truncatedRows = rowExtent > limits.maxRows
  const rows = Math.min(rowExtent, limits.maxRows)
  const truncatedColumns = widest > limits.maxColumns
  const columns = Math.min(widest, limits.maxColumns)

  const cells: Grid['cells'] = []
  for (let row = 0; row < rows; row += 1) {
    const source = data[row]
    const line: Array<GridCell | undefined> = new Array<GridCell | undefined>(columns)
    for (let column = 0; column < columns; column += 1) {
      const cell = source?.[column]
      if (!cell || cell.t === 'z') continue
      const text = cellText(cell, limits.maxCellChars)
      if (text !== '') line[column] = { text, align: cellAlign(cell) }
    }
    cells.push(line)
  }

  const spilling = new Set<string>()
  for (const range of sheet['!merges'] ?? []) {
    if (range.e.c > range.s.c) spilling.add(`${range.s.r}:${range.s.c}`)
  }

  const columnInfo = sheet['!cols'] ?? []
  const columnWidths = Array.from({ length: columns }, (_, column) => {
    const info = columnInfo[column]
    if (info?.hidden) return 0
    const stated = info?.wpx ?? (info?.wch ? info.wch * 7 + 5 : undefined)
    const width = stated === undefined
      ? Math.max(DEFAULT_COLUMN_WIDTH, fitColumnWidth(cells, column, spilling, false))
      : Math.max(stated, fitColumnWidth(cells, column, spilling, true))
    return clamp(Math.round(width), MIN_COLUMN_WIDTH, MAX_COLUMN_WIDTH)
  })

  const rowInfo = sheet['!rows'] ?? []
  const rowHeights = Array.from({ length: rows }, (_, row): number | undefined => {
    const info = rowInfo[row]
    if (info?.hidden) return 0
    // A row's height is kept in points. SheetJS' own `hpx` is the same number, not converted.
    const height = info?.hpt !== undefined ? (info.hpt * 96) / 72 : info?.hpx
    return height === undefined ? undefined : clamp(Math.round(height), MIN_ROW_HEIGHT, MAX_ROW_HEIGHT)
  })

  const merges: Merge[] = []
  for (const range of sheet['!merges'] ?? []) {
    if (range.s.r >= rows || range.s.c >= columns) continue
    const rowSpan = Math.min(range.e.r, rows - 1) - range.s.r + 1
    const columnSpan = Math.min(range.e.c, columns - 1) - range.s.c + 1
    if (rowSpan > 1 || columnSpan > 1) merges.push({ row: range.s.r, column: range.s.c, rowSpan, columnSpan })
  }

  return { cells, rows, columns, merges, columnWidths, rowHeights, truncatedRows, truncatedColumns }
}

/**
 * The spreadsheet engine, built on SheetJS. It reads a workbook's table of contents first —
 * sheet names and which are hidden, without any sheet's cells — and builds a sheet's grid only
 * when the reader opens it, capped at a number of rows and columns, so a workbook with a
 * hundred sheets is a list of tabs and one sheet, not a hundred sheets in memory. Each read
 * still goes through the file (see `open`), which is what the size limit is for.
 *
 * It accepts only what it can name: a zip (.xlsx, .xlsm) or an OLE compound file (.xls).
 * SheetJS itself would take a file's contents for whatever they look like — HTML, CSV, XML —
 * whatever the extension says, and a preview has no business parsing those.
 */
export function createSpreadsheetEngine({
  loadSheetJs,
  limits = DEFAULT_SPREADSHEET_LIMITS,
  zipLimits,
}: SpreadsheetEngineOptions): SpreadsheetEngine {
  return {
    async open(bytes) {
      if (isZip(bytes)) {
        try {
          inspectOfficeZip(bytes, zipLimits)
        } catch (error) {
          if (error instanceof OfficeZipError) {
            throw new SpreadsheetError(error.reason === 'not-a-zip' ? 'invalid' : 'tooComplex', error.message, error)
          }
          throw error
        }
      } else if (!isCompoundFile(bytes)) {
        throw new SpreadsheetError('invalid', 'Not a spreadsheet file')
      }

      let sheetjs: SheetJsLibrary
      try {
        sheetjs = await loadSheetJs()
      } catch (error) {
        throw new SpreadsheetError('unavailable', error instanceof Error ? error.message : String(error), error)
      }

      let names: string[]
      let hidden: boolean[]
      try {
        // Reads the workbook's own part, which lists the sheets and which are hidden, without
        // asking for any sheet's cells. That is cheaper, not cheap: an .xlsx's shared strings,
        // which every sheet indexes into, are still parsed whole, and an .xls (one BIFF stream,
        // with no separate parts) is read in full whatever `sheets` says. Measured near the
        // size limit that is a second or two on this thread, and `readSheet` below pays the
        // same again for each sheet the reader visits first. (`bookSheets` looks like the
        // option for this, but it leaves the hidden flags out.)
        const contents = sheetjs.read(bytes, { type: 'array', sheets: [] })
        names = contents.SheetNames
        hidden = names.map((_, index) => (contents.Workbook?.Sheets?.[index]?.Hidden ?? 0) !== 0)
      } catch (error) {
        throw new SpreadsheetError('invalid', error instanceof Error ? error.message : String(error), error)
      }

      const sheets = names.flatMap((name, index): SheetInfo[] => (hidden[index] ? [] : [{ index, name }]))
      return {
        sheets,
        async readSheet(index) {
          const name = names[index]
          if (name === undefined) throw new SpreadsheetError('invalid', `The workbook has no sheet ${index}`)
          try {
            const workbook = sheetjs.read(bytes, {
              type: 'array',
              dense: true,
              sheets: index,
              // One more than is shown: see `toGrid`.
              sheetRows: limits.maxRows + 1,
              // Nothing to draw with these, and each costs memory per cell.
              cellFormula: false,
              cellHTML: false,
              // Column widths, row heights and which are hidden are only read with this on. It also
              // hangs a style object on every cell, which is why the rows and columns are capped.
              cellStyles: true,
            })
            const sheet = workbook.Sheets[name]
            if (!sheet) throw new Error(`The sheet ${name} was not read`)
            return toGrid(sheet, limits)
          } catch (error) {
            throw new SpreadsheetError('invalid', error instanceof Error ? error.message : String(error), error)
          }
        },
      }
    },
  }
}

/** The engine the app uses. SheetJS loads on the first workbook, not at startup. */
export const defaultSpreadsheetEngine: SpreadsheetEngine = createSpreadsheetEngine({
  loadSheetJs: () => import('xlsx'),
})
