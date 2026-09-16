import { useCallback, useEffect, useMemo, useRef, useState, type HTMLAttributes } from 'react'
import { Sidebar } from './Sidebar'
import { ContentRouter } from './ContentRouter'
import { ToastContainer } from '@/components/layout/Toast'
import { UpdateChecker } from '@/components/layout/UpdateChecker'
import { StatusDot } from '@/components/ui/Badge'
import { IconButton } from '@/components/ui/IconButton'
import { useSettingsStore } from '../../stores/settingsStore'
import { useUIStore, type SettingsTab } from '../../stores/uiStore'
import { useKeyboardShortcuts } from '../../hooks/useKeyboardShortcuts'
import { useElectronWindowDragRegions } from '../../hooks/useElectronWindowDragRegions'
import { useSidebarResize } from '../../hooks/useSidebarResize'
import {
  H5ConnectionRequiredError,
  initializeDesktopServerUrl,
  isDesktopRuntime,
  isH5ConnectionRequiredError,
} from '../../lib/desktopRuntime'
import { getDesktopHost } from '../../lib/desktopHost'
import {
  desktopUiPreferencesApi,
  type DesktopUiPreferencesResponse,
} from '../../api/desktopUiPreferences'
import {
  captureProjectDisplayNameHydrationRevision,
  hydrateProjectDisplayNames,
} from '../../stores/projectDisplayNameStore'
import { openDesktopNotificationTarget } from '../../lib/desktopNotificationNavigation'
import { TabBar } from './TabBar'
import { WorkspaceHeaderProvider } from './WorkspaceHeaderContext'
import { StartupErrorView } from './StartupErrorView'
import { useTabStore, SETTINGS_TAB_ID } from '../../stores/tabStore'
import { useChatStore } from '../../stores/chatStore'
import { useSessionStore } from '../../stores/sessionStore'
import { useTranslation } from '../../i18n'
import { H5ConnectionView } from './H5ConnectionView'
import { useMobileViewport } from '../../hooks/useMobileViewport'
import type { Tab } from '../../stores/tabStore'
import { getTraceLaunchRequest } from '../../lib/traceLaunch'
import { openTraceDetail } from '../../lib/traceNavigation'
import { TraceList } from '../../pages/TraceList'
import { TraceSession } from '../../pages/TraceSession'

function isChatTab(tab: Tab | undefined) {
  return tab?.type === 'session'
}

