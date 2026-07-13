import { create } from 'zustand'
import { sessionsApi } from '../api/sessions'
import { dropSession as dropVirtualHeightSession } from '../components/chat/virtualHeightCache'
import { destroyTerminalRuntime } from '../lib/terminalRuntime'
import { useSessionRuntimeStore } from './sessionRuntimeStore'

const TAB_STORAGE_KEY = 'cc-haha-open-tabs'

export const SETTINGS_TAB_ID = '__settings__'
export const SCHEDULED_TAB_ID = '__scheduled__'
export const MARKET_TAB_ID = '__market__'
export const TRACE_LIST_TAB_ID = '__traces__'
export const TERMINAL_TAB_PREFIX = '__terminal__'
export const TRACE_TAB_PREFIX = '__trace__'
export const WORKBENCH_TAB_PREFIX = '__workbench__'
export const SUBAGENT_TAB_PREFIX = '__subagent__'

export type TabType = 'session' | 'settings' | 'scheduled' | 'market' | 'terminal' | 'trace' | 'traces' | 'workbench' | 'subagent'
type PersistentSpecialTabType = 'settings' | 'scheduled' | 'market' | 'traces'

export type Tab = {
  sessionId: string
  title: string
  type: TabType
  status: 'idle' | 'running' | 'error'
  terminalCwd?: string
  terminalRuntimeId?: string
  traceSessionId?: string
  workbenchSessionId?: string
  sourceSessionId?: string
  sourceTurnKey?: string
  sourceElementId?: string
  subagentToolUseId?: string
}

export type WorkbenchTabOrigin = {
  sourceSessionId?: string
  sourceTurnKey?: string
  sourceElementId?: string
}

type TabPersistence = {
  openTabs: Array<{ sessionId: string; title: string; type?: TabType; traceSessionId?: string }>
  activeTabId: string | null
}

type TabStore = {
  tabs: Tab[]
  activeTabId: string | null

  openTab: (sessionId: string, title: string, type?: TabType) => void
  openTracesTab: (title?: string) => string
  openTraceTab: (sessionId: string, title?: string) => string
  openTerminalTab: (cwd?: string, terminalRuntimeId?: string) => string
  openWorkbenchTab: (sessionId: string, title?: string, origin?: WorkbenchTabOrigin) => string
  returnFromWorkbench: (tabId: string) => void
  openSubagentTab: (sourceSessionId: string, toolUseId: string, title?: string) => string
  closeTab: (sessionId: string) => void
  setActiveTab: (sessionId: string) => void
  updateTabTitle: (sessionId: string, title: string) => void
  updateTabStatus: (sessionId: string, status: Tab['status']) => void
  replaceTabSession: (oldSessionId: string, newSessionId: string) => void
  moveTab: (fromIndex: number, toIndex: number) => void

  saveTabs: () => void
  restoreTabs: () => Promise<void>
}

const PERSISTENT_SPECIAL_TAB_IDS: Record<PersistentSpecialTabType, string> = {
  settings: SETTINGS_TAB_ID,
  scheduled: SCHEDULED_TAB_ID,
  market: MARKET_TAB_ID,
  traces: TRACE_LIST_TAB_ID,
}

function getPersistentSpecialTabType(tab: Pick<Tab, 'sessionId'> & { type?: TabType }): PersistentSpecialTabType | null {
  if (tab.sessionId === SETTINGS_TAB_ID) return 'settings'
  if (tab.sessionId === SCHEDULED_TAB_ID) return 'scheduled'
  if (tab.sessionId === MARKET_TAB_ID) return 'market'
  if (tab.sessionId === TRACE_LIST_TAB_ID) return 'traces'
  if (tab.type === 'settings' || tab.type === 'scheduled' || tab.type === 'market' || tab.type === 'traces') {
    return tab.type
  }
  return null
}

