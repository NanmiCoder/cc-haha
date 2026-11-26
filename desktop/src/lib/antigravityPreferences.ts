import type { AntigravityModelInfo } from '../types/provider'
import type { ReasoningEffortLevel } from '../types/settings'
import { ANTIGRAVITY_ACP_DEFAULT_EFFORTS } from '../constants/antigravityAcp'

export type ComposerEngine = 'cc-haha' | 'antigravity'

export type AntigravitySavedSelection = {
  modelId: string
  effortLevel?: ReasoningEffortLevel
}

export type AntigravityCachedCatalog = {
  models: AntigravityModelInfo[]
  currentModelId?: string
  currentEffortLevel?: ReasoningEffortLevel
  version?: string
}

export const ANTIGRAVITY_ENABLED_STORAGE_KEY = 'cc-haha-antigravity-enabled'
export const ANTIGRAVITY_LAST_ENGINE_STORAGE_KEY = 'cc-haha-composer-engine'
export const ANTIGRAVITY_LAST_SELECTION_STORAGE_KEY = 'cc-haha-antigravity-last-selection'
export const ANTIGRAVITY_CACHED_CATALOG_STORAGE_KEY = 'cc-haha-antigravity-cached-catalog'

function isValidAntigravityEffort(value: unknown): value is ReasoningEffortLevel {
  return typeof value === 'string' && (ANTIGRAVITY_ACP_DEFAULT_EFFORTS as readonly string[]).includes(value)
}

export function readAntigravityEnabled(): boolean {
  try {
    return localStorage.getItem(ANTIGRAVITY_ENABLED_STORAGE_KEY) !== '0'
  } catch {
    return true
  }
}

export function writeAntigravityEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(ANTIGRAVITY_ENABLED_STORAGE_KEY, enabled ? '1' : '0')
  } catch {
    // localStorage unavailable
  }
}

export function readLastComposerEngine(): ComposerEngine {
  try {
    return localStorage.getItem(ANTIGRAVITY_LAST_ENGINE_STORAGE_KEY) === 'antigravity'
      ? 'antigravity'
      : 'cc-haha'
  } catch {
    return 'cc-haha'
  }
}

export function writeLastComposerEngine(engine: ComposerEngine): void {
  try {
    localStorage.setItem(ANTIGRAVITY_LAST_ENGINE_STORAGE_KEY, engine)
  } catch {
    // localStorage unavailable
  }
}

export function parseAntigravitySavedSelection(raw: string | null): AntigravitySavedSelection | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const record = parsed as Record<string, unknown>
    if (typeof record.modelId !== 'string' || !record.modelId.trim()) return null
    if (record.effortLevel !== undefined && !isValidAntigravityEffort(record.effortLevel)) return null
    return {
      modelId: record.modelId.trim(),
      ...(record.effortLevel ? { effortLevel: record.effortLevel } : {}),
    }
  } catch {
    return null
  }
}

export function readAntigravityLastSelection(): AntigravitySavedSelection | null {
  try {
    return parseAntigravitySavedSelection(localStorage.getItem(ANTIGRAVITY_LAST_SELECTION_STORAGE_KEY))
  } catch {
    return null
  }
}

export function writeAntigravityLastSelection(selection: AntigravitySavedSelection): void {
  try {
    localStorage.setItem(ANTIGRAVITY_LAST_SELECTION_STORAGE_KEY, JSON.stringify({
      modelId: selection.modelId,
      ...(selection.effortLevel ? { effortLevel: selection.effortLevel } : {}),
    }))
  } catch {
    // localStorage unavailable
  }
}

export function readAntigravityCachedCatalog(): AntigravityCachedCatalog | null {
  try {
    const raw = localStorage.getItem(ANTIGRAVITY_CACHED_CATALOG_STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const record = parsed as Record<string, unknown>
    if (!Array.isArray(record.models)) return null
    const models: AntigravityModelInfo[] = []
    for (const item of record.models) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue
      const entry = item as Record<string, unknown>
      if (typeof entry.id !== 'string' || !entry.id.trim() || typeof entry.name !== 'string' || !entry.name.trim()) {
        continue
      }
      const supportedReasoningEfforts = Array.isArray(entry.supportedReasoningEfforts)
        ? entry.supportedReasoningEfforts.filter(isValidAntigravityEffort)
        : undefined
      models.push({
        id: entry.id.trim(),
        name: entry.name.trim(),
        ...(supportedReasoningEfforts !== undefined
          ? { supportedReasoningEfforts }
          : {}),
        ...(isValidAntigravityEffort(entry.defaultReasoningEffort)
          ? { defaultReasoningEffort: entry.defaultReasoningEffort }
          : {}),
      })
    }
    if (models.length === 0) return null
    return {
      models,
      ...(typeof record.currentModelId === 'string' && record.currentModelId.trim()
        ? { currentModelId: record.currentModelId.trim() }
        : {}),
      ...(isValidAntigravityEffort(record.currentEffortLevel)
        ? { currentEffortLevel: record.currentEffortLevel }
        : {}),
      ...(typeof record.version === 'string' && record.version.trim()
        ? { version: record.version.trim() }
        : {}),
    }
  } catch {
    return null
  }
}

export function writeAntigravityCachedCatalog(catalog: AntigravityCachedCatalog): void {
  if (catalog.models.length === 0) return
  try {
    localStorage.setItem(ANTIGRAVITY_CACHED_CATALOG_STORAGE_KEY, JSON.stringify({
      models: catalog.models,
      ...(catalog.currentModelId ? { currentModelId: catalog.currentModelId } : {}),
      ...(catalog.currentEffortLevel ? { currentEffortLevel: catalog.currentEffortLevel } : {}),
      ...(catalog.version ? { version: catalog.version } : {}),
    }))
  } catch {
    // localStorage unavailable
  }
}

export function clearAntigravityCachedCatalog(): void {
  try {
    localStorage.removeItem(ANTIGRAVITY_CACHED_CATALOG_STORAGE_KEY)
  } catch {
    // localStorage unavailable
  }
}
