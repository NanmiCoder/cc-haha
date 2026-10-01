import { strToU8, zipSync } from 'fflate'
import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_OFFICE_ZIP_LIMITS } from '@/lib/workspace/officeZipGuard'
import { resultsWorkbook, workbookOf } from '@/test/fixtures/xlsx'
import {
  DEFAULT_SPREADSHEET_LIMITS,
  SpreadsheetError,
  createSpreadsheetEngine,
  defaultSpreadsheetEngine,
  type SpreadsheetEngine,
} from './spreadsheetEngine'

/** The real SheetJS, reading real workbooks written by it. */
const engine: SpreadsheetEngine = createSpreadsheetEngine({ loadSheetJs: () => import('xlsx') })

async function firstGrid(bytes: Uint8Array, using: SpreadsheetEngine = engine) {
  const document = await using.open(bytes)
  return document.readSheet(document.sheets[0]!.index)
}

const failureOf = (promise: Promise<unknown>) => promise.catch((error: unknown) => error)

describe('the sheets of a workbook', () => {
  it('lists the visible ones, in order, by their place among all of them', async () => {
    const document = await engine.open(resultsWorkbook())

    // "Hidden data" is the workbook's second sheet: it is not offered, and "Second" is still the third.
    expect(document.sheets).toEqual([
      { index: 0, name: '结果 Results' },
      { index: 2, name: 'Second' },
    ])
  })

  it('leaves out a very hidden sheet too', async () => {
    const document = await engine.open(workbookOf([
      { name: 'A', rows: [['a']] },
      { name: 'B', rows: [['b']], hidden: 2 },
    ]))

    expect(document.sheets.map((sheet) => sheet.name)).toEqual(['A'])
  })

  it('has no sheets to offer when none is visible', async () => {
    const document = await engine.open(workbookOf([{ name: 'Only', rows: [['x']], hidden: 1 }]))

    expect(document.sheets).toEqual([])
  })

  it('reads only the sheet it is asked for', async () => {
    const document = await engine.open(resultsWorkbook())

    const second = await document.readSheet(2)

    expect(second.cells[0]![0]!.text).toBe('only')
    expect(second.rows).toBe(2)
    expect(second.cells.flat().map((cell) => cell?.text)).not.toContain('实验结果 Experimental results')
  })

  it('does not read a sheet that is not there', async () => {
    const document = await engine.open(resultsWorkbook())

    expect(await failureOf(document.readSheet(9))).toBeInstanceOf(SpreadsheetError)
  })
})

describe('what a cell shows', () => {
  it('is its text as Excel would print it, not the raw number behind it', async () => {
    const grid = await firstGrid(resultsWorkbook())
    const formatted = grid.cells[6]!

    expect(formatted.map((cell) => cell?.text)).toEqual(['2023-03-15', '25.6%', '¥1,234.50', '1234.5'])
  })

  it('shows the value of a formula, not the formula', async () => {
    const grid = await firstGrid(resultsWorkbook())

    // (The row is four columns wide, like the sheet; its last cell is empty.)
    expect(grid.cells[4]!.map((cell) => cell?.text)).toEqual(['合计', '60', '14.125', undefined])
  })

  it('shows booleans and errors as Excel does', async () => {
    const grid = await firstGrid(resultsWorkbook())

    expect(grid.cells[5]![0]!.text).toBe('TRUE')
    expect(grid.cells[5]![1]!.text).toBe('#DIV/0!')
  })

  it('keeps markup in a cell as text, for the viewer to show as text', async () => {
    const grid = await firstGrid(resultsWorkbook())

    expect(grid.cells[5]![2]!.text).toBe('<img src=x onerror="window.parent.__cellXss=1">')
  })

  it('reads Chinese', async () => {
    const grid = await firstGrid(resultsWorkbook())

    expect(grid.cells[0]![0]!.text).toBe('实验结果 Experimental results')
    expect(grid.cells[2]![0]!.text).toBe('对照组')
  })

  it('leaves an empty cell a hole rather than an empty string', async () => {
    const grid = await firstGrid(workbookOf([{ name: 'A', rows: [['a', null, 'c'], [null, 'b']] }]))

    expect(grid.cells[0]![1]).toBeUndefined()
    expect(grid.cells[1]![0]).toBeUndefined()
    expect(grid.columns).toBe(3)
  })

  it('puts numbers to the right, booleans and errors in the middle, and text to the left, as Excel does', async () => {
    const grid = await firstGrid(resultsWorkbook())

    expect(grid.cells[2]![0]!.align).toBe('left')
    expect(grid.cells[2]![1]!.align).toBe('right')
    expect(grid.cells[5]![0]!.align).toBe('center')
    expect(grid.cells[5]![1]!.align).toBe('center')
  })

  it('cuts a cell that is absurdly long instead of holding all of it', async () => {
    const limited = createSpreadsheetEngine({
      loadSheetJs: () => import('xlsx'),
      limits: { ...DEFAULT_SPREADSHEET_LIMITS, maxCellChars: 10 },
    })

    const grid = await firstGrid(workbookOf([{ name: 'A', rows: [['0123456789abcdef']] }]), limited)

    expect(grid.cells[0]![0]!.text).toBe('0123456789…')
  })
})