export const useTabStore = create<TabStore>((set, get) => ({
  tabs: [],
  activeTabId: null,

  openTab: (sessionId, title, type) => {
    const { tabs } = get()
    const existing = tabs.find((t) => t.sessionId === sessionId)
    if (existing) {
      set({
        tabs: tabs.map((tab) =>
          tab.sessionId === sessionId
            ? {
                ...tab,
                title,
                type: type ?? tab.type ?? 'session',
              }
            : tab,
        ),
        activeTabId: sessionId,
      })
    } else {
      set({
        tabs: [...tabs, { sessionId, title, type: type ?? 'session', status: 'idle' }],
        activeTabId: sessionId,
      })
    }
    get().saveTabs()
  },

  openTracesTab: (title = 'Traces') => {
    const { tabs } = get()
    const existing = tabs.find((tab) => tab.sessionId === TRACE_LIST_TAB_ID)
    if (existing) {
      set({
        tabs: tabs.map((tab) => (
          tab.sessionId === TRACE_LIST_TAB_ID
            ? { ...tab, title, type: 'traces' }
            : tab
        )),
        activeTabId: TRACE_LIST_TAB_ID,
      })
    } else {
      set({
        tabs: [...tabs, { sessionId: TRACE_LIST_TAB_ID, title, type: 'traces', status: 'idle' }],
        activeTabId: TRACE_LIST_TAB_ID,
      })
    }
    get().saveTabs()
    return TRACE_LIST_TAB_ID
  },

  openTraceTab: (sessionId, title = 'Trace') => {
    const traceTabId = `${TRACE_TAB_PREFIX}${sessionId}`
    const { tabs } = get()
    const existing = tabs.find((tab) => tab.sessionId === traceTabId)
    if (existing) {
      set({
        tabs: tabs.map((tab) => (
          tab.sessionId === traceTabId
            ? { ...tab, title, type: 'trace', traceSessionId: sessionId }
            : tab
        )),
        activeTabId: traceTabId,
      })
    } else {
      set({
        tabs: [...tabs, { sessionId: traceTabId, title, type: 'trace', status: 'idle', traceSessionId: sessionId }],
        activeTabId: traceTabId,
      })
    }
    get().saveTabs()
    return traceTabId
  },

  openTerminalTab: (cwd, terminalRuntimeId) => {
    const { tabs } = get()
    const nextIndex = Math.max(
      0,
      ...tabs
        .filter((tab) => tab.type === 'terminal')
        .map((tab) => {
          const match = /^Terminal (\d+)$/.exec(tab.title)
          return match ? Number(match[1]) : 0
        }),
    ) + 1
    const sessionId = `${TERMINAL_TAB_PREFIX}${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    set({
      tabs: [...tabs, { sessionId, title: `Terminal ${nextIndex}`, type: 'terminal', status: 'idle', terminalCwd: cwd, terminalRuntimeId }],
      activeTabId: sessionId,
    })
    get().saveTabs()
    return sessionId
  },

  openWorkbenchTab: (sessionId, title = 'Workbench', origin) => {
    const tabId = `${WORKBENCH_TAB_PREFIX}${sessionId}`
    const { tabs } = get()
    const existing = tabs.find((tab) => tab.sessionId === tabId)
    const tab: Tab = {
      sessionId: tabId,
      title,
      type: 'workbench',
      status: 'idle',
      workbenchSessionId: sessionId,
      sourceSessionId: origin?.sourceSessionId ?? sessionId,
      ...(origin?.sourceTurnKey ? { sourceTurnKey: origin.sourceTurnKey } : {}),
      ...(origin?.sourceElementId ? { sourceElementId: origin.sourceElementId } : {}),
    }

    if (existing) {
      set({
        tabs: tabs.map((current) => current.sessionId === tabId ? tab : current),
        activeTabId: tabId,
      })
    } else {
      set({
        tabs: [...tabs, tab],
        activeTabId: tabId,
      })
    }
    get().saveTabs()
    return tabId
  },

  returnFromWorkbench: (tabId) => {
    const tab = get().tabs.find((current) => current.sessionId === tabId)
    if (tab?.type !== 'workbench') return

    if (tab.sourceSessionId && get().tabs.some((current) => current.sessionId === tab.sourceSessionId)) {
      get().setActiveTab(tab.sourceSessionId)
    }
    get().closeTab(tabId)
  },

  openSubagentTab: (sourceSessionId, toolUseId, title = 'SubAgent') => {
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
    }

    set({
      tabs: existing
        ? tabs.map((current) => current.sessionId === tabId ? tab : current)
        : [...tabs, tab],
      activeTabId: tabId,
    })
    get().saveTabs()
    return tabId
  },

  closeTab: (sessionId) => {
    const { tabs, activeTabId } = get()
    const index = tabs.findIndex((t) => t.sessionId === sessionId)
    if (index < 0) return

    const newTabs = tabs.filter((t) => t.sessionId !== sessionId)
    let newActiveId = activeTabId

    if (activeTabId === sessionId) {
      if (newTabs.length === 0) {
        newActiveId = null
      } else if (index >= newTabs.length) {
        newActiveId = newTabs[newTabs.length - 1]!.sessionId
      } else {
        newActiveId = newTabs[index]!.sessionId
      }
    }

    set({ tabs: newTabs, activeTabId: newActiveId })
    get().saveTabs()
    const closedTab = tabs[index]
    if (closedTab?.type === 'terminal') {
      destroyTerminalRuntime(closedTab.terminalRuntimeId ?? closedTab.sessionId)
    }
    dropVirtualHeightSession(sessionId)
  },

  setActiveTab: (sessionId) => {
    set({ activeTabId: sessionId })
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

  moveTab: (fromIndex, toIndex) => {
    if (fromIndex === toIndex) return
    const { tabs } = get()
    if (fromIndex < 0 || fromIndex >= tabs.length || toIndex < 0 || toIndex >= tabs.length) return
    const newTabs = [...tabs]
    const [moved] = newTabs.splice(fromIndex, 1)
    newTabs.splice(toIndex, 0, moved!)
    set({ tabs: newTabs })
    get().saveTabs()
  },

  saveTabs: () => {
    const { tabs, activeTabId } = get()
    const persistableTabs = tabs.filter((tab) => tab.type !== 'terminal' && tab.type !== 'workbench' && tab.type !== 'subagent')
    const activeTab = tabs.find((tab) => tab.sessionId === activeTabId)
    const persistedActiveTabId = activeTabId && persistableTabs.some((tab) => tab.sessionId === activeTabId)
      ? activeTabId
      : activeTab?.type === 'workbench' && activeTab.sourceSessionId && persistableTabs.some((tab) => tab.sessionId === activeTab.sourceSessionId)
        ? activeTab.sourceSessionId
        : (persistableTabs[0]?.sessionId ?? null)
    const data: TabPersistence = {
      openTabs: persistableTabs.map((t) => ({
        sessionId: t.sessionId,
        title: t.title,
        type: t.type,
        ...(t.traceSessionId ? { traceSessionId: t.traceSessionId } : {}),
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
      const raw = localStorage.getItem(TAB_STORAGE_KEY)
      if (!raw) return

      const data = JSON.parse(raw) as TabPersistence
      if (!data.openTabs || data.openTabs.length === 0) {
        set({ tabs: [], activeTabId: null })
        localStorage.removeItem(TAB_STORAGE_KEY)
        return
      }

      const { sessions } = await sessionsApi.list({ limit: 200 })
      const current = get()
      if (
        current.tabs !== restoreStartedWith.tabs ||
        current.activeTabId !== restoreStartedWith.activeTabId
      ) {
        return
      }
      useSessionRuntimeStore.getState().syncFromSessions(sessions)
      const existingIds = new Set(sessions.map((s) => s.id))

      const validTabs: Tab[] = data.openTabs
        .filter((t) => {
          // Special tabs are always valid
          if (getPersistentSpecialTabType(t)) return true
          if (t.type === 'trace') return !!t.traceSessionId && existingIds.has(t.traceSessionId)
          if (t.type === 'terminal') return false
          // Session tabs must exist on server
          return existingIds.has(t.sessionId)
        })
        .map((t) => {
          const specialType = getPersistentSpecialTabType(t)
          if (specialType) {
            return { sessionId: PERSISTENT_SPECIAL_TAB_IDS[specialType], title: t.title, type: specialType, status: 'idle' as const }
          }
          if (t.type === 'trace' && t.traceSessionId) {
            const sourceTitle = sessions.find((s) => s.id === t.traceSessionId)?.title || t.title
            return {
              sessionId: `${TRACE_TAB_PREFIX}${t.traceSessionId}`,
              title: sourceTitle === t.title ? t.title : `Trace: ${sourceTitle}`,
              type: 'trace' as const,
              status: 'idle' as const,
              traceSessionId: t.traceSessionId,
            }
          }
          return {
            sessionId: t.sessionId,
            title: sessions.find((s) => s.id === t.sessionId)?.title || t.title,
            type: 'session' as const,
            status: 'idle' as const,
          }
        })

      if (validTabs.length === 0) {
        set({ tabs: [], activeTabId: null })
        localStorage.removeItem(TAB_STORAGE_KEY)
        return
      }

      const activeId = data.activeTabId && validTabs.some((t) => t.sessionId === data.activeTabId)
        ? data.activeTabId
        : validTabs[0]!.sessionId

      set({ tabs: validTabs, activeTabId: activeId })
    } catch { /* noop */ }
  },
}))
