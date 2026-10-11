import { open, stat } from 'node:fs/promises'
import { statSync, type Stats } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import { StringDecoder } from 'node:string_decoder'
import parser, { type Token } from 'stream-json/parser.js'
import { createBoundedJsonProjection } from '../boundedJsonProjection.js'
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
// 5: protocol-lock metadata was projected into session summaries.
// 6: protocol enforcement was removed; rebuild v5 summaries without protocol restrictions.
// 7: independent desktop team workers remain addressable but leave sidebar listings.
// 8: complete runtime selections clear the previous effort when no override is saved.
// 9: usage cost rates were corrected (Sonnet 5, Sonnet 5.5, Opus 5.5, fast mode); rebuild the
//    persisted per-model dollars.
// 10: project the explicit per-session ChatGPT OAuth Fast selection.
export const SESSION_SUMMARY_PARSER_VERSION = 10

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
  /** Records longer than this are streamed into a bounded skeleton. */
  recordStreamingThresholdBytes?: number
}

type SourceProjectionBundle = {
  candidate: SessionSourceCandidate
  projection: TranscriptProjection
  fingerprint: SourceFingerprint
  state: 'ready' | 'pending'
  entryLocators: TranscriptEntryLocator[]
  locatorWrite: 'append' | 'replace'
}

/**
 * Records up to this size are buffered and parsed whole. A longer record (a
 * base64 image or document result) is streamed into a bounded skeleton instead,
 * so one large payload never makes the whole transcript unprojectable.
 */
export const MAX_PROJECTION_RECORD_BYTES = 8 * 1024 * 1024
export const MAX_PROJECTION_RECORDS = 50_000
export const MAX_PROJECTION_METADATA_BYTES = 16 * 1024 * 1024
const projectionMetadataBytes = new WeakMap<TranscriptProjection, number>()
const projectionRecordCounts = new WeakMap<TranscriptProjection, number>()
const MAX_CACHED_PROJECTIONS = 8

class ProjectionLimitError extends Error {
  readonly code = 'LOCAL_INDEX_SOURCE_LIMIT'
  constructor() {
    super('Transcript exceeds the bounded local-index projection budget')
  }
}

export const LOCAL_INDEX_SOURCE_LIMIT = 'LOCAL_INDEX_SOURCE_LIMIT'

const OVERSIZED_SKELETON_BYTES = 1024 * 1024
const OVERSIZED_PREVIEW_CHARS = 4096
// Fails the reducer's JSON.parse, so an invalid oversized line is counted as
// malformed exactly like an ordinary one.
const UNPARSEABLE_RECORD_TEXT = '{'
// Every field the reducer, its activity projection, usage dedupe and entry
// locators read. Values the reducer never reads (tool results, base64 bodies)
// are skipped while the parser still validates them.
const SKELETON_ROOT_SCALARS = new Set([
  'type', 'subtype', 'content', 'isMeta', 'isSidechain', 'entrypoint', 'timestamp',
  'cwd', 'workDir', 'permissionMode', 'runtimeProviderId', 'runtimeModelId',
  'effortLevel', 'openAIFastMode', 'customTitle', 'aiTitle', 'uuid', 'parentUuid', 'messageId',
  'parent_tool_use_id', 'requestId', 'version', 'sessionId', 'timeSavedMs',
])
const SKELETON_ROOT_SUBTREES = new Set(['repository', 'worktreeSession', 'forkedFrom'])
const SKELETON_BLOCK_FIELDS = new Set(['type', 'name', 'id', 'tool_use_id', 'text', 'input'])

function skeletonSelected(path: readonly string[]): boolean {
  if (!path.length) return true
  const head = path[0]!
  if (SKELETON_ROOT_SUBTREES.has(head)) return true
  if (head !== 'message') return path.length === 1 && SKELETON_ROOT_SCALARS.has(head)
  if (path.length === 1) return true
  const field = path[1]
  if (field === 'role' || field === 'id' || field === 'model') return path.length === 2
  if (field === 'usage') return true
  if (field !== 'content') return false
  if (path.length <= 3) return true
  if (!SKELETON_BLOCK_FIELDS.has(path[3]!)) return false
  if (path.length === 4) return true
  return path[3] === 'input' && path.length === 5 && (path[4] === 'skill' || path[4] === 'command')
}

