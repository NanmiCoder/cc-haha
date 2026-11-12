/**
 * Lightweight Markdown parsing of the plan body: only recognizes headings, paragraphs, numbered steps, lists and code blocks common in plans.
 * Render styles per design: headings 23/30, paragraphs 16/25, step numbers monospace, paths monospace.
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

export const MISSING_PLAN_TEXT = 'The computer did not provide the plan body; check on the computer before approving.'

/** The plan body comes only from plan / planContent; an empty string counts as absent. */
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
      // Blank lines between numbers are allowed (loose list) and still count as the same group of steps.
      if (previous?.type === type) previous.items.push(item)
      else blocks.push({ type, items: [item] } as PlanBlock)
      // Indented continuation lines and sublists belong under this step.
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

/** File paths (with / and an extension) are shown in monospace, same as `code`. */
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

/** "First two lines of the plan" in the base card: take the first two blocks with content, stripping Markdown markers. */
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
