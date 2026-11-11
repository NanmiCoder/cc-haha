import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { PanelLeft, SquarePen } from 'lucide-react'
import { useTranslation } from '../../i18n'
import { StatusDot } from '@/components/ui/Badge'
import { IconButton } from '@/components/ui/IconButton'
import type { DesktopUiPreferencesResponse } from '../../api/desktopUiPreferences'
import { sessionNeedsAttention } from '../../lib/sessionAttention'
import { formatRelativeTime } from '../../lib/formatRelativeTime'
import { resolveProjectDisplayName } from '../../stores/projectDisplayNameStore'
import { useChatStore } from '../../stores/chatStore'
import { useSessionStore } from '../../stores/sessionStore'
import { useTabStore } from '../../stores/tabStore'
import { useUIStore } from '@/stores/uiStore'
import { ContentRouter } from '../layout/ContentRouter'
import { getSessionWorkspaceLabel } from '../layout/sidebarTaskGroups'
import { ToastContainer } from '../layout/Toast'
import { UpdateChecker } from '../layout/UpdateChecker'
import { WorkspaceHeaderProvider } from '../layout/WorkspaceHeaderContext'
import { MobileSessionBrowser } from './MobileSessionBrowser'
import { MobileSessionDrawer } from '@/components/mobile/MobileSessionDrawer'
import { MobileTopBar } from './MobileTopBar'
import { MobileActivityPill } from './MobileActivityPill'
import type { MobileShellLayout } from './mobileShellLayout'
import { resolveNewTaskWorkDir } from '@/components/mobile/mobileNewTask'
import {
  goMobileHome,
  isMobileRoutableTab,
  navigateMobileUp,
  resolveMobileRoute,
  useMobileHistoryGuard,
  type MobileRoute,
} from './mobileNavigation'

type Props = {
  layout: Exclude<MobileShellLayout, 'desktop'>
  preferencesRequest: Promise<DesktopUiPreferencesResponse> | null
}

function dismissMobileDialog(): boolean {
  const dialog = Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"][aria-modal="true"]'))
    .find(element => element.dataset.testid !== 'mobile-session-drawer-panel' && !element.closest('[inert], [hidden]'))
  if (!dialog) return false
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
  return true
}

/** Chat stays mounted beneath the phone's session drawer. New chat is a page. */
export function MobileShell({ layout, preferencesRequest }: Props) {
  const t = useTranslation()
  const tabs = useTabStore((state) => state.tabs)
  const activeTabId = useTabStore((state) => state.activeTabId)
  const route = resolveMobileRoute(tabs, activeTabId)
  const activeTab = tabs.find((tab) => tab.sessionId === activeTabId)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [draftReturnId, setDraftReturnId] = useState<string | null>(null)
  const previousPageRef = useRef<string | null>(activeTab?.type === 'session' ? activeTabId : null)
  const canReturnFromDraft = route.kind === 'home' && tabs.some(tab => tab.sessionId === draftReturnId)
  const closeDrawer = useCallback(() => setDrawerOpen(false), [])
  const openDrawer = useCallback(() => {
    // Opening navigation should dismiss the keyboard, without losing its draft.
    const active = document.activeElement
    if (active instanceof HTMLElement && active.matches('input, textarea, [contenteditable="true"]')) active.blur()
    setDrawerOpen(true)
  }, [])
  const goUp = useCallback(() => {
    if (dismissMobileDialog()) return
    if (drawerOpen) {
      setDrawerOpen(false)
      return
    }
    if (canReturnFromDraft) {
      useTabStore.getState().setActiveTab(draftReturnId!)
      setDraftReturnId(null)
    } else if (route.kind === 'detail') {
      navigateMobileUp()
    } else if (route.kind === 'settings') {
      const previous = previousPageRef.current
      if (previous && useTabStore.getState().tabs.some(tab => tab.sessionId === previous)) {
        useTabStore.getState().setActiveTab(previous)
      } else goMobileHome()
    }
  }, [canReturnFromDraft, draftReturnId, drawerOpen, route.kind])
  const pageDepth = canReturnFromDraft || route.kind === 'detail' || route.kind === 'settings' ? 1 : 0
  const backDepth = pageDepth + (drawerOpen ? 1 : 0)
  const hasBack = backDepth > 0
  const goBack = useMobileHistoryGuard(backDepth, true, goUp)

  // Android Back belongs to the current app page, never to computer pairing.
  // A picker gets first refusal, then the drawer/detail/draft navigation. False
  // means chat root: the native host can background the app, retaining WebView.
  useEffect(() => {
    const back = () => {
      if (dismissMobileDialog()) return true
      if (!hasBack) return false
      goUp()
      return true
    }
    window.__CC_HAHA_MOBILE_NAVIGATE_BACK__ = back
    return () => {
      if (window.__CC_HAHA_MOBILE_NAVIGATE_BACK__ === back) delete window.__CC_HAHA_MOBILE_NAVIGATE_BACK__
    }
  }, [goUp, hasBack])

  const startNewTask = useCallback((workDir: string) => {
    setDraftReturnId(useTabStore.getState().activeTabId)
    useUIStore.getState().startNewSessionDraft(workDir)
    goMobileHome()
    setDrawerOpen(false)
  }, [])

  useEffect(() => {
    if (route.kind === 'session' || route.kind === 'home') previousPageRef.current = activeTabId
    if (activeTabId) setDraftReturnId(null)
  }, [activeTabId, route.kind])

  useEffect(() => {
    if (activeTab && !isMobileRoutableTab(activeTab)) goMobileHome()
  }, [activeTab])

  const browser = (variant: 'pane' | 'drawer') => (
    <MobileSessionBrowser
      variant={variant}
      selectedSessionId={route.kind === 'session' ? route.tabId : null}
      preferencesRequest={preferencesRequest}
      onNewTask={startNewTask}
      onNavigate={closeDrawer}
      onClose={variant === 'drawer' ? goBack : undefined}
    />
  )

  return (
    <div data-testid="mobile-shell" data-layout={layout}
      className="app-shell app-shell-viewport app-shell--mobile relative flex overflow-hidden bg-[var(--color-surface)]">
      {layout === 'tablet' ? (
        <aside data-testid="mobile-tablet-pane" className="flex w-[340px] shrink-0 flex-col border-r border-[var(--color-border)]">
          {browser('pane')}
        </aside>
      ) : null}
      <main id="content-area" {...(drawerOpen && layout === 'phone' ? { inert: '' } : {})}
        className="app-shell-main--mobile flex min-w-0 flex-1 flex-col overflow-hidden">
        {route.kind === 'home' ? (
          <MobileTopBar
            title={t('mobile.newTask.title')}
            onBack={canReturnFromDraft ? goBack : undefined}
            onMenu={!canReturnFromDraft && layout === 'phone' ? openDrawer : undefined}
            trailing={canReturnFromDraft && layout === 'phone' ? (
              <IconButton size="2xl" tone="secondary" data-testid="mobile-open-sessions"
                icon={<PanelLeft size={22} strokeWidth={1.75} aria-hidden="true" />}
                label={t('mobile.home.title')} onClick={openDrawer} />
            ) : undefined}
          />
        ) : (
          <MobileRouteBar route={route}
            onBack={route.kind === 'session' ? undefined : goBack}
            onMenu={route.kind === 'session' && layout === 'phone' ? openDrawer : undefined}
            onNewTask={startNewTask} />
        )}
        <WorkspaceHeaderProvider><ContentRouter /></WorkspaceHeaderProvider>
      </main>
      {layout === 'phone' && drawerOpen ? (
        <MobileSessionDrawer onClose={goBack}>{browser('drawer')}</MobileSessionDrawer>
      ) : null}
      <ToastContainer />
      <UpdateChecker />
    </div>
  )
}

