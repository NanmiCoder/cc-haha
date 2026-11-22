/**
 * Upstream session-id rotation for relays that cap requests per conversation.
 *
 * Some relays (OpenCode Zen Go, for example) count requests per conversation id
 * and refuse the whole conversation once the cap is hit, answering
 * `400 {"error":{"code":"session_request_limit_exceeded"}}`. The conversation
 * itself is not lost — every request re-sends the full history — so the cap
 * only binds the identity the proxy sends upstream. Rotating that id (same
 * conversation, fresh counter) lets the session continue in place instead of
 * forcing the user to export the transcript and start over.
 *
 * Rotation is deliberately narrow:
 * - Only the relay's own error code triggers it, never any other 400.
 * - Only presets whose upstream header template carries `$SESSION_ID` opt in;
 *   a relay that identifies the conversation by something else gains nothing
 *   from a rotated id, and the retry would double upstream traffic for nothing.
 * - It proves itself per id: a rotated id that was refused before it ever
 *   served a successful request disables rotation for the conversation — the
 *   relay evidently counts on something else (account, API key), or rejects
 *   the id's format. A rotated id that served successfully and later hits the
 *   cap has simply exhausted its own counter and rotates onward.
 */

const ROTATION_TTL_MS = 6 * 60 * 60 * 1000
const MAX_ROTATIONS_PER_SESSION = 25
const MAX_TRACKED_SESSIONS = 1000

const SESSION_LIMIT_ERROR_CODE = 'session_request_limit_exceeded'

export function isSessionLimitError(text: string): boolean {
  for (let depth = 0; depth < 3; depth++) {
    let payload: { code?: unknown; error?: { code?: unknown; message?: unknown } } | null
    try { payload = JSON.parse(text) } catch { return false }
    if (!payload || typeof payload !== 'object') return false
    if (payload.code === SESSION_LIMIT_ERROR_CODE || payload.error?.code === SESSION_LIMIT_ERROR_CODE) return true
    const message = payload.error?.message
    const prefix = 'Upstream returned HTTP 400: '
    if (typeof message !== 'string' || !message.startsWith(prefix)) return false
    text = message.slice(prefix.length)
  }
  return false
}

type RotationEntry = {
  count: number
  currentId: string
  /** Whether `currentId` ever served a successful request. */
  currentIdSucceeded: boolean
  disabled: boolean
  updatedAt: number
}

const rotations = new Map<string, RotationEntry>()

function pruneExpired(now: number): void {
  for (const [key, entry] of rotations) {
    if (now - entry.updatedAt > ROTATION_TTL_MS) rotations.delete(key)
  }
  while (rotations.size > MAX_TRACKED_SESSIONS) {
    // Map preserves insertion order; the oldest entry is the least recently
    // touched because every touch re-puts it below.
    const oldest = rotations.keys().next().value
    if (oldest === undefined) break
    rotations.delete(oldest)
  }
}

function touch(inboundSessionId: string, entry: RotationEntry, now: number): void {
  entry.updatedAt = now
  rotations.delete(inboundSessionId)
  rotations.set(inboundSessionId, entry)
}

/**
 * Whether a preset's upstream header template actually carries the session id.
 * Without it the relay identifies the conversation by something the proxy does
 * not control, so rotation is meaningless.
 */
export function templateCarriesSessionId(template: Record<string, string> | undefined): boolean {
  if (!template) return false
  return Object.values(template).some(value => value.includes('$SESSION_ID'))
}

/**
 * The session id the proxy should send upstream for this conversation: the
 * rotated id once a rotation is active, the inbound id otherwise.
 */
export function getEffectiveUpstreamSessionId(inboundSessionId: string, providerId = ''): string {
  const now = Date.now()
  pruneExpired(now)
  const key = JSON.stringify([providerId, inboundSessionId])
  const entry = rotations.get(key)
  if (!entry || entry.disabled) return inboundSessionId
  touch(key, entry, now)
  return entry.currentId
}

/**
 * Record that a request under the conversation's current upstream id succeeded,
 * so a later refusal of that id reads as "counter exhausted" (rotate onward)
 * rather than "rotation does not work here" (disable).
 */
export function markUpstreamSessionSuccess(inboundSessionId: string, attemptedId: string, providerId = ''): void {
  const key = JSON.stringify([providerId, inboundSessionId])
  const entry = rotations.get(key)
  if (!entry || entry.disabled || entry.currentId !== attemptedId) return
  entry.currentIdSucceeded = true
  touch(key, entry, Date.now())
}

/**
 * Record that the upstream refused this conversation with the session-limit
 * error code, and return the id the retry should use.
 *
 * Returns the next rotated id when rotation can still help, and `null` when it
 * cannot: the refused id never served a successful request (rotation is
 * provably useless for this relay), rotation was disabled earlier, or the
 * per-conversation cap was reached.
 */
export function recordSessionLimitExceeded(inboundSessionId: string, attemptedId: string, providerId = ''): string | null {
  if (!inboundSessionId) return null
  const now = Date.now()
  pruneExpired(now)

  const key = JSON.stringify([providerId, inboundSessionId])
  const entry = rotations.get(key)
  if (entry?.disabled) return null
  if (entry && attemptedId !== entry.currentId) return entry.currentId
  if (entry && attemptedId === entry.currentId && attemptedId !== inboundSessionId && !entry.currentIdSucceeded) {
    // The freshly rotated id was refused before it ever worked.
    entry.disabled = true
    entry.updatedAt = now
    return null
  }
  if (entry && entry.count >= MAX_ROTATIONS_PER_SESSION) {
    entry.disabled = true
    entry.updatedAt = now
    return null
  }
  const count = (entry?.count ?? 0) + 1
  const currentId = `${inboundSessionId}-r${count}`
  touch(key, { count, currentId, currentIdSucceeded: false, disabled: false, updatedAt: now }, now)
  pruneExpired(now)
  return currentId
}

export function resetSessionRotationForTests(): void {
  rotations.clear()
}
