import { open, stat } from 'node:fs/promises'
import { statSync, type Stats } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import type { LocalIndexDatabase, LocalIndexWriteOperation } from './database.js'
import { writeActivityProjection } from './activityIndex.js'
import {
  SourceReadRetryError,
  type FileReaderIo,
  type LocalIndexIoMetrics,
  type ReadonlyFileHandle,
} from './fileReader.js'
import type { SessionIndex } from './sessionIndex.js'
import {
  captureSourceFingerprint,
  deserializeSourceFingerprint,
  detectSourceChange,
  serializeSourceFingerprint,
  verifySourceFingerprint,
  type SourceChange,
  type SourceFingerprint,
} from './sourceFingerprint.js'
import {
  TranscriptRebuildRequiredError,
  reduceTranscriptWithLocators,
} from './transcriptReducer.js'
import type {
  TranscriptChunk,
  TranscriptEntryLocator,
  TranscriptProjection,
} from './types.js'

// Bump whenever the reducer's output changes for input it has already seen: a mismatch against a
// source's stored version makes `detectSourceChange` return `rebuild`, which is the only thing
// that refreshes already-indexed transcripts.
// 3: usage is deduplicated per (message.id, requestId), and sessions carry active working time.
// 4: usage copied into a fork is excluded from the fork's activity projection.
export const SESSION_SUMMARY_PARSER_VERSION = 4

export type SessionSourceCandidate = {
  path: string
  sessionId: string
  projectPath: string
  fallbackCreatedAt: string
  fallbackModifiedAt: string
  fallbackWorkDir: string | null
  modifiedAtMs: number
}

export type ProjectionProgress = {
  state?: 'building' | 'ready' | 'degraded'
  discovered: number
  indexed: number
  degraded?: number
  lastErrorCode?: string | null
}

export type ProjectionWork = {
  maxBufferedChunks: number
  maxBufferedBytes: number
}

export type SessionProjectResult =
  | {
    kind: 'indexed'
    action: 'full' | 'append' | 'rebuild' | 'unchanged'
    projection: TranscriptProjection
    work: ProjectionWork
  }
  | { kind: 'deleted' }
  | Extract<SourceChange, { kind: 'retry' }>

export interface SessionProjector {
  projectSource(
    candidate: SessionSourceCandidate,
    progress?: ProjectionProgress,
  ): Promise<SessionProjectResult>
  deleteSource(
    path: string,
    progress?: ProjectionProgress,
  ): Promise<{ kind: 'deleted' } | Extract<SourceChange, { kind: 'retry' }>>
  projectActivitySource(
    candidate: SessionSourceCandidate,
  ): Promise<SessionProjectResult>
  deleteActivitySource(
    path: string,
  ): Promise<{ kind: 'deleted' } | Extract<SourceChange, { kind: 'retry' }>>
}

export type SessionProjectorOptions = {
  database: LocalIndexDatabase
  index: SessionIndex
  scope: string
  parserVersion?: number
  now?: () => number
  fileIo?: FileReaderIo
  metrics?: LocalIndexIoMetrics
  verifyFingerprint?: typeof verifySourceFingerprint
  beforeSessionUpsert?: () => void
  syncStat?: (path: string) => {
    size: number
    mtimeMs: number
    ctimeMs: number
    dev: number | bigint
    ino: number | bigint
  }
  sourceMetadataStat?: (path: string) => Promise<Pick<
    Stats,
    'size' | 'mtimeMs' | 'ctimeMs' | 'dev' | 'ino' | 'birthtime' | 'mtime'
  >>
  canCommit?: () => boolean
  signal?: AbortSignal
}

type SourceProjectionBundle = {
  candidate: SessionSourceCandidate
  projection: TranscriptProjection
  fingerprint: SourceFingerprint
  state: 'ready' | 'pending'
  entryLocators: TranscriptEntryLocator[]
  locatorWrite: 'append' | 'replace'
}

const READ_BUFFER_BYTES = 64 * 1024
const REDUCE_CHUNK_LIMIT = 256
const REDUCE_BYTE_LIMIT = 1024 * 1024
const ENTRY_INSERT_BATCH_SIZE = 75

