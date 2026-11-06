/**
 * Anchoring a chat annotation back onto the exact text the user selected.
 *
 * The transcript is rendered by `MarkdownRenderer`, so nothing in the message
 * subtree is ours to wrap. Instead we keep the annotation as a text offset into
 * the message's concatenated text, resolve that back to a `Range` at paint time,
 * and let the message component draw the mark as its own absolutely positioned
 * overlay. Nothing here touches the DOM.
 */

export type TextAnchor = {
  quote: string
  startOffset?: number
  endOffset?: number
}

export type AnnotationRect = {
  left: number
  top: number
  width: number
  height: number
}

type TextSegment = {
  node: Text
  start: number
  end: number
}

function collectTextSegments(root: Node): TextSegment[] {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  const segments: TextSegment[] = []
  let offset = 0
  let current = walker.nextNode()
  while (current) {
    const node = current as Text
    const end = offset + node.data.length
    segments.push({ node, start: offset, end })
    offset = end
    current = walker.nextNode()
  }
  return segments
}

/**
 * A DOM boundary point (`startContainer`/`startOffset`) is either a position in
 * a text node or a child index inside an element. Both map onto the same
 * concatenated-text coordinate the anchor is stored in.
 */
function textOffsetForPoint(segments: TextSegment[], container: Node, offset: number): number | null {
  if (container.nodeType === Node.TEXT_NODE) {
    const segment = segments.find((candidate) => candidate.node === container)
    if (!segment) return null
    return segment.start + Math.min(offset, segment.node.data.length)
  }

  const children = container.childNodes
  for (let index = offset; index < children.length; index += 1) {
    const child = children[index]!
    const segment = segments.find((candidate) => child === candidate.node || child.contains(candidate.node))
    if (segment) return segment.start
  }

  // No text follows the point inside this container, so it sits at the end of
  // whatever text the container holds.
  const contained = segments.filter((segment) => container.contains(segment.node))
  const last = contained[contained.length - 1]
  return last ? last.end : null
}

function rangeFromTextOffsets(segments: TextSegment[], start: number, end: number): Range | null {
  let startNode: Text | null = null
  let startOffset = 0
  let endNode: Text | null = null
  let endOffset = 0

  for (const segment of segments) {
    if (!startNode && start < segment.end) {
      startNode = segment.node
      startOffset = start - segment.start
    }
    if (end <= segment.end) {
      endNode = segment.node
      endOffset = end - segment.start
      break
    }
  }

  if (!startNode || !endNode) return null
  const range = document.createRange()
  range.setStart(startNode, Math.max(0, startOffset))
  range.setEnd(endNode, Math.max(0, endOffset))
  return range
}

/** Concatenated-text offsets of a selection, for storing on the annotation. */
export function getTextOffsetForRange(root: HTMLElement, range: Range): { start: number; end: number } | null {
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return null
  const segments = collectTextSegments(root)
  if (segments.length === 0) return null

  const start = textOffsetForPoint(segments, range.startContainer, range.startOffset)
  const end = textOffsetForPoint(segments, range.endContainer, range.endOffset)
  if (start === null || end === null || end <= start) return null
  return { start, end }
}

/**
 * Resolve a stored anchor back to a live range. Offsets are exact and are tried
 * first — they are the only way to tell two identical quotes in one message
 * apart. A quote search is the fallback for anchors captured without offsets and
 * for messages whose text shifted since capture.
 */
export function getRangeForAnnotation(root: HTMLElement, anchor: TextAnchor): Range | null {
  const segments = collectTextSegments(root)
  if (segments.length === 0) return null

  const full = segments.map((segment) => segment.node.data).join('')
  const quote = anchor.quote.trim()
  if (!quote) return null

  const candidates: Array<{ start: number; end: number }> = []
  if (anchor.startOffset !== undefined && anchor.endOffset !== undefined) {
    candidates.push({ start: anchor.startOffset, end: anchor.endOffset })
  }
  const searchStart = full.indexOf(quote)
  if (searchStart >= 0) candidates.push({ start: searchStart, end: searchStart + quote.length })

  for (const candidate of candidates) {
    if (candidate.start < 0 || candidate.end > full.length) continue
    if (full.slice(candidate.start, candidate.end).trim() !== quote) continue
    const range = rangeFromTextOffsets(segments, candidate.start, candidate.end)
    if (range) return range
  }
  return null
}

/**
 * Viewport rects of a range expressed relative to the message container, which
 * is what the overlay layer inside that container is positioned against. Rects
 * are only recomputed when the container's contents change size, so the overlay
 * rides along with scrolling for free.
 */
export function getAnnotationRects(root: HTMLElement, range: Range): AnnotationRect[] {
  const rootRect = root.getBoundingClientRect()
  // No layout to read (jsdom, or a detached node): paint nothing rather than throw.
  const clientRects = typeof range.getClientRects === 'function' ? Array.from(range.getClientRects()) : []
  return clientRects
    // Browsers report empty line boxes as zero-area rects; they would paint a
    // stray 1px sliver at the start of the next line.
    .filter((rect) => rect.width > 0 && rect.height > 0)
    .map((rect) => ({
      left: rect.left - rootRect.left + root.scrollLeft,
      top: rect.top - rootRect.top + root.scrollTop,
      width: rect.width,
      height: rect.height,
    }))
}

/** Diameter of the numbered badge; shared with the styles that draw it. */
export const ANNOTATION_BADGE_SIZE = 15

export type AnnotationLayout = {
  rects: AnnotationRect[]
  /** Top-left corner of the badge, in the same container-relative space as `rects`. */
  badge: { left: number; top: number }
}

/**
 * Where one annotation paints inside the message container. The badge rides the
 * end of the last painted line and is raised so it reads as a superscript
 * rather than as a character of the message.
 */
export function getAnnotationLayout(root: HTMLElement, anchor: TextAnchor): AnnotationLayout | null {
  const range = getRangeForAnnotation(root, anchor)
  if (!range) return null

  const rects = getAnnotationRects(root, range)
  const last = rects[rects.length - 1]
  if (!last) return null

  return {
    rects,
    badge: {
      left: last.left + last.width - 3,
      top: last.top - 9,
    },
  }
}
