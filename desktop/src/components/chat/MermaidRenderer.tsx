import { useEffect, useLayoutEffect, useMemo, useRef, useState, useCallback } from 'react'
import DOMPurify from 'dompurify'
import mermaid from 'mermaid'
import { Modal } from '../shared/Modal'
import { CopyButton } from '../shared/CopyButton'
import { useUIStore } from '../../stores/uiStore'
import type { ThemeMode } from '../../types/settings'

type Props = {
  code: string
}

const MIN_PREVIEW_ZOOM = 0.05
const MAX_PREVIEW_ZOOM = 3
const PREVIEW_ZOOM_STEP = 0.25
const PREVIEW_FIT_PADDING = 48

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

type MermaidThemeColors = {
  textColor: string
  mutedTextColor: string
  surfaceColor: string
  nodeColor: string
  accentColor: string
  lineColor: string
  isDark: boolean
}

const FLOWCHART_START = /^\s*(?:graph|flowchart)\b/i
const FLOWCHART_NODE_START = /^([A-Za-z][\w-]*)\[/
const UNQUOTED_FLOWCHART_LABEL_UNSAFE = /<br\s*\/?>|[{}[\]*]/i

function isFlowchartDiagram(code: string) {
  const firstMeaningfulLine = code
    .split('\n')
    .map((line) => line.trim())
    .find(Boolean)

  return firstMeaningfulLine ? FLOWCHART_START.test(firstMeaningfulLine) : false
}

function isQuotedFlowchartLabel(label: string) {
  const trimmed = label.trim()
  return (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'")) ||
    (trimmed.startsWith('`') && trimmed.endsWith('`'))
  )
}

function shouldQuoteFlowchartLabel(label: string) {
  return !isQuotedFlowchartLabel(label) && UNQUOTED_FLOWCHART_LABEL_UNSAFE.test(label)
}

function escapeFlowchartLabel(label: string) {
  return label.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

function isLikelyFlowchartLabelClose(line: string, closeIndex: number) {
  const after = line.slice(closeIndex + 1).trimStart()
  return (
    after.length === 0 ||
    after.startsWith('--') ||
    after.startsWith('-.') ||
    after.startsWith('==') ||
    after.startsWith('~~~') ||
    after.startsWith(':::') ||
    after.startsWith('&') ||
    after.startsWith('@') ||
    /^[;,)]/.test(after)
  )
}

function findFlowchartLabelClose(line: string, openIndex: number) {
  for (let index = openIndex + 1; index < line.length; index += 1) {
    if (line[index] === ']' && isLikelyFlowchartLabelClose(line, index)) {
      return index
    }
  }
  return -1
}

function normalizeFlowchartLine(line: string) {
  let output = ''
  let index = 0

  while (index < line.length) {
    const match = FLOWCHART_NODE_START.exec(line.slice(index))
    if (!match) {
      output += line[index]
      index += 1
      continue
    }

    const nodeId = match[1] ?? ''
    const openIndex = index + nodeId.length
    const closeIndex = findFlowchartLabelClose(line, openIndex)
    if (closeIndex < 0) {
      output += line[index]
      index += 1
      continue
    }

    const label = line.slice(openIndex + 1, closeIndex)
    if (!shouldQuoteFlowchartLabel(label)) {
      output += line.slice(index, closeIndex + 1)
    } else {
      output += `${nodeId}["${escapeFlowchartLabel(label)}"]`
    }
    index = closeIndex + 1
  }

  return output
}

function normalizeGeneratedFlowchartSyntax(code: string) {
  if (!isFlowchartDiagram(code)) return code
  return code.split('\n').map(normalizeFlowchartLine).join('\n')
}

function rgbToHex(color: string, fallback: string) {
  const trimmed = color.trim()
  if (/^#[0-9a-f]{6}$/i.test(trimmed)) return trimmed
  const shortHex = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(trimmed)
  if (shortHex) {
    return `#${shortHex[1]}${shortHex[1]}${shortHex[2]}${shortHex[2]}${shortHex[3]}${shortHex[3]}`
  }

  const rgb = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i.exec(trimmed)
  if (!rgb) return fallback

  return [rgb[1], rgb[2], rgb[3]]
    .map((value) => {
      const channel = Math.max(0, Math.min(255, Math.round(Number.parseFloat(value ?? '0'))))
      return channel.toString(16).padStart(2, '0')
    })
    .join('')
    .replace(/^/, '#')
}

function resolveThemeColor(token: string, fallback: string) {
  if (typeof document === 'undefined') return fallback

  const probe = document.createElement('span')
  probe.style.color = `var(${token})`
  probe.style.position = 'absolute'
  probe.style.pointerEvents = 'none'
  probe.style.opacity = '0'
  document.body.appendChild(probe)
  const resolved = getComputedStyle(probe).color
  probe.remove()

  return rgbToHex(resolved, fallback)
}

function getMermaidThemeColors(theme: ThemeMode): MermaidThemeColors {
  const isDark = theme === 'dark'
  return {
    textColor: resolveThemeColor('--color-text-primary', isDark ? '#E5E2E1' : '#1B1C1A'),
    mutedTextColor: resolveThemeColor('--color-text-secondary', isDark ? '#B7AAA5' : '#61514B'),
    surfaceColor: resolveThemeColor('--color-surface-container-lowest', isDark ? '#0E0E0E' : '#FFFFFF'),
    nodeColor: resolveThemeColor('--color-surface-container-low', isDark ? '#1C1B1B' : '#F4EFEA'),
    accentColor: resolveThemeColor('--color-primary', isDark ? '#FFB59F' : '#8F482F'),
    lineColor: resolveThemeColor('--color-outline', isDark ? '#BFAEAA' : '#667485'),
    isDark,
  }
}

function initMermaid(theme: ThemeMode) {
  const {
    textColor,
    mutedTextColor,
    surfaceColor,
    nodeColor,
    accentColor,
    lineColor,
    isDark,
  } = getMermaidThemeColors(theme)

  mermaid.initialize({
    startOnLoad: false,
    theme: 'base',
    htmlLabels: false,
    flowchart: {
      htmlLabels: false,
      arrowMarkerAbsolute: true,
    },
    themeVariables: {
      darkMode: isDark,
      background: surfaceColor,
      mainBkg: nodeColor,
      primaryColor: nodeColor,
      primaryTextColor: textColor,
      primaryBorderColor: lineColor,
      secondaryColor: surfaceColor,
      tertiaryColor: surfaceColor,
      textColor,
      lineColor,
      edgeLabelBackground: surfaceColor,
      clusterBkg: surfaceColor,
      clusterBorder: lineColor,
      titleColor: textColor,
      labelTextColor: textColor,
      nodeTextColor: textColor,
      noteTextColor: textColor,
      noteBkgColor: surfaceColor,
      noteBorderColor: lineColor,
      actorTextColor: textColor,
      actorLineColor: lineColor,
      signalTextColor: textColor,
      signalColor: mutedTextColor,
      activationBkgColor: nodeColor,
      activationBorderColor: accentColor,
    },
    securityLevel: 'strict',
    suppressErrorRendering: true,
    fontFamily: 'var(--font-sans)',
  })

  return { lineColor }
}

let mermaidIdCounter = 0

function sanitizeMermaidSvg(svg: string) {
  return DOMPurify.sanitize(svg, {
    USE_PROFILES: { svg: true, svgFilters: true, html: true },
    ADD_TAGS: ['foreignObject'],
  })
}

function formatSvgDimension(value: number) {
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(3)))
}

