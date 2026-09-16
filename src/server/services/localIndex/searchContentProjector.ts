import { open, type FileHandle } from 'node:fs/promises'
import {
  getCommandMetadataDisplayText,
  shouldHideCommandMetadataContent,
} from '../../../utils/commandMetadata.js'
import type { SearchContentDatabase } from './searchContentDatabase.js'
import { shouldSuppressSearchContentCapture } from '../../../services/managedContext/sensitivityPolicy.js'
import { projectManagedContextContent } from '../../../services/managedContext/blockFormat.js'
import {
  normalizeSearchContent,
  type SearchContentDocumentWrite,
  type SearchContentIndex,
  type SearchContentRole,
  type SearchContentSourceState,
  type SearchContentSourceWrite,
} from './searchContentIndex.js'
import {
  captureSourceFingerprint,
  deserializeSourceFingerprint,
  detectSourceChange,
  serializeSourceFingerprint,
  verifySourceFingerprint,
  type SourceChange,
  type SourceFingerprint,
} from './sourceFingerprint.js'

export const SEARCH_CONTENT_PARSER_VERSION = 2
export const SEARCH_CONTENT_MAX_JSONL_LINE_BYTES = 16 * 1024 * 1024
export const SEARCH_CONTENT_LINE_TOO_LARGE =
  'SEARCH_CONTENT_JSONL_LINE_TOO_LARGE' as const

export type SearchableTranscriptEntry = {
  type?: string
  uuid?: string
  timestamp?: string
  message?: { role?: string; content?: unknown }
  [key: string]: unknown
}

export type SearchableSegment = {
  role: SearchContentRole
  text: string
}

export type SearchContentSourceCandidate = {
  path: string
  projectPath: string
  ownerSessionId: string
  ownerTranscriptPath: string
  modifiedAtMs: number
}

export type SearchContentProjectResult =
  | {
    kind: 'indexed'
    action: 'full' | 'append' | 'rebuild' | 'unchanged'
    state: SearchContentSourceState
    indexedBytes: number
    indexedLines: number
    documentCount: number
  }
  | { kind: 'deleted' }
  | Extract<SourceChange, { kind: 'retry' }>

export interface SearchContentProjector {
  projectSource(
    candidate: SearchContentSourceCandidate,
  ): Promise<SearchContentProjectResult>
  deleteSource(path: string): { kind: 'deleted' }
}

export type SearchContentProjectorOptions = {
  database: SearchContentDatabase
  index: SearchContentIndex
  parserVersion?: number
  now?: () => number
  signal?: AbortSignal
  verifyFingerprint?: typeof verifySourceFingerprint
  maxJsonlLineBytes?: number
}

const READ_BUFFER_BYTES = 256 * 1024

function extractPlainTextBlocks(content: unknown): string[] {
  if (typeof content === 'string') {
    const trimmed = content.trim()
    return trimmed ? [trimmed] : []
  }
  if (!Array.isArray(content)) return []

  const result: string[] = []
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    const record = block as Record<string, unknown>
    if (record.type !== 'text' || typeof record.text !== 'string') continue
    const trimmed = record.text.trim()
    if (trimmed) result.push(trimmed)
  }
  return result
}

/** The canonical visible-text boundary shared by indexing and verification. */
export function extractSearchableSegments(
  entry: SearchableTranscriptEntry,
): SearchableSegment[] {
  if (entry.type !== 'user' && entry.type !== 'assistant') return []

  const rawContent = entry.message?.content
  const projected = entry.type === 'user' || entry.message?.role === 'user'
    ? projectManagedContextContent(rawContent)
    : { ok: true as const, content: rawContent, hadManagedContext: false }
  if (!projected.ok) return []
  const content = projected.content
  const commandDisplayText = getCommandMetadataDisplayText(content)
  if (commandDisplayText) {
    return [{ role: 'user', text: commandDisplayText }]
  }
  if (shouldHideCommandMetadataContent(content)) return []

  const role: SearchContentRole =
    entry.type === 'assistant' || entry.message?.role === 'assistant'
      ? 'assistant'
      : 'user'
  return extractPlainTextBlocks(content).map(text => ({ role, text }))
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return
  const error = new Error('Search content projection was aborted')
  error.name = 'AbortError'
  throw error
}

