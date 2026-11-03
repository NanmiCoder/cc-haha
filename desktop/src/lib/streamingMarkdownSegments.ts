/**
 * Streamed Markdown, split into settled segments and a live tail.
 *
 * Rendering a streaming block as one Markdown document costs the whole block
 * on every delta: marked re-lexes all of it, DOMPurify re-sanitizes it and the
 * row's innerHTML is swapped out, so the work grows with the text for as long
 * as the stream runs. A long deliberation is re-parsed dozens of times a second
 * by the end, and the renderer thread has nothing left for a paste or a
 * keystroke (#1508).
 *
 * A settled segment never changes once it is cut, so a memoized renderer skips
 * it; only the live tail is parsed on each delta. Cuts land at a paragraph
 * break (a blank line) outside fenced code, so every settled segment is a run
 * of complete top-level blocks. Prose that runs past the maximum without a
 * blank line is cut at a line break instead: with marked's `breaks` option that
 * shows one paragraph as two while the block streams, which next to a
 * paragraph margin is invisible, and the finished block is rendered whole again.
 */
export type StreamingMarkdownSegments = {
  settled: readonly string[]
  live: string
}

export type StreamingMarkdownSegmentOptions = {
  /** A segment is not cut before it holds at least this much text. */
  minSegmentChars?: number
  /** Past this much text without a blank line, a line break may cut. */
  maxSegmentChars?: number
}

export const EMPTY_STREAMING_MARKDOWN_SEGMENTS: StreamingMarkdownSegments = { settled: [], live: '' }

const DEFAULT_MIN_SEGMENT_CHARS = 2_000
const DEFAULT_MAX_SEGMENT_CHARS = 6_000
const CODE_FENCE_LINE = /^ {0,3}(`{3,}|~{3,})/

/**
 * `previous` is the result for an earlier prefix of `content`: its settled
 * segments are kept as they are and only the text after them is scanned, so a
 * delta costs the pending text, not the block. A `previous` that `content` no
 * longer starts with (the block was replaced) is ignored.
 */
export function splitStreamingMarkdown(
  content: string,
  previous: StreamingMarkdownSegments = EMPTY_STREAMING_MARKDOWN_SEGMENTS,
  options: StreamingMarkdownSegmentOptions = {},
): StreamingMarkdownSegments {
  const minSegmentChars = Math.max(1, options.minSegmentChars ?? DEFAULT_MIN_SEGMENT_CHARS)
  const maxSegmentChars = Math.max(minSegmentChars, options.maxSegmentChars ?? DEFAULT_MAX_SEGMENT_CHARS)

  const settled: string[] = []
  let segmentStart = 0
  const kept = previous.settled.join('')
  if (kept.length > 0 && content.startsWith(kept)) {
    settled.push(...previous.settled)
    segmentStart = kept.length
  }

  let fence: string | null = null
  // Where a line break could cut, if the segment overflows before a blank line.
  let lineBreakCut = -1
  let afterBlankLine = false
  let position = segmentStart

  while (position < content.length) {
    const lineEnd = content.indexOf('\n', position)
    // The last line is still being written: nothing after it can be settled,
    // and nothing before it can be cut off until it has begun.
    const lineComplete = lineEnd !== -1
    const line = content.slice(position, lineComplete ? lineEnd : content.length)
    const blank = line.trim().length === 0

    if (fence === null && !blank && !/\s/.test(line.charAt(0))) {
      // A line that starts a new top-level block is where the text before it
      // can be settled: after a paragraph break once the segment is long
      // enough, otherwise at the last line break once it has overflowed.
      if (afterBlankLine && position - segmentStart >= minSegmentChars) {
        settled.push(content.slice(segmentStart, position))
        segmentStart = position
        lineBreakCut = -1
      } else if (position - segmentStart >= maxSegmentChars && lineBreakCut > segmentStart) {
        settled.push(content.slice(segmentStart, lineBreakCut))
        segmentStart = lineBreakCut
        lineBreakCut = -1
      }
    }

    if (!lineComplete) break

    const fenceMatch = CODE_FENCE_LINE.exec(line)
    if (fenceMatch) {
      const marker = fenceMatch[1]!.charAt(0)
      if (fence === null) fence = marker
      else if (fence === marker) fence = null
    }

    const next = lineEnd + 1
    if (fence === null) {
      afterBlankLine = blank
      if (!blank) lineBreakCut = next
    } else {
      afterBlankLine = false
    }
    position = next
  }

  return { settled, live: content.slice(segmentStart) }
}
