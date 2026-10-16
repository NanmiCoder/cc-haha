export type VerticalPlacement = {
  direction: 'up' | 'down'
  /** Viewport y of the overlay's edge that touches the anchor: its top when `down`, its bottom when `up`. */
  edge: number
  /** The most height the overlay can take on that side without leaving the viewport. */
  maxHeight: number
}

type Options = {
  viewportHeight: number
  /** Height the overlay wants; it opens downward when that much fits below. */
  preferredHeight: number
  /** Space between the anchor and the overlay. */
  gap: number
  /** Space kept between the overlay and the viewport edge. */
  margin: number
  /** Floor for `maxHeight`, so a very short window still shows a few rows. */
  minHeight?: number
}

/**
 * Picks the side of a fixed-position overlay's anchor and the height it may use.
 *
 * Choosing a side is not enough: when neither side fits the preferred height
 * the larger one still ends at the window edge, and the overlay's own
 * `max-height` (taller than that) lets it run past it. Applying `maxHeight`
 * lets its scrolling list shrink to the room that is there.
 */
export function resolveVerticalPlacement(
  anchor: { top: number; bottom: number },
  { viewportHeight, preferredHeight, gap, margin, minHeight = 0 }: Options,
): VerticalPlacement {
  const spaceBelow = viewportHeight - anchor.bottom - gap - margin
  const spaceAbove = anchor.top - gap - margin
  const direction = spaceBelow >= preferredHeight || spaceBelow >= spaceAbove ? 'down' : 'up'
  const room = direction === 'down' ? spaceBelow : spaceAbove
  return {
    direction,
    edge: direction === 'down' ? anchor.bottom + gap : anchor.top - gap,
    maxHeight: Math.max(minHeight, Math.floor(room)),
  }
}
