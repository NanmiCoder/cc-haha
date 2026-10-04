import { useCallback, useEffect, useState, type RefObject } from 'react'

export type FixedRowWindow = { start: number; end: number; scrollTop: number }

export type ScrollAlign = 'nearest' | 'center' | 'end' | 'offset'

/** Pure range math, exported for tests. */
export function computeFixedRowWindow(
  scrollTop: number,
  viewportHeight: number,
  rowHeight: number,
  count: number,
  overscan: number,
): Omit<FixedRowWindow, 'scrollTop'> {
  if (count <= 0 || rowHeight <= 0) return { start: 0, end: 0 }
  const first = Math.floor(Math.max(0, scrollTop) / rowHeight)
  const visible = Math.ceil(Math.max(0, viewportHeight) / rowHeight) + 1
  const start = Math.max(0, Math.min(count, first - overscan))
  const end = Math.max(start, Math.min(count, first + visible + overscan))
  return { start, end }
}

/** First and last fully or partly visible index, without overscan. */
export function visibleRange(scrollTop: number, viewportHeight: number, rowHeight: number, count: number): { first: number; last: number } {
  if (count <= 0) return { first: 0, last: -1 }
  const first = Math.min(count - 1, Math.floor(Math.max(0, scrollTop) / rowHeight))
  const last = Math.min(count - 1, Math.max(first, Math.ceil((Math.max(0, scrollTop) + Math.max(0, viewportHeight)) / rowHeight) - 1))
  return { first, last }
}

/**
 * Windowing for a list whose rows all share one height. No measurement is
 * needed, so this stays a few lines instead of a virtualization library
 * (components/AGENTS.md rules those out).
 */
export function useFixedRowWindow(
  containerRef: RefObject<HTMLElement | null>,
  options: { count: number; rowHeight: number; overscan?: number; enabled?: boolean },
): FixedRowWindow & { viewportHeight: number; scrollToIndex: (index: number, align?: ScrollAlign, offset?: number) => void } {
  const { count, rowHeight, overscan = 12, enabled = true } = options
  const [viewport, setViewport] = useState({ scrollTop: 0, height: 0 })

  useEffect(() => {
    const element = containerRef.current
    if (!element || !enabled) return
    let frame = 0
    const read = () => {
      frame = 0
      setViewport((previous) => (
        previous.scrollTop === element.scrollTop && previous.height === element.clientHeight
          ? previous
          : { scrollTop: element.scrollTop, height: element.clientHeight }
      ))
    }
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(read)
    }
    read()
    element.addEventListener('scroll', schedule, { passive: true })
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule)
    observer?.observe(element)
    return () => {
      element.removeEventListener('scroll', schedule)
      observer?.disconnect()
      if (frame) cancelAnimationFrame(frame)
    }
  }, [containerRef, enabled])

  const scrollToIndex = useCallback((index: number, align: ScrollAlign = 'nearest', offset = 0) => {
    const element = containerRef.current
    if (!element || index < 0) return
    const top = index * rowHeight
    const bottom = top + rowHeight
    const height = element.clientHeight
    let next: number | null = null
    if (align === 'center') next = top - Math.max(0, (height - rowHeight) / 2)
    // Keep the row at the same distance from the viewport top it had before (prepend anchoring).
    else if (align === 'offset') next = top - offset
    else if (align === 'end') next = bottom - height
    else if (top < element.scrollTop) next = top
    else if (bottom > element.scrollTop + height) next = bottom - height
    if (next !== null) element.scrollTop = Math.max(0, next)
  }, [containerRef, rowHeight])

  return {
    ...computeFixedRowWindow(viewport.scrollTop, viewport.height || 600, rowHeight, count, overscan),
    scrollTop: viewport.scrollTop,
    viewportHeight: viewport.height || 600,
    scrollToIndex,
  }
}
