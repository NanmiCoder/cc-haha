import type { MessageEntry } from '../types/session'

export type ExportFormat = 'markdown' | 'html' | 'txt'

export type ExportNode = {
  index: number
  subtype: string
  timestamp: string
  label: string
}

const COMPACT_SUBTYPES = new Set(['compact_boundary', 'microcompact_boundary'])

export function isCompactBoundaryEntry(entry: MessageEntry): boolean {
  return entry.type === 'system' && entry.subtype != null && COMPACT_SUBTYPES.has(entry.subtype)
}

export function collectExportNodes(messages: MessageEntry[]): ExportNode[] {
  const nodes: ExportNode[] = []
  messages.forEach((entry, index) => {
    if (isCompactBoundaryEntry(entry)) {
      nodes.push({
        index,
        subtype: entry.subtype ?? 'compact_boundary',
        timestamp: entry.timestamp,
        label: formatNodeLabel(entry),
      })
    }
  })
  return nodes
}

function formatNodeLabel(entry: MessageEntry): string {
  const time = entry.timestamp ? new Date(entry.timestamp).toLocaleString() : ''
  const text = extractText(entry)
  const summary = text && text.trim() ? text.trim().slice(0, 40) : '上下文已压缩'
  return `${time} — ${summary}`
}

function extractText(entry: MessageEntry): string {
  const content = entry.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter((block): block is Record<string, unknown> => !!block && typeof block === 'object')
      .map((block) => (typeof block.text === 'string' ? block.text : ''))
      .filter(Boolean)
      .join('\n\n')
  }
  return ''
}

function extractToolName(block: Record<string, unknown>): string {
  if (block.type === 'tool_use') {
    const name = block.name
    return typeof name === 'string' ? name : 'tool'
  }
  if (block.type === 'tool_result') {
    const toolUseId = block.tool_use_id
    return typeof toolUseId === 'string' ? `tool_result(${toolUseId.slice(0, 8)})` : 'tool_result'
  }
  return String(block.type ?? '')
}

function serializeBlockContent(block: Record<string, unknown>): string {
  const text = typeof block.text === 'string' ? block.text : ''
  const input = block.input
  let json = ''
  if (input !== undefined && input !== null) {
    try {
      json = JSON.stringify(input, null, 2)
    } catch {
      json = String(input)
    }
  }
  return text && json ? `${text}\n\`\`\`json\n${json}\n\`\`\`` : text || json
}

function entryToString(entry: MessageEntry): string {
  const content = entry.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter((block): block is Record<string, unknown> => !!block && typeof block === 'object')
      .map((block) => {
        const prefix = block.type === 'tool_use' || block.type === 'tool_result'
          ? `[${extractToolName(block)}]\n`
          : ''
        return prefix + serializeBlockContent(block)
      })
      .filter(Boolean)
      .join('\n\n')
  }
  return ''
}

/** Render a range of messages to Markdown. */
export function renderMessagesToMarkdown(messages: MessageEntry[]): string {
  const lines: string[] = []
  for (const entry of messages) {
    if (isCompactBoundaryEntry(entry)) {
      const time = entry.timestamp ? ` (${new Date(entry.timestamp).toLocaleString()})` : ''
      lines.push(`> **${extractText(entry) || '上下文已压缩'}**${time}`)
      continue
    }
    const body = entryToString(entry).trim()
    if (!body) continue
    switch (entry.type) {
      case 'user':
        lines.push(`> ${body.replace(/\n/g, '\n> ')}`)
        break
      case 'assistant':
        lines.push(body)
        break
      case 'system':
        lines.push(`*${body}*`)
        break
      case 'tool_use':
      case 'tool_result':
        lines.push(`\`\`\`\n${body}\n\`\`\``)
        break
    }
    lines.push('')
  }
  return lines.join('\n')
}

/** Render a range of messages to plain text (mirrors the CLI /export output). */
export function renderMessagesToPlainText(messages: MessageEntry[]): string {
  const lines: string[] = []
  for (const entry of messages) {
    if (isCompactBoundaryEntry(entry)) {
      const time = entry.timestamp ? ` (${new Date(entry.timestamp).toLocaleString()})` : ''
      lines.push(`[${extractText(entry) || '上下文已压缩'}${time}]`)
      continue
    }
    const body = entryToString(entry).trim()
    if (!body) continue
    lines.push(body)
    lines.push('')
  }
  return lines.join('\n')
}

