import { lstat, readdir, stat } from 'node:fs/promises'
import { basename, join, relative, resolve, sep } from 'node:path'
import { getClaudeConfigHomeDir } from '../../../utils/envUtils.js'
import {
  getLocalIndexDatabasePath,
  resolveLocalIndexMode,
  type LocalIndexModeResolution,
} from './config.js'
import {
  openLocalIndexDatabase,
  type LocalIndexDatabase,
} from './database.js'
import {
  createSessionIndex,
  type LocalIndexGateway,
  type IndexedSessionRow,
  type IndexedSessionSearchCandidate,
  type PersistedBackfillState,
  type SessionEntryLocatorPage,
  type SessionFileMatch,
  type SessionIndex,
  type SessionIndexPage,
  type SessionSearchCandidateFilters,
} from './sessionIndex.js'
import {
  createSessionProjector,
  SESSION_SUMMARY_PARSER_VERSION,
  type SessionProjector,
  type SessionSourceCandidate,
} from './sessionProjector.js'
import {
  backupLocalIndexDatabaseFamily,
  classifyLocalIndexFailure,
  isConfirmedLocalIndexCorruption,
  type LocalIndexBackupResult,
} from './recovery.js'
import {
  createReconciliationWatcher,
  type ReconciliationBatch,
  type ReconciliationWatcher,
  type ReconciliationWatcherOptions,
} from './reconciliationWatcher.js'
import type { LocalIndexMode, LocalIndexStatus } from './types.js'
import type { ClaudeCodeStats, StatsDateRange } from '../../../utils/stats.js'
import {
  markActivityBackfillBuilding,
  writeActivityBackfillState,
} from './activityIndex.js'

export type LocalIndexSchedulingMetrics = {
  maxBatchSize: number
  yieldCount: number
}

export interface LocalIndexCoordinator extends LocalIndexGateway {
  getSchedulingMetrics(): LocalIndexSchedulingMetrics
  isActivityScopeReady(): boolean
  getActivityStats(range: StatsDateRange, now?: Date): ClaudeCodeStats | null
}

export type SourceDiscoveryResult = {
  complete: boolean
  rootMissing?: boolean
}

export type ActivitySourceCandidate = SessionSourceCandidate & {
  isSubagent: boolean
}

export type ActivitySourceDiscoveryResult = SourceDiscoveryResult & {
  candidates: ActivitySourceCandidate[]
}

export type SourceDiscoveryEmitter = (
  candidates: SessionSourceCandidate[],
) => Promise<void>

export type LocalIndexCoordinatorDependencies = {
  resolveMode?: () => LocalIndexModeResolution
  resolveScope?: () => string
  resolveDatabasePath?: () => string
  openDatabase?: (path: string, scope: string) => LocalIndexDatabase
  createIndex?: (database: LocalIndexDatabase) => SessionIndex
  createProjector?: (options: {
    database: LocalIndexDatabase
    index: SessionIndex
    scope: string
    canCommit: () => boolean
    signal: AbortSignal
  }) => SessionProjector
  discoverSources?: (
    scope: string,
    signal: AbortSignal,
    emit: SourceDiscoveryEmitter,
  ) => Promise<SessionSourceCandidate[] | SourceDiscoveryResult>
  discoverActivitySources?: (
    scope: string,
    signal: AbortSignal,
  ) => Promise<ActivitySourceDiscoveryResult>
  yieldToForeground?: () => Promise<void>
  schedule?: (operation: () => void) => void
  now?: () => number
  batchSize?: number
  createWatcher?: (options: ReconciliationWatcherOptions) => ReconciliationWatcher
  backupDatabaseFamily?: (options: {
    scope: string
    databasePath: string
    reason: 'SQLITE_CORRUPT' | 'MANUAL_REBUILD'
  }) => Promise<LocalIndexBackupResult>
  storageLimitBytes?: number
  busyCooldownMs?: number
}

export const LOCAL_INDEX_STORAGE_LIMIT_BYTES = 512 * 1024 * 1024

const OFF_STATUS: LocalIndexStatus = {
  mode: 'off',
  state: 'off',
  discovered: 0,
  indexed: 0,
  degradedSources: 0,
  databaseBytes: 0,
  walBytes: 0,
  lastUpdatedAt: null,
  lastErrorCode: null,
}

function cloneStatus(status: LocalIndexStatus): LocalIndexStatus {
  return { ...status }
}

function errorCode(error: unknown, fallback: string): string {
  const code = (error as { code?: unknown })?.code
  if (typeof code !== 'string' || !/^[A-Z0-9_-]{1,80}$/.test(code)) {
    return fallback
  }
  if (code.startsWith('SQLITE_') || code === 'LOCAL_INDEX_SCHEMA_UNSUPPORTED') {
    const classified = classifyLocalIndexFailure(error)
    return classified === 'LOCAL_INDEX_START_FAILED' ? fallback : classified
  }
  return code
}

function stableDatabaseError(error: unknown): { code: string } {
  return { code: classifyLocalIndexFailure(error) }
}

function desanitizeProjectPath(projectPath: string): string {
  const windowsDrivePath = projectPath.match(/^([a-zA-Z])--(.+)$/)
  if (windowsDrivePath) {
    return `${windowsDrivePath[1]}:\\${windowsDrivePath[2].replace(/-/g, '\\')}`
  }
  const windowsDriveRoot = projectPath.match(/^([a-zA-Z])--$/)
  if (windowsDriveRoot) return `${windowsDriveRoot[1]}:\\`
  return projectPath.replace(/-/g, sep)
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'ENOENT'
}

async function yieldUnlessAborted(
  operation: () => Promise<void>,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) return
  let onAbort: (() => void) | undefined
  const aborted = new Promise<void>(resolve => {
    onAbort = resolve
    signal.addEventListener('abort', onAbort, { once: true })
  })
  try {
    await Promise.race([operation(), aborted])
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort)
  }
}

export type DiscoveryDirectoryEntry = {
  name: string
  isDirectory(): boolean
  isFile(): boolean
}

export type DiscoveryFileSystem = {
  readdirWithFileTypes(path: string): Promise<DiscoveryDirectoryEntry[]>
  statPath(path: string): ReturnType<typeof stat>
}

const defaultDiscoveryFileSystem: DiscoveryFileSystem = {
  readdirWithFileTypes(path) {
    return readdir(path, { withFileTypes: true })
  },
  statPath(path) {
    return stat(path)
  },
}

