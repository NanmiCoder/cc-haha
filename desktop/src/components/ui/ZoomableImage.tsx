import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react'

import { useElementSize } from '@/hooks/useElementSize'
import { cx } from '@/lib/cx'
import {
  ZOOM_MAX,
  ZOOM_MIN,
  anchoredScroll,
  continuesDoublePress,
  fitScale,
  stepZoom,
  wheelZoom,
  zoomPercent,
  type Press,
} from '@/lib/zoomPan'
import { ZoomControls, floatingPillClass, type ZoomControlsLabels } from './ZoomControls'

/** `'fit'` shows the whole image; a number is a scale against its natural size. */
export type ImageZoom = 'fit' | number

export type ZoomableImageProps = {
  src: string
  alt: string
  /** Caller-supplied so this primitive never carries user-visible text of its own. */
  labels: ZoomControlsLabels
  /**
   * Extra controls beside the zoom cluster — "Open in system app", for one. Pass
   * bare `IconButton`s (with this `surface`): they are wrapped in the same
   * floating pill as the zoom cluster.
   */
  actions?: ReactNode
  /** Controlled zoom. Omit it and the component keeps its own. */
  zoom?: ImageZoom
  defaultZoom?: ImageZoom
  onZoomChange?: (zoom: ImageZoom) => void
  /**
   * Where to scroll once the picture has its size — the position it was left at. A
   * zoomed picture has nothing to scroll until it is laid out at that zoom, so a host
   * that restores earlier is clamped to 0 and then records the 0. Giving this marks
   * the scroll area `deferred`, which tells such a host to leave the restoring here.
   */
  initialScroll?: { left: number; top: number }
  onError?: () => void
  /** `media` on the dark lightbox, `default` on a panel. */
  surface?: 'default' | 'media' | 'lightbox'
  className?: string
}

/** Space kept clear around a fitted image, and inside the scroll area. */
const FIT_PADDING = 16

/**
 * An image you can look at closely: fit-to-window, − / + steps, Ctrl/⌘+wheel and
 * pinch zoom anchored under the pointer, drag to pan, double-click between fit and
 * 100%, and `+` `-` `0` `1` from the keyboard.
 *
 * Give it a `key` per image when one instance shows several: the natural size it
 * measures belongs to the picture, not to the component.
 */