function skeletonPreview(path: readonly string[]): boolean {
  if (path.length === 0) return true
  if (path.length === 1) return path[0] === 'content'
  if (path[0] !== 'message' || path[1] !== 'content') return false
  // Text bodies are only read for titles and shot attribution, so a preview is
  // enough; identifiers such as tool names stay exact and budgeted.
  return path.length === 2 ||
    path.length === 3 ||
    path.length === 4 && (path[3] === 'text' || path[3] === 'input') ||
    path.length === 5 && path[3] === 'input' && path[4] === 'command'
}

function isJsonWhitespace(byte: number): boolean {
  return byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d ||
    byte === 0x0b || byte === 0x0c
}

/**
 * Streams one record that is too large to buffer and yields the chunk text the
 * reducer parses in its place. The original byte range stays with the chunk,
 * so offsets and locators still describe the canonical line.
 */
class OversizedRecordStream {
  private readonly stream = parser.asStream({ packValues: false, streamValues: true })
  private readonly decoder = new StringDecoder('utf8')
  private readonly projection = createBoundedJsonProjection({
    selected: skeletonSelected,
    preview: skeletonPreview,
    metadataBytes: OVERSIZED_SKELETON_BYTES,
    previewChars: OVERSIZED_PREVIEW_CHARS,
    limitError: () => new ProjectionLimitError(),
  })
  private parseError: unknown
  private projectionError: unknown
  private sawContent = false

  constructor() {
    this.stream.on('error', error => {
      this.parseError ??= error
    })
    this.stream.on('data', (token: Token) => {
      if (this.projectionError || this.parseError) return
      try {
        this.projection.token(token)
      } catch (error) {
        this.projectionError = error
      }
    })
  }

  async write(part: Buffer): Promise<void> {
    if (!this.sawContent) this.sawContent = part.some(byte => !isJsonWhitespace(byte))
    // Keep parsing after a budget error: an invalid line must still count as
    // malformed rather than as a projection limit.
    if (this.parseError) return
    const text = this.decoder.write(part)
    if (!text) return
    await new Promise<void>(resolve => this.stream.write(text, () => resolve()))
  }

  async finish(): Promise<string> {
    try {
      if (!this.sawContent) return ''
      if (!this.parseError) {
        await new Promise<void>(resolve => {
          this.stream.once('end', resolve)
          this.stream.once('error', () => resolve())
          this.stream.end(this.decoder.end())
        })
      }
      if (this.parseError) return UNPARSEABLE_RECORD_TEXT
      if (this.projectionError) throw this.projectionError
      const root = this.projection.root()
      return root === undefined ? '' : JSON.stringify(root)
    } finally {
      this.stream.destroy()
    }
  }

