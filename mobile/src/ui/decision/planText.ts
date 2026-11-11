/**
 * 计划正文的轻量 Markdown 解析：只认计划里常见的标题、段落、编号步骤、列表和代码块。
 * 渲染样式按设计稿：标题 23/30，段落 16/25，步骤编号等宽，路径等宽。
 */
export type PlanItem = { marker: string; lines: string[] }
export type PlanBlock =
  | { type: 'title'; text: string }
  | { type: 'heading'; text: string }
  | { type: 'paragraph'; text: string }
  | { type: 'ordered'; items: PlanItem[] }
  | { type: 'bullets'; items: PlanItem[] }
  | { type: 'code'; text: string }
export type PlanSpan = { text: string; code?: boolean; bold?: boolean }

export const MISSING_PLAN_TEXT = '电脑未提供计划正文，请在电脑上核对后再批准。'

/** 计划正文只来自 plan / planContent；空串当作没有。 */
export function planSource(input: Record<string, unknown>) {
  for (const value of [input.plan, input.planContent])
    if (typeof value === 'string' && value.trim()) return value
  return null
}

export function planFilePath(input: Record<string, unknown>) {
  for (const value of [input.planFilePath, input.filePath])
    if (typeof value === 'string' && value.trim()) return value
  return undefined
}

const ORDERED = /^(\d{1,3})[.)]\s+(.*)$/
const BULLET = /^[-*+]\s+(.*)$/
const indentOf = (line: string) => line.length - line.trimStart().length

export function planBlocks(text: string): PlanBlock[] {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const blocks: PlanBlock[] = []
  let paragraph: string[] = []
  const flush = () => {
    if (paragraph.length)
      blocks.push({ type: 'paragraph', text: paragraph.join('\n') })
    paragraph = []
  }
  for (let index = 0; index < lines.length; index++) {
    const raw = lines[index]
    const line = raw.trim()
    if (line.startsWith('```')) {
      flush()
      const body: string[] = []
      index++
      while (index < lines.length && !lines[index].trim().startsWith('```'))
        body.push(lines[index++])
      blocks.push({ type: 'code', text: body.join('\n') })
      continue
    }
    if (!line) {
      flush()
      continue
    }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line)) {
      flush()
      continue
    }
    const heading = /^(#{1,6})\s+(.+?)\s*#*$/.exec(line)
    if (heading) {
      flush()
      blocks.push({
        type: heading[1].length === 1 ? 'title' : 'heading',
        text: heading[2],
      })
      continue
    }
    const ordered = indentOf(raw) < 2 ? ORDERED.exec(line) : null
    const bullet = indentOf(raw) < 2 && !ordered ? BULLET.exec(line) : null
    if (ordered || bullet) {
      flush()
      const type = ordered ? 'ordered' : 'bullets'
      const item: PlanItem = {
        marker: ordered ? ordered[1] : '•',
        lines: [(ordered ? ordered[2] : bullet![1]).trim()],
      }
      const previous = blocks.at(-1)
      // 编号之间允许空行（松散列表），仍算同一组步骤。
      if (previous?.type === type) previous.items.push(item)
      else blocks.push({ type, items: [item] } as PlanBlock)
      // 缩进的续行、子列表归到这一步下面。
      while (index + 1 < lines.length) {
        const next = lines[index + 1]
        if (!next.trim()) {
          const after = lines.slice(index + 2).find((value) => value.trim())
          if (after && indentOf(after) >= 2) {
            index++
            continue
          }
          break
        }
        if (indentOf(next) < 2) break
        index++
        item.lines.push(next.trim().replace(/^[-*+]\s+/, '· '))
      }
      continue
    }
    paragraph.push(line)
  }
  flush()
  return blocks
}

/** 文件路径（含 / 和扩展名）按等宽显示，与 `code` 一致。 */
const PATH = /((?:~|\.{1,2})?(?:[\w@.-]+\/)+[\w@.[\]-]+\.[A-Za-z0-9]+)/
export function planSpans(text: string): PlanSpan[] {
  const spans: PlanSpan[] = []
  for (const part of text.split(/(`[^`\n]+`|\*\*[^*\n]+\*\*)/g)) {
    if (!part) continue
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
      spans.push({ text: part.slice(1, -1), code: true })
      continue
    }
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
      spans.push({ text: part.slice(2, -2), bold: true })
      continue
    }
    for (const piece of part.split(PATH)) {
      if (!piece) continue
      spans.push(PATH.test(piece) && /\//.test(piece) ? { text: piece, code: true } : { text: piece })
    }
  }
  return spans
}

const plain = (value: string) =>
  value
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*([^*]*)\*\*/g, '$1')
    .trim()

/** 底座卡片里的“计划前两行”：取前两条有内容的块，去掉 Markdown 记号。 */
export function planExcerpt(text: string, count = 2) {
  const lines: string[] = []
  for (const block of planBlocks(text)) {
    if (block.type === 'code') continue
    if (block.type === 'ordered' || block.type === 'bullets')
      for (const item of block.items)
        lines.push(
          block.type === 'ordered'
            ? `${item.marker}. ${plain(item.lines[0])}`
            : plain(item.lines[0])
        )
    else lines.push(...block.text.split('\n').map(plain))
    if (lines.filter(Boolean).length >= count) break
  }
  return lines.filter(Boolean).slice(0, count).join('\n')
}