export async function discoverTranscriptSources(
  scope: string,
  signal: AbortSignal,
  emit: SourceDiscoveryEmitter,
  fileSystem: DiscoveryFileSystem = defaultDiscoveryFileSystem,
): Promise<SourceDiscoveryResult> {
  const projectsDir = join(scope, 'projects')
  let projectEntries
  try {
    projectEntries = await fileSystem.readdirWithFileTypes(projectsDir)
  } catch (error) {
    if (isMissing(error)) return { complete: true, rootMissing: true }
    throw error
  }

  let candidates: SessionSourceCandidate[] = []
  let complete = true
  const flushCandidates = async (): Promise<void> => {
    if (candidates.length === 0) return
    candidates.sort((left, right) =>
      right.modifiedAtMs - left.modifiedAtMs || left.path.localeCompare(right.path),
    )
    const batch = candidates
    candidates = []
    await emit(batch)
  }
  for (const projectEntry of projectEntries) {
    if (signal.aborted) return { complete: false }
    if (!projectEntry.isDirectory()) continue
    const projectPath = projectEntry.name
    const projectDir = join(projectsDir, projectPath)
    let files
    try {
      files = await fileSystem.readdirWithFileTypes(projectDir)
    } catch (error) {
      if (isMissing(error)) {
        complete = false
        continue
      }
      throw error
    }

    for (const file of files) {
      if (signal.aborted) return { complete: false }
      if (!file.isFile() || !file.name.endsWith('.jsonl')) continue
      const path = join(projectDir, file.name)
      let snapshot
      try {
        snapshot = await fileSystem.statPath(path)
      } catch (error) {
        if (isMissing(error)) {
          complete = false
          continue
        }
        throw error
      }
      candidates.push({
        path,
        sessionId: file.name.slice(0, -'.jsonl'.length),
        projectPath,
        fallbackCreatedAt: snapshot.birthtime.toISOString(),
        fallbackModifiedAt: snapshot.mtime.toISOString(),
        fallbackWorkDir: desanitizeProjectPath(projectPath),
        modifiedAtMs: snapshot.mtimeMs,
      })
      if (candidates.length >= 25) await flushCandidates()
    }
  }
  await flushCandidates()
  return { complete }
}

/**
 * Depth a `subagents/` tree is walked. Plain subagents sit directly under it; a workflow nests
 * them one group directory deeper (`subagents/workflows/<wf_id>/agent-*.jsonl`). The bound keeps
 * an unexpected deep tree from turning discovery into a full filesystem walk.
 */
const SUBAGENT_SCAN_MAX_DEPTH = 3

/**
 * Every `agent-*.jsonl` beneath one session's `subagents/` directory, at any nesting level up to
 * `SUBAGENT_SCAN_MAX_DEPTH`. Walking rather than reading one level is what brings workflow agent
 * transcripts into the index — their tokens and tool calls were previously invisible.
 */
async function collectSubagentPaths(
  directory: string,
  signal: AbortSignal,
  depth = 1,
): Promise<{ complete: boolean; paths: string[] }> {
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch (error) {
    if (isMissing(error)) return { complete: true, paths: [] }
    return { complete: false, paths: [] }
  }

  const paths: string[] = []
  let complete = true
  for (const entry of entries) {
    if (signal.aborted) return { complete: false, paths }
    if (entry.isFile()) {
      if (entry.name.startsWith('agent-') && entry.name.endsWith('.jsonl')) {
        paths.push(join(directory, entry.name))
      }
      continue
    }
    if (!entry.isDirectory() || depth >= SUBAGENT_SCAN_MAX_DEPTH) continue
    const nested = await collectSubagentPaths(join(directory, entry.name), signal, depth + 1)
    if (!nested.complete) complete = false
    paths.push(...nested.paths)
  }
  return { complete, paths }
}

export async function discoverActivityTranscriptSources(
  scope: string,
  signal: AbortSignal,
): Promise<ActivitySourceDiscoveryResult> {
  const projectsDir = join(scope, 'projects')
  let projectEntries
  try {
    projectEntries = await readdir(projectsDir, { withFileTypes: true })
  } catch (error) {
    if (isMissing(error)) {
      return { complete: true, rootMissing: true, candidates: [] }
    }
    throw error
  }

  const candidates: ActivitySourceCandidate[] = []
  let complete = true
  for (const projectEntry of projectEntries) {
    if (signal.aborted) return { complete: false, candidates }
    if (!projectEntry.isDirectory()) continue
    const projectPath = projectEntry.name
    const projectDir = join(projectsDir, projectPath)
    let entries
    try {
      entries = await readdir(projectDir, { withFileTypes: true })
    } catch (error) {
      if (isMissing(error)) {
        complete = false
        continue
      }
      throw error
    }

    for (const entry of entries) {
      if (signal.aborted) return { complete: false, candidates }
      if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        const path = join(projectDir, entry.name)
        try {
          const snapshot = await stat(path)
          candidates.push({
            path,
            sessionId: entry.name.slice(0, -'.jsonl'.length),
            projectPath,
            fallbackCreatedAt: snapshot.birthtime.toISOString(),
            fallbackModifiedAt: snapshot.mtime.toISOString(),
            fallbackWorkDir: desanitizeProjectPath(projectPath),
            modifiedAtMs: snapshot.mtimeMs,
            isSubagent: false,
          })
        } catch (error) {
          if (isMissing(error)) complete = false
          else throw error
        }
        continue
      }
      if (!entry.isDirectory()) continue
      const subagentsDir = join(projectDir, entry.name, 'subagents')
      const found = await collectSubagentPaths(subagentsDir, signal)
      if (!found.complete) complete = false
      for (const path of found.paths) {
        if (signal.aborted) return { complete: false, candidates }
        try {
          const snapshot = await stat(path)
          candidates.push({
            path,
            sessionId: entry.name,
            projectPath,
            fallbackCreatedAt: snapshot.birthtime.toISOString(),
            fallbackModifiedAt: snapshot.mtime.toISOString(),
            fallbackWorkDir: desanitizeProjectPath(projectPath),
            modifiedAtMs: snapshot.mtimeMs,
            isSubagent: true,
          })
        } catch (error) {
          if (isMissing(error)) complete = false
          else throw error
        }
      }
    }
  }
  candidates.sort((left, right) =>
    right.modifiedAtMs - left.modifiedAtMs || left.path.localeCompare(right.path))
  return { complete, candidates }
}

/**
 * The public state describes whether a committed snapshot can be served, not
 * whether a reconciliation happens to be running. `backfill_state.state` only
 * records projection progress, so it cannot answer that; committed rows can.
 * Reopening an index that already has some keeps it servable while the
 * catch-up generation runs, and an empty one stays `building` so an empty page
 * is read as "still loading" rather than "there are no sessions".
 */
