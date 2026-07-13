/**
 * 消息格式化工具
 */

type AdapterChatState =
  | 'idle'
  | 'thinking'
  | 'streaming'
  | 'tool_executing'
  | 'permission_pending'

type ImStatusSummary = {
  sessionId?: string
  projectName?: string | null
  branch?: string | null
  model?: string | null
  state?: AdapterChatState | null
  verb?: string | null
  pendingPermissionCount?: number
  taskCounts?: {
    total: number
    pending: number
    inProgress: number
    completed: number
  }
}

const IM_HELP_LINES = [
  '/new [项目] / 新会话 — 新建会话或切换项目',
  '/projects / 项目列表 — 查看最近项目',
  '/status / 状态 — 查看当前会话状态',
  '/clear / 清空 — 清空当前会话上下文',
  '/stop / 停止 — 停止当前生成',
  '/help / 帮助 — 显示这份帮助',
  '权限审批：/allow <id>、/always <id>、/deny <id>',
]

/** Split text into chunks that fit within a character limit, respecting paragraph/sentence boundaries. */
export function splitMessage(text: string, limit: number): string[] {
  if (text.length <= limit) return [text]

  const chunks: string[] = []
  let remaining = text

  while (remaining.length > 0) {
    if (remaining.length <= limit) {
      chunks.push(remaining)
      break
    }

    let splitAt = remaining.lastIndexOf('\n\n', limit)
    if (splitAt <= 0) splitAt = remaining.lastIndexOf('\n', limit)
    if (splitAt <= 0) splitAt = remaining.lastIndexOf('. ', limit)
    if (splitAt <= 0) splitAt = remaining.lastIndexOf(' ', limit)
    if (splitAt <= 0) splitAt = limit

    // Include the delimiter for paragraph/sentence breaks
    if (remaining[splitAt] === '\n' || remaining[splitAt] === '.') splitAt += 1

    chunks.push(remaining.slice(0, splitAt).trimEnd())
    remaining = remaining.slice(splitAt).trimStart()
  }

  return chunks
}

type MarkdownTable = {
  headers: string[]
  rows: string[][]
}

function splitMarkdownTableRow(line: string): string[] {
  const trimmed = line.trim()
  const inner = trimmed.startsWith('|') ? trimmed.slice(1) : trimmed
  const withoutTrailingPipe = inner.endsWith('|') ? inner.slice(0, -1) : inner
  return withoutTrailingPipe.split('|').map((cell) => cell.trim())
}

function isMarkdownTableDivider(line: string): boolean {
  const cells = splitMarkdownTableRow(line)
  if (cells.length < 2) return false
  return cells.every((cell) => /^:?-{3,}:?$/.test(cell.trim()))
}

function isPotentialMarkdownTableRow(line: string): boolean {
  const trimmed = line.trim()
  return trimmed.includes('|') && splitMarkdownTableRow(trimmed).length >= 2
}