const defaultFileIo: FileReaderIo = {
  openReadonly(path, flags): Promise<FileHandle> {
    return open(path, flags)
  },
  statPath(path) {
    return stat(path)
  },
}

class SourceChangedDuringCommitError extends Error {}
class ProjectionGenerationCancelledError extends Error {}

function increment(
  metrics: LocalIndexIoMetrics | undefined,
  key: keyof LocalIndexIoMetrics,
  value = 1,
): void {
  if (metrics) metrics[key] += value
}

function fileIdentity(stats: { dev: number | bigint; ino: number | bigint }): string | null {
  if (process.platform === 'win32' || stats.ino === 0) return null
  return `${stats.dev}:${stats.ino}`
}

function snapshotMatchesFingerprint(
  snapshot: {
    size: number
    mtimeMs: number
    ctimeMs: number
    dev: number | bigint
    ino: number | bigint
  },
  fingerprint: SourceFingerprint,
): boolean {
  const identity = fileIdentity(snapshot)
  return snapshot.size === fingerprint.size &&
    snapshot.mtimeMs === fingerprint.mtimeMs &&
    snapshot.ctimeMs === fingerprint.ctimeMs &&
    (
      fingerprint.fileIdentity === null ||
      identity === null ||
      fingerprint.fileIdentity === identity
    )
}

function sameReadSnapshot(left: SourceFingerprint, right: SourceFingerprint): boolean {
  // The indexed boundary moves from the prior safe newline to the newly reduced
  // newline, so boundaryWindowHash/indexedBytes intentionally differ here. The
  // immutable read snapshot is represented by identity, size, mtime, ctime,
  // head, and physical tail. The final fingerprint is separately verified in
  // full.
  return left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs &&
    (
      left.fileIdentity === null ||
      right.fileIdentity === null ||
      left.fileIdentity === right.fileIdentity
    ) &&
    left.firstWindowHash === right.firstWindowHash &&
    left.lastWindowHash === right.lastWindowHash
}

function initialProjection(candidate: SessionSourceCandidate): TranscriptProjection {
  return {
    summary: {
      title: 'Untitled Session',
      createdAt: candidate.fallbackCreatedAt,
      modifiedAt: candidate.fallbackModifiedAt,
      messageCount: 0,
      workDir: candidate.fallbackWorkDir,
    },
    indexedBytes: 0,
    pendingTailBytes: 0,
    malformedLineCount: 0,
  }
}

function retryFrom(error: unknown): Extract<SourceChange, { kind: 'retry' }> {
  if (error instanceof SourceReadRetryError) return error.change
  return { kind: 'retry', reason: 'transient-io' }
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'ENOENT'
}

