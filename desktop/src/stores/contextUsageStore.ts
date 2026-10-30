import { create } from 'zustand'
import { sessionsApi, type SessionContextSnapshot } from '@/api/sessions'
import type { ChatState } from '@/types/chat'

export type ContextUsageRevision = {
  runtimeSelectionKey: string
  refreshNonce: number
  messageCount: number
  contentRevision: number
  chatState: ChatState
}

type RefreshMode = 'restore' | 'auto' | 'manual' | 'force'

type ContextUsageEntry = {
  context: SessionContextSnapshot | null
  source: 'live' | 'estimate' | null
  model: string | null
  updatedAt: number | null
  error: string | null
  snapshotRevision: ContextUsageRevision | null
  requestRevision: ContextUsageRevision
  inFlight: Promise<boolean> | null
  lastAutoRefreshAt: number
}

type ContextUsageStore = {
  bySession: Record<string, ContextUsageEntry | undefined>
  clearSession: (sessionId: string) => void
  refresh: (sessionId: string, revision: ContextUsageRevision, mode: RefreshMode, visible: boolean) => Promise<boolean>
}

const AUTO_REFRESH_MIN_INTERVAL_MS = 10_000
const ACTIVE_REFRESH_MS = 30_000
// The CLI control deadline is 20s; allow the server to return its transcript fallback.
const CONTEXT_REQUEST_TIMEOUT_MS = 30_000

function sameRuntime(a: ContextUsageRevision, b: ContextUsageRevision) {
  return a.runtimeSelectionKey === b.runtimeSelectionKey && a.refreshNonce === b.refreshNonce
}

function sameRevision(a: ContextUsageRevision | null, b: ContextUsageRevision) {
  return a !== null && sameRuntime(a, b) && a.messageCount === b.messageCount
    && a.contentRevision === b.contentRevision && a.chatState === b.chatState
}

// Memory only: readings and pending requests belong to the session, not to the composer
// currently displaying it. Nothing here changes the persisted session/config format.
export const useContextUsageStore = create<ContextUsageStore>((set, get) => {
  const update = (sessionId: string, entry: ContextUsageEntry) => {
    set((state) => ({ bySession: { ...state.bySession, [sessionId]: entry } }))
  }

  return {
    bySession: {},
    clearSession: (sessionId) => {
      if (!get().bySession[sessionId]) return
      set((state) => {
        const bySession = { ...state.bySession }
        delete bySession[sessionId]
        return { bySession }
      })
    },
    refresh: (sessionId, revision, mode, visible) => {
      let entry = get().bySession[sessionId]
      if (!entry) {
        entry = {
          context: null,
          source: null,
          model: null,
          updatedAt: null,
          error: null,
          snapshotRevision: null,
          requestRevision: revision,
          inFlight: null,
          lastAutoRefreshAt: 0,
        }
        update(sessionId, entry)
      }

      const runtimeChanged = !sameRuntime(entry.requestRevision, revision)
      const turnCompleted = entry.requestRevision.chatState !== 'idle' && revision.chatState === 'idle'
      const messagesChangedWhileAway = mode === 'restore' && entry.inFlight !== null && (
        entry.requestRevision.messageCount !== revision.messageCount
        || entry.requestRevision.contentRevision !== revision.contentRevision
      )
      if (runtimeChanged || turnCompleted || messagesChangedWhileAway) {
        // Invalidate even while hidden: an old process's late response must never become
        // the cached reading for a replacement runtime or a compacted context.
        entry = { ...entry, requestRevision: revision, inFlight: null, lastAutoRefreshAt: 0 }
        update(sessionId, entry)
      }

      if ((mode === 'auto' || mode === 'restore') && !visible) return Promise.resolve(false)
      if (mode !== 'force' && entry.inFlight) return entry.inFlight
      if (mode === 'restore' && !runtimeChanged && !turnCompleted && sameRevision(entry.snapshotRevision, revision)
        && (revision.chatState === 'idle' || Date.now() - (entry.updatedAt ?? 0) < ACTIVE_REFRESH_MS)) {
        return Promise.resolve(true)
      }
      if (mode === 'auto' && Date.now() - entry.lastAutoRefreshAt < AUTO_REFRESH_MIN_INTERVAL_MS) {
        return Promise.resolve(false)
      }
      if (typeof sessionsApi.getInspection !== 'function') return Promise.resolve(false)

      const request = sessionsApi.getInspection(sessionId, {
        includeContext: true,
        contextOnly: true,
        timeout: CONTEXT_REQUEST_TIMEOUT_MS,
      }).then((inspection) => {
        const current = get().bySession[sessionId]
        if (current?.inFlight !== request) return false
        const context = inspection.context ?? inspection.contextEstimate ?? null
        if (!context) {
          update(sessionId, { ...current, error: inspection.errors?.context ?? null })
          return false
        }
        const usageModel = inspection.usage?.models.find((model) => model.displayName?.trim() || model.model?.trim())
        const model = [context.model, inspection.status?.model, usageModel?.displayName, usageModel?.model]
          .find((value) => value?.trim())?.trim() ?? null
        update(sessionId, {
          ...current,
          context,
          source: inspection.context ? 'live' : 'estimate',
          model,
          updatedAt: Date.now(),
          error: null,
          snapshotRevision: revision,
        })
        return true
      }).catch((error) => {
        const current = get().bySession[sessionId]
        if (current?.inFlight !== request) return false
        update(sessionId, { ...current, error: error instanceof Error ? error.message : String(error) })
        return false
      }).finally(() => {
        const current = get().bySession[sessionId]
        if (current?.inFlight === request) update(sessionId, { ...current, inFlight: null })
      })
      update(sessionId, {
        ...entry,
        requestRevision: revision,
        inFlight: request,
        error: null,
        lastAutoRefreshAt: mode === 'auto' || mode === 'restore' ? Date.now() : entry.lastAutoRefreshAt,
      })
      return request
    },
  }
})
