import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  type KeyboardEvent,
} from 'react'
import { useElementSize } from '@/hooks/useElementSize'
import { useTranslation } from '@/i18n'
import { getDesktopHost } from '@/lib/desktopHost'
import {
  ZOOM_MAX,
  ZOOM_MIN,
  anchoredScroll,
  anchoredScrollLeft,
  clampZoom,
  stepZoom,
  wheelZoom,
  zoomPercent,
} from '@/lib/zoomPan'
import { useUIStore } from '@/stores/uiStore'
import { PanelMessage } from '../PanelMessage'
import { DocumentFailure } from './DocumentFailure'
import type { DocumentViewerProps } from './documentViewers'
import { DocumentToolbar, type DocumentZoomState } from './DocumentToolbar'
import { defaultDocxEngine, type DocxEngine, type DocxError } from './docxEngine'
import { applyZoom, contentHeight, currentColorScheme, type FrameHandlers } from './docxFrame'
import { useDocxDocument, type RenderedDocx } from './useDocxDocument'

export type DocxSurfaceProps = DocumentViewerProps & {
  /** Overridable so a test can supply a document without loading docx-preview. */
  engine?: DocxEngine
}

/** The padding `presentationCss` puts around the pages, on each side, at 100%. */
const WRAPPER_PADDING = 16
/** "Fit to width" never enlarges a page past its natural size. */
const FIT_MAX_SCALE = 1
/** Two zooms closer than this are the same zoom. */
const ZOOM_EPSILON = 1e-3

function fileNameOf(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path
}

function failureMessage(error: DocxError, t: ReturnType<typeof useTranslation>): string {
  if (error.kind === 'tooComplex') return t('workspace.document.tooComplex')
  if (error.kind === 'unavailable') return t('workspace.document.engineUnavailable')
  return t('workspace.document.parseFailed')
}

/**
 * The Word viewer `DocumentSurface` loads for `.docx` files.
 *
 * The document is drawn into a frame that cannot run script (see `docxFrame`), sized to its
 * content so that this surface's scroll area — not the frame — does the scrolling. Zoom is
 * CSS `zoom` on the pages inside the frame, which re-lays the text out at the new size
 * instead of stretching a picture of it.
 */
