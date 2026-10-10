import type { StoreApi } from 'zustand'
import { wsManager } from '../api/websocket'
import { hasRunningBackgroundTasks } from '../lib/backgroundTasks'
import { isSideChatSession } from '../lib/sideChatSessions'
import { useTabStore, type Tab } from './tabStore'
import { useTeamStore } from './teamStore'
import type { PerSessionState } from './chatStore'

type HiddenSessionChatState = {
  sessions: Record<string, PerSessionState>
  disconnectSession: (sessionId: string, options?: { keepTranscript?: boolean }) => void
}

/**
 * Which sessions a client shows. On the desktop every open tab stays live,
 * active or not. The phone and tablet shells show one page at a time: the
 * rest of their tabs are only a way back, and keep their transcript cached.
 */
export type SessionDisplayScope = 'open-tabs' | 'active-tab'

/** Chat, team, member, subagent and legacy workbench tabs all read their session's socket. */
function tabReferences(tab: Tab): Array<string | undefined> {
  return [tab.sessionId, tab.sourceSessionId, tab.teamLeadSessionId, tab.workbenchSessionId]
}

function shownTabs(scope: SessionDisplayScope): Tab[] {
  const { tabs, activeTabId } = useTabStore.getState()
  if (scope === 'open-tabs') return tabs
  return tabs.filter((tab) => tab.sessionId === activeTabId)
}

function isShown(sessionId: string, scope: SessionDisplayScope): boolean {
  return shownTabs(scope).some((tab) => tabReferences(tab).includes(sessionId))
}

/** The turn is still running, or it is the user's move (a prompt or question). */
function hasForegroundWork(session: PerSessionState): boolean {
  return session.chatState !== 'idle' ||
    session.isPreparingTurn === true ||
    (session.queuedUserMessages?.length ?? 0) > 0 ||
    session.pendingPermission != null ||
    Object.keys(session.pendingPermissions ?? {}).length > 0 ||
    session.pendingComputerUsePermission != null ||
    Object.keys(session.pendingComputerUsePermissions ?? {}).length > 0
}

/**
 * The CLI reports `running` until its background tasks and the replies their
 * notifications trigger are all done. Before this connection has seen a run
 * state, a background task the session still shows is the best evidence left.
 */
function isCliStillWorking(session: PerSessionState): boolean {
  if (session.cliRunState) return session.cliRunState === 'running'
  return hasRunningBackgroundTasks(session.backgroundAgentTasks)
}

/**
 * A session's socket is what keeps its CLI — and the MCP servers and shells
 * under it — alive: the server reclaims a runtime only after the last client
 * socket of that session closes. "Keep running" on a tab close keeps the
 * socket so the work can finish and still notify, and the phone keeps a
 * socket for every session it has opened, so nothing released them and each
 * held its runtime until the page or the app went away (#1485).
 *
 * Release a session's socket once nothing on screen reads it and the work it
 * was kept for is done. Kept: a pending prompt (the user's move; its
 * notification or the waiting list brings them back), a CLI still running
 * background work, and a team lead, whose socket carries every member's
 * approvals and team events. Side chats are shown by their parent's workspace
 * and released with it. A session that still has a tab keeps its transcript.
 */
export function installHiddenSessionRelease(
  chatStore: Pick<StoreApi<HiddenSessionChatState>, 'getState' | 'subscribe'>,
  { scope = 'open-tabs' }: { scope?: SessionDisplayScope } = {},
): () => void {
  let installed = true
  const scheduled = new Set<string>()

  const releaseIfDone = (sessionId: string) => {
    const { sessions, disconnectSession } = chatStore.getState()
    const session = sessions[sessionId]
    if (
      !session ||
      isShown(sessionId, scope) ||
      isSideChatSession(sessionId) ||
      !wsManager.getConnectedSessionIds().includes(sessionId) ||
      hasForegroundWork(session) ||
      isCliStillWorking(session) ||
      useTeamStore.getState().teamNameBySession[sessionId]
    ) return
    const stillOpen = isShown(sessionId, 'open-tabs')
    disconnectSession(sessionId, stillOpen ? { keepTranscript: true } : undefined)
  }

  const schedule = (sessionId: string | undefined) => {
    if (!sessionId || scheduled.has(sessionId)) return
    scheduled.add(sessionId)
    // Decide after the current update: the same task may reopen the tab or send
    // a queued message right after the session first looks done.
    queueMicrotask(() => {
      scheduled.delete(sessionId)
      if (installed) releaseIfDone(sessionId)
    })
  }

  // Runs on every chat update, streaming deltas included: compare in place.
  const unsubscribeChat = chatStore.subscribe((state, previous) => {
    if (state.sessions === previous.sessions) return
    for (const sessionId in state.sessions) {
      if (state.sessions[sessionId] !== previous.sessions[sessionId] && !isShown(sessionId, scope)) schedule(sessionId)
    }
  })
  const unsubscribeTabs = useTabStore.subscribe((state, previous) => {
    if (state.tabs === previous.tabs && state.activeTabId === previous.activeTabId) return
    for (const tab of previous.tabs) {
      for (const sessionId of tabReferences(tab)) {
        if (sessionId && !isShown(sessionId, scope)) schedule(sessionId)
      }
    }
  })
  const unsubscribeTeams = useTeamStore.subscribe((state, previous) => {
    if (state.teamNameBySession === previous.teamNameBySession) return
    for (const sessionId in previous.teamNameBySession) {
      if (!state.teamNameBySession[sessionId]) schedule(sessionId)
    }
  })
  // Sessions already off screen when this starts, e.g. after the window
  // narrowed into the phone layout.
  for (const sessionId in chatStore.getState().sessions) {
    if (!isShown(sessionId, scope)) schedule(sessionId)
  }

  return () => {
    installed = false
    unsubscribeChat()
    unsubscribeTabs()
    unsubscribeTeams()
  }
}
