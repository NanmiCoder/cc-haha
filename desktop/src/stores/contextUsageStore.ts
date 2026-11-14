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
  detailContext: SessionContextSnapshot | null
  source: 'live' | 'estimate' | null
  model: string | null
  updatedAt: number | null
  error: string | null
  snapshotRevision: ContextUsageRevision | null
  requestRevision: ContextUsageRevision
  inFlight: Promise<boolean> | null
  detailsInFlight: Promise<boolean> | null
  abortController: AbortController | null
  detailsAbortController: AbortController | null
  requestSequence: number
  appliedHeaderSequence: number
  lastAutoRefreshAt: number
}

type ContextUsageStore = {
  bySession: Record<string, ContextUsageEntry | undefined>
  clearSession: (sessionId: string) => void
  cancelDetails: (sessionId: string) => void
  refresh: (sessionId: string, revision: ContextUsageRevision, mode: RefreshMode, visible: boolean, includeDetails?: boolean) => Promise<boolean>
}

const AUTO_REFRESH_MIN_INTERVAL_MS = 1_000
const ACTIVE_REFRESH_MS = 3_000
// Summary controls have a 5s server deadline; only the full breakdown can
// require the longer control deadline and transcript fallback.
const SUMMARY_REQUEST_TIMEOUT_MS = 6_000
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
      get().bySession[sessionId]?.abortController?.abort()
      get().bySession[sessionId]?.detailsAbortController?.abort()
      set((state) => {
        const bySession = { ...state.bySession }
        delete bySession[sessionId]
        return { bySession }
      })
    },
    cancelDetails: (sessionId) => {
      const entry = get().bySession[sessionId]
      if (!entry?.detailsInFlight) return
      entry.detailsAbortController?.abort()
      update(sessionId, { ...entry, detailsInFlight: null, detailsAbortController: null })
    },
    refresh: (sessionId, revision, mode, visible, includeDetails = mode === 'manual') => {
      const summaryOnly = !includeDetails
      let entry = get().bySession[sessionId]
      if (!entry) {
        entry = {
          context: null,
          detailContext: null,
          source: null,
          model: null,
          updatedAt: null,
          error: null,
          snapshotRevision: null,
          requestRevision: revision,
          inFlight: null,
          detailsInFlight: null,
          abortController: null,
          detailsAbortController: null,
          requestSequence: 0,
          appliedHeaderSequence: 0,
          lastAutoRefreshAt: 0,
        }
        update(sessionId, entry)
      }

      const runtimeChanged = !sameRuntime(entry.requestRevision, revision)
      const turnCompleted = entry.requestRevision.chatState !== 'idle' && revision.chatState === 'idle'
      const messagesChangedWhileAway = mode === 'restore' && (entry.inFlight !== null || entry.detailsInFlight !== null) && (
        entry.requestRevision.messageCount !== revision.messageCount
        || entry.requestRevision.contentRevision !== revision.contentRevision
      )
      if (runtimeChanged || turnCompleted || messagesChangedWhileAway) {
        // Invalidate even while hidden: an old process's late response must never become
        // the cached reading for a replacement runtime or a compacted context.
        entry.abortController?.abort()
        entry.detailsAbortController?.abort()
        entry = {
          ...entry,
          requestRevision: revision,
          inFlight: null,
          detailsInFlight: null,
          abortController: null,
          detailsAbortController: null,
          detailContext: runtimeChanged || turnCompleted ? null : entry.detailContext,
          lastAutoRefreshAt: 0,
        }
        update(sessionId, entry)
      }

      if ((mode === 'auto' || mode === 'restore') && !visible) return Promise.resolve(false)
      const pending = includeDetails ? entry.detailsInFlight : entry.inFlight
      if (mode !== 'force' && pending) return pending
      if (mode === 'restore' && !runtimeChanged && !turnCompleted
        && (!includeDetails || entry.detailContext !== null) && sameRevision(entry.snapshotRevision, revision)
        && (revision.chatState === 'idle' || Date.now() - (entry.updatedAt ?? 0) < ACTIVE_REFRESH_MS)) {
        return Promise.resolve(true)
      }
      if (mode === 'auto' && Date.now() - entry.lastAutoRefreshAt < AUTO_REFRESH_MIN_INTERVAL_MS) {
        return Promise.resolve(false)
      }
      if (typeof sessionsApi.getInspection !== 'function') return Promise.resolve(false)

      // Keep one request of each kind: a slow breakdown must neither block
      // the live meter nor get cancelled by its three-second summary polls.
      if (includeDetails) entry.detailsAbortController?.abort()
      else entry.abortController?.abort()
      const controller = new AbortController()
      const requestSequence = entry.requestSequence + 1
      const isCurrent = (current: ContextUsageEntry | undefined) =>
        current !== undefined && (includeDetails ? current.detailsInFlight : current.inFlight) === request
      const request = sessionsApi.getInspection(sessionId, {
        includeContext: true,
        contextOnly: true,
        summaryOnly,
        timeout: summaryOnly ? SUMMARY_REQUEST_TIMEOUT_MS : CONTEXT_REQUEST_TIMEOUT_MS,
        signal: controller.signal,
      }).then((inspection) => {
        const current = get().bySession[sessionId]
        if (!isCurrent(current) || !current) return false
        const context = inspection.context ?? inspection.contextEstimate ?? null
        if (!context) {
          if (!includeDetails && requestSequence > current.appliedHeaderSequence) {
            update(sessionId, { ...current, error: inspection.errors?.context ?? null })
          }
          return false
        }
        const usageModel = inspection.usage?.models.find((model) => model.displayName?.trim() || model.model?.trim())
        const model = [context.model, inspection.status?.model, usageModel?.displayName, usageModel?.model]
          .find((value) => value?.trim())?.trim() ?? null
        // Summary and full replies share one ordering. A response may finish
        // later while still describing an older request's context snapshot.
        const updateHeader = requestSequence > current.appliedHeaderSequence
        update(sessionId, {
          ...current,
          ...(includeDetails ? { detailContext: context } : {}),
          ...(updateHeader ? {
            context,
            source: inspection.context ? 'live' as const : 'estimate' as const,
            model,
            updatedAt: Date.now(),
            error: null,
            snapshotRevision: revision,
            appliedHeaderSequence: requestSequence,
          } : {}),
        })
        return true
      }).catch((error) => {
        const current = get().bySession[sessionId]
        if (!isCurrent(current) || !current) return false
        if (!includeDetails && requestSequence > current.appliedHeaderSequence) {
          update(sessionId, { ...current, error: error instanceof Error ? error.message : String(error) })
        }
        return false
      }).finally(() => {
        const current = get().bySession[sessionId]
        if (isCurrent(current) && current) update(sessionId, {
          ...current,
          ...(includeDetails
            ? { detailsInFlight: null, detailsAbortController: null }
            : { inFlight: null, abortController: null }),
        })
      })
      update(sessionId, {
        ...entry,
        requestRevision: revision,
        requestSequence,
        ...(includeDetails
          ? { detailsInFlight: request, detailsAbortController: controller }
          : { inFlight: request, abortController: controller, error: null }),
        lastAutoRefreshAt: !includeDetails && (mode === 'auto' || mode === 'restore') ? Date.now() : entry.lastAutoRefreshAt,
      })
      return request
    },
  }
})