  discard(): void {
    this.stream.destroy()
  }
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
  if (error instanceof ProjectionLimitError) throw error
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
  recordStreamingThresholdBytes: number
}): Promise<{
  projection: TranscriptProjection
  entryLocators: TranscriptEntryLocator[]
  work: ProjectionWork
}> {
  let handle: ReadonlyFileHandle | undefined
  let thrown: unknown
  let oversized: OversizedRecordStream | undefined
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
    // Bytes of the current record already handed to `oversized`.
    let oversizedBytes = 0
    let recordsRead = projectionRecordCounts.get(options.seed) ?? 0
    let metadataBytes = projectionMetadataBytes.get(options.seed) ?? 0
    const entryLocators: TranscriptEntryLocator[] = []

    const flush = (): void => {
      if (chunks.length === 0) return
      work.maxBufferedChunks = Math.max(work.maxBufferedChunks, chunks.length)
      work.maxBufferedBytes = Math.max(work.maxBufferedBytes, chunkBytes)
      const reduced = reduceTranscriptWithLocators(
        chunks,
        projection,
        {
          isSubagent: options.isSubagent,
          validateRetainedMetadata(entry) {
            const fields = ['type', 'uuid', 'messageId', 'timestamp', 'parent_tool_use_id',
              'cwd', 'workDir', 'runtimeProviderId', 'runtimeModelId', 'openAIFastMode', 'customTitle', 'aiTitle',
              'repository', 'worktreeSession', 'requestId', 'version', 'sessionId']
            const message = entry.message as Record<string, unknown> | undefined
            const values: unknown[] = fields.map(field => entry[field])
            values.push(message?.id, message?.role, message?.model)
            const content = message?.content
            if (Array.isArray(content)) for (const block of content) {
              if (block?.type !== 'tool_use') continue
              values.push(block.name, block.name === 'Skill' ? block.input?.skill : undefined)
              if (values.length > 16_384) throw new ProjectionLimitError()
            }
            const iterations = (message?.usage as { iterations?: unknown } | undefined)?.iterations
            if (Array.isArray(iterations)) for (const iteration of iterations) {
              if (iteration?.type === 'advisor_message') values.push(iteration.model)
              if (values.length > 16_384) throw new ProjectionLimitError()
            }
            // Charge only metadata that the reducer/locators can retain. Large text
            // and tool bodies are deliberately excluded from this lifetime budget.
            let visited = 0
            while (values.length) {
              const value = values.pop()
              if (value === undefined || value === null) continue
              if (++visited > 16_384) throw new ProjectionLimitError()
              metadataBytes += 64
              if (typeof value === 'string') {
                if (value.length > 4096) throw new ProjectionLimitError()
                metadataBytes += Buffer.byteLength(value)
              } else if (typeof value === 'object') {
                for (const key in value) {
                  metadataBytes += Buffer.byteLength(key)
                  values.push((value as Record<string, unknown>)[key])
                  if (values.length > 16_384) throw new ProjectionLimitError()
                }
              }
              if (metadataBytes > MAX_PROJECTION_METADATA_BYTES) throw new ProjectionLimitError()
            }
          },
        },
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
        const segment = bytes.subarray(segmentStart, newline === -1 ? bytes.length : newline + 1)
        if (!oversized && pendingSegmentsLength + segment.length > options.recordStreamingThresholdBytes) {
          // Hand the record to the bounded stream instead of concatenating it.
          oversized = new OversizedRecordStream()
          for (const saved of pendingSegments) await oversized.write(saved)
          oversizedBytes = pendingSegmentsLength
          pendingSegments = []
          pendingSegmentsLength = 0
        }
        if (newline === -1) {
          if (oversized) {
            await oversized.write(segment)
            oversizedBytes += segment.length
          } else {
            pendingSegments.push(segment)
            pendingSegmentsLength += segment.length
            work.maxBufferedBytes = Math.max(
              work.maxBufferedBytes,
              chunkBytes + pendingSegmentsLength,
            )
          }
          break
        }

        recordsRead += 1
        if (recordsRead > MAX_PROJECTION_RECORDS) throw new ProjectionLimitError()
        if (oversized) {
          await oversized.write(segment)
          const recordBytes = oversizedBytes + segment.length
          const text = await oversized.finish()
          oversized = undefined
          oversizedBytes = 0
          chunks.push({
            text,
            byteStart: lineByteStart,
            byteLength: recordBytes,
            completeLine: true,
          })
          chunkBytes += text.length
          lineByteStart += recordBytes
        } else {
          let completeLine: Buffer
          if (pendingSegments.length === 0) {
            completeLine = segment
          } else {
            pendingSegments.push(segment)
            pendingSegmentsLength += segment.length
            completeLine = Buffer.concat(pendingSegments, pendingSegmentsLength)
          }
          chunks.push({
            text: completeLine.toString('utf8'),
            byteStart: lineByteStart,
            byteLength: completeLine.length,
            completeLine: true,
          })
          chunkBytes += completeLine.length
          lineByteStart += completeLine.length
          pendingSegments = []
          pendingSegmentsLength = 0
        }
        work.maxBufferedChunks = Math.max(work.maxBufferedChunks, chunks.length)
        work.maxBufferedBytes = Math.max(work.maxBufferedBytes, chunkBytes)
        segmentStart = newline + 1

        if (
          chunks.length >= REDUCE_CHUNK_LIMIT ||
          chunkBytes >= REDUCE_BYTE_LIMIT
        ) {
          flush()
        }
      }
      position += bytesRead
      // File reads may resolve from cache; explicitly let UI/API work run between chunks.
      await new Promise<void>(resolve => setImmediate(resolve))
    }

    flush()
    if (oversized) {
      // An unterminated oversized tail is only counted. The next append reads
      // it again from `indexedBytes` once its newline arrives.
      oversized.discard()
      oversized = undefined
      projection = reduceTranscriptWithLocators([{
        text: '',
        byteStart: lineByteStart,
        byteLength: oversizedBytes,
        completeLine: false,
      }], projection, { isSubagent: options.isSubagent }).projection
    } else if (pendingSegmentsLength > 0) {
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

    projectionMetadataBytes.set(projection, metadataBytes)
    projectionRecordCounts.set(projection, recordsRead)
    return { projection, entryLocators, work }
  } catch (error) {
    thrown = error
    if (
      error instanceof ProjectionLimitError ||
      error instanceof SourceReadRetryError ||
      error instanceof TranscriptRebuildRequiredError ||
      error instanceof ProjectionGenerationCancelledError
    ) {
      throw error
    }
    throw new SourceReadRetryError('transient-io')
  } finally {
    oversized?.discard()
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
  const recordStreamingThresholdBytes = Math.min(
    MAX_PROJECTION_RECORD_BYTES,
    Math.max(1, options.recordStreamingThresholdBytes ?? MAX_PROJECTION_RECORD_BYTES),
  )
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

  /**
   * Remember a committed transcript that no longer fits the projection budget,
   * so the next launch knows before its first read. Only the state changes:
   * the stored fingerprint and rows still describe the last successful
   * projection, and the next successful commit resets the state.
   */
  const markSourceLimited = (path: string): void => {
    try {
      options.database.transaction(writer => {
        assertActive()
        writer.run(`
          UPDATE source_files
          SET state = 'degraded', last_error_code = ?, updated_at_ms = ?
          WHERE path = ? AND NOT (state = 'degraded' AND last_error_code IS ?)
        `, LOCAL_INDEX_SOURCE_LIMIT, now(), path, LOCAL_INDEX_SOURCE_LIMIT)
      })
    } catch {
      // The failure still reaches the coordinator; persisting it only lets the
      // next launch skip rediscovering it.
    }
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
          runtime_provider_present, runtime_model_id, effort_level, is_team_worker, openai_fast_mode
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
          effort_level = excluded.effort_level,
          is_team_worker = excluded.is_team_worker,
          openai_fast_mode = excluded.openai_fast_mode
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
      summary.effortLevel ?? null,
      summary.isTeamWorker ? 1 : 0,
      summary.openAIFastMode === undefined ? null : Number(summary.openAIFastMode))

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
      recordStreamingThresholdBytes,
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
        if (existing.state === 'degraded') {
          // The budgets only grow as a transcript is appended to, so a limited
          // source is retried once it is rewritten or the parser changes, not
          // on every append. Its stored fingerprint describes the last
          // successful projection and must never seed an append.
          if (
            existing.lastErrorCode === LOCAL_INDEX_SOURCE_LIMIT &&
            (change.kind === 'unchanged' || change.kind === 'append')
          ) {
            throw new ProjectionLimitError()
          }
          action = 'rebuild'
        } else if (
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
        } else if (change.kind === 'unchanged') {
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

      const failFrom = (error: unknown): Extract<SourceChange, { kind: 'retry' }> => {
        if (error instanceof ProjectionLimitError && existing) {
          markSourceLimited(candidate.path)
        }
        return retryFrom(error)
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
            return failFrom(rebuildError)
          }
        } else {
          return failFrom(error)
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
      projectionCache.delete(candidate.path)
      projectionCache.set(candidate.path, built.projection)
      while (projectionCache.size > MAX_CACHED_PROJECTIONS) {
        projectionCache.delete(projectionCache.keys().next().value!)
      }
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
      projectionCache.delete(candidate.path)
      projectionCache.set(candidate.path, built.projection)
      while (projectionCache.size > MAX_CACHED_PROJECTIONS) {
        projectionCache.delete(projectionCache.keys().next().value!)
      }
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