function getSvgStyleProperty(element: Element, property: string) {
  const style = element.getAttribute('style') ?? ''
  const escapedProperty = property.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = new RegExp(`(?:^|;)\\s*${escapedProperty}\\s*:\\s*([^;]+)`, 'i').exec(style)
  return match?.[1]?.trim() ?? ''
}

function setSvgStyle(element: Element, property: string, value: string, overwrite = true) {
  if (!overwrite && getSvgStyleProperty(element, property)) return

  const style = element.getAttribute('style') ?? ''
  const escapedProperty = property.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const declaration = `${property}: ${value}`
  const pattern = new RegExp(`(^|;)\\s*${escapedProperty}\\s*:[^;]*`, 'i')
  const nextStyle = pattern.test(style)
    ? style.replace(pattern, (_, prefix: string) => `${prefix}${declaration}`)
    : `${style.trim().replace(/;$/, '')}${style.trim() ? '; ' : ''}${declaration}`

  element.setAttribute('style', nextStyle)
}

function setSvgFallbackStyle(element: Element, property: string, value: string) {
  if (element.hasAttribute(property)) return
  setSvgStyle(element, property, value, false)
}

function normalizeMermaidSvg(svg: string, lineColor: string) {
  if (typeof DOMParser === 'undefined' || typeof XMLSerializer === 'undefined') {
    return svg
  }

  const parsed = new DOMParser().parseFromString(svg, 'image/svg+xml')
  if (parsed.querySelector('parsererror')) return svg

  const root = parsed.querySelector('svg')
  if (!root) return svg

  const metrics = parseSvgMetrics(svg)
  if (metrics) {
    root.setAttribute('width', formatSvgDimension(metrics.width))
    root.setAttribute('height', formatSvgDimension(metrics.height))
  }

  root.setAttribute('preserveAspectRatio', 'xMidYMid meet')
  setSvgStyle(root, 'display', 'block')
  setSvgStyle(root, 'max-width', 'none')
  setSvgStyle(root, 'height', metrics ? `${formatSvgDimension(metrics.height)}px` : 'auto')
  setSvgStyle(root, 'background', 'transparent')
  setSvgStyle(root, 'overflow', 'visible')

  root
    .querySelectorAll('[data-edge="true"], .flowchart-link, .edgePath .path')
    .forEach((edge) => {
      setSvgFallbackStyle(edge, 'stroke', lineColor)
      setSvgFallbackStyle(edge, 'stroke-width', '1.6px')
      setSvgFallbackStyle(edge, 'fill', 'none')
      setSvgStyle(edge, 'vector-effect', 'non-scaling-stroke')
    })

  root
    .querySelectorAll('.marker, .arrowMarkerPath, marker path')
    .forEach((marker) => {
      setSvgFallbackStyle(marker, 'fill', lineColor)
      setSvgFallbackStyle(marker, 'stroke', lineColor)
    })

  return new XMLSerializer().serializeToString(root)
}