const EXPORT_HTML_STYLE = `
  :root { color-scheme: light dark; }
  body { font-family: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif; line-height: 1.7; margin: 0 auto; max-width: 860px; padding: 40px 24px; color: #1f2328; background: #ffffff; }
  h1 { font-size: 22px; border-bottom: 1px solid #d0d7de; padding-bottom: 12px; }
  .msg { margin: 18px 0; padding: 12px 16px; border-radius: 8px; }
  .user { background: #f6f8fa; border-left: 4px solid #0969da; }
  .assistant { background: #f0f7ff; border-left: 4px solid #1f883d; }
  .system { background: #fff8c5; border-left: 4px solid #d4a72c; }
  .tool { background: #f6f8fa; border-left: 4px solid #6e7781; }
  .tool pre { background: #1f2328; color: #e6edf3; padding: 12px; border-radius: 6px; overflow-x: auto; }
  .boundary { margin: 18px 0; padding: 8px 12px; background: #f6f8fa; border: 1px dashed #d0d7de; border-radius: 6px; font-style: italic; color: #57606a; }
  pre, code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  blockquote { margin: 0; }
  blockquote p { margin: 0 0 8px; }
  @media (prefers-color-scheme: dark) { body { background: #0d1117; color: #e6edf3; } h1 { border-color: #30363d; } .user { background: #161b22; border-color: #4493f8; } .assistant { background: #0f2417; border-color: #3fb950; } .system { background: #2a2410; border-color: #d4a72c; } .tool { background: #161b22; border-color: #8b949e; } .boundary { background: #161b22; border-color: #30363d; color: #8b949e; } .tool pre { background: #010409; color: #e6edf3; } }
`

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function renderBlockHtml(block: Record<string, unknown>): string {
  const prefix = block.type === 'tool_use' || block.type === 'tool_result'
    ? `<div class="tool-head"><code>${escapeHtml(extractToolName(block))}</code></div>`
    : ''
  const text = typeof block.text === 'string' ? escapeHtml(block.text) : ''
  const input = block.input
  let json = ''
  if (input !== undefined && input !== null) {
    try {
      json = escapeHtml(JSON.stringify(input, null, 2))
    } catch {
      json = escapeHtml(String(input))
    }
  }
  const body = [
    text ? `<p>${text.replace(/\n/g, '<br/>')}</p>` : '',
    json ? `<pre><code>${json}</code></pre>` : '',
  ].join('')
  return prefix + body
}

/** Render a range of messages to a self-contained HTML document with inline styles. */
export function renderMessagesToHtml(messages: MessageEntry[], title = 'Conversation Export'): string {
  const parts: string[] = []
  for (const entry of messages) {
    if (isCompactBoundaryEntry(entry)) {
      const time = entry.timestamp ? ` (${new Date(entry.timestamp).toLocaleString()})` : ''
      parts.push(`<div class="boundary">${escapeHtml(extractText(entry) || '上下文已压缩')}${escapeHtml(time)}</div>`)
      continue
    }
    const content = entry.content
    if (typeof content === 'string') {
      const body = content.trim()
      if (!body) continue
      const cls = entry.type === 'user' ? 'user' : entry.type === 'assistant' ? 'assistant' : entry.type === 'system' ? 'system' : 'tool'
      parts.push(`<div class="msg ${cls}"><p>${escapeHtml(body).replace(/\n/g, '<br/>')}</p></div>`)
      continue
    }
    if (Array.isArray(content)) {
      const blocks = content.filter((b): b is Record<string, unknown> => !!b && typeof b === 'object')
      const rendered = blocks.map((b) => renderBlockHtml(b)).join('')
      if (!rendered.trim()) continue
      const cls = entry.type === 'user' ? 'user' : entry.type === 'assistant' ? 'assistant' : entry.type === 'system' ? 'system' : 'tool'
      parts.push(`<div class="msg ${cls}">${rendered}</div>`)
    }
  }
  return `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${escapeHtml(title)}</title>
<style>${EXPORT_HTML_STYLE}</style>
</head>
<body>
<h1>${escapeHtml(title)}</h1>
${parts.join('\n')}
</body>
</html>`
}

export function formatExportFilename(baseName: string, format: ExportFormat, timestamp = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  const stamp = `${timestamp.getFullYear()}-${pad(timestamp.getMonth() + 1)}-${pad(timestamp.getDate())}-${pad(timestamp.getHours())}${pad(timestamp.getMinutes())}${pad(timestamp.getSeconds())}`
  const ext = format === 'markdown' ? 'md' : format === 'html' ? 'html' : 'txt'
  const safe = baseName.replace(/[^a-z0-9\u4e00-\u9fa5\s-]/gi, '').replace(/\s+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '')
  return `${stamp}-${safe || 'conversation'}.${ext}`
}

export function downloadExport(content: string, filename: string): void {
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  URL.revokeObjectURL(url)
}
