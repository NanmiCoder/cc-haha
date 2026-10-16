export const TAB_BEHAVIOR_STORAGE_KEY = 'cc-haha-tab-behavior'
export const TAB_BEHAVIOR_VERSION = 1

/** Presets rather than a free number: each is a count people actually keep. */
export const SESSION_TAB_LIMIT_OPTIONS = [5, 8, 12, 20] as const
export type SessionTabLimit = (typeof SESSION_TAB_LIMIT_OPTIONS)[number]

export type TabBehavior = {
  /** Most chat tabs kept open; `null` keeps every tab until it is closed by hand. */
  sessionTabLimit: SessionTabLimit | null
  restoreOnLaunch: boolean
}

/** Today's behavior, so nobody's tab strip changes until they opt in. */
export const DEFAULT_TAB_BEHAVIOR: TabBehavior = { sessionTabLimit: null, restoreOnLaunch: true }

type TabBehaviorStorage = Pick<Storage, 'getItem' | 'setItem'>

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isSessionTabLimit(value: unknown): value is SessionTabLimit {
  return SESSION_TAB_LIMIT_OPTIONS.includes(value as SessionTabLimit)
}

export function normalizeTabBehavior(value: unknown): TabBehavior {
  const record = isRecord(value) ? value : {}
  return {
    sessionTabLimit: isSessionTabLimit(record.sessionTabLimit) ? record.sessionTabLimit : null,
    restoreOnLaunch: record.restoreOnLaunch !== false,
  }
}

function getStorage(): TabBehaviorStorage | null {
  try { return globalThis.localStorage ?? null } catch { return null }
}

function parseStored(storage: TabBehaviorStorage | null): Record<string, unknown> | null {
  try {
    const raw = storage?.getItem(TAB_BEHAVIOR_STORAGE_KEY)
    if (!raw) return null
    const value: unknown = JSON.parse(raw)
    return isRecord(value) ? value : null
  } catch { return null }
}

/**
 * A missing or unreadable record is the default. A record from a newer build
 * is read as the default and left in place, so a downgrade cannot rewrite it.
 */
export function readTabBehavior(storage: TabBehaviorStorage | null = getStorage()): TabBehavior {
  const value = parseStored(storage)
  if (value?.version !== undefined && value.version !== TAB_BEHAVIOR_VERSION) return { ...DEFAULT_TAB_BEHAVIOR }
  return normalizeTabBehavior(value)
}

export function persistTabBehavior(behavior: TabBehavior, storage: TabBehaviorStorage | null = getStorage()): void {
  try {
    storage?.setItem(TAB_BEHAVIOR_STORAGE_KEY, JSON.stringify({ version: TAB_BEHAVIOR_VERSION, ...normalizeTabBehavior(behavior) }))
  } catch { /* noop */ }
}
