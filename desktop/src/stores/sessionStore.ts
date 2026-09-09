import type { SessionProtocolState } from '../../../src/shared/sessionProtocol'
import { create } from 'zustand'
import {
  sessionsApi,
  type BatchDeleteSessionsResponse,
  type BranchSessionResponse,
  type CreateSessionRepositoryOptions,
  type ProjectSessionHistoryParams,
  type ProjectSessionHistoryResponse,
} from '../api/sessions'
import { ApiError } from '../api/client'
import { useSessionRuntimeStore } from './sessionRuntimeStore'
import { useSettingsStore } from './settingsStore'
import { useTabStore } from './tabStore'
import type { LocalIndexStatus, SessionListItem } from '../types/session'
import type { PermissionMode } from '../types/settings'
import type { RuntimeSelection } from '../types/runtime'
import { isPlaceholderSessionTitle } from '../lib/sessionTitle'
import { invalidateRecentProjectsCache } from '../lib/recentProjectsCache'

const SESSION_LIST_LIMIT = 400
const PROJECT_HISTORY_PAGE_SIZE = 50

export type ProjectHistoryState = {
  isLoading: boolean
  error: string | null
  initialized: boolean
  hasMore: boolean
  nextCursor: string | null
  sessionIds: Set<string>
  excludedSessionIds?: Set<string>
  requestId: number
}
type RecentProjectBoundary = { beforeModifiedAt: string; beforeId: string }

type CreateSessionOptions = {
  repository?: CreateSessionRepositoryOptions
  permissionMode?: PermissionMode
}

type BranchSessionResult = Pick<BranchSessionResponse, 'sessionId' | 'title' | 'workDir'>

type SessionStore = {
  sessions: SessionListItem[]
  activeSessionId: string | null
  isLoading: boolean
  error: string | null
  indexStatus: LocalIndexStatus | null
  sessionListRequestId: number
  isBatchMode: boolean
  selectedSessionIds: Set<string>
  historicalSessionIds: Set<string>
  recentSessionIds: Set<string>
  recentProjectBoundaries: Record<string, RecentProjectBoundary>
  projectHistory: Record<string, ProjectHistoryState>

  fetchSessions: (project?: string) => Promise<void>
  loadMoreProjectSessions: (projectRoot: string) => Promise<void>
  releaseProjectHistory: (projectRoot: string) => void
  hydrateHistoricalSessions: (
    sessions: SessionListItem[],
    expectedSelections?: Record<string, RuntimeSelection>,
  ) => SessionListItem[]
  openHistoricalSession: (session: SessionListItem) => void
  createSession: (workDir?: string, options?: CreateSessionOptions) => Promise<string>
  branchSession: (
    sourceSessionId: string,
    targetMessageId: string,
    options?: { title?: string },
  ) => Promise<BranchSessionResult>
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
  updateSessionMessageCount: (id: string, messageCount: number) => void
  updateSessionPermissionMode: (id: string, mode: PermissionMode) => void
  updateSessionApiFormat: (id: string, sessionApiFormat: SessionProtocolState) => void
  setActiveSession: (id: string | null) => void
}

let fetchSessionsRequestId = 0
let projectHistoryRequestId = 0
const projectHistoryRequests = new Map<string, {
  controller: AbortController
  requestId: number
  excludedSessionIds: Set<string>
}>()
// The local index can lag the create response by one refresh. Keep explicit
// ids from that response until the list has observed them at least once.
const pendingCreatedSessionIds = new Set<string>()

