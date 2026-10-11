import type { StoreApi } from 'zustand'
import { isPlaceholderSessionTitle } from '../lib/sessionTitle'
import { isSideChatSession } from '../lib/sideChatSessions'
import { useSessionStore } from './sessionStore'
import { useTabStore } from './tabStore'
import type { PerSessionState } from './chatStore'

type EmptySessionChatState = {
  sessions: Record<string, PerSessionState>
  disconnectSession: (sessionId: string, options?: { keepTranscript?: boolean }) => void
}

/**
 * "New session" creates the session on the server straight away, so walking
 * away from it unused left a "New Session" row in the sidebar for good. The
 * tab strip used to delete such a session when its tab was closed; with no
 * tabs to close, it is deleted when the person leaves it for another chat or
 * the new-session page.
 *
 * Opening a page on top of it (Settings, the market, a run) is not leaving:
 * the person is coming back. And it is only empty when every source agrees —
 * no messages on the server, a placeholder title, a loaded and empty
 * transcript, and nothing typed or queued. A missing record can mean a load
 * that timed out, so it never counts as empty.
 */
export function isAbandonedEmptySession(sessionId: string, chat: PerSessionState | undefined): boolean {
  if (isSideChatSession(sessionId)) return false
  const listed = useSessionStore.getState().sessions.find((session) => session.id === sessionId)
  return Boolean(
    listed &&
    listed.messageCount === 0 &&
    isPlaceholderSessionTitle(listed.title) &&
    chat &&
    chat.historyStatus === 'ready' &&
    chat.messages.length === 0 &&
    chat.chatState === 'idle' &&
    !chat.isPreparingTurn &&
    !(chat.queuedUserMessages?.length) &&
    !chat.composerDraft?.input?.trim() &&
    !(chat.composerDraft?.attachments?.length),
  )
}

export function installEmptySessionCleanup(
  chatStore: Pick<StoreApi<EmptySessionChatState>, 'getState'>,
): () => void {
  let installed = true
  const unsubscribe = useTabStore.subscribe((state, previous) => {
    const left = previous.activeTabId
    if (!left || state.activeTabId === left) return
    if (previous.tabs.find((tab) => tab.sessionId === left)?.type !== 'session') return
    const shown = state.tabs.find((tab) => tab.sessionId === state.activeTabId)
    // Back to a chat or to the new-session page counts as leaving; a page
    // opened on top of it does not.
    if (shown && shown.type !== 'session') return
    // Replaced in place (an empty session swapped for a worktree one): its
    // owner deletes it.
    if (!state.tabs.some((tab) => tab.sessionId === left)) return
    // Decide after the current update, as the release does: the same action
    // may still be filling the session in.
    queueMicrotask(() => {
      if (!installed) return
      const { sessions, disconnectSession } = chatStore.getState()
      if (useTabStore.getState().activeTabId === left) return
      if (!isAbandonedEmptySession(left, sessions[left])) return
      void useSessionStore.getState().deleteSession(left)
        .then(() => {
          disconnectSession(left)
          useTabStore.getState().closeTab(left)
        })
        .catch(() => {
          // The row stays; the person can delete it by hand.
        })
    })
  })
  return () => {
    installed = false
    unsubscribe()
  }
}
