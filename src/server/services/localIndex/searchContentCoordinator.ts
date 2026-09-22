import { lstat, readdir, rm } from 'node:fs/promises'
import { basename, join, relative, resolve, sep } from 'node:path'
import { getClaudeConfigHomeDir } from '../../../utils/envUtils.js'
import { isConfirmedLocalIndexCorruption } from './recovery.js'
import {
  getSearchContentDatabasePath,
  openSearchContentDatabase,
  type SearchContentDatabase,
} from './searchContentDatabase.js'
import {
  createSearchContentIndex,
  type SearchContentIndex,
  type SearchContentSuggestions,
  type SearchContentQueryOptions,
  type SearchContentQueryResult,
} from './searchContentIndex.js'
import {
  createSearchContentProjector,
  type SearchContentProjector,
  type SearchContentSourceCandidate,
} from './searchContentProjector.js'
import {
  createReconciliationWatcher,
  type ReconciliationBatch,
  type ReconciliationWatcher,
  type ReconciliationWatcherOptions,
} from './reconciliationWatcher.js'

export const SEARCH_CONTENT_STORAGE_LIMIT_BYTES = 512 * 1024 * 1024

export type SearchContentDiscoveryResult = {
  complete: boolean
  rootMissing?: boolean
}

export type SearchContentDiscoveryEmitter = (
  candidates: SearchContentSourceCandidate[],
) => Promise<void>

export type SearchContentCoordinatorStatus = {
  state: 'building' | 'ready' | 'degraded'
  discovered: number
  indexed: number
  degradedSources: number
  databaseBytes: number
  walBytes: number
  lastErrorCode: string | null
}

export interface SearchContentCoordinator {
  suggestSessions(query: string, options?: { limit?: number; signal?: AbortSignal }): SearchContentSuggestions | null
  start(): Promise<void>
  stop(): Promise<void>
  search(
    query: string,
    options?: SearchContentQueryOptions & { signal?: AbortSignal },
  ): SearchContentQueryResult | null
  getStatus(): SearchContentCoordinatorStatus
}

type SearchContentCoordinatorDependencies = {
  resolveScope?: () => string
  resolveDatabasePath?: () => string
  openDatabase?: (path: string, scope: string) => SearchContentDatabase
  createIndex?: (database: SearchContentDatabase, scope: string) => SearchContentIndex
  createProjector?: (options: {
    database: SearchContentDatabase
    index: SearchContentIndex
    signal: AbortSignal
  }) => SearchContentProjector
  discoverSources?: typeof discoverSearchContentSources
  createWatcher?: (options: ReconciliationWatcherOptions) => ReconciliationWatcher
  schedule?: (task: () => void) => void
  yieldToForeground?: () => Promise<void>
  removeDatabaseFamily?: (databasePath: string) => Promise<void>
  storageLimitBytes?: number
}

const EMPTY_STATUS: SearchContentCoordinatorStatus = {
  state: 'building',
  discovered: 0,
  indexed: 0,
  degradedSources: 0,
  databaseBytes: 0,
  walBytes: 0,
  lastErrorCode: null,
}

const SEARCH_CONTENT_OWNER_MISSING = 'SEARCH_CONTENT_OWNER_MISSING'
const SEARCH_CONTENT_PROJECTS_ROOT_MISSING = 'SEARCH_CONTENT_PROJECTS_ROOT_MISSING'

class SearchContentOwnerMissingError extends Error {
  readonly code = SEARCH_CONTENT_OWNER_MISSING

  constructor() {
    super('Nested search source has no openable owner transcript')
    this.name = 'SearchContentOwnerMissingError'
  }
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'ENOENT'
}

function errorCode(error: unknown, fallback: string): string {
  const code = (error as { code?: unknown })?.code
  return typeof code === 'string' && code ? code : fallback
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return
  const error = signal.reason instanceof Error
    ? signal.reason
    : new Error('Search content operation was aborted')
  error.name = 'AbortError'
  throw error
}

