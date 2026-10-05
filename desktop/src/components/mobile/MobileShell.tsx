import { useEffect, type ReactNode } from 'react'
import { useTranslation } from '../../i18n'
import { StatusDot } from '@/components/ui/Badge'
import type { DesktopUiPreferencesResponse } from '../../api/desktopUiPreferences'
import { sessionNeedsAttention } from '../../lib/sessionAttention'
import { formatRelativeTime } from '../../lib/formatRelativeTime'
import { resolveProjectDisplayName } from '../../stores/projectDisplayNameStore'
import { useChatStore } from '../../stores/chatStore'
import { useSessionStore } from '../../stores/sessionStore'
import { useTabStore } from '../../stores/tabStore'
import { EmptySession } from '../../pages/EmptySession'
import { ContentRouter } from '../layout/ContentRouter'
import { getSessionWorkspaceLabel } from '../layout/sidebarTaskGroups'
import { ToastContainer } from '../layout/Toast'
import { UpdateChecker } from '../layout/UpdateChecker'
import { WorkspaceHeaderProvider } from '../layout/WorkspaceHeaderContext'
import { MobileSessionBrowser } from './MobileSessionBrowser'
import { MobileTopBar } from './MobileTopBar'
import { MobileActivityPill } from './MobileActivityPill'
import type { MobileShellLayout } from './mobileShellLayout'
import {
  goMobileHome,
  isMobileRoutableTab,
  mobileRouteDepth,
  resolveMobileRoute,
  useMobileHistoryGuard,
  type MobileRoute,
} from './mobileNavigation'

type Props = {
  layout: Exclude<MobileShellLayout, 'desktop'>
  preferencesRequest: Promise<DesktopUiPreferencesResponse> | null
}

/**
 * The phone and tablet app frame.
 *
 * Phone: one page at a time. Home is the session list with the new-task
 * composer under it; a session, Settings or a detail page replaces it, with a
 * Back that the system back gesture also drives.
 *
 * Tablet: the same session list stays on the left and the page sits beside it.
 */
export function MobileShell({ layout, preferencesRequest }: Props) {
  const tabs = useTabStore((state) => state.tabs)
  const activeTabId = useTabStore((state) => state.activeTabId)
  const route = resolveMobileRoute(tabs, activeTabId)
  const activeTab = tabs.find((tab) => tab.sessionId === activeTabId)
  const goBack = useMobileHistoryGuard(mobileRouteDepth(route), true)

  // A desktop-only tab (terminal, scheduled tasks, the team canvas…) restored
  // from storage or opened by a link has no page here: show home instead of a
  // blank frame. The tab itself is kept for when the desktop opens it.
  useEffect(() => {
    if (activeTab && !isMobileRoutableTab(activeTab)) goMobileHome()
  }, [activeTab])

  const showBack = route.kind !== 'home' && (layout === 'phone' || route.kind !== 'session')

  return (
    <div
      data-testid="mobile-shell"
      data-layout={layout}
      className="app-shell app-shell-viewport app-shell--mobile flex overflow-hidden bg-[var(--color-surface)]"
    >
      {layout === 'tablet' ? (
        <aside
          data-testid="mobile-tablet-pane"
          className="flex w-[340px] shrink-0 flex-col border-r border-[var(--color-border)]"
        >
          <MobileSessionBrowser
            variant="pane"
            selectedSessionId={route.kind === 'session' ? route.tabId : null}
            preferencesRequest={preferencesRequest}
          />
        </aside>
      ) : null}
      <main
        id="content-area"
        className="app-shell-main--mobile flex min-w-0 flex-1 flex-col overflow-hidden"
      >
        {route.kind !== 'home' ? (
          <MobileRouteBar route={route} onBack={showBack ? goBack : undefined} />
        ) : null}
        <WorkspaceHeaderProvider>
          <ContentRouter
            homePage={layout === 'phone'
              ? <EmptySession mobileHome={<MobileSessionBrowser variant="home" preferencesRequest={preferencesRequest} />} />
              : undefined}
          />
        </WorkspaceHeaderProvider>
      </main>
      <ToastContainer />
      <UpdateChecker />
    </div>
  )
}

function MobileRouteBar({ route, onBack }: { route: Exclude<MobileRoute, { kind: 'home' }>; onBack?: () => void }) {
  const t = useTranslation()
  const tab = useTabStore((state) => state.tabs.find((candidate) => candidate.sessionId === route.tabId))

  if (route.kind === 'settings') {
    return <MobileTopBar title={t('sidebar.settings')} onBack={onBack} backLabel={t('mobile.nav.backToSessions')} />
  }
  if (route.kind === 'detail') {
    return <MobileTopBar title={tab?.title || t('session.untitled')} onBack={onBack} activeSessionId={route.parentSessionId} />
  }
  return <MobileSessionBar sessionId={route.tabId} fallbackTitle={tab?.title} onBack={onBack} />
}

function MobileSessionBar({
  sessionId,
  fallbackTitle,
  onBack,
}: {
  sessionId: string
  fallbackTitle?: string
  onBack?: () => void
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
      backLabel={t('mobile.nav.backToSessions')}
      activeSessionId={sessionId}
      trailing={<MobileActivityPill sessionId={sessionId} />}
    />
  )
}
