/** Start paging back when within this many screens of the earliest loaded content, so content is usually filled in before reaching the top. */
export const PREFETCH_SCREENS = 1.5
/**
 * Maximum batches auto-paged in a row in one drag. In sessions with many tool calls a whole batch often folds into the existing
 * "process" row with almost no height change, so the check keeps paging; cap it, and another drag by the user continues.
 */
export const AUTO_BATCH_LIMIT = 4

/**
 * Whether to page back a batch now. The message stream is an inverted list (starting at the newest), and toOldest is the distance from the top edge of the viewport to
 * the earliest loaded content: when content is shorter than a screen it is 0 and naturally fills; earlier content is appended at the end of the list 
 * without moving the reading position, so it can page early even while at the newest.
 */
export function shouldPrefetchOlder({
  viewport,
  content,
  toOldest,
  batches,
}: {
  viewport: number
  content: number
  toOldest: number
  batches: number
}) {
  if (!viewport || !content || batches >= AUTO_BATCH_LIMIT) return false
  return toOldest < viewport * PREFETCH_SCREENS
}
