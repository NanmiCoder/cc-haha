import { create } from 'zustand'
import type { RuntimeSelection } from '../types/runtime'

const STORAGE_KEY = 'cc-haha-session-runtime'
const COORDINATOR_STORAGE_KEY = 'cc-haha-session-coordinator'

export const DRAFT_RUNTIME_SELECTION_KEY = '__draft__'

type SessionRuntimeStore = {
  selections: Record<string, RuntimeSelection>
  /** Per-session orchestration ("协调") mode toggle. Absent/false = off. */
  coordinatorModes: Record<string, boolean>
  setSelection: (key: string, selection: RuntimeSelection) => void
  clearSelection: (key: string) => void
  moveSelection: (fromKey: string, toKey: string) => void
  setCoordinatorMode: (key: string, enabled: boolean) => void
}

function loadSelections(): Record<string, RuntimeSelection> {
  if (typeof localStorage === 'undefined') return {}
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as Record<string, RuntimeSelection>
    return parsed && typeof parsed === 'object' ? parsed : {}
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

function loadCoordinatorModes(): Record<string, boolean> {
  if (typeof localStorage === 'undefined') return {}
  try {
    const raw = localStorage.getItem(COORDINATOR_STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as Record<string, boolean>
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function persistCoordinatorModes(modes: Record<string, boolean>) {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(COORDINATOR_STORAGE_KEY, JSON.stringify(modes))
  } catch {
    // noop
  }
}

export const useSessionRuntimeStore = create<SessionRuntimeStore>((set) => ({
  selections: loadSelections(),
  coordinatorModes: loadCoordinatorModes(),

  setSelection: (key, selection) =>
    set((state) => {
      const selections = {
        ...state.selections,
        [key]: selection,
      }
      persistSelections(selections)
      return { selections }
    }),

  clearSelection: (key) =>
    set((state) => {
      const hadSelection = key in state.selections
      const hadCoordinator = key in state.coordinatorModes
      if (!hadSelection && !hadCoordinator) return state

      const next: Partial<SessionRuntimeStore> = {}
      if (hadSelection) {
        const { [key]: _removed, ...rest } = state.selections
        persistSelections(rest)
        next.selections = rest
      }
      if (hadCoordinator) {
        const { [key]: _removed, ...rest } = state.coordinatorModes
        persistCoordinatorModes(rest)
        next.coordinatorModes = rest
      }
      return next
    }),

  moveSelection: (fromKey, toKey) =>
    set((state) => {
      const selection = state.selections[fromKey]
      const coordinator = state.coordinatorModes[fromKey]
      if (!selection && coordinator === undefined) return state

      const next: Partial<SessionRuntimeStore> = {}
      if (selection) {
        const { [fromKey]: _removed, ...rest } = state.selections
        next.selections = { ...rest, [toKey]: selection }
        persistSelections(next.selections)
      }
      if (coordinator !== undefined) {
        const { [fromKey]: _removed, ...rest } = state.coordinatorModes
        next.coordinatorModes = { ...rest, [toKey]: coordinator }
        persistCoordinatorModes(next.coordinatorModes)
      }
      return next
    }),

  setCoordinatorMode: (key, enabled) =>
    set((state) => {
      if ((state.coordinatorModes[key] ?? false) === enabled) return state
      const coordinatorModes = { ...state.coordinatorModes, [key]: enabled }
      persistCoordinatorModes(coordinatorModes)
      return { coordinatorModes }
    }),
}))
