import { create } from 'zustand'
import {
  browserUseApi,
  type BrowserControlState,
  type BrowserTakeoverState,
  type BrowserUseActivityEvent,
  type BrowserUseConfig,
  type BrowserUseStatus,
} from '@/api/browserUse'
import type {
  BrowserUseHostEvent,
  BrowserUseTargetRect,
} from '@/lib/desktopHost/types'
import { setWorkspaceBrowserAgentActive } from '@/lib/workspace/browserGuests'
import { useUIStore } from '@/stores/uiStore'
import { t } from '@/i18n'

export type BrowserUseCursorMove = {
  moveId: string
  x: number
  y: number
  durationMs: number
  targetRect?: BrowserUseTargetRect
  label?: string
  seq: number
}

export type BrowserUseClickRipple = {
  x: number
  y: number
  button: 'left' | 'right' | 'middle'
  seq: number
}

export type BrowserUseTabOverlayState = {
  tabId: string
  controlState: BrowserControlState
  actionLabel?: string
  takeoverReason?: string
  sessionId?: string
  showOverlay: boolean
  cursor: BrowserUseCursorMove | null
  ripple: BrowserUseClickRipple | null
}

const MAX_ACTIVITIES_PER_SESSION = 100

let configMutationSeq = 0
let inFlightConfigMutations = 0
let statusRequestSeq = 0
let cursorEventSeq = 0

function createDefaultTabOverlay(tabId: string): BrowserUseTabOverlayState {
  return {
    tabId,
    controlState: 'idle',
    showOverlay: true,
    cursor: null,
    ripple: null,
  }
}

type BrowserUseStore = {
  config: BrowserUseConfig | null
  status: BrowserUseStatus | null
  loaded: boolean
  loading: boolean
  error: string | null
  tabStates: Record<string, BrowserUseTabOverlayState | undefined>
  activitiesBySession: Record<string, BrowserUseActivityEvent[] | undefined>
  takeoverBySession: Record<string, BrowserTakeoverState | null | undefined>

  fetchStatus: () => Promise<BrowserUseStatus | null>
  fetchConfig: () => Promise<BrowserUseConfig | null>
  updateConfig: (patch: Partial<BrowserUseConfig>) => Promise<BrowserUseConfig | null>
  applyStatus: (status: BrowserUseStatus) => void
  applyHostEvent: (event: BrowserUseHostEvent) => void
  applyActivityEvent: (sessionId: string, activity: BrowserUseActivityEvent) => void
  applyTakeoverEvent: (sessionId: string, takeover: BrowserTakeoverState) => void
  resumeTakeover: (sessionId: string, takeoverId?: string, note?: string) => Promise<boolean>
  abortTakeover: (sessionId: string, takeoverId?: string, reason?: string) => Promise<boolean>
  clearTabState: (tabId: string) => void
  clearSession: (sessionId: string) => void
  reset: () => void
}

