import { vi } from 'vitest'
import type {
  DelimitedFormat,
  Grid,
  GridCell,
  SpreadsheetDocument,
  SpreadsheetEngine,
} from '@/components/workspace/surfaces/document/spreadsheetEngine'

/**
 * A grid from rows of values: a number is a right-aligned cell, a string a left-aligned one,
 * `undefined` a hole. Sizes are the engine's defaults; anything else goes in `overrides`.
 */
export function gridOf(rows: Array<Array<string | number | undefined>>, overrides: Partial<Grid> = {}): Grid {
  const columns = Math.max(0, ...rows.map((row) => row.length))
  const cells = rows.map((row) => Array.from({ length: columns }, (_, column): GridCell | undefined => {
    const value = row[column]
    if (value === undefined) return undefined
    return { text: String(value), align: typeof value === 'number' ? 'right' : 'left' }
  }))
  return {
    cells,
    rows: rows.length,
    columns,
    merges: [],
    columnWidths: Array.from({ length: columns }, () => 72),
    rowHeights: rows.map(() => undefined),
    truncatedRows: false,
    truncatedColumns: false,
    ...overrides,
  }
}

export type FakeSheet = {
  name: string
  grid: Grid
  /** Left out of the engine's list of sheets, as SheetJS-read hidden sheets are. */
  hidden?: boolean
}

/** One `open` call, for a test to finish or fail when it chooses. */
export type FakeOpen = {
  bytes: Uint8Array
  finish: () => void
  fail: (error: unknown) => void
}

/** One `readSheet` call, likewise. `document` counts the `open` calls that produced it, from 0. */
export type FakeRead = {
  document: number
  index: number
  finish: () => void
  fail: (error: unknown) => void
}

/**
 * A spreadsheet engine a test can drive. `open` and `readSheet` both wait for the test to say
 * they are done, which is what lets it assert on the state in between: the previous version
 * still on show while the next opens, the previous sheet still up while the next is read.
 *
 * `autoFinish` answers at once, for the tests that only care about what ends up on screen.
 * `setSheets` changes what the next `open` finds, as an agent rewriting the workbook would.
 */
export function createFakeSpreadsheetEngine({
  sheets,
  autoFinish = false,
}: { sheets: FakeSheet[]; autoFinish?: boolean }) {
  const opens: FakeOpen[] = []
  const reads: FakeRead[] = []
  let current = sheets

  const engine: SpreadsheetEngine & { open: ReturnType<typeof vi.fn> } = {
    open: vi.fn((bytes: Uint8Array, options?: { delimited?: DelimitedFormat }) => new Promise<SpreadsheetDocument>((resolve, reject) => {
      const workbook = current
      const documentNumber = opens.length
      const document: SpreadsheetDocument = {
        sheets: workbook.flatMap((sheet, index) => (sheet.hidden ? [] : [{ index, name: sheet.name }])),
        delimited: options?.delimited ? true : undefined,
        readSheet: (index) => new Promise<Grid>((resolveRead, rejectRead) => {
          const read: FakeRead = {
            document: documentNumber,
            index,
            finish: () => {
              const sheet = workbook[index]
              if (sheet) resolveRead(sheet.grid)
              else rejectRead(new Error(`no sheet ${index}`))
            },
            fail: rejectRead,
          }
          reads.push(read)
          if (autoFinish) read.finish()
        }),
      }
      const open: FakeOpen = { bytes, finish: () => resolve(document), fail: reject }
      opens.push(open)
      if (autoFinish) open.finish()
    })),
  }

  return {
    engine,
    opens,
    reads,
    setSheets: (next: FakeSheet[]) => {
      current = next
    },
  }
}
