import { useEffect, useRef } from 'react'
import { useTabStore, type Tab } from '../../stores/tabStore'
import { useSessionStore } from '../../stores/sessionStore'
import { useChatStore } from '../../stores/chatStore'

/**
 * Where the phone shell is. Home is the session list; a session, Settings and
 * the detail pages (a subagent run, a team member) stack on top of it. Every
 * other tab type is a desktop surface with no phone layout and is sent home.
 */
export type MobileRoute =
  | { kind: 'home' }
  | { kind: 'session'; tabId: string }
  | { kind: 'settings'; tabId: string }
  | { kind: 'detail'; tabId: string; parentSessionId: string | null }

const HOME: MobileRoute = { kind: 'home' }

export function resolveMobileRoute(tabs: readonly Tab[], activeTabId: string | null): MobileRoute {
  if (!activeTabId) return HOME
  const tab = tabs.find((candidate) => candidate.sessionId === activeTabId)
  if (!tab) return HOME
  switch (tab.type) {
    case 'session':
      return { kind: 'session', tabId: tab.sessionId }
    case 'settings':
      return { kind: 'settings', tabId: tab.sessionId }
    case 'subagent':
      return { kind: 'detail', tabId: tab.sessionId, parentSessionId: tab.sourceSessionId ?? null }
    case 'team-member':
      return { kind: 'detail', tabId: tab.sessionId, parentSessionId: tab.teamLeadSessionId ?? null }
    default:
      return HOME
  }
}

/** How many pages sit above home; the browser history mirrors this. */
export function mobileRouteDepth(route: MobileRoute): number {
  if (route.kind === 'home') return 0
  if (route.kind === 'detail') return 2
  return 1
}

/** Whether a tab can be shown by the phone shell at all. */
export function isMobileRoutableTab(tab: Tab | undefined): boolean {
  return tab ? resolveMobileRoute([tab], tab.sessionId).kind !== 'home' : false
}

export function goMobileHome(): void {
  useTabStore.setState({ activeTabId: null })
  useTabStore.getState().saveTabs()
}

export function openMobileSession(sessionId: string): void {
  const tabs = useTabStore.getState().tabs
  if (tabs.some((tab) => tab.sessionId === sessionId && tab.type === 'session')) {
    useTabStore.getState().setActiveTab(sessionId)
  } else {
    const session = useSessionStore.getState().sessions.find((candidate) => candidate.id === sessionId)
    if (session) {
      useSessionStore.getState().openHistoricalSession(session)
    } else {
      useTabStore.getState().openTab(sessionId, '')
    }
  }
  useChatStore.getState().connectToSession(sessionId)
}

/**
 * One level up. A detail page is closed rather than kept: on a phone it is a
 * look at something inside its session, not a tab of its own to come back to,
 * and leaving it open would bring it back the next time the session is shown.
 */
export function navigateMobileUp(): void {
  const { tabs, activeTabId } = useTabStore.getState()
  const route = resolveMobileRoute(tabs, activeTabId)
  if (route.kind === 'home') return
  if (route.kind === 'detail') {
    useTabStore.getState().closeTab(route.tabId)
    if (route.parentSessionId) {
      openMobileSession(route.parentSessionId)
      return
    }
  }
  goMobileHome()
}

type HistoryGuardState = { ccHahaMobileGuard: true }

function isGuardState(state: unknown): state is HistoryGuardState {
  return typeof state === 'object' && state !== null && (state as HistoryGuardState).ccHahaMobileGuard === true
}

/**
 * Lets the system back gesture (iOS edge swipe, Android back, WeChat's back
 * button) go up one page instead of leaving the app.
 *
 * While any page sits above home, one extra history entry is kept on top of
 * the stack. Going back pops it; the popstate handler then moves the shell up
 * a level and, if that level is still above home, pushes the entry again. An
 * in-app back button calls `history.back()` through the returned function so
 * the two paths stay one path. When the shell reaches home some other way (a
 * deleted session, a redirect), the spare entry is consumed quietly so the
 * next back leaves the app as expected instead of doing nothing.
 *
 * `goUp` is what one level up means; the shell passes its own when something
 * other than a route (the new-task sheet) is the top level.
 */
export function useMobileHistoryGuard(
  depth: number,
  enabled: boolean,
  goUp: () => void = navigateMobileUp,
): () => void {
  const guardedRef = useRef(false)
  const ignoreNextPopRef = useRef(false)
  const goUpRef = useRef(goUp)
  goUpRef.current = goUp

  useEffect(() => {
    if (!enabled) return
    if (depth > 0 && !guardedRef.current) {
      window.history.pushState({ ccHahaMobileGuard: true } satisfies HistoryGuardState, '')
      guardedRef.current = true
    } else if (depth === 0 && guardedRef.current) {
      guardedRef.current = false
      if (isGuardState(window.history.state)) {
        ignoreNextPopRef.current = true
        window.history.back()
      }
    }
  }, [depth, enabled])

  useEffect(() => {
    if (!enabled) return
    const handlePopState = () => {
      if (ignoreNextPopRef.current) {
        ignoreNextPopRef.current = false
        return
      }
      if (!guardedRef.current) return
      guardedRef.current = false
      goUpRef.current()
    }
    window.addEventListener('popstate', handlePopState)
    return () => window.removeEventListener('popstate', handlePopState)
  }, [enabled])

  return () => {
    if (enabled && guardedRef.current && isGuardState(window.history.state)) {
      window.history.back()
      return
    }
    goUpRef.current()
  }
}
