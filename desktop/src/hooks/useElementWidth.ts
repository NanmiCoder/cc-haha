import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * Tracks an element's rendered border-box width.
 *
 * Returns `null` — not `0` — until a real measurement lands. Callers need to
 * tell "not measured yet" apart from "measured as zero" so they can hold on to
 * whatever prop-driven default they started with instead of flashing a layout
 * that the first paint would immediately replace. jsdom has no ResizeObserver
 * and lays nothing out, so under test the width stays `null` and every caller
 * keeps its fallback.
 *
 * Measure a node whose own width does not depend on the decision it feeds:
 * observing an element that the resulting layout resizes turns the observer
 * into a feedback loop that oscillates across the threshold.
 */
export function useElementWidth<T extends HTMLElement>(): [(node: T | null) => void, number | null] {
  const [width, setWidth] = useState<number | null>(null)
  const nodeRef = useRef<T | null>(null)
  const observerRef = useRef<ResizeObserver | null>(null)

  const observeNode = useCallback((node: T | null) => {
    observerRef.current?.disconnect()
    observerRef.current = null
    if (!node) return

    const measure = () => {
      const next = node.offsetWidth
      setWidth(next > 0 ? next : null)
    }

    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    observerRef.current = observer
  }, [])

  const measuredRef = useCallback((node: T | null) => {
    nodeRef.current = node
    observeNode(node)
  }, [observeNode])

  useEffect(() => {
    // StrictMode replays effect setup after cleanup without reattaching the
    // callback ref. Reconnect to the retained node so future resizes arrive.
    if (!observerRef.current) observeNode(nodeRef.current)
    return () => {
      observerRef.current?.disconnect()
      observerRef.current = null
    }
  }, [observeNode])

  return [measuredRef, width]
}
