export const CHAT_APPEARANCE_STORAGE_KEY = 'cc-haha-chat-appearance'
export const CHAT_APPEARANCE_VERSION = 1

export type ChatAppearance = {
  font: 'system' | 'sans' | 'serif' | 'mono'
  fontSize: number
  width: 'standard' | 'wide' | 'full'
}

export const DEFAULT_CHAT_APPEARANCE: ChatAppearance = { font: 'system', fontSize: 14, width: 'standard' }
export type AppearanceStorage = Pick<Storage, 'getItem' | 'setItem'>

const FONT_STACKS: Record<ChatAppearance['font'], string> = {
  system: '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei UI", "Microsoft YaHei", sans-serif',
  sans: 'Arial, "PingFang SC", "Microsoft YaHei UI", "Microsoft YaHei", sans-serif',
  serif: 'Georgia, "Songti SC", "Source Han Serif SC", "Noto Serif CJK SC", SimSun, serif',
  mono: '"JetBrains Mono", ui-monospace, Menlo, Consolas, "PingFang SC", "Microsoft YaHei", monospace',
}
const WIDTHS = { standard: '900px', wide: '1200px', full: '100%' }

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function normalizeChatAppearance(value: unknown): ChatAppearance {
  const record = isRecord(value) ? value : {}
  return {
    font: record.font === 'sans' || record.font === 'serif' || record.font === 'mono' ? record.font : 'system',
    fontSize: typeof record.fontSize === 'number' && Number.isFinite(record.fontSize)
      ? Math.round(Math.min(24, Math.max(12, record.fontSize))) : 14,
    width: record.width === 'wide' || record.width === 'full' ? record.width : 'standard',
  }
}

export function getAppearanceStorage(): AppearanceStorage | null {
  try { return globalThis.localStorage ?? null } catch { return null }
}

function parseStored(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null
  try {
    const value: unknown = JSON.parse(raw)
    return isRecord(value) ? value : null
  } catch { return null }
}

function isFutureVersion(value: Record<string, unknown> | null): boolean {
  return value?.version !== undefined && value.version !== CHAT_APPEARANCE_VERSION
}

export function readChatAppearance(storage: AppearanceStorage | null = getAppearanceStorage()): ChatAppearance {
  try {
    const value = parseStored(storage?.getItem(CHAT_APPEARANCE_STORAGE_KEY) ?? null)
    return normalizeChatAppearance(isFutureVersion(value) ? null : value)
  } catch { return { ...DEFAULT_CHAT_APPEARANCE } }
}

/** Upgrade the pre-feature fixture (missing key) without touching other UI preferences.
 * Unversioned data is normalized; unknown versions are left intact for newer builds.
 */
export function migrateChatAppearance(storage: AppearanceStorage): boolean {
  const raw = storage.getItem(CHAT_APPEARANCE_STORAGE_KEY)
  const value = parseStored(raw)
  if (isFutureVersion(value)) return false
  const next = JSON.stringify({ ...value, version: CHAT_APPEARANCE_VERSION, ...normalizeChatAppearance(value) })
  if (raw === next) return false
  storage.setItem(CHAT_APPEARANCE_STORAGE_KEY, next)
  return true
}

export function persistChatAppearance(appearance: ChatAppearance, storage: AppearanceStorage | null = getAppearanceStorage()): void {
  if (!storage) return
  try {
    const value = parseStored(storage.getItem(CHAT_APPEARANCE_STORAGE_KEY))
    if (isFutureVersion(value)) return
    storage.setItem(CHAT_APPEARANCE_STORAGE_KEY, JSON.stringify({ ...value, version: CHAT_APPEARANCE_VERSION, ...normalizeChatAppearance(appearance) }))
  } catch { /* Keep controls usable when storage is unavailable. */ }
}

export function getChatAppearanceStyle(appearance: ChatAppearance): Record<string, string> {
  const normalized = normalizeChatAppearance(appearance)
  return {
    '--chat-font-family': FONT_STACKS[normalized.font],
    '--chat-font-size': `${normalized.fontSize}px`,
    '--chat-content-max-width': WIDTHS[normalized.width],
  }
}

export function applyChatAppearance(appearance: ChatAppearance): void {
  if (typeof document === 'undefined') return
  for (const [name, value] of Object.entries(getChatAppearanceStyle(appearance))) {
    document.documentElement.style.setProperty(name, value)
  }
}
