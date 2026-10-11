import type { StoreApi } from 'zustand'
import { wsManager } from '../api/websocket'
import { hasRunningBackgroundTasks } from '../lib/backgroundTasks'
import { getSideChatParentSessionId, isSideChatSession } from '../lib/sideChatSessions'
import { useTabStore, type Tab } from './tabStore'
import { useTeamStore } from './teamStore'
import type { PerSessionState } from './chatStore'

type HiddenSessionChatState = {
  sessions: Record<string, PerSessionState>
  askUserQuestionDrafts?: Record<string, unknown>
  disconnectSession: (sessionId: string, options?: { keepTranscript?: boolean }) => void
}

/**
 * How many released conversations keep their transcript cached. Each is only
 * a record once its socket is gone, but the chat store splits its activity
 * budget across every record it holds, so an app that visits hundreds of
 * chats would otherwise starve the one on screen. Past this, the oldest
 * released records with nothing unsent are dropped; going back to one loads
 * its history again.
 */
export const RELEASED_TRANSCRIPT_LIMIT = 16

/**
 * Which sessions a client shows. On the desktop every tab on the navigation
 * stack stays live: the chat on screen, the chats used just before it (capped
 * by `WARM_SESSION_LIMIT`) and whatever the open pages read. The phone and
 * tablet shells show one page at a time: the rest of their tabs are only a way
 * back, and keep their transcript cached.
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
  // A side chat lives in its parent's workspace: it is on screen exactly as
  // long as the parent is. One whose parent is unknown is kept.
  if (isSideChatSession(sessionId)) {
    const parent = getSideChatParentSessionId(sessionId)
    return parent === undefined || isShown(parent, scope)
  }
  return shownTabs(scope).some((tab) => tabReferences(tab).includes(sessionId))
}

/** Nothing typed, queued or half-answered that dropping the record would lose. */
function holdsNothingUnsent(session: PerSessionState, askDrafts: unknown): boolean {
  return !session.composerDraft?.input?.trim() &&
    !(session.composerDraft?.attachments?.length) &&
    !session.repositoryLaunchDraft &&
    !askDrafts &&
    !hasForegroundWork(session)
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
 * approvals and team events. Temporary side chats also stay connected until
 * explicitly closed: their CLI context is not persisted, so reclaiming the
 * runtime would make the conversation impossible to resume.
 *
 * Releasing never drops the transcript, draft or queued messages. Chats leave
 * the desktop's warm set on their own (`WARM_SESSION_LIMIT`), not because
 * someone closed them, so going back has to find the conversation where it
 * was. The chat store's history budget bounds the cached messages, and
 * `RELEASED_TRANSCRIPT_LIMIT` bounds how many released records are kept.
 */
export function installHiddenSessionRelease(
  chatStore: Pick<StoreApi<HiddenSessionChatState>, 'getState' | 'subscribe'>,
  { scope = 'open-tabs' }: { scope?: SessionDisplayScope } = {},
): () => void {
  let installed = true
  const scheduled = new Set<string>()
  // Released sessions, oldest first, for `RELEASED_TRANSCRIPT_LIMIT`.
  const released: string[] = []

  const pruneReleased = () => {
    if (released.length <= RELEASED_TRANSCRIPT_LIMIT) return
    const { sessions, askUserQuestionDrafts, disconnectSession } = chatStore.getState()
    for (let index = 0; index < released.length && released.length > RELEASED_TRANSCRIPT_LIMIT;) {
      const sessionId = released[index]!
      const session = sessions[sessionId]
      if (!session || session.connectionState !== 'disconnected') {
        // Gone or reconnected since: no longer a released record.
        released.splice(index, 1)
        continue
      }
      if (!isShown(sessionId, scope) && holdsNothingUnsent(session, askUserQuestionDrafts?.[sessionId])) {
        released.splice(index, 1)
        disconnectSession(sessionId)
        continue
      }
      index += 1
    }
  }

  const releaseIfDone = (sessionId: string) => {
    const { sessions, disconnectSession } = chatStore.getState()
    const session = sessions[sessionId]
    if (
      !session ||
      isSideChatSession(sessionId) ||
      isShown(sessionId, scope) ||
      !wsManager.getConnectedSessionIds().includes(sessionId) ||
      hasForegroundWork(session) ||
      isCliStillWorking(session) ||
      useTeamStore.getState().teamNameBySession[sessionId]
    ) return
    disconnectSession(sessionId, { keepTranscript: true })
    const at = released.indexOf(sessionId)
    if (at >= 0) released.splice(at, 1)
    released.push(sessionId)
    pruneReleased()
  }

  // Recheck workspace sessions with their parent; the release guard keeps
  // temporary side chats alive even when the parent is no longer shown.
  const scheduleWithSideChats = (sessionId: string) => {
    schedule(sessionId)
    for (const id in chatStore.getState().sessions) {
      if (isSideChatSession(id) && getSideChatParentSessionId(id) === sessionId) schedule(id)
    }
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
        if (sessionId && !isShown(sessionId, scope)) scheduleWithSideChats(sessionId)
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
