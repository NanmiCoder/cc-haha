import { Table } from 'lucide-react'
import { useCallback, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { SegmentedControl } from '@/components/ui/SegmentedControl'
import { useElementSize } from '@/hooks/useElementSize'
import { useTranslation } from '@/i18n'
import { fileExtension } from '@/lib/fileCapabilities'
import { PanelMessage } from '../PanelMessage'
import { DelimitedSource } from './DelimitedSource'
import { DocumentFailure } from './DocumentFailure'
import { DocumentToolbar } from './DocumentToolbar'
import type { DocumentViewerProps } from './documentViewers'
import { SheetGrid } from './SheetGrid'
import {
  defaultSpreadsheetEngine,
  type DelimitedFormat,
  type SpreadsheetEngine,
  type SpreadsheetError,
} from './spreadsheetEngine'
import { useSheetGrid, useSpreadsheetDocument } from './useSpreadsheetDocument'

export type SpreadsheetSurfaceProps = DocumentViewerProps & {
  /** Overridable so a test can supply a workbook without loading SheetJS. */
  engine?: SpreadsheetEngine
}

type ScrollAt = { top: number; left: number }

function fileNameOf(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path
}

function delimitedFormatOf(path: string): DelimitedFormat | undefined {
  const extension = fileExtension(path)
  return extension === 'csv' || extension === 'tsv' ? extension : undefined
}

type DelimitedView = 'table' | 'source'

function failureMessage(error: SpreadsheetError, t: ReturnType<typeof useTranslation>): string {
  if (error.kind === 'tooComplex') return t('workspace.document.tooComplex')
  if (error.kind === 'unavailable') return t('workspace.document.engineUnavailable')
  return t('workspace.document.parseFailed')
}

/**
 * The spreadsheet viewer `DocumentSurface` loads for `.xlsx` files, and for `.csv` and
 * `.tsv`, which are one sheet with no tabs and a way back to the text they are.
 *
 * A workbook is a row of sheet tabs over one sheet at a time, drawn as a grid of text (see
 * `SheetGrid`). Which sheet the reader is on is remembered with the file, and so is where
 * they scrolled to on each sheet while the tab stays open.
 */
export default function SpreadsheetSurface({
  blob,
  path,
  absolutePath,
  sheet,
  onSheetChange,
  initialView,
  source,
  engine = defaultSpreadsheetEngine,
}: SpreadsheetSurfaceProps) {
  const t = useTranslation()
  const delimited = delimitedFormatOf(path)
  const { current, error, retry } = useSpreadsheetDocument(engine, blob, delimited)
  // A reference to a line of the file (`data.csv:12`) is about its text, so it opens there.
  const [view, setView] = useState<DelimitedView>(delimited && source?.reveal ? 'source' : 'table')
  const showSource = delimited !== undefined && source !== undefined && view === 'source'

  const { selected, grid, gridName, error: gridError } = useSheetGrid(current, sheet)
  // The sheet asked for is the one on screen. While it is not, the last one stays up.
  const onScreen = selected !== null && gridName === selected.name

  // ---- scroll: one position per sheet, and back where it was when the panel returns ----

  const scrollRef = useRef<HTMLDivElement | null>(null)
  const [sizeRef, viewport] = useElementSize<HTMLDivElement>()
  const setScroller = useCallback((node: HTMLDivElement | null) => {
    scrollRef.current = node
    sizeRef(node)
  }, [sizeRef])

  const lastScroll = useRef<ScrollAt>({ top: 0, left: 0 })
  /** Where each sheet was left, by name, when the reader moved to another. */
  const leftAt = useRef(new Map<string, ScrollAt>())
  const pendingRestore = useRef<(ScrollAt & { name: string | null }) | null>(
    initialView ? { name: null, top: initialView.scrollTop, left: initialView.scrollLeft } : null,
  )
  /** The sheet the scroller is currently laid out for; `null` before the first, and while hidden. */
  const placed = useRef<string | null>(null)
  const visible = viewport !== null

  useLayoutEffect(() => {
    const node = scrollRef.current
    if (!node || grid === null || gridName === null) return
    if (!visible) {
      // A hidden panel loses its scroll offset. Remember where the reader was, to put them back.
      if (placed.current !== null) {
        pendingRestore.current = { name: placed.current, ...lastScroll.current }
        placed.current = null
      }
      return
    }
    if (placed.current === gridName) return // a newer version of the sheet on screen: stay put

    const pending = pendingRestore.current
    const target = pending && (pending.name === null || pending.name === gridName)
      ? pending
      : leftAt.current.get(gridName) ?? { top: 0, left: 0 }
    pendingRestore.current = null
    node.scrollTop = target.top
    node.scrollLeft = target.left
    lastScroll.current = { top: node.scrollTop, left: node.scrollLeft }
    placed.current = gridName
  }, [grid, gridName, visible])

  const selectSheet = (name: string) => {
    const node = scrollRef.current
    if (node && placed.current !== null) leftAt.current.set(placed.current, { top: node.scrollTop, left: node.scrollLeft })
    onSheetChange?.(name)
  }

  // ---- what covers the grid, if anything ----

  let cover: ReactNode = null
  if (!current) {
    cover = error
      ? (
        <DocumentFailure
          message={failureMessage(error, t)}
          absolutePath={absolutePath}
          // The same bytes fail the same way, unless SheetJS itself was what failed to load.
          onRetry={error.kind === 'unavailable' ? retry : undefined}
        />
      )
      : <PanelMessage busy message={t('workspace.document.loading')} />
  } else if (!selected) {
    cover = <PanelMessage icon={Table} message={t('workspace.sheet.empty')} />
  } else if (!onScreen) {
    if (gridError) cover = <DocumentFailure message={failureMessage(gridError, t)} absolutePath={absolutePath} />
    else if (grid === null) cover = <PanelMessage busy message={t('workspace.document.loading')} />
  } else if (grid && (grid.rows === 0 || grid.columns === 0)) {
    cover = <PanelMessage icon={Table} message={t('workspace.sheet.empty')} />
  }

  // A newer version that would not open, or would not read, leaves the last good one up.
  const refreshFailure = current ? (error ?? (onScreen ? gridError : null)) : null

  const viewToggle = delimited && source
    ? (
      <SegmentedControl
        label={t('workspace.delimited.view')}
        size="sm"
        value={view}
        onChange={setView}
        items={[
          { value: 'table', label: t('workspace.delimited.table') },
          { value: 'source', label: t('workspace.delimited.source') },
        ]}
      />
    )
    : null

  // One anonymous sheet has nothing to switch between.
  const tabs = current && selected && !current.delimited
    ? (
      <div className="min-w-0 overflow-x-auto">
        <SegmentedControl
          as="tablist"
          appearance="underline"
          size="sm"
          label={t('workspace.sheet.tabs')}
          items={current.sheets.map((item) => ({ value: item.name, label: item.name }))}
          value={selected.name}
          onChange={selectSheet}
        />
      </div>
    )
    : undefined

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {current ? (
        <DocumentToolbar
          leading={<>{viewToggle}{tabs}</>}
          absolutePath={absolutePath}
          note={showSource ? undefined : t(delimited ? 'workspace.document.approximate.csv' : 'workspace.document.approximate.xlsx')}
        />
      ) : null}
      {showSource && source ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <DelimitedSource blob={blob} source={source} />
        </div>
      ) : null}
      {/* Kept mounted behind the source view: a hidden table keeps where the reader was. */}
      <div className={showSource ? 'hidden' : 'relative min-h-0 flex-1'}>
        <div
          ref={setScroller}
          // The grid arrives after this mounts, so the panel leaves restoring the scroll position
          // to us (see WorkspaceFileTab); it still records where the reader leaves it.
          data-workspace-scroll-surface="deferred"
          role="tabpanel"
          aria-label={gridName ?? fileNameOf(path)}
          aria-busy={selected !== null && !onScreen && !gridError}
          aria-hidden={cover ? true : undefined}
          tabIndex={cover ? -1 : 0}
          onScroll={(event) => {
            lastScroll.current = { top: event.currentTarget.scrollTop, left: event.currentTarget.scrollLeft }
          }}
          className="absolute inset-0 overflow-auto bg-[var(--color-surface)] outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-border-focus)]"
        >
          {grid && gridName !== null ? <SheetGrid key={gridName} grid={grid} label={gridName} /> : null}
        </div>
        {cover ? <div className="absolute inset-0 bg-[var(--color-surface)]">{cover}</div> : null}
      </div>
      {refreshFailure ? (
        <p role="status" className="shrink-0 border-t border-[var(--color-border)] px-3 py-1.5 text-[12px] text-[var(--color-text-tertiary)]">
          {t('workspace.files.refreshFailed', { reason: failureMessage(refreshFailure, t) })}
        </p>
      ) : null}
    </div>
  )
}
