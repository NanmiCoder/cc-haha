import { useEffect, useRef } from 'react'
import { reviewApi } from '@/api/review'
import { useWorkspaceReviewStore } from '@/stores/workspaceReviewStore'
import { reviewSourceKey, type WorkspaceReviewSource } from './types'

/** Revalidate only the visible live comparison; stable revisions preserve cached diffs and scroll. */
export function useWorkspaceReviewRefresh(sessionId: string, source: WorkspaceReviewSource, active: boolean) {
  const revision = useWorkspaceReviewStore(state => state.revisionBySession[sessionId] ?? 0)
  const trigger = useRef<() => void>(() => {})
  const sourceKey = reviewSourceKey(source)
  useEffect(() => {
    if (!active || source.kind === 'turn' || source.kind === 'commit') return
    const abort = new AbortController()
    let running = false
    const check = async () => {
      const store = useWorkspaceReviewStore.getState()
      if (abort.signal.aborted || running || document.visibilityState === 'hidden' || store.isWriting(sessionId) || store.getEntry(sessionId, source).loading) return
      running = true
      try {
        const next = await reviewApi.getRevision(sessionId, source, { signal: abort.signal })
        if (abort.signal.aborted || store.isWriting(sessionId)) return
        const current = useWorkspaceReviewStore.getState().getEntry(sessionId, source)
        if (!current.loading && (next.snapshot !== current.status?.snapshot || next.state !== current.status?.state || next.error !== current.status?.error)) {
          await store.load(sessionId, source, { force: true, signal: abort.signal })
        }
      } catch {
        // Keep the last readable payload on transient failures; the next probe retries.
      } finally {
        running = false
      }
    }
    trigger.current = () => { void check() }
    trigger.current()
    const timer = setInterval(trigger.current, 5_000)
    window.addEventListener('focus', trigger.current)
    document.addEventListener('visibilitychange', trigger.current)
    return () => {
      abort.abort()
      clearInterval(timer)
      window.removeEventListener('focus', trigger.current)
      document.removeEventListener('visibilitychange', trigger.current)
      trigger.current = () => {}
    }
    // sourceKey is the canonical identity; UI reconstruction of the same source must not restart probes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, sourceKey, active])
  useEffect(() => { trigger.current() }, [revision])
}