export function ZoomableImage({
  src,
  alt,
  labels,
  actions,
  zoom: controlledZoom,
  defaultZoom = 'fit',
  onZoomChange,
  initialScroll,
  onError,
  surface = 'default',
  className,
}: ZoomableImageProps) {
  const media = surface !== 'default'
  const [ownZoom, setOwnZoom] = useState<ImageZoom>(defaultZoom)
  const zoom = controlledZoom ?? ownZoom
  const [natural, setNatural] = useState<{ width: number; height: number } | null>(null)
  const [sizeRef, size] = useElementSize<HTMLDivElement>()
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const imageRef = useRef<HTMLImageElement | null>(null)
  const pendingAnchor = useRef<{ anchorX: number; anchorY: number; oldScale: number } | null>(null)
  const drag = useRef<{ pointerId: number; x: number; y: number; left: number; top: number } | null>(null)
  const lastPress = useRef<Press | null>(null)
  const [panning, setPanning] = useState(false)

  const setScrollNode = useCallback((node: HTMLDivElement | null) => {
    scrollRef.current = node
    sizeRef(node)
  }, [sizeRef])

  const fit = natural && size
    ? fitScale({
        containerWidth: size.width,
        containerHeight: size.height,
        contentWidth: natural.width,
        contentHeight: natural.height,
        padding: FIT_PADDING,
      })
    : null
  // `null` means the scale cannot be computed yet (not loaded, not measured): the
  // image is then laid out by CSS, which approximates fit until it can be exact.
  const scale = zoom === 'fit' ? fit : zoom
  const currentScale = scale ?? 1

  const changeZoom = useCallback((next: ImageZoom, anchor?: { x: number; y: number }) => {
    const node = scrollRef.current
    if (node && typeof next === 'number') {
      pendingAnchor.current = {
        anchorX: anchor?.x ?? node.clientWidth / 2,
        anchorY: anchor?.y ?? node.clientHeight / 2,
        oldScale: currentScale,
      }
    }
    if (controlledZoom === undefined) setOwnZoom(next)
    onZoomChange?.(next)
  }, [controlledZoom, currentScale, onZoomChange])

  // Latest values for the native wheel listener, which is bound once.
  const latest = useRef({ changeZoom, currentScale })
  useLayoutEffect(() => {
    latest.current = { changeZoom, currentScale }
  })

  useEffect(() => {
    const node = scrollRef.current
    if (!node) return
    // Native and non-passive on purpose: React attaches `onWheel` as a passive
    // listener, where preventDefault is ignored — and a pinch would then zoom the
    // whole page as well as the image.
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return
      event.preventDefault()
      const rect = node.getBoundingClientRect()
      latest.current.changeZoom(
        wheelZoom(latest.current.currentScale, event.deltaY),
        { x: event.clientX - rect.left, y: event.clientY - rect.top },
      )
    }
    node.addEventListener('wheel', onWheel, { passive: false })
    return () => node.removeEventListener('wheel', onWheel)
  }, [])

  // The scroll offset only makes sense once the content has its new size, so the
  // anchor is applied after the scale that changed it has rendered.
  useLayoutEffect(() => {
    const pending = pendingAnchor.current
    const node = scrollRef.current
    if (!pending || !node || scale === null) return
    pendingAnchor.current = null
    const next = anchoredScroll({
      scrollLeft: node.scrollLeft,
      scrollTop: node.scrollTop,
      anchorX: pending.anchorX,
      anchorY: pending.anchorY,
      oldScale: pending.oldScale,
      newScale: scale,
    })
    node.scrollLeft = next.scrollLeft
    node.scrollTop = next.scrollTop
  }, [scale])

  useEffect(() => {
    // The load event can have fired before React attached its handler when the
    // image was already decoded, so read the size directly as well.
    const image = imageRef.current
    setNatural(image && image.complete && image.naturalWidth > 0
      ? { width: image.naturalWidth, height: image.naturalHeight }
      : null)
  }, [src])

  const sized = scale !== null && natural !== null
  const canPan = natural !== null && scale !== null && size !== null
    && (natural.width * scale + FIT_PADDING * 2 > size.width || natural.height * scale + FIT_PADDING * 2 > size.height)

  // Once, and only when the picture is laid out at its size: that is when there is
  // something to scroll to. After that the reader's own scrolling is not ours to undo.
  const restoredScroll = useRef(false)
  useLayoutEffect(() => {
    const node = scrollRef.current
    if (restoredScroll.current || !initialScroll || !sized || !node) return
    restoredScroll.current = true
    node.scrollLeft = initialScroll.left
    node.scrollTop = initialScroll.top
  }, [initialScroll, sized])

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.ctrlKey || event.metaKey || event.altKey) return
    if (event.key === '+' || event.key === '=') changeZoom(stepZoom(currentScale, 1))
    else if (event.key === '-' || event.key === '_') changeZoom(stepZoom(currentScale, -1))
    else if (event.key === '0') changeZoom('fit')
    else if (event.key === '1') changeZoom(1)
    else return
    event.preventDefault()
  }

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    // Two presses on this surface, not the `dblclick` event: see continuesDoublePress.
    const press = { time: event.timeStamp, x: event.clientX, y: event.clientY }
    if (continuesDoublePress(lastPress.current, press)) {
      lastPress.current = null
      changeZoom(zoom === 'fit' ? 1 : 'fit')
      return
    }
    lastPress.current = press

    const node = scrollRef.current
    if (!canPan || !node) return
    drag.current = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      left: node.scrollLeft,
      top: node.scrollTop,
    }
    node.setPointerCapture?.(event.pointerId)
    setPanning(true)
  }

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const node = scrollRef.current
    const active = drag.current
    if (!node || !active || active.pointerId !== event.pointerId) return
    node.scrollLeft = active.left - (event.clientX - active.x)
    node.scrollTop = active.top - (event.clientY - active.y)
  }

  const endPan = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (drag.current?.pointerId !== event.pointerId) return
    drag.current = null
    scrollRef.current?.releasePointerCapture?.(event.pointerId)
    setPanning(false)
  }

  return (
    <div className={cx('relative flex min-h-0 flex-1 flex-col', className)}>
      <div
        ref={setScrollNode}
        data-workspace-scroll-surface={initialScroll ? 'deferred' : ''}
        role="group"
        aria-label={alt}
        tabIndex={0}
        onKeyDown={onKeyDown}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endPan}
        onPointerCancel={endPan}
        className={cx(
          'min-h-0 flex-1 overflow-auto outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-border-focus)]',
          !media && 'bg-[var(--color-surface)]',
          canPan && (panning ? 'cursor-grabbing' : 'cursor-grab'),
        )}
      >
        {/* `m-auto` on the image, not `justify-center` on the row: centering by
            justification clips the start of an image wider than its container,
            where auto margins collapse to zero and let it scroll from the edge. */}
        <div className="flex min-h-full min-w-full p-4">
          <img
            ref={imageRef}
            src={src}
            alt={alt}
            draggable={false}
            onLoad={(event) => {
              const image = event.currentTarget
              // A picture that reports no size (an SVG with only a viewBox, in engines
              // that do not invent one) stays laid out by CSS, as it is before loading:
              // a 0×0 natural size would draw it as nothing.
              if (image.naturalWidth > 0 && image.naturalHeight > 0) {
                setNatural({ width: image.naturalWidth, height: image.naturalHeight })
              }
            }}
            onError={onError}
            style={sized ? { width: natural.width * scale, height: natural.height * scale, maxWidth: 'none' } : undefined}
            className={cx(
              'm-auto select-none rounded-[var(--radius-md)]',
              sized ? 'shrink-0' : 'max-h-full max-w-full object-contain',
              !media && 'border border-[var(--color-border)] bg-[var(--color-surface-container-lowest)] shadow-[var(--shadow-card)]',
            )}
          />
        </div>
      </div>

      <div className={surface === 'lightbox'
        ? 'pointer-events-none flex shrink-0 items-center justify-center gap-2 py-4'
        : 'pointer-events-none absolute bottom-3 right-3 flex items-center gap-2'}>
        <div className="pointer-events-auto flex items-center gap-2">
          <ZoomControls
            percent={zoomPercent(currentScale)}
            fitActive={zoom === 'fit'}
            canZoomIn={currentScale < ZOOM_MAX - 1e-3}
            canZoomOut={currentScale > ZOOM_MIN + 1e-3}
            onZoomIn={() => changeZoom(stepZoom(currentScale, 1))}
            onZoomOut={() => changeZoom(stepZoom(currentScale, -1))}
            onFit={() => changeZoom('fit')}
            labels={labels}
            surface={surface}
          />
          {actions ? <div className={floatingPillClass(surface)}>{actions}</div> : null}
        </div>
      </div>
    </div>
  )
}
