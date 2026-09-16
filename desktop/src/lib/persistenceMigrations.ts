import { DARK_THEME_MODES, LIGHT_THEME_MODES, THEME_MODES } from '../types/settings'
import {
  WORKSPACE_STORAGE_KEY,
  WORKSPACE_STORAGE_VERSION,
} from './workspace/storageKey'
import {
  APP_ZOOM_STORAGE_KEY,
  LEGACY_UI_ZOOM_STORAGE_KEY,
  isValidStoredAppZoomLevel,
  normalizeAppZoomLevel,
} from './appZoom'

export const CURRENT_DESKTOP_PERSISTENCE_SCHEMA_VERSION = 4
export const DESKTOP_PERSISTENCE_VERSION_KEY = 'cc-haha.persistence.schemaVersion'

type DesktopMigrationReport = {
  migratedKeys: string[]
}

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

const TAB_STORAGE_KEY = 'cc-haha-open-tabs'
const SESSION_RUNTIME_STORAGE_KEY = 'cc-haha-session-runtime'
const THEME_STORAGE_KEY = 'cc-haha-theme'
const FOLLOW_SYSTEM_THEME_STORAGE_KEY = 'cc-haha-follow-system-theme'
const LIGHT_THEME_STORAGE_KEY = 'cc-haha-light-theme'
const DARK_THEME_STORAGE_KEY = 'cc-haha-dark-theme'
const LOCALE_STORAGE_KEY = 'cc-haha-locale'
const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max']
const PERSISTED_SPECIAL_TAB_TYPES = ['settings', 'scheduled', 'market', 'connectors', 'traces'] as const
const PERSISTED_SPECIAL_TAB_IDS: Record<(typeof PERSISTED_SPECIAL_TAB_TYPES)[number], string> = {
  settings: '__settings__',
  scheduled: '__scheduled__',
  market: '__market__',
  connectors: '__connectors__',
  traces: '__traces__',
}
const SUPPORTED_LOCALES = ['en', 'zh', 'zh-TW', 'jp', 'kr']
const WORKSPACE_PERSISTED_TAB_KINDS = ['file', 'browser', 'review', 'terminal']

