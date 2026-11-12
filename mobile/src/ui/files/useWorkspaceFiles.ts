import { useCallback, useEffect, useRef, useState } from 'react'
import type { ApiClient } from '../../core/client'
import { errorMessage } from '../../core/changesView'
import {
  dirState,
  searchRows,
  type DirEntry,
  type DirState,
  type SearchRow,
} from './filesModel'

type TreeResponse = { state?: string; entries?: DirEntry[]; error?: string }
type SearchResponse = { state?: string; entries?: DirEntry[]; truncated?: boolean; error?: string }

const root = (sessionId: string) => `/api/sessions/${encodeURIComponent(sessionId)}/workspace`

/**
 * Workspace directory tree: read on demand, only the folder being expanded is read, and read ones stay in memory.
 * The root is read once when enabled becomes true; tap an errored directory to retry.
 */
export function useWorkspaceTree(client: ApiClient | null, sessionId: string, enabled: boolean) {
  const [dirs, setDirs] = useState<Record<string, DirState>>({})
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set())
  const abort = useRef<AbortController | null>(null)
  useEffect(() => {
    const controller = new AbortController()
    abort.current = controller
    return () => controller.abort()
  }, [client, sessionId])

  const load = useCallback(
    (path: string) => {
      const signal = abort.current?.signal
      if (!client || !signal) return
      setDirs((previous) => ({ ...previous, [path]: 'loading' }))
      client
        .get<TreeResponse>(`${root(sessionId)}/tree?path=${encodeURIComponent(path)}`, { signal })
        .then((response) => {
          if (!signal.aborted) setDirs((previous) => ({ ...previous, [path]: dirState(response) }))
        })
        .catch((error) => {
          if (!signal.aborted)
            setDirs((previous) => ({ ...previous, [path]: { error: errorMessage(error) } }))
        })
    },
    [client, sessionId]
  )

  const rootLoaded = dirs[''] !== undefined
  useEffect(() => {
    if (enabled && client && !rootLoaded) load('')
  }, [enabled, client, rootLoaded, load])

  const toggle = useCallback(
    (path: string) => {
      setOpen((previous) => {
        const next = new Set(previous)
        if (next.has(path)) next.delete(path)
        else next.add(path)
        return next
      })
      if (!dirs[path]) load(path)
    },
    [dirs, load]
  )
  return { dirs, open, toggle, retry: load }
}

/** Search by file name within the project (desktop workspace/search, at most 200 results); the request is sent after 250ms idle. */
export function useFileSearch(
  client: ApiClient | null,
  sessionId: string,
  query: string,
  enabled: boolean
) {
  const [result, setResult] = useState<{
    query: string
    rows?: SearchRow[]
    truncated?: boolean
    error?: string
  } | null>(null)
  useEffect(() => {
    if (!client || !enabled || !query) return
    const controller = new AbortController()
    const timer = setTimeout(() => {
      client
        .get<SearchResponse>(`${root(sessionId)}/search?query=${encodeURIComponent(query)}`, {
          signal: controller.signal,
        })
        .then((response) => {
          if (controller.signal.aborted) return
          setResult(
            response.state === 'ok' || Array.isArray(response.entries)
              ? { query, rows: searchRows(response.entries ?? []), truncated: response.truncated }
              : { query, error: response.error || 'Search unavailable right now' }
          )
        })
        .catch((error) => {
          if (!controller.signal.aborted) setResult({ query, error: errorMessage(error) })
        })
    }, 250)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [client, sessionId, query, enabled])
  const current = result && result.query === query ? result : null
  return {
    rows: current?.rows ?? [],
    truncated: Boolean(current?.truncated),
    error: current?.error ?? '',
    pending: Boolean(query) && enabled && !current,
  }
}
