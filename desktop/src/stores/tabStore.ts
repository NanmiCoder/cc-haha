import { create } from 'zustand'
import { sessionsApi } from '../api/sessions'
import { ApiError } from '../api/client'
import { dropSession as dropVirtualHeightSession } from '../components/chat/virtualHeightCache'
import { useSessionRuntimeStore } from './sessionRuntimeStore'
import { teamMemberSessionId } from '../types/team'
import type { SessionListItem } from '../types/session'

const TAB_STORAGE_KEY = 'cc-haha-open-tabs'

export const SETTINGS_TAB_ID = '__settings__'
export const SCHEDULED_TAB_ID = '__scheduled__'
export const CONNECTORS_TAB_ID = '__connectors__'
export const MARKET_TAB_ID = '__market__'
/** Retired app-level terminal tabs. Kept only to recognise their ids. */
export const TERMINAL_TAB_PREFIX = '__terminal__'
export const WORKBENCH_TAB_PREFIX = '__workbench__'
export const SUBAGENT_TAB_PREFIX = '__subagent__'
export const TEAM_TAB_PREFIX = '__team__'
export const TEAM_MEMBER_TAB_PREFIX = 'team-member:'

export type TabType = 'session' | 'settings' | 'scheduled' | 'connectors' | 'market' | 'workbench' | 'subagent' | 'team' | 'team-member'
type PersistentSpecialTabType = 'settings' | 'scheduled' | 'connectors' | 'market'

/**
 * How many chats keep their socket, and so their CLI and MCP servers, while
 * not on screen: the one in view plus the three used before it. There is no
 * tab strip any more, so nobody closes chats by hand; without a bound every
 * chat ever opened would pin a CLI until the app quits (#1485). A chat that
 * drops out is released only once its work is done (`hiddenSessionRelease`)
 * and keeps its transcript and draft, so coming back costs a CLI start, not
 * the conversation.
 */
export const WARM_SESSION_LIMIT = 4

// Retired tab shapes that older builds persisted. `persistenceMigrations`
// rewrites them at startup; restoreTabs tolerates them as a second guard.
const LEGACY_TRACE_LIST_TAB_ID = '__traces__'
const LEGACY_TRACE_TAB_PREFIX = '__trace__'

export type Tab = {
  sessionId: string
  title: string
  type: TabType
  status: 'idle' | 'running' | 'error'
  workbenchSessionId?: string
  sourceSessionId?: string
  sourceTurnKey?: string
  sourceElementId?: string
  subagentToolUseId?: string
  subagentTaskId?: string
  teamLeadSessionId?: string
  teamMemberAgentId?: string
  teamIncarnationId?: string
  /**
   * Where Back leads. Subagent and member pages: the page or chat that opened
   * them. Settings, the market and scheduled tasks: whatever was on screen
   * when they opened — another root page, a chat, a run page, or
   * `HOME_RETURN_ID` for the new-session page, which has no tab of its own.
   */
  returnTabId?: string
}

/** `returnTabId` of a root page opened from the new-session page. */
export const HOME_RETURN_ID = ''

type PersistedTab = {
  sessionId: string
  title: string
  // Typed as string: old builds also persisted the retired 'trace'/'traces'.
  type?: string
  traceSessionId?: string
}

type TabPersistence = {
  openTabs: PersistedTab[]
  activeTabId: string | null
}

type TabStore = {
  tabs: Tab[]
  activeTabId: string | null

  openTab: (sessionId: string, title: string, type?: TabType) => void
  openSubagentTab: (
    sourceSessionId: string,
    toolUseId: string,
    title?: string,
    taskId?: string,
    returnTabId?: string,
  ) => string
  returnFromSubagent: (tabId: string) => void
  openTeamWorkbenchTab: (leadSessionId: string, title?: string) => string
  returnFromTeamWorkbench: (tabId: string) => void
  openTeamMemberTab: (
    leadSessionId: string,
    agentId: string,
    title?: string,
    returnTabId?: string,
    incarnationId?: string,
  ) => string
  returnFromTeamMember: (tabId: string) => void
  closeTab: (sessionId: string) => void
  setActiveTab: (sessionId: string) => void
  updateTabTitle: (sessionId: string, title: string) => void
  updateTabStatus: (sessionId: string, status: Tab['status']) => void
  replaceTabSession: (oldSessionId: string, newSessionId: string) => void

  saveTabs: () => void
  restoreTabs: () => Promise<void>
}

