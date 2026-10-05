import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react'
import { Input } from '@/components/ui/Input'
import { useDebouncedValue } from '@/hooks/useDebouncedValue'
import { useElementSize } from '@/hooks/useElementSize'
import { useTranslation } from '@/i18n'
import {
  ZOOM_MAX,
  ZOOM_MIN,
  anchoredScrollLeft,
  clampZoom,
  fitWidthScale,
  stepZoom,
  wheelZoom,
  zoomPercent,
} from '@/lib/zoomPan'
import type { WorkspaceFileView } from '@/stores/workspaceContentStore'
import { DocumentToolbar, type DocumentZoomState } from './DocumentToolbar'
import type { PdfDocumentHandle, PdfError } from './pdfEngine'
import {
  anchoredScrollTop,
  currentPageIndex,
  layoutPdfColumn,
  PDF_PAGE_GAP,
  PDF_PAGE_PADDING,
  scrollTopForPage,
  visiblePageRange,
  type PageBox,
  type PageSize,
} from './pdfLayout'
import { PdfPage } from './PdfPage'

/** The bitmap catches up with the zoom this long after the reader stops changing it. */
const REDRAW_SETTLE_MS = 120
/** Pages stay drawn this many viewport heights beyond what is visible, on each side. */
const OVERSCAN = 1
/** "Fit to width" never enlarges a page past its natural size. */
const FIT_MAX_SCALE = 1
/** Two zooms closer than this are the same zoom. */
const ZOOM_EPSILON = 1e-3

/** The pages that are mounted, and the one the reader would say they are on (0-based). */
type PageWindow = { first: number; last: number; current: number }

function sameWindow(a: PageWindow | null, b: PageWindow): boolean {
  return !!a && a.first === b.first && a.last === b.last && a.current === b.current
}

function fileNameOf(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path
}

export type PdfViewerProps = {
  doc: PdfDocumentHandle
  sizes: readonly PageSize[]
  path: string
  absolutePath: string
  /** The reader's zoom as a scale factor, or `undefined` for fit to width. */
  zoom: number | undefined
  onZoomChange: (zoom: number | undefined) => void
  /** Where this file was left when its tab was last open. */
  initialView: WorkspaceFileView | undefined
  /** A newer version could not be opened; `doc` is the version before it. */
  refreshError: PdfError | null
}

/**
 * The pages of an open PDF as one scrolling column, with the bar above it.
 *
 * Where each page sits is arithmetic on its size and the zoom (`pdfLayout`), so
 * which pages to draw is decided from the scroll offset alone, and only those few
 * exist as elements: a 500-page document is a tall empty box with a handful of
 * pages in it.
 *
 * Every change of layout — a zoom, a resized panel, a rewritten file — is
 * anchored to "this page, this far down", so the reader keeps their place.
 */
