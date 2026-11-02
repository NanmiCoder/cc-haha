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
 * 工作区目录树：按需读取，展开哪个文件夹才读哪个，读过的留在内存里。
 * 根目录在 enabled 变为 true 时读一次；出错的目录点按重试。
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

/** 项目内按文件名搜索（电脑端的 workspace/search，最多 200 条）；停手 250ms 才发请求。 */
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
              : { query, error: response.error || '暂时无法搜索' }
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
