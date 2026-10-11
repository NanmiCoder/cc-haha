import { useMemo } from 'react'
import type { Tab } from '../../stores/tabStore'
import type { PerSessionState } from '../../stores/chatStore'
import { hasRunningBackgroundTasks } from '../../lib/backgroundTasks'
import { sessionNeedsAttention } from '../../lib/sessionAttention'
import { mergeLiveSessionStatus, type LiveActivityMap, type SessionStatus } from '../../lib/sessionLiveStatus'

export type MobileSessionStatus = SessionStatus

type ChatSource = Pick<
  PerSessionState,
  'chatState' | 'connectionState' | 'pendingPermission' | 'pendingPermissions' | 'backgroundAgentTasks'
>

/**
 * Running and waiting sessions for the phone list. The merge with the
 * server's live answer is shared with the desktop (`mergeLiveSessionStatus`).
 */
export function deriveMobileSessionStatus(
  tabs: readonly Tab[],
  chatSessions: Readonly<Record<string, ChatSource | undefined>>,
  live: LiveActivityMap,
): MobileSessionStatus {
  const runningIds: string[] = []
  const attentionIds: string[] = []
  const connectedIds: string[] = []

  for (const [sessionId, session] of Object.entries(chatSessions)) {
    if (!session) continue
    if (session.connectionState === 'connected') connectedIds.push(sessionId)
    if (sessionNeedsAttention(session)) {
      attentionIds.push(sessionId)
    } else if (session.chatState !== 'idle' || hasRunningBackgroundTasks(session.backgroundAgentTasks)) {
      runningIds.push(sessionId)
    }
  }

  for (const tab of tabs) {
    if (tab.type === 'session' && tab.status === 'running') runningIds.push(tab.sessionId)
  }

  return mergeLiveSessionStatus({ runningIds, attentionIds, connectedIds }, live)
}

export function useMobileSessionStatus(
  tabs: readonly Tab[],
  chatSessions: Readonly<Record<string, ChatSource | undefined>>,
  live: LiveActivityMap,
): MobileSessionStatus {
  return useMemo(() => deriveMobileSessionStatus(tabs, chatSessions, live), [chatSessions, live, tabs])
}
