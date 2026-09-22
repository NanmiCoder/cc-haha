import { create } from 'zustand'
import type { RuntimeSelection } from '../types/runtime'
import type { SessionListItem } from '../types/session'
import {
  GROK_OFFICIAL_DEFAULT_MODEL_ID,
  GROK_OFFICIAL_MODELS,
  GROK_OFFICIAL_PROVIDER_ID,
} from '../constants/grokOfficialProvider'
import { normalizeRuntimeSelection } from '../lib/runtimeSelection'

const STORAGE_KEY = 'cc-haha-session-runtime'
// Session-list metadata can lag behind runtime changes or arrive out of order.
// Protect local choices until the server confirms them. Object identity also
// lets callers discard list responses started before a choice/confirmation.
// This transient state follows moveSelection without changing persisted JSON.
const pendingRuntimes = new WeakSet<RuntimeSelection>()
const RETIRED_GROK_MODEL_IDS = new Set([
  'grok-build',
  'grok-build-0.1',
  'grok-4.3',
  'grok-4.20-reasoning',
  'grok-4.20-non-reasoning',
  // Dropped from the live /v1/models feed, so a session still pinned to it
  // would send an ID the gateway no longer serves.
  'grok-composer-2.5-fast',
])

export const DRAFT_RUNTIME_SELECTION_KEY = '__draft__'

type SessionRuntimeStore = {
  selections: Record<string, RuntimeSelection>
  setSelection: (key: string, selection: RuntimeSelection) => void
  clearSelection: (key: string) => void
  moveSelection: (fromKey: string, toKey: string) => void
  settleSelection: (key: string) => void
  syncFromSessions: (sessions: SessionListItem[], startedWith?: Record<string, RuntimeSelection>) => void
}

function normalizeSelection(selection: RuntimeSelection): RuntimeSelection | null {
  const normalizedSelection = normalizeRuntimeSelection(selection)
  if (
    normalizedSelection.providerId === null &&
    normalizedSelection.modelId.trim().toLowerCase() === 'opus[1m]'
  ) {
    // Older builds persisted the dynamic Claude default as an explicit model.
    // Drop only that Claude Official sentinel so the OAuth subscription tier
    // can resolve the current default. Third-party `[1m]` model ids stay intact.
    return null
  }
  if (
    normalizedSelection.providerId !== GROK_OFFICIAL_PROVIDER_ID ||
    !RETIRED_GROK_MODEL_IDS.has(normalizedSelection.modelId)
  ) {
    return normalizedSelection
  }

  const fallback = GROK_OFFICIAL_MODELS.find(
    (model) => model.id === GROK_OFFICIAL_DEFAULT_MODEL_ID,
  )
  return {
    providerId: GROK_OFFICIAL_PROVIDER_ID,
    modelId: GROK_OFFICIAL_DEFAULT_MODEL_ID,
    ...(fallback?.defaultReasoningEffort
      ? { effortLevel: fallback.defaultReasoningEffort }
      : {}),
  }
}

function normalizeSelections(
  selections: Record<string, RuntimeSelection>,
): { selections: Record<string, RuntimeSelection>; changed: boolean } {
  let changed = false
  const normalized: Record<string, RuntimeSelection> = {}
  for (const [key, selection] of Object.entries(selections)) {
    const next = normalizeSelection(selection)
    if (!next) {
      changed = true
      continue
    }
    if (next !== selection) changed = true
    normalized[key] = next
  }
  return { selections: normalized, changed }
}

function loadSelections(): Record<string, RuntimeSelection> {
  if (typeof localStorage === 'undefined') return {}
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as Record<string, RuntimeSelection>
    if (!parsed || typeof parsed !== 'object') return {}
    const normalized = normalizeSelections(parsed)
    if (normalized.changed) persistSelections(normalized.selections)
    return normalized.selections
  } catch {
    return {}
  }
}

function persistSelections(selections: Record<string, RuntimeSelection>) {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(selections))
  } catch {
    // noop
  }
}

export const useSessionRuntimeStore = create<SessionRuntimeStore>((set) => ({
  selections: loadSelections(),

  setSelection: (key, selection) =>
    set((state) => {
      const normalized = normalizeSelection(selection)
      const selections = { ...state.selections }
      if (normalized) {
        pendingRuntimes.add(normalized)
        selections[key] = normalized
      } else delete selections[key]
      persistSelections(selections)
      return { selections }
    }),

  clearSelection: (key) =>
    set((state) => {
      if (!(key in state.selections)) return state
      const { [key]: _removed, ...rest } = state.selections
      persistSelections(rest)
      return { selections: rest }
    }),

  moveSelection: (fromKey, toKey) =>
    set((state) => {
      const selection = state.selections[fromKey]
      if (!selection) return state
      const { [fromKey]: _removed, ...rest } = state.selections
      const selections = {
        ...rest,
        [toKey]: selection,
      }
      persistSelections(selections)
      return { selections }
    }),

  settleSelection: (key) =>
    set((state) => {
      const current = state.selections[key]
      if (!current || !pendingRuntimes.has(current)) return state
      // A new identity invalidates requests started before confirmation/failure.
      return { selections: { ...state.selections, [key]: { ...current } } }
    }),

  syncFromSessions: (sessions, startedWith) =>
    set((state) => {
      let selections = state.selections
      for (const session of sessions) {
        const current = selections[session.id]
        if (startedWith && startedWith[session.id] !== current) continue
        if (!session.runtimeModelId || session.runtimeProviderId === undefined) continue
        const selection = normalizeSelection({
          providerId: session.runtimeProviderId,
          modelId: session.runtimeModelId,
          ...(session.effortLevel ? { effortLevel: session.effortLevel } : {}),
        })
        const matchesCurrent = selection &&
          current?.providerId === selection.providerId &&
          current.modelId === selection.modelId &&
          current.effortLevel === selection.effortLevel
        const pending = current && pendingRuntimes.has(current)
        if (pending && !matchesCurrent) continue
        if (!selection) {
          if (!(session.id in selections)) continue
          if (selections === state.selections) selections = { ...state.selections }
          delete selections[session.id]
          continue
        }
        if (matchesCurrent && !pending) {
          continue
        }
        if (selections === state.selections) selections = { ...state.selections }
        selections[session.id] = selection
      }
      if (selections === state.selections) return state
      persistSelections(selections)
      return { selections }
    }),
}))