declare global {
  interface Window { __CC_HAHA_MOBILE_NAVIGATE_BACK__?: () => boolean }
}

function MobileRouteBar({ route, onBack, onMenu, onNewTask }: {
  route: Exclude<MobileRoute, { kind: 'home' }>
  onBack?: () => void
  onMenu?: () => void
  onNewTask: (workDir: string) => void
}) {
  const t = useTranslation()
  const tab = useTabStore((state) => state.tabs.find((candidate) => candidate.sessionId === route.tabId))

  if (route.kind === 'settings') {
    return <MobileTopBar title={t('sidebar.settings')} onBack={onBack} backLabel={t('mobile.nav.backToSessions')} />
  }
  if (route.kind === 'detail') {
    return <MobileTopBar title={tab?.title || t('session.untitled')} onBack={onBack} activeSessionId={route.parentSessionId} />
  }
  return <MobileSessionBar sessionId={route.tabId} fallbackTitle={tab?.title} onBack={onBack} onMenu={onMenu} onNewTask={onNewTask} />
}

function MobileSessionBar({
  sessionId,
  fallbackTitle,
  onBack,
  onMenu,
  onNewTask,
}: {
  sessionId: string
  fallbackTitle?: string
  onBack?: () => void
  onMenu?: () => void
  onNewTask: (workDir: string) => void
}) {
  const t = useTranslation()
  const session = useSessionStore((state) => state.sessions.find((candidate) => candidate.id === sessionId))
  const waiting = useChatStore((state) => sessionNeedsAttention(state.sessions[sessionId]))
  const running = useChatStore((state) => {
    const chat = state.sessions[sessionId]
    return Boolean(chat && chat.chatState !== 'idle')
  })

  let subtitle: ReactNode = null
  if (waiting) {
    subtitle = (
      <span className="flex items-center gap-1.5 font-medium text-[var(--color-on-warning-container)]">
        <StatusDot tone="warning" />
        {t('mobile.session.waiting')}
      </span>
    )
  } else if (running) {
    subtitle = (
      <span className="flex items-center gap-1.5 text-[var(--color-text-secondary)]">
        <StatusDot tone="info" pulse />
        {t('mobile.session.running')}
      </span>
    )
  } else if (session) {
    subtitle = (
      <span className="truncate">
        {[getSessionWorkspaceLabel(session, resolveProjectDisplayName), formatRelativeTime(session.modifiedAt, t)]
          .filter(Boolean)
          .join(' · ')}
      </span>
    )
  }

  return (
    <MobileTopBar
      title={session?.title || fallbackTitle || t('session.untitled')}
      subtitle={subtitle}
      onBack={onBack}
      onMenu={onMenu}
      backLabel={t('mobile.nav.backToSessions')}
      activeSessionId={sessionId}
      trailing={(
        <>
          <MobileActivityPill sessionId={sessionId} />
          <IconButton
            size="2xl"
            tone="secondary"
            icon={<SquarePen size={20} strokeWidth={1.75} aria-hidden="true" />}
            label={t('mobile.home.newTask')}
            onClick={() => onNewTask(resolveNewTaskWorkDir(session ? [session] : [], null))}
          />
        </>
      )}
    />
  )
}
