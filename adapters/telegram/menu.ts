import { t } from '../common/i18n.js'

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

/**
 * Built lazily: the descriptions must follow the language that is active when
 * the menu is synced, not the process default at import time.
 */
export function telegramBotCommands(): TelegramBotCommand[] {
  return [
    { command: 'start', description: t('telegram.cmd.start') },
    { command: 'help', description: t('telegram.cmd.help') },
    { command: 'new', description: t('telegram.cmd.new') },
    { command: 'projects', description: t('telegram.cmd.projects') },
    { command: 'sessions', description: t('telegram.cmd.sessions') },
    { command: 'resume', description: t('telegram.cmd.resume') },
    { command: 'status', description: t('telegram.cmd.status') },
    { command: 'clear', description: t('telegram.cmd.clear') },
    { command: 'stop', description: t('telegram.cmd.stop') },
    { command: 'provider', description: t('telegram.cmd.provider') },
    { command: 'model', description: t('telegram.cmd.model') },
    { command: 'skills', description: t('telegram.cmd.skills') },
    { command: 'allow', description: t('telegram.cmd.allow') },
    { command: 'always', description: t('telegram.cmd.always') },
    { command: 'deny', description: t('telegram.cmd.deny') },
    { command: 'language', description: t('telegram.cmd.language') },
  ]
}

export async function syncTelegramBotCommands(
  api: TelegramCommandApi,
  commands: TelegramBotCommand[] = telegramBotCommands(),
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
        text: t('telegram.prev'),
        callbackData: `tgsel:${params.kind}:page:${page - 1}`,
      })
    }
    nav.push({
      text: `${page + 1}/${totalPages}`,
      callbackData: `tgsel:${params.kind}:noop:${page}`,
    })
    if (page < totalPages - 1) {
      nav.push({
        text: t('telegram.next'),
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
  const chars = Array.from(label.trim() || t('common.choose'))
  if (chars.length <= TELEGRAM_BUTTON_LABEL_LIMIT) return chars.join('')
  return `${chars.slice(0, TELEGRAM_BUTTON_LABEL_LIMIT - 1).join('')}…`
}