function clampZoom(value: number) {
  return Math.min(MAX_PREVIEW_ZOOM, Math.max(MIN_PREVIEW_ZOOM, value))
}

function calculateFitZoom(metrics: SvgMetrics, viewport: HTMLElement | null) {
  if (!viewport) return 1

  const viewportWidth = viewport.clientWidth
  const viewportHeight = viewport.clientHeight
  if (viewportWidth <= 0 || viewportHeight <= 0) return 1

  const availableWidth = Math.max(1, viewportWidth - PREVIEW_FIT_PADDING)
  const availableHeight = Math.max(1, viewportHeight - PREVIEW_FIT_PADDING)
  return clampZoom(Math.min(1, availableWidth / metrics.width, availableHeight / metrics.height))
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
  const theme = useUIStore((state) => state.theme)
  const containerRef = useRef<HTMLDivElement>(null)
  const previewViewportRef = useRef<HTMLDivElement>(null)
  const previewContentRef = useRef<HTMLDivElement>(null)
  const dragStateRef = useRef<DragState | null>(null)
  const [svg, setSvg] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [previewOpen, setPreviewOpen] = useState(false)
  const [previewZoom, setPreviewZoom] = useState(1)
  const [previewFitMode, setPreviewFitMode] = useState(true)
  const [isDraggingPreview, setIsDraggingPreview] = useState(false)
  const [inlineViewportWidth, setInlineViewportWidth] = useState(0)

  const svgMetrics = svg ? parseSvgMetrics(svg) : null
  const sanitizedSvg = useMemo(() => (svg ? sanitizeMermaidSvg(svg) : null), [svg])
  const inlineZoom = svgMetrics && inlineViewportWidth > 0
    ? clampZoom(Math.min(1, Math.max(1, inlineViewportWidth - 32) / svgMetrics.width))
    : 1

  const inlineFrameStyle = svgMetrics
    ? {
        position: 'relative' as const,
        width: `${svgMetrics.width * inlineZoom}px`,
        height: `${svgMetrics.height * inlineZoom}px`,
      }
    : undefined
  const inlineCanvasStyle = svgMetrics
    ? {
        position: 'absolute' as const,
        left: 0,
        top: 0,
        width: `${svgMetrics.width}px`,
        height: `${svgMetrics.height}px`,
        transform: `scale(${inlineZoom})`,
        transformOrigin: 'top left',
      }
    : undefined

  useEffect(() => {
    let cancelled = false
    const { lineColor } = initMermaid(theme)

    const id = `mermaid-${++mermaidIdCounter}`
    const renderCode = normalizeGeneratedFlowchartSyntax(code)

    mermaid.render(id, renderCode).then(
      ({ svg: renderedSvg }) => {
        if (!cancelled) {
          setSvg(normalizeMermaidSvg(renderedSvg, lineColor))
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
  }, [code, theme])

  useLayoutEffect(() => {
    const container = containerRef.current
    if (!container) return undefined

    const updateInlineWidth = () => setInlineViewportWidth(container.clientWidth)
    updateInlineWidth()

    if (typeof ResizeObserver === 'undefined') return undefined

    const resizeObserver = new ResizeObserver(updateInlineWidth)
    resizeObserver.observe(container)
    return () => resizeObserver.disconnect()
  }, [svg])

  const handlePreview = useCallback(() => setPreviewOpen(true), [])
  const handlePreviewClose = useCallback(() => setPreviewOpen(false), [])
  const applyPreviewFit = useCallback(() => {
    if (!svgMetrics) return
    setPreviewZoom(calculateFitZoom(svgMetrics, previewViewportRef.current))
  }, [svgMetrics])
  const setPreviewZoomAroundCenter = useCallback((nextZoom: number) => {
    const viewport = previewViewportRef.current
    const previousZoom = previewZoom
    const clampedZoom = clampZoom(nextZoom)

    if (!viewport || previousZoom <= 0) {
      setPreviewZoom(clampedZoom)
      return
    }

    const sourceCenterX = (viewport.scrollLeft + viewport.clientWidth / 2) / previousZoom
    const sourceCenterY = (viewport.scrollTop + viewport.clientHeight / 2) / previousZoom
    setPreviewZoom(clampedZoom)

    window.requestAnimationFrame(() => {
      viewport.scrollLeft = Math.max(0, sourceCenterX * clampedZoom - viewport.clientWidth / 2)
      viewport.scrollTop = Math.max(0, sourceCenterY * clampedZoom - viewport.clientHeight / 2)
    })
  }, [previewZoom])
  const fitPreview = useCallback(() => {
    setPreviewFitMode(true)
    applyPreviewFit()
    const viewport = previewViewportRef.current
    if (viewport) {
      viewport.scrollLeft = 0
      viewport.scrollTop = 0
    }
  }, [applyPreviewFit])
  const zoomIn = useCallback(
    () => {
      setPreviewFitMode(false)
      setPreviewZoomAroundCenter(previewZoom + PREVIEW_ZOOM_STEP)
    },
    [previewZoom, setPreviewZoomAroundCenter],
  )
  const zoomOut = useCallback(
    () => {
      setPreviewFitMode(false)
      setPreviewZoomAroundCenter(previewZoom - PREVIEW_ZOOM_STEP)
    },
    [previewZoom, setPreviewZoomAroundCenter],
  )
  const resetZoom = useCallback(() => {
    setPreviewFitMode(false)
    setPreviewZoomAroundCenter(1)
  }, [setPreviewZoomAroundCenter])

  useEffect(() => {
    if (!previewOpen) {
      setPreviewZoom(1)
      setPreviewFitMode(true)
      setIsDraggingPreview(false)
      dragStateRef.current = null
    }
  }, [previewOpen, svg])

  useLayoutEffect(() => {
    if (!previewOpen || !svgMetrics || !previewFitMode) return undefined

    let animationFrame = window.requestAnimationFrame(applyPreviewFit)
    let resizeObserver: ResizeObserver | null = null
    const viewport = previewViewportRef.current

    if (viewport && typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(() => {
        if (!previewFitMode) return
        window.cancelAnimationFrame(animationFrame)
        animationFrame = window.requestAnimationFrame(applyPreviewFit)
      })
      resizeObserver.observe(viewport)
    }

    return () => {
      window.cancelAnimationFrame(animationFrame)
      resizeObserver?.disconnect()
    }
  }, [applyPreviewFit, previewFitMode, previewOpen, svgMetrics])

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

  const handlePreviewWheel = useCallback((event: React.WheelEvent<HTMLDivElement>) => {
    if (!event.ctrlKey && !event.metaKey) return

    event.preventDefault()
    const direction = event.deltaY < 0 ? PREVIEW_ZOOM_STEP : -PREVIEW_ZOOM_STEP
    setPreviewFitMode(false)
    setPreviewZoomAroundCenter(previewZoom + direction)
  }, [previewZoom, setPreviewZoomAroundCenter])

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

  const previewFrameStyle = svgMetrics
    ? {
        position: 'relative' as const,
        width: `${svgMetrics.width * previewZoom}px`,
        height: `${svgMetrics.height * previewZoom}px`,
      }
    : undefined
  const previewCanvasStyle = svgMetrics
    ? {
        position: 'absolute' as const,
        left: 0,
        top: 0,
        width: `${svgMetrics.width}px`,
        height: `${svgMetrics.height}px`,
        transform: `scale(${previewZoom})`,
        transformOrigin: 'top left',
        willChange: 'transform',
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
          data-testid="mermaid-diagram-surface"
          className="overflow-auto bg-[var(--color-surface-container-lowest)] p-4 cursor-pointer"
          style={{ maxHeight: 400 }}
          onClick={handlePreview}
        >
          <div className="mx-auto shrink-0 select-none" style={inlineFrameStyle}>
            <div
              style={inlineCanvasStyle}
              aria-label="Mermaid inline canvas"
              dangerouslySetInnerHTML={{ __html: sanitizedSvg ?? '' }}
            />
          </div>
        </div>
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
                  onClick={fitPreview}
                  aria-label="Fit diagram"
                  className="rounded-md px-2 py-1 text-[11px] font-semibold text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)]"
                >
                  Fit
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
            className="overflow-auto rounded-xl bg-[var(--color-surface-container-lowest)]"
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
                  className="mx-auto shrink-0 select-none"
                  style={previewFrameStyle}
                >
                  <div
                    ref={previewContentRef}
                    style={previewCanvasStyle}
                    data-dragging={isDraggingPreview ? 'true' : 'false'}
                    aria-label="Mermaid preview canvas"
                    dangerouslySetInnerHTML={{ __html: sanitizedSvg ?? '' }}
                  />
                </div>
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
