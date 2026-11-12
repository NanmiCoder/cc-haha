import { useEffect, useState } from 'react'
import type { ConnectionState } from '../../core/sessionTransport'

/** Only after being disconnected this long does the nav bar subtitle switch to connection status; until then it shows session info as usual. */
export const CONNECTION_LABEL_AFTER_MS = 3000
/** Only after being disconnected this long does the "Reconnecting" banner pop up. */
export const CONNECTION_BANNER_AFTER_MS = 10000
/** After this many consecutive failures stop waiting: most likely the computer is asleep or the network is down, so tell the user right away. */
export const CONNECTION_BANNER_AFTER_FAILURES = 2

/** In these states the banner says "Disconnected, reconnecting automatically" with a retry. */
export function showsReconnectBanner(connection: ConnectionState) {
  return connection === 'resuming' || connection === 'reconnecting' || connection === 'offline'
}

export type ConnectionNotice = {
  /** The subtitle shows connection status. */
  label: boolean
  /** Show the connection banner (reconnecting / load failed). */
  banner: boolean
  /** how long until the state changes and must be re-evaluated. */
  recheckIn?: number
}

/**
 * Brief disconnects like returning to foreground or switching networks usually recover in a second or two, so do not disturb the user meanwhile.
 * Expired pairing needs user action, so warn immediately; two consecutive failed connects also skip the full ten second wait; 
 * a session just opened and never connected shows "Connecting" as usual.
 */
export function connectionNotice({
  connection,
  since,
  now,
  everReady,
  failures = 0,
}: {
  connection: ConnectionState
  /** The time it last left ready (the session open time if never connected). */
  since: number
  now: number
  everReady: boolean
  /** Consecutive failed connects (see SessionTransport.failures). */
  failures?: number
}): ConnectionNotice {
  if (connection === 'ready') return { label: false, banner: false }
  if (connection === 'pairing_required') return { label: true, banner: true }
  const elapsed = Math.max(0, now - since)
  const failing = failures >= CONNECTION_BANNER_AFTER_FAILURES
  const label = !everReady || failing || elapsed >= CONNECTION_LABEL_AFTER_MS
  const banner = failing || elapsed >= CONNECTION_BANNER_AFTER_MS
  const next = banner
    ? undefined
    : [CONNECTION_LABEL_AFTER_MS, CONNECTION_BANNER_AFTER_MS].find((threshold) => threshold > elapsed)
  return {
    label,
    banner,
    ...(next === undefined ? {} : { recheckIn: next - elapsed }),
  }
}

/** Record the time it left ready, and rerender when the banner should appear. */
export function useConnectionNotice(
  connection: ConnectionState,
  failures = 0,
  now: () => number = Date.now
) {
  const ready = connection === 'ready'
  const [track, setTrack] = useState(() => ({ ready, since: now(), everReady: ready }))
  // Record the time on the spot when the state changes: recording it in an effect would compute one frame with the old time and flash the banner.
  let current = track
  if (track.ready !== ready) {
    current = { ready, since: now(), everReady: track.everReady || ready }
    setTrack(current)
  }
  const [, setChecks] = useState(0)
  const notice = connectionNotice({
    connection,
    since: current.since,
    now: now(),
    everReady: current.everReady,
    failures,
  })
  const wait = notice.recheckIn
  useEffect(() => {
    if (wait === undefined) return
    const timer = setTimeout(() => setChecks((value) => value + 1), wait)
    return () => clearTimeout(timer)
  }, [wait, current.since])
  return notice
}
