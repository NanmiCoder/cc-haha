/** 聊天里够用的 Markdown 子集：代码块、标题、列表、引用、表格、分隔线和段落。 */
export type MarkdownBlock =
  | { type: 'code'; text: string; lang?: string }
  | { type: 'heading'; level: number; text: string }
  | { type: 'list'; ordered: boolean; items: { marker: string; text: string }[] }
  | { type: 'quote'; text: string }
  | { type: 'table'; header: string[]; rows: string[][] }
  | { type: 'rule' }
  | { type: 'paragraph'; text: string }

const listLine = /^\s*([-*+]|\d+[.)])\s+(.*)$/
// 表格分隔行：| --- | :---: | ---: |（外侧竖线可省）。
const tableRule = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/

/** 把一行表格拆成单元格：去掉外侧竖线，支持 \| 转义。 */
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
        // 行比表头短就补空，长就截断，保持矩形。
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

/* ───────────── 表格列宽 ───────────── */

export const TABLE_MIN_COLUMN = 72
export const TABLE_MAX_COLUMN = 320

/**
 * 估算文字的“半角单位”宽度：中日韩、全角标点和 emoji 按 2 个单位，
 * 其余按 1 个。只用来给列宽定初值，不要求精确。
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

/** 每列按内容估算的自然宽度；用于放不下时判断谁更需要空间。 */
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
 * 把自然列宽分配到可用宽度：放得下就按比例铺满整行，放不下就等比压缩、
 * 但每列不低于 `TABLE_MIN_COLUMN`。列实在太多时返回 null，调用方退回横向滚动。
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