export const useBrowserUseStore = create<BrowserUseStore>((set, get) => ({
  config: null,
  status: null,
  loaded: false,
  loading: false,
  error: null,
  tabStates: {},
  activitiesBySession: {},
  takeoverBySession: {},

  fetchStatus: async () => {
    const seq = ++statusRequestSeq
    set({ loading: true, error: null })
    try {
      const status = await browserUseApi.getStatus()
      if (seq !== statusRequestSeq) return null
      set((state) => ({
        status,
        config: status.config ?? state.config,
        loaded: true,
        loading: false,
        error: null,
      }))
      return status
    } catch (error) {
      if (seq !== statusRequestSeq) return null
      set({
        loading: false,
        error: error instanceof Error ? error.message : String(error),
      })
      return null
    }
  },

  fetchConfig: async () => {
    const seq = configMutationSeq
    try {
      const config = await browserUseApi.getConfig()
      if (seq !== configMutationSeq) return null
      set((state) => ({
        config,
        loaded: true,
        status: state.status
          ? { ...state.status, enabled: config.enabled, preferredTarget: config.preferredTarget, config }
          : state.status,
      }))
      return config
    } catch {
      return null
    }
  },

  updateConfig: async (patch) => {
    const seq = ++configMutationSeq
    inFlightConfigMutations += 1
    const previousConfig = get().config
    const previousStatus = get().status
    if (previousConfig) {
      const optimistic: BrowserUseConfig = { ...previousConfig, ...patch }
      set((state) => ({
        config: optimistic,
        error: null,
        status: state.status
          ? {
              ...state.status,
              enabled: optimistic.enabled,
              preferredTarget: optimistic.preferredTarget,
              config: optimistic,
            }
          : state.status,
      }))
    }
    try {
      const saved = await browserUseApi.updateConfig(patch)
      if (seq !== configMutationSeq) return saved
      set((state) => ({
        config: saved,
        loaded: true,
        error: null,
        status: state.status
          ? {
              ...state.status,
              enabled: saved.enabled,
              preferredTarget: saved.preferredTarget,
              config: saved,
            }
          : state.status,
      }))
      return saved
    } catch (error) {
      if (seq === configMutationSeq) {
        set({
          config: previousConfig,
          status: previousStatus,
          error: error instanceof Error ? error.message : String(error),
        })
      }
      return null
    } finally {
      inFlightConfigMutations = Math.max(0, inFlightConfigMutations - 1)
    }
  },

  applyStatus: (status) => {
    set((state) => {
      if (inFlightConfigMutations > 0 && state.config) {
        return {
          status: {
            ...status,
            enabled: state.config.enabled,
            preferredTarget: state.config.preferredTarget,
            config: state.config,
          },
          loaded: true,
          error: null,
        }
      }
      return {
        status,
        config: status.config,
        loaded: true,
        error: null,
      }
    })
  },

  applyHostEvent: (event) => {
    if (event.type === 'control-state') {
      setWorkspaceBrowserAgentActive(event.tabId, event.state !== 'idle')
      set((state) => {
        const previous = state.tabStates[event.tabId] ?? createDefaultTabOverlay(event.tabId)
        const nextShowOverlay = event.showOverlay ?? previous.showOverlay
        const next: BrowserUseTabOverlayState = {
          ...previous,
          controlState: event.state,
          actionLabel: event.state === 'idle' ? undefined : (event.actionLabel ?? previous.actionLabel),
          takeoverReason: event.state === 'takeover' ? (event.takeoverReason ?? previous.takeoverReason) : undefined,
          sessionId: event.sessionId ?? previous.sessionId,
          showOverlay: nextShowOverlay,
          cursor: event.state === 'idle' ? null : previous.cursor,
          ripple: event.state === 'idle' ? null : previous.ripple,
        }
        return {
          tabStates: { ...state.tabStates, [event.tabId]: next },
        }
      })
      return
    }

    if (event.type === 'move-cursor') {
      const seq = ++cursorEventSeq
      set((state) => {
        const previous = state.tabStates[event.tabId] ?? createDefaultTabOverlay(event.tabId)
        const next: BrowserUseTabOverlayState = {
          ...previous,
          actionLabel: event.label ?? previous.actionLabel,
          cursor: {
            moveId: event.moveId,
            x: event.x,
            y: event.y,
            durationMs: event.durationMs,
            targetRect: event.targetRect,
            label: event.label,
            seq,
          },
        }
        return {
          tabStates: { ...state.tabStates, [event.tabId]: next },
        }
      })
      return
    }

    if (event.type === 'click-ripple') {
      const seq = ++cursorEventSeq
      set((state) => {
        const previous = state.tabStates[event.tabId] ?? createDefaultTabOverlay(event.tabId)
        const next: BrowserUseTabOverlayState = {
          ...previous,
          ripple: {
            x: event.x,
            y: event.y,
            button: event.button ?? 'left',
            seq,
          },
        }
        return {
          tabStates: { ...state.tabStates, [event.tabId]: next },
        }
      })
      return
    }

    if (event.type === 'close-tab') {
      get().clearTabState(event.tabId)
    }
  },

  applyActivityEvent: (sessionId, activity) => {
    const targetSession = activity.sessionId || sessionId
    set((state) => {
      const existing = state.activitiesBySession[targetSession] ?? []
      const idx = existing.findIndex((item) => item.id === activity.id)
      const nextList = idx >= 0
        ? existing.map((item, i) => (i === idx ? activity : item))
        : [...existing, activity].slice(-MAX_ACTIVITIES_PER_SESSION)
      const nextTakeover = activity.takeover
        ? activity.takeover.status === 'pending'
          ? activity.takeover
          : null
        : state.takeoverBySession[targetSession]
      return {
        activitiesBySession: {
          ...state.activitiesBySession,
          [targetSession]: nextList,
        },
        ...(activity.takeover
          ? {
              takeoverBySession: {
                ...state.takeoverBySession,
                [targetSession]: nextTakeover,
              },
            }
          : {}),
      }
    })
  },

  applyTakeoverEvent: (sessionId, takeover) => {
    const targetSession = takeover.sessionId || sessionId
    set((state) => {
      const nextTakeover = takeover.status === 'pending' ? takeover : null
      const tabState = takeover.tabId ? state.tabStates[takeover.tabId] : undefined
      let nextTabStates = state.tabStates
      if (takeover.tabId && takeover.target === 'workspace') {
        const base = tabState ?? createDefaultTabOverlay(takeover.tabId)
        // Return to 'idle' on both 'resumed' and 'aborted' so the Takeover
        // Shield never gets stuck if the model replies with text instead of
        // calling another browser action; the next real browser action will
        // transition the tab back to 'active' via control-state IPC.
        const nextControl: BrowserControlState = takeover.status === 'pending'
          ? 'takeover'
          : 'idle'
        setWorkspaceBrowserAgentActive(takeover.tabId, nextControl !== 'idle')
        nextTabStates = {
          ...state.tabStates,
          [takeover.tabId]: {
            ...base,
            controlState: nextControl,
            takeoverReason: takeover.status === 'pending' ? takeover.message : undefined,
            sessionId: targetSession,
          },
        }
      }
      return {
        takeoverBySession: {
          ...state.takeoverBySession,
          [targetSession]: nextTakeover,
        },
        tabStates: nextTabStates,
      }
    })
  },

  resumeTakeover: async (sessionId, takeoverId, note) => {
    try {
      const result = await browserUseApi.resumeTakeover({ sessionId, takeoverId, note })
      if (result.takeover) {
        get().applyTakeoverEvent(sessionId, result.takeover)
      } else {
        set((state) => ({
          takeoverBySession: { ...state.takeoverBySession, [sessionId]: null },
        }))
      }
      return result.resumed
    } catch (error) {
      useUIStore.getState().addToast({
        type: 'error',
        message: error instanceof Error && error.message ? error.message : t('browserUse.takeoverCard.actionFailed'),
      })
      return false
    }
  },

  abortTakeover: async (sessionId, takeoverId, reason) => {
    try {
      const result = await browserUseApi.abortTakeover({ sessionId, takeoverId, reason })
      if (result.takeover) {
        get().applyTakeoverEvent(sessionId, result.takeover)
      } else {
        set((state) => ({
          takeoverBySession: { ...state.takeoverBySession, [sessionId]: null },
        }))
      }
      return true
    } catch (error) {
      useUIStore.getState().addToast({
        type: 'error',
        message: error instanceof Error && error.message ? error.message : t('browserUse.takeoverCard.actionFailed'),
      })
      return false
    }
  },

  clearTabState: (tabId) => {
    setWorkspaceBrowserAgentActive(tabId, false)
    set((state) => {
      if (!(tabId in state.tabStates)) return state
      const { [tabId]: _, ...rest } = state.tabStates
      return { tabStates: rest }
    })
  },

  clearSession: (sessionId) => {
    set((state) => {
      const { [sessionId]: _act, ...restActivities } = state.activitiesBySession
      const { [sessionId]: _to, ...restTakeovers } = state.takeoverBySession
      return {
        activitiesBySession: restActivities,
        takeoverBySession: restTakeovers,
      }
    })
  },

  reset: () => {
    configMutationSeq = 0
    inFlightConfigMutations = 0
    statusRequestSeq = 0
    cursorEventSeq = 0
    set({
      config: null,
      status: null,
      loaded: false,
      loading: false,
      error: null,
      tabStates: {},
      activitiesBySession: {},
      takeoverBySession: {},
    })
  },
}))
