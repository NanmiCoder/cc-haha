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