const PERSISTENT_SPECIAL_TAB_IDS: Record<PersistentSpecialTabType, string> = {
  settings: SETTINGS_TAB_ID,
  scheduled: SCHEDULED_TAB_ID,
  market: MARKET_TAB_ID,
  connectors: CONNECTORS_TAB_ID,
}

function getPersistentSpecialTabType(tab: { sessionId: string; type?: string }): PersistentSpecialTabType | null {
  if (tab.sessionId === SETTINGS_TAB_ID) return 'settings'
  if (tab.sessionId === SCHEDULED_TAB_ID) return 'scheduled'
  if (tab.sessionId === CONNECTORS_TAB_ID) return 'market'
  if (tab.sessionId === MARKET_TAB_ID) return 'market'
  if (tab.type === 'connectors' || tab.type === 'settings' || tab.type === 'scheduled' || tab.type === 'market') {
    return tab.type === 'connectors' ? 'market' : tab.type
  }
  return null
}

/**
 * Rewrites the retired Trace tabs: the list tab is dropped and a per-session
 * trace tab becomes that session's chat tab (where the 轨迹 view now lives).
 */
function normalizeLegacyPersistedTab(tab: PersistedTab): PersistedTab | null {
  if (tab.sessionId === LEGACY_TRACE_LIST_TAB_ID || tab.type === 'traces') return null
  if (tab.type === 'trace' || tab.sessionId.startsWith(LEGACY_TRACE_TAB_PREFIX)) {
    const sessionId = tab.traceSessionId || tab.sessionId.slice(LEGACY_TRACE_TAB_PREFIX.length)
    return sessionId && !sessionId.startsWith(LEGACY_TRACE_TAB_PREFIX)
      ? { sessionId, title: tab.title, type: 'session' }
      : null
  }
  return tab
}

function normalizeLegacyActiveTabId(activeTabId: string | null | undefined): string | null {
  if (!activeTabId || activeTabId === LEGACY_TRACE_LIST_TAB_ID) return null
  if (activeTabId.startsWith(LEGACY_TRACE_TAB_PREFIX)) {
    return activeTabId.slice(LEGACY_TRACE_TAB_PREFIX.length) || null
  }
  return activeTabId
}

function getPersistedSessionId(tab: PersistedTab): string | null {
  if (getPersistentSpecialTabType(tab)) return null
  if (
    tab.type === 'terminal' || tab.type === 'workbench' || tab.type === 'subagent' ||
    tab.type === 'team' || tab.type === 'team-member'
  ) return null
  return tab.sessionId
}

/** Settings, scheduled tasks and the extension market: one page at a time. */
export function isRootPageTab(tab: Pick<Tab, 'type'> | undefined): boolean {
  return tab?.type === 'settings' || tab?.type === 'scheduled' ||
    tab?.type === 'market' || tab?.type === 'connectors'
}

/**
 * The tab list is a navigation stack, most recent last, not a strip anyone
 * sees. Chats sit at the bottom (the warm set); pages sit on top of the chat
 * they were opened from. Showing a tab moves it to the top, and:
 * - showing a chat leaves every page behind it;
 * - showing Settings, the market or scheduled tasks drops every other root
 *   page except the one it was opened from, so Back from Settings opened out
 *   of the market lands on the market, but switching sections from the
 *   sidebar does not pile them up;
 * - subagent, team and member pages stack, so Back unwinds them in order.
 * The shown tab is always the last one.
 */
