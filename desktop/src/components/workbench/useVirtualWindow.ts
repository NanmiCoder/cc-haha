import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react'

const DEFAULT_VIEWPORT_HEIGHT = 600

export type FixedVirtualWindowOptions = {
  itemCount: number
  itemHeight: number
  overscan?: number
  threshold?: number
  scrollRef: RefObject<HTMLElement | null>
  initialScrollTop?: number
}

export type FixedVirtualWindow = {
  virtualized: boolean
  startIndex: number
  endIndex: number
  topSpacer: number
  bottomSpacer: number
  onScroll: (scrollTop: number) => void
  ensureIndexVisible: (index: number) => void
}

/**
 * Lightweight fixed-height windowing for large workbench trees.
 *
 * Below `threshold` every item mounts normally so small trees and tests keep
 * their direct DOM layout; above `threshold` only the viewport plus `overscan`
 * mounts, using spacer padding so keyboard navigation and normal flow stay
 * intact without external virtual-scroll dependencies.
 */
export function useFixedVirtualWindow({
  itemCount,
  itemHeight,
  overscan = 15,
  threshold = 400,
  scrollRef,
  initialScrollTop = 0,
}: FixedVirtualWindowOptions): FixedVirtualWindow {
  const virtualized = itemCount > threshold
  const [scrollTop, setScrollTop] = useState(initialScrollTop)
  const [viewportHeight, setViewportHeight] = useState(DEFAULT_VIEWPORT_HEIGHT)

  useEffect(() => {
    setScrollTop(initialScrollTop)
  }, [initialScrollTop])

  useEffect(() => {
    if (!virtualized) return
    const element = scrollRef.current
    if (!element) return
    const measure = () => {
      if (element.clientHeight > 0) setViewportHeight(element.clientHeight)
    }
    measure()
    if (typeof ResizeObserver !== 'function') return
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [scrollRef, virtualized])

  const onScroll = useCallback((nextScrollTop: number) => {
    setScrollTop((prev) => (prev === nextScrollTop ? prev : nextScrollTop))
  }, [])

  const effectiveHeight = viewportHeight > 0 ? viewportHeight : DEFAULT_VIEWPORT_HEIGHT

  const ensureIndexVisible = useCallback((index: number) => {
    if (!virtualized || index < 0 || index >= itemCount) return
    const itemTop = index * itemHeight
    const itemBottom = itemTop + itemHeight
    const container = scrollRef.current
    const currentTop = container ? container.scrollTop : scrollTop
    let nextTop = currentTop
    if (itemTop < currentTop) {
      nextTop = itemTop
    } else if (itemBottom > currentTop + effectiveHeight) {
      nextTop = Math.max(0, itemBottom - effectiveHeight)
    }
    if (container && container.scrollTop !== nextTop) {
      container.scrollTop = nextTop
    }
    setScrollTop(nextTop)
  }, [effectiveHeight, itemCount, itemHeight, scrollRef, scrollTop, virtualized])

  if (!virtualized) {
    return {
      virtualized: false,
      startIndex: 0,
      endIndex: itemCount,
      topSpacer: 0,
      bottomSpacer: 0,
      onScroll,
      ensureIndexVisible,
    }
  }

  const maxScrollTop = Math.max(0, itemCount * itemHeight - effectiveHeight)
  const clampedScrollTop = Math.min(Math.max(0, scrollTop), maxScrollTop)
  const visibleCount = Math.max(1, Math.ceil(effectiveHeight / itemHeight))
  const rawStart = Math.floor(clampedScrollTop / itemHeight)
  const startIndex = Math.max(0, rawStart - overscan)
  const endIndex = Math.min(itemCount, rawStart + visibleCount + overscan)
  const topSpacer = startIndex * itemHeight
  const bottomSpacer = Math.max(0, (itemCount - endIndex) * itemHeight)

  return {
    virtualized: true,
    startIndex,
    endIndex,
    topSpacer,
    bottomSpacer,
    onScroll,
    ensureIndexVisible,
  }
}

export type VariableVirtualWindowOptions = {
  keys: readonly string[]
  estimateHeight: (index: number) => number
  gap?: number
  overscan?: number
  threshold?: number
  scrollRef: RefObject<HTMLElement | null>
}

export type VariableVirtualWindow = {
  virtualized: boolean
  startIndex: number
  endIndex: number
  topSpacer: number
  bottomSpacer: number
  onScroll: (scrollTop: number) => void
  measureItem: (key: string, node: HTMLElement | null) => void
  scrollToIndex: (index: number) => void
}

function lowerBound(offsets: readonly number[], value: number): number {
  let low = 0
  let high = offsets.length - 1
  while (low < high) {
    const mid = (low + high) >>> 1
    if ((offsets[mid] ?? 0) < value) low = mid + 1
    else high = mid
  }
  return low
}

/**
 * Lightweight variable-height sliding window for large diff review card stacks.
 *
 * Keeps each rendered section as a direct child of the scroll container so
 * `position: sticky` headers continue pinning against the scroll box while
 * bounding both mounted DOM sections and active observers.
 */
export function useVariableVirtualWindow({
  keys,
  estimateHeight,
  gap = 12,
  overscan = 6,
  threshold = 80,
  scrollRef,
}: VariableVirtualWindowOptions): VariableVirtualWindow {
  const virtualized = keys.length > threshold
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportHeight, setViewportHeight] = useState(DEFAULT_VIEWPORT_HEIGHT)
  const [measureVersion, setMeasureVersion] = useState(0)
  const measuredHeights = useRef(new Map<string, number>())

  useEffect(() => {
    if (!virtualized) return
    const element = scrollRef.current
    if (!element) return
    const measure = () => {
      if (element.clientHeight > 0) setViewportHeight(element.clientHeight)
    }
    measure()
    if (typeof ResizeObserver !== 'function') return
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [scrollRef, virtualized])

  const onScroll = useCallback((nextScrollTop: number) => {
    setScrollTop((prev) => (prev === nextScrollTop ? prev : nextScrollTop))
  }, [])

  const measureItem = useCallback((itemKey: string, node: HTMLElement | null) => {
    if (!node) return
    const height = node.offsetHeight
    if (height <= 0) return
    const previous = measuredHeights.current.get(itemKey)
    if (previous !== undefined && Math.abs(previous - height) < 2) return
    measuredHeights.current.set(itemKey, height)
    setMeasureVersion((version) => version + 1)
  }, [])

  const layout = useMemo(() => {
    // Re-read measuredHeights when measureVersion bumps.
    void measureVersion
    const offsets = new Array<number>(keys.length + 1)
    offsets[0] = 0
    for (let index = 0; index < keys.length; index++) {
      const itemKey = keys[index]!
      const height = measuredHeights.current.get(itemKey) ?? estimateHeight(index)
      const stride = index < keys.length - 1 ? height + gap : height
      offsets[index + 1] = offsets[index]! + stride
    }
    return offsets
  }, [estimateHeight, gap, keys, measureVersion])

  const scrollToIndex = useCallback((index: number) => {
    if (!virtualized || index < 0 || index >= keys.length) return
    const targetTop = layout[index] ?? 0
    const container = scrollRef.current
    if (container && container.scrollTop !== targetTop) {
      container.scrollTop = targetTop
    }
    setScrollTop(targetTop)
  }, [keys.length, layout, scrollRef, virtualized])

  if (!virtualized) {
    return {
      virtualized: false,
      startIndex: 0,
      endIndex: keys.length,
      topSpacer: 0,
      bottomSpacer: 0,
      onScroll,
      measureItem,
      scrollToIndex,
    }
  }

  const totalHeight = layout[keys.length] ?? 0
  const effectiveHeight = viewportHeight > 0 ? viewportHeight : DEFAULT_VIEWPORT_HEIGHT
  const clampedScrollTop = Math.min(Math.max(0, scrollTop), Math.max(0, totalHeight - effectiveHeight))
  const firstVisible = Math.max(0, lowerBound(layout, clampedScrollTop) - 1)
  const lastVisible = Math.min(keys.length, lowerBound(layout, clampedScrollTop + effectiveHeight) + 1)
  const startIndex = Math.max(0, firstVisible - overscan)
  const endIndex = Math.min(keys.length, Math.max(firstVisible + 1, lastVisible + overscan))
  const topSpacer = startIndex > 0 ? Math.max(0, (layout[startIndex] ?? 0) - gap) : 0
  const bottomSpacer = endIndex < keys.length ? Math.max(0, totalHeight - (layout[endIndex] ?? totalHeight) - gap) : 0

  return {
    virtualized: true,
    startIndex,
    endIndex,
    topSpacer,
    bottomSpacer,
    onScroll,
    measureItem,
    scrollToIndex,
  }
}
