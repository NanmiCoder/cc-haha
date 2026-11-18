import { sessionsApi, type SessionHistoryPage } from '@/api/sessions'
import type { TranslationKey } from '@/i18n'
import { copyTextToClipboard } from '@/lib/clipboard'
import type { MessageEntry } from '@/types/session'

type HistoryCompleteness = Pick<NonNullable<SessionHistoryPage['page']>, 'historyComplete' | 'contentTruncated' | 'omittedOversizedEntries'>
  & Partial<Pick<NonNullable<SessionHistoryPage['page']>, 'hasMore' | 'nextCursor' | 'previousCursor'>>
export type SessionMarkdownHistory = { messages: MessageEntry[]; page?: HistoryCompleteness }
export type SessionMarkdownActionMode = 'copy' | 'export'

export type RunSessionMarkdownActionOptions = {
  sessionId: string
  title: string
  mode: SessionMarkdownActionMode
  addToast: (toast: { type: 'success' | 'error'; message: string }) => void
  t: (key: TranslationKey) => string
}

const MAX_FILENAME_CODE_POINTS = 80
const WINDOWS_RESERVED_FILENAME_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i
const WRAPPER_ONLY_KEYS = new Set(['content', 'type', 'status', 'role'])
const inFlightSessionMarkdownActions = new Set<string>()

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function readMediaType(record: Record<string, unknown>): string | undefined {
  const candidates = [
    isRecord(record.source) ? record.source.media_type : undefined,
    isRecord(record.file) ? record.file.type : undefined,
    record.media_type,
    record.mimeType,
  ]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim()
  }
  return undefined
}

function formatAttachmentPlaceholder(kind: string, mediaType?: string): string {
  return mediaType ? `_[${kind} attachment: ${mediaType}]_` : `_[${kind} attachment]_`
}

function attachmentPlaceholderForRecord(record: Record<string, unknown>): string | null {
  const blockType = typeof record.type === 'string' ? record.type : ''
  const mediaType = readMediaType(record)

  if (blockType === 'image' || blockType === 'input_image' || blockType === 'image_url') {
    return formatAttachmentPlaceholder('Image', mediaType)
  }
  if (blockType === 'document' || blockType === 'pdf') {
    return formatAttachmentPlaceholder('Document', mediaType)
  }
  if (blockType === 'audio' || blockType === 'input_audio') {
    return formatAttachmentPlaceholder('Audio', mediaType)
  }
  if (blockType === 'video') {
    return formatAttachmentPlaceholder('Video', mediaType)
  }

  const hasBase64Source = isRecord(record.source) && (record.source.type === 'base64' || typeof record.source.data === 'string')
  const hasBase64File = isRecord(record.file) && typeof record.file.base64 === 'string'
  if (hasBase64Source || hasBase64File || typeof record.base64 === 'string') {
    if (mediaType?.startsWith('image/')) return formatAttachmentPlaceholder('Image', mediaType)
    if (mediaType?.startsWith('audio/')) return formatAttachmentPlaceholder('Audio', mediaType)
    if (mediaType?.startsWith('video/')) return formatAttachmentPlaceholder('Video', mediaType)
    if (mediaType === 'application/pdf') return formatAttachmentPlaceholder('Document', mediaType)
    return formatAttachmentPlaceholder('Binary', mediaType)
  }

  return null
}

function sanitizeJsonForMarkdown(value: unknown): unknown {
  if (typeof value === 'string') {
    const dataUriMatch = /^data:([^;,]+);base64,/i.exec(value)
    if (dataUriMatch) return `[base64 ${dataUriMatch[1]} omitted]`
    return value
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeJsonForMarkdown(item))
  }
  if (isRecord(value)) {
    const placeholder = attachmentPlaceholderForRecord(value)
    if (placeholder) return placeholder
    const sanitized: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(value)) {
      if ((key === 'base64' || key === 'signature') && typeof entry === 'string') {
        sanitized[key] = '[omitted]'
      } else if (value.type === 'redacted_thinking' && key === 'data' && typeof entry === 'string') {
        sanitized[key] = '[omitted]'
      } else {
        sanitized[key] = sanitizeJsonForMarkdown(entry)
      }
    }
    return sanitized
  }
  return value
}

function formatJsonFence(value: unknown): string {
  return `\`\`\`json\n${JSON.stringify(sanitizeJsonForMarkdown(value), null, 2)}\n\`\`\``
}