function pathParts(scope: string, candidate: string): string[] | null {
  const projectsRoot = resolve(scope, 'projects')
  const child = relative(projectsRoot, resolve(candidate))
  if (!child || child === '..' || child.startsWith(`..${sep}`) || child.endsWith(sep)) {
    return null
  }
  const parts = child.split(sep)
  if (
    parts.length === 0 ||
    parts.some(part => !part || part === '.' || part === '..') ||
    !parts.at(-1)!.endsWith('.jsonl') ||
    parts.at(-1) === '.jsonl'
  ) return null
  return parts
}

export function isSearchContentJsonlPath(scope: string, candidate: string): boolean {
  return pathParts(scope, candidate) !== null
}

async function candidateFromPath(
  scope: string,
  candidatePath: string,
): Promise<SearchContentSourceCandidate | null> {
  const parts = pathParts(scope, candidatePath)
  if (!parts) return null
  const normalizedPath = resolve(candidatePath)
  let snapshot
  try {
    snapshot = await lstat(normalizedPath)
  } catch (error) {
    if (isMissing(error)) return null
    throw error
  }
  if (!snapshot.isFile() || snapshot.isSymbolicLink()) return null

  const projectsRoot = resolve(scope, 'projects')
  if (parts.length === 1) {
    return {
      path: normalizedPath,
      projectPath: basename(projectsRoot),
      ownerSessionId: parts[0]!.slice(0, -'.jsonl'.length),
      ownerTranscriptPath: normalizedPath,
      modifiedAtMs: snapshot.mtimeMs,
    }
  }

  const projectPath = parts[0]!
  const direct = parts.length === 2
  const ownerSessionId = direct
    ? parts[1]!.slice(0, -'.jsonl'.length)
    : parts[1]!
  const ownerTranscriptPath = direct
    ? normalizedPath
    : join(projectsRoot, projectPath, `${ownerSessionId}.jsonl`)
  if (!direct) {
    try {
      const ownerSnapshot = await lstat(ownerTranscriptPath)
      if (!ownerSnapshot.isFile() || ownerSnapshot.isSymbolicLink()) {
        throw new SearchContentOwnerMissingError()
      }
    } catch (error) {
      if (isMissing(error)) throw new SearchContentOwnerMissingError()
      throw error
    }
  }
  return {
    path: normalizedPath,
    projectPath,
    ownerSessionId,
    ownerTranscriptPath,
    // Date filters apply to the actual matching source. Owner-level ranking is
    // still correct because the query groups sources with MAX(modified_at_ms).
    modifiedAtMs: snapshot.mtimeMs,
  }
}

export async function discoverSearchContentSources(
  scope: string,
  signal: AbortSignal,
  emit: SearchContentDiscoveryEmitter,
): Promise<SearchContentDiscoveryResult> {
  const projectsRoot = resolve(scope, 'projects')
  let rootEntries
  try {
    rootEntries = await readdir(projectsRoot, { withFileTypes: true })
  } catch (error) {
    if (isMissing(error)) return { complete: true, rootMissing: true }
    throw error
  }

  const directories: Array<{ path: string; entries: typeof rootEntries }> = [{
    path: projectsRoot,
    entries: rootEntries,
  }]
  let candidates: SearchContentSourceCandidate[] = []
  let complete = true
  const flush = async (): Promise<void> => {
    if (candidates.length === 0) return
    candidates.sort((left, right) =>
      right.modifiedAtMs - left.modifiedAtMs || left.path.localeCompare(right.path))
    const batch = candidates
    candidates = []
    await emit(batch)
  }

  while (directories.length > 0) {
    throwIfAborted(signal)
    const directory = directories.pop()!
    for (const entry of directory.entries) {
      throwIfAborted(signal)
      const entryPath = join(directory.path, entry.name)
      if (entry.isDirectory()) {
        try {
          directories.push({
            path: entryPath,
            entries: await readdir(entryPath, { withFileTypes: true }),
          })
        } catch (error) {
          if (isMissing(error)) {
            complete = false
            continue
          }
          throw error
        }
        continue
      }
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue
      let candidate: SearchContentSourceCandidate | null
      try {
        candidate = await candidateFromPath(scope, entryPath)
      } catch (error) {
        if (errorCode(error, '') === SEARCH_CONTENT_OWNER_MISSING) {
          complete = false
          continue
        }
        throw error
      }
      if (!candidate) {
        complete = false
        continue
      }
      candidates.push(candidate)
      if (candidates.length >= 25) await flush()
    }
  }
  await flush()
  return { complete }
}