function readJson(storage: StorageLike, key: string): unknown {
  const raw = storage.getItem(key)
  if (!raw) return null
  return JSON.parse(raw)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function isPersistedSpecialTabType(value: unknown): value is (typeof PERSISTED_SPECIAL_TAB_TYPES)[number] {
  return typeof value === 'string' && (PERSISTED_SPECIAL_TAB_TYPES as readonly string[]).includes(value)
}

function getPersistedSpecialTabType(tab: Record<string, unknown>): (typeof PERSISTED_SPECIAL_TAB_TYPES)[number] | null {
  if (tab.sessionId === '__settings__') return 'settings'
  if (tab.sessionId === '__scheduled__') return 'scheduled'
  if (tab.sessionId === '__connectors__') return 'market'
  if (tab.sessionId === '__market__') return 'market'
  if (tab.sessionId === '__traces__') return 'traces'
  return isPersistedSpecialTabType(tab.type) ? tab.type === 'connectors' ? 'market' : tab.type : null
}

function writeJson(storage: StorageLike, key: string, value: unknown): void {
  storage.setItem(key, JSON.stringify(value))
}

function migrateTabs(storage: StorageLike, report: DesktopMigrationReport): void {
  const raw = storage.getItem(TAB_STORAGE_KEY)
  if (!raw) return

  try {
    const parsed = readJson(storage, TAB_STORAGE_KEY)
    const rawTabs = Array.isArray(parsed)
      ? parsed
      : isRecord(parsed) && Array.isArray(parsed.openTabs)
        ? parsed.openTabs
        : []
    const openTabs = rawTabs
      .filter((tab): tab is Record<string, unknown> => isRecord(tab))
      .filter((tab) => typeof tab.sessionId === 'string' && typeof tab.title === 'string')
      .filter((tab) => tab.type !== 'terminal' && !String(tab.sessionId).startsWith('__terminal__'))
      .map((tab) => {
        const specialType = getPersistedSpecialTabType(tab)
        return {
          sessionId: specialType ? PERSISTED_SPECIAL_TAB_IDS[specialType] : tab.sessionId as string,
          title: tab.title as string,
          type: specialType ?? 'session',
        }
      })
      .filter((tab, index, tabs) => tabs.findIndex(other => other.sessionId === tab.sessionId) === index)
    const legacyActive = isRecord(parsed) ? rawTabs.find(tab => isRecord(tab) && tab.sessionId === parsed.activeTabId) : undefined
    const activeType = isRecord(legacyActive) ? getPersistedSpecialTabType(legacyActive) : null
    const normalizedActive = activeType ? PERSISTED_SPECIAL_TAB_IDS[activeType] : isRecord(parsed) ? parsed.activeTabId : null
    const activeTabId =
      isRecord(parsed) &&
      typeof normalizedActive === 'string' &&
      openTabs.some((tab) => tab.sessionId === normalizedActive)
        ? normalizedActive
        : (openTabs[0]?.sessionId ?? null)

    if (openTabs.length === 0) {
      storage.removeItem(TAB_STORAGE_KEY)
    } else {
      writeJson(storage, TAB_STORAGE_KEY, { openTabs, activeTabId })
    }
  } catch {
    storage.removeItem(TAB_STORAGE_KEY)
  }
  report.migratedKeys.push(TAB_STORAGE_KEY)
}

function migrateSessionRuntime(storage: StorageLike, report: DesktopMigrationReport): void {
  const raw = storage.getItem(SESSION_RUNTIME_STORAGE_KEY)
  if (!raw) return

  try {
    const parsed = readJson(storage, SESSION_RUNTIME_STORAGE_KEY)
    if (!isRecord(parsed)) {
      storage.removeItem(SESSION_RUNTIME_STORAGE_KEY)
      report.migratedKeys.push(SESSION_RUNTIME_STORAGE_KEY)
      return
    }

    const next = Object.fromEntries(
      Object.entries(parsed).filter(([, selection]) => (
        isRecord(selection) &&
        typeof selection.modelId === 'string' &&
        (selection.providerId === null || typeof selection.providerId === 'string') &&
        (
          selection.effortLevel === undefined ||
          (
            typeof selection.effortLevel === 'string' &&
            EFFORT_LEVELS.includes(selection.effortLevel)
          )
        )
      )),
    )

    if (Object.keys(next).length === 0) {
      storage.removeItem(SESSION_RUNTIME_STORAGE_KEY)
    } else {
      writeJson(storage, SESSION_RUNTIME_STORAGE_KEY, next)
    }

    if (JSON.stringify(next) !== JSON.stringify(parsed)) {
      report.migratedKeys.push(SESSION_RUNTIME_STORAGE_KEY)
    }
  } catch {
    storage.removeItem(SESSION_RUNTIME_STORAGE_KEY)
    report.migratedKeys.push(SESSION_RUNTIME_STORAGE_KEY)
  }
}

/**
 * The 「纸 · 墨 · 印」 redesign replaced three theme keys with six.
 *
 * `light` was the warm workspace, labelled 经典暖色 in the picker, so it lands
 * on `warm-classic` — the palette carrying the same name. Without this it
 * would fail the enum check and silently reset those users to the default,
 * which reads as "the app forgot my theme" rather than as a rename.
 */
const RENAMED_THEMES: Record<string, string> = {
  light: 'warm-classic',
}

/**
 * Rename-aware normalization for any key holding a theme name. The applied
 * theme is not the only one: following the system stores a preference per
 * ground, and those hold theme names too, so a rename has to reach them or
 * the preference silently resets.
 */
function migrateThemeKey(
  storage: StorageLike,
  key: string,
  allowedValues: readonly string[],
  report: DesktopMigrationReport,
): void {
  const stored = storage.getItem(key)
  const renamed = stored === null ? null : RENAMED_THEMES[stored]
  if (renamed && allowedValues.includes(renamed)) {
    storage.setItem(key, renamed)
    report.migratedKeys.push(key)
    return
  }
  normalizeEnumKey(storage, key, [...allowedValues], report)
}

/**
 * Schema 2 introduced the unified workspace store. Schema 3 adds review viewed
 * paths and the turn checkpoint index to its descriptors. Old workspaces keep
 * their tabs, including the Files picker whose path is deliberately empty.
 *
 * Terminal descriptors are the reason this cannot be left to the hydrator
 * alone: a stale entry carrying a live-looking runtime id is exactly the shape
 * that would make a restored shell look like a running process.
 */
function migrateWorkspaceState(storage: StorageLike, report: DesktopMigrationReport): void {
  const raw = storage.getItem(WORKSPACE_STORAGE_KEY)
  if (!raw) return

  try {
    const parsed = JSON.parse(raw)
    if (!isRecord(parsed) || !isRecord(parsed.sessions)) {
      storage.removeItem(WORKSPACE_STORAGE_KEY)
      report.migratedKeys.push(WORKSPACE_STORAGE_KEY)
      return
    }
    if (parsed.version !== 1 && parsed.version !== WORKSPACE_STORAGE_VERSION) {
      // A newer build wrote this. The hydrator already refuses a version it
      // does not know, so leave the entry alone — deleting it would mean that
      // downgrading once, briefly, permanently discards the workspace the newer
      // build is still using.
      return
    }

    let changed = parsed.version !== WORKSPACE_STORAGE_VERSION
    const sessions: Record<string, unknown> = {}
    for (const [sessionId, value] of Object.entries(parsed.sessions)) {
      if (!isRecord(value) || !Array.isArray(value.tabs)) {
        changed = true
        continue
      }
      const tabs = value.tabs.filter((tab) =>
        isRecord(tab) &&
        typeof tab.id === 'string' &&
        // Anything naming a host resource is stale by definition once the
        // process that owned it is gone.
        !('runtimeId' in tab) &&
        !('browserTabId' in tab) &&
        WORKSPACE_PERSISTED_TAB_KINDS.includes(tab.kind as string))
        .map((tab) => parsed.version === 1 && tab.kind === 'review'
          ? { ...tab, viewedPaths: [] }
          : tab)
      if (tabs.length !== value.tabs.length) changed = true
      if (tabs.length === 0) {
        changed = true
        continue
      }
      sessions[sessionId] = { ...value, tabs }
    }

    if (Object.keys(sessions).length === 0) {
      storage.removeItem(WORKSPACE_STORAGE_KEY)
      report.migratedKeys.push(WORKSPACE_STORAGE_KEY)
      return
    }
    if (changed) {
      writeJson(storage, WORKSPACE_STORAGE_KEY, { ...parsed, version: WORKSPACE_STORAGE_VERSION, sessions })
      report.migratedKeys.push(WORKSPACE_STORAGE_KEY)
    }
  } catch {
    storage.removeItem(WORKSPACE_STORAGE_KEY)
    report.migratedKeys.push(WORKSPACE_STORAGE_KEY)
  }
}

function normalizeEnumKey(
  storage: StorageLike,
  key: string,
  allowedValues: string[],
  report: DesktopMigrationReport,
): void {
  const value = storage.getItem(key)
  if (value !== null && !allowedValues.includes(value)) {
    storage.removeItem(key)
    report.migratedKeys.push(key)
  }
}

function normalizeAppZoomKey(storage: StorageLike, report: DesktopMigrationReport): void {
  const value = storage.getItem(APP_ZOOM_STORAGE_KEY)
  if (!isValidStoredAppZoomLevel(value)) {
    storage.removeItem(APP_ZOOM_STORAGE_KEY)
    report.migratedKeys.push(APP_ZOOM_STORAGE_KEY)
  }

  const currentValue = storage.getItem(APP_ZOOM_STORAGE_KEY)
  const legacyValue = storage.getItem(LEGACY_UI_ZOOM_STORAGE_KEY)
  if (currentValue === null && legacyValue !== null && isValidStoredAppZoomLevel(legacyValue)) {
    storage.setItem(APP_ZOOM_STORAGE_KEY, String(normalizeAppZoomLevel(legacyValue)))
    report.migratedKeys.push(APP_ZOOM_STORAGE_KEY)
  }
  if (legacyValue !== null) {
    storage.removeItem(LEGACY_UI_ZOOM_STORAGE_KEY)
    report.migratedKeys.push(LEGACY_UI_ZOOM_STORAGE_KEY)
  }
}

function runMigrationStep(
  report: DesktopMigrationReport,
  fallbackKey: string,
  step: () => void,
): void {
  try {
    step()
  } catch {
    report.migratedKeys.push(fallbackKey)
  }
}

function getDefaultStorage(): StorageLike | null {
  try {
    return globalThis.localStorage ?? null
  } catch {
    return null
  }
}

export function runDesktopPersistenceMigrations(storage: StorageLike | null = getDefaultStorage()): DesktopMigrationReport {
  const report: DesktopMigrationReport = { migratedKeys: [] }
  if (!storage) return report

  runMigrationStep(report, TAB_STORAGE_KEY, () => migrateTabs(storage, report))
  runMigrationStep(report, SESSION_RUNTIME_STORAGE_KEY, () => migrateSessionRuntime(storage, report))
  runMigrationStep(report, THEME_STORAGE_KEY, () =>
    migrateThemeKey(storage, THEME_STORAGE_KEY, THEME_MODES, report))
  // A junk value here would otherwise be read as "never chosen", which is what
  // tells a fresh install to follow the system.
  runMigrationStep(report, FOLLOW_SYSTEM_THEME_STORAGE_KEY, () =>
    normalizeEnumKey(storage, FOLLOW_SYSTEM_THEME_STORAGE_KEY, ['0', '1'], report))
  runMigrationStep(report, LIGHT_THEME_STORAGE_KEY, () =>
    migrateThemeKey(storage, LIGHT_THEME_STORAGE_KEY, LIGHT_THEME_MODES, report))
  runMigrationStep(report, DARK_THEME_STORAGE_KEY, () =>
    migrateThemeKey(storage, DARK_THEME_STORAGE_KEY, DARK_THEME_MODES, report))
  runMigrationStep(report, LOCALE_STORAGE_KEY, () => normalizeEnumKey(storage, LOCALE_STORAGE_KEY, SUPPORTED_LOCALES, report))
  runMigrationStep(report, APP_ZOOM_STORAGE_KEY, () => normalizeAppZoomKey(storage, report))
  runMigrationStep(report, WORKSPACE_STORAGE_KEY, () => migrateWorkspaceState(storage, report))
  try {
    storage.setItem(DESKTOP_PERSISTENCE_VERSION_KEY, String(CURRENT_DESKTOP_PERSISTENCE_SCHEMA_VERSION))
  } catch {
    report.migratedKeys.push(DESKTOP_PERSISTENCE_VERSION_KEY)
  }

  return report
}
