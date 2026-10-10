import { useCallback, useEffect, useRef, useState } from 'react'
import {
  SpreadsheetError,
  type DelimitedFormat,
  type Grid,
  type SheetInfo,
  type SpreadsheetDocument,
  type SpreadsheetEngine,
} from './spreadsheetEngine'

export type SpreadsheetDocumentState = {
  /**
   * The workbook to show. It stays in place while a newer version of the same file opens,
   * and is only replaced once the new one is ready.
   */
  current: SpreadsheetDocument | null
  /**
   * Why the newest version could not be opened. With `current` set, that is the previous
   * version, still on screen; without, there is nothing to show.
   */
  error: SpreadsheetError | null
  retry: () => void
}

function toSpreadsheetError(reason: unknown): SpreadsheetError {
  if (reason instanceof SpreadsheetError) return reason
  return new SpreadsheetError('invalid', reason instanceof Error ? reason.message : String(reason), reason)
}

/**
 * Open the workbook in `blob` with `engine`, and keep it open for as long as it is shown.
 *
 * A file an agent is still writing produces a stream of versions, some of them half a
 * workbook. Each new `blob` is opened off to the side: the reader keeps the version they are
 * looking at until the next one is open, and one that will not open changes nothing but the
 * note under the sheet.
 */
export function useSpreadsheetDocument(
  engine: SpreadsheetEngine,
  blob: Blob,
  delimited?: DelimitedFormat,
): SpreadsheetDocumentState {
  const [current, setCurrent] = useState<SpreadsheetDocument | null>(null)
  const [error, setError] = useState<SpreadsheetError | null>(null)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let superseded = false
    setError(null)

    void (async () => {
      try {
        // Our own copy of the bytes: the Blob is held for the next tab switch.
        const bytes = new Uint8Array(await blob.arrayBuffer())
        const document = await engine.open(bytes, delimited ? { delimited } : undefined)
        if (!superseded) setCurrent(document)
      } catch (reason) {
        if (!superseded) setError(toSpreadsheetError(reason))
      }
    })()

    return () => {
      superseded = true
    }
  }, [engine, blob, delimited, attempt])

  const retry = useCallback(() => setAttempt((count) => count + 1), [])

  return { current, error, retry }
}

export type SheetGridState = {
  /**
   * The sheet the reader is on: the one they picked, if this version of the workbook still has
   * it; failing that, the one they were looking at; failing that, the first.
   */
  selected: SheetInfo | null
  /** The grid to show: the selected sheet once it has been read, until then the one before it. */
  grid: Grid | null
  /**
   * Which sheet `grid` is, by name. Names, not positions: a newer version of the workbook may
   * have a sheet added in front, and the sheet on screen is still the same sheet.
   */
  gridName: string | null
  /** The selected sheet could not be read. */
  error: SpreadsheetError | null
}

/**
 * Choose a sheet of `document` and read it. Sheets already read are kept, so switching back to
 * one is instant; and the sheet on screen is not blanked while the next is read, which for a
 * sheet of any size is a beat during which the panel would otherwise flash empty.
 *
 * `preferred` is the sheet the reader picked, by name; before they pick one, the sheet that
 * happens to be first is the one they are on, and a sheet inserted in front of it by the next
 * version of the file does not move them.
 */
export function useSheetGrid(document: SpreadsheetDocument | null, preferred: string | undefined): SheetGridState {
  const cache = useRef(new WeakMap<SpreadsheetDocument, Map<number, Grid>>())
  const [shown, setShown] = useState<{ grid: Grid; name: string } | null>(null)
  const [failure, setFailure] = useState<{ document: SpreadsheetDocument; index: number; error: SpreadsheetError } | null>(null)

  const wanted = preferred ?? shown?.name
  const selected = document ? (document.sheets.find((sheet) => sheet.name === wanted) ?? document.sheets[0] ?? null) : null
  const index = selected?.index ?? null
  const name = selected?.name ?? null

  useEffect(() => {
    if (!document || index === null || name === null) return
    let superseded = false
    const known = cache.current.get(document)?.get(index)
    if (known) {
      setShown({ grid: known, name })
      setFailure(null)
      return
    }
    void (async () => {
      try {
        const grid = await document.readSheet(index)
        if (superseded) return
        const forDocument = cache.current.get(document) ?? new Map<number, Grid>()
        forDocument.set(index, grid)
        cache.current.set(document, forDocument)
        setShown({ grid, name })
        setFailure(null)
      } catch (reason) {
        if (!superseded) setFailure({ document, index, error: toSpreadsheetError(reason) })
      }
    })()
    return () => {
      superseded = true
    }
  }, [document, index, name])

  return {
    selected,
    grid: shown?.grid ?? null,
    gridName: shown?.name ?? null,
    error: failure && failure.document === document && failure.index === index ? failure.error : null,
  }
}
