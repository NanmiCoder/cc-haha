import { ApiError } from '../api/client'
import { sessionsApi } from '../api/sessions'
import { hasRunningBackgroundTasks, listRunningBackgroundTasks } from '../lib/backgroundTasks'
import { isPlaceholderSessionTitle } from '../lib/sessionTitle'
import { releaseWorkspaceSession } from '../lib/workspace/releaseSession'
import { useChatStore } from './chatStore'
import { useSessionStore } from './sessionStore'
import {
  CONNECTORS_TAB_ID,
  MARKET_TAB_ID,
  SCHEDULED_TAB_ID,
  SETTINGS_TAB_ID,
  SUBAGENT_TAB_PREFIX,
  TEAM_MEMBER_TAB_PREFIX,
  TEAM_TAB_PREFIX,
  TERMINAL_TAB_PREFIX,
  WORKBENCH_TAB_PREFIX,
  useTabStore,
  type Tab,
} from './tabStore'

export function isSessionTabId(tabId: string | null) {
  if (!tabId) return false
  return tabId !== SETTINGS_TAB_ID &&
    tabId !== SCHEDULED_TAB_ID &&
    tabId !== MARKET_TAB_ID &&
    tabId !== CONNECTORS_TAB_ID &&
    !tabId.startsWith(TERMINAL_TAB_PREFIX) &&
    !tabId.startsWith(WORKBENCH_TAB_PREFIX) &&
    !tabId.startsWith(SUBAGENT_TAB_PREFIX) &&
    !tabId.startsWith(TEAM_TAB_PREFIX) &&
    !tabId.startsWith(TEAM_MEMBER_TAB_PREFIX)
}

export function isSessionTab(tab: Tab | null | undefined) {
  if (!tab) return false
  const tabType = (tab as Partial<Tab>).type
  if (tabType === 'session') return true
  if (tabType) return false
  return isSessionTabId(tab.sessionId)
}

/** Chat tabs whose turn or background tasks are still going. */
export function getRunningSessionIds(targetTabs: Tab[]): string[] {
  const chatSessions = useChatStore.getState().sessions
  return targetTabs
    .filter((tab) => isSessionTab(tab))
    .filter((tab) => {
      const sessionState = chatSessions[tab.sessionId]
      return !!sessionState &&
        (sessionState.chatState !== 'idle' || hasRunningBackgroundTasks(sessionState.backgroundAgentTasks))
    })
    .map((tab) => tab.sessionId)
}

/**
 * Everything closing a tab does. A running chat listed in `runningSessionIds`
 * keeps its socket so the work can finish, unless `stopRunning` stops it first.
 * The session itself is never deleted, except an unused "New session".
 */
export function closeTabsWithPolicy(targetTabs: Tab[], runningSessionIds: string[], stopRunning: boolean): void {
  const runningSessionSet = new Set(runningSessionIds)

  for (const tab of targetTabs) {
    if (isSessionTab(tab)) {
      const isRunning = runningSessionSet.has(tab.sessionId)
      if (isRunning && stopRunning) {
        const chat = useChatStore.getState()
        const runningTasks = listRunningBackgroundTasks(chat.sessions[tab.sessionId]?.backgroundAgentTasks)
        chat.stopGeneration(tab.sessionId)
        // The dialog counts background tasks as the session running, but
        // stopGeneration only reaches the foreground turn and Agent tasks (and
        // marks the latter as stopping, which stopBackgroundTask skips). A shell
        // command would outlive "Stop & Close" and keep the reopened session
        // running. Both must go out before disconnectSession closes the socket.
        for (const task of runningTasks) {
          chat.stopBackgroundTask(tab.sessionId, task.taskId)
        }
      }
      if (!isRunning || stopRunning) {
        // Auto-delete only when both server metadata and the loaded transcript
        // confirm this is an empty placeholder. Missing state can mean a timed-out
        // recovery load, so treating it as empty risks deleting a real session.
        const sessionEntry = useSessionStore.getState().sessions.find((s) => s.id === tab.sessionId)
        const chatEntry = useChatStore.getState().sessions[tab.sessionId]
        if (
          sessionEntry?.messageCount === 0 &&
          isPlaceholderSessionTitle(sessionEntry.title) &&
          chatEntry?.historyStatus === 'ready' &&
          chatEntry.messages.length === 0
        ) {
          // Marked before the request so the tab closing below is not offered back.
          useTabStore.getState().markSessionsDeleted([tab.sessionId])
          void useSessionStore.getState().deleteSession(tab.sessionId)
        }
        useChatStore.getState().disconnectSession(tab.sessionId)
      }
      releaseWorkspaceSession(tab.sessionId)
    }
    useTabStore.getState().closeTab(tab.sessionId)
  }
}

/**
 * Brings back the most recently closed chat tab that still has a session.
 * Entries whose session was deleted since are dropped on the way.
 */
export async function reopenClosedSessionTab(): Promise<boolean> {
  for (;;) {
    const closed = useTabStore.getState().takeClosedSessionTab()
    if (!closed) return false
    if (useTabStore.getState().tabs.some((tab) => tab.sessionId === closed.sessionId)) continue

    let session = useSessionStore.getState().sessions.find((s) => s.id === closed.sessionId)
    if (!session) {
      try {
        session = await sessionsApi.getSummary(closed.sessionId)
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) continue
        // Unreachable server: keep the entry for the next try.
        useTabStore.getState().rememberClosedSessionTab(closed)
        return false
      }
    }
    useSessionStore.getState().openHistoricalSession(session)
    useChatStore.getState().connectToSession(session.id)
    return true
  }
}
