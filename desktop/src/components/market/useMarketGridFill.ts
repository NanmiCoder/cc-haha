import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * The catalogue grid, described once.
 *
 * The column count is deliberately not a breakpoint list: it is whatever
 * `repeat(auto-fill, …)` resolves to inside the container it lands in, which
 * is what lets a collapsed sidebar buy a whole column instead of just wider
 * cards, and what keeps a card from stretching to a 600px line length at 2-up.
 *
 * The skeleton has to predict that number to stand in for the content, so the
 * track floor and the gap live here as numbers and everything else is built
 * from them — the real grid, the placeholder grid, and the arithmetic below.
 * Held as separate literals (a style string, a Tailwind arbitrary class, a
 * breakpoint table) they drift apart silently: nothing fails, the placeholder
 * just stops matching what replaces it.
 */
export const CATALOG_COLUMN_FLOOR = 340
/** `EXTENSION_CARD_GRID`'s `gap-4`, so both tabs space their cards alike. */
export const CATALOG_GAP = 16
/** `SkillCard`'s `min-h-[200px]`. */
export const CATALOG_CARD_MIN_HEIGHT = 200

/**
 * `min(100%, …)` rather than the floor verbatim: the same bundle serves the
 * touch H5 shell, where a 340px track would overflow the viewport.
 */
export const CATALOG_GRID_TEMPLATE =
  `repeat(auto-fill,minmax(min(100%,${CATALOG_COLUMN_FLOOR}px),1fr))`

const ROW_HEIGHT = CATALOG_CARD_MIN_HEIGHT + CATALOG_GAP
/** Leaves the last placeholder row cut off by the fold rather than floating above it. */
const BOTTOM_GUTTER = 24
/** A page is 24 skills; promising more placeholders than can arrive is a lie. */
const MAX_CARDS = 24

/** What `repeat(auto-fill, minmax(FLOOR, 1fr))` resolves to at this width. */
export function catalogColumnsForWidth(width: number): number {
  return Math.max(1, Math.floor((width + CATALOG_GAP) / (CATALOG_COLUMN_FLOOR + CATALOG_GAP)))
}

/**
 * Measures the catalogue grid so the loading placeholder matches it.
 *
 * A fixed card count is wrong at both ends of the window range: six cards are
 * two rows, which on a wide desktop shell leaves most of the viewport blank
 * below them — the page reads as "finished loading, nearly empty" for as long
 * as the request takes.
 *
 * `measureRef` goes on the catalogue grid in whichever form is mounted — the
 * placeholder while the first page loads, the real grid afterwards. That is
 * what keeps `columns` right for the load-more row, which is drawn while the
 * real grid is the thing on screen.
 *
 * Measurement is driven by a callback ref rather than an effect because the
 * measured node only exists while its branch is mounted; an effect on the
 * parent runs when the parent mounts, which is a different moment entirely.
 */
export function useMarketGridFill() {
  const nodeRef = useRef<HTMLElement | null>(null)
  const [layout, setLayout] = useState({ columns: 1, count: 6 })

  const measure = useCallback(() => {
    if (typeof window === 'undefined') return
    const node = nodeRef.current
    if (!node) return
    const rect = node.getBoundingClientRect()
    const columns = catalogColumnsForWidth(rect.width)
    const rows = Math.max(1, Math.ceil((window.innerHeight - rect.top - BOTTOM_GUTTER) / ROW_HEIGHT))
    const count = Math.min(rows * columns, MAX_CARDS)
    setLayout((previous) =>
      previous.columns === columns && previous.count === count ? previous : { columns, count },
    )
  }, [])

  const measureRef = useCallback(
    (node: HTMLElement | null) => {
      nodeRef.current = node
      if (node) measure()
    },
    [measure],
  )

  useEffect(() => {
    if (typeof window === 'undefined') return
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [measure])

  return { measureRef, columns: layout.columns, count: layout.count }
}