export const useSessionStore = create<SessionStore>((set, get) => ({
  sessions: [],
  activeSessionId: null,
  isLoading: false,
  error: null,
  indexStatus: null,
  sessionListRequestId: 0,
  isBatchMode: false,
  selectedSessionIds: new Set(),
  historicalSessionIds: new Set(),
  recentSessionIds: new Set(),
  recentProjectBoundaries: {},
  projectHistory: {},

  fetchSessions: async (project?: string) => {
    const requestId = ++fetchSessionsRequestId
    const expectedSelections = useSessionRuntimeStore.getState().selections
    set({ isLoading: true, error: null, sessionListRequestId: requestId })
    try {
      const response = await sessionsApi.list(buildSessionListParams(project))
      if (requestId !== get().sessionListRequestId) return
      const raw = response.sessions
      const indexStatus = response.index ?? null
      useSessionRuntimeStore.getState().syncFromSessions(raw, expectedSelections)
      let syncedSessions: SessionListItem[] = []
      set((state) => {
        if (requestId !== state.sessionListRequestId) return state
        const openSessionIds = getOpenSessionIds()
        const projectSessionIds = getProjectHistorySessionIds(state.projectHistory)
        const historicalSessionIds = new Set([...state.historicalSessionIds]
          .filter((id) => openSessionIds.has(id)))
        // Only explicitly opened history needs metadata outside the recent
        // page. Closing its tab releases it even while the index is building.
        const retainedSessions = state.sessions.filter((session) => (
          !state.historicalSessionIds.has(session.id) || historicalSessionIds.has(session.id) || projectSessionIds.has(session.id)
        ))
        const incomingSessions = reconcilePendingCreatedSessions(raw, retainedSessions)
        const incomingIds = new Set(incomingSessions.map((session) => session.id))
        const retainedHistory = retainedSessions.filter((session) => (
          (historicalSessionIds.has(session.id) || projectSessionIds.has(session.id)) && !incomingIds.has(session.id)
        ))
        const sessions = mergeSessionList(
          shouldRetainRenderedSessions(indexStatus)
            ? [...incomingSessions, ...retainedSessions]
            : [...incomingSessions, ...retainedHistory],
          state.sessions,
        )
        syncedSessions = sessions
        return {
          sessions,
          historicalSessionIds,
          recentSessionIds: new Set([
            ...(shouldRetainRenderedSessions(indexStatus) ? state.recentSessionIds : []),
            ...raw.map((session) => session.id),
          ]),
          recentProjectBoundaries: shouldRetainRenderedSessions(indexStatus) ? {} : buildRecentProjectBoundaries(raw),
          indexStatus,
          isLoading: indexStatus?.state === 'building' && sessions.length === 0,
        }
      })
      syncOpenSessionTabTitles(syncedSessions)
    } catch (err) {
      if (requestId !== get().sessionListRequestId) return
      set({ error: (err as Error).message, isLoading: false })
    }
  },

  loadMoreProjectSessions: async (projectRoot) => {
    if (!projectRoot) return
    const previous = get().projectHistory[projectRoot]
    if (previous?.isLoading || (previous?.initialized && !previous.hasMore)) return
    const requestId = ++projectHistoryRequestId
    const controller = new AbortController()
    const request = { controller, requestId, excludedSessionIds: new Set(previous?.excludedSessionIds) }
    projectHistoryRequests.set(projectRoot, request)
    set((state) => ({
      projectHistory: {
        ...state.projectHistory,
        [projectRoot]: {
          initialized: false,
          hasMore: true,
          nextCursor: null,
          sessionIds: new Set(),
          ...state.projectHistory[projectRoot],
          isLoading: true,
          error: null,
          requestId,
        },
      },
    }))
    const isCurrent = () => !controller.signal.aborted &&
      get().projectHistory[projectRoot]?.requestId === requestId
    const cursor = previous?.nextCursor
    try {
      let response: ProjectSessionHistoryResponse
      try {
        response = await sessionsApi.listProjectHistory(
          cursor
            ? { projectRoot, limit: PROJECT_HISTORY_PAGE_SIZE, cursor }
            : initialProjectHistoryParams(projectRoot, get()),
          { signal: controller.signal },
        )
      } catch (error) {
        if (!isCurrent()) return
        if (!cursor || !(error instanceof ApiError) || error.status !== 409) throw error
        // Snapshot cursors can expire. Restart once, keeping visible rows and
        // discarding the expired cursor even if the replacement request fails.
        set((state) => ({
          projectHistory: {
            ...state.projectHistory,
            [projectRoot]: { ...state.projectHistory[projectRoot]!, nextCursor: null, initialized: false, hasMore: true },
          },
        }))
        response = await sessionsApi.listProjectHistory(initialProjectHistoryParams(projectRoot, get()), { signal: controller.signal })
      }
      if (!isCurrent()) return
      const incoming = reconcileSessionSnapshots(
        response.sessions.filter((session) => !request.excludedSessionIds.has(session.id)),
        get().sessions,
      )
      set((state) => {
        const history = state.projectHistory[projectRoot]
        if (history?.requestId !== requestId) return state
        return {
          sessions: mergeSessionList([...incoming, ...state.sessions], state.sessions),
          projectHistory: {
            ...state.projectHistory,
            [projectRoot]: {
              ...history,
              sessionIds: new Set([...history.sessionIds, ...incoming.map((session) => session.id)]),
              nextCursor: response.nextCursor,
              hasMore: response.nextCursor !== null,
              initialized: true,
              isLoading: false,
              error: null,
            },
          },
        }
      })
      syncOpenSessionTabTitles(incoming)
    } catch (error) {
      if (!isCurrent()) return
      set((state) => ({
        projectHistory: {
          ...state.projectHistory,
          [projectRoot]: { ...state.projectHistory[projectRoot]!, isLoading: false, error: error instanceof Error ? error.message : String(error) },
        },
      }))
    } finally {
      if (projectHistoryRequests.get(projectRoot) === request) projectHistoryRequests.delete(projectRoot)
    }
  },

  releaseProjectHistory: (projectRoot) => {
    projectHistoryRequests.get(projectRoot)?.controller.abort()
    projectHistoryRequests.delete(projectRoot)
    set((state) => {
      const history = state.projectHistory[projectRoot]
      if (!history) return state
      const { [projectRoot]: _released, ...projectHistory } = state.projectHistory
      const openSessionIds = getOpenSessionIds()
      const historicalSessionIds = new Set([
        ...state.historicalSessionIds,
        ...[...history.sessionIds].filter((id) => openSessionIds.has(id)),
      ])
      const remainingProjectIds = getProjectHistorySessionIds(projectHistory)
      return {
        projectHistory,
        historicalSessionIds,
        sessions: state.sessions.filter((session) => (
          !history.sessionIds.has(session.id) || state.recentSessionIds.has(session.id) ||
          remainingProjectIds.has(session.id) || historicalSessionIds.has(session.id) ||
          pendingCreatedSessionIds.has(session.id)
        )),
      }
    })
  },

  hydrateHistoricalSessions: (snapshots, expectedSelections) => {
    if (snapshots.length === 0) return []
    const selected = reconcileSessionSnapshots(snapshots, get().sessions)
    const selectedIds = new Set(selected.map((session) => session.id))
    // Hydrate before activating the tab: connecting immediately applies its
    // runtime selection and the composer reads workspace/permission metadata.
    useSessionRuntimeStore.getState().syncFromSessions(selected, expectedSelections)
    set((state) => ({
      sessions: mergeSessionList([
        ...selected,
        ...state.sessions.filter((item) => !selectedIds.has(item.id)),
      ], state.sessions),
      historicalSessionIds: new Set([...state.historicalSessionIds, ...selectedIds]),
    }))
    return selected
  },

  openHistoricalSession: (session) => {
    const [selected] = get().hydrateHistoricalSessions([session])
    if (!selected) return
    set({ activeSessionId: selected.id })
    useTabStore.getState().openTab(selected.id, selected.title)
  },

  createSession: async (workDir?: string, options?: CreateSessionOptions) => {
    const requestedPermissionMode = options?.permissionMode ?? getDefaultSessionPermissionMode()
    const { sessionId: id, workDir: resolvedWorkDir } = await sessionsApi.create({
      ...(workDir ? { workDir } : {}),
      ...(options?.repository ? { repository: options.repository } : {}),
      ...(requestedPermissionMode ? { permissionMode: requestedPermissionMode } : {}),
    })
    invalidateRecentProjectsCache()
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
      permissionMode: requestedPermissionMode,
    }

    pendingCreatedSessionIds.add(id)
    set((state) => ({
      sessions: state.sessions.some((session) => session.id === id)
        ? state.sessions
        : [optimisticSession, ...state.sessions],
      activeSessionId: id,
    }))

    void get().fetchSessions()
    return id
  },

  branchSession: async (sourceSessionId, targetMessageId, options) => {
    const result = await sessionsApi.branch(sourceSessionId, {
      targetMessageId,
      ...(options?.title ? { title: options.title } : {}),
    })
    invalidateRecentProjectsCache()
    const sourceSession = get().sessions.find((session) => session.id === sourceSessionId)
    const now = new Date().toISOString()
    const optimisticSession: SessionListItem = {
      id: result.sessionId,
      title: result.title || 'New Session',
      createdAt: now,
      modifiedAt: now,
      messageCount: 0,
      projectPath: sourceSession?.projectPath ?? '',
      projectRoot: sourceSession?.projectRoot ?? sourceSession?.workDir ?? result.workDir ?? null,
      workDir: result.workDir ?? sourceSession?.workDir ?? null,
      workDirExists: true,
    }

    pendingCreatedSessionIds.add(result.sessionId)
    set((state) => ({
      sessions: state.sessions.some((session) => session.id === result.sessionId)
        ? state.sessions.map((session) =>
            session.id === result.sessionId
              ? { ...session, ...optimisticSession }
              : session)
        : [optimisticSession, ...state.sessions],
      activeSessionId: result.sessionId,
    }))

    void get().fetchSessions()
    return {
      sessionId: result.sessionId,
      title: result.title,
      workDir: result.workDir,
    }
  },

  deleteSession: async (id: string) => {
    await sessionsApi.delete(id)
    pendingCreatedSessionIds.delete(id)
    invalidateRecentProjectsCache()
    useSessionRuntimeStore.getState().clearSelection(id)
    excludeDeletedProjectSessions([id])
    set((s) => ({
      sessions: s.sessions.filter((session) => session.id !== id),
      historicalSessionIds: removeIdsFromSet(s.historicalSessionIds, [id]),
      recentSessionIds: removeIdsFromSet(s.recentSessionIds, [id]),
      projectHistory: removeProjectHistorySessionIds(s.projectHistory, [id]),
      activeSessionId: s.activeSessionId === id ? null : s.activeSessionId,
      selectedSessionIds: removeIdsFromSet(s.selectedSessionIds, [id]),
      sessionListRequestId: ++fetchSessionsRequestId,
      isLoading: false,
    }))
  },

  deleteSessions: async (ids: string[]) => {
    const sessionIds = [...new Set(ids)].filter(Boolean)
    const result = await sessionsApi.batchDelete(sessionIds)
    if (result.successes.length > 0) {
      invalidateRecentProjectsCache()
    }
    for (const id of result.successes) {
      pendingCreatedSessionIds.delete(id)
      useSessionRuntimeStore.getState().clearSelection(id)
    }
    excludeDeletedProjectSessions(result.successes)
    set((s) => ({
      sessions: s.sessions.filter((session) => !result.successes.includes(session.id)),
      historicalSessionIds: removeIdsFromSet(s.historicalSessionIds, result.successes),
      recentSessionIds: removeIdsFromSet(s.recentSessionIds, result.successes),
      projectHistory: removeProjectHistorySessionIds(s.projectHistory, result.successes),
      activeSessionId: s.activeSessionId && result.successes.includes(s.activeSessionId)
        ? null
        : s.activeSessionId,
      selectedSessionIds: removeIdsFromSet(s.selectedSessionIds, result.successes),
      ...(result.successes.length > 0
        ? { sessionListRequestId: ++fetchSessionsRequestId, isLoading: false }
        : {}),
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

  updateSessionMessageCount: (id, messageCount) => {
    set((s) => ({
      sessions: s.sessions.map((session) =>
        session.id === id ? { ...session, messageCount } : session,
      ),
    }))
  },

  updateSessionPermissionMode: (id, mode) => {
    set((s) => ({
      sessions: s.sessions.map((session) =>
        session.id === id ? { ...session, permissionMode: mode } : session,
      ),
    }))
  },

  updateSessionApiFormat: (id, sessionApiFormat) => {
    set((state) => ({
      sessions: state.sessions.map((session) =>
        session.id === id ? { ...session, sessionApiFormat } : session,
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

function getOpenSessionIds(): Set<string> {
  return new Set(useTabStore.getState().tabs.flatMap((tab) => tab.type === 'session'
    ? [tab.sessionId]
    : tab.type === 'trace' && tab.traceSessionId ? [tab.traceSessionId] : []))
}

function getProjectHistorySessionIds(projectHistory: Record<string, ProjectHistoryState>): Set<string> {
  return new Set(Object.values(projectHistory).flatMap((history) => [...history.sessionIds]))
}

function initialProjectHistoryParams(
  projectRoot: string,
  state: Pick<SessionStore, 'recentProjectBoundaries'>,
): ProjectSessionHistoryParams {
  // Only the recent page forms a contiguous prefix. An individually restored
  // old tab cannot serve as the boundary without skipping the history gap.
  return {
    projectRoot,
    limit: PROJECT_HISTORY_PAGE_SIZE,
    ...state.recentProjectBoundaries[projectRoot],
  }
}

function buildRecentProjectBoundaries(sessions: SessionListItem[]): Record<string, RecentProjectBoundary> {
  const boundaries: Record<string, RecentProjectBoundary> = {}
  for (const session of sessions) {
    const root = session.projectRoot || session.workDir || session.projectPath
    const modifiedAt = Date.parse(session.modifiedAt)
    if (!root || !Number.isFinite(modifiedAt)) continue
    const existing = boundaries[root]
    if (!existing || modifiedAt < Date.parse(existing.beforeModifiedAt) ||
      (modifiedAt === Date.parse(existing.beforeModifiedAt) && session.id.localeCompare(existing.beforeId) > 0)) {
      boundaries[root] = { beforeModifiedAt: session.modifiedAt, beforeId: session.id }
    }
  }
  return boundaries
}

function excludeDeletedProjectSessions(ids: string[]): void {
  for (const request of projectHistoryRequests.values()) {
    for (const id of ids) request.excludedSessionIds.add(id)
  }
}

function removeProjectHistorySessionIds(
  projectHistory: Record<string, ProjectHistoryState>,
  ids: string[],
): Record<string, ProjectHistoryState> {
  if (ids.length === 0) return projectHistory
  return Object.fromEntries(Object.entries(projectHistory).map(([root, history]) => [
    root,
    {
      ...history,
      sessionIds: removeIdsFromSet(history.sessionIds, ids),
      excludedSessionIds: new Set([...(history.excludedSessionIds ?? []), ...ids]),
    },
  ]))
}

function buildSessionListParams(project: string | undefined) {
  return project
    ? { project, limit: SESSION_LIST_LIMIT }
    : { limit: SESSION_LIST_LIMIT }
}

function getDefaultSessionPermissionMode(): PermissionMode | undefined {
  const mode = useSettingsStore.getState().permissionMode
  return mode === 'default' ? undefined : mode
}

export function reconcileSessionSnapshots(
  snapshots: SessionListItem[],
  currentSessions: SessionListItem[],
): SessionListItem[] {
  const currentById = new Map(currentSessions.map((session) => [session.id, session]))
  // History pages and tab restoration both outlive sidebar refreshes. Keep
  // newer local data, including metadata edits with unchanged activity time.
  return snapshots.map((snapshot) => {
    const current = currentById.get(snapshot.id)
    return current && sessionModifiedTime(current) >= sessionModifiedTime(snapshot)
      ? current
      : snapshot
  })
}

function mergeSessionList(
  incoming: SessionListItem[],
  currentForTitle: SessionListItem[],
): SessionListItem[] {
  const currentById = new Map(currentForTitle.map((session) => [session.id, session]))
  const byId = new Map<string, SessionListItem>()

  for (const item of incoming) {
    const current = currentById.get(item.id)
    const candidate = preserveLocalMetadata(current, item)
    const existing = byId.get(candidate.id)
    if (!existing || sessionModifiedTime(candidate) > sessionModifiedTime(existing)) {
      byId.set(candidate.id, candidate)
    }
  }

  return [...byId.values()].sort((a, b) => sessionModifiedTime(b) - sessionModifiedTime(a))
}

function reconcilePendingCreatedSessions(
  incoming: SessionListItem[],
  current: SessionListItem[],
): SessionListItem[] {
  const incomingIds = new Set(incoming.map((session) => session.id))
  for (const id of incomingIds) pendingCreatedSessionIds.delete(id)

  const pending = current.filter((session) => (
    pendingCreatedSessionIds.has(session.id) && !incomingIds.has(session.id)
  ))
  return pending.length > 0 ? [...incoming, ...pending] : incoming
}

function shouldRetainRenderedSessions(indexStatus: LocalIndexStatus | null): boolean {
  return indexStatus?.mode === 'on' && indexStatus.state === 'building'
}

function sessionModifiedTime(session: SessionListItem): number {
  const timestamp = new Date(session.modifiedAt).getTime()
  return Number.isFinite(timestamp) ? timestamp : 0
}

function preserveLocalMetadata(
  current: SessionListItem | undefined,
  incoming: SessionListItem,
): SessionListItem {
  if (!current) return incoming
  // Protocol locks cannot be removed by a session-list snapshot taken before
  // the first accepted turn. The live event is mirrored into this metadata.
  if (current.sessionApiFormat && incoming.sessionApiFormat === undefined) {
    incoming = { ...incoming, sessionApiFormat: current.sessionApiFormat }
  }
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
