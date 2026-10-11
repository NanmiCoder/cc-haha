import { useCallback, useSyncExternalStore } from 'react'
import { sessionsApi } from '../api/sessions'
import type { LiveActivityMap } from '../lib/sessionLiveStatus'
import { isDocumentVisible } from './useSessionListAutoRefresh'

export const LIVE_ACTIVITY_POLL_MS = 5_000

export type { LiveActivityMap }
const EMPTY: LiveActivityMap = new Map()

// One poll for the whole page. The desktop sidebar and its header both read
// this, and two timers would double the requests for the same answer.
let snapshot: LiveActivityMap = EMPTY
let subscribers = 0
let timer: number | null = null
let controller: AbortController | null = null
const listeners = new Set<() => void>()

function sameActivity(a: LiveActivityMap, b: LiveActivityMap): boolean {
  if (a.size !== b.size) return false
  for (const [id, state] of a) if (b.get(id) !== state) return false
  return true
}

function publish(next: LiveActivityMap) {
  if (sameActivity(snapshot, next)) return
  snapshot = next
  for (const listener of listeners) listener()
}

function poll() {
  if (!isDocumentVisible()) return
  controller?.abort()
  const current = new AbortController()
  controller = current
  try {
    void sessionsApi.getLiveStatus(current.signal)
      .then(({ sessions }) => {
        if (current.signal.aborted || subscribers === 0) return
        publish(new Map(sessions.map((entry) => [entry.id, entry.activityState])))
      })
      .catch(() => undefined)
  } catch {
    // A failed poll keeps the last answer, whatever the reason it failed.
  }
}

function start() {
  poll()
  timer = window.setInterval(poll, LIVE_ACTIVITY_POLL_MS)
  document.addEventListener('visibilitychange', poll)
}

function stop() {
  controller?.abort()
  controller = null
  if (timer !== null) window.clearInterval(timer)
  timer = null
  document.removeEventListener('visibilitychange', poll)
  // A page that mounts again later asks afresh rather than showing an answer
  // from whenever the last reader left.
  snapshot = EMPTY
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  subscribers += 1
  if (subscribers === 1) start()
  return () => {
    listeners.delete(listener)
    subscribers -= 1
    if (subscribers === 0) stop()
  }
}

const noopUnsubscribe = () => {}
const readSnapshot = () => snapshot
const readEmpty = () => EMPTY

/**
 * Which sessions the server says are working or waiting, for every session —
 * not only the ones this page opened a socket to. The chat store only knows
 * about connected sessions, so a session started on the phone, from an IM
 * channel or by a scheduled task and parked on an approval would otherwise
 * show nothing.
 *
 * Polls while the page is visible. A failed poll keeps the last answer: one
 * dropped request on a phone network should not make every badge blink off.
 */
export function useLiveSessionActivity(enabled = true): LiveActivityMap {
  const subscribeWhenEnabled = useCallback(
    (listener: () => void) => enabled ? subscribe(listener) : noopUnsubscribe,
    [enabled],
  )
  return useSyncExternalStore(subscribeWhenEnabled, enabled ? readSnapshot : readEmpty)
}