export function PdfViewer({
  doc,
  sizes,
  path,
  absolutePath,
  zoom,
  onZoomChange,
  initialView,
  refreshError,
}: PdfViewerProps) {
  const t = useTranslation()
  const [sizeRef, viewport] = useElementSize<HTMLDivElement>()
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const setScroller = useCallback((node: HTMLDivElement | null) => {
    scrollRef.current = node
    sizeRef(node)
  }, [sizeRef])

  const widest = useMemo(() => sizes.reduce((max, size) => Math.max(max, size.width), 0), [sizes])
  // `null` until the panel has a size: nothing is laid out, and so nothing drawn, for a hidden panel.
  const fit = viewport
    ? fitWidthScale({ containerWidth: viewport.width, contentWidth: widest, padding: PDF_PAGE_PADDING, maxScale: FIT_MAX_SCALE })
    : null
  const scale = fit === null ? null : zoom === undefined ? fit : clampZoom(zoom)
  const column = useMemo(
    () => (scale === null ? null : layoutPdfColumn(sizes, scale, { gap: PDF_PAGE_GAP, padding: PDF_PAGE_PADDING })),
    [sizes, scale],
  )
  const contentWidth = viewport && column ? Math.max(viewport.width, column.width + PDF_PAGE_PADDING * 2) : 0
  const settledScale = useDebouncedValue(scale, REDRAW_SETTLE_MS)
  const drawScale = settledScale ?? scale

  const [pageWindow, setPageWindow] = useState<PageWindow | null>(null)
  const lastScroll = useRef({ top: 0, left: 0 })

  const syncWindow = useCallback(() => {
    const node = scrollRef.current
    if (!node || !column) return
    lastScroll.current = { top: node.scrollTop, left: node.scrollLeft }
    const height = node.clientHeight
    const range = visiblePageRange(column.boxes, node.scrollTop, height, height * OVERSCAN)
    const next: PageWindow = {
      first: range?.first ?? 0,
      last: range?.last ?? -1,
      current: currentPageIndex(column.boxes, node.scrollTop, height),
    }
    setPageWindow((previous) => (sameWindow(previous, next) ? previous : next))
  }, [column])

  // Where to put the scroll offset once there is a layout to put it in.
  const pendingRestore = useRef(initialView ? { top: initialView.scrollTop, left: initialView.scrollLeft } : null)
  // The point to hold still through the next change of zoom (the pointer, for a wheel zoom).
  const pendingAnchor = useRef<{ x: number; y: number } | null>(null)
  const previousLayout = useRef<{ boxes: readonly PageBox[]; scale: number; contentWidth: number } | null>(null)

  useLayoutEffect(() => {
    const node = scrollRef.current
    if (!node) return
    if (!column || scale === null) {
      // Hidden or not yet measured. A hidden panel loses its scroll offset, so
      // remember where the reader was and put them back when it returns.
      if (previousLayout.current) {
        pendingRestore.current = lastScroll.current
        previousLayout.current = null
      }
      return
    }

    const previous = previousLayout.current
    if (pendingRestore.current) {
      node.scrollTop = pendingRestore.current.top
      node.scrollLeft = pendingRestore.current.left
      pendingRestore.current = null
    } else if (previous && previous.boxes !== column.boxes) {
      const anchor = pendingAnchor.current ?? { x: node.clientWidth / 2, y: 0 }
      node.scrollTop = anchoredScrollTop({
        before: previous.boxes,
        after: column.boxes,
        scrollTop: node.scrollTop,
        anchorY: anchor.y,
      })
      node.scrollLeft = anchoredScrollLeft({
        scrollLeft: node.scrollLeft,
        anchorX: anchor.x,
        oldScale: previous.scale,
        newScale: scale,
        oldContentWidth: previous.contentWidth,
        newContentWidth: contentWidth,
      })
    }
    pendingAnchor.current = null
    previousLayout.current = { boxes: column.boxes, scale, contentWidth }
    syncWindow()
  }, [column, scale, contentWidth, viewport?.height, syncWindow])

  const zoomTo = useCallback((next: number | undefined, anchor?: { x: number; y: number }) => {
    const node = scrollRef.current
    const target = next === undefined ? fit : clampZoom(next)
    if (node && scale !== null && target !== null && Math.abs(target - scale) > ZOOM_EPSILON) {
      pendingAnchor.current = { x: anchor?.x ?? node.clientWidth / 2, y: anchor?.y ?? node.clientHeight / 2 }
    }
    onZoomChange(next)
  }, [fit, scale, onZoomChange])

  // Latest values for the native wheel listener, which is bound once.
  const latest = useRef({ zoomTo, scale })
  useLayoutEffect(() => {
    latest.current = { zoomTo, scale }
  })

  useEffect(() => {
    const node = scrollRef.current
    if (!node) return
    // Native and non-passive on purpose: React attaches `onWheel` as a passive
    // listener, where preventDefault is ignored — and a pinch would then zoom the
    // whole page as well as the document.
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return
      event.preventDefault()
      const { zoomTo: zoomAt, scale: current } = latest.current
      if (current === null) return
      const rect = node.getBoundingClientRect()
      zoomAt(wheelZoom(current, event.deltaY), { x: event.clientX - rect.left, y: event.clientY - rect.top })
    }
    node.addEventListener('wheel', onWheel, { passive: false })
    return () => node.removeEventListener('wheel', onWheel)
  }, [])

  const goToPage = (page: number) => {
    const node = scrollRef.current
    if (!node || !column) return
    node.scrollTop = scrollTopForPage(column.boxes, page - 1, PDF_PAGE_GAP)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.ctrlKey || event.metaKey || event.altKey || scale === null) return
    if (event.key === '+' || event.key === '=') zoomTo(stepZoom(scale, 1))
    else if (event.key === '-' || event.key === '_') zoomTo(stepZoom(scale, -1))
    else if (event.key === '0') zoomTo(undefined)
    else if (event.key === '1') zoomTo(1)
    else return
    event.preventDefault()
  }

  const currentPage = (pageWindow?.current ?? 0) + 1
  // What the reader is typing in the page box; `null` while they are not.
  const [draftPage, setDraftPage] = useState<string | null>(null)

  const zoomState: DocumentZoomState = {
    percent: zoomPercent(scale ?? 1),
    fitActive: zoom === undefined,
    canZoomIn: scale !== null && scale < ZOOM_MAX - ZOOM_EPSILON,
    canZoomOut: scale !== null && scale > ZOOM_MIN + ZOOM_EPSILON,
    onZoomIn: () => scale !== null && zoomTo(stepZoom(scale, 1)),
    onZoomOut: () => scale !== null && zoomTo(stepZoom(scale, -1)),
    onFit: () => zoomTo(undefined),
  }

  const pages: ReactNode[] = []
  if (column && scale !== null && drawScale !== null && pageWindow) {
    // The window can be a beat behind a layout that has fewer pages (a rewritten file).
    const last = Math.min(pageWindow.last, column.boxes.length - 1)
    for (let index = pageWindow.first; index <= last; index += 1) {
      const box = column.boxes[index]!
      pages.push(
        <div
          key={index}
          className="absolute"
          style={{ top: box.top, left: (contentWidth - box.width) / 2, width: box.width, height: box.height }}
        >
          <PdfPage doc={doc} pageNumber={index + 1} total={sizes.length} scale={scale} drawScale={drawScale} />
        </div>,
      )
    }
  }

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <DocumentToolbar
        absolutePath={absolutePath}
        zoom={zoomState}
        leading={
          <div role="group" aria-label={t('workspace.pdf.pages')} className="flex items-center gap-1.5">
            <Input
              aria-label={t('workspace.pdf.pageNumber')}
              size="sm"
              inputMode="numeric"
              autoComplete="off"
              containerClassName="w-14"
              className="text-center tabular-nums"
              value={draftPage ?? String(currentPage)}
              onFocus={(event) => {
                setDraftPage(String(currentPage))
                event.currentTarget.select()
              }}
              onChange={(event) => setDraftPage(event.target.value.replace(/\D/g, ''))}
              onBlur={() => setDraftPage(null)}
              onKeyDown={(event) => {
                if (event.key !== 'Enter' && event.key !== 'Escape') return
                const page = Number.parseInt(draftPage ?? '', 10)
                if (event.key === 'Enter' && Number.isFinite(page)) goToPage(page)
                setDraftPage(null)
                // Hand the keyboard back to the document, so the arrow keys keep scrolling it.
                scrollRef.current?.focus({ preventScroll: true })
              }}
            />
            <span className="text-xs tabular-nums text-[var(--color-text-tertiary)]">/ {sizes.length}</span>
          </div>
        }
      />
      <div
        ref={setScroller}
        // The pages lay out asynchronously, so this panel leaves restoring the scroll
        // position to us (see WorkspaceFileTab); it still records where the reader leaves it.
        data-workspace-scroll-surface="deferred"
        role="group"
        aria-label={fileNameOf(path)}
        tabIndex={0}
        onKeyDown={onKeyDown}
        onScroll={syncWindow}
        // A permanent vertical scrollbar: whether the column overflows must not change
        // the width "fit to width" measures, or a one-page document would flicker
        // between the two widths.
        className="min-h-0 flex-1 overflow-x-auto overflow-y-scroll bg-[var(--color-surface-container-high)] outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-border-focus)]"
      >
        {column ? (
          <div className="relative" style={{ width: contentWidth, height: column.height }}>
            {pages}
          </div>
        ) : null}
      </div>
      {refreshError ? (
        <p role="status" className="shrink-0 border-t border-[var(--color-border)] px-3 py-1.5 text-[12px] text-[var(--color-text-tertiary)]">
          {t('workspace.files.refreshFailed', { reason: refreshReason(refreshError, t) })}
        </p>
      ) : null}
    </div>
  )
}

function refreshReason(error: PdfError, t: ReturnType<typeof useTranslation>): string {
  if (error.kind === 'password') return t('workspace.document.passwordProtected')
  if (error.kind === 'unavailable') return t('workspace.document.engineUnavailable')
  return t('workspace.document.parseFailed')
}
