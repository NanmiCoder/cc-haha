/**
 * Markdown style optimization for Feishu cards
 *
 * Background:
 * - Feishu card `tag: 'markdown'` elements have a known rendering bug with H1~H3 headings (shown literally).
 *   They must be downgraded to H4/H5 to render correctly.
 * - Schema 2.0 CardKit supports full markdown, but `<br>` spacing must be added manually so headings/tables/
 *   code blocks are not squeezed together.
 * - Cards have a table count limit (FEISHU_CARD_TABLE_LIMIT=3); exceeding it triggers 230099/11310.
 * - Images must be Feishu-uploaded `img_xxx` keys; any other URL triggers CardKit error 200570.
 *
 * Implementation reference: openclaw-lark/src/card/markdown-style.ts + card-error.ts
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Feishu card table limit —— more than 3 triggers 230099/11310 (measured by openclaw 2026-03) */
export const FEISHU_CARD_TABLE_LIMIT = 3

// ---------------------------------------------------------------------------
// Public: optimizeMarkdownForFeishu
// ---------------------------------------------------------------------------

/**
 * Safely preprocess markdown destined for a `tag: 'markdown'` element.
 *
 * - Heading downgrade: if the source contains H1~H3, H2~H6 → H5, H1 → H4
 * - Code block content is protected and not downgraded
 * - Schema 2.0: add `<br>` spacing around consecutive headings/tables/code blocks
 * - Collapse 3+ consecutive blank lines to 2
 * - Remove markdown image references that are not `img_*` (prevents CardKit 200570)
 * - Any internal error falls back to the original text so sending is never blocked
 *
 * @param text original markdown
 * @param cardVersion card schema version. Defaults to 2 (Schema 2.0 CardKit);
 *   1 is the old Schema 1.0 fallback path (no longer recommended).
 */
export function optimizeMarkdownForFeishu(text: string, cardVersion = 2): string {
  try {
    let r = _optimizeMarkdownForFeishu(text, cardVersion)
    r = stripInvalidImageKeys(r)
    return r
  } catch {
    return text
  }
}

