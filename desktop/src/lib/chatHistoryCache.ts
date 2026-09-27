import type { PerSessionState } from '../stores/chatStore'
import type { UIMessage } from '../types/chat'
import { retainedMessageBytes } from './chatHistoryBudget'

export const CHAT_HISTORY_CACHE_BYTES = 16 * 1024 * 1024

type HistoryCache = Pick<PerSessionState, 'messages'>
const sizes = new WeakMap<UIMessage[], number>()

/** Rough aggregate size for idle-tab eviction. Shared message objects are
 * counted once; the timeline is a single mounted array. */
export function historyCacheBytes(session: HistoryCache): number {
  const cached = sizes.get(session.messages)
  if (cached !== undefined) return cached
  let bytes = 0
  for (const message of session.messages) bytes += retainedMessageBytes(message)
  sizes.set(session.messages, bytes)
  return bytes
}
