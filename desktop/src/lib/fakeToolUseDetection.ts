/**
 * Detect "fake" tool_use blocks emitted as plain text by models that don't
 * support (or don't correctly route) Anthropic-style structured tool calls.
 *
 * Symptom in the wild: a model on a non-Anthropic gateway (mimo, lgfzer,
 * some local proxies) emits something like
 *
 *   <tool_use id="tooluse_NS9MjB3a1XuhVvgU52uHpE" name="Bash">
 *     {"command":"ls -la /tmp", "description":"list tmp"}
 *   </tool_use>
 *
 * inside a normal `content_delta { text }` stream. The desktop renders that
 * stream as markdown, marked passes the unknown `<tool_use>` element through
 * as raw HTML, the browser collapses whitespace, and the user sees garbage
 * like `<tool_useid="..."` followed by a smushed shell command.
 *
 * Worse: the model doesn't know the call never executed, so it follows up
 * with apologies ("工具用错了, 重来:") and tries again, multiplying the
 * garbage. None of these "calls" actually run — they're text. We have to
 * extract them so we can:
 *   1. Hide the raw tags from the markdown renderer.
 *   2. Surface a clear notice so the user knows the model attempted a tool
 *      call that the provider failed to honor.
 *   3. Increment a per-provider compatibility counter so we can suggest
 *      switching providers after enough leaks.
 *
 * This module is the regex layer for (1) and (2). The store layer
 * (`providerCompatStore`) handles (3).
 *
 * Scope:
 * - Closed `<tool_use ...>...</tool_use>` blocks (whole turn, replay).
 * - Half-open `<tool_use ...>...` (mid-stream chunk before close arrives).
 * - Multiple consecutive blocks (model retried after self-correcting).
 * - `name=` and `id=` attributes in either order; with or without quotes.
 *
 * Out of scope:
 * - Fenced code blocks (` ```xml `) — those are intentional examples and
 *   should render verbatim. We bail out if the would-be block sits inside
 *   a fenced code block.
 */

export type FakeToolUseBlock = {
  /** The tool name from `name=`, or `'unknown'` if not parsed. */
  name: string
  /** The tool_use id from `id=`, or null. Useful for de-dup / analytics. */
  id: string | null
  /**
   * The block's inner text (between the opening tag and the closing tag,
   * or end-of-string for half-open blocks). May contain JSON, may be
   * empty for blocks that only have an opening tag at end-of-stream.
   */
  inner: string
  /** True when no `</tool_use>` was found before end-of-input. */
  unterminated: boolean
}

export type FakeToolUseExtraction = {
  /** Original text with all detected blocks removed. Whitespace squashed. */
  cleanText: string
  /** All detected blocks in source order. Empty when none found. */
  blocks: FakeToolUseBlock[]
}

// Match `<tool_use ... >` opener. Tolerates extra spaces, attribute order,
// quoted/unquoted values, and self-closing variants. Captures the full tag
// so we can splice out the matched range exactly.
const OPENER_RX =
  /<tool_use\b([^>]*?)(\/\s*)?>/gi

// Match `</tool_use>` closer.
const CLOSER_RX = /<\/tool_use\s*>/i

// Pull `name="..."` / `id="..."` (with or without quotes) out of the
// opener's attribute span.
const NAME_ATTR_RX = /\bname\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i
const ID_ATTR_RX = /\bid\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i

/**
 * Build a list of [start, end) ranges that fall inside fenced code blocks
 * so we can skip openers that legitimately appear in user-written examples.
 * Conservative: only ``` fences are tracked; ~~~ and indented code blocks
 * are rare for tool_use examples and don't justify the complexity.
 */
function fencedRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = []
  const fenceRx = /(^|\n)```/g
  let inFence = false
  let openIdx = -1
  let m: RegExpExecArray | null
  while ((m = fenceRx.exec(text)) !== null) {
    const idx = m.index + (m[1] ? 1 : 0)
    if (!inFence) {
      openIdx = idx
      inFence = true
    } else {
      // Close. End range at the closing fence's first ` so the closing
      // ``` itself is also considered "inside fence" for opener purposes.
      ranges.push([openIdx, idx + 3])
      inFence = false
      openIdx = -1
    }
  }
  // An unterminated opening fence covers everything from openIdx to EOF —
  // assume the model's still typing the example out. Don't strip openers
  // inside a half-open fence either.
  if (inFence && openIdx >= 0) ranges.push([openIdx, text.length])
  return ranges
}

function isInsideAny(ranges: Array<[number, number]>, idx: number): boolean {
  for (const [start, end] of ranges) {
    if (idx >= start && idx < end) return true
  }
  return false
}

function parseAttrs(attrSpan: string): { name: string; id: string | null } {
  const nameMatch = NAME_ATTR_RX.exec(attrSpan)
  const idMatch = ID_ATTR_RX.exec(attrSpan)
  const name =
    (nameMatch && (nameMatch[1] ?? nameMatch[2] ?? nameMatch[3])) || 'unknown'
  const id = (idMatch && (idMatch[1] ?? idMatch[2] ?? idMatch[3])) || null
  return { name, id }
}

/**
 * Squash leftover blank-line gaps that appear once a block is removed —
 * markdown renders `\n\n\n\n` as a giant gap, and a missing block
 * shouldn't leave an obvious hole in the prose.
 */
function squashWhitespace(text: string): string {
  return text.replace(/\n{3,}/g, '\n\n').replace(/[ \t]+\n/g, '\n').trim()
}

export function extractFakeToolUseBlocks(input: string): FakeToolUseExtraction {
  if (!input || !input.includes('<tool_use')) {
    return { cleanText: input, blocks: [] }
  }

  const fenced = fencedRanges(input)
  const blocks: FakeToolUseBlock[] = []
  const removalRanges: Array<[number, number]> = []

  // Reset state on the global regex so multiple calls don't share lastIndex.
  OPENER_RX.lastIndex = 0
  let opener: RegExpExecArray | null
  while ((opener = OPENER_RX.exec(input)) !== null) {
    const openStart = opener.index
    const openEnd = openStart + opener[0].length
    if (isInsideAny(fenced, openStart)) continue

    const attrSpan = opener[1] ?? ''
    const isSelfClose = !!opener[2]

    if (isSelfClose) {
      const { name, id } = parseAttrs(attrSpan)
      blocks.push({ name, id, inner: '', unterminated: false })
      removalRanges.push([openStart, openEnd])
      continue
    }

    // Search for closer starting at openEnd. Use slice + match to avoid
    // tracking another lastIndex; the slices are bounded by the block
    // size which is small in practice.
    const tail = input.slice(openEnd)
    const closer = CLOSER_RX.exec(tail)
    if (closer) {
      const innerStart = openEnd
      const innerEnd = openEnd + closer.index
      const blockEnd = innerEnd + closer[0].length
      const inner = input.slice(innerStart, innerEnd).trim()
      const { name, id } = parseAttrs(attrSpan)
      blocks.push({ name, id, inner, unterminated: false })
      removalRanges.push([openStart, blockEnd])
      // Skip past the closer so the next iteration doesn't match an
      // opener inside this block's inner text (rare but possible).
      OPENER_RX.lastIndex = blockEnd
    } else {
      // Half-open. Block extends to EOF — strip it all so the user
      // doesn't see a dangling `<tool_use ...>` mid-stream.
      const inner = input.slice(openEnd).trim()
      const { name, id } = parseAttrs(attrSpan)
      blocks.push({ name, id, inner, unterminated: true })
      removalRanges.push([openStart, input.length])
      break
    }
  }

  if (blocks.length === 0) {
    return { cleanText: input, blocks: [] }
  }

  // Splice in reverse so earlier indices stay valid.
  let cleanText = input
  for (let i = removalRanges.length - 1; i >= 0; i--) {
    const [start, end] = removalRanges[i]!
    cleanText = cleanText.slice(0, start) + cleanText.slice(end)
  }

  return { cleanText: squashWhitespace(cleanText), blocks }
}