async function streamProjection(options: {
  candidate: SessionSourceCandidate
  start: number
  seed: TranscriptProjection
  snapshot: SourceFingerprint
  io: FileReaderIo
  metrics?: LocalIndexIoMetrics
  assertActive: () => void
  isSubagent?: boolean
}): Promise<{
  projection: TranscriptProjection
  entryLocators: TranscriptEntryLocator[]
  work: ProjectionWork
}> {
  let handle: ReadonlyFileHandle | undefined
  let thrown: unknown
  const work: ProjectionWork = { maxBufferedChunks: 0, maxBufferedBytes: 0 }
  try {
    handle = await options.io.openReadonly(options.candidate.path, 'r')
    increment(options.metrics, 'filesOpened')
    increment(options.metrics, 'statCalls')
    const before = await handle.stat()
    if (
      options.start > before.size ||
      !snapshotMatchesFingerprint(before, options.snapshot)
    ) {
      throw new SourceReadRetryError('changed-during-read')
    }

    let projection = options.seed
    let position = options.start
    let lineByteStart = options.start
    let pendingSegments: Buffer[] = []
    let pendingSegmentsLength = 0
    let chunks: TranscriptChunk[] = []
    let chunkBytes = 0
    const entryLocators: TranscriptEntryLocator[] = []

    const flush = (): void => {
      if (chunks.length === 0) return
      work.maxBufferedChunks = Math.max(work.maxBufferedChunks, chunks.length)
      work.maxBufferedBytes = Math.max(work.maxBufferedBytes, chunkBytes)
      const reduced = reduceTranscriptWithLocators(
        chunks,
        projection,
        { isSubagent: options.isSubagent },
      )
      projection = reduced.projection
      entryLocators.push(...reduced.locators)
      chunks = []
      chunkBytes = 0
    }

    while (position < options.snapshot.size) {
      options.assertActive()
      const requested = Math.min(READ_BUFFER_BYTES, options.snapshot.size - position)
      const buffer = Buffer.allocUnsafe(requested)
      const { bytesRead } = await handle.read(buffer, 0, requested, position)
      increment(options.metrics, 'bytesRead', bytesRead)
      if (bytesRead === 0) throw new SourceReadRetryError('changed-during-read')

      const bytes = buffer.subarray(0, bytesRead)
      let segmentStart = 0
      while (segmentStart < bytes.length) {
        const newline = bytes.indexOf(0x0a, segmentStart)
        if (newline === -1) {
          const segment = bytes.subarray(segmentStart)
          pendingSegments.push(segment)
          pendingSegmentsLength += segment.length
          work.maxBufferedBytes = Math.max(
            work.maxBufferedBytes,
            chunkBytes + pendingSegmentsLength,
          )
          break
        }

        const finalSegment = bytes.subarray(segmentStart, newline + 1)
        let completeLine: Buffer
        if (pendingSegments.length === 0) {
          completeLine = finalSegment
        } else {
          pendingSegments.push(finalSegment)
          pendingSegmentsLength += finalSegment.length
          completeLine = Buffer.concat(pendingSegments, pendingSegmentsLength)
        }
        chunks.push({
          text: completeLine.toString('utf8'),
          byteStart: lineByteStart,
          byteLength: completeLine.length,
          completeLine: true,
        })
        chunkBytes += completeLine.length
        work.maxBufferedChunks = Math.max(work.maxBufferedChunks, chunks.length)
        work.maxBufferedBytes = Math.max(work.maxBufferedBytes, chunkBytes)
        lineByteStart += completeLine.length
        pendingSegments = []
        pendingSegmentsLength = 0
        segmentStart = newline + 1

        if (
          chunks.length >= REDUCE_CHUNK_LIMIT ||
          chunkBytes >= REDUCE_BYTE_LIMIT
        ) {
          flush()
        }
      }
      position += bytesRead
    }

    flush()
    if (pendingSegmentsLength > 0) {
      const pending = pendingSegments.length === 1
        ? pendingSegments[0]!
        : Buffer.concat(pendingSegments, pendingSegmentsLength)
      work.maxBufferedChunks = Math.max(work.maxBufferedChunks, 1)
      work.maxBufferedBytes = Math.max(work.maxBufferedBytes, pending.length)
      const reduced = reduceTranscriptWithLocators([{
        text: pending.toString('utf8'),
        byteStart: lineByteStart,
        byteLength: pending.length,
        completeLine: false,
      }], projection, { isSubagent: options.isSubagent })
      projection = reduced.projection
    }

    increment(options.metrics, 'statCalls')
    const after = await handle.stat()
    increment(options.metrics, 'statCalls')
    let currentPath
    try {
      currentPath = await options.io.statPath(options.candidate.path)
    } catch (error) {
      if (isMissing(error)) throw new SourceReadRetryError('changed-during-read')
      throw error
    }
    if (
      !snapshotMatchesFingerprint(after, options.snapshot) ||
      !snapshotMatchesFingerprint(currentPath, options.snapshot)
    ) {
      throw new SourceReadRetryError('changed-during-read')
    }
    options.assertActive()

    return { projection, entryLocators, work }
  } catch (error) {
    thrown = error
    if (
      error instanceof SourceReadRetryError ||
      error instanceof TranscriptRebuildRequiredError ||
      error instanceof ProjectionGenerationCancelledError
    ) {
      throw error
    }
    throw new SourceReadRetryError('transient-io')
  } finally {
    if (handle) {
      try {
        await handle.close()
      } catch (error) {
        if (!thrown) throw new SourceReadRetryError('transient-io')
      }
    }
  }
}

function resolvedProgress(
  progress: ProjectionProgress | undefined,
  fallbackIndexed: number,
): Required<ProjectionProgress> {
  return {
    state: progress?.state ?? 'building',
    discovered: progress?.discovered ?? fallbackIndexed,
    indexed: progress?.indexed ?? fallbackIndexed,
    degraded: progress?.degraded ?? 0,
    lastErrorCode: progress?.lastErrorCode ?? null,
  }
}

