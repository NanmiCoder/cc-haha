import { create } from 'zustand'
import { destroyTerminalRuntime } from '../lib/terminalRuntime'

export const TERMINAL_PANEL_DEFAULT_HEIGHT = 420
export const TERMINAL_PANEL_MIN_HEIGHT = 260
export const TERMINAL_PANEL_MAX_HEIGHT = 760
export const SESSION_TERMINAL_RUNTIME_PREFIX = '__session_terminal__'

type TerminalPanelSessionState = {
  isOpen: boolean
  runtimeId?: string
}

type TerminalPanelStore = {
  panelBySession: Record<string, TerminalPanelSessionState | undefined>
  height: number

  isPanelOpen: (sessionId: string) => boolean
  openPanel: (sessionId: string) => void
  closePanel: (sessionId: string) => void
  togglePanel: (sessionId: string) => void
  setHeight: (height: number) => void
  clearSession: (sessionId: string) => void
  detachRuntime: (sessionId: string) => void
  getPanelRuntimeId: (sessionId: string) => string | undefined
}

const DEFAULT_PANEL_STATE: TerminalPanelSessionState = {
  isOpen: false,
}

function createSessionTerminalRuntimeId(sessionId: string) {
  return `${SESSION_TERMINAL_RUNTIME_PREFIX}${sessionId}`
}

function getSessionPanelState(
  panelBySession: Record<string, TerminalPanelSessionState | undefined>,
  sessionId: string,
) {
  return panelBySession[sessionId] ?? DEFAULT_PANEL_STATE
}

function removeRecordKey<T>(record: Record<string, T>, key: string) {
  if (!(key in record)) return record
  const { [key]: _removed, ...rest } = record
  return rest
}

export function clampTerminalPanelHeight(height: number) {
  if (!Number.isFinite(height)) return TERMINAL_PANEL_DEFAULT_HEIGHT
  const rounded = Math.round(height)
  return Math.min(TERMINAL_PANEL_MAX_HEIGHT, Math.max(TERMINAL_PANEL_MIN_HEIGHT, rounded))
}

export const useTerminalPanelStore = create<TerminalPanelStore>((set, get) => ({
  panelBySession: {},
  height: TERMINAL_PANEL_DEFAULT_HEIGHT,

  isPanelOpen: (sessionId) => getSessionPanelState(get().panelBySession, sessionId).isOpen,

  openPanel: (sessionId) =>
    set((state) => {
      const panel = getSessionPanelState(state.panelBySession, sessionId)
      return {
        panelBySession: {
          ...state.panelBySession,
          [sessionId]: {
            ...panel,
            isOpen: true,
            runtimeId: panel.runtimeId ?? createSessionTerminalRuntimeId(sessionId),
          },
        },
      }
    }),

  closePanel: (sessionId) =>
    set((state) => {
      const panel = getSessionPanelState(state.panelBySession, sessionId)
      return {
        panelBySession: {
          ...state.panelBySession,
          [sessionId]: {
            ...panel,
            isOpen: false,
          },
        },
      }
    }),

  togglePanel: (sessionId) =>
    set((state) => {
      const panel = getSessionPanelState(state.panelBySession, sessionId)
      return {
        panelBySession: {
          ...state.panelBySession,
          [sessionId]: {
            ...panel,
            isOpen: !panel.isOpen,
            runtimeId: panel.runtimeId ?? createSessionTerminalRuntimeId(sessionId),
          },
        },
      }
    }),

  setHeight: (height) => set({ height: clampTerminalPanelHeight(height) }),

  clearSession: (sessionId) =>
    set((state) => {
      const runtimeId = state.panelBySession[sessionId]?.runtimeId
      if (runtimeId) {
        destroyTerminalRuntime(runtimeId)
      }
      return {
        panelBySession: removeRecordKey(state.panelBySession, sessionId),
      }
    }),

  detachRuntime: (sessionId) =>
    set((state) => {
      const panel = state.panelBySession[sessionId]
      if (!panel) return state
      return {
        panelBySession: {
          ...state.panelBySession,
          [sessionId]: {
            ...panel,
            isOpen: false,
            runtimeId: undefined,
          },
        },
      }
    }),

  getPanelRuntimeId: (sessionId) => get().panelBySession[sessionId]?.runtimeId,
}))
