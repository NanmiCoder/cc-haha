import { useEffect, useState } from 'react'
import { trajectoryApi } from '../../api/trajectory'
import type { TrajectoryRow, TrajectoryRowDetail, TrajectorySnapshotBlob } from '../../types/trajectory'

type Loadable<T> = { status: 'idle' | 'loading' | 'ready' | 'error'; value: T | null; error: string | null }

const IDLE = { status: 'idle', value: null, error: null } as const

function lru<T>(limit: number) {
  const map = new Map<string, T>()
  return {
    get(key: string) {
      const value = map.get(key)
      if (value !== undefined) {
        map.delete(key)
        map.set(key, value)
      }
      return value
    },
    set(key: string, value: T) {
      map.delete(key)
      map.set(key, value)
      while (map.size > limit) map.delete(map.keys().next().value!)
    },
    clear: () => map.clear(),
  }
}

const rowCache = lru<TrajectoryRowDetail>(48)
const snapshotCache = lru<TrajectorySnapshotBlob>(24)

export function clearTrajectoryDetailCache() {
  rowCache.clear()
  snapshotCache.clear()
}

function useCachedFetch<T>(key: string | null, cache: ReturnType<typeof lru<T>>, load: (signal: AbortSignal) => Promise<T>): Loadable<T> {
  const [state, setState] = useState<Loadable<T>>(() => {
    const cached = key ? cache.get(key) : undefined
    return cached ? { status: 'ready', value: cached, error: null } : key ? { status: 'loading', value: null, error: null } : IDLE
  })
  useEffect(() => {
    if (!key) {
      setState(IDLE)
      return
    }
    const cached = cache.get(key)
    if (cached) {
      setState({ status: 'ready', value: cached, error: null })
      return
    }
    const controller = new AbortController()
    setState({ status: 'loading', value: null, error: null })
    load(controller.signal).then(
      (value) => {
        cache.set(key, value)
        if (!controller.signal.aborted) setState({ status: 'ready', value, error: null })
      },
      (error: unknown) => {
        if (controller.signal.aborted) return
        setState({ status: 'error', value: null, error: error instanceof Error ? error.message : String(error) })
      },
    )
    return () => controller.abort()
    // `load` is recreated per render; the key fully identifies the request.
  }, [key])
  return state
}

/** Full records behind one row. The locator set is part of the key, so a row that grew a result refetches. */
export function useRowDetail(sessionId: string, agentId: string | undefined, row: TrajectoryRow | null) {
  const key = row && row.loc.length
    ? `${sessionId}:${agentId ?? 'main'}:${row.id}:${row.loc.map(([start, end]) => `${start}-${end}`).join(',')}`
    : null
  return useCachedFetch(key, rowCache, (signal) => trajectoryApi.getRow(sessionId, row!.id, row!.loc, agentId, { signal }))
}

export function useSnapshotBlob(sessionId: string, hash: string | undefined) {
  const key = hash ? `${sessionId}:${hash}` : null
  return useCachedFetch(key, snapshotCache, (signal) => trajectoryApi.getSnapshot(sessionId, hash!, { signal }))
}