function writeBackfillState(
  operation: LocalIndexWriteOperation,
  scope: string,
  watermark: string | null,
  progress: Required<ProjectionProgress>,
  updatedAtMs: number,
): void {
  operation.run(`
    INSERT INTO backfill_state (
      scope, state, watermark, discovered, indexed, degraded,
      last_error_code, updated_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(scope) DO UPDATE SET
      state = excluded.state,
      watermark = excluded.watermark,
      discovered = excluded.discovered,
      indexed = excluded.indexed,
      degraded = excluded.degraded,
      last_error_code = excluded.last_error_code,
      updated_at_ms = excluded.updated_at_ms
  `,
  scope,
  progress.state,
  watermark,
  progress.discovered,
  progress.indexed,
  progress.degraded,
  progress.lastErrorCode,
  updatedAtMs)
}

function writeSessionEntryLocators(
  operation: LocalIndexWriteOperation,
  transcriptPath: string,
  locators: TranscriptEntryLocator[],
): void {
  for (let start = 0; start < locators.length; start += ENTRY_INSERT_BATCH_SIZE) {
    const batch = locators.slice(start, start + ENTRY_INSERT_BATCH_SIZE)
    const bindings = batch.flatMap(locator => [
      transcriptPath,
      locator.ordinal,
      locator.jsonlLine,
      locator.byteStart,
      locator.byteLength,
      locator.entryType,
      locator.messageId,
      locator.role,
      locator.timestamp,
      locator.parentToolUseId,
    ])
    const values = batch.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ')
    operation.run(`
      INSERT INTO session_entries (
        transcript_path, ordinal, jsonl_line, byte_start, byte_length,
        entry_type, message_id, role, timestamp, parent_tool_use_id
      ) VALUES ${values}
    `, ...bindings)
  }
}

