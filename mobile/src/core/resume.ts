import type { ConnectionState } from './sessionTransport'

/**
 * Switched to background while connecting and away longer than this: the attempt was most likely cut by system suspension
 * (after iOS suspends the process sockets and requests stop progressing), so reopen right away on return instead of waiting for a slow timeout.
 */
export const RESUME_STALE_ATTEMPT_MS = 10_000

/**
 * - probe: connection looks open; probe first and keep using it on any received frame; 
 * - expedite: waiting on backoff; retry immediately; 
 * - reconnect: connection unusable; rebuild; 
 * - none: leave as is (connecting, or pairing has expired).
 */
export type ResumeAction = 'none' | 'probe' | 'expedite' | 'reconnect'

/**
 * How to handle the session connection on return to foreground (or network change). Probe regardless of time away, without tearing down usable connections; 
 * do not interrupt one being established, unless it spanned a background period long enough to be suspended.
 */
export function resumeAction({
  connection,
  socketOpen,
  backoffPending,
  attemptStartedAt,
  hiddenAt,
  now,
  staleAfter = RESUME_STALE_ATTEMPT_MS,
}: {
  connection: ConnectionState
  socketOpen: boolean
  backoffPending: boolean
  attemptStartedAt?: number
  hiddenAt?: number
  now: number
  staleAfter?: number
}): ResumeAction {
  if (connection === 'pairing_required') return 'none'
  if (backoffPending) return 'expedite'
  if (connection === 'ready') return socketOpen ? 'probe' : 'reconnect'
  if (connection === 'offline') return 'reconnect'
  const spannedSuspension =
    hiddenAt !== undefined &&
    attemptStartedAt !== undefined &&
    attemptStartedAt <= hiddenAt &&
    now - hiddenAt >= staleAfter
  return spannedSuspension ? 'reconnect' : 'none'
}
