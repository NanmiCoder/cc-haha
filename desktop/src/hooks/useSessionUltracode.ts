import { useCallback, useEffect, useRef, useState } from 'react'
import { sessionsApi, type SessionUltracodeState } from '@/api/sessions'

/** Runtime-only state. Never stored in localStorage or copied to another chat. */
export function useSessionUltracode(sessionId: string | undefined, refreshKey: string, open: boolean) {
  const [state, setState] = useState<SessionUltracodeState | null>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const generation = useRef(0)
  const currentSession = useRef(sessionId)
  currentSession.current = sessionId

  useEffect(() => {
    setState(null)
    setError(null)
    setPending(false)
  }, [sessionId])

  useEffect(() => {
    if (!sessionId || pending) return
    const abort = new AbortController()
    const request = ++generation.current
    void sessionsApi.getUltracode(sessionId, abort.signal).then(next => {
      if (request === generation.current && !abort.signal.aborted) { setState(next) }
    }).catch(reason => {
      if (request === generation.current && !abort.signal.aborted) setError(reason instanceof Error ? reason.message : String(reason))
    })
    return () => { abort.abort() }
  }, [sessionId, refreshKey, open, pending])

  const setEnabled = useCallback(async (enabled: boolean) => {
    if (!sessionId || pending) return
    const request = ++generation.current
    const isCurrentRequest = () => currentSession.current === sessionId && request === generation.current
    setPending(true)
    setError(null)
    try {
      const next = await sessionsApi.setUltracode(sessionId, enabled)
      if (isCurrentRequest()) setState(next)
    } catch (reason) {
      if (isCurrentRequest()) setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      if (isCurrentRequest()) setPending(false)
    }
  }, [sessionId, pending])

  return { state, pending, error, setEnabled }
}