export default function DocxSurface({
  blob,
  path,
  absolutePath,
  zoom,
  onZoomChange,
  initialView,
  engine = defaultDocxEngine,
}: DocxSurfaceProps) {
  const t = useTranslation()
  const hostRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const [sizeRef, viewport] = useElementSize<HTMLDivElement>()
  const setScroller = useCallback((node: HTMLDivElement | null) => {
    scrollRef.current = node
    sizeRef(node)
  }, [sizeRef])

  const handlersRef = useRef<FrameHandlers>({
    onExternalLink: () => undefined,
    onWheelZoom: () => undefined,
    onZoomKey: () => undefined,
  })
  const layoutRef = useRef<(rendered: RenderedDocx) => void>(() => undefined)
  const { current, error, retry } = useDocxDocument({
    engine,
    blob,
    hostRef,
    title: fileNameOf(path),
    handlersRef,
    layoutRef,
  })

  // `null` until there is both a document and a panel to fit it to.
  const fit = current && viewport
    ? Math.min(FIT_MAX_SCALE, clampZoom(viewport.width / (current.naturalWidth + 2 * WRAPPER_PADDING)))
    : null
  const scale = fit === null ? null : zoom === undefined ? fit : clampZoom(zoom)

  /** Zoom, width and height for a frame. Returns the width, which the scroll anchoring needs. */
  const layout = useCallback((rendered: RenderedDocx, toScale: number, panelWidth: number) => {
    const width = Math.max(panelWidth, (rendered.naturalWidth + 2 * WRAPPER_PADDING) * toScale)
    rendered.frame.style.width = `${width}px`
    applyZoom(rendered.doc, toScale)
    // Read after the zoom is applied: the height is that of the pages at the new size.
    rendered.frame.style.height = `${contentHeight(rendered.doc)}px`
    return width
  }, [])

  useLayoutEffect(() => {
    layoutRef.current = (rendered) => {
      if (scale !== null && viewport) layout(rendered, scale, viewport.width)
    }
  })

  const pendingRestore = useRef(initialView ? { top: initialView.scrollTop, left: initialView.scrollLeft } : null)
  const pendingAnchor = useRef<{ x: number; y: number } | null>(null)
  const lastScroll = useRef({ top: 0, left: 0 })
  const lastLayout = useRef<{ frame: HTMLIFrameElement; scale: number; width: number } | null>(null)

  useLayoutEffect(() => {
    const node = scrollRef.current
    if (!node) return
    if (!current || scale === null || !viewport) {
      // Hidden, or not drawn yet. A hidden panel loses its scroll offset, so remember
      // where the reader was and put them back when it returns.
      if (lastLayout.current) {
        pendingRestore.current = lastScroll.current
        lastLayout.current = null
      }
      return
    }

    const previous = lastLayout.current
    const width = layout(current, scale, viewport.width)
    if (pendingRestore.current) {
      node.scrollTop = pendingRestore.current.top
      node.scrollLeft = pendingRestore.current.left
      pendingRestore.current = null
    } else if (previous && previous.frame === current.frame && Math.abs(previous.scale - scale) > ZOOM_EPSILON) {
      const anchor = pendingAnchor.current ?? { x: viewport.width / 2, y: 0 }
      node.scrollTop = anchoredScroll({
        scrollLeft: node.scrollLeft,
        scrollTop: node.scrollTop,
        anchorX: anchor.x,
        anchorY: anchor.y,
        oldScale: previous.scale,
        newScale: scale,
      }).scrollTop
      node.scrollLeft = anchoredScrollLeft({
        scrollLeft: node.scrollLeft,
        anchorX: anchor.x,
        oldScale: previous.scale,
        newScale: scale,
        oldContentWidth: previous.width,
        newContentWidth: width,
      })
    }
    pendingAnchor.current = null
    lastLayout.current = { frame: current.frame, scale, width }
    lastScroll.current = { top: node.scrollTop, left: node.scrollLeft }
  }, [current, scale, viewport, layout])

  // The frame's colour scheme follows the theme, or its canvas turns opaque over the surround.
  const theme = useUIStore((state) => state.theme)
  useEffect(() => {
    const meta = current?.doc.querySelector('meta[name="color-scheme"]')
    const scheme = currentColorScheme()
    if (meta && scheme) meta.setAttribute('content', scheme)
  }, [current, theme])

  const zoomTo = useCallback((next: number | undefined, anchor?: { x: number; y: number }) => {
    const node = scrollRef.current
    const target = next === undefined ? fit : clampZoom(next)
    if (node && scale !== null && target !== null && Math.abs(target - scale) > ZOOM_EPSILON) {
      pendingAnchor.current = { x: anchor?.x ?? node.clientWidth / 2, y: anchor?.y ?? node.clientHeight / 2 }
    }
    onZoomChange(next)
  }, [fit, scale, onZoomChange])

  const zoomByKey = useCallback((key: string) => {
    if (scale === null) return
    if (key === '+' || key === '=') zoomTo(stepZoom(scale, 1))
    else if (key === '-' || key === '_') zoomTo(stepZoom(scale, -1))
    else if (key === '0') zoomTo(undefined)
    else if (key === '1') zoomTo(1)
  }, [scale, zoomTo])

  /** A point in the frame, as a point in the scroll area: what the zoom anchors to. */
  const inScrollArea = useCallback((at: { x: number; y: number }) => {
    const scroller = scrollRef.current?.getBoundingClientRect()
    const frame = current?.frame.getBoundingClientRect()
    return scroller && frame ? { x: frame.left - scroller.left + at.x, y: frame.top - scroller.top + at.y } : undefined
  }, [current])

  useLayoutEffect(() => {
    handlersRef.current = {
      onExternalLink: (url) => {
        void getDesktopHost().shell.open(url).catch(() => window.open(url, '_blank', 'noopener'))
      },
      onWheelZoom: (deltaY, at) => {
        if (scale !== null) zoomTo(wheelZoom(scale, deltaY), inScrollArea(at))
      },
      onZoomKey: zoomByKey,
    }
  })

  // A wheel over the surround, outside the frame. Native and non-passive on purpose: React's
  // `onWheel` is passive, where preventDefault is ignored and a pinch would zoom the whole app.
  const latest = useRef({ zoomTo, scale })
  useLayoutEffect(() => {
    latest.current = { zoomTo, scale }
  })
  useEffect(() => {
    const node = scrollRef.current
    if (!node) return
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return
      event.preventDefault()
      const { zoomTo: zoomAt, scale: now } = latest.current
      if (now === null) return
      const rect = node.getBoundingClientRect()
      zoomAt(wheelZoom(now, event.deltaY), { x: event.clientX - rect.left, y: event.clientY - rect.top })
    }
    node.addEventListener('wheel', onWheel, { passive: false })
    return () => node.removeEventListener('wheel', onWheel)
  }, [])

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.ctrlKey || event.metaKey || event.altKey || scale === null) return
    if (!['+', '=', '-', '_', '0', '1'].includes(event.key)) return
    zoomByKey(event.key)
    event.preventDefault()
  }

  const zoomState: DocumentZoomState = {
    percent: zoomPercent(scale ?? 1),
    fitActive: zoom === undefined,
    canZoomIn: scale !== null && scale < ZOOM_MAX - ZOOM_EPSILON,
    canZoomOut: scale !== null && scale > ZOOM_MIN + ZOOM_EPSILON,
    onZoomIn: () => scale !== null && zoomTo(stepZoom(scale, 1)),
    onZoomOut: () => scale !== null && zoomTo(stepZoom(scale, -1)),
    onFit: () => zoomTo(undefined),
  }

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {current ? (
        <DocumentToolbar
          absolutePath={absolutePath}
          zoom={zoomState}
          note={t('workspace.document.approximate.docx')}
        />
      ) : null}
      <div
        ref={setScroller}
        // The pages arrive after this mounts, so the panel leaves restoring the scroll position
        // to us (see WorkspaceFileTab); it still records where the reader leaves it.
        data-workspace-scroll-surface="deferred"
        role="group"
        aria-label={fileNameOf(path)}
        tabIndex={0}
        onKeyDown={onKeyDown}
        onScroll={(event) => {
          lastScroll.current = { top: event.currentTarget.scrollTop, left: event.currentTarget.scrollLeft }
        }}
        // A permanent vertical scrollbar: whether the page overflows must not change the
        // width "fit to width" measures. With a classic scrollbar (Windows, Linux) one that
        // comes and goes narrows the panel, which shrinks the fit, which removes the
        // overflow and the scrollbar with it — and the page changes size for good.
        className="min-h-0 flex-1 overflow-x-auto overflow-y-scroll bg-[var(--color-surface-container-high)] outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-border-focus)]"
      >
        <div ref={hostRef} className="relative" />
      </div>
      {current ? null : (
        <div className="absolute inset-0 bg-[var(--color-surface)]">
          {error ? (
            <DocumentFailure
              message={failureMessage(error, t)}
              absolutePath={absolutePath}
              // The same bytes fail the same way, unless docx-preview itself was what failed to load.
              onRetry={error.kind === 'unavailable' ? retry : undefined}
            />
          ) : (
            <PanelMessage busy message={t('workspace.document.loading')} />
          )}
        </div>
      )}
      {current && error ? (
        <p role="status" className="shrink-0 border-t border-[var(--color-border)] px-3 py-1.5 text-[12px] text-[var(--color-text-tertiary)]">
          {t('workspace.files.refreshFailed', { reason: failureMessage(error, t) })}
        </p>
      ) : null}
    </div>
  )
}
