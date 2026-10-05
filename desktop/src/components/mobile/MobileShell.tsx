import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
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
import { MobileNewTaskSheet } from './MobileNewTaskSheet'
import { MobileTopBar } from './MobileTopBar'
import { MobileActivityPill } from './MobileActivityPill'
import type { MobileShellLayout } from './mobileShellLayout'
import {
  goMobileHome,
  isMobileRoutableTab,
  mobileRouteDepth,
  navigateMobileUp,
  resolveMobileRoute,
  useMobileHistoryGuard,
  type MobileRoute,
} from './mobileNavigation'

type Props = {
  layout: Exclude<MobileShellLayout, 'desktop'>
  preferencesRequest: Promise<DesktopUiPreferencesResponse> | null
}

/** A new task asked for from the list, and the folder it starts in. */
type NewTaskRequest = { workDir: string; id: number }

/**
 * The phone and tablet app frame.
 *
 * Phone: one page at a time. Home is the session list; a session, Settings or
 * a detail page replaces it, with a Back that the system back gesture also
 * drives. A new task rises over the list as a sheet, one level above it.
 *
 * Tablet: the same session list stays on the left and the page sits beside
 * it; a new task is the new-session page on the right.
 */
export function MobileShell({ layout, preferencesRequest }: Props) {
  const tabs = useTabStore((state) => state.tabs)
  const activeTabId = useTabStore((state) => state.activeTabId)
  const route = resolveMobileRoute(tabs, activeTabId)
  const activeTab = tabs.find((tab) => tab.sessionId === activeTabId)
  const [newTask, setNewTask] = useState<NewTaskRequest | null>(null)
  const sheetOpen = layout === 'phone' && newTask !== null
  const goUp = useCallback(() => {
    if (sheetOpen) setNewTask(null)
    else navigateMobileUp()
  }, [sheetOpen])
  const goBack = useMobileHistoryGuard(mobileRouteDepth(route) + (sheetOpen ? 1 : 0), true, goUp)

  const nextNewTaskId = useRef(0)
  const startNewTask = useCallback((workDir: string) => {
    nextNewTaskId.current += 1
    setNewTask({ workDir, id: nextNewTaskId.current })
    // On a tablet the new-session page is what the right side shows at home.
    if (layout === 'tablet') goMobileHome()
  }, [layout])

  // Sending opens the new session (a slash command may open Settings): the
  // page changing is what takes the sheet away.
  const sheetTabIdRef = useRef(activeTabId)
  useEffect(() => {
    if (sheetTabIdRef.current !== activeTabId && layout === 'phone') setNewTask(null)
    sheetTabIdRef.current = activeTabId
  }, [activeTabId, layout])

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
            onNewTask={startNewTask}
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
              ? <MobileSessionBrowser variant="home" preferencesRequest={preferencesRequest} onNewTask={startNewTask} />
              // Keyed so each New task starts clean, in the folder it asked for.
              : <EmptySession key={newTask?.id ?? 0} initialWorkDir={newTask?.workDir} />}
          />
        </WorkspaceHeaderProvider>
      </main>
      {sheetOpen ? <MobileNewTaskSheet key={newTask.id} workDir={newTask.workDir} onCancel={goBack} /> : null}
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