export function AppShell() {
  const fetchSettings = useSettingsStore((s) => s.fetchAll)
  const sidebarOpen = useUIStore((s) => s.sidebarOpen)
  const toggleSidebar = useUIStore((s) => s.toggleSidebar)
  const setSidebarOpen = useUIStore((s) => s.setSidebarOpen)
  const [ready, setReady] = useState(false)
  const [startupError, setStartupError] = useState<string | null>(null)
  const [h5StartupError, setH5StartupError] = useState<H5ConnectionRequiredError | null>(null)
  const [bootstrapNonce, setBootstrapNonce] = useState(0)
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false)
  const [desktopUiPreferencesRequest, setDesktopUiPreferencesRequest] = useState<
    Promise<DesktopUiPreferencesResponse> | null
  >(null)
  const consumeDesktopUiPreferencesRequest = useCallback((request: Promise<DesktopUiPreferencesResponse>) => {
    setDesktopUiPreferencesRequest((current) => current === request ? null : current)
  }, [])
  const t = useTranslation()
  const traceLaunch = useMemo(() => getTraceLaunchRequest(), [])
  const desktopRuntime = isDesktopRuntime()
  const isMobileShell = useMobileViewport() && !desktopRuntime
  const tabs = useTabStore((s) => s.tabs)
  const activeTabId = useTabStore((s) => s.activeTabId)
  const setActiveTab = useTabStore((s) => s.setActiveTab)
  const sessions = useSessionStore((s) => s.sessions)
  const activeSession = activeTabId
    ? sessions.find((session) => session.id === activeTabId) ?? null
    : null
  const wasMobileShellRef = useRef(false)
  const sidebarWidth = useUIStore((s) => s.sidebarWidth)
  const effectiveSidebarOpen = isMobileShell ? mobileSidebarOpen : sidebarOpen
  const sidebarResize = useSidebarResize(!isMobileShell)
  const activeTab = tabs.find((tab) => tab.sessionId === activeTabId)
  const isActiveChatTab = isChatTab(activeTab)
  const mobileSessionTitle = activeSession?.title || activeTab?.title || t('session.untitled')
  const mobileSessionUpdated = (() => {
    if (!activeSession?.modifiedAt) return ''
    const diff = Date.now() - new Date(activeSession.modifiedAt).getTime()
    if (diff < 60000) return t('session.timeJustNow')
    if (diff < 3600000) return t('session.timeMinutes', { n: Math.floor(diff / 60000) })
    if (diff < 86400000) return t('session.timeHours', { n: Math.floor(diff / 3600000) })
    return t('session.timeDays', { n: Math.floor(diff / 86400000) })
  })()
  const sidebarHiddenProps: HTMLAttributes<HTMLDivElement> & { inert?: '' } =
    isMobileShell && !effectiveSidebarOpen
      ? { 'aria-hidden': true, inert: '' }
      : {}

  useEffect(() => {
    const sessionStore = useSessionStore.getState()
    if (activeSession) {
      if (sessionStore.activeSessionId !== activeSession.id) {
        sessionStore.setActiveSession(activeSession.id)
      }
      return
    }
    if (sessionStore.activeSessionId || activeTab?.type !== 'settings') return

    const openSessionIds = new Set(
      tabs.filter((tab) => tab.type === 'session').map((tab) => tab.sessionId),
    )
    // SessionStore keeps sessions most-recent-first; intersecting with restored
    // tabs excludes Settings and synthetic teammate tabs.
    const fallbackSession = sessions.find((session) => openSessionIds.has(session.id))
    if (fallbackSession) {
      sessionStore.setActiveSession(fallbackSession.id)
    }
  }, [activeSession, activeTab?.type, sessions, tabs])

  useEffect(() => {
    let cancelled = false

    const bootstrap = async () => {
      if (!cancelled) {
        setReady(false)
        setStartupError(null)
        setH5StartupError(null)
        setDesktopUiPreferencesRequest(null)
      }

      try {
        await initializeDesktopServerUrl()
        await fetchSettings()
        if (cancelled) return

        if (!traceLaunch.windowMode) {
          const displayNameHydrationRevision = captureProjectDisplayNameHydrationRevision()
          const preferencesRequest = desktopUiPreferencesApi.getPreferences()
          setDesktopUiPreferencesRequest(preferencesRequest)
          void preferencesRequest
            .then(({ preferences }) => {
              if (cancelled) return
              hydrateProjectDisplayNames(
                preferences.projectDisplayNames ?? {},
                displayNameHydrationRevision,
              )
              if (desktopRuntime && preferences.pet.enabled) {
                return getDesktopHost().pets.show()
              }
            })
            .catch(() => undefined)
        }

        setReady(true)

        void (async () => {
          if (traceLaunch.windowMode) return

          await useTabStore.getState().restoreTabs()
          if (cancelled) return
          if (traceLaunch.sessionId) {
            // A deep link arrives before the session list is in the store often
            // enough that the id prefix is the only title we can guarantee.
            const launchedSession = useSessionStore.getState().sessions
              .find((session) => session.id === traceLaunch.sessionId)
            openTraceDetail(
              traceLaunch.sessionId,
              launchedSession?.title || traceLaunch.sessionId.slice(0, 8),
            )
            return
          }
          const { activeTabId: activeId, tabs } = useTabStore.getState()
          const activeTab = tabs.find((tab) => tab.sessionId === activeId)
          if (activeId && activeTab?.type === 'session') {
            useChatStore.getState().connectToSession(activeId)
          }
        })().catch(() => {})
      } catch (error) {
        if (!cancelled) {
          if (!desktopRuntime && isH5ConnectionRequiredError(error)) {
            setH5StartupError(error)
            setStartupError(null)
          } else {
            setStartupError(error instanceof Error ? error.message : String(error))
            setH5StartupError(null)
          }
          setReady(false)
        }
      }
    }

    void bootstrap()

    return () => {
      cancelled = true
    }
  }, [bootstrapNonce, fetchSettings, desktopRuntime, traceLaunch])

  // Listen for macOS native menu navigation events (About / Settings)
  useEffect(() => {
    const host = getDesktopHost()
    if (!host.isDesktop) return
    let unlisten: (() => void) | undefined
    host.window.onNativeMenuNavigate((target) => {
      const destination = target as SettingsTab | 'settings'
      if (destination === 'about') {
        useUIStore.getState().setPendingSettingsTab('about')
      }
      useTabStore.getState().openTab(SETTINGS_TAB_ID, 'Settings', 'settings')
    })
      .then((fn) => { unlisten = fn })
      .catch(() => {})
    return () => { unlisten?.() }
  }, [])

  useEffect(() => {
    const host = getDesktopHost()
    if (!host.isDesktop || !host.pets) return
    let unlisten: (() => void) | undefined
    let disposed = false
    host.pets.onNavigateSession((sessionId) => {
      openDesktopNotificationTarget({ type: 'session', sessionId })
    })
      .then((fn) => {
        if (disposed) fn()
        else unlisten = fn
      })
      .catch(() => {})
    return () => {
      disposed = true
      unlisten?.()
    }
  }, [])

  useEffect(() => {
    if (!ready || !desktopRuntime || !isActiveChatTab || !activeTabId) return
    void desktopUiPreferencesApi.updatePetPreferences({ lastSessionId: activeTabId })
      .catch(() => undefined)
  }, [activeTabId, desktopRuntime, isActiveChatTab, ready])

  useKeyboardShortcuts()
  useElectronWindowDragRegions()

  useEffect(() => {
    if (isMobileShell && !wasMobileShellRef.current) {
      setMobileSidebarOpen(false)
      setSidebarOpen(false)
    }
    if (!isMobileShell && wasMobileShellRef.current) {
      setMobileSidebarOpen(false)
    }
    wasMobileShellRef.current = isMobileShell
  }, [isMobileShell, setSidebarOpen])

  useEffect(() => {
    if (!ready || !isMobileShell) return
    if (isChatTab(activeTab) || activeTab?.type === 'settings' || (!activeTab && !activeTabId)) return
    const nextChatTab = tabs.find(isChatTab)
    if (nextChatTab) {
      setActiveTab(nextChatTab.sessionId)
      return
    }
    useTabStore.setState({ activeTabId: null })
  }, [activeTab, activeTabId, isMobileShell, ready, setActiveTab, tabs])

  const setEffectiveSidebarOpen = (open: boolean) => {
    if (isMobileShell) {
      setMobileSidebarOpen(open)
      setSidebarOpen(open)
      return
    }
    setSidebarOpen(open)
  }

  const toggleEffectiveSidebar = () => {
    if (isMobileShell) {
      setEffectiveSidebarOpen(!mobileSidebarOpen)
      return
    }
    toggleSidebar()
  }

  if (!desktopRuntime && h5StartupError) {
    return (
      <H5ConnectionView
        initialServerUrl={h5StartupError.serverUrl}
        error={h5StartupError.message}
        onConnected={() => setBootstrapNonce((value) => value + 1)}
      />
    )
  }

  if (startupError) {
    return <StartupErrorView error={startupError} />
  }

  if (!ready) {
    return (
      <div className="app-shell-viewport flex items-center justify-center bg-[var(--color-surface)] text-[var(--color-text-secondary)]">
        {t('app.launching')}
      </div>
    )
  }

  if (traceLaunch.windowMode) {
    return (
      <div className="app-shell-viewport flex overflow-hidden bg-[var(--color-surface)] text-[var(--color-text-primary)]">
        {traceLaunch.sessionId ? (
          <TraceSession sessionId={traceLaunch.sessionId} standalone />
        ) : (
          <TraceList />
        )}
        <ToastContainer />
      </div>
    )
  }

  return (
    <div className={`app-shell app-shell-viewport flex overflow-hidden bg-[var(--color-surface)]${isMobileShell ? ' app-shell--mobile' : ''}`}>
      {isMobileShell && effectiveSidebarOpen ? (
        <button
          type="button"
          data-testid="sidebar-backdrop"
          className="app-shell-backdrop fixed inset-0 z-[var(--z-scrim)] border-0 p-0"
          aria-label={t('sidebar.collapse')}
          onClick={() => setEffectiveSidebarOpen(false)}
        />
      ) : null}
      <div
        id="sidebar-shell"
        ref={sidebarResize.shellRef}
        data-testid="sidebar-shell"
        data-state={effectiveSidebarOpen ? 'open' : 'closed'}
        data-mobile={isMobileShell ? 'true' : 'false'}
        className={`sidebar-shell${isMobileShell ? ' sidebar-shell--mobile' : ''}`}
        {...sidebarHiddenProps}
      >
        {!isMobileShell || effectiveSidebarOpen ? (
          <Sidebar
            isMobile={isMobileShell}
            onRequestClose={() => setEffectiveSidebarOpen(false)}
            desktopUiPreferencesRequest={desktopUiPreferencesRequest}
            onDesktopUiPreferencesConsumed={consumeDesktopUiPreferencesRequest}
          />
        ) : null}
        {!isMobileShell ? (
          <div
            data-testid="sidebar-resize-handle"
            role="separator"
            aria-orientation="vertical"
            aria-label={t('sidebar.resize')}
            aria-valuenow={effectiveSidebarOpen ? sidebarWidth : 0}
            tabIndex={0}
            className="sidebar-resize-handle"
            {...sidebarResize.handleProps}
          />
        ) : null}
      </div>
      <main
        id="content-area"
        data-sidebar-state={effectiveSidebarOpen ? 'open' : 'closed'}
        className={`min-w-0 flex-1 flex flex-col overflow-hidden${isMobileShell ? ' app-shell-main--mobile' : ''}`}
      >
        {isMobileShell ? (
          <div
            data-testid="mobile-session-header"
            className="flex shrink-0 items-center gap-3 border-b border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2"
          >
            <IconButton
              data-testid="mobile-sidebar-toggle"
              icon={effectiveSidebarOpen ? 'close' : 'menu'}
              label={effectiveSidebarOpen ? t('sidebar.collapse') : t('sidebar.expand')}
              onClick={toggleEffectiveSidebar}
              size="2xl"
              aria-controls="sidebar-shell"
              aria-expanded={effectiveSidebarOpen}
            />
            {activeTab?.type === 'settings' ? (
              <h1 className="min-w-0 flex-1 truncate text-[15px] font-bold leading-tight text-[var(--color-text-primary)]">{t('sidebar.settings')}</h1>
            ) : isActiveChatTab ? (
              <div className="min-w-0 flex-1">
                <h1 className="truncate text-[15px] font-bold leading-tight text-[var(--color-text-primary)]">
                  {mobileSessionTitle}
                </h1>
                <div className="mt-0.5 flex min-w-0 items-center gap-1.5 overflow-hidden whitespace-nowrap text-[10px] font-medium text-[var(--color-text-tertiary)]">
                  {activeTab?.status === 'running' ? (
                    <span className="flex shrink-0 items-center gap-1 text-[var(--color-text-secondary)]">
                      <StatusDot tone="success" pulse />
                      {t('session.active')}
                    </span>
                  ) : null}
                  {activeSession?.messageCount !== undefined && activeSession.messageCount > 0 ? (
                    <>
                      {activeTab?.status === 'running' ? <span aria-hidden="true">·</span> : null}
                      <span>{t('session.messages', { count: activeSession.messageCount })}</span>
                    </>
                  ) : null}
                  {mobileSessionUpdated ? (
                    <>
                      {(activeTab?.status === 'running') || ((activeSession?.messageCount ?? 0) > 0) ? <span aria-hidden="true">·</span> : null}
                      <span className="truncate">{t('session.lastUpdated', { time: mobileSessionUpdated })}</span>
                    </>
                  ) : null}
                </div>
              </div>
            ) : null}
          </div>
        ) : null}
        <WorkspaceHeaderProvider>
          {!isMobileShell ? <TabBar /> : null}
          <ContentRouter />
        </WorkspaceHeaderProvider>
      </main>
      <ToastContainer />
      <UpdateChecker />
    </div>
  )
}
