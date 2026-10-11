import type { LiveSessionActivity } from '../api/sessions'

export type LiveActivityMap = ReadonlyMap<string, LiveSessionActivity['activityState']>

export type SessionStatus = {
  runningIds: ReadonlySet<string>
  attentionIds: ReadonlySet<string>
}

/** What this page's own sockets say. */
export type ChatSessionStatus = {
  runningIds: Iterable<string>
  attentionIds: Iterable<string>
  /** Sessions with a live socket: for these the chat store is the authority. */
  connectedIds: Iterable<string>
}

/**
 * Running and waiting sessions, from this page's sockets and the server's live
 * answer together.
 *
 * A session this page holds a live socket to is read from the chat store, the
 * same records the cards render from (`sessionNeedsAttention`), so a request
 * answered here clears at once instead of on the next poll. Every other
 * session is read from the server, which is the only thing that knows about
 * sessions started elsewhere or released from this page's warm set. Waiting
 * outranks running in both sources.
 */
export function mergeLiveSessionStatus(chat: ChatSessionStatus, live: LiveActivityMap): SessionStatus {
  const attentionIds = new Set(chat.attentionIds)
  const runningIds = new Set<string>()
  for (const id of chat.runningIds) if (!attentionIds.has(id)) runningIds.add(id)
  const authoritative = new Set(chat.connectedIds)

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
