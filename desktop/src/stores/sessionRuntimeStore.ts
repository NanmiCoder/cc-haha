import { create } from 'zustand'
import type { RuntimeSelection } from '../types/runtime'

const STORAGE_KEY = 'cc-haha-session-runtime'
const COORDINATOR_STORAGE_KEY = 'cc-haha-session-coordinator'
const SOLO_PIPELINE_STORAGE_KEY = 'cc-haha-session-solo-pipeline'
const HANDOFF_STORAGE_KEY = 'cc-haha-session-handoff'

export const DRAFT_RUNTIME_SELECTION_KEY = '__draft__'

/**
 * Per-session record of where the hand-off context came from. Set by the
 * "Continue from here" flow when it succeeds in attaching a previous
 * session's summary to this session's CLI launch. Used to render a small
 * "↗ continued from..." chip in the chat header so the user remembers
 * (and trusts) that the AI has prior context.
 *
 * `approxTokens` is a frontend-side estimate (chars / 4) — not authoritative,
 * but enough to give the user a feel for how big the hand-off addendum is.
 * The exact tokens are also counted server-side as part of the system
 * prompt category in ContextUsageIndicator.
 */
export type SessionHandoffInfo = {
  previousSessionId: string
  /** Title of the previous session at hand-off time (snapshotted, may drift). */
  previousSessionTitle: string
  approxTokens: number
  /** ISO timestamp from the SessionSummary, for staleness display. */
  generatedAt: string
}

type SessionRuntimeStore = {
  selections: Record<string, RuntimeSelection>
  /** Per-session orchestration ("协调") mode toggle. Absent/false = off. */
  coordinatorModes: Record<string, boolean>
  /**
   * Per-session Solo Pipeline mode toggle. Absent/false = off. Mutually
   * exclusive with `coordinatorModes` at the chatStore action layer
   * (setSessionSoloPipelineMode clears coordinator and vice versa); the
   * raw runtime store is intentionally orthogonal so each map stays a
   * simple persistence-backed mirror of the user's toggle state.
   */
  soloPipelineModes: Record<string, boolean>
  /** Per-session hand-off context info. Absent = no hand-off attached. */
  handoffInfo: Record<string, SessionHandoffInfo>
  setSelection: (key: string, selection: RuntimeSelection) => void
  clearSelection: (key: string) => void
  moveSelection: (fromKey: string, toKey: string) => void
  setCoordinatorMode: (key: string, enabled: boolean) => void
  setSoloPipelineMode: (key: string, enabled: boolean) => void
  setHandoffInfo: (key: string, info: SessionHandoffInfo) => void
  clearHandoffInfo: (key: string) => void
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

function loadSoloPipelineModes(): Record<string, boolean> {
  if (typeof localStorage === 'undefined') return {}
  try {
    const raw = localStorage.getItem(SOLO_PIPELINE_STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as Record<string, boolean>
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function persistSoloPipelineModes(modes: Record<string, boolean>) {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(SOLO_PIPELINE_STORAGE_KEY, JSON.stringify(modes))
  } catch {
    // noop
  }
}

function loadHandoffInfo(): Record<string, SessionHandoffInfo> {
  if (typeof localStorage === 'undefined') return {}
  try {
    const raw = localStorage.getItem(HANDOFF_STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as Record<string, SessionHandoffInfo>
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function persistHandoffInfo(info: Record<string, SessionHandoffInfo>) {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(HANDOFF_STORAGE_KEY, JSON.stringify(info))
  } catch {
    // noop
  }
}

export const useSessionRuntimeStore = create<SessionRuntimeStore>((set) => ({
  selections: loadSelections(),
  coordinatorModes: loadCoordinatorModes(),
  soloPipelineModes: loadSoloPipelineModes(),
  handoffInfo: loadHandoffInfo(),

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
      const hadSoloPipeline = key in state.soloPipelineModes
      const hadHandoff = key in state.handoffInfo
      if (!hadSelection && !hadCoordinator && !hadSoloPipeline && !hadHandoff) return state

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
      if (hadSoloPipeline) {
        const { [key]: _removed, ...rest } = state.soloPipelineModes
        persistSoloPipelineModes(rest)
        next.soloPipelineModes = rest
      }
      if (hadHandoff) {
        const { [key]: _removed, ...rest } = state.handoffInfo
        persistHandoffInfo(rest)
        next.handoffInfo = rest
      }
      return next
    }),

  moveSelection: (fromKey, toKey) =>
    set((state) => {
      const selection = state.selections[fromKey]
      const coordinator = state.coordinatorModes[fromKey]
      const soloPipeline = state.soloPipelineModes[fromKey]
      const handoff = state.handoffInfo[fromKey]
      if (!selection && coordinator === undefined && soloPipeline === undefined && !handoff) return state

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
      if (soloPipeline !== undefined) {
        const { [fromKey]: _removed, ...rest } = state.soloPipelineModes
        next.soloPipelineModes = { ...rest, [toKey]: soloPipeline }
        persistSoloPipelineModes(next.soloPipelineModes)
      }
      if (handoff) {
        const { [fromKey]: _removed, ...rest } = state.handoffInfo
        next.handoffInfo = { ...rest, [toKey]: handoff }
        persistHandoffInfo(next.handoffInfo)
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

  setSoloPipelineMode: (key, enabled) =>
    set((state) => {
      if ((state.soloPipelineModes[key] ?? false) === enabled) return state
      const soloPipelineModes = { ...state.soloPipelineModes, [key]: enabled }
      persistSoloPipelineModes(soloPipelineModes)
      return { soloPipelineModes }
    }),

  setHandoffInfo: (key, info) =>
    set((state) => {
      const handoffInfo = { ...state.handoffInfo, [key]: info }
      persistHandoffInfo(handoffInfo)
      return { handoffInfo }
    }),

  clearHandoffInfo: (key) =>
    set((state) => {
      if (!(key in state.handoffInfo)) return state
      const { [key]: _removed, ...handoffInfo } = state.handoffInfo
      persistHandoffInfo(handoffInfo)
      return { handoffInfo }
    }),
}))