describe('the shape of a sheet', () => {
  it('reports its size', async () => {
    const grid = await firstGrid(resultsWorkbook())

    expect(grid.rows).toBe(7)
    expect(grid.columns).toBe(4)
    expect(grid.truncatedRows).toBe(false)
    expect(grid.truncatedColumns).toBe(false)
  })

  it('reads merged cells as spans', async () => {
    const grid = await firstGrid(resultsWorkbook())

    expect(grid.merges).toEqual([{ row: 0, column: 0, rowSpan: 1, columnSpan: 3 }])
  })

  it.each(['xlsx', 'xlsm', 'biff8'] as const)('keeps the empty extent of a merged title in %s', async (format) => {
    const grid = await firstGrid(workbookOf([{
      name: 'Results',
      rows: [['Thesis research results']],
      merges: [{ s: { r: 0, c: 0 }, e: { r: 2, c: 3 } }],
    }], format))

    expect([grid.rows, grid.columns]).toEqual([3, 4])
    expect(grid.merges).toEqual([{ row: 0, column: 0, rowSpan: 3, columnSpan: 4 }])
    expect(grid.cells[0]![0]!.text).toBe('Thesis research results')
    expect(grid.columnWidths).toHaveLength(4)
    expect(grid.rowHeights).toHaveLength(3)
    expect(grid.truncatedRows).toBe(false)
    expect(grid.truncatedColumns).toBe(false)
  })

  it('caps the empty extent of a merged title at the preview limits', async () => {
    const limited = createSpreadsheetEngine({
      loadSheetJs: () => import('xlsx'),
      limits: { ...DEFAULT_SPREADSHEET_LIMITS, maxRows: 2, maxColumns: 2 },
    })
    const grid = await firstGrid(workbookOf([{
      name: 'Results',
      rows: [['Thesis research results']],
      merges: [{ s: { r: 0, c: 0 }, e: { r: 2, c: 3 } }],
    }]), limited)

    expect([grid.rows, grid.columns]).toEqual([2, 2])
    expect(grid.merges).toEqual([{ row: 0, column: 0, rowSpan: 2, columnSpan: 2 }])
    expect(grid.truncatedRows).toBe(true)
    expect(grid.truncatedColumns).toBe(true)
  })

  it('clips a merge to what was read, and drops one that starts beyond it', async () => {
    const limited = createSpreadsheetEngine({
      loadSheetJs: () => import('xlsx'),
      limits: { ...DEFAULT_SPREADSHEET_LIMITS, maxRows: 2, maxColumns: 2 },
    })
    const grid = await firstGrid(workbookOf([{
      name: 'A',
      rows: [['a', 'b', 'c'], ['d', 'e', 'f'], ['g', 'h', 'i']],
      merges: [
        { s: { r: 0, c: 0 }, e: { r: 1, c: 3 } }, // reaches past both limits
        { s: { r: 2, c: 0 }, e: { r: 2, c: 2 } }, // begins past the rows
        { s: { r: 0, c: 2 }, e: { r: 0, c: 4 } }, // begins past the columns
      ],
    }]), limited)

    expect(grid.merges).toEqual([{ row: 0, column: 0, rowSpan: 2, columnSpan: 2 }])
  })

  it('does not treat a merge of a single cell as a merge', async () => {
    const grid = await firstGrid(workbookOf([{ name: 'A', rows: [['a']], merges: [{ s: { r: 0, c: 0 }, e: { r: 0, c: 0 } }] }]))

    expect(grid.merges).toEqual([])
  })

  it('takes column widths from the sheet, and hides a hidden column by giving it none', async () => {
    const grid = await firstGrid(resultsWorkbook())

    expect(grid.columnWidths[0]).toBe(140) // set in pixels
    // Set in characters, and turned into pixels by SheetJS with the workbook's own digit width.
    expect(grid.columnWidths[1]).toBe(77)
    expect(grid.columnWidths[2]).toBe(0) // hidden
    expect(grid.columnWidths[3]).toBe(72) // not said
  })

  it('widens a column the file gives no width to fit its numbers, so a value is never cut to "12,000…"', async () => {
    const grid = await firstGrid(workbookOf([{ name: 'A', rows: [['项目', '预算(元)'], ['服务器', '1,234,567,890.00'], ['差旅', '8,000.00']] }]))

    // 16 digits/separators at ~6.6px, plus the cell's padding.
    expect(grid.columnWidths[1]).toBeGreaterThanOrEqual(120)
    // A short CJK label still gets the default floor, not a sliver.
    expect(grid.columnWidths[0]).toBeGreaterThanOrEqual(72)
  })

  it('leaves a short column at the default width', async () => {
    const grid = await firstGrid(workbookOf([{ name: 'A', rows: [['a', 'b'], ['c', 'd']] }]))

    expect(grid.columnWidths).toEqual([72, 72])
  })

  it('caps how far a long text can widen a column', async () => {
    const grid = await firstGrid(workbookOf([{ name: 'A', rows: [['x'.repeat(500)]] }]))

    expect(grid.columnWidths[0]).toBe(360)
  })

  it('does not widen a column for a merged heading that spills over its neighbours', async () => {
    const grid = await firstGrid(workbookOf([{
      name: 'A',
      rows: [['Quarterly budget summary for the whole group', '', ''], ['a', 'b', 'c']],
      merges: [{ s: { r: 0, c: 0 }, e: { r: 0, c: 2 } }],
    }]))

    expect(grid.columnWidths).toEqual([72, 72, 72])
  })

  it('widens a stated column for a number that would otherwise be cut, as Excel would show ####', async () => {
    // 12 characters is what the file asked for; the preview font needs more for this figure.
    const grid = await firstGrid(workbookOf([{
      name: 'A',
      rows: [['预算', 1234567890.12]],
      columns: [{ wpx: 40 }, { wpx: 40 }],
    }]))

    expect(grid.columnWidths[1]).toBeGreaterThan(40)
    // The text column keeps the width the file set: clipping text is what Excel does too.
    expect(grid.columnWidths[0]).toBe(40)
  })

  it('never widens a column the file sets, nor a hidden one', async () => {
    const grid = await firstGrid(workbookOf([{
      name: 'A',
      rows: [['x'.repeat(100), 'y'.repeat(100)]],
      columns: [{ wpx: 90 }, { hidden: true }],
    }]))

    expect(grid.columnWidths).toEqual([90, 0])
  })

  it('keeps column widths within what can be drawn', async () => {
    const grid = await firstGrid(workbookOf([{ name: 'A', rows: [['a', 'b']], columns: [{ wpx: 2 }, { wpx: 9000 }] }]))

    expect(grid.columnWidths).toEqual([28, 480])
  })

  it('takes row heights from the sheet, kept in points and drawn in pixels, and hides a hidden row', async () => {
    const grid = await firstGrid(workbookOf([{
      name: 'A',
      rows: [['a'], ['b'], ['c'], ['d']],
      rowInfo: [{ hpt: 30 }, { hpt: 15 }, { hidden: true }, {}],
    }]))

    // 30pt = 40px and 15pt = 20px at 96 dpi.
    expect(grid.rowHeights).toEqual([40, 20, 0, undefined])
  })

  it('keeps row heights within what can be drawn', async () => {
    const grid = await firstGrid(workbookOf([{ name: 'A', rows: [['a'], ['b']], rowInfo: [{ hpt: 1 }, { hpt: 900 }] }]))

    expect(grid.rowHeights).toEqual([16, 400])
  })
})

