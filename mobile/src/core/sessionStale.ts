/**
 * After another page rewrites the session transcript (rewind conversation / code), the session page content is stale.
 * The rewind page records a flag here before returning; when the session page regains focus it takes the flag and rereads history.
 * In memory only, sharing the lifetime of the navigation stack.
 */
const stale = new Set<string>()
const key = (hostId: string, sessionId: string) => JSON.stringify([hostId, sessionId])

export function markSessionStale(hostId: string, sessionId: string) {
  stale.add(key(hostId, sessionId))
}

/** Take the flag: returns true if a reread is needed, and false on later calls. */
export function takeSessionStale(hostId: string, sessionId: string) {
  return stale.delete(key(hostId, sessionId))
}
