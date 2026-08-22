import { watch, type FSWatcher } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'

export type ReconciliationBatch = {
  paths: string[]
  fullSweep: boolean
}

type PendingReconciliationSnapshot = {
  generation: number
  paths: Set<string>
  fullSweep: boolean
}

export type ReconciliationWatchHandle = {
  close(): void
}

export type ReconciliationWatcherMetrics = {
  queuedPaths: number
  maxBatchSize: number
  yielded: number
  fullSweeps: number
  watchFailures: number
}

export type ReconciliationWatcher = {
  start(): Promise<void>
  stop(): Promise<void>
  queueTranscriptPath(path: string): void
  queueFullSweep(): void
  getMetrics(): ReconciliationWatcherMetrics
}

export type ReconciliationWatcherOptions = {
  scope: string
  onBatch(batch: ReconciliationBatch): Promise<void>
  /** Mark dependent reads stale as soon as an event is queued, before debounce. */
  onDirty?: () => void
  onWatchFailure?: (code: 'LOCAL_INDEX_WATCH_FAILED') => void
  onWatchRecovered?: () => void
  /** Override the default top-level transcript classifier for another projection. */
  isTargetPath?: (scope: string, candidate: string) => boolean
  watchDirectory?: (
    directory: string,
    listener: (eventType: string, filename: string | null) => void,
    onError: () => void,
  ) => ReconciliationWatchHandle
  listWatchDirectories?: (scope: string) => Promise<string[]>
  yieldToForeground?: () => Promise<void>
  debounceMs?: number
  maxWaitMs?: number
  safetySweepMs?: number
  maxQueuedPaths?: number
  batchSize?: number
  watchRetryBaseMs?: number
  watchRetryMaxMs?: number
}

const DEFAULT_DEBOUNCE_MS = 350
const DEFAULT_MAX_WAIT_MS = 2_000
const DEFAULT_SAFETY_SWEEP_MS = 5 * 60 * 1_000
const DEFAULT_MAX_QUEUED_PATHS = 2_048
const DEFAULT_BATCH_SIZE = 25

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'ENOENT'
}

async function pathIsDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch (error) {
    if (isMissing(error)) return false
    throw error
  }
}

async function defaultListWatchDirectories(scope: string): Promise<string[]> {
  const projectsRoot = join(scope, 'projects')
  const directories = new Set<string>()
  if (await pathIsDirectory(scope)) directories.add(scope)
  if (!await pathIsDirectory(projectsRoot)) return [...directories]
  directories.add(projectsRoot)
  const entries = await readdir(projectsRoot, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.isDirectory()) directories.add(join(projectsRoot, entry.name))
  }
  return [...directories]
}

function defaultWatchDirectory(
  directory: string,
  listener: (eventType: string, filename: string | null) => void,
  onError: () => void,
  recursive = false,
): FSWatcher {
  const watcher = watch(directory, { recursive }, (eventType, filename) => {
    listener(eventType, filename?.toString() ?? null)
  })
  watcher.on('error', onError)
  return watcher
}

function isExactTranscriptPath(scope: string, candidate: string): boolean {
  const normalizedScope = resolve(scope)
  const normalizedCandidate = resolve(candidate)
  const child = relative(normalizedScope, normalizedCandidate)
  if (!child || child === '..' || child.startsWith(`..${sep}`)) return false
  const parts = child.split(sep)
  return parts.length === 3 &&
    parts[0] === 'projects' &&
    parts[1]!.length > 0 &&
    parts[2]!.endsWith('.jsonl') &&
    parts[2] !== '.jsonl'
}

