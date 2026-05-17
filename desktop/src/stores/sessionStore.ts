import { create } from 'zustand'
import { sessionsApi, type BatchDeleteSessionsResponse, type CreateSessionRepositoryOptions } from '../api/sessions'
import { useSessionRuntimeStore } from './sessionRuntimeStore'
import { useTabStore } from './tabStore'
import type { SessionListItem } from '../types/session'
import { isPlaceholderSessionTitle } from '../lib/sessionTitle'

type CreateSessionOptions = {
  repository?: CreateSessionRepositoryOptions
}

type SessionStore = {
  sessions: SessionListItem[]
  activeSessionId: string | null
  isLoading: boolean
  error: string | null
  isBatchMode: boolean
  selectedSessionIds: Set<string>

  fetchSessions: (project?: string) => Promise<void>
  createSession: (workDir?: string, options?: CreateSessionOptions) => Promise<string>
  deleteSession: (id: string) => Promise<void>
  deleteSessions: (ids: string[]) => Promise<BatchDeleteSessionsResponse>
  enterBatchMode: () => void
  exitBatchMode: () => void
  toggleSessionSelected: (id: string) => void
  selectSessions: (ids: string[]) => void
  deselectSessions: (ids: string[]) => void
  clearSessionSelection: () => void
  renameSession: (id: string, title: string) => Promise<void>
  updateSessionTitle: (id: string, title: string) => void
  setActiveSession: (id: string | null) => void
}

export const useSessionStore = create<SessionStore>((set, get) => ({
  sessions: [],
  activeSessionId: null,
  isLoading: false,
  error: null,
  isBatchMode: false,
  selectedSessionIds: new Set(),

  fetchSessions: async (project?: string) => {
    set({ isLoading: true, error: null })
    try {
      const { sessions: raw } = await sessionsApi.list({ project, limit: 100 })
      let syncedSessions: SessionListItem[] = []
      set((state) => {
        const currentById = new Map(state.sessions.map((session) => [session.id, session]))
        // Deduplicate by session ID - keep the most recently modified entry.
        const byId = new Map<string, SessionListItem>()
        for (const s of raw) {
          const current = currentById.get(s.id)
          const candidate = preserveLocalTitle(current, s)
          const existing = byId.get(s.id)
          if (!existing || new Date(candidate.modifiedAt) > new Date(existing.modifiedAt)) {
            byId.set(s.id, candidate)
          }
        }
        const sessions = [...byId.values()]
        syncedSessions = sessions
        return { sessions, isLoading: false }
      })
      syncOpenSessionTabTitles(syncedSessions)
    } catch (err) {
      set({ error: (err as Error).message, isLoading: false })
    }
  },

  createSession: async (workDir?: string, options?: CreateSessionOptions) => {
    const { sessionId: id, workDir: resolvedWorkDir } = await sessionsApi.create({
      ...(workDir ? { workDir } : {}),
      ...(options?.repository ? { repository: options.repository } : {}),
    })
    const now = new Date().toISOString()
    const optimisticSession: SessionListItem = {
      id,
      title: 'New Session',
      createdAt: now,
      modifiedAt: now,
      messageCount: 0,
      projectPath: '',
      workDir: resolvedWorkDir ?? workDir ?? null,
      projectRoot: resolvedWorkDir ?? workDir ?? null,
      workDirExists: true,
    }

    set((state) => ({
      sessions: state.sessions.some((session) => session.id === id)
        ? state.sessions
        : [optimisticSession, ...state.sessions],
      activeSessionId: id,
    }))

    void get().fetchSessions()
    return id
  },

  deleteSession: async (id: string) => {
    await sessionsApi.delete(id)
    useSessionRuntimeStore.getState().clearSelection(id)
    set((s) => ({
      sessions: s.sessions.filter((session) => session.id !== id),
      activeSessionId: s.activeSessionId === id ? null : s.activeSessionId,
      selectedSessionIds: removeIdsFromSet(s.selectedSessionIds, [id]),
    }))
  },

  deleteSessions: async (ids: string[]) => {
    const sessionIds = [...new Set(ids)].filter(Boolean)
    const result = await sessionsApi.batchDelete(sessionIds)
    for (const id of result.successes) {
      useSessionRuntimeStore.getState().clearSelection(id)
    }
    set((s) => ({
      sessions: s.sessions.filter((session) => !result.successes.includes(session.id)),
      activeSessionId: s.activeSessionId && result.successes.includes(s.activeSessionId)
        ? null
        : s.activeSessionId,
      selectedSessionIds: removeIdsFromSet(s.selectedSessionIds, result.successes),
    }))
    return result
  },

  enterBatchMode: () => set({ isBatchMode: true }),
  exitBatchMode: () => set({ isBatchMode: false, selectedSessionIds: new Set() }),
  toggleSessionSelected: (id) => set((s) => {
    const selectedSessionIds = new Set(s.selectedSessionIds)
    if (selectedSessionIds.has(id)) {
      selectedSessionIds.delete(id)
    } else {
      selectedSessionIds.add(id)
    }
    return { selectedSessionIds }
  }),
  selectSessions: (ids) => set((s) => {
    const selectedSessionIds = new Set(s.selectedSessionIds)
    for (const id of ids) selectedSessionIds.add(id)
    return { selectedSessionIds }
  }),
  deselectSessions: (ids) => set((s) => ({
    selectedSessionIds: removeIdsFromSet(s.selectedSessionIds, ids),
  })),
  clearSessionSelection: () => set({ selectedSessionIds: new Set() }),

  renameSession: async (id: string, title: string) => {
    await sessionsApi.rename(id, title)
    set((s) => ({
      sessions: s.sessions.map((session) =>
        session.id === id ? { ...session, title } : session,
      ),
    }))
  },

  updateSessionTitle: (id, title) => {
    set((s) => ({
      sessions: s.sessions.map((session) =>
        session.id === id ? { ...session, title } : session,
      ),
    }))
  },

  setActiveSession: (id) => set({ activeSessionId: id }),
}))

function removeIdsFromSet(selected: Set<string>, ids: string[]): Set<string> {
  if (ids.length === 0) return selected
  const next = new Set(selected)
  for (const id of ids) next.delete(id)
  return next
}

function preserveLocalTitle(
  current: SessionListItem | undefined,
  incoming: SessionListItem,
): SessionListItem {
  if (!current) return incoming
  if (isPlaceholderSessionTitle(incoming.title) && !isPlaceholderSessionTitle(current.title)) {
    return { ...incoming, title: current.title }
  }
  return incoming
}

function syncOpenSessionTabTitles(sessions: SessionListItem[]): void {
  const titleById = new Map(sessions.map((session) => [session.id, session.title]))
  const { tabs, updateTabTitle } = useTabStore.getState()
  for (const tab of tabs) {
    if (tab.type !== 'session') continue
    const title = titleById.get(tab.sessionId)
    if (title && title !== tab.title) {
      updateTabTitle(tab.sessionId, title)
    }
  }
}
