import { useCallback, useEffect, useRef, useState } from 'react'

/** Rows mounted when a list opens, and added each time the reader nears its end. */
export const REVEAL_PAGE_SIZE = 40
/** Mount the next page while its rows are still this far below the fold. */
const REVEAL_PREFETCH_MARGIN = '0px 0px 480px 0px'

/**
 * Mounts a long, newest-first list one page at a time.
 *
 * A team's communication history keeps growing for the whole run and every
 * text row renders Markdown, so mounting all of it on open stalled the click:
 * 553 messages took ~250ms and ~13k DOM nodes, and the workbench's one-second
 * clock re-rendered every one of those rows while the panel stayed open.
 * Rows below the fold now mount as the reader scrolls toward them; counts shown
 * elsewhere keep describing the whole list, and find-in-page reaches unmounted
 * rows through `useTranscriptFind`.
 *
 * `resetKey` starts over from the first page when the list changes meaning
 * (another filter, another member), not when it merely grows.
 */
export function useProgressiveReveal(total: number, resetKey: string) {
  const [revealed, setRevealed] = useState({ key: resetKey, limit: REVEAL_PAGE_SIZE })
  // Reset during render rather than only reading a default, so returning to a
  // list seen earlier also starts from its first page.
  if (revealed.key !== resetKey) setRevealed({ key: resetKey, limit: REVEAL_PAGE_SIZE })
  const limit = revealed.key === resetKey ? revealed.limit : REVEAL_PAGE_SIZE
  const hasMore = total > limit
  const scrollRootRef = useRef<HTMLDivElement | null>(null)
  const sentinelRef = useRef<HTMLDivElement | null>(null)
  /**
   * Every shell this runs in has the observer; without it (or in a test) the
   * caller renders a button instead, so the list can still be paged through
   * rather than silently ending at the first page.
   */
  const [canAutoReveal] = useState(() => typeof IntersectionObserver === 'function')

  const showMore = useCallback(() => {
    setRevealed((current) => ({
      key: resetKey,
      limit: (current.key === resetKey ? current.limit : REVEAL_PAGE_SIZE) + REVEAL_PAGE_SIZE,
    }))
  }, [resetKey])
  /** Mount whole pages up to and including the row at `index` (find jumps there). */
  const revealThrough = useCallback((index: number) => {
    const needed = (Math.floor(index / REVEAL_PAGE_SIZE) + 1) * REVEAL_PAGE_SIZE
    setRevealed((current) => {
      const currentLimit = current.key === resetKey ? current.limit : REVEAL_PAGE_SIZE
      return currentLimit >= needed ? current : { key: resetKey, limit: needed }
    })
  }, [resetKey])

  useEffect(() => {
    if (!canAutoReveal || !hasMore) return
    const sentinel = sentinelRef.current
    if (!sentinel) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) showMore()
      },
      { root: scrollRootRef.current, rootMargin: REVEAL_PREFETCH_MARGIN },
    )
    observer.observe(sentinel)
    return () => observer.disconnect()
    // Re-observing after each page is what keeps a tall pane filling: an
    // observer only reports changes, so a sentinel still in range after one
    // page would otherwise never ask for the next.
  }, [canAutoReveal, hasMore, limit, showMore])

  return { limit, hasMore, showMore, revealThrough, canAutoReveal, scrollRootRef, sentinelRef }
}