describe('a sheet longer or wider than can be held', () => {
  const small = createSpreadsheetEngine({
    loadSheetJs: () => import('xlsx'),
    limits: { ...DEFAULT_SPREADSHEET_LIMITS, maxRows: 3, maxColumns: 2 },
  })

  it('holds the first rows and columns, and says there were more', async () => {
    const grid = await firstGrid(workbookOf([{
      name: 'A',
      rows: [['1a', '1b', '1c'], ['2a', '2b', '2c'], ['3a', '3b', '3c'], ['4a', '4b', '4c'], ['5a', '5b', '5c']],
    }]), small)

    expect(grid.rows).toBe(3)
    expect(grid.columns).toBe(2)
    expect(grid.truncatedRows).toBe(true)
    expect(grid.truncatedColumns).toBe(true)
    expect(grid.cells.map((row) => row.map((cell) => cell?.text))).toEqual([['1a', '1b'], ['2a', '2b'], ['3a', '3b']])
  })

  it('does not say so about a sheet that exactly fits', async () => {
    const grid = await firstGrid(workbookOf([{ name: 'A', rows: [['1a', '1b'], ['2a', '2b'], ['3a', '3b']] }]), small)

    expect(grid.rows).toBe(3)
    expect(grid.truncatedRows).toBe(false)
    expect(grid.truncatedColumns).toBe(false)
  })

  it('has limits a real thesis dataset clears', () => {
    expect(DEFAULT_SPREADSHEET_LIMITS.maxRows).toBeGreaterThanOrEqual(5_000)
    expect(DEFAULT_SPREADSHEET_LIMITS.maxColumns).toBeGreaterThanOrEqual(50)
  })
})