function _optimizeMarkdownForFeishu(text: string, cardVersion: number): string {
  // ── 1. Extract code blocks, protect with placeholders, restore afterwards ─────────────────────
  // `#` / `|` inside code blocks must not be hit by heading downgrade or table matching
  const MARK = '___CB_'
  const codeBlocks: string[] = []
  let r = text.replace(/```[\s\S]*?```/g, (m) => {
    return `${MARK}${codeBlocks.push(m) - 1}___`
  })

  // ── 2. Heading downgrade ────────────────────────────────────────────────────
  // Only downgrade when the original document (not the protected r) contains H1~H3
  // Order: first H2~H6 → H5, then H1 → H4
  // If H1→H4 ran first, `####` would be matched again by the later `#{2,6}` and become H5
  const hasH1toH3 = /^#{1,3} /m.test(text)
  if (hasH1toH3) {
    r = r.replace(/^#{2,6} (.+)$/gm, '##### $1') // H2~H6 → H5
    r = r.replace(/^# (.+)$/gm, '#### $1') // H1 → H4
  }

  // ── 3. Schema 2.0 paragraph spacing ────────────────────────────────────────
  if (cardVersion >= 2) {
    // 3a. Add <br> between consecutive headings
    r = r.replace(/^(#{4,5} .+)\n{1,2}(#{4,5} )/gm, '$1\n<br>\n$2')

    // 3b. Non-table line directly followed by a table line → insert a blank line first (so later rules apply)
    r = r.replace(/^([^|\n].*)\n(\|.+\|)/gm, '$1\n\n$2')

    // 3c. Before a table: insert <br> before the blank line (i.e. `\n\n|` → `\n<br>\n\n|`)
    r = r.replace(/\n\n((?:\|.+\|[^\S\n]*\n?)+)/g, '\n\n<br>\n\n$1')

    // 3d. After a table: append <br> at the end of the table block (skip when followed by a rule/heading/bold/end of text)
    r = r.replace(/((?:^\|.+\|[^\S\n]*\n?)+)/gm, (m, _table, offset) => {
      const after = r.slice(offset + m.length).replace(/^\n+/, '')
      if (!after || /^(---|#{4,5} |\*\*)/.test(after)) return m
      return m + '\n<br>\n'
    })

    // 3e. Plain text before a table: keep only <br>, drop extra blank lines
    //     "text\n\n<br>\n\n|" → "text\n<br>\n|"
    r = r.replace(/^((?!#{4,5} )(?!\*\*).+)\n\n(<br>)\n\n(\|)/gm, '$1\n$2\n$3')

    // 3f. Bold line before a table: <br> right after the bold line, blank line kept after it
    //     "**bold**\n\n<br>\n\n|" → "**bold**\n<br>\n\n|"
    r = r.replace(/^(\*\*.+)\n\n(<br>)\n\n(\|)/gm, '$1\n$2\n\n$3')

    // 3g. Plain text after a table: drop extra blank lines
    //     "| row |\n\n<br>\ntext" → "| row |\n<br>\ntext"
    r = r.replace(/(\|[^\n]*\n)\n(<br>\n)((?!#{4,5} )(?!\*\*))/gm, '$1$2$3')
  }

  // ── 4. Collapse extra blank lines (3+ consecutive newlines → 2) ────────────────────
  // Must run before restoring code blocks, otherwise consecutive newlines inside code blocks would be hit
  r = r.replace(/\n{3,}/g, '\n\n')

  // ── 5. Restore code blocks ─────────────────────────────────────────────────
  // With Schema 2.0, add <br> before and after to separate code blocks from surrounding paragraphs
  codeBlocks.forEach((block, i) => {
    const replacement = cardVersion >= 2 ? `\n<br>\n${block}\n<br>\n` : block
    r = r.replace(`${MARK}${i}___`, replacement)
  })

  return r
}

// ---------------------------------------------------------------------------
// stripInvalidImageKeys
// ---------------------------------------------------------------------------

/** Matches full markdown image syntax: `![alt](value)` */
const IMAGE_RE = /!\[([^\]]*)\]\(([^)\s]+)\)/g

/**
 * Remove markdown image references whose value is not a Feishu image key (`img_xxx`).
 * Prevents CardKit error 200570 (unknown image key).
 *
 * HTTP URLs and local paths are removed too —— upstream (ImageResolver) is responsible for converting them to
 * `img_xxx`; this function is a safety net.
 */
function stripInvalidImageKeys(text: string): string {
  if (!text.includes('![')) return text
  return text.replace(IMAGE_RE, (fullMatch, _alt, value) => {
    if (value.startsWith('img_')) return fullMatch
    return ''
  })
}

// ---------------------------------------------------------------------------
// Table limiting: sanitizeTextForCard
// ---------------------------------------------------------------------------

export type MarkdownTableMatch = {
  index: number
  length: number
  raw: string
}

/**
 * Scan the positions of markdown tables in the body that Feishu cards **actually render**.
 *
 * Example tables inside code blocks are not parsed by Feishu as card table elements, so exclude them first.
 * The result is used by `sanitizeTextForCard` to decide whether extra tables must be downgraded.
 */
export function findMarkdownTablesOutsideCodeBlocks(text: string): MarkdownTableMatch[] {
  // Scan code block ranges first
  const codeBlockRanges: Array<{ start: number; end: number }> = []
  const codeBlockRegex = /```[\s\S]*?```/g
  let cbMatch = codeBlockRegex.exec(text)
  while (cbMatch != null) {
    codeBlockRanges.push({
      start: cbMatch.index,
      end: cbMatch.index + cbMatch[0].length,
    })
    cbMatch = codeBlockRegex.exec(text)
  }
  const isInsideCodeBlock = (idx: number): boolean =>
    codeBlockRanges.some((range) => idx >= range.start && idx < range.end)

  // Scan tables (header | sep | body...)
  const tableRegex = /\|.+\|[\r\n]+\|[-:| ]+\|[\s\S]*?(?=\n\n|\n(?!\|)|$)/g
  const matches: MarkdownTableMatch[] = []
  let tableMatch = tableRegex.exec(text)
  while (tableMatch != null) {
    if (!isInsideCodeBlock(tableMatch.index)) {
      matches.push({
        index: tableMatch.index,
        length: tableMatch[0].length,
        raw: tableMatch[0],
      })
    }
    tableMatch = tableRegex.exec(text)
  }
  return matches
}

/**
 * Downgrade markdown tables beyond `tableLimit` in the body to code blocks to avoid
 * 230099/11310. The first `tableLimit` tables stay as-is (the card renders them normally); the rest are
 * wrapped in backticks (Feishu treats them as code blocks instead of tables).
 */
export function sanitizeTextForCard(
  text: string,
  tableLimit: number = FEISHU_CARD_TABLE_LIMIT,
): string {
  const matches = findMarkdownTablesOutsideCodeBlocks(text)
  if (matches.length <= tableLimit) return text
  return wrapTablesBeyondLimit(text, matches, Math.max(tableLimit, 0))
}

function wrapTablesBeyondLimit(
  text: string,
  matches: readonly MarkdownTableMatch[],
  keepCount: number,
): string {
  if (matches.length <= keepCount) return text
  // Replace from back to front so earlier replacements don't shift later offsets
  let result = text
  for (let i = matches.length - 1; i >= keepCount; i--) {
    const { index, length, raw } = matches[i]!
    const replacement = '```\n' + raw + '\n```'
    result = result.slice(0, index) + replacement + result.slice(index + length)
  }
  return result
}
