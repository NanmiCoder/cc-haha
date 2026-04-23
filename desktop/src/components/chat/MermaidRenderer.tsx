import { useEffect, useRef, useState, useCallback } from 'react'
import DOMPurify from 'dompurify'
import mermaid from 'mermaid'
import { Modal } from '../shared/Modal'
import { CopyButton } from '../shared/CopyButton'

type Props = {
  code: string
}

let mermaidInitialized = false
const MIN_PREVIEW_ZOOM = 0.5
const MAX_PREVIEW_ZOOM = 3
const PREVIEW_ZOOM_STEP = 0.25

type SvgMetrics = {
  width: number
  height: number
}

type DragState = {
  pointerId: number
  startX: number
  startY: number
  scrollLeft: number
  scrollTop: number
}

function initMermaid() {
  if (mermaidInitialized) return
  mermaid.initialize({
    startOnLoad: false,
    theme: 'default',
    securityLevel: 'strict',
    fontFamily: 'var(--font-sans)',
  })
  mermaidInitialized = true
}

let mermaidIdCounter = 0

function clampZoom(value: number) {
  return Math.min(MAX_PREVIEW_ZOOM, Math.max(MIN_PREVIEW_ZOOM, value))
}

function getPointerPosition(
  event: Pick<React.PointerEvent<HTMLDivElement>, 'clientX' | 'clientY' | 'pageX' | 'pageY'>,
) {
  const x = Number.isFinite(event.clientX) ? event.clientX : event.pageX
  const y = Number.isFinite(event.clientY) ? event.clientY : event.pageY

  return {
    x: Number.isFinite(x) ? x : 0,
    y: Number.isFinite(y) ? y : 0,
  }
}

function parseSvgMetrics(svg: string): SvgMetrics | null {
  const viewBoxMatch = svg.match(/viewBox="([^"]+)"/i)
  if (viewBoxMatch) {
    const viewBox = viewBoxMatch[1]
    if (!viewBox) return null

    const values = viewBox
      .split(/[\s,]+/)
      .map((part) => Number.parseFloat(part))

    if (values.length === 4 && values.every((value) => Number.isFinite(value))) {
      const [, , width, height] = values
      if (width !== undefined && height !== undefined) {
        return { width, height }
      }
    }
  }

  const widthMatch = svg.match(/\bwidth="([0-9.]+)(?:px)?"/i)
  const heightMatch = svg.match(/\bheight="([0-9.]+)(?:px)?"/i)
  if (widthMatch && heightMatch) {
    const widthValue = widthMatch[1]
    const heightValue = heightMatch[1]
    if (!widthValue || !heightValue) return null

    const width = Number.parseFloat(widthValue)
    const height = Number.parseFloat(heightValue)
    if (Number.isFinite(width) && Number.isFinite(height)) {
      return { width, height }
    }
  }

  return null
}

