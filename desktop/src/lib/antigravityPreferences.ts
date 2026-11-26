import type { ReasoningEffortLevel } from '../types/settings'
import { ANTIGRAVITY_ACP_DEFAULT_EFFORTS } from '../constants/antigravityAcp'

export type ComposerEngine = 'cc-haha' | 'antigravity'

export type AntigravitySavedSelection = {
  modelId: string
  effortLevel?: ReasoningEffortLevel
}

export const ANTIGRAVITY_ENABLED_STORAGE_KEY = 'cc-haha-antigravity-enabled'
export const ANTIGRAVITY_LAST_ENGINE_STORAGE_KEY = 'cc-haha-composer-engine'
export const ANTIGRAVITY_LAST_SELECTION_STORAGE_KEY = 'cc-haha-antigravity-last-selection'

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
