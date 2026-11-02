// Search core shared by the find bar and the surfaces that register a find
// controller with it: walk visible text nodes and mark matches with the CSS
// Custom Highlight API (Range-based, no DOM mutation → React-safe).

export const MAX_FIND_MATCHES = 1_000
export const FIND_RESULTS_HIGHLIGHT = 'cc-find-results'
export const FIND_ACTIVE_HIGHLIGHT = 'cc-find-active'
// Subtrees never searched: sidebar, tab bar, the find bar, non-content tags.
const SKIP_CLOSEST = '.sidebar-panel, [data-testid="tab-bar"], [data-find-bar], script, style, noscript'

/**
 * Walk visible text nodes outside skipped subtrees; return a Range per
 * case-insensitive match. `skip` adds selectors whose subtrees the caller
 * searches some other way.
 */
export function collectFindRanges(q: string, roots: ParentNode[], skip?: string): Range[] {
  const ranges: Range[] = []
  const needle = q.toLowerCase()
  const skipClosest = skip ? `${SKIP_CLOSEST}, ${skip}` : SKIP_CLOSEST
  for (const root of roots) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const parent = node.parentElement
        if (!parent || !node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT
        if (parent.closest(skipClosest)) return NodeFilter.FILTER_REJECT
        if (parent.closest('[hidden], [aria-hidden="true"], .hidden, .invisible')) return NodeFilter.FILTER_REJECT
        return NodeFilter.FILTER_ACCEPT
      },
    })
    let textNode = walker.nextNode() as Text | null
    while (textNode) {
      const text = textNode.nodeValue!.toLowerCase()
      let idx = text.indexOf(needle)
      while (idx !== -1 && ranges.length < MAX_FIND_MATCHES) {
        const range = document.createRange()
        range.setStart(textNode, idx)
        range.setEnd(textNode, idx + needle.length)
        ranges.push(range)
        idx = text.indexOf(needle, idx + needle.length)
      }
      if (ranges.length >= MAX_FIND_MATCHES) return ranges
      textNode = walker.nextNode() as Text | null
    }
  }
  return ranges
}

/** Register CSS highlights for all matches + the active one, and scroll the active into view. */
export function paintFindHighlights(ranges: Range[], activeIndex: number) {
  const highlights = (CSS as any).highlights as Map<string, unknown> | undefined
  const HighlightCtor = (globalThis as any).Highlight
  if (highlights && HighlightCtor) {
    const results = new HighlightCtor()
    for (const r of ranges) results.add(r)
    highlights.set(FIND_RESULTS_HIGHLIGHT, results)
    const active = ranges[activeIndex]
    if (active) {
      const activeHl = new HighlightCtor()
      activeHl.add(active)
      activeHl.priority = 1 // paint over the results highlight
      highlights.set(FIND_ACTIVE_HIGHLIGHT, activeHl)
    } else {
      highlights.delete(FIND_ACTIVE_HIGHLIGHT)
    }
  }
  ranges[activeIndex]?.startContainer.parentElement?.scrollIntoView({ block: 'center', behavior: 'smooth' })
}

export function clearFindHighlights() {
  const highlights = (globalThis.CSS as any)?.highlights as Map<string, unknown> | undefined
  highlights?.delete(FIND_RESULTS_HIGHLIGHT)
  highlights?.delete(FIND_ACTIVE_HIGHLIGHT)
}
