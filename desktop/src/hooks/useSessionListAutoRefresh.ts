import { useCallback, useEffect, useRef } from 'react'

const SESSION_LIST_AUTO_REFRESH_MS = 30_000
const SESSION_LIST_BUILDING_REFRESH_MS = 1_500
const SESSION_LIST_FOCUS_REFRESH_MIN_MS = 5_000

/**
 * Keeps the session list fresh while a list is on screen: once on mount, on
 * window focus / tab return (throttled), and on a slow timer — faster while
 * the local index is still building. The desktop sidebar and the phone's
 * session list both mount it; whichever is showing owns the refresh.
 *
 * Returns a function that forces a refresh now.
 */
export function useSessionListAutoRefresh(
  fetchSessions: () => Promise<void>,
  indexBuilding = false,
): () => Promise<void> {
  const inFlightRef = useRef<Promise<void> | null>(null)
  const lastStartedAtRef = useRef(0)
  const minIntervalMs = indexBuilding
    ? SESSION_LIST_BUILDING_REFRESH_MS
    : SESSION_LIST_FOCUS_REFRESH_MIN_MS

  const refreshSessions = useCallback((force = false) => {
    if (inFlightRef.current && !force) return inFlightRef.current

    const now = Date.now()
    if (!force && now - lastStartedAtRef.current < minIntervalMs) {
      return Promise.resolve()
    }

    lastStartedAtRef.current = now
    const request = Promise.resolve()
      .then(() => fetchSessions())
      .catch(() => undefined)
      .finally(() => {
        if (inFlightRef.current === request) {
          inFlightRef.current = null
        }
      })
    inFlightRef.current = request
    return request
  }, [fetchSessions, minIntervalMs])

  useEffect(() => {
    void refreshSessions(true)

    const refreshIfVisible = () => {
      if (!isDocumentVisible()) return
      void refreshSessions()
    }

    window.addEventListener('focus', refreshIfVisible)
    document.addEventListener('visibilitychange', refreshIfVisible)
    const timer = window.setInterval(() => {
      if (!isDocumentVisible()) return
      void refreshSessions()
    }, indexBuilding ? SESSION_LIST_BUILDING_REFRESH_MS : SESSION_LIST_AUTO_REFRESH_MS)

    return () => {
      window.removeEventListener('focus', refreshIfVisible)
      document.removeEventListener('visibilitychange', refreshIfVisible)
      window.clearInterval(timer)
    }
  }, [refreshSessions, indexBuilding])

  return useCallback(() => refreshSessions(true), [refreshSessions])
}

export function isDocumentVisible(): boolean {
  return typeof document === 'undefined' || document.visibilityState !== 'hidden'
}
