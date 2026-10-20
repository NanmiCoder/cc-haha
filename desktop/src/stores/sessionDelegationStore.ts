import { useEffect } from 'react'
import { create } from 'zustand'
import { sessionCollaborationApi, type SessionDelegationSnapshot } from '@/api/sessionCollaboration'
import {
  buildDelegatedSessionRows,
  delegationChangeSummaries,
  type DelegatedSessionRow,
  type DelegationChangeSummary,
} from '@/components/sessionDelegation/sessionDelegationModel'

export type SessionDelegationEntry = {
  snapshot: SessionDelegationSnapshot | null
  /**
   * Derived once per snapshot and kept by identity while unchanged: the tab bar
   * and the session page pass this array into the shared Activity model cache,
   * which compares its inputs item by item.
   */
  rows: DelegatedSessionRow[]
  changes: DelegationChangeSummary[]
  error: string | null
  manageOpen: boolean
}

export const EMPTY_DELEGATED_SESSION_ROWS: DelegatedSessionRow[] = []
const EMPTY_CHANGES: DelegationChangeSummary[] = []
const EMPTY: SessionDelegationEntry = { snapshot: null, rows: EMPTY_DELEGATED_SESSION_ROWS, changes: EMPTY_CHANGES, error: null, manageOpen: false }
const reads = new Map<string, Promise<void>>()

function keepIfEqual<T>(previous: T[], next: T[], empty: T[]): T[] {
  if (next.length === 0) return empty
  return JSON.stringify(previous) === JSON.stringify(next) ? previous : next
}

type SessionDelegationState = {
  bySession: Record<string, SessionDelegationEntry>
  /**
   * Polls share a read already in flight. After a mutation pass `fresh`: a read
   * that started before it may answer with the state before it.
   */
  refresh: (sessionId: string, options?: { fresh?: boolean }) => Promise<void>
  setSnapshot: (sessionId: string, snapshot: SessionDelegationSnapshot) => void
  setManageOpen: (sessionId: string, open: boolean) => void
}

export const useSessionDelegationStore = create<SessionDelegationState>((set, get) => {
  const update = (id: string, fn: (entry: SessionDelegationEntry) => SessionDelegationEntry) => set(state => ({
    bySession: { ...state.bySession, [id]: fn(state.bySession[id] ?? EMPTY) },
  }))
  const apply = (entry: SessionDelegationEntry, snapshot: SessionDelegationSnapshot): SessionDelegationEntry => ({
    ...entry,
    snapshot,
    rows: keepIfEqual(entry.rows, buildDelegatedSessionRows(snapshot), EMPTY_DELEGATED_SESSION_ROWS),
    changes: keepIfEqual(entry.changes, delegationChangeSummaries(snapshot), EMPTY_CHANGES),
    error: null,
  })
  return {
    bySession: {},
    refresh: (id, options) => {
      const pending = reads.get(id)
      if (pending && !options?.fresh) return pending
      const request: Promise<void> = (async () => {
        // Let the earlier read land first so it cannot overwrite this one.
        if (pending) await pending
        try {
          const snapshot = await sessionCollaborationApi.get(id)
          update(id, entry => apply(entry, snapshot))
        } catch (error) {
          update(id, entry => ({ ...entry, error: error instanceof Error ? error.message : String(error) }))
        }
      })().finally(() => {
        if (reads.get(id) === request) reads.delete(id)
      })
      reads.set(id, request)
      return request
    },
    setSnapshot: (id, snapshot) => update(id, entry => apply(entry, snapshot)),
    setManageOpen: (id, open) => {
      if ((get().bySession[id]?.manageOpen ?? false) === open) return
      update(id, entry => ({ ...entry, manageOpen: open }))
    },
  }
})

/** Server state outlives navigation and reload; poll it while the session is on screen. */
export function useSessionDelegationSync(sessionId: string | null | undefined): void {
  useEffect(() => {
    if (!sessionId) return
    const { refresh } = useSessionDelegationStore.getState()
    void refresh(sessionId)
    const timer = window.setInterval(() => void refresh(sessionId), 2000)
    return () => window.clearInterval(timer)
  }, [sessionId])
}
