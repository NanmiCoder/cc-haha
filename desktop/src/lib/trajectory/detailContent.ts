import type { TrajectoryRow } from '../../types/trajectory'

export type ToolUseBlock = { id: string; name: string; input: unknown }

export type TrajectoryDetailContent = {
  /** Markdown-renderable text of the row (prompt, response, injected text). */
  text: string
  thinking: string[]
  toolUses: ToolUseBlock[]
  /** Tool rows: the call input. */
  toolInput?: unknown
  /** Tool rows: the result text as the model saw it. */
  toolResult?: string
  toolResultIsError?: boolean
  /** Tool rows: the structured result the harness recorded (toolUseResult). */
  toolResultStructured?: unknown
  /** Context rows backed by an attachment record. */
  attachment?: unknown
  imageCount: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function blocksOf(entry: Record<string, unknown>): unknown[] {
  const message = entry.message
  if (!isRecord(message)) return []
  const content = message.content
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  return Array.isArray(content) ? content : []
}

function textOfResult(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return content === undefined ? '' : JSON.stringify(content, null, 2)
  return content
    .map((block) => {
      if (!isRecord(block)) return ''
      if (block.type === 'text' && typeof block.text === 'string') return block.text
      if (block.type === 'image') return '[image]'
      return JSON.stringify(block, null, 2)
    })
    .filter(Boolean)
    .join('\n\n')
}

/** Pull the readable parts out of a row's raw transcript records. */
export function extractDetailContent(row: TrajectoryRow, entries: readonly Record<string, unknown>[]): TrajectoryDetailContent {
  const content: TrajectoryDetailContent = { text: '', thinking: [], toolUses: [], imageCount: 0 }
  const texts: string[] = []
  for (const entry of entries) {
    if (entry.type === 'attachment') {
      content.attachment = entry.attachment
      continue
    }
    if (entry.type === 'system') {
      if (typeof entry.content === 'string') texts.push(entry.content)
      continue
    }
    for (const block of blocksOf(entry)) {
      if (!isRecord(block)) continue
      switch (block.type) {
        case 'text':
          if (typeof block.text === 'string' && row.kind !== 'tool') texts.push(block.text)
          break
        case 'thinking':
          if (typeof block.thinking === 'string' && block.thinking) content.thinking.push(block.thinking)
          break
        case 'redacted_thinking':
          content.thinking.push('[redacted thinking]')
          break
        case 'image':
          content.imageCount++
          break
        case 'tool_use':
          if (typeof block.id === 'string' && typeof block.name === 'string') {
            const use = { id: block.id, name: block.name, input: block.input }
            if (row.kind === 'tool') {
              if (block.id === row.toolUseId) content.toolInput = block.input
            } else {
              content.toolUses.push(use)
            }
          }
          break
        case 'tool_result':
          if (row.kind === 'tool' && block.tool_use_id === row.toolUseId) {
            content.toolResult = textOfResult(block.content)
            if (Array.isArray(block.content)) {
              content.imageCount += block.content.filter((item) => isRecord(item) && item.type === 'image').length
            }
            content.toolResultIsError = block.is_error === true
            if (entry.toolUseResult !== undefined) content.toolResultStructured = entry.toolUseResult
          }
          break
      }
    }
  }
  content.text = texts.join('\n\n')
  return content
}

/** One readable value per attachment, for the preview tab. */
export function attachmentText(attachment: unknown): string {
  if (!isRecord(attachment)) return ''
  const strings: string[] = []
  const visit = (value: unknown, depth: number) => {
    if (depth > 4 || strings.length > 200) return
    if (typeof value === 'string') {
      if (value.trim()) strings.push(value)
      return
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1)
      return
    }
    if (isRecord(value)) {
      for (const [key, child] of Object.entries(value)) {
        if (key === 'type') continue
        visit(child, depth + 1)
      }
    }
  }
  visit(attachment, 0)
  return strings.join('\n\n')
}
