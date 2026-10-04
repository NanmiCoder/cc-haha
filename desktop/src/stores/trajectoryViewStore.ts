import { create } from 'zustand'
import type { ChatNavigationTarget } from '../lib/trajectory/chatTarget'

export type SessionViewMode = 'chat' | 'trajectory'

export const TRAJECTORY_DETAIL_WIDTH_KEY = 'cc-haha-trajectory-detail-width'
export const TRAJECTORY_DETAIL_WIDTH_DEFAULT = 440
export const TRAJECTORY_DETAIL_WIDTH_MIN = 320
export const TRAJECTORY_DETAIL_WIDTH_MAX = 720

/**
 * A one-shot request to reveal something in the other view. The consumer
 * (trajectory view or message list) handles it once and clears it by nonce,
 * so a re-render can never replay a stale jump.
 */
export type TrajectoryNavRequest =
  | { nonce: number; sessionId: string; to: 'trajectory'; rowId: string }
  | { nonce: number; sessionId: string; to: 'chat'; target: ChatNavigationTarget }

type TrajectoryViewState = {
  modes: Record<string, SessionViewMode>
  /** Sessions whose trajectory view has been opened at least once. */
  opened: Record<string, true>
  detailWidth: number
  nav: TrajectoryNavRequest | null
  setMode: (sessionId: string, mode: SessionViewMode) => void
  setDetailWidth: (width: number) => void
  /** Switch to the trajectory and select a row there. */
  revealInTrajectory: (sessionId: string, rowId: string) => void
  /** Switch to the chat and scroll to a message or tool call. */
  revealInChat: (sessionId: string, target: ChatNavigationTarget) => void
  consumeNav: (nonce: number) => void
  forgetSession: (sessionId: string) => void
}

export function clampDetailWidth(width: number): number {
  if (!Number.isFinite(width)) return TRAJECTORY_DETAIL_WIDTH_DEFAULT
  return Math.round(Math.min(TRAJECTORY_DETAIL_WIDTH_MAX, Math.max(TRAJECTORY_DETAIL_WIDTH_MIN, width)))
}

function readStoredWidth(): number {
  try {
    const raw = globalThis.localStorage?.getItem(TRAJECTORY_DETAIL_WIDTH_KEY)
    if (!raw) return TRAJECTORY_DETAIL_WIDTH_DEFAULT
    const value = Number(raw)
    return Number.isFinite(value) ? clampDetailWidth(value) : TRAJECTORY_DETAIL_WIDTH_DEFAULT
  } catch {
    return TRAJECTORY_DETAIL_WIDTH_DEFAULT
  }
}

function writeStoredWidth(width: number) {
  try {
    globalThis.localStorage?.setItem(TRAJECTORY_DETAIL_WIDTH_KEY, String(width))
  } catch {
    // Storage can be unavailable (private mode, quota); the width just won't persist.
  }
}

let nextNonce = 1

export const useTrajectoryViewStore = create<TrajectoryViewState>((set) => ({
  modes: {},
  opened: {},
  detailWidth: readStoredWidth(),
  nav: null,

  setMode: (sessionId, mode) => set((state) => (
    state.modes[sessionId] === mode && (mode === 'chat' || state.opened[sessionId])
      ? state
      : {
          modes: { ...state.modes, [sessionId]: mode },
          opened: mode === 'trajectory' && !state.opened[sessionId]
            ? { ...state.opened, [sessionId]: true }
            : state.opened,
        }
  )),

  setDetailWidth: (width) => {
    const next = clampDetailWidth(width)
    writeStoredWidth(next)
    set({ detailWidth: next })
  },

  revealInTrajectory: (sessionId, rowId) => set((state) => ({
    modes: { ...state.modes, [sessionId]: 'trajectory' },
    opened: state.opened[sessionId] ? state.opened : { ...state.opened, [sessionId]: true },
    nav: { nonce: nextNonce++, sessionId, to: 'trajectory', rowId },
  })),

  revealInChat: (sessionId, target) => set((state) => ({
    modes: { ...state.modes, [sessionId]: 'chat' },
    nav: { nonce: nextNonce++, sessionId, to: 'chat', target },
  })),

  consumeNav: (nonce) => set((state) => (state.nav?.nonce === nonce ? { nav: null } : state)),

  forgetSession: (sessionId) => set((state) => {
    if (!(sessionId in state.modes) && !(sessionId in state.opened)) return state
    const modes = { ...state.modes }
    const opened = { ...state.opened }
    delete modes[sessionId]
    delete opened[sessionId]
    return { modes, opened, nav: state.nav?.sessionId === sessionId ? null : state.nav }
  }),
}))
