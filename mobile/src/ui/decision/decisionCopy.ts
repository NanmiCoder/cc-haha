/**
 * 审批底座的文案与摘要。只读工具输入里真实存在的字段；拿不到的信息不显示。
 */
export type ToolKind = 'command' | 'edit' | 'write' | 'web' | 'read' | 'other'

const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'NotebookEdit'])
const READ_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS', 'NotebookRead'])

export function toolKind(toolName: string): ToolKind {
  if (toolName === 'Bash' || toolName === 'PowerShell') return 'command'
  if (EDIT_TOOLS.has(toolName)) return 'edit'
  // Write 可能新建也可能覆盖已有文件，协议里没有区分。
  if (toolName === 'Write') return 'write'
  if (toolName === 'WebFetch' || toolName === 'WebSearch') return 'web'
  if (READ_TOOLS.has(toolName)) return 'read'
  return 'other'
}

/** 文件类审批（Edit/MultiEdit/NotebookEdit/Write）用更高的底座和 diff。 */
export const isFileChange = (toolName: string) =>
  ['edit', 'write'].includes(toolKind(toolName))

export function approvalTitle(toolName: string) {
  switch (toolKind(toolName)) {
    case 'command':
      return '想运行命令'
    case 'edit':
      return '想修改文件'
    case 'write':
      return '想写入文件'
    case 'web':
      return '想联网'
    case 'read':
      return '想读取文件'
    default:
      return `想使用 ${toolName}`
  }
}

export function denyTitle(toolName: string) {
  switch (toolKind(toolName)) {
    case 'command':
      return '不运行这条命令'
    case 'edit':
      return '不修改这个文件'
    case 'write':
      return '不写入这个文件'
    case 'web':
      return toolName === 'WebSearch' ? '不做这次搜索' : '不打开这个网页'
    case 'read':
      return toolName === 'Read' ? '不读取这个文件' : '不做这次查找'
    default:
      return `不使用 ${toolName}`
  }
}

const DENY_VERBS: Record<ToolKind, string> = {
  command: '跑',
  edit: '改',
  write: '写',
  web: '联网',
  read: '读',
  other: '用',
}

export function denySuggestions(toolName: string) {
  return [`先说说为什么要${DENY_VERBS[toolKind(toolName)]}`, '换个更稳妥的做法']
}

/**
 * rule:'always' 在服务端套用 CLI 给出的会话级建议（Bash 是电脑算出的命令前缀或整条命令，
 * WebFetch 是域名，读取是目录）；CLI 没给建议时才整体放行这个工具。手机拿不到这些建议，
 * 所以文案只说“同类”，不编造具体前缀。
 */
export function rememberLabel(toolName: string) {
  switch (toolKind(toolName)) {
    case 'command':
      return '这段会话里，同类命令不再问我'
    case 'edit':
    case 'write':
      // rule:'always' 让电脑按 CLI 的建议放行：询问/计划模式下切到自动接受编辑，
      // 工作区外的文件则加入允许目录；不会把“自动”模式降级。
      return '这段会话里，同类修改不再问我'
    case 'web':
      return toolName === 'WebSearch'
        ? '这段会话里，联网搜索不再问我'
        : '这段会话里，同一网站不再问我'
    case 'read':
      return '这段会话里，读取同一位置不再问我'
    default:
      return `这段会话里不再询问 ${toolName}`
  }
}

const text = (value: unknown) =>
  typeof value === 'string' && value.trim() ? value : undefined

/** 底座代码块里展示的内容：命令、路径、网址或查询；其他工具退回 JSON。 */
export function approvalSubject(
  toolName: string,
  input: Record<string, unknown>
): { text: string; prompt?: string } {
  const kind = toolKind(toolName)
  if (kind === 'command' && text(input.command))
    return { text: String(input.command), prompt: '$ ' }
  const value =
    kind === 'edit' || kind === 'write'
      ? (text(input.file_path) ?? text(input.notebook_path))
      : kind === 'web'
        ? (text(input.url) ?? text(input.query))
        : kind === 'read'
          ? (text(input.file_path) ??
            text(input.pattern) ??
            text(input.path) ??
            text(input.notebook_path))
          : undefined
  if (value) return { text: value }
  const json = JSON.stringify(input, null, 2) ?? ''
  return { text: json.length > 600 ? `${json.slice(0, 600)}…` : json }
}

/** 拒绝态的一行摘要：命令带 “$ ”，只取第一行。 */
export function denySummary(toolName: string, input: Record<string, unknown>) {
  const subject = approvalSubject(toolName, input)
  const firstLine = subject.text.split('\n')[0] ?? ''
  return `${subject.prompt ?? ''}${firstLine}`
}

/** Bash 自己写的 description（例如“跑会话传输的单元测试”）优先于协议的 description。 */
export function approvalDescription(
  description: string | undefined,
  input: Record<string, unknown>
) {
  return text(description) ?? text(input.description)
}

/** “在 ~/code/cc-haha”：把用户主目录缩写成 ~，拿不到工作目录时不显示。 */
export function workDirCaption(workDir?: string | null) {
  const value = workDir?.trim()
  if (!value) return undefined
  const short = value
    .replace(/^\/Users\/[^/]+(?=\/|$)/, '~')
    .replace(/^\/home\/[^/]+(?=\/|$)/, '~')
    .replace(/^[A-Za-z]:\\Users\\[^\\]+(?=\\|$)/, '~')
  return `在 ${short}`
}

/** 快捷说明：输入框为空时直接填入，否则接在末尾。 */
export function appendSuggestion(current: string, suggestion: string) {
  const trimmed = current.trimEnd()
  if (!trimmed) return suggestion
  if (trimmed.includes(suggestion)) return trimmed
  return /[。！？.!?，,；;：:]$/.test(trimmed)
    ? `${trimmed}${suggestion}`
    : `${trimmed}。${suggestion}`
}