describe('an older workbook (.xls)', () => {
  it('reads one, with its Chinese text and its sheets', async () => {
    const document = await engine.open(workbookOf([
      { name: '数据', rows: [['姓名', '成绩'], ['张三', 91.5]] },
      { name: 'Two', rows: [['x']] },
    ], 'biff8'))

    expect(document.sheets.map((sheet) => sheet.name)).toEqual(['数据', 'Two'])
    const grid = await document.readSheet(0)
    expect(grid.cells.map((row) => row.map((cell) => cell?.text))).toEqual([['姓名', '成绩'], ['张三', '91.5']])
  })

  it('reads a macro-enabled workbook as a workbook, and runs nothing', async () => {
    const grid = await firstGrid(workbookOf([{ name: 'A', rows: [['macro', 'enabled']] }], 'xlsm'))

    expect(grid.cells[0]!.map((cell) => cell?.text)).toEqual(['macro', 'enabled'])
  })
})

describe('what is not a workbook', () => {
  it.each([
    ['text', strToU8('this is not a spreadsheet')],
    ['nothing', new Uint8Array(0)],
    ['HTML, which SheetJS would happily read as a table', strToU8('<html><body><table><tr><td>cell</td></tr></table></body></html>')],
    ['CSV, which it would read as rows', strToU8('a,b,c\n1,2,3\n')],
    ['SpreadsheetML XML, which it would read too', strToU8('<?xml version="1.0"?><Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"></Workbook>')],
  ])('answers %s with `invalid`, without asking SheetJS to interpret it', async (_label, bytes) => {
    const loadSheetJs = vi.fn(() => import('xlsx'))
    const guarded = createSpreadsheetEngine({ loadSheetJs })

    const failure = await failureOf(guarded.open(bytes))

    expect(failure).toBeInstanceOf(SpreadsheetError)
    expect(failure).toMatchObject({ kind: 'invalid' })
    expect(loadSheetJs).not.toHaveBeenCalled()
  })

  it('answers a workbook cut off mid-write (an agent still at it) with `invalid`', async () => {
    const whole = resultsWorkbook()

    const failure = await failureOf(engine.open(whole.slice(0, Math.floor(whole.length / 2))))

    expect(failure).toMatchObject({ kind: 'invalid' })
  })

  it('answers a zip that is not a workbook with `invalid`', async () => {
    const failure = await failureOf(engine.open(zipSync({ 'hello.txt': strToU8('hello') })))

    expect(failure).toMatchObject({ kind: 'invalid' })
  })

  it('answers an archive that promises to inflate past all reason with `tooComplex`, before loading anything', async () => {
    const loadSheetJs = vi.fn(() => import('xlsx'))
    const guarded = createSpreadsheetEngine({
      loadSheetJs,
      zipLimits: { ...DEFAULT_OFFICE_ZIP_LIMITS, maxEntryBytes: 1024 * 1024 },
    })
    const bomb = zipSync({ 'xl/media/huge.bmp': new Uint8Array(4 * 1024 * 1024) })

    const failure = await failureOf(guarded.open(bomb))

    expect(failure).toMatchObject({ kind: 'tooComplex' })
    expect(loadSheetJs).not.toHaveBeenCalled()
  })

  it('reports SheetJS failing to load as `unavailable`, not as a broken workbook', async () => {
    const broken = createSpreadsheetEngine({ loadSheetJs: () => Promise.reject(new Error('Failed to fetch dynamically imported module')) })

    const failure = await failureOf(broken.open(resultsWorkbook()))

    expect(failure).toMatchObject({ kind: 'unavailable' })
  })
})

describe('the default engine', () => {
  it('is built on SheetJS, loaded when a workbook is first opened', async () => {
    const document = await defaultSpreadsheetEngine.open(resultsWorkbook())

    expect(document.sheets.map((sheet) => sheet.name)).toEqual(['结果 Results', 'Second'])
  })
})