export function createReconciliationWatcher(
  options: ReconciliationWatcherOptions,
): ReconciliationWatcher {
  const listWatchDirectories = options.listWatchDirectories ?? defaultListWatchDirectories
  const yieldToForeground = options.yieldToForeground ?? (
    () => new Promise<void>(resolve => setTimeout(resolve, 0))
  )
  const debounceMs = Math.max(1, Math.trunc(options.debounceMs ?? DEFAULT_DEBOUNCE_MS))
  const maxWaitMs = Math.max(debounceMs, Math.trunc(options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS))
  const safetySweepMs = Math.max(1, Math.trunc(
    options.safetySweepMs ?? DEFAULT_SAFETY_SWEEP_MS,
  ))
  const maxQueuedPaths = Math.max(1, Math.trunc(
    options.maxQueuedPaths ?? DEFAULT_MAX_QUEUED_PATHS,
  ))
  const batchSize = Math.max(1, Math.min(
    DEFAULT_BATCH_SIZE,
    Math.trunc(options.batchSize ?? DEFAULT_BATCH_SIZE),
  ))
  const projectsRoot = join(resolve(options.scope), 'projects')
  const isTargetPath = options.isTargetPath ?? isExactTranscriptPath
  const watchDirectory = options.watchDirectory ?? (
    (directory, listener, onError) => defaultWatchDirectory(
      directory,
      listener,
      onError,
      dirname(directory) === projectsRoot,
    )
  )
  const watchRetryBaseMs = Math.max(1, Math.trunc(options.watchRetryBaseMs ?? 1_000))
  const watchRetryMaxMs = Math.max(
    watchRetryBaseMs,
    Math.trunc(options.watchRetryMaxMs ?? 60_000),
  )

  let active = false
  let generation = 0
  let firstQueuedAt = 0
  let debounceTimer: ReturnType<typeof setTimeout> | undefined
  let maxWaitTimer: ReturnType<typeof setTimeout> | undefined
  let safetyTimer: ReturnType<typeof setInterval> | undefined
  let watchRetryTimer: ReturnType<typeof setTimeout> | undefined
  let watchRetryMs = watchRetryBaseMs
  let handles = new Map<string, ReconciliationWatchHandle>()
  let processing: Promise<void> | undefined
  let pendingSnapshot: PendingReconciliationSnapshot | undefined
  const dirtyPaths = new Set<string>()
  let needsFullSweep = false
  const metrics: ReconciliationWatcherMetrics = {
    queuedPaths: 0,
    maxBatchSize: 0,
    yielded: 0,
    fullSweeps: 0,
    watchFailures: 0,
  }

  const clearFlushTimers = (): void => {
    if (debounceTimer) clearTimeout(debounceTimer)
    if (maxWaitTimer) clearTimeout(maxWaitTimer)
    debounceTimer = undefined
    maxWaitTimer = undefined
    firstQueuedAt = 0
  }

  const scheduleWatchRetry = (expectedGeneration: number): void => {
    if (!active || expectedGeneration !== generation || watchRetryTimer) return
    watchRetryTimer = setTimeout(() => {
      watchRetryTimer = undefined
      void refreshWatchers(expectedGeneration)
    }, watchRetryMs)
    watchRetryTimer.unref?.()
    watchRetryMs = Math.min(watchRetryMaxMs, watchRetryMs * 2)
  }

  const refreshWatchers = async (expectedGeneration: number): Promise<void> => {
    if (!active || expectedGeneration !== generation) return
    let directories: string[]
    try {
      directories = await listWatchDirectories(options.scope)
    } catch {
      metrics.watchFailures += 1
      needsFullSweep = true
      options.onWatchFailure?.('LOCAL_INDEX_WATCH_FAILED')
      scheduleWatchRetry(expectedGeneration)
      return
    }
    if (!active || expectedGeneration !== generation) return
    const desired = new Set(directories.map(directory => resolve(directory)))
    for (const [directory, handle] of handles) {
      if (desired.has(directory)) continue
      handle.close()
      handles.delete(directory)
    }
    let failed = false
    for (const directory of desired) {
      if (handles.has(directory)) continue
      try {
        const handle = watchDirectory(
          directory,
          (_eventType, filename) => {
            if (!active || expectedGeneration !== generation) return
            const isProjectDirectory = dirname(directory) === projectsRoot
            if (!isProjectDirectory || !filename) {
              queueFullSweep()
              return
            }
            const candidate = join(directory, filename)
            if (!isTargetPath(options.scope, candidate)) {
              queueFullSweep()
              return
            }
            queueTranscriptPath(candidate)
          },
          () => {
            if (!active || expectedGeneration !== generation) return
            const failedHandle = handles.get(directory)
            failedHandle?.close()
            handles.delete(directory)
            metrics.watchFailures += 1
            options.onWatchFailure?.('LOCAL_INDEX_WATCH_FAILED')
            queueFullSweep()
            scheduleWatchRetry(expectedGeneration)
          },
        )
        handles.set(directory, handle)
      } catch {
        failed = true
        metrics.watchFailures += 1
        options.onWatchFailure?.('LOCAL_INDEX_WATCH_FAILED')
        queueFullSweep()
        scheduleWatchRetry(expectedGeneration)
      }
    }
    if (!failed && handles.size === desired.size) {
      const recovered = metrics.watchFailures > 0 && watchRetryMs > watchRetryBaseMs
      if (watchRetryTimer) clearTimeout(watchRetryTimer)
      watchRetryTimer = undefined
      watchRetryMs = watchRetryBaseMs
      if (recovered) options.onWatchRecovered?.()
    }
  }

  const runSnapshot = async (
    expectedGeneration: number,
    fullSweep: boolean,
    paths: string[],
  ): Promise<void> => {
    if (!active || expectedGeneration !== generation) return
    if (fullSweep) {
      metrics.fullSweeps += 1
      await options.onBatch({ paths: [], fullSweep: true })
      if (active && expectedGeneration === generation && !watchRetryTimer) {
        await refreshWatchers(expectedGeneration)
      }
      return
    }
    for (let offset = 0; offset < paths.length; offset += batchSize) {
      if (!active || expectedGeneration !== generation) return
      const batch = paths.slice(offset, offset + batchSize)
      metrics.maxBatchSize = Math.max(metrics.maxBatchSize, batch.length)
      await options.onBatch({ paths: batch, fullSweep: false })
      if (offset + batch.length < paths.length) {
        metrics.yielded += 1
        await yieldToForeground()
      }
    }
  }

  const drainPendingSnapshots = async (): Promise<void> => {
    while (pendingSnapshot) {
      const snapshot = pendingSnapshot
      pendingSnapshot = undefined
      await runSnapshot(
        snapshot.generation,
        snapshot.fullSweep,
        snapshot.fullSweep ? [] : [...snapshot.paths].sort(),
      )
    }
  }

  const startPendingProcessing = (): void => {
    if (processing || !pendingSnapshot) return
    const task = Promise.resolve().then(drainPendingSnapshots)
    processing = task
    void task.then(
      () => {
        if (processing !== task) return
        processing = undefined
        if (active && pendingSnapshot) startPendingProcessing()
      },
      () => {
        if (processing !== task) return
        processing = undefined
        if (active && pendingSnapshot) startPendingProcessing()
      },
    )
  }

  const mergePendingSnapshot = (
    expectedGeneration: number,
    fullSweep: boolean,
    paths: string[],
  ): void => {
    if (!active || expectedGeneration !== generation) return
    if (!pendingSnapshot || pendingSnapshot.generation !== expectedGeneration) {
      pendingSnapshot = {
        generation: expectedGeneration,
        paths: new Set(fullSweep ? [] : paths),
        fullSweep,
      }
    } else if (fullSweep) {
      pendingSnapshot.fullSweep = true
      pendingSnapshot.paths.clear()
    } else if (!pendingSnapshot.fullSweep) {
      for (const path of paths) pendingSnapshot.paths.add(path)
      if (pendingSnapshot.paths.size > maxQueuedPaths) {
        pendingSnapshot.fullSweep = true
        pendingSnapshot.paths.clear()
      }
    }
    startPendingProcessing()
  }

  const flush = (): void => {
    if (!active) return
    clearFlushTimers()
    const expectedGeneration = generation
    const fullSweep = needsFullSweep
    const paths = fullSweep ? [] : [...dirtyPaths].sort()
    needsFullSweep = false
    dirtyPaths.clear()
    metrics.queuedPaths = 0
    if (!fullSweep && paths.length === 0) return
    mergePendingSnapshot(expectedGeneration, fullSweep, paths)
  }

  const scheduleFlush = (): void => {
    if (!active) return
    const now = Date.now()
    if (firstQueuedAt === 0) {
      firstQueuedAt = now
      maxWaitTimer = setTimeout(flush, maxWaitMs)
      maxWaitTimer.unref?.()
    }
    if (debounceTimer) clearTimeout(debounceTimer)
    debounceTimer = setTimeout(flush, debounceMs)
    debounceTimer.unref?.()
  }

  const queueTranscriptPath = (candidate: string): void => {
    if (!active) return
    if (!isTargetPath(options.scope, candidate)) {
      queueFullSweep()
      return
    }
    options.onDirty?.()
    if (needsFullSweep) return
    dirtyPaths.add(resolve(candidate))
    if (dirtyPaths.size > maxQueuedPaths) {
      dirtyPaths.clear()
      needsFullSweep = true
    }
    metrics.queuedPaths = dirtyPaths.size
    scheduleFlush()
  }

  const queueFullSweep = (): void => {
    if (!active) return
    options.onDirty?.()
    needsFullSweep = true
    dirtyPaths.clear()
    metrics.queuedPaths = 0
    scheduleFlush()
  }

  return {
    async start(): Promise<void> {
      if (active) return
      active = true
      generation += 1
      const expectedGeneration = generation
      await refreshWatchers(expectedGeneration)
      if (!active || expectedGeneration !== generation) return
      safetyTimer = setInterval(queueFullSweep, safetySweepMs)
      safetyTimer.unref?.()
    },
    async stop(): Promise<void> {
      if (!active && handles.size === 0) return
      active = false
      generation += 1
      clearFlushTimers()
      if (safetyTimer) clearInterval(safetyTimer)
      safetyTimer = undefined
      if (watchRetryTimer) clearTimeout(watchRetryTimer)
      watchRetryTimer = undefined
      dirtyPaths.clear()
      needsFullSweep = false
      pendingSnapshot = undefined
      metrics.queuedPaths = 0
      for (const handle of handles.values()) handle.close()
      handles = new Map()
      await processing?.catch(() => undefined)
    },
    queueTranscriptPath,
    queueFullSweep,
    getMetrics(): ReconciliationWatcherMetrics {
      return { ...metrics }
    },
  }
}
