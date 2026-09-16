import { useEffect, useState } from 'react'
import { useTranslation } from '../../i18n'
import { useWorkspaceContentStore } from '../../stores/workspaceContentStore'
import { useWorkspaceReviewStore } from '../../stores/workspaceReviewStore'
import { useWorkspaceStore } from '../../stores/workspaceStore'
import { streamWorkspaceWatch } from './fileWatch'

function parentDirectory(path: string): string {
  const normalized = path.replace(/\\/g, '/')
  const separator = normalized.lastIndexOf('/')
  return separator < 0 ? '' : normalized.slice(0, separator) || '/'
}

function waitForRetry(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', finish)
      resolve()
    }
    const timer = setTimeout(finish, ms)
    signal.addEventListener('abort', finish, { once: true })
    if (signal.aborted) finish()
  })
}

/** One cancellable subscription for the visible task; tab movement keeps caches intact. */
export function useWorkspaceFileWatch(sessionId: string, enabled: boolean): string | null {
  const t = useTranslation()
  const [error, setError] = useState<string | null>(null)
  const openedFileKey = useWorkspaceStore((state) => JSON.stringify(
    (state.bySession[sessionId]?.tabs ?? []).flatMap((tab) => tab.kind === 'file' && tab.path ? [tab.path] : []).sort(),
  ))
  // Read responses provide the same validated path identity as watch events.
  // A chat target may keep its absolute request/cache key inside this workdir.
  const fileKey = useWorkspaceContentStore((state) => JSON.stringify((JSON.parse(openedFileKey) as string[])
    .map((path) => state.filesByKey[`${sessionId}::${path}`]?.watchPath ?? path).sort()))
  const directoryKey = useWorkspaceContentStore((state) => JSON.stringify(Object.entries(state.treeByKey)
    .filter(([key]) => key.startsWith(`${sessionId}::`)).map(([key, tree]) => tree?.path ?? key.slice(sessionId.length + 2)).sort()))
  const directoryCount = new Set(['', ...(JSON.parse(fileKey) as string[]).map(parentDirectory), ...(JSON.parse(directoryKey) as string[])]).size

  useEffect(() => {
    if (!enabled) return
    const files = JSON.parse(fileKey) as string[]
    const loadedDirectories = JSON.parse(directoryKey) as string[]
    // Open files take priority at the bound; root detects renamed/deleted
    // loaded directories. No recursive watcher or repository-wide polling.
    const directories = [...new Set(['', ...files.map(parentDirectory), ...loadedDirectories])].slice(0, 64)
    const abort = new AbortController()
    let refreshTimer: ReturnType<typeof setTimeout> | undefined
    const changedPaths = new Set<string>()
    const changedDirectories = new Set<string>()
    const queueRefresh = (paths: string[], dirtyDirectories: string[]) => {
      for (const path of paths) changedPaths.add(path)
      for (const path of dirtyDirectories) changedDirectories.add(path)
      if (refreshTimer !== undefined) return
      refreshTimer = setTimeout(() => {
        refreshTimer = undefined
        if (abort.signal.aborted) return
        useWorkspaceReviewStore.getState().invalidateSession(sessionId)
        void useWorkspaceContentStore.getState().refreshWatchedPaths(sessionId, [...changedPaths], [...changedDirectories], abort.signal)
        changedPaths.clear()
        changedDirectories.clear()
      }, 120)
    }
    const run = async () => {
      let failures = 0
      while (!abort.signal.aborted) {
        const connection = new AbortController()
        const cancelConnection = () => connection.abort()
        abort.signal.addEventListener('abort', cancelConnection, { once: true })
        let reattach = false
        try {
          await streamWorkspaceWatch(sessionId, directories, connection.signal, (event) => {
            if (abort.signal.aborted || connection.signal.aborted) return
            if (event.type === 'ready') {
              failures = 0
              setError(null)
              queueRefresh(files, directories)
            } else if (event.type === 'change') {
              queueRefresh(event.paths, event.directories)
              // A target or its ancestor was replaced/recreated. Missing
              // targets temporarily watch a live ancestor, so each restored
              // level must move the subscription closer to the target.
              // A coalesced directory may contain an unnamed child replacement
              // even when this event also has named paths. Reattach only the
              // existing bounded subscription; ready refreshes do not reattach.
              const ancestorChanged = event.directories.some((changedDirectory) => directories.some((directory) =>
                directory !== changedDirectory && (changedDirectory === '' || directory.startsWith(`${changedDirectory}/`)),
              ))
              if (ancestorChanged || event.paths.some((path) => directories.some((directory) => directory === path || directory.startsWith(`${path}/`)))) {
                reattach = true
                connection.abort()
              }
            } else if (event.type === 'error') {
              setError(event.message)
            }
          })
        } catch (cause) {
          if (!abort.signal.aborted && !reattach) setError(cause instanceof Error ? cause.message : 'Workspace watch failed')
        } finally {
          abort.signal.removeEventListener('abort', cancelConnection)
          connection.abort()
        }
        if (abort.signal.aborted) break
        if (reattach) continue
        failures += 1
        await waitForRetry(Math.min(30_000, 1_000 * 2 ** Math.min(failures, 5)), abort.signal)
      }
    }
    void run()
    return () => {
      abort.abort()
      clearTimeout(refreshTimer)
    }
  }, [directoryKey, enabled, fileKey, sessionId])

  return enabled ? error ?? (directoryCount > 64 ? t('workspace.files.watchLimit', { count: 64 }) : null) : null
}