function initialBuildingStatus(
  mode: Exclude<LocalIndexMode, 'off'>,
  persisted: PersistedBackfillState | null,
  hasCommittedRows: boolean,
): LocalIndexStatus {
  return {
    mode,
    state: hasCommittedRows ? 'ready' : 'building',
    discovered: persisted?.discovered ?? 0,
    indexed: persisted?.indexed ?? 0,
    degradedSources: persisted?.degraded ?? 0,
    databaseBytes: 0,
    walBytes: 0,
    lastUpdatedAt: persisted
      ? new Date(persisted.updatedAtMs).toISOString()
      : null,
    lastErrorCode: persisted?.lastErrorCode ?? null,
  }
}

export function createLocalIndexCoordinator(
  dependencies: LocalIndexCoordinatorDependencies = {},
): LocalIndexCoordinator {
  const resolveMode = dependencies.resolveMode ?? resolveLocalIndexMode
  const resolveScope = dependencies.resolveScope ?? getClaudeConfigHomeDir
  const resolveDatabasePath = dependencies.resolveDatabasePath ?? getLocalIndexDatabasePath
  const openDatabase = dependencies.openDatabase ?? (
    (path, scope) => openLocalIndexDatabase({ path, scope })
  )
  const createIndex = dependencies.createIndex ?? createSessionIndex
  const createProjector = dependencies.createProjector ?? (
    options => createSessionProjector(options)
  )
  const discoverSources = dependencies.discoverSources ?? discoverTranscriptSources
  const discoverActivitySources = dependencies.discoverActivitySources ??
    discoverActivityTranscriptSources
  const yieldToForeground = dependencies.yieldToForeground ?? (
    () => new Promise<void>(resolve => setTimeout(resolve, 0))
  )
  const schedule = dependencies.schedule ?? queueMicrotask
  const now = dependencies.now ?? Date.now
  const batchSize = Math.max(1, Math.min(25, Math.trunc(dependencies.batchSize ?? 25)))
  const createWatcher = dependencies.createWatcher ?? createReconciliationWatcher
  const backupDatabaseFamily = dependencies.backupDatabaseFamily ?? backupLocalIndexDatabaseFamily
  const storageLimitBytes = Math.max(
    1,
    Math.trunc(dependencies.storageLimitBytes ?? LOCAL_INDEX_STORAGE_LIMIT_BYTES),
  )
  const busyCooldownMs = Math.max(
    1,
    Math.trunc(dependencies.busyCooldownMs ?? 5_000),
  )

  let mode: LocalIndexMode = 'off'
  let status = cloneStatus(OFF_STATUS)
  let database: LocalIndexDatabase | undefined
  let index: SessionIndex | undefined
  let projector: SessionProjector | undefined
  let scope: string | undefined
  let databasePath: string | undefined
  let started = false
  let generation = 0
  let abortController: AbortController | undefined
  let backgroundTask: Promise<void> | undefined
  let writerQueue: Promise<void> = Promise.resolve()
  let watcher: ReconciliationWatcher | undefined
  let watcherHealthy = true
  let storageLimited = false
  let failedPaths = new Map<string, string>()
  let fullSweepFailureCode: string | null = null
  let lifecycleRevision = 0
  let startPromise: Promise<void> | undefined
  let stopPromise: Promise<void> | undefined
  let rebuildPromise: Promise<LocalIndexStatus> | undefined
  let runtimeReconfigurePromise: Promise<void> | undefined
  let databaseFailureCooldownUntil = 0
  let checkpointBusy = false
  let scheduling: LocalIndexSchedulingMetrics = {
    maxBatchSize: 0,
    yieldCount: 0,
  }

  const noteTransientDatabaseBusy = (): void => {
    databaseFailureCooldownUntil = Math.max(
      databaseFailureCooldownUntil,
      now() + busyCooldownMs,
    )
  }

  /**
   * A busy passive checkpoint means some WAL frames are still in use, not that
   * the committed snapshot is unreadable. Remember it so the checkpoint is not
   * retried on every reconciliation, but keep serving reads: cutting them off
   * for the whole cooldown would drop the sidebar back to a full JSONL scan
   * each time a writer happens to be mid-transaction.
   */
  const noteCheckpointBusy = (): void => {
    checkpointBusy = true
    databaseFailureCooldownUntil = Math.max(
      databaseFailureCooldownUntil,
      now() + busyCooldownMs,
    )
  }

  const markDegraded = (error: unknown, fallback: string): void => {
    const code = errorCode(error, fallback)
    if (code === 'SQLITE_BUSY') noteTransientDatabaseBusy()
    const currentStatus = status.mode === mode
      ? status
      : { ...OFF_STATUS, mode }
    status = {
      ...currentStatus,
      state: 'degraded',
      lastErrorCode: code,
      lastUpdatedAt: new Date(now()).toISOString(),
    }
  }

  const latestFailedPathCode = (exceptPath?: string): string | null => {
    let latest: string | null = null
    for (const [path, code] of failedPaths) {
      if (path !== exceptPath) latest = code
    }
    return latest
  }

  const outstandingReconciliationFailures = (): number =>
    failedPaths.size + (fullSweepFailureCode ? 1 : 0)

  const refreshStorageStatus = (activeDatabase: LocalIndexDatabase): void => {
    try {
      const checkpoint = activeDatabase.checkpointPassive?.()
      if (checkpoint && checkpoint.busy > 0) {
        noteCheckpointBusy()
        return
      }
      checkpointBusy = false
      const storage = activeDatabase.getStorageStats?.()
      if (!storage) return
      status = {
        ...status,
        databaseBytes: storage.databaseBytes,
        walBytes: storage.walBytes,
      }
      storageLimited = storage.databaseBytes + storage.walBytes > storageLimitBytes
      if (storageLimited) {
        status = {
          ...status,
          state: 'degraded',
          lastErrorCode: 'LOCAL_INDEX_SIZE_LIMIT',
          lastUpdatedAt: new Date(now()).toISOString(),
        }
      }
    } catch (error) {
      storageLimited = true
      markDegraded(stableDatabaseError(error), 'LOCAL_INDEX_CHECKPOINT_FAILED')
    }
  }

  const enqueueWriter = (
    expectedGeneration: number,
    operation: () => Promise<void>,
  ): Promise<void> => {
    const task = writerQueue.then(async () => {
      if (!started || expectedGeneration !== generation) return
      await operation()
    })
    writerQueue = task.catch(() => undefined)
    backgroundTask = task
    void task.then(
      () => {
        if (backgroundTask === task) backgroundTask = undefined
      },
      () => {
        if (backgroundTask === task) backgroundTask = undefined
      },
    )
    return task
  }

  const candidateFromWatchedPath = async (
    activeScope: string,
    path: string,
  ): Promise<SessionSourceCandidate | null> => {
    const projectsRoot = resolve(activeScope, 'projects')
    const normalizedPath = resolve(path)
    const child = relative(projectsRoot, normalizedPath)
    const parts = child.split(sep)
    if (
      !child ||
      child === '..' ||
      child.startsWith(`..${sep}`) ||
      parts.length !== 2 ||
      !parts[0] ||
      !parts[1] ||
      !parts[1].endsWith('.jsonl') ||
      basename(normalizedPath) !== parts[1]
    ) {
      return null
    }
    const snapshot = await lstat(normalizedPath)
    if (!snapshot.isFile()) return null
    return {
      path: normalizedPath,
      sessionId: parts[1].slice(0, -'.jsonl'.length),
      projectPath: parts[0],
      fallbackCreatedAt: snapshot.birthtime.toISOString(),
      fallbackModifiedAt: snapshot.mtime.toISOString(),
      fallbackWorkDir: desanitizeProjectPath(parts[0]),
      modifiedAtMs: snapshot.mtimeMs,
    }
  }

  const runActivityDiscoveryGeneration = async (
    signal: AbortSignal,
    activeScope: string,
    activeDatabase: LocalIndexDatabase,
    activeIndex: SessionIndex,
    activeProjector: SessionProjector,
    isActiveGeneration: () => boolean,
  ): Promise<void> => {
    if (
      typeof activeIndex.listActivitySources !== 'function' ||
      typeof activeIndex.getActivitySource !== 'function' ||
      typeof activeIndex.getActivityBackfillState !== 'function'
    ) {
      return
    }
    const existingSources = activeIndex.listActivitySources()
    const discovery = await discoverActivitySources(activeScope, signal)
    if (!isActiveGeneration()) return
    const complete = discovery.complete && !(
      discovery.rootMissing && existingSources.length > 0
    )
    const seen = new Set<string>()
    let indexed = 0
    let degraded = 0
    let lastErrorCode: string | null = null

    for (let start = 0; start < discovery.candidates.length; start += batchSize) {
      if (!isActiveGeneration()) return
      const batch = discovery.candidates.slice(start, start + batchSize)
      for (const candidate of batch) {
        if (!isActiveGeneration()) return
        seen.add(candidate.path)
        try {
          if (candidate.isSubagent) {
            const result = await activeProjector.projectActivitySource(candidate)
            if (result.kind === 'retry') {
              degraded += 1
              lastErrorCode = result.reason === 'changed-during-read'
                ? 'LOCAL_INDEX_ACTIVITY_SOURCE_CHANGED'
                : 'LOCAL_INDEX_ACTIVITY_TRANSIENT_IO'
              continue
            }
          } else if (!activeIndex.getActivitySource(candidate.path)) {
            degraded += 1
            lastErrorCode = 'LOCAL_INDEX_ACTIVITY_MAIN_MISSING'
            continue
          }
          indexed += 1
        } catch (error) {
          degraded += 1
          lastErrorCode = errorCode(error, 'LOCAL_INDEX_ACTIVITY_PROJECT_FAILED')
        }
      }
      if (start + batch.length < discovery.candidates.length) {
        scheduling.yieldCount += 1
        await yieldUnlessAborted(yieldToForeground, signal)
      }
    }

    if (complete) {
      for (const source of existingSources) {
        if (!isActiveGeneration() || seen.has(source.path)) continue
        const result = await activeProjector.deleteActivitySource(source.path)
        if (result.kind === 'retry') {
          degraded += 1
          lastErrorCode = 'LOCAL_INDEX_ACTIVITY_DELETE_FAILED'
        }
      }
    } else {
      degraded += 1
      lastErrorCode = lastErrorCode ?? 'LOCAL_INDEX_ACTIVITY_DISCOVERY_INCOMPLETE'
    }
    if (!isActiveGeneration()) return

    const discovered = discovery.candidates.length
    activeDatabase.transaction(operation => {
      writeActivityBackfillState(operation, {
        scope: activeScope,
        state: complete && degraded === 0 && indexed === discovered
          ? 'ready'
          : 'degraded',
        watermark: discovery.candidates.at(-1)?.path ?? null,
        discovered,
        indexed,
        degraded,
        lastErrorCode,
        updatedAtMs: now(),
      })
    })
  }

  const runDiscoveryGeneration = async (
    expectedGeneration: number,
    signal: AbortSignal,
    activeScope: string,
    activeDatabase: LocalIndexDatabase,
    activeIndex: SessionIndex,
    activeProjector: SessionProjector,
  ): Promise<void> => {
    const isActiveGeneration = (): boolean =>
      !signal.aborted &&
      started &&
      expectedGeneration === generation &&
      activeScope === scope &&
      activeDatabase === database &&
      activeIndex === index &&
      activeProjector === projector
    if (!isActiveGeneration()) return
    refreshStorageStatus(activeDatabase)
    if (storageLimited) return
    const existingSources = activeIndex.listSources()
    const existingPaths = new Set(existingSources.map(source => source.path))
    const seenPaths = new Set<string>()
    const knownPaths = new Set(existingPaths)
    const committedPaths = new Set(existingPaths)
    const sweepFailedPaths = new Map<string, string>()
    let genericFailureCount = 0
    let genericFailureCode: string | null = null
    let degraded = 0

    status = {
      ...status,
      // A catch-up over an already-served snapshot is not a rebuild. Keep
      // serving it while this generation runs; only a snapshot that never
      // finished (or one with rows still unaccounted for) is `building`.
      state: outstandingReconciliationFailures() > 0
        ? 'degraded'
        : status.state === 'ready'
          ? 'ready'
          : 'building',
      // A new discovery generation resets to rows that are actually persisted.
      // From this point both counters only move forward until the generation ends.
      discovered: knownPaths.size,
      indexed: committedPaths.size,
      degradedSources: outstandingReconciliationFailures(),
      lastErrorCode: latestFailedPathCode() ?? fullSweepFailureCode,
    }

    const recordFailure = (code: string, path?: string): void => {
      if (path) sweepFailedPaths.set(resolve(path), code)
      else {
        genericFailureCount += 1
        genericFailureCode = code
      }
      degraded = sweepFailedPaths.size + genericFailureCount
      const pendingPaths = new Set([
        ...failedPaths.keys(),
        ...sweepFailedPaths.keys(),
      ])
      status = {
        ...status,
        state: 'degraded',
        degradedSources: pendingPaths.size + genericFailureCount +
          (fullSweepFailureCode ? 1 : 0),
        lastErrorCode: code,
      }
    }

    const processCandidateBatch = async (
      input: SessionSourceCandidate[],
      yieldAfterFinalBatch: boolean,
    ): Promise<void> => {
      if (!isActiveGeneration()) return
      const unique = input
        .filter(candidate => {
          if (seenPaths.has(candidate.path)) return false
          seenPaths.add(candidate.path)
          knownPaths.add(candidate.path)
          return true
        })
        .sort((left, right) =>
          right.modifiedAtMs - left.modifiedAtMs || left.path.localeCompare(right.path),
        )
      status = {
        ...status,
        discovered: knownPaths.size,
      }

      for (let batchStart = 0; batchStart < unique.length; batchStart += batchSize) {
        if (!isActiveGeneration()) return
        const batch = unique.slice(batchStart, batchStart + batchSize)
        scheduling.maxBatchSize = Math.max(scheduling.maxBatchSize, batch.length)
        for (const candidate of batch) {
          if (!isActiveGeneration()) return
          const alreadyCommitted = committedPaths.has(candidate.path)
          const targetIndexed = alreadyCommitted
            ? committedPaths.size
            : committedPaths.size + 1
          try {
            const result = await activeProjector.projectSource(candidate, {
              state: 'building',
              discovered: targetIndexed,
              indexed: targetIndexed,
              degraded,
              lastErrorCode: status.lastErrorCode,
            })
            if (!isActiveGeneration()) return
            if (result.kind === 'retry') {
              recordFailure(result.reason === 'changed-during-read'
                ? 'LOCAL_INDEX_SOURCE_CHANGED'
                : 'LOCAL_INDEX_TRANSIENT_IO', candidate.path)
            } else {
              committedPaths.add(candidate.path)
              status = {
                ...status,
                indexed: committedPaths.size,
              }
            }
          } catch (error) {
            if (!isActiveGeneration()) return
            recordFailure(
              errorCode(error, 'LOCAL_INDEX_PROJECT_FAILED'),
              candidate.path,
            )
          }
        }

        const hasAnotherBatch = batchStart + batch.length < unique.length
        if (hasAnotherBatch || yieldAfterFinalBatch) {
          scheduling.yieldCount += 1
          await yieldUnlessAborted(yieldToForeground, signal)
          if (!isActiveGeneration()) return
        }
      }
    }

    const processDeletes = async (paths: string[]): Promise<void> => {
      if (!isActiveGeneration()) return
      for (let batchStart = 0; batchStart < paths.length; batchStart += batchSize) {
        if (!isActiveGeneration()) return
        const batch = paths.slice(batchStart, batchStart + batchSize)
        scheduling.maxBatchSize = Math.max(scheduling.maxBatchSize, batch.length)
        for (const path of batch) {
          if (!isActiveGeneration()) return
          try {
            const result = await activeProjector.deleteSource(path, {
              state: 'building',
              discovered: knownPaths.size,
              // A confirmed deletion is completed reconciliation work. Keep the
              // generation counter monotonic even though live row count falls.
              indexed: Math.max(status.indexed, committedPaths.size),
              degraded,
              lastErrorCode: status.lastErrorCode,
            })
            if (!isActiveGeneration()) return
            if (result.kind === 'retry') {
              recordFailure(result.reason === 'changed-during-read'
                ? 'LOCAL_INDEX_SOURCE_CHANGED'
                : 'LOCAL_INDEX_TRANSIENT_IO', path)
            }
          } catch (error) {
            if (!isActiveGeneration()) return
            recordFailure(errorCode(error, 'LOCAL_INDEX_DELETE_FAILED'), path)
          }
        }
        if (batchStart + batch.length < paths.length) {
          scheduling.yieldCount += 1
          await yieldUnlessAborted(yieldToForeground, signal)
          if (!isActiveGeneration()) return
        }
      }
    }

    try {
      let emitted = false
      const discoveryResult = await discoverSources(
        activeScope,
        signal,
        async candidates => {
          emitted = true
          await processCandidateBatch(candidates, true)
        },
      )
      if (!isActiveGeneration()) return

      const complete = Array.isArray(discoveryResult)
        ? true
        : discoveryResult.complete && !(
          discoveryResult.rootMissing && existingSources.length > 0
        )
      if (Array.isArray(discoveryResult)) {
        await processCandidateBatch(discoveryResult, false)
        if (!isActiveGeneration()) return
      } else if (!emitted && !complete) {
        recordFailure('LOCAL_INDEX_DISCOVERY_INCOMPLETE')
      }

      if (!isActiveGeneration()) return
      if (complete) {
        await processDeletes(existingSources
          .filter(source => !seenPaths.has(source.path))
          .map(source => source.path))
        if (!isActiveGeneration()) return
      } else if (degraded === 0) {
        recordFailure('LOCAL_INDEX_DISCOVERY_INCOMPLETE')
      }

      if (complete) {
        failedPaths = sweepFailedPaths
        fullSweepFailureCode = genericFailureCode
      } else {
        for (const [path, code] of sweepFailedPaths) failedPaths.set(path, code)
        fullSweepFailureCode = genericFailureCode ?? 'LOCAL_INDEX_DISCOVERY_INCOMPLETE'
      }
      try {
        await runActivityDiscoveryGeneration(
          signal,
          activeScope,
          activeDatabase,
          activeIndex,
          activeProjector,
          isActiveGeneration,
        )
      } catch (error) {
        if (isActiveGeneration()) {
          activeDatabase.transaction(operation => {
            writeActivityBackfillState(operation, {
              scope: activeScope,
              state: 'degraded',
              discovered: 0,
              indexed: 0,
              degraded: 1,
              lastErrorCode: errorCode(
                error,
                'LOCAL_INDEX_ACTIVITY_DISCOVERY_FAILED',
              ),
              updatedAtMs: now(),
            })
          })
        }
      }
      if (!isActiveGeneration()) return
      const outstandingFailures = outstandingReconciliationFailures()
      status = {
        ...status,
        state: outstandingFailures === 0 && watcherHealthy ? 'ready' : 'degraded',
        degradedSources: outstandingFailures,
        lastErrorCode: latestFailedPathCode() ?? fullSweepFailureCode ??
          (watcherHealthy ? null : 'LOCAL_INDEX_WATCH_FAILED'),
        lastUpdatedAt: new Date(now()).toISOString(),
      }
      refreshStorageStatus(activeDatabase)
    } catch (error) {
      if (
        isActiveGeneration()
      ) {
        fullSweepFailureCode = errorCode(error, 'LOCAL_INDEX_DISCOVERY_FAILED')
        markDegraded({ code: fullSweepFailureCode }, 'LOCAL_INDEX_DISCOVERY_FAILED')
      }
    }
  }

  const runTargetedReconciliation = async (
    expectedGeneration: number,
    signal: AbortSignal,
    activeScope: string,
    activeDatabase: LocalIndexDatabase,
    activeIndex: SessionIndex,
    activeProjector: SessionProjector,
    paths: string[],
  ): Promise<void> => {
    const isActiveGeneration = (): boolean =>
      !signal.aborted &&
      started &&
      expectedGeneration === generation &&
      activeScope === scope &&
      activeDatabase === database &&
      activeIndex === index &&
      activeProjector === projector
    if (!isActiveGeneration()) return
    refreshStorageStatus(activeDatabase)
    if (storageLimited) return
    status = {
      ...status,
      // Reconciling a watched batch never withdraws a snapshot that is already
      // being served. `building` is reserved for the first generation, before
      // any complete snapshot exists.
      state: outstandingReconciliationFailures() > 0
        ? 'degraded'
        : status.state === 'building'
          ? 'building'
          : 'ready',
      degradedSources: outstandingReconciliationFailures(),
      lastErrorCode: latestFailedPathCode() ?? fullSweepFailureCode,
    }

    for (const path of paths) {
      if (!isActiveGeneration()) return
      const normalizedPath = resolve(path)
      const existing = activeIndex.getSource(normalizedPath)
      const remainingFailureCount = failedPaths.size -
        (failedPaths.has(normalizedPath) ? 1 : 0) +
        (fullSweepFailureCode ? 1 : 0)
      const remainingFailureCode = latestFailedPathCode(normalizedPath) ??
        fullSweepFailureCode
      try {
        let candidate: SessionSourceCandidate | null
        try {
          candidate = await candidateFromWatchedPath(activeScope, path)
        } catch (error) {
          if (!isMissing(error)) throw error
          candidate = null
        }
        if (!isActiveGeneration()) return
        if (!candidate) {
          if (existing) {
            const deleted = await activeProjector.deleteSource(normalizedPath, {
              state: remainingFailureCount > 0 ? 'degraded' : 'building',
              discovered: status.discovered,
              indexed: status.indexed,
              degraded: remainingFailureCount,
              lastErrorCode: remainingFailureCode,
            })
            if (deleted.kind === 'retry') {
              throw { code: deleted.reason === 'changed-during-read'
                ? 'LOCAL_INDEX_SOURCE_CHANGED'
                : 'LOCAL_INDEX_TRANSIENT_IO' }
            }
          }
          failedPaths.delete(normalizedPath)
          continue
        }
        const projected = await activeProjector.projectSource(candidate, {
          state: remainingFailureCount > 0 ? 'degraded' : 'building',
          discovered: Math.max(status.discovered, activeIndex.countSources() + (existing ? 0 : 1)),
          indexed: Math.max(status.indexed, activeIndex.countSources() + (existing ? 0 : 1)),
          degraded: remainingFailureCount,
          lastErrorCode: remainingFailureCode,
        })
        if (projected.kind === 'retry') {
          throw { code: projected.reason === 'changed-during-read'
            ? 'LOCAL_INDEX_SOURCE_CHANGED'
            : 'LOCAL_INDEX_TRANSIENT_IO' }
        }
        failedPaths.delete(normalizedPath)
      } catch (error) {
        if (!isActiveGeneration()) return
        failedPaths.set(
          normalizedPath,
          errorCode(error, 'LOCAL_INDEX_RECONCILE_FAILED'),
        )
      }
    }
    if (!isActiveGeneration()) return
    const count = activeIndex.countSources()
    const outstandingFailures = outstandingReconciliationFailures()
    status = {
      ...status,
      state: outstandingFailures === 0 && watcherHealthy ? 'ready' : 'degraded',
      discovered: count,
      indexed: count,
      degradedSources: outstandingFailures,
      lastErrorCode: latestFailedPathCode() ?? fullSweepFailureCode ??
        (watcherHealthy ? null : 'LOCAL_INDEX_WATCH_FAILED'),
      lastUpdatedAt: new Date(now()).toISOString(),
    }
    refreshStorageStatus(activeDatabase)
  }

  const runStart = async (expectedLifecycle: number): Promise<void> => {
    const pendingStop = stopPromise
    if (pendingStop) await pendingStop
    if (expectedLifecycle !== lifecycleRevision) return
    let openedDatabase: LocalIndexDatabase | undefined
    try {
      const resolution = resolveMode()
      mode = resolution.mode
      if (mode === 'off') {
        status = {
          ...OFF_STATUS,
          lastErrorCode: resolution.warningCode,
        }
        return
      }
      status = {
        ...OFF_STATUS,
        mode,
        state: 'building',
      }
      const resolvedScope = resolveScope()
      const resolvedDatabasePath = resolveDatabasePath()
      try {
        openedDatabase = openDatabase(resolvedDatabasePath, resolvedScope)
      } catch (error) {
        if (!isConfirmedLocalIndexCorruption(error)) throw stableDatabaseError(error)
        await backupDatabaseFamily({
          scope: resolvedScope,
          databasePath: resolvedDatabasePath,
          reason: 'SQLITE_CORRUPT',
        })
        if (expectedLifecycle !== lifecycleRevision) return
        openedDatabase = openDatabase(resolvedDatabasePath, resolvedScope)
      }
      if (expectedLifecycle !== lifecycleRevision) {
        openedDatabase.close()
        return
      }
      const activeDatabase = openedDatabase
      const activeIndex = createIndex(activeDatabase)
      const persisted = activeIndex.getBackfillState(resolvedScope)
      // A parser upgrade makes persisted activity aggregates semantically stale. Invalidate their
      // readiness before exposing the index so reads fall back until the rebuild finishes.
      if (
        typeof activeIndex.getActivityBackfillState === 'function' &&
        typeof activeIndex.listActivitySources === 'function'
      ) {
        const persistedActivity = activeIndex.getActivityBackfillState(resolvedScope)
        const parserUpgradePending = persistedActivity?.state === 'ready' &&
          activeIndex.listActivitySources().some(source =>
            source.parserVersion !== SESSION_SUMMARY_PARSER_VERSION)
        if (parserUpgradePending) {
          activeDatabase.transaction(operation => {
            markActivityBackfillBuilding(operation, resolvedScope, now())
          })
        }
      }
      scope = resolvedScope
      databasePath = resolvedDatabasePath
      database = activeDatabase
      index = activeIndex
      generation += 1
      const expectedGeneration = generation
      const controller = new AbortController()
      abortController = controller
      projector = createProjector({
        database: activeDatabase,
        index: activeIndex,
        scope: resolvedScope,
        signal: controller.signal,
        canCommit: () =>
          started &&
          generation === expectedGeneration &&
          expectedLifecycle === lifecycleRevision &&
          !controller.signal.aborted &&
          database === activeDatabase &&
          index === activeIndex &&
          scope === resolvedScope,
      })
      const activeProjector = projector
      failedPaths = new Map(activeIndex.listSources()
        .filter(source => source.state === 'degraded')
        .map(source => [
          resolve(source.path),
          source.lastErrorCode ?? 'SOURCE_PARSE_DEGRADED',
        ]))
      fullSweepFailureCode = persisted?.state === 'degraded' && failedPaths.size === 0
        ? persisted.lastErrorCode ?? 'LOCAL_INDEX_DISCOVERY_INCOMPLETE'
        : null
      status = initialBuildingStatus(mode, persisted, activeIndex.countSources() > 0)
      if (outstandingReconciliationFailures() > 0) {
        status = {
          ...status,
          state: 'degraded',
          degradedSources: outstandingReconciliationFailures(),
          lastErrorCode: latestFailedPathCode() ?? fullSweepFailureCode,
        }
      }
      started = true
      databaseFailureCooldownUntil = 0
      writerQueue = Promise.resolve()
      watcherHealthy = true
      storageLimited = false
      scheduling = { maxBatchSize: 0, yieldCount: 0 }
      const activeWatcher = createWatcher({
        scope: resolvedScope,
        yieldToForeground,
        onBatch: async (batch: ReconciliationBatch) => {
          await enqueueWriter(expectedGeneration, () => batch.fullSweep
            ? runDiscoveryGeneration(
              expectedGeneration,
              controller.signal,
              resolvedScope,
              activeDatabase,
              activeIndex,
              activeProjector,
            )
            : runTargetedReconciliation(
              expectedGeneration,
              controller.signal,
              resolvedScope,
              activeDatabase,
              activeIndex,
              activeProjector,
              batch.paths,
            ))
        },
        onWatchFailure: code => {
          if (!started || expectedGeneration !== generation) return
          watcherHealthy = false
          markDegraded({ code }, code)
        },
        onWatchRecovered: () => {
          if (!started || expectedGeneration !== generation) return
          watcherHealthy = true
          activeWatcher.queueFullSweep()
        },
      })
      watcher = activeWatcher
      void activeWatcher.start().catch(() => {
        if (!started || expectedGeneration !== generation) return
        watcherHealthy = false
        markDegraded({ code: 'LOCAL_INDEX_WATCH_FAILED' }, 'LOCAL_INDEX_WATCH_FAILED')
      })
      refreshStorageStatus(activeDatabase)
      schedule(() => {
        const task = enqueueWriter(expectedGeneration, () => runDiscoveryGeneration(
          expectedGeneration,
          controller.signal,
          resolvedScope,
          activeDatabase,
          activeIndex,
          activeProjector,
        ))
        void task.catch(error => {
          if (expectedGeneration === generation && started) {
            markDegraded(error, 'LOCAL_INDEX_START_FAILED')
          }
        })
      })
    } catch (error) {
      try {
        openedDatabase?.close()
      } catch {
        // Preserve the startup failure code.
      }
      if (expectedLifecycle !== lifecycleRevision) return
      if (database === openedDatabase) {
        database = undefined
        index = undefined
        projector = undefined
        scope = undefined
        databasePath = undefined
      }
      started = false
      markDegraded(stableDatabaseError(error), 'LOCAL_INDEX_START_FAILED')
    }
  }

  const beginStart = (expectedLifecycle: number): Promise<void> => {
    if (startPromise) return startPromise
    const operation = runStart(expectedLifecycle)
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
  }

  const stopActive = (): Promise<void> => {
    if (stopPromise) return stopPromise
    const operation = (async (): Promise<void> => {
      const pendingStart = startPromise
      const activeController = abortController
      const activeTask = backgroundTask
      const activeWriterQueue = writerQueue
      const activeWatcher = watcher
      const activeDatabase = database
      const activeIndex = index
      const activeProjector = projector
      const activeScope = scope
      const activeDatabasePath = databasePath
      generation += 1
      started = false
      const watcherStop = activeWatcher?.stop()
      activeController?.abort()
      if (abortController === activeController) abortController = undefined
      if (backgroundTask === activeTask) backgroundTask = undefined
      if (watcher === activeWatcher) watcher = undefined
      if (database === activeDatabase) database = undefined
      if (index === activeIndex) index = undefined
      if (projector === activeProjector) projector = undefined
      if (scope === activeScope) scope = undefined
      if (databasePath === activeDatabasePath) databasePath = undefined
      await Promise.all([
        pendingStart?.catch(() => undefined),
        watcherStop?.catch(() => undefined),
        activeTask?.catch(() => undefined),
        activeWriterQueue.catch(() => undefined),
      ])
      activeDatabase?.close()
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

  const beginRuntimeReconfiguration = (
    resolution: LocalIndexModeResolution,
  ): void => {
    if (runtimeReconfigurePromise) return
    lifecycleRevision += 1
    const expectedLifecycle = lifecycleRevision
    mode = resolution.mode
    status = resolution.mode === 'off'
      ? { ...OFF_STATUS, lastErrorCode: resolution.warningCode }
      : { ...OFF_STATUS, mode: resolution.mode, state: 'building' }
    const operation = (async () => {
      await stopActive()
      if (
        expectedLifecycle !== lifecycleRevision ||
        resolution.mode === 'off'
      ) return
      await beginStart(expectedLifecycle)
    })()
    runtimeReconfigurePromise = operation
    void operation.then(
      () => {
        if (runtimeReconfigurePromise === operation) {
          runtimeReconfigurePromise = undefined
        }
      },
      () => {
        if (runtimeReconfigurePromise === operation) {
          runtimeReconfigurePromise = undefined
        }
      },
    )
  }

  const synchronizeRuntimeConfiguration = (): boolean => {
    const resolution = resolveMode()
    if (runtimeReconfigurePromise) return false
    if (!started) {
      if (resolution.mode === 'off' && mode !== 'off') {
        mode = 'off'
        status = { ...OFF_STATUS, lastErrorCode: resolution.warningCode }
      }
      return resolution.mode === mode
    }

    const configurationChanged = resolution.mode !== mode || (
      resolution.mode !== 'off' && (
        resolveScope() !== scope ||
        resolveDatabasePath() !== databasePath
      )
    )
    if (!configurationChanged) return true
    beginRuntimeReconfiguration(resolution)
    return false
  }

  const indexReadAllowed = (): boolean =>
    synchronizeRuntimeConfiguration() &&
    (checkpointBusy || now() >= databaseFailureCooldownUntil)

  const coordinator: LocalIndexCoordinator = {
    async start(): Promise<void> {
      if (started) {
        if (synchronizeRuntimeConfiguration()) return
        await runtimeReconfigurePromise
        return
      }
      if (runtimeReconfigurePromise) {
        await runtimeReconfigurePromise
        return
      }
      if (startPromise) return startPromise
      if (rebuildPromise) {
        await rebuildPromise
        return
      }
      lifecycleRevision += 1
      await beginStart(lifecycleRevision)
    },

    async stop(): Promise<void> {
      lifecycleRevision += 1
      const pendingRebuild = rebuildPromise
      const pendingReconfigure = runtimeReconfigurePromise
      await stopActive()
      await Promise.all([
        pendingRebuild?.catch(() => undefined),
        pendingReconfigure?.catch(() => undefined),
      ])
    },

    getMode(): LocalIndexMode {
      synchronizeRuntimeConfiguration()
      return mode
    },

    getPublicStatus(): LocalIndexStatus {
      synchronizeRuntimeConfiguration()
      return cloneStatus(status)
    },

    isSessionScopeReady(): boolean {
      if (
        !indexReadAllowed() ||
        !index ||
        status.state === 'degraded' ||
        status.state === 'off'
      ) return false
      if (status.state === 'ready') return true
      try {
        return index.listSessions({ limit: 1 }).total > 0
      } catch (error) {
        markDegraded(error, 'LOCAL_INDEX_READ_FAILED')
        return false
      }
    },

    isActivityScopeReady(): boolean {
      if (
        !indexReadAllowed() ||
        !index ||
        !scope ||
        mode === 'off' ||
        !watcherHealthy ||
        storageLimited ||
        outstandingReconciliationFailures() > 0
      ) {
        return false
      }
      try {
        const activity = index.getActivityBackfillState(scope)
        return activity?.state === 'ready' &&
          activity.degraded === 0 &&
          activity.discovered === activity.indexed
      } catch {
        return false
      }
    },

    getActivityStats(
      range: StatsDateRange,
      queryNow?: Date,
    ): ClaudeCodeStats | null {
      if (
        !indexReadAllowed() ||
        !index ||
        !coordinator.isActivityScopeReady()
      ) return null
      try {
        return index.aggregateActivity(range, queryNow)
      } catch {
        return null
      }
    },

    listSessions(options): SessionIndexPage {
      if (!indexReadAllowed() || !index) return { sessions: [], total: 0 }
      try {
        return index.listSessions(options)
      } catch (error) {
        markDegraded(error, 'LOCAL_INDEX_READ_FAILED')
        return { sessions: [], total: 0 }
      }
    },

    getSessionSuggestionMetadata(sessionIds) {
      if (!indexReadAllowed() || !index?.getSessionSuggestionMetadata) return null
      try { return index.getSessionSuggestionMetadata(sessionIds) }
      catch (error) { markDegraded(error, 'LOCAL_INDEX_READ_FAILED'); return null }
    },

    searchSessionMetadata(query, options): SessionIndexPage | null {
      if (!indexReadAllowed() || !index?.searchSessionMetadata) return null
      try { return index.searchSessionMetadata(query, options) }
      catch (error) { markDegraded(error, 'LOCAL_INDEX_READ_FAILED'); return null }
    },

    findSearchCandidates(
      filters: SessionSearchCandidateFilters,
    ): IndexedSessionSearchCandidate[] | null {
      if (!indexReadAllowed() || !index?.findSearchCandidates) return null
      try {
        return index.findSearchCandidates(filters)
      } catch (error) {
        markDegraded(error, 'LOCAL_INDEX_READ_FAILED')
        return null
      }
    },

    findSessionFiles(sessionId: string): SessionFileMatch[] {
      if (!indexReadAllowed() || !index) return []
      try {
        return index.findSessionFiles(sessionId)
      } catch (error) {
        markDegraded(error, 'LOCAL_INDEX_READ_FAILED')
        return []
      }
    },

    getSession(sessionId: string): IndexedSessionRow | null {
      if (!indexReadAllowed() || !index?.getSession) return null
      try {
        return index.getSession(sessionId)
      } catch (error) {
        markDegraded(error, 'LOCAL_INDEX_READ_FAILED')
        return null
      }
    },

    updateSessionTitle(sessionId: string, title: string): boolean {
      if (!synchronizeRuntimeConfiguration() || !index?.updateSessionTitle) return false
      try {
        return index.updateSessionTitle(sessionId, title)
      } catch (error) {
        markDegraded(error, 'LOCAL_INDEX_TITLE_WRITE_FAILED')
        return false
      }
    },

    getSessionEntryLocators(
      transcriptPath: string,
      entryTypes?: string[],
    ): SessionEntryLocatorPage | null {
      if (!indexReadAllowed() || !index) return null
      try {
        return index.getSessionEntryLocators(transcriptPath, entryTypes)
      } catch (error) {
        markDegraded(error, 'LOCAL_INDEX_READ_FAILED')
        return null
      }
    },

    async rebuild(): Promise<LocalIndexStatus> {
      if (rebuildPromise) return rebuildPromise
      lifecycleRevision += 1
      const expectedLifecycle = lifecycleRevision
      const operation = (async (): Promise<LocalIndexStatus> => {
        const requestedMode = resolveMode()
        const activeScope = scope
        const activePath = database ? databasePath : undefined
        await stopActive()
        if (expectedLifecycle !== lifecycleRevision) {
          return coordinator.getPublicStatus()
        }
        if (requestedMode.mode === 'off') {
          mode = 'off'
          status = {
            ...OFF_STATUS,
            lastErrorCode: requestedMode.warningCode,
          }
          return coordinator.getPublicStatus()
        }
        const targetScope = activeScope ?? resolveScope()
        const targetPath = activePath ?? resolveDatabasePath()
        try {
          await backupDatabaseFamily({
            scope: targetScope,
            databasePath: targetPath,
            reason: 'MANUAL_REBUILD',
          })
          if (expectedLifecycle !== lifecycleRevision) {
            return coordinator.getPublicStatus()
          }
          await beginStart(expectedLifecycle)
        } catch (error) {
          if (expectedLifecycle !== lifecycleRevision) {
            return coordinator.getPublicStatus()
          }
          mode = requestedMode.mode
          markDegraded(stableDatabaseError(error), 'LOCAL_INDEX_REBUILD_FAILED')
        }
        return coordinator.getPublicStatus()
      })()
      rebuildPromise = operation
      try {
        return await operation
      } finally {
        if (rebuildPromise === operation) rebuildPromise = undefined
      }
    },

    getSchedulingMetrics(): LocalIndexSchedulingMetrics {
      return { ...scheduling }
    },
  }

  return coordinator
}

// Construction is intentionally side-effect free. The active config scope and
// database path are resolved only when start() is called after Bun.serve().
export const localIndexCoordinator = createLocalIndexCoordinator()