export function MermaidRenderer({ code }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const previewViewportRef = useRef<HTMLDivElement>(null)
  const previewContentRef = useRef<HTMLDivElement>(null)
  const dragStateRef = useRef<DragState | null>(null)
  const [svg, setSvg] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [previewOpen, setPreviewOpen] = useState(false)
  const [previewZoom, setPreviewZoom] = useState(1)
  const [isDraggingPreview, setIsDraggingPreview] = useState(false)

  const svgMetrics = svg ? parseSvgMetrics(svg) : null

  useEffect(() => {
    let cancelled = false
    initMermaid()

    const id = `mermaid-${++mermaidIdCounter}`

    mermaid.render(id, code).then(
      ({ svg: renderedSvg }) => {
        if (!cancelled) {
          setSvg(renderedSvg)
          setError(null)
        }
      },
      (err) => {
        if (!cancelled) {
          setError(String(err?.message || err))
          setSvg(null)
        }
      },
    )

    return () => { cancelled = true }
  }, [code])

  const handlePreview = useCallback(() => setPreviewOpen(true), [])
  const handlePreviewClose = useCallback(() => setPreviewOpen(false), [])
  const zoomIn = useCallback(
    () => setPreviewZoom((value) => clampZoom(value + PREVIEW_ZOOM_STEP)),
    [],
  )
  const zoomOut = useCallback(
    () => setPreviewZoom((value) => clampZoom(value - PREVIEW_ZOOM_STEP)),
    [],
  )
  const resetZoom = useCallback(() => setPreviewZoom(1), [])

  useEffect(() => {
    if (!previewOpen) {
      setPreviewZoom(1)
      setIsDraggingPreview(false)
      dragStateRef.current = null
    }
  }, [previewOpen, svg])

  const stopDraggingPreview = useCallback(() => {
    const viewport = previewViewportRef.current
    const dragState = dragStateRef.current
    if (viewport && dragState) {
      try {
        viewport.releasePointerCapture(dragState.pointerId)
      } catch {
        // Ignore capture release failures from synthetic test events.
      }
    }
    dragStateRef.current = null
    setIsDraggingPreview(false)
  }, [])

  useEffect(() => stopDraggingPreview, [stopDraggingPreview])

  useEffect(() => {
    if (!previewOpen || !previewContentRef.current) return

    const renderedSvg = previewContentRef.current.querySelector('svg')
    if (!renderedSvg) return

    renderedSvg.setAttribute('width', '100%')
    renderedSvg.setAttribute('height', '100%')
    renderedSvg.style.width = '100%'
    renderedSvg.style.height = '100%'
    renderedSvg.style.display = 'block'
  }, [previewOpen, svg, previewZoom])

  const handlePreviewWheel = useCallback((event: React.WheelEvent<HTMLDivElement>) => {
    if (!event.ctrlKey && !event.metaKey) return

    event.preventDefault()
    const direction = event.deltaY < 0 ? PREVIEW_ZOOM_STEP : -PREVIEW_ZOOM_STEP
    setPreviewZoom((value) => clampZoom(value + direction))
  }, [])

  const handlePreviewPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return

    const viewport = previewViewportRef.current
    if (!viewport) return
    const { x, y } = getPointerPosition(event)

    dragStateRef.current = {
      pointerId: event.pointerId,
      startX: x,
      startY: y,
      scrollLeft: viewport.scrollLeft,
      scrollTop: viewport.scrollTop,
    }
    setIsDraggingPreview(true)
    viewport.setPointerCapture(event.pointerId)
  }, [])

  const handlePreviewPointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const viewport = previewViewportRef.current
    const dragState = dragStateRef.current
    if (!viewport || !dragState || dragState.pointerId !== event.pointerId) return

    event.preventDefault()
    const { x, y } = getPointerPosition(event)
    viewport.scrollLeft = dragState.scrollLeft - (x - dragState.startX)
    viewport.scrollTop = dragState.scrollTop - (y - dragState.startY)
  }, [])

  const handlePreviewPointerUp = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const dragState = dragStateRef.current
    if (!dragState || dragState.pointerId !== event.pointerId) return
    stopDraggingPreview()
  }, [stopDraggingPreview])

  const previewCanvasStyle = svgMetrics
    ? {
        width: `${svgMetrics.width * previewZoom}px`,
        height: `${svgMetrics.height * previewZoom}px`,
      }
    : undefined

  if (error) {
    return (
      <div className="my-4 overflow-hidden rounded-[var(--radius-lg)] border border-[var(--color-error)]/30">
        <div className="flex items-center gap-2 border-b border-[var(--color-error)]/20 bg-[var(--color-error-container)] px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-[var(--color-error)]">
          <span className="material-symbols-outlined text-[14px]">error</span>
          Mermaid Error
        </div>
        <div className="bg-[var(--color-error-container)]/30 px-3 py-2 font-[var(--font-mono)] text-[11px] text-[var(--color-error)]">
          {error}
        </div>
      </div>
    )
  }

  if (!svg) {
    return (
      <div className="my-4 flex items-center justify-center rounded-[var(--radius-lg)] border border-[var(--color-border)]/50 bg-[var(--color-surface-container-low)] py-8">
        <div className="flex items-center gap-2 text-[11px] text-[var(--color-text-tertiary)]">
          <span className="material-symbols-outlined animate-spin text-[16px]">progress_activity</span>
          Rendering diagram...
        </div>
      </div>
    )
  }

  return (
    <>
      <div className="my-4 overflow-hidden rounded-[var(--radius-lg)] border border-[var(--color-outline-variant)]/50 bg-[var(--color-surface-container-low)]">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-[var(--color-outline-variant)]/40 bg-[var(--color-surface-container)] px-3 py-1.5 text-[11px] text-[var(--color-text-tertiary)]">
          <div className="flex items-center gap-2">
            <span className="material-symbols-outlined text-[14px]">account_tree</span>
            <span className="font-semibold uppercase tracking-[0.14em]">Mermaid</span>
          </div>
          <div className="flex items-center gap-1.5">
            <button
              onClick={handlePreview}
              className="flex items-center gap-1 rounded-md border border-[var(--color-outline-variant)]/40 bg-[var(--color-surface-container-lowest)] px-2 py-1 text-[11px] text-[var(--color-text-tertiary)] transition-colors hover:bg-[var(--color-surface-container-high)] hover:text-[var(--color-text-primary)]"
            >
              <span className="material-symbols-outlined text-[12px]">fullscreen</span>
              Preview
            </button>
            <CopyButton
              text={code}
              className="rounded-md border border-[var(--color-outline-variant)]/40 bg-[var(--color-surface-container-lowest)] px-2 py-1 text-[11px] text-[var(--color-text-tertiary)] transition-colors hover:bg-[var(--color-surface-container-high)] hover:text-[var(--color-text-primary)]"
            />
          </div>
        </div>

        {/* Diagram */}
        <div
          ref={containerRef}
          className="flex items-center justify-center overflow-auto bg-white p-4 cursor-pointer"
          style={{ maxHeight: 400 }}
          onClick={handlePreview}
          dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true } }) }}
        />
      </div>

      {/* Fullscreen preview modal */}
      <Modal open={previewOpen} onClose={handlePreviewClose} width={1100}>
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-sm font-semibold text-[var(--color-text-primary)]">
              <span className="material-symbols-outlined text-[18px]">account_tree</span>
              Mermaid Diagram
            </div>
            <div className="flex items-center gap-2">
              <div className="flex items-center gap-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-container-low)] px-1 py-1">
                <button
                  type="button"
                  onClick={zoomOut}
                  aria-label="Zoom out"
                  className="flex h-8 w-8 items-center justify-center rounded-md text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)]"
                >
                  <span className="material-symbols-outlined text-[16px]">remove</span>
                </button>
                <button
                  type="button"
                  onClick={resetZoom}
                  className="min-w-[68px] rounded-md px-2 py-1 text-[11px] font-semibold text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)]"
                >
                  {Math.round(previewZoom * 100)}%
                </button>
                <button
                  type="button"
                  onClick={zoomIn}
                  aria-label="Zoom in"
                  className="flex h-8 w-8 items-center justify-center rounded-md text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)]"
                >
                  <span className="material-symbols-outlined text-[16px]">add</span>
                </button>
              </div>
              <CopyButton
                text={code}
                className="rounded-md border border-[var(--color-border)] px-2.5 py-1 text-[11px] text-[var(--color-text-tertiary)] transition-colors hover:text-[var(--color-text-primary)]"
              />
            </div>
          </div>
          <div
            ref={previewViewportRef}
            data-testid="mermaid-preview-viewport"
            className="overflow-auto rounded-xl bg-white"
            style={{
              maxHeight: '75vh',
              cursor: isDraggingPreview ? 'grabbing' : 'grab',
            }}
            onWheel={handlePreviewWheel}
            onPointerDown={handlePreviewPointerDown}
            onPointerMove={handlePreviewPointerMove}
            onPointerUp={handlePreviewPointerUp}
            onPointerCancel={handlePreviewPointerUp}
            onPointerLeave={handlePreviewPointerUp}
          >
            <div className="min-h-full min-w-full p-6">
              <div
                ref={previewContentRef}
                className="mx-auto shrink-0 select-none"
                style={previewCanvasStyle}
                data-dragging={isDraggingPreview ? 'true' : 'false'}
                aria-label="Mermaid preview canvas"
                dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true } }) }}
              />
            </div>
          </div>
          <div className="text-[11px] text-[var(--color-text-tertiary)]">
            Use the zoom controls to enlarge the diagram. Drag inside the preview to pan, or use the trackpad, mouse wheel, and scrollbars. Hold Ctrl/Command while scrolling to zoom.
          </div>
        </div>
      </Modal>
    </>
  )
}
