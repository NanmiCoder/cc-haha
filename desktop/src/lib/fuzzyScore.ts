/**
 * Tiny fuzzy matcher for the project picker — subsequence matching with
 * bonuses for consecutive runs, word boundaries and prefix hits, in the
 * spirit of fzf/Sublime. Kept deliberately small: the candidate set is the
 * user's project list (≤500 entries), so an O(query·candidate) walk per
 * candidate is more than fast enough.
 */

const NO_MATCH = -1

function isBoundaryChar(char: string | undefined): boolean {
  return char === '/' || char === '-' || char === '_' || char === '.' || char === ' '
}

/**
 * Returns a score > 0 when every character of `query` appears in `candidate`
 * in order (case-insensitive), -1 otherwise. Higher = better.
 */
export function fuzzyScore(query: string, candidate: string): number {
  const q = query.trim().toLowerCase()
  if (q.length === 0) return 0
  const c = candidate.toLowerCase()

  let score = 0
  let qi = 0
  let consecutive = 0
  for (let ci = 0; ci < c.length && qi < q.length; ci++) {
    if (c[ci] !== q[qi]) {
      consecutive = 0
      continue
    }
    score += 1
    consecutive += 1
    if (consecutive > 1) score += 10
    const prev = ci > 0 ? c[ci - 1] : undefined
    if (ci === 0 || isBoundaryChar(prev)) score += 15
    else if (c[ci] !== candidate[ci]) score += 15 // camelCase hump (lowercase differs from original)
    if (ci === qi) score += 8 // matched at/near the prefix
    qi++
  }
  return qi === q.length ? score : NO_MATCH
}

/**
 * Filters and ranks `items` by `query`. `keys` returns the candidate strings
 * for an item (e.g. label + path); the best per-item score wins. Empty query
 * returns the input unchanged, preserving the caller's ordering.
 */
export function fuzzyFilter<T>(items: T[], query: string, keys: (item: T) => Array<string | null | undefined>): T[] {
  const q = query.trim()
  if (q.length === 0) return items
  const scored: Array<{ item: T; score: number; index: number }> = []
  for (let index = 0; index < items.length; index++) {
    const item = items[index]
    if (item === undefined) continue
    let best = NO_MATCH
    for (const key of keys(item)) {
      if (!key) continue
      const s = fuzzyScore(q, key)
      if (s > best) best = s
    }
    if (best !== NO_MATCH) scored.push({ item, score: best, index })
  }
  // Stable on equal scores so the original recency order survives.
  scored.sort((a, b) => b.score - a.score || a.index - b.index)
  return scored.map((entry) => entry.item)
}