function fileIdentity(snapshot: {
  dev: number | bigint
  ino: number | bigint
}): string | null {
  if (process.platform === 'win32' || snapshot.ino === 0) return null
  return `${snapshot.dev}:${snapshot.ino}`
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

function sameReadSnapshot(
  before: SourceFingerprint,
  after: SourceFingerprint,
): boolean {
  return before.size === after.size &&
    before.mtimeMs === after.mtimeMs &&
    before.ctimeMs === after.ctimeMs &&
    (
      before.fileIdentity === null ||
      after.fileIdentity === null ||
      before.fileIdentity === after.fileIdentity
    ) &&
    before.firstWindowHash === after.firstWindowHash &&
    before.lastWindowHash === after.lastWindowHash
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'ENOENT'
}

function retry(): Extract<SourceChange, { kind: 'retry' }> {
  return { kind: 'retry', reason: 'transient-io' }
}

function parseCompleteLine(options: {
  bytes: Buffer
  byteStart: number
  jsonlLine: number
  /**
   * §8.4: a sensitive session keeps only the user-visible projection — the
   * assistant/tool full text is not indexed.
   */
  safeProjectionOnly?: boolean
}): SearchContentDocumentWrite[] {
  let end = options.bytes.length - 1
  if (end > 0 && options.bytes[end - 1] === 13) end -= 1
  let parsed: unknown
  try {
    parsed = JSON.parse(options.bytes.subarray(0, end).toString('utf8'))
  } catch {
    return []
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return []
  const entry = parsed as SearchableTranscriptEntry
  const messageId = typeof entry.uuid === 'string' ? entry.uuid : null
  const timestamp = typeof entry.timestamp === 'string' ? entry.timestamp : null
  const segments = extractSearchableSegments(entry)
  return segments
    .map((segment, segmentIndex) => ({ segment, segmentIndex }))
    .filter(({ segment }) => !options.safeProjectionOnly || segment.role === 'user')
    .map(({ segment, segmentIndex }) => ({
      jsonlLine: options.jsonlLine,
      byteStart: options.byteStart,
      byteLength: options.bytes.length,
      segmentIndex,
      role: segment.role,
      messageId,
      timestamp,
      body: segment.text,
      normalizedBody: normalizeSearchContent(segment.text),
    }))
}

async function readCompleteLines(options: {
  handle: FileHandle
  start: number
  end: number
  startingLine: number
  signal?: AbortSignal
  maxJsonlLineBytes: number
  /** §8.4 sensitivity policy: keep only the user-visible projection. */
  safeProjectionOnly?: boolean
}): Promise<{
  documents: SearchContentDocumentWrite[]
  indexedBytes: number
  indexedLines: number
  lineTooLarge: boolean
}> {
  const documents: SearchContentDocumentWrite[] = []
  const pendingParts: Buffer[] = []
  let pendingBytes = 0
  let position = options.start
  let lineStart = options.start
  let jsonlLine = options.startingLine

  while (position < options.end) {
    throwIfAborted(options.signal)
    const requested = Math.min(READ_BUFFER_BYTES, options.end - position)
    const buffer = Buffer.allocUnsafe(requested)
    const { bytesRead } = await options.handle.read(buffer, 0, requested, position)
    if (bytesRead < 1) throw new Error('Search source changed during read')
    const chunk = buffer.subarray(0, bytesRead)
    let cursor = 0

    while (cursor < chunk.length) {
      const newline = chunk.indexOf(10, cursor)
      if (newline < 0) {
        const remainder = chunk.subarray(cursor)
        if (pendingBytes + remainder.length > options.maxJsonlLineBytes) {
          return {
            documents,
            indexedBytes: lineStart,
            indexedLines: jsonlLine,
            lineTooLarge: true,
          }
        }
        pendingParts.push(remainder)
        pendingBytes += remainder.length
        break
      }

      const tail = chunk.subarray(cursor, newline + 1)
      if (pendingBytes + tail.length > options.maxJsonlLineBytes) {
        return {
          documents,
          indexedBytes: lineStart,
          indexedLines: jsonlLine,
          lineTooLarge: true,
        }
      }
      const lineBytes = pendingParts.length > 0
        ? Buffer.concat([...pendingParts, tail], pendingBytes + tail.length)
        : tail
      jsonlLine += 1
      documents.push(...parseCompleteLine({
        bytes: lineBytes,
        byteStart: lineStart,
        jsonlLine,
        safeProjectionOnly: options.safeProjectionOnly,
      }))
      lineStart += lineBytes.length
      pendingParts.length = 0
      pendingBytes = 0
      cursor = newline + 1
    }
    position += bytesRead
  }

  return {
    documents,
    indexedBytes: lineStart,
    indexedLines: jsonlLine,
    lineTooLarge: false,
  }
}

export function createSearchContentProjector(
  options: SearchContentProjectorOptions,
): SearchContentProjector {
  const parserVersion = options.parserVersion ?? SEARCH_CONTENT_PARSER_VERSION
  const now = options.now ?? Date.now
  const verifyFingerprint = options.verifyFingerprint ?? verifySourceFingerprint
  const configuredLineLimit = options.maxJsonlLineBytes ??
    SEARCH_CONTENT_MAX_JSONL_LINE_BYTES
  const maxJsonlLineBytes = Number.isFinite(configuredLineLimit)
    ? Math.max(1, Math.trunc(configuredLineLimit))
    : SEARCH_CONTENT_MAX_JSONL_LINE_BYTES

  const remove = (path: string): { kind: 'deleted' } => {
    options.index.deleteSource(path)
    return { kind: 'deleted' }
  }

  return {
    async projectSource(candidate) {
      throwIfAborted(options.signal)
      const existing = options.index.getSource(candidate.path)
      let action: 'full' | 'append' | 'rebuild' = existing ? 'rebuild' : 'full'
      let start = 0
      let startingLine = 0

      if (existing) {
        const previous = deserializeSourceFingerprint(existing.fingerprint)
        const change = previous
          ? await detectSourceChange({
            path: candidate.path,
            previous,
            parserVersion,
          })
          : { kind: 'rebuild', reason: 'rewrite' } as const
        if (change.kind === 'retry') return change
        if (change.kind === 'deleted') return remove(candidate.path)
        if (change.kind === 'unchanged') {
          if (
            existing.projectPath !== candidate.projectPath ||
            existing.ownerSessionId !== candidate.ownerSessionId ||
            existing.ownerTranscriptPath !== candidate.ownerTranscriptPath ||
            existing.modifiedAtMs !== candidate.modifiedAtMs
          ) {
            options.index.appendSource({
              ...existing,
              projectPath: candidate.projectPath,
              ownerSessionId: candidate.ownerSessionId,
              ownerTranscriptPath: candidate.ownerTranscriptPath,
              modifiedAtMs: candidate.modifiedAtMs,
              updatedAtMs: now(),
            }, [])
          }
          return {
            kind: 'indexed',
            action: 'unchanged',
            state: existing.state,
            indexedBytes: existing.indexedBytes,
            indexedLines: existing.indexedLines,
            documentCount: 0,
          }
        }
        if (change.kind === 'append') {
          action = 'append'
          start = change.readFrom
          startingLine = existing.indexedLines
        }
      }

      let handle: FileHandle | undefined
      try {
        const readSnapshot = await captureSourceFingerprint({
          path: candidate.path,
          indexedBytes: start,
          parserVersion,
        })
        throwIfAborted(options.signal)
        handle = await open(candidate.path, 'r')
        const before = await handle.stat()
        if (!snapshotMatchesFingerprint(before, readSnapshot)) {
          return { kind: 'retry', reason: 'changed-during-read' }
        }
        const reduced = await readCompleteLines({
          handle,
          start,
          end: readSnapshot.size,
          startingLine,
          signal: options.signal,
          maxJsonlLineBytes,
          safeProjectionOnly: shouldSuppressSearchContentCapture(candidate.ownerSessionId),
        })
        const after = await handle.stat()
        if (!snapshotMatchesFingerprint(after, readSnapshot)) {
          return { kind: 'retry', reason: 'changed-during-read' }
        }
        await handle.close()
        handle = undefined

        const commitSnapshot = await captureSourceFingerprint({
          path: candidate.path,
          indexedBytes: reduced.indexedBytes,
          parserVersion,
        })
        if (!sameReadSnapshot(readSnapshot, commitSnapshot)) {
          return { kind: 'retry', reason: 'changed-during-read' }
        }
        const verified = await verifyFingerprint({
          path: candidate.path,
          expected: commitSnapshot,
        })
        if (verified.kind !== 'unchanged') {
          return verified.kind === 'retry'
            ? verified
            : { kind: 'retry', reason: 'changed-during-read' }
        }
        throwIfAborted(options.signal)

        const state: SearchContentSourceState = reduced.lineTooLarge
          ? 'degraded'
          : reduced.indexedBytes < commitSnapshot.size ? 'pending' : 'ready'
        const source: SearchContentSourceWrite = {
          path: candidate.path,
          projectPath: candidate.projectPath,
          ownerSessionId: candidate.ownerSessionId,
          ownerTranscriptPath: candidate.ownerTranscriptPath,
          modifiedAtMs: candidate.modifiedAtMs,
          sizeBytes: commitSnapshot.size,
          mtimeMs: commitSnapshot.mtimeMs,
          fileIdentity: commitSnapshot.fileIdentity,
          fingerprint: serializeSourceFingerprint(commitSnapshot),
          indexedBytes: reduced.indexedBytes,
          indexedLines: reduced.indexedLines,
          parserVersion,
          state,
          lastErrorCode: reduced.lineTooLarge
            ? SEARCH_CONTENT_LINE_TOO_LARGE
            : null,
          updatedAtMs: now(),
        }
        if (action === 'append') {
          options.index.appendSource(source, reduced.documents)
        } else {
          options.index.replaceSource(source, reduced.documents)
        }
        return {
          kind: 'indexed',
          action,
          state,
          indexedBytes: reduced.indexedBytes,
          indexedLines: reduced.indexedLines,
          documentCount: reduced.documents.length,
        }
      } catch (error) {
        if (isMissing(error)) return remove(candidate.path)
        return retry()
      } finally {
        await handle?.close().catch(() => {})
      }
    },
    deleteSource: remove,
  }
}
