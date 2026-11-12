/** The Markdown subset sufficient for chat: code blocks, headings, lists, quotes, tables, rules and paragraphs. */
export type MarkdownBlock =
  | { type: 'code'; text: string; lang?: string }
  | { type: 'heading'; level: number; text: string }
  | { type: 'list'; ordered: boolean; items: { marker: string; text: string }[] }
  | { type: 'quote'; text: string }
  | { type: 'table'; header: string[]; rows: string[][] }
  | { type: 'rule' }
  | { type: 'paragraph'; text: string }

const listLine = /^\s*([-*+]|\d+[.)])\s+(.*)$/
// Table separator row: | --- | :---: | ---: | (outer pipes optional).
const tableRule = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/

/** Split a table row into cells: strip outer pipes, support \| escaping. */
export function splitTableRow(line: string): string[] {
  const body = line.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '')
  return body.split(/(?<!\\)\|/).map((cell) => cell.replace(/\\\|/g, '|').trim())
}

export function parseMarkdown(source: string): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = []
  const lines = source.replace(/\r\n?/g, '\n').split('\n')
  let paragraph: string[] = []
  const flush = () => {
    if (paragraph.length) blocks.push({ type: 'paragraph', text: paragraph.join('\n') })
    paragraph = []
  }
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]
    const fence = line.match(/^\s*```\s*([^`\s]*)/)
    if (fence) {
      flush()
      const code: string[] = []
      index++
      while (index < lines.length && !/^\s*```\s*$/.test(lines[index])) {
        code.push(lines[index])
        index++
      }
      blocks.push({ type: 'code', text: code.join('\n'), ...(fence[1] ? { lang: fence[1] } : {}) })
      continue
    }
    if (!line.trim()) {
      flush()
      continue
    }
    if (line.includes('|') && index + 1 < lines.length && lines[index + 1].includes('-') && tableRule.test(lines[index + 1]) && lines[index + 1].includes('|')) {
      flush()
      const header = splitTableRow(line)
      const rows: string[][] = []
      index += 2
      while (index < lines.length && lines[index].trim() && lines[index].includes('|')) {
        const cells = splitTableRow(lines[index])
        // Pad rows shorter than the header and truncate longer ones, keeping it rectangular.
        rows.push(header.map((_, column) => cells[column] ?? ''))
        index++
      }
      index--
      blocks.push({ type: 'table', header, rows })
      continue
    }
    const heading = line.match(/^(#{1,6})\s+(.+)$/)
    if (heading) {
      flush()
      blocks.push({ type: 'heading', level: heading[1].length, text: heading[2].trim() })
      continue
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flush()
      blocks.push({ type: 'rule' })
      continue
    }
    const item = line.match(listLine)
    if (item) {
      flush()
      const ordered = /\d/.test(item[1])
      const previous = blocks.at(-1)
      const entry = { marker: ordered ? item[1].replace(')', '.') : '•', text: item[2] }
      if (previous?.type === 'list' && previous.ordered === ordered) previous.items.push(entry)
      else blocks.push({ type: 'list', ordered, items: [entry] })
      continue
    }
    const quote = line.match(/^\s*>\s?(.*)$/)
    if (quote) {
      flush()
      const previous = blocks.at(-1)
      if (previous?.type === 'quote') previous.text += `\n${quote[1]}`
      else blocks.push({ type: 'quote', text: quote[1] })
      continue
    }
    paragraph.push(line)
  }
  flush()
  return blocks
}

/* ───────────── Mount cap for very long messages ───────────── */

/**
 * A message is one row in the message list, and list virtualization does not reach inside a row: every paragraph, list item and table cell
 * mounts as a native view. On Android native views live on the Java heap (usually capped at 256MB), so when the model repeats tens of thousands of blocks, 
 * opening or long-pressing that message crashes with OutOfMemoryError. So each message is capped by roughly how many native views it would mount:
 * beyond the cap only the beginning and end are kept, and the middle collapses into one expandable spot.
 */
export type MarkdownLimit = { head: number; tail: number }
export const MARKDOWN_LIMIT: MarkdownLimit = { head: 1500, tail: 500 }
/** Each expansion adds one more budget to the head, up to this many; anything longer can only be viewed on the computer, and expanding cannot push the cap back up. */
export const MARKDOWN_EXPAND_LIMIT = 6000
export type MarkdownWindow = { head: MarkdownBlock[]; hidden: number; tail: MarkdownBlock[] }

// Matches the render structure in Message.tsx: list item = row + number + container + body; each table row = row + each cell (container + body), plus the table frame.
const LIST_ITEM_COST = 4
const TABLE_FRAME_COST = 3
const tableRowCost = (block: { header: string[] }) => 1 + block.header.length * 2

/** Split into pieces that can be kept or dropped individually: lists by item, tables by row, other blocks (including header-only tables) as one piece each. */
type Piece = { block: number; item: number; cost: number }

function markdownPieces(blocks: MarkdownBlock[]): Piece[] {
  const pieces: Piece[] = []
  blocks.forEach((block, index) => {
    if (block.type === 'list')
      block.items.forEach((_, item) => pieces.push({ block: index, item, cost: LIST_ITEM_COST }))
    else if (block.type === 'table' && block.rows.length)
      block.rows.forEach((_, item) => pieces.push({ block: index, item, cost: tableRowCost(block) }))
    else {
      // Header-only table: the header and frame are counted as "opening a table" in pieceCost, not counted again here.
      const cost = block.type === 'table' ? 0 : block.type === 'code' || block.type === 'quote' ? 2 : 1
      pieces.push({ block: index, item: -1, cost })
    }
  })
  return pieces
}

/** When a table is split, each piece carries the header and frame. */
function pieceCost(blocks: MarkdownBlock[], piece: Piece, opensTable: boolean) {
  const block = blocks[piece.block]
  return piece.cost + (opensTable && block.type === 'table' ? TABLE_FRAME_COST + tableRowCost(block) : 0)
}

function rebuild(blocks: MarkdownBlock[], pieces: Piece[]): MarkdownBlock[] {
  const out: MarkdownBlock[] = []
  for (let start = 0; start < pieces.length; ) {
    let end = start
    while (end + 1 < pieces.length && pieces[end + 1].block === pieces[start].block) end++
    const block = blocks[pieces[start].block]
    const from = pieces[start].item
    const to = pieces[end].item + 1
    if (from < 0) out.push(block)
    else if (block.type === 'list') out.push({ ...block, items: block.items.slice(from, to) })
    else if (block.type === 'table') out.push({ ...block, rows: block.rows.slice(from, to) })
    else out.push(block)
    start = end + 1
  }
  return out
}

/** Cut out the head and tail by native view budget; return as is if it fits, with hidden being the number of collapsed middle pieces. */
export function windowMarkdown(blocks: MarkdownBlock[], limit: MarkdownLimit): MarkdownWindow {
  const pieces = markdownPieces(blocks)
  let head = 0
  let spent = 0
  while (head < pieces.length) {
    const opens = head === 0 || pieces[head - 1].block !== pieces[head].block
    const cost = pieceCost(blocks, pieces[head], opens)
    if (spent + cost > limit.head) break
    spent += cost
    head++
  }
  if (head === pieces.length) return { head: blocks, hidden: 0, tail: [] }
  let tail = pieces.length
  spent = 0
  while (tail > head) {
    const piece = pieces[tail - 1]
    const opens = tail === pieces.length || pieces[tail].block !== piece.block
    const cost = pieceCost(blocks, piece, opens)
    if (spent + cost > limit.tail) break
    spent += cost
    tail--
  }
  if (tail === head) return { head: blocks, hidden: 0, tail: [] }
  return {
    head: rebuild(blocks, pieces.slice(0, head)),
    hidden: tail - head,
    tail: rebuild(blocks, pieces.slice(tail)),
  }
}

/* ───────────── Table column widths ───────────── */

export const TABLE_MIN_COLUMN = 72
export const TABLE_MAX_COLUMN = 320

/**
 * Estimate text width in "half-width units": CJK, full-width punctuation and emoji count as 2 units, 
 * everything else as 1. Only used to seed column widths, no precision required.
 */
export function textWidthUnits(text: string): number {
  let units = 0
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    const wide =
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe30 && code <= 0xfe4f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6) ||
      (code >= 0x1f300 && code <= 0x1faff)
    units += wide ? 2 : 1
  }
  return units
}

/** Natural width of each column estimated from content; used to decide who needs space more when it does not fit. */
export function naturalColumnWidths(header: string[], rows: string[][]): number[] {
  return header.map((title, column) => {
    let units = textWidthUnits(title)
    for (const row of rows) units = Math.max(units, textWidthUnits(row[column] ?? ''))
    return Math.min(TABLE_MAX_COLUMN, Math.max(TABLE_MIN_COLUMN, Math.ceil(units * 7 + 20)))
  })
}

function roundToTotal(values: number[], total: number): number[] {
  const rounded = values.map((value) => Math.floor(value))
  let left = total - rounded.reduce((sum, value) => sum + value, 0)
  for (let index = 0; left > 0; index = (index + 1) % rounded.length, left--) rounded[index] += 1
  return rounded
}

/**
 * Distribute natural column widths over the available width: when it fits fill the row proportionally, otherwise shrink proportionally, 
 * but each column no narrower than `TABLE_MIN_COLUMN`. With truly too many columns return null and the caller falls back to horizontal scrolling.
 */
export function fitColumnWidths(natural: number[], available: number): number[] | null {
  const count = natural.length
  if (!count) return []
  if (!(available > 0)) return natural
  const min = TABLE_MIN_COLUMN
  if (available < min * count) return null
  let remaining = available
  let open = natural.map((_, index) => index)
  const widths = new Array<number>(count).fill(0)
  while (open.length) {
    const total = open.reduce((sum, index) => sum + natural[index], 0)
    const scale = remaining / total
    const narrow = open.filter((index) => natural[index] * scale < min)
    if (!narrow.length) {
      for (const index of open) widths[index] = natural[index] * scale
      break
    }
    for (const index of narrow) {
      widths[index] = min
      remaining -= min
    }
    open = open.filter((index) => !narrow.includes(index))
  }
  return roundToTotal(widths, available)
}

export type InlineSegment = { type: 'text' | 'bold' | 'code'; text: string }

export function parseInline(text: string): InlineSegment[] {
  return text
    .split(/(\*\*[^*\n]+\*\*|`[^`\n]+`)/g)
    .filter(Boolean)
    .map((segment) =>
      segment.startsWith('**') && segment.endsWith('**') && segment.length > 4
        ? { type: 'bold', text: segment.slice(2, -2) }
        : segment.startsWith('`') && segment.endsWith('`') && segment.length > 2
          ? { type: 'code', text: segment.slice(1, -1) }
          : { type: 'text', text: segment }
    )
}
