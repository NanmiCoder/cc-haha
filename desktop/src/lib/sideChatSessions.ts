// Lifetime-only identity registry. Closed side chats stay classified as
// ephemeral so late events cannot persist their settings as normal sessions.
const parents = new Map<string, string>()
const known = new Set<string>()

export function registerSideChatSession(sessionId: string, parentSessionId: string) {
  known.add(sessionId)
  parents.set(sessionId, parentSessionId)
}

export function unregisterSideChatSession(sessionId: string) {
  parents.delete(sessionId)
}

export function isSideChatSession(sessionId: string) {
  return sessionId.startsWith('side-') || known.has(sessionId)
}

export function getSideChatParentSessionId(sessionId: string) {
  return parents.get(sessionId)
}
