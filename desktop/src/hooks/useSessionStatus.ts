import { useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useChatStore } from '../stores/chatStore'
import { useTabStore } from '../stores/tabStore'
import { hasRunningBackgroundTasks } from '../lib/backgroundTasks'
import { collectAttentionIds } from '../lib/sessionAttention'
import { mergeLiveSessionStatus, type SessionStatus } from '../lib/sessionLiveStatus'
import { useLiveSessionActivity } from './useLiveSessionActivity'

/**
 * Which sessions are running and which are waiting on the user, across every
 * session rather than only the ones this window holds a socket to.
 *
 * Only id lists are selected from the stores, never the session map: that
 * changes on every streamed token of every session, and a layout component
 * re-rendering for each one kept the window busy while long runs streamed
 * (#1480). `useShallow` keeps an unchanged list from re-rendering.
 */
export function useSessionStatus(): SessionStatus {
  const runningChatIds = useChatStore(useShallow((s) =>
    Object.keys(s.sessions).filter((sessionId) => {
      const session = s.sessions[sessionId]!
      return session.chatState !== 'idle' || hasRunningBackgroundTasks(session.backgroundAgentTasks)
    })))
  // The chat store also mirrors a run onto the chat's tab, which can say so
  // before the session's own record does.
  const runningTabIds = useTabStore(useShallow((s) =>
    s.tabs.flatMap((tab) => tab.type === 'session' && tab.status === 'running' ? [tab.sessionId] : [])))
  const attentionChatIds = useChatStore(useShallow((s) => collectAttentionIds(s.sessions)))
  const connectedIds = useChatStore(useShallow((s) =>
    Object.keys(s.sessions).filter((sessionId) => s.sessions[sessionId]!.connectionState === 'connected')))
  const live = useLiveSessionActivity()
  return useMemo(
    () => mergeLiveSessionStatus({
      runningIds: [...runningChatIds, ...runningTabIds],
      attentionIds: attentionChatIds,
      connectedIds,
    }, live),
    [attentionChatIds, connectedIds, live, runningChatIds, runningTabIds],
  )
}