function navigateTo(tabs: Tab[], tabId: string): Tab[] {
  const target = tabs.find((tab) => tab.sessionId === tabId)
  if (!target) return tabs
  let next = tabs.filter((tab) => tab.sessionId !== tabId)
  if (target.type === 'session') next = next.filter((tab) => tab.type === 'session')
  else if (isRootPageTab(target)) {
    next = next.filter((tab) => !isRootPageTab(tab) || tab.sessionId === target.returnTabId)
  }
  next.push(target)
  return evictColdSessions(next)
}

/**
 * Drop the least recently shown chats past `WARM_SESSION_LIMIT`. The shown
 * tab and any chat a page on the stack belongs to are never dropped.
 */
function evictColdSessions(tabs: Tab[]): Tab[] {
  let excess = tabs.filter((tab) => tab.type === 'session').length - WARM_SESSION_LIMIT
  if (excess <= 0) return tabs
  const shown = tabs[tabs.length - 1]
  const referenced = new Set(tabs.flatMap((tab) => tab.type === 'session'
    ? []
    : [tab.sourceSessionId, tab.teamLeadSessionId, tab.workbenchSessionId]))
  return tabs.filter((tab) => {
    if (excess <= 0 || tab.type !== 'session' || tab === shown || referenced.has(tab.sessionId)) return true
    excess -= 1
    return false
  })
}

/**
 * Old builds saved every open tab in strip order. Keep what the stack can
 * hold: a root page only if it was the one showing, the saved active chat,
 * and the chats nearest the end of the list.
 */
function trimRestoredTabs(openTabs: PersistedTab[], activeTabId: string | null): PersistedTab[] {
  const activeRootType = activeTabId
    ? getPersistentSpecialTabType(openTabs.find((tab) => tab.sessionId === activeTabId) ?? { sessionId: activeTabId })
    : null
  const sessionIds = openTabs.flatMap((tab) => getPersistedSessionId(tab) ? [tab.sessionId] : [])
  const activeIsChat = activeTabId !== null && sessionIds.includes(activeTabId)
  const warm = new Set(sessionIds.filter((id) => id !== activeTabId).slice(-(activeIsChat ? WARM_SESSION_LIMIT - 1 : WARM_SESSION_LIMIT)))
  if (activeIsChat && activeTabId) warm.add(activeTabId)
  return openTabs.filter((tab) => {
    const rootType = getPersistentSpecialTabType(tab)
    if (rootType) return rootType === activeRootType
    return !getPersistedSessionId(tab) || warm.has(tab.sessionId)
  })
}

