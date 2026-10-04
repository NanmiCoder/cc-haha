import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiError } from '../../api/client'
import { trajectoryApi } from '../../api/trajectory'
import { mergeRows } from '../../lib/trajectory/mergeRows'
import type { TrajectoryPage, TrajectoryRow } from '../../types/trajectory'

export type TrajectoryDataState = {
  status: 'loading' | 'ready' | 'error'
  error: string | null
  rows: ReadonlyMap<string, TrajectoryRow>
  snapshots: readonly TrajectoryRow[]
  olderCursor: string | null
  tailToken: string | null
  historyComplete: boolean
  sourceMissing: boolean
  loadingOlder: boolean
  /** Bumps on every applied change, a cheap memo key for derived views. */
  version: number
}

const EMPTY_STATE: TrajectoryDataState = {
  status: 'loading',
  error: null,
  rows: new Map(),
  snapshots: [],
  olderCursor: null,
  tailToken: null,
  historyComplete: false,
  sourceMissing: false,
  loadingOlder: false,
  version: 0,
}

/** Kept across unmounts so flipping between chat and trajectory is instant. */
const CACHE_LIMIT = 12
const cache = new Map<string, TrajectoryDataState>()

function remember(key: string, state: TrajectoryDataState) {
  cache.delete(key)
  cache.set(key, state)
  while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!)
}

export function clearTrajectoryDataCache() {
  cache.clear()
}

export const APPEND_THROTTLE_MS = 1500
export const RUNNING_POLL_MS = 4000

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}

function applyPage(state: TrajectoryDataState, page: TrajectoryPage, mode: 'tail' | 'older' | 'append'): TrajectoryDataState {
  return {
    ...state,
    status: 'ready',
    error: null,
    rows: mode === 'tail' ? mergeRows(new Map(), page.rows) : mergeRows(state.rows, page.rows),
    snapshots: page.snapshots ?? state.snapshots,
    olderCursor: mode === 'append' ? state.olderCursor : page.olderCursor,
    tailToken: mode === 'older' ? state.tailToken : page.tailToken,
    historyComplete: mode === 'append' ? state.historyComplete : page.historyComplete,
    sourceMissing: Boolean(page.sourceMissing),
    loadingOlder: mode === 'older' ? false : state.loadingOlder,
    version: state.version + 1,
  }
}

/**
 * Loads one trajectory scope (the main transcript or one subagent) and keeps
 * it current while visible. Nothing is fetched while `visible` is false, so a
 * mounted-but-hidden view costs no requests.
 */
export function useTrajectoryData(options: {
  sessionId: string
  agentId?: string
  visible: boolean
  running: boolean
  /** Changes whenever the chat sees new activity; drives throttled appends. */
  activityKey: string | number
}) {
  const { sessionId, agentId, visible, running, activityKey } = options
  const key = `${sessionId}::${agentId ?? 'main'}`
  const [state, setState] = useState<TrajectoryDataState>(() => cache.get(key) ?? EMPTY_STATE)
  const stateRef = useRef(state)
  const keyRef = useRef(key)
  const inflight = useRef<AbortController | null>(null)

  const commit = useCallback((forKey: string, update: (previous: TrajectoryDataState) => TrajectoryDataState) => {
    if (keyRef.current !== forKey) return
    const next = update(stateRef.current)
    stateRef.current = next
    remember(forKey, next)
    setState(next)
  }, [])

  useEffect(() => {
    keyRef.current = key
    const cached = cache.get(key) ?? EMPTY_STATE
    stateRef.current = cached
    setState(cached)
    return () => {
      inflight.current?.abort()
      inflight.current = null
    }
  }, [key])

  const loadTail = useCallback(async () => {
    const forKey = keyRef.current
    inflight.current?.abort()
    const controller = new AbortController()
    inflight.current = controller
    try {
      const page = await trajectoryApi.getPage(sessionId, { agentId }, { signal: controller.signal })
      commit(forKey, (previous) => applyPage(previous, page, 'tail'))
    } catch (error) {
      if (isAbort(error)) return
      commit(forKey, (previous) => ({ ...previous, status: previous.version ? previous.status : 'error', error: errorMessage(error) }))
    } finally {
      if (inflight.current === controller) inflight.current = null
    }
  }, [agentId, commit, sessionId])

  const append = useCallback(async () => {
    const forKey = keyRef.current
    const token = stateRef.current.tailToken
    if (!token) return loadTail()
    if (inflight.current) return
    const controller = new AbortController()
    inflight.current = controller
    try {
      const page = await trajectoryApi.getPage(sessionId, { after: token, agentId }, { signal: controller.signal })
      commit(forKey, (previous) => applyPage(previous, page, 'append'))
    } catch (error) {
      if (isAbort(error)) return
      if (inflight.current === controller) inflight.current = null
      // The transcript was rewritten (rewind, compaction rewrite): start over.
      if (error instanceof ApiError && error.status === 409) return loadTail()
      commit(forKey, (previous) => ({ ...previous, error: errorMessage(error) }))
    } finally {
      if (inflight.current === controller) inflight.current = null
    }
  }, [agentId, commit, loadTail, sessionId])

  const loadOlder = useCallback(async () => {
    const forKey = keyRef.current
    const cursor = stateRef.current.olderCursor
    if (!cursor || stateRef.current.loadingOlder) return false
    commit(forKey, (previous) => ({ ...previous, loadingOlder: true }))
    try {
      const page = await trajectoryApi.getPage(sessionId, { cursor, agentId })
      commit(forKey, (previous) => applyPage(previous, page, 'older'))
      return true
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        commit(forKey, (previous) => ({ ...previous, loadingOlder: false }))
        await loadTail()
        return false
      }
      commit(forKey, (previous) => ({ ...previous, loadingOlder: false, error: errorMessage(error) }))
      return false
    }
  }, [agentId, commit, loadTail, sessionId])

  // First load, and a refresh of cached data when the view becomes visible.
  useEffect(() => {
    if (!visible) return
    if (stateRef.current.version === 0) void loadTail()
    else void append()
  }, [visible, key, loadTail, append])

  // Activity-driven appends, trailing-throttled.
  const lastActivity = useRef(activityKey)
  useEffect(() => {
    if (!visible || lastActivity.current === activityKey) return
    lastActivity.current = activityKey
    const timer = setTimeout(() => { void append() }, APPEND_THROTTLE_MS)
    return () => clearTimeout(timer)
  }, [activityKey, append, visible])

  // Fallback poll while a turn runs, plus one final read when it ends.
  const wasRunning = useRef(running)
  useEffect(() => {
    if (!visible) return
    if (wasRunning.current && !running) void append()
    wasRunning.current = running
    if (!running) return
    const timer = setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
      void append()
    }, RUNNING_POLL_MS)
    return () => clearInterval(timer)
  }, [append, running, visible])

  return { state, loadOlder, reload: loadTail }
}
