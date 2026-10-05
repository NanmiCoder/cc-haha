import { useEffect, useState } from 'react'
import { sessionsApi, type LiveSessionActivity } from '../../api/sessions'
import { isDocumentVisible } from '../../hooks/useSessionListAutoRefresh'

export const LIVE_ACTIVITY_POLL_MS = 5_000

export type LiveActivityMap = ReadonlyMap<string, LiveSessionActivity['activityState']>

const EMPTY: LiveActivityMap = new Map()

/**
 * Which sessions the server says are working or waiting, for every session —
 * not only the ones this page opened a socket to. The chat store only knows
 * about connected sessions, so a session started on the desktop and parked on
 * an approval would otherwise sit in "earlier" on the phone.
 *
 * Polls while the page is visible. A failed poll keeps the last answer: one
 * dropped request on a phone network should not make every badge blink off.
 */
export function useLiveSessionActivity(enabled = true): LiveActivityMap {
  const [activity, setActivity] = useState<LiveActivityMap>(EMPTY)

  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    let controller: AbortController | null = null

    const poll = () => {
      if (!isDocumentVisible()) return
      controller?.abort()
      const current = new AbortController()
      controller = current
      void sessionsApi.getLiveStatus(current.signal)
        .then(({ sessions }) => {
          if (cancelled || current.signal.aborted) return
          setActivity(new Map(sessions.map((entry) => [entry.id, entry.activityState])))
        })
        .catch(() => undefined)
    }

    poll()
    const timer = window.setInterval(poll, LIVE_ACTIVITY_POLL_MS)
    document.addEventListener('visibilitychange', poll)
    return () => {
      cancelled = true
      controller?.abort()
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', poll)
    }
  }, [enabled])

  return activity
}
