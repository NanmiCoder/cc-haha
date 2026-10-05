import { useMemo } from 'react'
import type { Tab } from '../../stores/tabStore'
import type { PerSessionState } from '../../stores/chatStore'
import { hasRunningBackgroundTasks } from '../../lib/backgroundTasks'
import { sessionNeedsAttention } from '../../lib/sessionAttention'
import type { LiveActivityMap } from './useLiveSessionActivity'

export type MobileSessionStatus = {
  runningIds: ReadonlySet<string>
  attentionIds: ReadonlySet<string>
}

type ChatSource = Pick<
  PerSessionState,
  'chatState' | 'connectionState' | 'pendingPermission' | 'pendingPermissions' | 'backgroundAgentTasks'
>

/**
 * Running and waiting sessions for the phone list.
 *
 * A session this page holds a live socket to is read from the chat store, the
 * same records the cards render from (`sessionNeedsAttention`), so a request
 * answered here clears at once instead of on the next poll. Every other
 * session is read from the server's live answer, which is the only thing that
 * knows about sessions started elsewhere.
 */
export function deriveMobileSessionStatus(
  tabs: readonly Tab[],
  chatSessions: Readonly<Record<string, ChatSource | undefined>>,
  live: LiveActivityMap,
): MobileSessionStatus {
  const runningIds = new Set<string>()
  const attentionIds = new Set<string>()
  const authoritative = new Set<string>()

  for (const [sessionId, session] of Object.entries(chatSessions)) {
    if (!session) continue
    if (session.connectionState === 'connected') authoritative.add(sessionId)
    if (sessionNeedsAttention(session)) {
      attentionIds.add(sessionId)
    } else if (session.chatState !== 'idle' || hasRunningBackgroundTasks(session.backgroundAgentTasks)) {
      runningIds.add(sessionId)
    }
  }

  for (const tab of tabs) {
    if (tab.type === 'session' && tab.status === 'running' && !attentionIds.has(tab.sessionId)) {
      runningIds.add(tab.sessionId)
    }
  }

  for (const [sessionId, state] of live) {
    if (authoritative.has(sessionId)) continue
    if (state === 'waiting') {
      attentionIds.add(sessionId)
      runningIds.delete(sessionId)
    } else if (!attentionIds.has(sessionId)) {
      runningIds.add(sessionId)
    }
  }

  return { runningIds, attentionIds }
}

export function useMobileSessionStatus(
  tabs: readonly Tab[],
  chatSessions: Readonly<Record<string, ChatSource | undefined>>,
  live: LiveActivityMap,
): MobileSessionStatus {
  return useMemo(() => deriveMobileSessionStatus(tabs, chatSessions, live), [chatSessions, live, tabs])
}