function contentToMarkdown(content: unknown): string {
  if (content === null || content === undefined) return ''
  if (typeof content === 'string') return content
  if (typeof content === 'number' || typeof content === 'boolean') return String(content)
  if (Array.isArray(content)) {
    return content
      .map((item) => contentToMarkdown(item).trim())
      .filter(Boolean)
      .join('\n\n')
  }
  if (isRecord(content)) {
    const attachment = attachmentPlaceholderForRecord(content)
    if (attachment) return attachment

    if (content.type === 'thinking') {
      const thinking = typeof content.thinking === 'string' ? content.thinking.trim() : ''
      return thinking ? `<details>\n<summary>Thinking</summary>\n\n${thinking}\n\n</details>` : ''
    }

    if (content.type === 'redacted_thinking') {
      return '_[Redacted thinking]_'
    }

    if (content.type === 'tool_use' && typeof content.name === 'string') {
      const header = `**Tool use: \`${content.name}\`**`
      if (!('input' in content) || content.input === undefined) return header
      return `${header}\n\n${formatJsonFence(content.input)}`
    }

    if (content.type === 'tool_result') {
      const nested = contentToMarkdown(content.content).trim()
      if (content.is_error === true) {
        return nested ? `**Tool error**\n\n${nested}` : '**Tool error**'
      }
      return nested
    }

    if (typeof content.text === 'string') return content.text

    const keys = Object.keys(content)
    if ('content' in content && keys.length > 0 && keys.every((key) => WRAPPER_ONLY_KEYS.has(key))) {
      return contentToMarkdown(content.content)
    }

    return formatJsonFence(content)
  }
  return ''
}

function hasAssistantNarrativeBlocks(content: unknown): boolean {
  return Array.isArray(content) && content.some(
    (block) => isRecord(block) && (block.type === 'text' || block.type === 'thinking' || block.type === 'redacted_thinking'),
  )
}

function messageLabel(message: MessageEntry & { role?: string }): string {
  if (message.role === 'assistant') return 'Assistant'
  if (message.type === 'tool_use' && hasAssistantNarrativeBlocks(message.content)) return 'Assistant'
  switch (message.type) {
    case 'user': return 'User'
    case 'assistant': return 'Assistant'
    case 'system': return 'System'
    case 'tool_use': return 'Tool use'
    case 'tool_result': return 'Tool result'
  }
}

function messageBody(message: MessageEntry): string {
  const content = contentToMarkdown(message.content).trim()
  if (message.type === 'tool_result') {
    if (content) return content
    return message.toolUseResult !== undefined ? contentToMarkdown(message.toolUseResult).trim() : ''
  }
  if (message.type === 'tool_use' && message.toolUseResult !== undefined) {
    const result = contentToMarkdown(message.toolUseResult).trim()
    if (result && result !== content) {
      return content ? `${content}\n\n${result}` : result
    }
  }
  return content
}

export function isCompleteSessionHistory(history: SessionMarkdownHistory): boolean {
  const page = history.page
  if (!page) return true
  return page.historyComplete !== false
    && page.hasMore !== true
    && page.nextCursor == null
    && page.previousCursor == null
    && !page.contentTruncated
    && page.omittedOversizedEntries === 0
}

export function buildSessionMarkdown(title: string, history: SessionMarkdownHistory): string {
  const sections = history.messages.map((message) => {
    const body = messageBody(message)
    const timestamp = message.timestamp ? ` · ${message.timestamp}` : ''
    const heading = `## ${messageLabel(message)}${timestamp}`
    return body ? `${heading}\n\n${body}` : heading
  })
  return [`# ${title.trim() || 'Untitled session'}`, ...sections].join('\n\n').trimEnd() + '\n'
}

export function sanitizeSessionFilename(title: string): string {
  const normalized = title
    .replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '')
    .trim()
  const truncated = Array.from(normalized)
    .slice(0, MAX_FILENAME_CODE_POINTS)
    .join('')
    .replace(/[. ]+$/g, '')
    .trim()
  if (!truncated) return 'session.md'
  const stem = WINDOWS_RESERVED_FILENAME_RE.test(truncated) ? `session-${truncated}` : truncated
  return `${stem}.md`
}

export function downloadTextFile(content: string, filename: string): void {
  const url = URL.createObjectURL(new Blob([content], { type: 'text/markdown;charset=utf-8' }))
  const revoke = typeof URL.revokeObjectURL === 'function' ? URL.revokeObjectURL.bind(URL) : undefined
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  link.remove()
  if (revoke) setTimeout(() => revoke(url), 1000)
}

export async function runSessionMarkdownAction({
  sessionId,
  title,
  mode,
  addToast,
  t,
}: RunSessionMarkdownActionOptions): Promise<boolean> {
  if (!sessionId || inFlightSessionMarkdownActions.has(sessionId)) return false
  inFlightSessionMarkdownActions.add(sessionId)
  try {
    const history = await sessionsApi.getFullHistory(sessionId)
    if (!isCompleteSessionHistory(history)) {
      addToast({ type: 'error', message: t('sidebar.markdownHistoryIncomplete') })
      return false
    }
    const resolvedTitle = title.trim() || t('tabs.untitled')
    const markdown = buildSessionMarkdown(resolvedTitle, history)
    if (mode === 'copy') {
      if (!await copyTextToClipboard(markdown)) throw new Error('clipboard')
      addToast({ type: 'success', message: t('sidebar.markdownCopied') })
    } else {
      downloadTextFile(markdown, sanitizeSessionFilename(resolvedTitle))
      addToast({ type: 'success', message: t('sidebar.markdownExported') })
    }
    return true
  } catch {
    addToast({
      type: 'error',
      message: t(mode === 'copy' ? 'sidebar.markdownCopyFailed' : 'sidebar.markdownExportFailed'),
    })
    return false
  } finally {
    inFlightSessionMarkdownActions.delete(sessionId)
  }
}
