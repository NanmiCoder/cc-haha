import type { MessageEntry, SessionHistoryPage } from '@/types/session'

type HistoryCompleteness = Pick<NonNullable<SessionHistoryPage['page']>, 'historyComplete' | 'contentTruncated' | 'omittedOversizedEntries'>
  & Partial<Pick<NonNullable<SessionHistoryPage['page']>, 'hasMore' | 'nextCursor'>>
export type SessionMarkdownHistory = { messages: MessageEntry[]; page?: HistoryCompleteness }

function contentToMarkdown(content: unknown, indent = ''): string {
  if (content === null || content === undefined) return ''
  if (typeof content === 'string') return content
  if (typeof content === 'number' || typeof content === 'boolean') return String(content)
  if (Array.isArray(content)) {
    return content
      .map((item) => contentToMarkdown(item, indent))
      .filter(Boolean)
      .join('\n')
  }
  if (typeof content === 'object') {
    const record = content as Record<string, unknown>
    if (typeof record.text === 'string') return record.text
    if ('content' in record) {
      const nested = contentToMarkdown(record.content, indent)
      if (nested) return nested
    }
    return `\n${indent}\`\`\`json\n${JSON.stringify(content, null, 2)}\n${indent}\`\`\``
  }
  return ''
}

function messageLabel(type: MessageEntry['type']): string {
  switch (type) {
    case 'user': return 'User'
    case 'assistant': return 'Assistant'
    case 'system': return 'System'
    case 'tool_use': return 'Tool use'
    case 'tool_result': return 'Tool result'
  }
}

function messageBody(message: MessageEntry): string {
  const content = contentToMarkdown(message.content).trim()
  if (message.type !== 'tool_use' && message.type !== 'tool_result') return content

  const details: string[] = []
  if (content) details.push(content)
  if (message.toolUseResult !== undefined) {
    const result = contentToMarkdown(message.toolUseResult).trim()
    if (result) details.push(result)
  }
  return details.join('\n\n')
}

export function isCompleteSessionHistory(history: SessionMarkdownHistory): boolean {
  const page = history.page
  if (!page) return true
  return page.historyComplete !== false
    && page.hasMore !== true
    && page.nextCursor == null
    && !page.contentTruncated
    && page.omittedOversizedEntries === 0
}

export function buildSessionMarkdown(title: string, history: SessionMarkdownHistory): string {
  const sections = history.messages.map((message) => {
    const body = messageBody(message)
    const timestamp = message.timestamp ? ` · ${message.timestamp}` : ''
    return `## ${messageLabel(message.type)}${timestamp}\n\n${body}`.trimEnd()
  })
  return [`# ${title.trim() || 'Untitled session'}`, ...sections].join('\n\n').trimEnd() + '\n'
}

export function sanitizeSessionFilename(title: string): string {
  const safe = title
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
    .replace(/[. ]+$/g, '')
    .trim()
    .replace(/\s+/g, ' ')
  return `${safe || 'session'}.md`
}

export function downloadTextFile(content: string, filename: string): void {
  const url = URL.createObjectURL(new Blob([content], { type: 'text/markdown;charset=utf-8' }))
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
