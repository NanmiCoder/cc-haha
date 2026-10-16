import { useCallback, useEffect, useRef, useState } from 'react'

/** Gap kept between the overlay's top edge and the edge that would clip it. */
const EDGE_GAP = 8

const CLIPPING_OVERFLOW = /^(hidden|clip|auto|scroll)$/

/**
 * The nearest ancestor whose overflow clips `node`, or null for the window.
 *
 * Overflow between an absolutely positioned box and its containing block does
 * not clip it, so the search starts at the containing block.
 */
function clippingAncestor(node: HTMLElement): Element | null {
  const document = node.ownerDocument
  const view = document.defaultView
  for (let current = node.offsetParent; current && current !== document.body && current !== document.documentElement; current = current.parentElement) {
    if (view && CLIPPING_OVERFLOW.test(view.getComputedStyle(current).overflowY)) return current
  }
  return null
}

function sameRect(a: DOMRect, b: DOMRect): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height
}

/**
 * Calls `onMove` when `element` moves or the window resizes, until the returned
 * cleanup runs.
 *
 * Opening the bottom terminal pushes the composer up without resizing it or
 * the column that clips it, so no ResizeObserver hears it — yet every popover's
 * bottom edge moved with the composer. This is Floating UI's `observeMove` (the
 * `layoutShift` option of `autoUpdate`, MIT): an IntersectionObserver whose
 * root margin hugs the element's current rect, so any movement changes the
 * intersection ratio, and each change re-arms it around the new rect.
 */
function observeMove(element: Element, onMove: () => void): () => void {
  const document = element.ownerDocument
  const view = document.defaultView
  const root = document.documentElement
  let observer: IntersectionObserver | null = null
  let retry: ReturnType<typeof setTimeout> | undefined

  const disconnect = () => {
    clearTimeout(retry)
    observer?.disconnect()
    observer = null
  }

  const refresh = (skip = false, threshold = 1) => {
    disconnect()
    const rect = element.getBoundingClientRect()
    if (!skip) onMove()
    if (!view?.IntersectionObserver || !rect.width || !rect.height) return

    const rootMargin = [
      rect.top,
      root.clientWidth - rect.right,
      root.clientHeight - rect.bottom,
      rect.left,
    ].map((inset) => `${-Math.floor(inset)}px`).join(' ')
    let firstUpdate = true
    const handle = (entries: IntersectionObserverEntry[]) => {
      // The entry is a snapshot: if the element has moved since, its ratio
      // describes a stale rect and cannot detect the next movement.
      if (!sameRect(rect, element.getBoundingClientRect())) return refresh()
      const ratio = entries[0]?.intersectionRatio ?? 0
      if (ratio !== threshold) {
        if (!firstUpdate) return refresh()
        // Clipped in place reads as 0; retry slowly instead of looping.
        if (!ratio) retry = setTimeout(() => refresh(false, 1e-7), 1000)
        else refresh(false, ratio)
      }
      firstUpdate = false
    }
    const options = { rootMargin, threshold: Math.max(0, Math.min(1, threshold)) || 1 }
    try {
      // A document root keeps the margin relative to this frame inside an iframe.
      observer = new view.IntersectionObserver(handle, { ...options, root: document })
    } catch {
      observer = new view.IntersectionObserver(handle, options)
    }
    observer.observe(element)
  }

  const handleResize = () => refresh()
  view?.addEventListener('resize', handleResize)
  refresh(true)
  return () => {
    view?.removeEventListener('resize', handleResize)
    disconnect()
  }
}

/**
 * The height an overlay that opens upward (`absolute bottom-full`) can take
 * before it runs past the top of whatever clips it — the nearest ancestor that
 * hides overflow, or the window.
 *
 * The composer's popovers open upward with `vh` caps chosen when the composer
 * sat at the bottom of the window. A new session centres it, inside a page that
 * clips its overflow, and the slash menu lost its first rows and the top of its
 * scrollbar (#1587). Apply the result as the popover's `max-height` and let its
 * scrolling body shrink; the `vh` cap stays the upper bound.
 *
 * `bottom-full` pins the overlay's bottom edge, so capping its height never
 * moves the edge it is measured from. `undefined` until measured — and under
 * jsdom, which lays nothing out — so the CSS cap applies alone.
 */
export function useRoomAbove<T extends HTMLElement>(): [(node: T | null) => void, number | undefined] {
  const [room, setRoom] = useState<number>()
  const nodeRef = useRef<T | null>(null)
  const cleanupRef = useRef<(() => void) | null>(null)

  const watchNode = useCallback((node: T | null) => {
    cleanupRef.current?.()
    cleanupRef.current = null
    const view = node?.ownerDocument.defaultView
    if (!node || !view) return

    const clip = clippingAncestor(node)
    const measure = () => {
      const top = Math.max(0, clip?.getBoundingClientRect().top ?? 0)
      const next = Math.max(0, Math.floor(node.getBoundingClientRect().bottom - top - EDGE_GAP))
      setRoom((current) => (current === next ? current : next))
    }

    measure()
    // The room changes when the window does, when the composer grows (a second
    // line, an attachment) or moves (a bottom panel opening under it), or when
    // the clipping page is resized.
    const stopWatchingMoves = observeMove(node.offsetParent ?? node, measure)
    const observer = view.ResizeObserver ? new view.ResizeObserver(measure) : null
    if (node.offsetParent) observer?.observe(node.offsetParent)
    if (clip) observer?.observe(clip)
    cleanupRef.current = () => {
      stopWatchingMoves()
      observer?.disconnect()
    }
  }, [])

  const measuredRef = useCallback((node: T | null) => {
    nodeRef.current = node
    watchNode(node)
  }, [watchNode])

  useEffect(() => {
    // StrictMode replays effect setup after cleanup without reattaching the
    // callback ref. Re-watch the retained node so later resizes still arrive.
    if (!cleanupRef.current) watchNode(nodeRef.current)
    return () => {
      cleanupRef.current?.()
      cleanupRef.current = null
    }
  }, [watchNode])

  return [measuredRef, room]
}
