import type { ClientMessage } from './types'

type Sender = (message: ClientMessage) => boolean

const senders = new Map<string, Sender>()

/**
 * The session page registers its WebSocket send function here so other pages (like the full-screen subagent page)
 * can send "stop background task" without opening another connection. Returns an unregister function; a later registration for the same session overrides an earlier one.
 */
export function registerSessionSender(sessionId: string, send: Sender) {
  senders.set(sessionId, send)
  return () => {
    if (senders.get(sessionId) === send) senders.delete(sessionId)
  }
}

/** Returns false when not registered or the connection is not ready. */
export function sendToSession(sessionId: string, message: ClientMessage) {
  return senders.get(sessionId)?.(message) ?? false
}
