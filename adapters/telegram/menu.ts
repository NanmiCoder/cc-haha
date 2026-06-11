export type TelegramBotCommand = {
  command: string
  description: string
}

export type TelegramSelectionKind =
  | 'provider'
  | 'model'
  | 'resume_project'
  | 'resume_session'
  | 'skill'

export type TelegramSelectionItem = {
  label: string
  value: string
  description?: string
  meta?: Record<string, string>
}

export type TelegramSelectionButton = {
  text: string
  callbackData: string
}

export type TelegramSelectionPage = {
  page: number
  totalPages: number
  visibleItems: Array<TelegramSelectionItem & { index: number }>
  rows: TelegramSelectionButton[][]
}

export type TelegramSelectionCallback =
  | { kind: TelegramSelectionKind; action: 'pick'; index: number }
  | { kind: TelegramSelectionKind; action: 'page'; index: number }
  | { kind: TelegramSelectionKind; action: 'noop'; index: number }

type TelegramCommandApi = {
  deleteMyCommands?: () => Promise<unknown>
  setMyCommands: (commands: TelegramBotCommand[]) => Promise<unknown>
}

const TELEGRAM_SELECTION_PAGE_SIZE = 8
const TELEGRAM_BUTTON_LABEL_LIMIT = 32

export const TELEGRAM_BOT_COMMANDS: TelegramBotCommand[] = [
  { command: 'start', description: '开始使用' },
  { command: 'help', description: '查看帮助' },
  { command: 'new', description: '新建会话或切换项目' },
  { command: 'projects', description: '查看最近项目' },
  { command: 'resume', description: '恢复历史会话' },
  { command: 'status', description: '查看当前状态' },
  { command: 'clear', description: '清空当前上下文' },
  { command: 'stop', description: '停止当前生成' },
  { command: 'provider', description: '切换 Provider' },
  { command: 'model', description: '切换模型' },
  { command: 'skills', description: '查看 Skills' },
  { command: 'allow', description: '允许权限请求' },
  { command: 'always', description: '永久允许权限请求' },
  { command: 'deny', description: '拒绝权限请求' },
]

export async function syncTelegramBotCommands(
  api: TelegramCommandApi,
  commands: TelegramBotCommand[] = TELEGRAM_BOT_COMMANDS,
): Promise<void> {
  if (api.deleteMyCommands) {
    await api.deleteMyCommands()
  }
  await api.setMyCommands(commands)
}

export function buildTelegramSelectionPage(params: {
  kind: TelegramSelectionKind
  items: TelegramSelectionItem[]
  page: number
  pageSize?: number
}): TelegramSelectionPage {
  const pageSize = params.pageSize ?? TELEGRAM_SELECTION_PAGE_SIZE
  const totalPages = Math.max(1, Math.ceil(params.items.length / pageSize))
  const page = clampPage(params.page, totalPages)
  const start = page * pageSize
  const visibleItems = params.items
    .slice(start, start + pageSize)
    .map((item, offset) => ({ ...item, index: start + offset }))

  const rows = visibleItems.map((item) => [
    {
      text: truncateButtonLabel(item.label),
      callbackData: `tgsel:${params.kind}:pick:${item.index}`,
    },
  ])

  if (totalPages > 1) {
    const nav: TelegramSelectionButton[] = []
    if (page > 0) {
      nav.push({
        text: 'Prev',
        callbackData: `tgsel:${params.kind}:page:${page - 1}`,
      })
    }
    nav.push({
      text: `${page + 1}/${totalPages}`,
      callbackData: `tgsel:${params.kind}:noop:${page}`,
    })
    if (page < totalPages - 1) {
      nav.push({
        text: 'Next',
        callbackData: `tgsel:${params.kind}:page:${page + 1}`,
      })
    }
    rows.push(nav)
  }

  return {
    page,
    totalPages,
    visibleItems,
    rows,
  }
}

export function parseTelegramSelectionCallback(data: string): TelegramSelectionCallback | null {
  const match = data.match(/^tgsel:([a-z_]+):(pick|page|noop):(\d+)$/)
  if (!match) return null
  const kind = match[1] as TelegramSelectionKind
  if (!isTelegramSelectionKind(kind)) return null
  const index = Number(match[3])
  if (!Number.isSafeInteger(index) || index < 0) return null
  return {
    kind,
    action: match[2] as TelegramSelectionCallback['action'],
    index,
  } as TelegramSelectionCallback
}

function isTelegramSelectionKind(value: string): value is TelegramSelectionKind {
  return value === 'provider' ||
    value === 'model' ||
    value === 'resume_project' ||
    value === 'resume_session' ||
    value === 'skill'
}

function clampPage(page: number, totalPages: number): number {
  if (!Number.isFinite(page) || page < 0) return 0
  if (page >= totalPages) return totalPages - 1
  return Math.floor(page)
}

function truncateButtonLabel(label: string): string {
  const chars = Array.from(label.trim() || '选择')
  if (chars.length <= TELEGRAM_BUTTON_LABEL_LIMIT) return chars.join('')
  return `${chars.slice(0, TELEGRAM_BUTTON_LABEL_LIMIT - 1).join('')}…`
}