export function createSessionProjector(options: SessionProjectorOptions): SessionProjector {
  const parserVersion = options.parserVersion ?? SESSION_SUMMARY_PARSER_VERSION
  const now = options.now ?? Date.now
  const io = options.fileIo ?? defaultFileIo
  const verifyFingerprint = options.verifyFingerprint ?? verifySourceFingerprint
  const syncSourceStat = options.syncStat ?? statSync
  const sourceMetadataStat = options.sourceMetadataStat ?? stat
  const projectionCache = new Map<string, TranscriptProjection>()
  const assertActive = (): void => {
    if (options.signal?.aborted || options.canCommit?.() === false) {
      throw new ProjectionGenerationCancelledError()
    }
  }

  const commitProgress = (
    watermark: string | null,
    progress: ProjectionProgress | undefined,
  ): void => {
    const sourceCount = progress ? progress.indexed : options.index.countSources()
    const resolved = resolvedProgress(progress, sourceCount)
    options.database.transaction(writer => {
      assertActive()
      writeBackfillState(writer, options.scope, watermark, resolved, now())
      assertActive()
    })
  }

  const commitSourceProjection = (
    bundle: SourceProjectionBundle,
    progress: ProjectionProgress | undefined,
  ): void => {
    const summary = bundle.projection.summary
    const sourceCount = progress
      ? progress.indexed
      : options.index.countSources() +
        (options.index.getSource(bundle.candidate.path) ? 0 : 1)
    const resolved = resolvedProgress(progress, sourceCount)
    const updatedAtMs = now()
    const assertCommitSnapshot = (): void => {
      let snapshot
      try {
        increment(options.metrics, 'statCalls')
        snapshot = syncSourceStat(bundle.candidate.path)
      } catch {
        throw new SourceChangedDuringCommitError()
      }
      if (!snapshotMatchesFingerprint(snapshot, bundle.fingerprint)) {
        throw new SourceChangedDuringCommitError()
      }
    }

    options.database.transaction(writer => {
      assertActive()
      assertCommitSnapshot()
      writer.run(`
        INSERT INTO source_files (
          path, kind, size_bytes, mtime_ms, file_identity, prefix_hash,
          indexed_bytes, parser_version, state, last_error_code, updated_at_ms
        ) VALUES (?, 'transcript', ?, ?, ?, ?, ?, ?, ?, NULL, ?)
        ON CONFLICT(path) DO UPDATE SET
          kind = excluded.kind,
          size_bytes = excluded.size_bytes,
          mtime_ms = excluded.mtime_ms,
          file_identity = excluded.file_identity,
          prefix_hash = excluded.prefix_hash,
          indexed_bytes = excluded.indexed_bytes,
          parser_version = excluded.parser_version,
          state = excluded.state,
          last_error_code = NULL,
          updated_at_ms = excluded.updated_at_ms
      `,
      bundle.candidate.path,
      bundle.fingerprint.size,
      bundle.fingerprint.mtimeMs,
      bundle.fingerprint.fileIdentity,
      serializeSourceFingerprint(bundle.fingerprint),
      bundle.projection.indexedBytes,
      parserVersion,
      bundle.state,
      updatedAtMs)

      if (bundle.projection.activity) {
        writeActivityProjection(writer, {
          path: bundle.candidate.path,
          parentSessionId: bundle.candidate.sessionId,
          projectPath: bundle.candidate.projectPath,
          isSubagent: false,
          fingerprint: bundle.fingerprint,
          fingerprintJson: serializeSourceFingerprint(bundle.fingerprint),
          indexedBytes: bundle.projection.indexedBytes,
          parserVersion,
          state: bundle.state,
          updatedAtMs,
        }, bundle.projection.activity)
      }

      if (bundle.locatorWrite === 'replace') {
        writer.run(
          'DELETE FROM session_entries WHERE transcript_path = ?',
          bundle.candidate.path,
        )
      }
      writeSessionEntryLocators(
        writer,
        bundle.candidate.path,
        bundle.entryLocators,
      )

      options.beforeSessionUpsert?.()
      const modifiedAtMs = Date.parse(summary.modifiedAt)
      if (!Number.isFinite(modifiedAtMs)) {
        throw new Error('Session projection has an invalid modifiedAt timestamp')
      }
      const runtimeProviderPresent = Object.prototype.hasOwnProperty.call(
        summary,
        'runtimeProviderId',
      ) ? 1 : 0
      writer.run(`
        INSERT INTO sessions (
          transcript_path, session_id, project_path, title, created_at,
          modified_at, modified_at_ms, message_count, work_dir, repository_json,
          worktree_session_json, permission_mode, runtime_provider_id,
          runtime_provider_present, runtime_model_id, effort_level
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(transcript_path) DO UPDATE SET
          session_id = excluded.session_id,
          project_path = excluded.project_path,
          title = excluded.title,
          created_at = excluded.created_at,
          modified_at = excluded.modified_at,
          modified_at_ms = excluded.modified_at_ms,
          message_count = excluded.message_count,
          work_dir = excluded.work_dir,
          repository_json = excluded.repository_json,
          worktree_session_json = excluded.worktree_session_json,
          permission_mode = excluded.permission_mode,
          runtime_provider_id = excluded.runtime_provider_id,
          runtime_provider_present = excluded.runtime_provider_present,
          runtime_model_id = excluded.runtime_model_id,
          effort_level = excluded.effort_level
      `,
      bundle.candidate.path,
      bundle.candidate.sessionId,
      bundle.candidate.projectPath,
      summary.title,
      summary.createdAt,
      summary.modifiedAt,
      modifiedAtMs,
      summary.messageCount,
      summary.workDir,
      summary.repository ? JSON.stringify(summary.repository) : null,
      summary.worktreeSession !== undefined
        ? JSON.stringify(summary.worktreeSession)
        : null,
      summary.permissionMode ?? null,
      summary.runtimeProviderId ?? null,
      runtimeProviderPresent,
      summary.runtimeModelId ?? null,
      summary.effortLevel ?? null)

      writeBackfillState(
        writer,
        options.scope,
        bundle.candidate.path,
        resolved,
        updatedAtMs,
      )
      // This closes the practical verify-to-BEGIN window. A same-size rewrite
      // with forged mtime in the final stat-to-COMMIT instructions remains an
      // unavoidable micro-window and is repaired by the next reconciliation.
      assertCommitSnapshot()
      assertActive()
    })
  }

  const buildProjection = async (
    candidate: SessionSourceCandidate,
    start: number,
    seed: TranscriptProjection,
    isSubagent = false,
  ): Promise<{
    projection: TranscriptProjection
    entryLocators: TranscriptEntryLocator[]
    fingerprint: SourceFingerprint
    work: ProjectionWork
  }> => {
    assertActive()
    const readSnapshot = await captureSourceFingerprint({
      path: candidate.path,
      indexedBytes: start,
      parserVersion,
      metrics: options.metrics,
      io,
    })
    let projectionSeed = seed
    if (start === 0) {
      increment(options.metrics, 'statCalls')
      let metadata
      try {
        metadata = await sourceMetadataStat(candidate.path)
      } catch (error) {
        if (isMissing(error)) throw new SourceReadRetryError('changed-during-read')
        throw error
      }
      assertActive()
      if (!snapshotMatchesFingerprint(metadata, readSnapshot)) {
        throw new SourceReadRetryError('changed-during-read')
      }
      projectionSeed = initialProjection({
        ...candidate,
        fallbackCreatedAt: metadata.birthtime.toISOString(),
        fallbackModifiedAt: metadata.mtime.toISOString(),
      })
    }
    const streamed = await streamProjection({
      candidate,
      start,
      seed: projectionSeed,
      snapshot: readSnapshot,
      io,
      metrics: options.metrics,
      assertActive,
      isSubagent,
    })
    assertActive()
    const commitSnapshot = await captureSourceFingerprint({
      path: candidate.path,
      indexedBytes: streamed.projection.indexedBytes,
      parserVersion,
      metrics: options.metrics,
      io,
    })
    if (!sameReadSnapshot(readSnapshot, commitSnapshot)) {
      throw new SourceReadRetryError('changed-during-read')
    }
    assertActive()
    return {
      projection: streamed.projection,
      entryLocators: streamed.entryLocators,
      fingerprint: commitSnapshot,
      work: streamed.work,
    }
  }

  return {
    async projectSource(candidate, progress): Promise<SessionProjectResult> {
      try {
        assertActive()
      } catch (error) {
        return retryFrom(error)
      }
      const existing = options.index.getSource(candidate.path)
      let action: 'full' | 'append' | 'rebuild' = 'full'
      let start = 0
      let seed = initialProjection(candidate)

      if (existing) {
        const previous = deserializeSourceFingerprint(existing.fingerprint)
        const previousProjection = projectionCache.get(candidate.path) ??
          options.index.getProjectionSeed(candidate.path)
        const change = previous
          ? await detectSourceChange({
            path: candidate.path,
            previous,
            parserVersion,
            metrics: options.metrics,
            io,
          })
          : { kind: 'rebuild', reason: 'rewrite' } as const
        try {
          assertActive()
        } catch (error) {
          return retryFrom(error)
        }
        if (change.kind === 'retry') return change
        if (change.kind === 'deleted') return this.deleteSource(candidate.path, progress)
        if (
          change.kind === 'unchanged' &&
          options.index.getActivitySource(candidate.path)
        ) {
          commitProgress(candidate.path, progress)
          if (!previousProjection) return { kind: 'retry', reason: 'transient-io' }
          return {
            kind: 'indexed',
            action: 'unchanged',
            projection: previousProjection,
            work: { maxBufferedChunks: 0, maxBufferedBytes: 0 },
          }
        }
        if (change.kind === 'unchanged') {
          action = 'rebuild'
        } else if (change.kind === 'append') {
          const dependedOnFileFallback = previous !== null &&
            previousProjection?.summary.modifiedAt ===
              new Date(previous.mtimeMs).toISOString()
          if (dependedOnFileFallback) {
            action = 'rebuild'
          } else {
            action = 'append'
            start = change.readFrom
            seed = previousProjection ?? initialProjection(candidate)
          }
        } else {
          action = 'rebuild'
        }
      }

      let built
      try {
        built = await buildProjection(candidate, start, seed)
      } catch (error) {
        if (action === 'append' && error instanceof TranscriptRebuildRequiredError) {
          action = 'rebuild'
          try {
            built = await buildProjection(candidate, 0, initialProjection(candidate))
          } catch (rebuildError) {
            return retryFrom(rebuildError)
          }
        } else {
          return retryFrom(error)
        }
      }

      // This bounded verification is deliberately the last async file operation.
      // The following BEGIN/upserts/COMMIT are synchronous and source-owned.
      const verified = await verifyFingerprint({
        path: candidate.path,
        expected: built.fingerprint,
        metrics: options.metrics,
        io,
      })
      try {
        assertActive()
      } catch (error) {
        return retryFrom(error)
      }
      if (verified.kind !== 'unchanged') {
        return verified.kind === 'retry'
          ? verified
          : { kind: 'retry', reason: 'changed-during-read' }
      }

      const bundle: SourceProjectionBundle = {
        candidate,
        projection: built.projection,
        fingerprint: built.fingerprint,
        state: built.projection.pendingTailBytes > 0 ? 'pending' : 'ready',
        entryLocators: built.entryLocators,
        locatorWrite: action === 'append' ? 'append' : 'replace',
      }
      try {
        commitSourceProjection(bundle, progress)
      } catch (error) {
        if (
          error instanceof SourceChangedDuringCommitError ||
          error instanceof ProjectionGenerationCancelledError
        ) {
          return { kind: 'retry', reason: 'changed-during-read' }
        }
        throw error
      }
      projectionCache.set(candidate.path, built.projection)
      return { kind: 'indexed', action, ...built }
    },

    async projectActivitySource(candidate): Promise<SessionProjectResult> {
      try {
        assertActive()
      } catch (error) {
        return retryFrom(error)
      }
      const existing = options.index.getActivitySource(candidate.path)
      let action: 'full' | 'append' | 'rebuild' = existing ? 'rebuild' : 'full'
      let start = 0
      let seed = initialProjection(candidate)
      if (existing) {
        const previous = deserializeSourceFingerprint(existing.fingerprint)
        const change = previous
          ? await detectSourceChange({
              path: candidate.path,
              previous,
              parserVersion,
              metrics: options.metrics,
              io,
            })
          : { kind: 'rebuild', reason: 'rewrite' } as const
        try {
          assertActive()
        } catch (error) {
          return retryFrom(error)
        }
        if (change.kind === 'retry') return change
        if (change.kind === 'deleted') return this.deleteActivitySource(candidate.path)
        if (change.kind === 'unchanged') {
          const projection = initialProjection(candidate)
          projection.indexedBytes = existing.indexedBytes
          projection.pendingTailBytes = existing.size - existing.indexedBytes
          return {
            kind: 'indexed',
            action: 'unchanged',
            projection,
            work: { maxBufferedChunks: 0, maxBufferedBytes: 0 },
          }
        }
        if (change.kind === 'append') {
          const cached = projectionCache.get(candidate.path)
          if (cached) {
            action = 'append'
            start = change.readFrom
            seed = cached
          }
        }
      }

      let built
      try {
        built = await buildProjection(
          candidate,
          start,
          seed,
          true,
        )
      } catch (error) {
        if (action === 'append' && error instanceof TranscriptRebuildRequiredError) {
          action = 'rebuild'
          try {
            built = await buildProjection(
              candidate,
              0,
              initialProjection(candidate),
              true,
            )
          } catch (rebuildError) {
            return retryFrom(rebuildError)
          }
        } else {
          return retryFrom(error)
        }
      }
      const verified = await verifyFingerprint({
        path: candidate.path,
        expected: built.fingerprint,
        metrics: options.metrics,
        io,
      })
      try {
        assertActive()
      } catch (error) {
        return retryFrom(error)
      }
      if (verified.kind !== 'unchanged') {
        return verified.kind === 'retry'
          ? verified
          : { kind: 'retry', reason: 'changed-during-read' }
      }
      if (!built.projection.activity) {
        return { kind: 'retry', reason: 'transient-io' }
      }
      const state = built.projection.pendingTailBytes > 0 ? 'pending' : 'ready'
      const updatedAtMs = now()
      try {
        options.database.transaction(writer => {
          assertActive()
          let snapshot
          try {
            increment(options.metrics, 'statCalls')
            snapshot = syncSourceStat(candidate.path)
          } catch {
            throw new SourceChangedDuringCommitError()
          }
          if (!snapshotMatchesFingerprint(snapshot, built.fingerprint)) {
            throw new SourceChangedDuringCommitError()
          }
          writeActivityProjection(writer, {
            path: candidate.path,
            parentSessionId: candidate.sessionId,
            projectPath: candidate.projectPath,
            isSubagent: true,
            fingerprint: built.fingerprint,
            fingerprintJson: serializeSourceFingerprint(built.fingerprint),
            indexedBytes: built.projection.indexedBytes,
            parserVersion,
            state,
            updatedAtMs,
          }, built.projection.activity!)
          try {
            increment(options.metrics, 'statCalls')
            snapshot = syncSourceStat(candidate.path)
          } catch {
            throw new SourceChangedDuringCommitError()
          }
          if (!snapshotMatchesFingerprint(snapshot, built.fingerprint)) {
            throw new SourceChangedDuringCommitError()
          }
          assertActive()
        })
      } catch (error) {
        if (
          error instanceof SourceChangedDuringCommitError ||
          error instanceof ProjectionGenerationCancelledError
        ) {
          return { kind: 'retry', reason: 'changed-during-read' }
        }
        throw error
      }
      projectionCache.set(candidate.path, built.projection)
      return { kind: 'indexed', action, ...built }
    },

    async deleteActivitySource(path) {
      try {
        assertActive()
      } catch (error) {
        return retryFrom(error)
      }
      try {
        increment(options.metrics, 'statCalls')
        await io.statPath(path)
        return { kind: 'retry', reason: 'changed-during-read' }
      } catch (error) {
        if (!isMissing(error)) return { kind: 'retry', reason: 'transient-io' }
      }
      const assertCommitMissing = (): void => {
        try {
          increment(options.metrics, 'statCalls')
          syncSourceStat(path)
        } catch (error) {
          if (isMissing(error)) return
          throw new SourceReadRetryError('transient-io')
        }
        throw new SourceChangedDuringCommitError()
      }
      try {
        options.database.transaction(writer => {
          assertActive()
          assertCommitMissing()
          writer.run('DELETE FROM activity_sources WHERE path = ?', path)
          assertCommitMissing()
          assertActive()
        })
      } catch (error) {
        if (error instanceof SourceChangedDuringCommitError) {
          return { kind: 'retry', reason: 'changed-during-read' }
        }
        return retryFrom(error)
      }
      projectionCache.delete(path)
      return { kind: 'deleted' }
    },

    async deleteSource(path, progress) {
      try {
        assertActive()
      } catch (error) {
        return retryFrom(error)
      }
      try {
        increment(options.metrics, 'statCalls')
        await io.statPath(path)
        return { kind: 'retry', reason: 'changed-during-read' }
      } catch (error) {
        if (!isMissing(error)) return { kind: 'retry', reason: 'transient-io' }
      }

      const sourceCount = progress
        ? progress.indexed
        : Math.max(0, options.index.countSources() - 1)
      const resolved = resolvedProgress(progress, sourceCount)
      const assertCommitMissing = (): void => {
        try {
          increment(options.metrics, 'statCalls')
          syncSourceStat(path)
        } catch (error) {
          if (isMissing(error)) return
          throw new SourceReadRetryError('transient-io')
        }
        throw new SourceChangedDuringCommitError()
      }
      try {
        options.database.transaction(writer => {
          assertActive()
          assertCommitMissing()
          writer.run('DELETE FROM source_files WHERE path = ?', path)
          writer.run('DELETE FROM activity_sources WHERE path = ?', path)
          writeBackfillState(writer, options.scope, path, resolved, now())
          // A source recreated after the first guard rolls back the cascade.
          // Recreate in the final stat-to-COMMIT instructions remains the same
          // unavoidable micro-window repaired by the next reconciliation.
          assertCommitMissing()
          assertActive()
        })
      } catch (error) {
        if (
          error instanceof ProjectionGenerationCancelledError ||
          error instanceof SourceReadRetryError
        ) {
          return retryFrom(error)
        }
        if (error instanceof SourceChangedDuringCommitError) {
          return { kind: 'retry', reason: 'changed-during-read' }
        }
        throw error
      }
      projectionCache.delete(path)
      return { kind: 'deleted' }
    },
  }
}