export const useTabStore = create<TabStore>((set, get) => ({
  tabs: [],
  activeTabId: null,

  openTab: (sessionId, title, type) => {
    if (sessionId === CONNECTORS_TAB_ID || type === 'connectors') { sessionId = MARKET_TAB_ID; type = 'market' }
    const { tabs, activeTabId } = get()
    const existing = tabs.find((t) => t.sessionId === sessionId)
    const nextType = type ?? existing?.type ?? 'session'
    // A root page remembers what it was opened over, unless it is already
    // the page on screen (a deep link into Settings while Settings is open).
    const returnTabId = isRootPageTab({ type: nextType }) && activeTabId !== sessionId
      ? activeTabId ?? HOME_RETURN_ID
      : existing?.returnTabId
    const opened: Tab = existing
      ? { ...existing, title, type: nextType, ...(returnTabId !== undefined ? { returnTabId } : {}) }
      : { sessionId, title, type: nextType, status: 'idle', ...(returnTabId !== undefined ? { returnTabId } : {}) }
    const nextTabs: Tab[] = existing
      ? tabs.map((tab) => tab.sessionId === sessionId ? opened : tab)
      : [...tabs, opened]
    set({ tabs: navigateTo(nextTabs, sessionId), activeTabId: sessionId })
    get().saveTabs()
  },

  openSubagentTab: (sourceSessionId, toolUseId, title = 'SubAgent', taskId, returnTabId) => {
    const tabId = `${SUBAGENT_TAB_PREFIX}${sourceSessionId}__${toolUseId}`
    const { tabs } = get()
    const existing = tabs.find((tab) => tab.sessionId === tabId)
    const tab: Tab = {
      sessionId: tabId,
      title,
      type: 'subagent',
      status: 'idle',
      sourceSessionId,
      subagentToolUseId: toolUseId,
      ...(taskId ? { subagentTaskId: taskId } : {}),
      ...(returnTabId ? { returnTabId } : {}),
    }

    set({
      tabs: navigateTo(existing
        ? tabs.map((current) => current.sessionId === tabId ? tab : current)
        : [...tabs, tab], tabId),
      activeTabId: tabId,
    })
    get().saveTabs()
    return tabId
  },

  returnFromSubagent: (tabId) => {
    const tab = get().tabs.find((current) => current.sessionId === tabId)
    if (tab?.type !== 'subagent') return

    const returnTabId = tab.returnTabId ?? tab.sourceSessionId
    if (returnTabId && get().tabs.some((current) => current.sessionId === returnTabId)) {
      get().setActiveTab(returnTabId)
    }
    get().closeTab(tabId)
  },

  openTeamWorkbenchTab: (leadSessionId, title = 'Agent Teams') => {
    const tabId = `${TEAM_TAB_PREFIX}${leadSessionId}`
    const { tabs } = get()
    const tab: Tab = {
      sessionId: tabId,
      title,
      type: 'team',
      status: 'idle',
      teamLeadSessionId: leadSessionId,
      sourceSessionId: leadSessionId,
    }

    set({
      tabs: navigateTo(tabs.some((current) => current.sessionId === tabId)
        ? tabs.map((current) => current.sessionId === tabId ? tab : current)
        : [...tabs, tab], tabId),
      activeTabId: tabId,
    })
    get().saveTabs()
    return tabId
  },

  returnFromTeamWorkbench: (tabId) => {
    const tab = get().tabs.find((current) => current.sessionId === tabId)
    if (tab?.type !== 'team') return

    if (tab.sourceSessionId && get().tabs.some((current) => current.sessionId === tab.sourceSessionId)) {
      get().setActiveTab(tab.sourceSessionId)
    }
    get().closeTab(tabId)
  },

  openTeamMemberTab: (leadSessionId, agentId, title = 'Agent', returnTabId, incarnationId) => {
    const tabId = teamMemberSessionId(agentId, incarnationId)
    const { tabs, activeTabId } = get()
    const resolvedReturnTabId = returnTabId ?? (
      activeTabId && tabs.some((tab) => tab.sessionId === activeTabId && tab.type === 'team')
        ? activeTabId
        : `${TEAM_TAB_PREFIX}${leadSessionId}`
    )
    const tab: Tab = {
      sessionId: tabId,
      title,
      type: 'team-member',
      status: 'idle',
      sourceSessionId: leadSessionId,
      teamLeadSessionId: leadSessionId,
      teamMemberAgentId: agentId,
      teamIncarnationId: incarnationId,
      returnTabId: resolvedReturnTabId,
    }

    set({
      tabs: navigateTo(tabs.some((current) => current.sessionId === tabId)
        ? tabs.map((current) => current.sessionId === tabId ? tab : current)
        : [...tabs, tab], tabId),
      activeTabId: tabId,
    })
    get().saveTabs()
    return tabId
  },

  returnFromTeamMember: (tabId) => {
    const tab = get().tabs.find((current) => current.sessionId === tabId)
    if (tab?.type !== 'team-member') return

    const returnTabId = tab.returnTabId
    if (returnTabId && get().tabs.some((current) => current.sessionId === returnTabId)) {
      get().setActiveTab(returnTabId)
    } else if (tab.teamLeadSessionId) {
      get().openTeamWorkbenchTab(tab.teamLeadSessionId)
    }
    get().closeTab(tabId)
  },

  closeTab: (sessionId) => {
    const { tabs, activeTabId } = get()
    const index = tabs.findIndex((t) => t.sessionId === sessionId)
    if (index < 0) return

    let newTabs = tabs.filter((t) => t.sessionId !== sessionId)
    let newActiveId = activeTabId

    // Closing the shown tab shows what it was opened over: a root page knows
    // (the new-session page included); anything else falls back to the tab
    // shown before it, which the stack keeps last.
    if (activeTabId === sessionId) {
      const closed = tabs[index]!
      const returnTo = isRootPageTab(closed) ? closed.returnTabId : undefined
      if (returnTo === HOME_RETURN_ID) {
        newActiveId = null
      } else if (returnTo && newTabs.some((tab) => tab.sessionId === returnTo)) {
        newActiveId = returnTo
        newTabs = navigateTo(newTabs, returnTo)
      } else {
        newActiveId = newTabs[newTabs.length - 1]?.sessionId ?? null
      }
    }

    set({ tabs: newTabs, activeTabId: newActiveId })
    get().saveTabs()
    dropVirtualHeightSession(sessionId)
  },

  setActiveTab: (sessionId) => {
    set((state) => ({ tabs: navigateTo(state.tabs, sessionId), activeTabId: sessionId }))
    get().saveTabs()
  },

  updateTabTitle: (sessionId, title) => {
    set((s) => ({
      tabs: s.tabs.map((t) => (t.sessionId === sessionId ? { ...t, title } : t)),
    }))
    get().saveTabs()
  },

  updateTabStatus: (sessionId, status) => {
    set((s) => ({
      tabs: s.tabs.map((t) => (t.sessionId === sessionId ? { ...t, status } : t)),
    }))
  },

  replaceTabSession: (oldSessionId, newSessionId) => {
    const { activeTabId } = get()
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.sessionId === oldSessionId ? { ...t, sessionId: newSessionId } : t,
      ),
      activeTabId: activeTabId === oldSessionId ? newSessionId : activeTabId,
    }))
    get().saveTabs()
  },

  saveTabs: () => {
    const { tabs, activeTabId } = get()
    const persistableTabs = tabs.filter((tab) => (
      tab.type !== 'workbench' &&
      tab.type !== 'subagent' &&
      tab.type !== 'team' &&
      tab.type !== 'team-member'
    ))
    const activeTab = tabs.find((tab) => tab.sessionId === activeTabId)
    // Detached views (subagent, team, member, workbench) restore to the
    // session they were spun out of rather than to a synthetic tab id. The
    // new-session page is saved as null, and anything else falls back to the
    // most recently shown chat, which the stack keeps last.
    const detachedOrigin = (
      activeTab?.type === 'workbench' ||
      activeTab?.type === 'subagent' ||
      activeTab?.type === 'team' ||
      activeTab?.type === 'team-member'
    )
      ? activeTab.sourceSessionId
      : undefined
    const persistedActiveTabId = activeTabId === null
      ? null
      : persistableTabs.some((tab) => tab.sessionId === activeTabId)
        ? activeTabId
        : detachedOrigin && persistableTabs.some((tab) => tab.sessionId === detachedOrigin)
          ? detachedOrigin
          : (persistableTabs[persistableTabs.length - 1]?.sessionId ?? null)
    const data: TabPersistence = {
      openTabs: persistableTabs.map((t) => ({
        sessionId: t.sessionId,
        title: t.title,
        type: t.type,
      })),
      activeTabId: persistedActiveTabId,
    }
    try {
      localStorage.setItem(TAB_STORAGE_KEY, JSON.stringify(data))
    } catch { /* noop */ }
  },

  restoreTabs: async () => {
    try {
      const restoreStartedWith = get()
      const runtimeSelections = useSessionRuntimeStore.getState().selections
      const restoreStillCurrent = () => {
        const current = get()
        return current.tabs === restoreStartedWith.tabs &&
          current.activeTabId === restoreStartedWith.activeTabId
      }
      const raw = localStorage.getItem(TAB_STORAGE_KEY)
      if (!raw) return

      const parsed = JSON.parse(raw) as TabPersistence
      const activeTabId = normalizeLegacyActiveTabId(parsed.activeTabId)
      const data: TabPersistence = {
        openTabs: trimRestoredTabs(Array.isArray(parsed.openTabs)
          ? parsed.openTabs.flatMap((tab) => {
              const normalized = normalizeLegacyPersistedTab(tab)
              return normalized ? [normalized] : []
            })
          : [], activeTabId),
        activeTabId,
      }
      if (data.openTabs.length === 0) {
        set({ tabs: [], activeTabId: null })
        localStorage.removeItem(TAB_STORAGE_KEY)
        return
      }

      const { sessions } = await sessionsApi.list({ limit: 200 })
      if (!restoreStillCurrent()) return
      const sessionsById = new Map(sessions.map((session) => [session.id, session]))
      const historicalSessions: SessionListItem[] = []
      const missingIds = new Set<string>()
      // The recent page cannot prove an old saved tab was deleted. Resolve
      // only missing saved ids, sequentially so large tab sets stay bounded.
      for (const tab of data.openTabs) {
        const sessionId = getPersistedSessionId(tab)
        if (!sessionId || sessionsById.has(sessionId) || missingIds.has(sessionId)) continue
        try {
          const session = await sessionsApi.getSummary(sessionId)
          if (!restoreStillCurrent()) return
          sessionsById.set(sessionId, session)
          historicalSessions.push(session)
        } catch (error) {
          if (!restoreStillCurrent()) return
          if (error instanceof ApiError && error.status === 404) {
            missingIds.add(sessionId)
          } else {
            // Keep persisted tabs intact on a timeout or unavailable server.
            throw error
          }
        }
      }

      // Avoid the sessionStore -> tabStore static import cycle. There must
      // be no await between reconciliation and activating the restored tabs.
      const { useSessionStore, reconcileSessionSnapshots } = await import('./sessionStore')
      if (!restoreStillCurrent()) return
      const recentSessions = reconcileSessionSnapshots(sessions, useSessionStore.getState().sessions)
      for (const session of recentSessions) sessionsById.set(session.id, session)
      if (historicalSessions.length > 0) {
        const hydrated = useSessionStore.getState().hydrateHistoricalSessions(historicalSessions, runtimeSelections)
        for (const session of hydrated) sessionsById.set(session.id, session)
      }
      useSessionRuntimeStore.getState().syncFromSessions(recentSessions, runtimeSelections)

      const validTabs: Tab[] = data.openTabs
        .filter((t) => {
          // Special tabs are always valid
          if (getPersistentSpecialTabType(t)) return true
          const sessionId = getPersistedSessionId(t)
          return sessionId !== null && sessionsById.has(sessionId)
        })
        .map((t) => {
          const specialType = getPersistentSpecialTabType(t)
          if (specialType) {
            return { sessionId: PERSISTENT_SPECIAL_TAB_IDS[specialType], title: t.title, type: specialType, status: 'idle' as const }
          }
          return {
            sessionId: t.sessionId,
            title: sessionsById.get(t.sessionId)?.title || t.title,
            type: 'session' as const,
            status: 'idle' as const,
          }
        })

      const uniqueTabs = validTabs.filter((tab, index) => validTabs.findIndex(other => other.sessionId === tab.sessionId) === index)
      if (uniqueTabs.length === 0) {
        set({ tabs: [], activeTabId: null })
        localStorage.removeItem(TAB_STORAGE_KEY)
        return
      }

      const legacyActive = data.openTabs.find(tab => tab.sessionId === data.activeTabId)
      const activeType = legacyActive && getPersistentSpecialTabType(legacyActive)
      const normalizedActive = activeType ? PERSISTENT_SPECIAL_TAB_IDS[activeType] : data.activeTabId
      // Saved at the new-session page: come back there, chats still warm.
      if (data.activeTabId === null) {
        set({ tabs: uniqueTabs, activeTabId: null })
        return
      }
      const activeId = normalizedActive && uniqueTabs.some(tab => tab.sessionId === normalizedActive) ? normalizedActive : uniqueTabs[uniqueTabs.length - 1]!.sessionId

      set({ tabs: navigateTo(uniqueTabs, activeId), activeTabId: activeId })
    } catch { /* noop */ }
  },
}))
