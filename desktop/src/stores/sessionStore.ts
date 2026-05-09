import { create } from 'zustand'
import { sessionsApi, type CreateSessionRepositoryOptions } from '../api/sessions'
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
  selectedProjects: string[]
  availableProjects: string[]

  fetchSessions: (project?: string) => Promise<void>
  createSession: (workDir?: string, options?: CreateSessionOptions) => Promise<string>
  deleteSession: (id: string) => Promise<void>
  renameSession: (id: string, title: string) => Promise<void>
  updateSessionTitle: (id: string, title: string) => void
  setActiveSession: (id: string | null) => void
  setSelectedProjects: (projects: string[]) => void
}

export const useSessionStore = create<SessionStore>((set, get) => ({
  sessions: [],
  activeSessionId: null,
  isLoading: false,
  error: null,
  selectedProjects: [],
  availableProjects: [],

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
        const availableProjects = [...new Set(sessions.map((s) => s.projectPath).filter(Boolean))].sort()
        return { sessions, availableProjects, isLoading: false }
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
    }))
  },

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
  setSelectedProjects: (projects) => set({ selectedProjects: projects }),
}))

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