function isFenceMarker(line: string): boolean {
  return /^\s*(```|~~~)/.test(line)
}

function formatMarkdownTableAsBullets(table: MarkdownTable): string {
  const { headers, rows } = table
  if (headers.length === 0 || rows.length === 0) return ''

  const output: string[] = []

  for (const row of rows) {
    if (row.every((cell) => !cell)) continue

    const label = row[0]
    if (label) output.push(label)

    for (let i = 1; i < Math.max(headers.length, row.length); i++) {
      const value = row[i]
      if (!value) continue
      const header = headers[i]
      output.push(`• ${header ? `${header}: ` : `Column ${i}: `}${value}`)
    }

    if (output[output.length - 1] !== '') output.push('')
  }

  while (output[output.length - 1] === '') output.pop()
  return output.join('\n')
}

/** Convert GitHub-flavored Markdown pipe tables into mobile-friendly bullet lists. */
export function convertMarkdownTablesToBullets(markdown: string): string {
  const lines = markdown.split('\n')
  const output: string[] = []
  let inFence = false
  let i = 0

  while (i < lines.length) {
    const headerLine = lines[i] ?? ''

    if (isFenceMarker(headerLine)) {
      inFence = !inFence
      output.push(headerLine)
      i += 1
      continue
    }

    const dividerLine = lines[i + 1] ?? ''
    if (!inFence && isPotentialMarkdownTableRow(headerLine) && isMarkdownTableDivider(dividerLine)) {
      const headers = splitMarkdownTableRow(headerLine)
      const rows: string[][] = []
      i += 2

      while (i < lines.length && isPotentialMarkdownTableRow(lines[i] ?? '')) {
        rows.push(splitMarkdownTableRow(lines[i] ?? ''))
        i += 1
      }

      const rendered = formatMarkdownTableAsBullets({ headers, rows })
      if (rendered) output.push(rendered)
      continue
    }

    output.push(headerLine)
    i += 1
  }

  return output.join('\n')
}

/** Format tool use info for display in IM. */
export function formatToolUse(toolName: string, input: unknown): string {
  const inp = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
  const summary = formatToolSummary(toolName, inp)
  if (summary) return `🔧 ${toolName}  ${summary}`
  const preview = truncateInput(input, 200)
  return `🔧 ${toolName}\n${preview}`
}

/** Generate a concise human-readable summary for common tools. */
function formatToolSummary(tool: string, inp: Record<string, unknown>): string | null {
  switch (tool) {
    case 'Bash': {
      const desc = inp.description as string | undefined
      const cmd = inp.command as string | undefined
      if (desc) return desc
      if (cmd) return truncate(cmd, 120)
      return null
    }
    case 'Read': {
      const fp = inp.file_path as string | undefined
      if (fp) return shortPath(fp)
      return null
    }
    case 'Edit': {
      const fp = inp.file_path as string | undefined
      if (fp) return shortPath(fp)
      return null
    }
    case 'Write': {
      const fp = inp.file_path as string | undefined
      if (fp) return shortPath(fp)
      return null
    }
    case 'Grep': {
      const pat = inp.pattern as string | undefined
      const p = inp.path as string | undefined
      if (pat) return `"${truncate(pat, 60)}"` + (p ? ` in ${shortPath(p)}` : '')
      return null
    }
    case 'Glob': {
      const pat = inp.pattern as string | undefined
      return pat ? `"${pat}"` : null
    }
    case 'Skill': {
      const skill = inp.skill as string | undefined
      return skill || null
    }
    case 'Agent': {
      const desc = inp.description as string | undefined
      return desc || null
    }
    case 'WebFetch': {
      const url = inp.url as string | undefined
      return url ? truncate(url, 120) : null
    }
    case 'WebSearch': {
      const q = inp.query as string | undefined
      return q ? `"${truncate(q, 80)}"` : null
    }
    default:
      return null
  }
}

function shortPath(fp: string): string {
  const parts = fp.replaceAll('\\', '/').split('/')
  return parts.length > 3 ? '…/' + parts.slice(-3).join('/') : fp
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '…' : s
}

/** Format a permission request for display in IM. */
export function formatPermissionRequest(toolName: string, input: unknown, requestId: string): string {
  const preview = truncateInput(input, 300)
  return `🔐 需要权限确认 [${requestId}]\n工具: ${toolName}\n${preview}`
}

/** Truncate tool input to a preview string. */
export function truncateInput(input: unknown, maxLen: number): string {
  try {
    const s = typeof input === 'string' ? input : JSON.stringify(input, null, 2)
    return s.length > maxLen ? s.slice(0, maxLen) + '…' : s
  } catch {
    return '(unserializable)'
  }
}

/** Escape special characters for Telegram MarkdownV2. */
export function escapeMarkdownV2(text: string): string {
  return text.replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, '\\$1')
}

export function formatImHelp(): string {
  return `可用命令：\n\n${IM_HELP_LINES.join('\n')}`
}

export function formatImStatus(summary: ImStatusSummary | null): string {
  if (!summary?.sessionId) {
    return '当前没有活动会话。\n\n发送 /new 新建会话，或发送 /projects 选择项目。'
  }

  const lines = ['当前会话状态：']

  if (summary.projectName) {
    lines.push(`项目: ${summary.projectName}${summary.branch ? ` (${summary.branch})` : ''}`)
  } else if (summary.branch) {
    lines.push(`分支: ${summary.branch}`)
  }

  lines.push(`会话: ${shortSessionId(summary.sessionId)}`)

  if (summary.model) {
    lines.push(`模型: ${summary.model}`)
  }

  lines.push(`状态: ${formatAdapterChatState(summary.state, summary.verb)}`)

  const pendingPermissionCount = summary.pendingPermissionCount ?? 0
  if (pendingPermissionCount > 0) {
    lines.push(`审批: ${pendingPermissionCount} 个待确认`)
  }

  const taskCounts = summary.taskCounts
  if (taskCounts && taskCounts.total > 0) {
    const taskParts = [`总计 ${taskCounts.total}`]
    if (taskCounts.inProgress > 0) taskParts.push(`进行中 ${taskCounts.inProgress}`)
    if (taskCounts.pending > 0) taskParts.push(`待处理 ${taskCounts.pending}`)
    if (taskCounts.completed > 0) taskParts.push(`已完成 ${taskCounts.completed}`)
    lines.push(`任务: ${taskParts.join(' · ')}`)
  }

  return lines.join('\n')
}

function formatAdapterChatState(
  state: AdapterChatState | null | undefined,
  verb: string | null | undefined,
): string {
  const label = (() => {
    switch (state) {
      case 'thinking':
        return '思考中'
      case 'streaming':
        return '生成中'
      case 'tool_executing':
        return '执行工具中'
      case 'permission_pending':
        return '等待权限确认'
      case 'idle':
      default:
        return '空闲'
    }
  })()

  if (!verb || verb === 'Thinking') return label
  return `${label} (${verb})`
}

function shortSessionId(sessionId: string): string {
  return sessionId.length > 12 ? `${sessionId.slice(0, 8)}…` : sessionId
}
