import { useCallback, useEffect, useState } from 'react'
import { Sidebar } from './Sidebar'
import { ContentRouter } from './ContentRouter'
import { ToastContainer } from '@/components/layout/Toast'
import { UpdateChecker } from '@/components/layout/UpdateChecker'
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
import { MobileShell } from '../mobile/MobileShell'
import { useMobileShellLayout } from '../mobile/mobileShellLayout'
import type { Tab } from '../../stores/tabStore'

function isChatTab(tab: Tab | undefined) {
  return tab?.type === 'session'
}

export function AppShell() {
  const fetchSettings = useSettingsStore((s) => s.fetchAll)
  const sidebarOpen = useUIStore((s) => s.sidebarOpen)
  const [ready, setReady] = useState(false)
  const [startupError, setStartupError] = useState<string | null>(null)
  const [h5StartupError, setH5StartupError] = useState<H5ConnectionRequiredError | null>(null)
  const [bootstrapNonce, setBootstrapNonce] = useState(0)
  const [desktopUiPreferencesRequest, setDesktopUiPreferencesRequest] = useState<
    Promise<DesktopUiPreferencesResponse> | null
  >(null)
  const consumeDesktopUiPreferencesRequest = useCallback((request: Promise<DesktopUiPreferencesResponse>) => {
    setDesktopUiPreferencesRequest((current) => current === request ? null : current)
  }, [])
  const t = useTranslation()
  const desktopRuntime = isDesktopRuntime()
  const shellLayout = useMobileShellLayout(desktopRuntime)
  const tabs = useTabStore((s) => s.tabs)
  const activeTabId = useTabStore((s) => s.activeTabId)
  const sessions = useSessionStore((s) => s.sessions)
  const activeSession = activeTabId
    ? sessions.find((session) => session.id === activeTabId) ?? null
    : null
  const sidebarWidth = useUIStore((s) => s.sidebarWidth)
  const sidebarResize = useSidebarResize(shellLayout === 'desktop')
  const activeTab = tabs.find((tab) => tab.sessionId === activeTabId)
  const isActiveChatTab = isChatTab(activeTab)

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

        setReady(true)

        void (async () => {
          await useTabStore.getState().restoreTabs()
          if (cancelled) return
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
  }, [bootstrapNonce, fetchSettings, desktopRuntime])

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
      <div className="app-shell-viewport flex items-center justify-center bg-[var(--color-surface)] text-[13px] text-[var(--color-text-tertiary)]">
        {t('app.launching')}
      </div>
    )
  }

  if (shellLayout !== 'desktop') {
    return <MobileShell layout={shellLayout} preferencesRequest={desktopUiPreferencesRequest} />
  }

  return (
    <div className="app-shell app-shell-viewport flex overflow-hidden bg-[var(--color-surface)]">
      <div
        id="sidebar-shell"
        ref={sidebarResize.shellRef}
        data-testid="sidebar-shell"
        data-state={sidebarOpen ? 'open' : 'closed'}
        data-mobile="false"
        className="sidebar-shell"
      >
        <Sidebar
          desktopUiPreferencesRequest={desktopUiPreferencesRequest}
          onDesktopUiPreferencesConsumed={consumeDesktopUiPreferencesRequest}
        />
        <div
          data-testid="sidebar-resize-handle"
          role="separator"
          aria-orientation="vertical"
          aria-label={t('sidebar.resize')}
          aria-valuenow={sidebarOpen ? sidebarWidth : 0}
          tabIndex={0}
          className="sidebar-resize-handle"
          {...sidebarResize.handleProps}
        />
      </div>
      <main
        id="content-area"
        data-sidebar-state={sidebarOpen ? 'open' : 'closed'}
        className="min-w-0 flex-1 flex flex-col overflow-hidden"
      >
        <WorkspaceHeaderProvider>
          <TabBar />
          <ContentRouter />
        </WorkspaceHeaderProvider>
      </main>
      <ToastContainer />
      <UpdateChecker />
    </div>
  )
}