async function removeSearchDatabaseFamily(databasePath: string): Promise<void> {
  await Promise.all(['', '-wal', '-shm', '-journal'].map(suffix =>
    rm(`${databasePath}${suffix}`, { force: true }),
  ))
}

export function createSearchContentCoordinator(
  dependencies: SearchContentCoordinatorDependencies = {},
): SearchContentCoordinator {
  const resolveScope = dependencies.resolveScope ?? getClaudeConfigHomeDir
  const resolveDatabasePath = dependencies.resolveDatabasePath ?? getSearchContentDatabasePath
  const openDatabase = dependencies.openDatabase ?? (
    (path, scope) => openSearchContentDatabase({ path, scope })
  )
  const createIndex = dependencies.createIndex ?? (
    (database, scope) => createSearchContentIndex(database, { scope })
  )
  const createProjector = dependencies.createProjector ?? (
    options => createSearchContentProjector(options)
  )
  const discoverSources = dependencies.discoverSources ?? discoverSearchContentSources
  const createWatcher = dependencies.createWatcher ?? createReconciliationWatcher
  const schedule = dependencies.schedule ?? queueMicrotask
  const yieldToForeground = dependencies.yieldToForeground ?? (
    () => new Promise<void>(resolve => setTimeout(resolve, 0))
  )
  const removeDatabaseFamily = dependencies.removeDatabaseFamily ?? removeSearchDatabaseFamily
  const storageLimitBytes = Math.max(
    1,
    Math.trunc(dependencies.storageLimitBytes ?? SEARCH_CONTENT_STORAGE_LIMIT_BYTES),
  )

  let status = { ...EMPTY_STATUS }
  let started = false
  let lifecycle = 0
  let dirtyRevision = 0
  let hasCompleteSweep = false
  let watcherHealthy = true
  let scope: string | undefined
  let databasePath: string | undefined
  let database: SearchContentDatabase | undefined
  let index: SearchContentIndex | undefined
  let projector: SearchContentProjector | undefined
  let watcher: ReconciliationWatcher | undefined
  let controller: AbortController | undefined
  let writerQueue: Promise<void> = Promise.resolve()
  let dirtyReadinessWrite: symbol | undefined
  let startPromise: Promise<void> | undefined
  let stopPromise: Promise<void> | undefined
  let corruptionRecoveryToken: symbol | undefined
  let failedPaths = new Map<string, string>()
  let discoveryFailureCode: string | null = null
  const closedDatabases = new WeakSet<SearchContentDatabase>()
  const watcherStopPromises = new WeakMap<ReconciliationWatcher, Promise<void>>()

  const closeDatabaseOnce = (target: SearchContentDatabase | undefined): void => {
    if (!target || closedDatabases.has(target)) return
    closedDatabases.add(target)
    try {
      target.close()
    } catch {
      // Cleanup must not mask the startup/recovery failure that caused it.
    }
  }

  const stopWatcherOnce = (
    target: ReconciliationWatcher | undefined,
  ): Promise<void> => {
    if (!target) return Promise.resolve()
    const pending = watcherStopPromises.get(target)
    if (pending) return pending
    const operation = Promise.resolve()
      .then(() => target.stop())
      .catch(() => undefined)
    watcherStopPromises.set(target, operation)
    return operation
  }

  const setBuilding = (): void => {
    if (!started) return
    dirtyRevision += 1
    status = { ...status, state: 'building', lastErrorCode: null }
    // Watcher notifications run outside the projection queue. A synchronous
    // write here would wait on the worker's SQLite lock on the UI/API thread.
    if (dirtyReadinessWrite) return
    const token = Symbol('dirty-readiness')
    dirtyReadinessWrite = token
    const expectedLifecycle = lifecycle
    void enqueue(expectedLifecycle, async () => {
      if (dirtyReadinessWrite !== token) return
      dirtyReadinessWrite = undefined
      if (!started || expectedLifecycle !== lifecycle || !index) return
      index.setReadiness({
        state: status.state,
        generation: dirtyRevision,
        discovered: status.discovered,
        indexed: status.indexed,
        degraded: status.degradedSources,
        lastErrorCode: status.lastErrorCode,
      })
    })
  }

  const refreshStorage = (): boolean => {
    if (!database) return false
    try {
      database.checkpointPassive()
      const storage = database.getStorageStats()
      status = {
        ...status,
        databaseBytes: storage.databaseBytes,
        walBytes: storage.walBytes,
      }
      return storage.databaseBytes + storage.walBytes <= storageLimitBytes
    } catch (error) {
      status = {
        ...status,
        state: 'degraded',
        lastErrorCode: errorCode(error, 'SEARCH_CONTENT_STORAGE_FAILED'),
      }
      return false
    }
  }

  const finishProjection = (
    expectedLifecycle: number,
    processedRevision: number,
    failureCodes: string[],
  ): void => {
    if (!started || expectedLifecycle !== lifecycle || !index) return
    const sources = index.listSources()
    const count = sources.length
    const pendingSources = sources.filter(source => source.state !== 'ready').length
    const projectionFailures = pendingSources > 0
      ? [...failureCodes, 'SEARCH_CONTENT_SOURCE_PENDING']
      : failureCodes
    status = {
      ...status,
      discovered: count,
      indexed: Math.max(0, count - projectionFailures.length),
      degradedSources: projectionFailures.length,
    }
    const storageHealthy = refreshStorage()
    const ready = hasCompleteSweep &&
      watcherHealthy &&
      projectionFailures.length === 0 &&
      processedRevision === dirtyRevision &&
      storageHealthy
    const lastErrorCode = !storageHealthy
      ? status.lastErrorCode ?? 'SEARCH_CONTENT_STORAGE_LIMIT'
      : projectionFailures.at(-1) ?? (!watcherHealthy ? 'SEARCH_CONTENT_WATCH_FAILED' : null)
    const state = ready ? 'ready' : processedRevision !== dirtyRevision && !lastErrorCode ? 'building' : 'degraded'
    status = { ...status, state, lastErrorCode }
    index.setReadiness({
      state,
      generation: dirtyRevision,
      discovered: status.discovered,
      indexed: status.indexed,
      degraded: status.degradedSources + (watcherHealthy ? 0 : 1),
      lastErrorCode,
    })
  }

  const runFullSweep = async (
    expectedLifecycle: number,
    processedRevision: number,
  ): Promise<void> => {
    const activeScope = scope
    const activeIndex = index
    const activeProjector = projector
    const signal = controller?.signal
    if (
      !started ||
      expectedLifecycle !== lifecycle ||
      !activeScope ||
      !activeIndex ||
      !activeProjector ||
      !signal
    ) return
    const existing = new Set(activeIndex.listSources().map(source => resolve(source.path)))
    const seen = new Set<string>()
    const sweepFailures = new Map<string, string>()
    try {
      const discovery = await discoverSources(activeScope, signal, async candidates => {
        for (const candidate of candidates) {
          throwIfAborted(signal)
          seen.add(resolve(candidate.path))
          const result = await activeProjector.projectSource(candidate)
          if (result.kind === 'retry') {
            sweepFailures.set(resolve(candidate.path), result.reason === 'changed-during-read'
              ? 'SEARCH_CONTENT_SOURCE_CHANGED'
              : 'SEARCH_CONTENT_TRANSIENT_IO')
          }
        }
        await yieldToForeground()
      })
      if (discovery.rootMissing && existing.size > 0) {
        // A temporarily unavailable projects root must never turn a populated
        // projection into an authoritative empty result set.
        hasCompleteSweep = false
        discoveryFailureCode = SEARCH_CONTENT_PROJECTS_ROOT_MISSING
      } else if (discovery.complete) {
        for (const stalePath of existing) {
          if (!seen.has(stalePath)) await activeProjector.deleteSource(stalePath)
        }
        hasCompleteSweep = true
        failedPaths = sweepFailures
        discoveryFailureCode = null
      } else {
        for (const [path, code] of sweepFailures) failedPaths.set(path, code)
        discoveryFailureCode = 'SEARCH_CONTENT_DISCOVERY_INCOMPLETE'
      }
    } catch (error) {
      if (signal.aborted || expectedLifecycle !== lifecycle) return
      discoveryFailureCode = errorCode(error, 'SEARCH_CONTENT_DISCOVERY_FAILED')
    }
    finishProjection(expectedLifecycle, processedRevision, [
      ...failedPaths.values(),
      ...(discoveryFailureCode ? [discoveryFailureCode] : []),
    ])
  }

  const runTargeted = async (
    expectedLifecycle: number,
    processedRevision: number,
    paths: string[],
  ): Promise<void> => {
    const activeScope = scope
    const activeIndex = index
    const activeProjector = projector
    const signal = controller?.signal
    if (
      !started ||
      expectedLifecycle !== lifecycle ||
      !activeScope ||
      !activeIndex ||
      !activeProjector ||
      !signal
    ) return
    let recoveredOwner = false
    for (const path of paths) {
      throwIfAborted(signal)
      if (!started || expectedLifecycle !== lifecycle) return
      const normalizedPath = resolve(path)
      try {
        const candidate = await candidateFromPath(activeScope, path)
        let result
        if (candidate) {
          result = await activeProjector.projectSource(candidate)
          const parts = pathParts(activeScope, normalizedPath)
          if (
            parts?.length === 2 &&
            [...failedPaths.values()].includes(SEARCH_CONTENT_OWNER_MISSING)
          ) recoveredOwner = true
        } else {
          const parts = pathParts(activeScope, normalizedPath)
          const dependentSources = parts?.length === 2
            ? activeIndex.listSources().filter(source =>
                resolve(source.ownerTranscriptPath) === normalizedPath &&
                resolve(source.path) !== normalizedPath)
            : []
          result = await activeProjector.deleteSource(normalizedPath)
          for (const dependent of dependentSources) {
            await activeProjector.deleteSource(resolve(dependent.path))
            failedPaths.set(resolve(dependent.path), SEARCH_CONTENT_OWNER_MISSING)
          }
        }
        if (result.kind === 'retry') {
          failedPaths.set(normalizedPath, result.reason === 'changed-during-read'
            ? 'SEARCH_CONTENT_SOURCE_CHANGED'
            : 'SEARCH_CONTENT_TRANSIENT_IO')
        } else {
          failedPaths.delete(normalizedPath)
        }
      } catch (error) {
        if (errorCode(error, '') === SEARCH_CONTENT_OWNER_MISSING) {
          await activeProjector.deleteSource(normalizedPath)
        }
        failedPaths.set(
          normalizedPath,
          errorCode(error, 'SEARCH_CONTENT_RECONCILE_FAILED'),
        )
      }
    }
    if (recoveredOwner) {
      await runFullSweep(expectedLifecycle, processedRevision)
      return
    }
    finishProjection(expectedLifecycle, processedRevision, [
      ...failedPaths.values(),
      ...(discoveryFailureCode ? [discoveryFailureCode] : []),
    ])
  }

  const enqueue = (
    expectedLifecycle: number,
    operation: () => Promise<void>,
  ): Promise<void> => {
    if (!started || expectedLifecycle !== lifecycle) return Promise.resolve()
    const queued = writerQueue.then(operation, operation)
    writerQueue = queued.catch(() => undefined)
    return queued.catch((error) => {
      if (started && expectedLifecycle === lifecycle) {
        status = {
          ...status,
          state: 'degraded',
          lastErrorCode: errorCode(error, 'SEARCH_CONTENT_RECONCILE_FAILED'),
        }
      }
    })
  }

  const stopActive = (options: {
    cancelCorruptionRecovery: boolean
    resetStatus: boolean
  }): Promise<void> => {
    if (options.cancelCorruptionRecovery) corruptionRecoveryToken = undefined
    if (stopPromise) return stopPromise

    lifecycle += 1
    const stopLifecycle = lifecycle
    const pendingStart = startPromise
    const activeController = controller
    const activeWatcher = watcher
    const activeDatabase = database
    const activeIndex = index
    const activeProjector = projector
    const activeScope = scope
    const activeDatabasePath = databasePath
    const activeWriterQueue = writerQueue

    started = false
    dirtyReadinessWrite = undefined
    hasCompleteSweep = false
    activeController?.abort()
    if (controller === activeController) controller = undefined
    if (watcher === activeWatcher) watcher = undefined
    if (database === activeDatabase) database = undefined
    if (index === activeIndex) index = undefined
    if (projector === activeProjector) projector = undefined
    if (scope === activeScope) scope = undefined
    if (databasePath === activeDatabasePath) databasePath = undefined

    const operation = (async (): Promise<void> => {
      await Promise.all([
        pendingStart?.catch(() => undefined),
        stopWatcherOnce(activeWatcher),
        activeWriterQueue.catch(() => undefined),
      ])
      closeDatabaseOnce(activeDatabase)
      if (stopLifecycle !== lifecycle) return
      failedPaths.clear()
      discoveryFailureCode = null
      if (options.resetStatus) status = { ...EMPTY_STATUS }
    })()
    stopPromise = operation
    void operation.then(
      () => {
        if (stopPromise === operation) stopPromise = undefined
      },
      () => {
        if (stopPromise === operation) stopPromise = undefined
      },
    )
    return operation
  }

  const coordinator: SearchContentCoordinator = {
    async start() {
      const pendingStop = stopPromise
      if (pendingStop) await pendingStop
      if (startPromise) return startPromise
      if (started) return
      lifecycle += 1
      const expectedLifecycle = lifecycle
      const operation = (async () => {
        let opened: SearchContentDatabase | undefined
        let activeWatcher: ReconciliationWatcher | undefined
        let activeController: AbortController | undefined
        try {
          const activeScope = resolveScope()
          const resolvedDatabasePath = resolveDatabasePath()
          try {
            opened = openDatabase(resolvedDatabasePath, activeScope)
          } catch (error) {
            if (!isConfirmedLocalIndexCorruption(error)) throw error
            await removeDatabaseFamily(resolvedDatabasePath)
            if (expectedLifecycle !== lifecycle) return
            opened = openDatabase(resolvedDatabasePath, activeScope)
          }
          if (expectedLifecycle !== lifecycle) {
            closeDatabaseOnce(opened)
            return
          }

          const activeDatabase = opened
          const activeIndex = createIndex(activeDatabase, activeScope)
          activeController = new AbortController()
          scope = activeScope
          databasePath = resolvedDatabasePath
          database = activeDatabase
          index = activeIndex
          controller = activeController
          projector = createProjector({
            database: activeDatabase,
            index: activeIndex,
            signal: activeController.signal,
          })
          writerQueue = Promise.resolve()
          status = { ...EMPTY_STATUS }
          started = true
          watcherHealthy = true
          hasCompleteSweep = false
          failedPaths = new Map(activeIndex.listSources()
            .filter(source => source.state === 'degraded')
            .map(source => [resolve(source.path), source.lastErrorCode ?? 'SEARCH_CONTENT_SOURCE_DEGRADED']))
          discoveryFailureCode = null
          dirtyRevision += 1
          activeIndex.setReadiness({
            state: 'building',
            generation: dirtyRevision,
            discovered: activeIndex.countSources(),
            indexed: 0,
          })
          activeWatcher = createWatcher({
            scope: activeScope,
            isTargetPath: isSearchContentJsonlPath,
            onDirty: setBuilding,
            onBatch: async (batch: ReconciliationBatch) => {
              const revision = dirtyRevision
              await enqueue(expectedLifecycle, () => batch.fullSweep
                ? runFullSweep(expectedLifecycle, revision)
                : runTargeted(expectedLifecycle, revision, batch.paths))
            },
            onWatchFailure: () => {
              if (!started || expectedLifecycle !== lifecycle) return
              watcherHealthy = false
              setBuilding()
              status = {
                ...status,
                state: 'degraded',
                lastErrorCode: 'SEARCH_CONTENT_WATCH_FAILED',
              }
            },
            onWatchRecovered: () => {
              if (!started || expectedLifecycle !== lifecycle) return
              watcherHealthy = true
              activeWatcher?.queueFullSweep()
            },
            yieldToForeground,
          })
          watcher = activeWatcher
          await activeWatcher.start()
          if (!started || expectedLifecycle !== lifecycle) return
          const revision = dirtyRevision
          schedule(() => {
            if (!started || expectedLifecycle !== lifecycle) return
            void enqueue(expectedLifecycle, () => runFullSweep(expectedLifecycle, revision))
          })
        } catch (error) {
          activeController?.abort()
          await stopWatcherOnce(activeWatcher)
          await writerQueue.catch(() => undefined)
          closeDatabaseOnce(opened)
          if (database === opened) database = undefined
          if (watcher === activeWatcher) watcher = undefined
          if (controller === activeController) controller = undefined
          if (expectedLifecycle === lifecycle) {
            scope = undefined
            databasePath = undefined
            index = undefined
            projector = undefined
            started = false
            hasCompleteSweep = false
            failedPaths.clear()
            discoveryFailureCode = null
            status = {
              ...status,
              state: 'degraded',
              lastErrorCode: errorCode(error, 'SEARCH_CONTENT_START_FAILED'),
            }
          }
        }
      })()
      startPromise = operation
      void operation.then(
        () => {
          if (startPromise === operation) startPromise = undefined
        },
        () => {
          if (startPromise === operation) startPromise = undefined
        },
      )
      return operation
    },
    async stop() {
      await stopActive({
        cancelCorruptionRecovery: true,
        resetStatus: true,
      })
    },
    suggestSessions(query, options = {}) {
      if (!started || !hasCompleteSweep || status.state !== 'ready' || !index || options.signal?.aborted) return null
      try {
        const result = index.querySessionSuggestions(query, options.limit)
        return options.signal?.aborted ? null : result
      } catch {
        // Suggestions are a disposable projection; never repair or scan
        // transcript files on the keystroke path when SQLite is unavailable.
        return null
      }
    },
    search(query, options = {}) {
      if (
        !started ||
        !hasCompleteSweep ||
        status.state !== 'ready' ||
        !index ||
        options.signal?.aborted
      ) return null
      const { signal, ...queryOptions } = options
      try {
        const result = index.query(query, queryOptions)
        if (signal?.aborted) return null
        return result
      } catch (error) {
        const queryFailureCode = isConfirmedLocalIndexCorruption(error)
          ? 'SQLITE_CORRUPT'
          : errorCode(error, 'SEARCH_CONTENT_QUERY_FAILED')
        status = {
          ...status,
          state: 'degraded',
          lastErrorCode: queryFailureCode,
        }
        if (
          queryFailureCode === 'SQLITE_CORRUPT' &&
          databasePath &&
          !corruptionRecoveryToken
        ) {
          const expectedLifecycle = lifecycle
          const failedDatabasePath = databasePath
          const token = Symbol('search-content-corruption-recovery')
          corruptionRecoveryToken = token
          try {
            schedule(() => {
              void (async () => {
                if (
                  corruptionRecoveryToken !== token ||
                  expectedLifecycle !== lifecycle
                ) return
                await stopActive({
                  cancelCorruptionRecovery: false,
                  resetStatus: false,
                })
                if (corruptionRecoveryToken !== token) return
                await removeDatabaseFamily(failedDatabasePath)
                if (corruptionRecoveryToken !== token) return
                await coordinator.start()
              })().catch((recoveryError) => {
                if (corruptionRecoveryToken !== token) return
                status = {
                  ...status,
                  state: 'degraded',
                  lastErrorCode: errorCode(
                    recoveryError,
                    'SEARCH_CONTENT_CORRUPTION_RECOVERY_FAILED',
                  ),
                }
              }).finally(() => {
                if (corruptionRecoveryToken === token) {
                  corruptionRecoveryToken = undefined
                }
              })
            })
          } catch (scheduleError) {
            corruptionRecoveryToken = undefined
            status = {
              ...status,
              state: 'degraded',
              lastErrorCode: errorCode(
                scheduleError,
                'SEARCH_CONTENT_CORRUPTION_RECOVERY_FAILED',
              ),
            }
          }
        }
        return null
      }
    },
    getStatus() {
      return { ...status }
    },
  }

  return coordinator
}

export const searchContentCoordinator = createSearchContentCoordinator()
