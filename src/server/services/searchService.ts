/**
 * SearchService — 工作区文件搜索 & 会话历史搜索
 *
 * 工作区文件搜索优先使用 ripgrep；会话搜索优先使用本地 SQLite 投影，
 * 索引未就绪或不可用时自动回退到有界、流式的 ripgrep / 文件扫描。
 */

import { spawn } from 'child_process'
import { createReadStream } from 'fs'
import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import { createInterface } from 'readline'
import { StringDecoder } from 'string_decoder'
import { ApiError } from '../middleware/errorHandler.js'
import { ripgrepCommand } from '../../utils/ripgrep.js'
import {
  sessionService,
  type IndexedSessionSearchMetadata,
} from './sessionService.js'
import {
  SEARCH_CONTENT_MAX_JSONL_LINE_BYTES,
  extractSearchableSegments,
  type SearchableTranscriptEntry,
} from './localIndex/searchContentProjector.js'
import {
  searchContentCoordinator,
} from './localIndex/searchContentCoordinator.js'
import type {
  SearchContentSuggestions,
  SearchContentMatch,
  SearchContentQueryOptions,
  SearchContentQueryResult,
} from './localIndex/searchContentIndex.js'
import {
  deserializeSourceFingerprint,
  verifySourceFingerprint,
  type SourceFingerprint,
} from './localIndex/sourceFingerprint.js'

export type SearchResult = {
  file: string
  line: number
  text: string
  context?: string[]
}

export type SessionMatchRole = 'user' | 'assistant'

export type SessionMatch = {
  /** Who produced the matched text. */
  role: SessionMatchRole
  /** Transcript entry uuid (for future "jump to message"); null on legacy rows. */
  messageId: string | null
  /** 1-based line number inside the .jsonl file. */
  lineNumber: number
  /** Whitespace-collapsed, window-trimmed readable excerpt. */
  snippet: string
  /** Match ranges relative to `snippet`, for highlighting. */
  highlights: Array<{ start: number; end: number }>
  timestamp?: string
}

export type SessionSearchResult = {
  sessionId: string
  title: string
  projectPath: string
  workDir: string | null
  modifiedAt: string
  /** Total readable matches in the session (may exceed matches.length). */
  matchCount: number
  matches: SessionMatch[]
}

export type SessionSearchOptions = {
  limit?: number
  matchesPerSession?: number
  caseSensitive?: boolean
  metrics?: SessionSearchIoMetrics
  project?: string
  modifiedAfter?: string
  modifiedBefore?: string
  signal?: AbortSignal
}

export type SessionSearchIoMetrics = {
  candidateFiles: number
  filesOpened: number
  bytesRead: number
  fallbackFiles: number
}

export type SessionSearchOutput = {
  results: SessionSearchResult[]
  truncated: boolean
}

/** Minimal transcript-entry shape needed for search (mirrors sessionService's RawEntry). */
type RawSearchEntry = SearchableTranscriptEntry

/** Cap files parsed in phase B so a broad query can't read hundreds of large files. */
const SESSION_SEARCH_MAX_FILES = 60
const SESSION_SEARCH_DEFAULT_LIMIT = 50
const SESSION_SEARCH_DEFAULT_MATCHES_PER_SESSION = 5
/** Characters of context kept on each side of a match inside a snippet. */
const SESSION_SNIPPET_WINDOW = 120
/** Keep exact-path rg invocations below Windows/macOS argv limits. */
const RG_PATH_BATCH_MAX_COUNT = 128
const RG_PATH_BATCH_MAX_CHARS = 24 * 1024
/** Session rg records contain only a path or a path + line number. */
const RG_SESSION_MAX_RECORD_BYTES = 64 * 1024
const RG_SESSION_MAX_ERROR_BYTES = 64 * 1024
function jsonEscapedSearchLiteral(query: string): string {
  return JSON.stringify(query).slice(1, -1)
}

function escapeRipgrepRegex(value: string): string {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')
}

function sourceFileIdentity(snapshot: { dev: number | bigint; ino: number | bigint }): string | null {
  if (process.platform === 'win32' || snapshot.ino === 0) return null
  return `${snapshot.dev}:${snapshot.ino}`
}

function snapshotMatchesSearchFingerprint(
  snapshot: {
    size: number
    mtimeMs: number
    ctimeMs: number
    dev: number | bigint
    ino: number | bigint
  },
  fingerprint: SourceFingerprint,
): boolean {
  const identity = sourceFileIdentity(snapshot)
  return snapshot.size === fingerprint.size &&
    snapshot.mtimeMs === fingerprint.mtimeMs &&
    snapshot.ctimeMs === fingerprint.ctimeMs &&
    (
      fingerprint.fileIdentity === null ||
      identity === null ||
      fingerprint.fileIdentity === identity
    )
}

function isDirectProjectName(value: unknown): value is string {
  return typeof value === 'string' &&
    value.length > 0 &&
    value !== '.' &&
    value !== '..' &&
    !value.includes('/') &&
    !value.includes('\\') &&
    path.basename(value) === value
}

type DirectorySnapshot = Pick<
  Awaited<ReturnType<typeof fs.stat>>,
  'dev' | 'ino' | 'size' | 'mtimeMs' | 'ctimeMs'
>

function sameDirectorySnapshot(
  left: DirectorySnapshot,
  right: DirectorySnapshot,
): boolean {
  return left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
}

function sameCandidateSnapshot(
  left: Map<string, IndexedSessionSearchMetadata>,
  right: Map<string, IndexedSessionSearchMetadata>,
): boolean {
  if (left.size !== right.size) return false
  const normalizedRight = new Map(
    [...right].map(([filePath, metadata]) => [path.resolve(filePath), metadata]),
  )
  for (const [filePath, leftMetadata] of left) {
    const rightMetadata = normalizedRight.get(path.resolve(filePath))
    if (!rightMetadata) return false
    const leftSource = leftMetadata.sourceSnapshot
    const rightSource = rightMetadata.sourceSnapshot
    if (!leftSource && !rightSource) continue
    if (
      !leftSource ||
      !rightSource ||
      leftSource.dev !== rightSource.dev ||
      leftSource.ino !== rightSource.ino ||
      leftSource.size !== rightSource.size ||
      leftSource.mtimeMs !== rightSource.mtimeMs ||
      leftSource.ctimeMs !== rightSource.ctimeMs
    ) return false
  }
  return true
}

type SearchEntryLineRead = {
  entries: Array<{ entry: Record<string, unknown>; lineNumber: number }>
  bytesRead: number
  rangesRead: number
}

type SearchServiceOptions = {
  suggestIndexedSessions?: (query: string, options: { limit?: number; signal?: AbortSignal }) => SearchContentSuggestions | null
  readEntriesAtLines?: (
    filePath: string,
    lineNumbers: Set<number>,
  ) => Promise<SearchEntryLineRead | null>
  getMetadataForPaths?: typeof sessionService.getIndexedSessionSearchMetadata
  getCandidatesForFilters?: typeof sessionService.getIndexedSessionSearchCandidates
  searchIndexedContent?: (
    query: string,
    options: SearchContentQueryOptions & { signal?: AbortSignal },
  ) => SearchContentQueryResult | null
  resolveRipgrepCommand?: typeof ripgrepCommand
}

function abortError(signal?: AbortSignal): Error {
  return signal?.reason instanceof Error
    ? signal.reason
    : new DOMException('The operation was aborted', 'AbortError')
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError(signal)
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

export class SearchService {
  private readonly suggestIndexedSessions: NonNullable<SearchServiceOptions['suggestIndexedSessions']>
  private readonly readEntriesAtLines: NonNullable<SearchServiceOptions['readEntriesAtLines']>
  private readonly getMetadataForPaths: NonNullable<SearchServiceOptions['getMetadataForPaths']>
  private readonly getCandidatesForFilters: NonNullable<SearchServiceOptions['getCandidatesForFilters']>
  private readonly searchIndexedContent: NonNullable<SearchServiceOptions['searchIndexedContent']>
  private readonly resolveRipgrepCommand: typeof ripgrepCommand
  private readonly commandAvailability = new Map<string, Promise<boolean>>()

  constructor(options: SearchServiceOptions = {}) {
    this.suggestIndexedSessions = options.suggestIndexedSessions ?? ((query, options) => searchContentCoordinator.suggestSessions(query, options))
    this.readEntriesAtLines = options.readEntriesAtLines ?? ((filePath, lineNumbers) =>
      sessionService.readSessionEntriesAtLines(
        filePath,
        lineNumbers,
        ['user', 'assistant'],
      ))
    this.getMetadataForPaths = options.getMetadataForPaths ?? (filePaths =>
      sessionService.getIndexedSessionSearchMetadata(filePaths))
    this.getCandidatesForFilters = options.getCandidatesForFilters ?? (filters =>
      sessionService.getIndexedSessionSearchCandidates(filters))
    this.searchIndexedContent = options.searchIndexedContent ?? (
      (query, searchOptions) => searchContentCoordinator.search(query, searchOptions)
    )
    this.resolveRipgrepCommand = options.resolveRipgrepCommand ?? ripgrepCommand
  }
  // ---------------------------------------------------------------------------
  // 工作区搜索
  // ---------------------------------------------------------------------------

  /** 使用 ripgrep 搜索工作目录 */
  async searchWorkspace(
    query: string,
    options?: {
      cwd?: string
      maxResults?: number
      glob?: string
      caseSensitive?: boolean
    },
  ): Promise<SearchResult[]> {
    if (!query) {
      throw ApiError.badRequest('Search query is required')
    }

    const cwd = options?.cwd || process.cwd()
    const maxResults = options?.maxResults || 200

    // 尝试产品统一解析出的 rg，降级到 grep
    if (this.hasRipgrep()) {
      try {
        return await this.searchWithRipgrep(query, cwd, maxResults, options)
      } catch (error) {
        if (isAbortError(error)) throw error
        // rg 执行失败，降级到 grep
      }
    }

    const hasGrep = await this.commandExists('grep')
    if (hasGrep) {
      try {
        return await this.searchWithGrep(query, cwd, maxResults, options)
      } catch (error) {
        if (isAbortError(error)) throw error
        // grep failed or is not available; fall back to a portable search.
      }
    }

    return this.searchWithFilesystem(query, cwd, maxResults, options)
  }

  // ---------------------------------------------------------------------------
  // 会话历史搜索
  // ---------------------------------------------------------------------------

  /** Menu suggestions deliberately trust the disposable index, never opening canonical transcripts. */
  async searchSessionSuggestions(query: string, options: { limit?: number; signal?: AbortSignal; deadlineMs?: number } = {}) {
    throwIfAborted(options.signal)
    if (!query.trim()) return { sessions: [], truncated: false, indexUnavailable: false }
    // The FTS lookup is one synchronous statement, so the deadline is checked
    // before it starts. A picker that already spent its budget on metadata
    // returns that page instead of stalling every other request.
    if (options.deadlineMs !== undefined && Date.now() > options.deadlineMs) {
      return { sessions: [], truncated: true, indexUnavailable: false }
    }
    const projected = this.suggestIndexedSessions(query, options)
    throwIfAborted(options.signal)
    return {
      sessions: projected?.sessions.map(item => ({ sessionId: item.ownerSessionId,
        ownerTranscriptPath: item.ownerTranscriptPath, projectPath: item.projectPath,
        modifiedAt: new Date(item.modifiedAtMs).toISOString() })) ?? [],
      truncated: projected?.truncated ?? true,
      indexUnavailable: projected === null,
    }
  }

  /**
   * Full-text search across all session transcripts.
   *
   * A complete SQLite content projection is the default query path. Until it
   * is ready (or whenever it becomes stale/degraded), the canonical JSONL
   * files remain authoritative through a bounded two-phase fallback: rg first
   * returns candidate paths, then only line locators for the most recent
   * candidates. A streaming pure-JS scan preserves behavior when rg is absent.
   */
  async searchSessions(
    query: string,
    options?: SessionSearchOptions,
  ): Promise<SessionSearchOutput> {
    throwIfAborted(options?.signal)
    const trimmedQuery = query.trim()
    if (!trimmedQuery) {
      throw ApiError.badRequest('Search query is required')
    }

    const caseSensitive = options?.caseSensitive ?? false
    const limit = options?.limit ?? SESSION_SEARCH_DEFAULT_LIMIT
    const matchesPerSession =
      options?.matchesPerSession ?? SESSION_SEARCH_DEFAULT_MATCHES_PER_SESSION

    const configDir =
      process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
    const projectsDir = path.join(configDir, 'projects')
    if (options?.project !== undefined && !isDirectProjectName(options.project)) {
      throw ApiError.badRequest('Invalid project filter')
    }
    const candidateRoot = options?.project
      ? path.resolve(projectsDir, options.project)
      : projectsDir
    const candidateRelative = path.relative(path.resolve(projectsDir), candidateRoot)
    if (
      options?.project &&
      (candidateRelative !== options.project ||
        candidateRelative.startsWith(`..${path.sep}`) ||
        path.isAbsolute(candidateRelative))
    ) {
      throw ApiError.badRequest('Invalid project filter')
    }

    let candidateRootSnapshot: Awaited<ReturnType<typeof fs.stat>>
    try {
      candidateRootSnapshot = await fs.stat(candidateRoot)
      throwIfAborted(options?.signal)
      if (!candidateRootSnapshot.isDirectory()) {
        return { results: [], truncated: false }
      }
    } catch {
      throwIfAborted(options?.signal)
      return { results: [], truncated: false }
    }

    const indexedModifiedAfterMs = options?.modifiedAfter
      ? Date.parse(options.modifiedAfter)
      : undefined
    const indexedModifiedBeforeMs = options?.modifiedBefore
      ? Date.parse(options.modifiedBefore)
      : undefined
    const indexedDatesValid =
      (indexedModifiedAfterMs === undefined || Number.isFinite(indexedModifiedAfterMs)) &&
      (indexedModifiedBeforeMs === undefined || Number.isFinite(indexedModifiedBeforeMs))
    const indexedContent = indexedDatesValid
      ? this.searchIndexedContent(trimmedQuery, {
          project: options?.project,
          modifiedAfterMs: indexedModifiedAfterMs,
          modifiedBeforeMs: indexedModifiedBeforeMs,
          limit: SESSION_SEARCH_MAX_FILES,
          matchesPerSession,
          caseSensitive,
          signal: options?.signal,
        })
      : null
    throwIfAborted(options?.signal)
    if (indexedContent) {
      const verifiedContent = await this.verifyIndexedContent(
        indexedContent,
        projectsDir,
        trimmedQuery,
        { caseSensitive, metrics: options?.metrics, signal: options?.signal },
      )
      if (verifiedContent) {
        return this.sessionResultsFromContentIndex(
          verifiedContent,
          trimmedQuery,
          {
            caseSensitive,
            limit,
            matchesPerSession,
            metrics: options?.metrics,
            signal: options?.signal,
          },
        )
      }
    }

    // A ready, complete scalar index can narrow project/date filters before rg.
    // If it cannot prove a complete list, preserve canonical root scanning.
    const indexedFilters = options?.project ||
      options?.modifiedAfter ||
      options?.modifiedBefore
      ? {
          project: options?.project,
          modifiedAfter: options?.modifiedAfter,
          modifiedBefore: options?.modifiedBefore,
        }
      : null
    let indexedFilterCandidates = indexedFilters
      ? await this.getCandidatesForFilters(indexedFilters)
      : null
    throwIfAborted(options?.signal)
    const phaseAScope = indexedFilterCandidates
      ? [...indexedFilterCandidates.keys()]
      : candidateRoot

    // ── Phase A: candidate files + matched line numbers ──────────────────────
    let candidates = await this.findSessionCandidateLines(
      trimmedQuery,
      phaseAScope,
      { caseSensitive, signal: options?.signal },
    )
    if (indexedFilterCandidates && indexedFilters) {
      let refreshedCandidates: Map<string, IndexedSessionSearchMetadata> | null = null
      try {
        refreshedCandidates = await this.getCandidatesForFilters(indexedFilters)
        throwIfAborted(options?.signal)
        const currentSnapshot = await fs.stat(candidateRoot)
        if (
          !refreshedCandidates ||
          !sameCandidateSnapshot(indexedFilterCandidates, refreshedCandidates) ||
          !sameDirectorySnapshot(candidateRootSnapshot, currentSnapshot)
        ) refreshedCandidates = null
      } catch (error) {
        throwIfAborted(options?.signal)
        if (isAbortError(error)) throw error
        refreshedCandidates = null
      }
      if (!refreshedCandidates) {
        indexedFilterCandidates = null
        candidates = await this.findSessionCandidateLines(
          trimmedQuery,
          candidateRoot,
          { caseSensitive, signal: options?.signal },
        )
      } else {
        indexedFilterCandidates = refreshedCandidates
      }
    }
    if (candidates.size === 0) {
      return { results: [], truncated: false }
    }

    // Prefer the most recently modified sessions; cap how many we parse.
    const indexedMetadata = indexedFilterCandidates ??
      await this.getMetadataForPaths([...candidates.keys()])
    throwIfAborted(options?.signal)
    const modifiedAfterMs = options?.modifiedAfter
      ? Date.parse(options.modifiedAfter)
      : Number.NEGATIVE_INFINITY
    const modifiedBeforeMs = options?.modifiedBefore
      ? Date.parse(options.modifiedBefore)
      : Number.POSITIVE_INFINITY
    const ranked = await Promise.all(
      [...candidates.keys()].map(async (filePath) => {
        throwIfAborted(options?.signal)
        const indexed = indexedMetadata?.get(path.resolve(filePath))
        let mtimeMs = 0
        try {
          mtimeMs = (await fs.stat(filePath)).mtimeMs
        } catch {
          // unreadable — sinks to the bottom
        }
        return { filePath, mtimeMs, indexed }
      }),
    )
    const filteredRanked = ranked.filter(item =>
      (!options?.project || path.basename(path.dirname(item.filePath)) === options.project) &&
      item.mtimeMs >= modifiedAfterMs &&
      item.mtimeMs <= modifiedBeforeMs,
    )
    filteredRanked.sort((a, b) => b.mtimeMs - a.mtimeMs)

    let truncated = false
    let filesToParse = filteredRanked
    if (filesToParse.length > SESSION_SEARCH_MAX_FILES) {
      filesToParse = filesToParse.slice(0, SESSION_SEARCH_MAX_FILES)
      truncated = true
    }
    if (options?.metrics) options.metrics.candidateFiles += filesToParse.length

    const matchedLines = await this.findSessionMatchedLines(
      trimmedQuery,
      filesToParse.map(item => item.filePath),
      { caseSensitive, signal: options?.signal },
    )
    throwIfAborted(options?.signal)

    // ── Phase B: parse matched lines serially (avoid concurrent big-file reads)
    const results: SessionSearchResult[] = []
    for (const { filePath, mtimeMs, indexed } of filesToParse) {
      throwIfAborted(options?.signal)
      const lineNumbers = matchedLines.get(path.resolve(filePath))
      if (!lineNumbers || lineNumbers.size === 0) continue

      let extracted: { matches: SessionMatch[]; matchCount: number; bytesRead: number }
      const targeted = await this.readEntriesAtLines(filePath, lineNumbers)
      throwIfAborted(options?.signal)
      const indexedMetadataVerified = targeted !== null
      if (targeted) {
        extracted = {
          ...this.extractSessionMatchesFromEntries(
            targeted.entries,
            trimmedQuery,
            { caseSensitive, matchesPerSession },
          ),
          bytesRead: targeted.bytesRead,
        }
      } else {
        extracted = await this.extractSessionMatches(
          filePath,
          lineNumbers,
          trimmedQuery,
          { caseSensitive, matchesPerSession, signal: options?.signal },
        )
        if (options?.metrics) options.metrics.fallbackFiles += 1
      }
      if (options?.metrics) {
        options.metrics.filesOpened += 1
        options.metrics.bytesRead += extracted.bytesRead
      }
      const { matches, matchCount } = extracted
      // All ripgrep hits were JSON noise (no readable user/assistant text).
      if (matchCount === 0) continue

      const sessionId = path.basename(filePath, '.jsonl')
      let title = sessionId
      let projectPath = path.basename(path.dirname(filePath))
      let workDir: string | null = null
      let modifiedAt = Number.isFinite(mtimeMs) && mtimeMs > 0
        ? new Date(mtimeMs).toISOString()
        : new Date(0).toISOString()
      if (indexed && indexedMetadataVerified) {
        title = indexed.title
        projectPath = indexed.projectPath
        workDir = indexed.workDir
        modifiedAt = indexed.modifiedAt
      }

      results.push({
        sessionId,
        title,
        projectPath,
        workDir,
        modifiedAt,
        matchCount,
        matches,
      })
    }

    // Most recently modified first.
    results.sort((a, b) =>
      a.modifiedAt < b.modifiedAt ? 1 : a.modifiedAt > b.modifiedAt ? -1 : 0,
    )

    if (results.length > limit) {
      return { results: results.slice(0, limit), truncated: true }
    }
    return { results, truncated }
  }

  /**
   * Treat SQLite as a disposable locator index, never as the text authority.
   * A missed watcher event must invalidate the whole query so the canonical
   * file path can answer it without mixing stale and current results.
   */
  private async verifyIndexedContent(
    indexedContent: SearchContentQueryResult,
    projectsDir: string,
    query: string,
    options: {
      caseSensitive: boolean
      metrics?: SessionSearchIoMetrics
      signal?: AbortSignal
    },
  ): Promise<SearchContentQueryResult | null> {
    const root = path.resolve(projectsDir)
    const verifiedSources = new Map<string, string>()
    const canonicalLines = new Map<string, RawSearchEntry>()
    const needle = options.caseSensitive ? query : query.toLowerCase()

    try {
      const sessions: SearchContentQueryResult['sessions'] = []
      for (const session of indexedContent.sessions) {
        throwIfAborted(options.signal)
        if (!this.isPathInside(root, session.ownerTranscriptPath)) return null
        const ownerSnapshot = await fs.stat(session.ownerTranscriptPath)
        if (!ownerSnapshot.isFile()) return null
        const matches: SearchContentMatch[] = []
        for (const match of session.matches) {
          throwIfAborted(options.signal)
          if (!this.isPathInside(root, match.sourcePath)) return null
          const fingerprint = deserializeSourceFingerprint(match.sourceFingerprint)
          if (!fingerprint || !this.searchMatchFitsFingerprint(match, fingerprint)) return null

          const normalizedSource = path.resolve(match.sourcePath)
          const verifiedFingerprint = verifiedSources.get(normalizedSource)
          if (verifiedFingerprint && verifiedFingerprint !== match.sourceFingerprint) return null
          if (!verifiedFingerprint) {
            const io = { filesOpened: 0, bytesRead: 0, statCalls: 0 }
            const change = await verifySourceFingerprint({
              path: normalizedSource,
              expected: fingerprint,
              metrics: io,
            })
            if (options.metrics) {
              options.metrics.filesOpened += io.filesOpened
              options.metrics.bytesRead += io.bytesRead
            }
            throwIfAborted(options.signal)
            if (change.kind !== 'unchanged') return null
            verifiedSources.set(normalizedSource, match.sourceFingerprint)
          }

          const locatorKey = `${normalizedSource}\0${match.byteStart}\0${match.byteLength}`
          let entry = canonicalLines.get(locatorKey)
          if (!entry) {
            entry = await this.readCanonicalIndexedEntry(
              normalizedSource,
              match.byteStart,
              match.byteLength,
              fingerprint,
              options,
            )
            if (!entry) return null
            canonicalLines.set(locatorKey, entry)
          }

          const segments = extractSearchableSegments(entry)
          const segment = segments[match.segmentIndex]
          const messageId = typeof entry.uuid === 'string' ? entry.uuid : null
          const timestamp = typeof entry.timestamp === 'string' ? entry.timestamp : null
          const haystack = options.caseSensitive ? segment?.text : segment?.text.toLowerCase()
          if (
            !segment ||
            segment.role !== match.role ||
            segment.text !== match.body ||
            messageId !== match.messageId ||
            timestamp !== match.timestamp ||
            !haystack?.includes(needle)
          ) return null
          matches.push({ ...match, body: segment.text })
        }
        sessions.push({ ...session, matches })
      }
      return { ...indexedContent, sessions }
    } catch (error) {
      throwIfAborted(options.signal)
      if (isAbortError(error)) throw error
      return null
    }
  }

  private isPathInside(root: string, candidate: string): boolean {
    const relative = path.relative(root, path.resolve(candidate))
    return relative.length > 0 &&
      relative !== '..' &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative)
  }

  private searchMatchFitsFingerprint(
    match: SearchContentMatch,
    fingerprint: SourceFingerprint,
  ): boolean {
    const locatorEnd = match.byteStart + match.byteLength
    return Number.isSafeInteger(match.byteStart) &&
      match.byteStart >= 0 &&
      Number.isSafeInteger(match.byteLength) &&
      match.byteLength > 0 &&
      match.byteLength <= SEARCH_CONTENT_MAX_JSONL_LINE_BYTES &&
      Number.isSafeInteger(locatorEnd) &&
      locatorEnd <= fingerprint.indexedBytes &&
      match.sourceSizeBytes === fingerprint.size &&
      match.sourceMtimeMs === fingerprint.mtimeMs &&
      match.sourceFileIdentity === fingerprint.fileIdentity &&
      match.sourceIndexedBytes === fingerprint.indexedBytes &&
      match.sourceParserVersion === fingerprint.parserVersion &&
      Number.isSafeInteger(match.lineNumber) &&
      match.lineNumber > 0 &&
      Number.isSafeInteger(match.segmentIndex) &&
      match.segmentIndex >= 0
  }

  private async readCanonicalIndexedEntry(
    sourcePath: string,
    byteStart: number,
    byteLength: number,
    fingerprint: SourceFingerprint,
    options: {
      metrics?: SessionSearchIoMetrics
      signal?: AbortSignal
    },
  ): Promise<RawSearchEntry | null> {
    throwIfAborted(options.signal)
    const handle = await fs.open(sourcePath, 'r')
    if (options.metrics) options.metrics.filesOpened += 1
    try {
      const before = await handle.stat()
      if (!snapshotMatchesSearchFingerprint(before, fingerprint)) return null
      const bytes = Buffer.allocUnsafe(byteLength)
      let offset = 0
      while (offset < byteLength) {
        throwIfAborted(options.signal)
        const read = await handle.read(bytes, offset, byteLength - offset, byteStart + offset)
        if (options.metrics) options.metrics.bytesRead += read.bytesRead
        if (read.bytesRead === 0) return null
        offset += read.bytesRead
      }
      const after = await handle.stat()
      const current = await fs.stat(sourcePath)
      if (
        !snapshotMatchesSearchFingerprint(after, fingerprint) ||
        !snapshotMatchesSearchFingerprint(current, fingerprint)
      ) return null
      if (bytes.at(-1) !== 10) return null
      let contentEnd = bytes.length - 1
      if (contentEnd > 0 && bytes[contentEnd - 1] === 13) contentEnd -= 1
      const parsed = JSON.parse(bytes.subarray(0, contentEnd).toString('utf8')) as unknown
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
      return parsed as RawSearchEntry
    } finally {
      await handle.close()
    }
  }

  private async sessionResultsFromContentIndex(
    indexedContent: SearchContentQueryResult,
    query: string,
    options: {
      caseSensitive: boolean
      limit: number
      matchesPerSession: number
      metrics?: SessionSearchIoMetrics
      signal?: AbortSignal
    },
  ): Promise<SessionSearchOutput> {
    throwIfAborted(options.signal)
    const ownerPaths = indexedContent.sessions.map(session => session.ownerTranscriptPath)
    let metadata: Map<string, IndexedSessionSearchMetadata> | null = null
    try {
      metadata = await this.getMetadataForPaths(ownerPaths)
    } catch (error) {
      throwIfAborted(options.signal)
      if (isAbortError(error)) throw error
    }
    throwIfAborted(options.signal)
    if (options.metrics) options.metrics.candidateFiles += indexedContent.sessions.length

    const needle = options.caseSensitive ? query : query.toLowerCase()
    const results: SessionSearchResult[] = []
    for (const session of indexedContent.sessions) {
      throwIfAborted(options.signal)
      const exactMatches = session.matches
        .filter((match) => {
          const haystack = options.caseSensitive ? match.body : match.body.toLowerCase()
          return haystack.includes(needle)
        })
        .slice(0, options.matchesPerSession)
      if (exactMatches.length === 0) continue

      const indexed = metadata?.get(path.resolve(session.ownerTranscriptPath))
      let title = session.ownerSessionId
      let projectPath = session.projectPath
      let workDir: string | null = null
      let modifiedAt = Number.isFinite(session.modifiedAtMs)
        ? new Date(session.modifiedAtMs).toISOString()
        : new Date(0).toISOString()
      if (indexed) {
        title = indexed.title
        projectPath = indexed.projectPath
        workDir = indexed.workDir
        modifiedAt = indexed.modifiedAt
      }

      results.push({
        sessionId: session.ownerSessionId,
        title,
        projectPath,
        workDir,
        modifiedAt,
        matchCount: session.matchCount,
        matches: exactMatches.map(match => ({
          role: match.role,
          messageId: match.messageId,
          lineNumber: match.lineNumber,
          ...this.buildSnippet(match.body, query, options.caseSensitive),
          ...(match.timestamp ? { timestamp: match.timestamp } : {}),
        })),
      })
    }

    results.sort((left, right) =>
      left.modifiedAt < right.modifiedAt ? 1 : left.modifiedAt > right.modifiedAt ? -1 : 0)
    return {
      results: results.slice(0, options.limit),
      truncated: indexedContent.truncated || results.length > options.limit,
    }
  }

  // ---------------------------------------------------------------------------
  // 会话搜索 — Phase A: 候选路径；Phase B: 选中路径的命中行号
  // ---------------------------------------------------------------------------

  private async findSessionCandidateLines(
    query: string,
    scope: string | string[],
    opts: { caseSensitive: boolean; signal?: AbortSignal },
  ): Promise<Map<string, Set<number>>> {
    throwIfAborted(opts.signal)
    if (this.hasRipgrep()) {
      try {
        return await this.findSessionCandidatesWithRipgrep(query, scope, opts)
      } catch (error) {
        throwIfAborted(opts.signal)
        if (isAbortError(error)) throw error
        // rg failed — fall back to a portable scan
      }
    }
    return this.findSessionCandidatesWithFilesystem(query, scope, opts, true)
  }

  private async findSessionCandidatesWithRipgrep(
    query: string,
    scope: string | string[],
    opts: { caseSensitive: boolean; signal?: AbortSignal },
  ): Promise<Map<string, Set<number>>> {
    const map = new Map<string, Set<number>>()
    const batches = typeof scope === 'string'
      ? [[scope]]
      : this.batchRipgrepPaths(scope)
    const literal = jsonEscapedSearchLiteral(query)
    for (const paths of batches) {
      throwIfAborted(opts.signal)
      const args = ['-l', '--fixed-strings', '--glob', '*.jsonl']
      if (!opts.caseSensitive) args.push('--ignore-case')
      args.push('--', literal, ...paths)

      const addCandidate = (record: string): void => {
        const candidate = this.parseRipgrepCandidatePath(record)
        if (candidate) map.set(path.resolve(candidate), new Set<number>())
      }
      const output = await this.runRipgrep(args, opts.signal, addCandidate)
      // Tests and embedders may replace runCommand with a string-returning shim.
      for (const record of output.split('\n')) addCandidate(record)
    }
    return map
  }

  private parseRipgrepCandidatePath(record: string): string | null {
    const value = record.endsWith('\r') ? record.slice(0, -1) : record
    if (!value) return null
    if (!value.startsWith('{')) return value
    try {
      const obj = JSON.parse(value) as Record<string, unknown>
      if (obj.type !== 'match') return null
      const data = obj.data as { path?: { text?: string } }
      return data.path?.text ?? null
    } catch {
      return value
    }
  }

  private async findSessionMatchedLines(
    query: string,
    filePaths: string[],
    opts: { caseSensitive: boolean; signal?: AbortSignal },
  ): Promise<Map<string, Set<number>>> {
    if (filePaths.length === 0) return new Map()
    throwIfAborted(opts.signal)
    if (this.hasRipgrep()) {
      try {
        return await this.findSessionMatchedLinesWithRipgrep(query, filePaths, opts)
      } catch (error) {
        throwIfAborted(opts.signal)
        if (isAbortError(error)) throw error
        // rg failed — retain the portable streaming fallback.
      }
    }
    return this.findSessionCandidatesWithFilesystem(query, filePaths, opts, false)
  }

  private async findSessionMatchedLinesWithRipgrep(
    query: string,
    filePaths: string[],
    opts: { caseSensitive: boolean; signal?: AbortSignal },
  ): Promise<Map<string, Set<number>>> {
    const map = new Map<string, Set<number>>()
    const literal = escapeRipgrepRegex(jsonEscapedSearchLiteral(query))
    const linePattern = `.*${literal}.*`

    for (const paths of this.batchRipgrepPaths(filePaths)) {
      throwIfAborted(opts.signal)
      const args = [
        '--line-number',
        '--with-filename',
        '--no-heading',
        '--only-matching',
        '--replace',
        '',
        '--glob',
        '*.jsonl',
      ]
      if (!opts.caseSensitive) args.push('--ignore-case')
      args.push('--', linePattern, ...paths)

      await this.runRipgrepRecords(args, opts.signal, (record) => {
        const match = /^(.*):(\d+):\r?$/.exec(record)
        if (!match) return
        const filePath = path.resolve(match[1])
        const lineNumber = Number.parseInt(match[2], 10)
        if (!Number.isSafeInteger(lineNumber) || lineNumber < 1) return
        const lineNumbers = map.get(filePath) ?? new Set<number>()
        lineNumbers.add(lineNumber)
        map.set(filePath, lineNumbers)
      })
    }

    return map
  }

  private batchRipgrepPaths(paths: string[]): string[][] {
    const batches: string[][] = []
    let current: string[] = []
    let currentChars = 0
    for (const filePath of paths) {
      const pathChars = filePath.length + 1
      if (
        current.length > 0 &&
        (current.length >= RG_PATH_BATCH_MAX_COUNT ||
          currentChars + pathChars > RG_PATH_BATCH_MAX_CHARS)
      ) {
        batches.push(current)
        current = []
        currentChars = 0
      }
      current.push(filePath)
      currentChars += pathChars
    }
    if (current.length > 0) batches.push(current)
    return batches
  }

  private async findSessionCandidatesWithFilesystem(
    query: string,
    scope: string | string[],
    opts: { caseSensitive: boolean; signal?: AbortSignal },
    pathsOnly: boolean,
  ): Promise<Map<string, Set<number>>> {
    const files = typeof scope === 'string'
      ? await this.walkJsonlFiles(scope, opts.signal)
      : scope
    const literal = jsonEscapedSearchLiteral(query)
    const needle = opts.caseSensitive ? literal : literal.toLowerCase()
    const map = new Map<string, Set<number>>()

    for (const filePath of files) {
      throwIfAborted(opts.signal)
      try {
        const lineNumbers = await this.scanSessionFileForLiteral(
          filePath,
          needle,
          { ...opts, stopAfterFirst: pathsOnly },
        )
        if (lineNumbers.size > 0) {
          map.set(path.resolve(filePath), pathsOnly ? new Set<number>() : lineNumbers)
        }
      } catch (error) {
        throwIfAborted(opts.signal)
        if (isAbortError(error)) throw error
        continue
      }
    }
    return map
  }

  private async scanSessionFileForLiteral(
    filePath: string,
    needle: string,
    opts: {
      caseSensitive: boolean
      signal?: AbortSignal
      stopAfterFirst: boolean
    },
  ): Promise<Set<number>> {
    const input = createReadStream(filePath, {
      encoding: 'utf-8',
      signal: opts.signal,
    })
    const lines = createInterface({ input, crlfDelay: Infinity })
    const matched = new Set<number>()
    let lineNumber = 0
    try {
      for await (const line of lines) {
        throwIfAborted(opts.signal)
        lineNumber += 1
        const haystack = opts.caseSensitive ? line : line.toLowerCase()
        if (!haystack.includes(needle)) continue
        matched.add(lineNumber)
        if (opts.stopAfterFirst) break
      }
    } finally {
      lines.close()
      input.destroy()
    }
    return matched
  }

  // ---------------------------------------------------------------------------
  // 会话搜索 — Phase B: 解析命中行 → 清洗 → 提取片段
  // ---------------------------------------------------------------------------

  private async extractSessionMatches(
    filePath: string,
    lineNumbers: Set<number>,
    query: string,
    opts: {
      caseSensitive: boolean
      matchesPerSession: number
      signal?: AbortSignal
    },
  ): Promise<{ matches: SessionMatch[]; matchCount: number; bytesRead: number }> {
    throwIfAborted(opts.signal)
    const entries: Array<{ entry: Record<string, unknown>; lineNumber: number }> = []
    let bytesRead = 0
    const input = createReadStream(filePath, { signal: opts.signal })
    const onData = (chunk: Buffer): void => {
      bytesRead += chunk.length
    }
    input.on('data', onData)
    const lines = createInterface({ input, crlfDelay: Infinity })
    let lineNumber = 0
    try {
      for await (const line of lines) {
        throwIfAborted(opts.signal)
        lineNumber += 1
        if (!lineNumbers.has(lineNumber) || !line) continue
        try {
          entries.push({
            entry: JSON.parse(line) as Record<string, unknown>,
            lineNumber,
          })
        } catch {
          // half-written / malformed line
        }
      }
    } catch (error) {
      throwIfAborted(opts.signal)
      if (isAbortError(error)) throw error
      return { matches: [], matchCount: 0, bytesRead }
    } finally {
      input.off('data', onData)
      lines.close()
      input.destroy()
    }
    return {
      ...this.extractSessionMatchesFromEntries(entries, query, opts),
      bytesRead,
    }
  }

  private extractSessionMatchesFromEntries(
    entries: Array<{ entry: Record<string, unknown>; lineNumber: number }>,
    query: string,
    opts: { caseSensitive: boolean; matchesPerSession: number },
  ): { matches: SessionMatch[]; matchCount: number } {
    const needle = opts.caseSensitive ? query : query.toLowerCase()
    const matches: SessionMatch[] = []
    let matchCount = 0

    for (const { entry: rawEntry, lineNumber: lineNo } of entries) {
      const entry = rawEntry as RawSearchEntry
      for (const segment of this.extractUserAssistantSegments(entry)) {
        const haystack = opts.caseSensitive ? segment.text : segment.text.toLowerCase()
        if (!haystack.includes(needle)) continue // ripgrep false positive (JSON noise)

        matchCount += 1
        if (matches.length < opts.matchesPerSession) {
          const { snippet, highlights } = this.buildSnippet(
            segment.text,
            query,
            opts.caseSensitive,
          )
          matches.push({
            role: segment.role,
            messageId: typeof entry.uuid === 'string' ? entry.uuid : null,
            lineNumber: lineNo,
            snippet,
            highlights,
            ...(typeof entry.timestamp === 'string' ? { timestamp: entry.timestamp } : {}),
          })
        }
      }
    }

    return { matches, matchCount }
  }

  /**
   * Extract only the user/assistant natural-language text from a transcript
   * entry. Tool calls (tool_use) and tool results (tool_result) are skipped, as
   * are internal command breadcrumbs — keeping search results clean.
   */
  private extractUserAssistantSegments(
    entry: RawSearchEntry,
  ): Array<{ role: SessionMatchRole; text: string }> {
    return extractSearchableSegments(entry)
  }

  /** Window a single match into a one-line, highlighted snippet. */
  private buildSnippet(
    text: string,
    query: string,
    caseSensitive: boolean,
  ): { snippet: string; highlights: Array<{ start: number; end: number }> } {
    const normalized = text.replace(/\s+/g, ' ').trim()
    const haystack = caseSensitive ? normalized : normalized.toLowerCase()
    const needle = caseSensitive ? query : query.toLowerCase()

    const idx = haystack.indexOf(needle)
    if (idx < 0) {
      const head = normalized.slice(0, SESSION_SNIPPET_WINDOW * 2)
      return {
        snippet: head + (normalized.length > head.length ? '…' : ''),
        highlights: [],
      }
    }

    const start = Math.max(0, idx - SESSION_SNIPPET_WINDOW)
    const end = Math.min(normalized.length, idx + needle.length + SESSION_SNIPPET_WINDOW)
    const prefix = start > 0 ? '…' : ''
    const suffix = end < normalized.length ? '…' : ''
    const snippet = prefix + normalized.slice(start, end) + suffix
    const highlightStart = prefix.length + (idx - start)

    return {
      snippet,
      highlights: [{ start: highlightStart, end: highlightStart + needle.length }],
    }
  }

  // ---------------------------------------------------------------------------
  // ripgrep 搜索
  // ---------------------------------------------------------------------------

  private async searchWithRipgrep(
    query: string,
    cwd: string,
    maxResults: number,
    options?: {
      glob?: string
      caseSensitive?: boolean
    },
  ): Promise<SearchResult[]> {
    const args = ['--json', '--max-count', String(maxResults)]

    if (options?.caseSensitive === false) {
      args.push('--ignore-case')
    }

    // 添加上下文行
    args.push('-C', '4')

    if (options?.glob) {
      args.push('--glob', options.glob)
    }

    args.push('--', query, cwd)

    const output = await this.runRipgrep(args)
    return this.parseRipgrepJson(output, maxResults)
  }

  /** 解析 ripgrep JSON 输出 */
  private parseRipgrepJson(
    output: string,
    maxResults: number,
  ): SearchResult[] {
    const results: SearchResult[] = []
    const lines = output.split('\n').filter(Boolean)

    // 收集上下文：key = `${file}:${matchLine}`
    const contextMap = new Map<
      string,
      { file: string; line: number; text: string; context: string[] }
    >()

    for (const line of lines) {
      try {
        const obj = JSON.parse(line) as Record<string, unknown>
        if (obj.type === 'match') {
          const data = obj.data as {
            path?: { text?: string }
            line_number?: number
            lines?: { text?: string }
            submatches?: unknown[]
          }

          const file = data.path?.text || ''
          const lineNum = data.line_number || 0
          const text = (data.lines?.text || '').replace(/\n$/, '')
          const key = `${file}:${lineNum}`

          contextMap.set(key, { file, line: lineNum, text, context: [] })
        } else if (obj.type === 'context') {
          // 上下文行归属到最近的 match
          const data = obj.data as {
            path?: { text?: string }
            line_number?: number
            lines?: { text?: string }
          }
          const text = (data.lines?.text || '').replace(/\n$/, '')

          // 附加到最后一个相同文件的 match
          const file = data.path?.text || ''
          for (const [key, entry] of contextMap) {
            if (key.startsWith(file + ':')) {
              entry.context.push(text)
            }
          }
        }
      } catch {
        // 跳过无法解析的行
      }
    }

    for (const entry of contextMap.values()) {
      if (results.length >= maxResults) break
      results.push({
        file: entry.file,
        line: entry.line,
        text: entry.text,
        context: entry.context.length > 0 ? entry.context : undefined,
      })
    }

    return results
  }

  // ---------------------------------------------------------------------------
  // grep 降级
  // ---------------------------------------------------------------------------

  private async searchWithGrep(
    query: string,
    cwd: string,
    maxResults: number,
    options?: {
      glob?: string
      caseSensitive?: boolean
    },
  ): Promise<SearchResult[]> {
    const args = ['-rn', '--max-count', String(maxResults)]

    if (options?.caseSensitive === false) {
      args.push('-i')
    }

    if (options?.glob) {
      args.push('--include', options.glob)
    }

    args.push('--', query, cwd)

    const output = await this.runCommand('grep', args)
    return this.parseGrepOutput(output, maxResults)
  }

  /** 解析 grep 输出 (file:line:text) */
  private parseGrepOutput(output: string, maxResults: number): SearchResult[] {
    const results: SearchResult[] = []
    const lines = output.split('\n').filter(Boolean)

    for (const line of lines) {
      if (results.length >= maxResults) break

      // grep -n 输出格式: file:line:text
      const match = line.match(/^(.+?):(\d+):(.*)$/)
      if (match) {
        results.push({
          file: match[1],
          line: parseInt(match[2], 10),
          text: match[3],
        })
      }
    }

    return results
  }

  // ---------------------------------------------------------------------------
  // Portable filesystem fallback
  // ---------------------------------------------------------------------------

  private async searchWithFilesystem(
    query: string,
    cwd: string,
    maxResults: number,
    options?: {
      glob?: string
      caseSensitive?: boolean
    },
  ): Promise<SearchResult[]> {
    const results: SearchResult[] = []
    const needle = options?.caseSensitive === false ? query.toLowerCase() : query

    await this.searchDirectory(cwd, needle, results, maxResults, {
      caseSensitive: options?.caseSensitive !== false,
      glob: options?.glob,
    })

    return results
  }

  private async searchDirectory(
    dir: string,
    needle: string,
    results: SearchResult[],
    maxResults: number,
    options: {
      caseSensitive: boolean
      glob?: string
    },
  ): Promise<void> {
    if (results.length >= maxResults) return

    let entries: import('fs').Dirent[]
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }

    for (const entry of entries) {
      if (results.length >= maxResults) return
      if (entry.name === 'node_modules' || entry.name === '.git') continue

      const fullPath = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        await this.searchDirectory(fullPath, needle, results, maxResults, options)
        continue
      }

      if (!entry.isFile()) continue
      if (options.glob && !this.matchesSimpleGlob(entry.name, options.glob)) continue

      await this.searchFile(fullPath, needle, results, maxResults, options.caseSensitive)
    }
  }

  private async searchFile(
    filePath: string,
    needle: string,
    results: SearchResult[],
    maxResults: number,
    caseSensitive: boolean,
  ): Promise<void> {
    let content: string
    try {
      const buffer = await fs.readFile(filePath)
      if (buffer.includes(0)) return
      content = buffer.toString('utf8')
    } catch {
      return
    }

    const lines = content.split(/\r?\n/)
    for (let index = 0; index < lines.length && results.length < maxResults; index++) {
      const haystack = caseSensitive ? lines[index] : lines[index].toLowerCase()
      if (!haystack.includes(needle)) continue

      results.push({
        file: filePath,
        line: index + 1,
        text: lines[index],
      })
    }
  }

  private matchesSimpleGlob(fileName: string, glob: string): boolean {
    if (!glob.includes('*')) return fileName === glob
    const escaped = glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
    return new RegExp(`^${escaped}$`).test(fileName)
  }

  // ---------------------------------------------------------------------------
  // 工具方法
  // ---------------------------------------------------------------------------

  private hasRipgrep(): boolean {
    return Boolean(this.getRipgrepCommand().rgPath)
  }

  private getRipgrepCommand(): ReturnType<typeof ripgrepCommand> {
    return this.resolveRipgrepCommand()
  }

  private runRipgrep(
    args: string[],
    signal?: AbortSignal,
    onStdoutRecord?: (record: string) => void,
  ): Promise<string> {
    const command = this.getRipgrepCommand()
    if (!command.rgPath) {
      return Promise.reject(new Error('ripgrep is unavailable'))
    }
    return this.runCommand(
      command.rgPath,
      [...command.rgArgs, ...args],
      signal,
      onStdoutRecord,
      command.argv0 ? { argv0: command.argv0 } : undefined,
    )
  }

  private runRipgrepRecords(
    args: string[],
    signal: AbortSignal | undefined,
    onRecord: (record: string) => void,
  ): Promise<void> {
    const command = this.getRipgrepCommand()
    if (!command.rgPath) {
      return Promise.reject(new Error('ripgrep is unavailable'))
    }
    return this.runCommandRecords(
      command.rgPath,
      [...command.rgArgs, ...args],
      signal,
      onRecord,
      command.argv0 ? { argv0: command.argv0 } : undefined,
    )
  }

  /** 运行外部命令，返回 stdout */
  private runCommand(
    cmd: string,
    args: string[],
    signal?: AbortSignal,
    onStdoutRecord?: (record: string) => void,
    spawnOptions?: { argv0?: string },
  ): Promise<string> {
    if (onStdoutRecord) {
      return this.runCommandRecords(
        cmd,
        args,
        signal,
        onStdoutRecord,
        spawnOptions,
      ).then(() => '')
    }
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(abortError(signal))
        return
      }
      const proc = spawn(cmd, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        ...(spawnOptions?.argv0 ? { argv0: spawnOptions.argv0 } : {}),
      })
      const chunks: Buffer[] = []
      const errorChunks: Buffer[] = []
      let settled = false
      const finish = (callback: () => void): void => {
        if (settled) return
        settled = true
        signal?.removeEventListener('abort', onAbort)
        callback()
      }
      const onAbort = (): void => {
        proc.kill()
        finish(() => reject(abortError(signal)))
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      if (signal?.aborted) onAbort()

      proc.stdout.on('data', (chunk: Buffer) => chunks.push(chunk))
      proc.stderr.on('data', (chunk: Buffer) => errorChunks.push(chunk))

      proc.on('close', (code) => {
        finish(() => {
          const output = Buffer.concat(chunks).toString('utf-8')
          const errorOutput = Buffer.concat(errorChunks).toString('utf-8')
          // rg/grep only exit 0 after emitting at least one match. An empty
          // successful capture means the host runtime did not provide usable
          // output, so fall back instead of reporting a false empty result.
          if (code === 0 && output.length === 0) {
            reject(new Error(`Command "${cmd}" returned no searchable output`))
            return
          }
          // rg/grep 返回 1 表示无匹配，不视为错误
          if (code === 0 || code === 1) {
            resolve(output)
          } else {
            reject(
              new Error(
                `Command "${cmd}" exited with code ${code}: ${errorOutput || output}`,
              ),
            )
          }
        })
      })

      proc.on('error', (err) => {
        finish(() => reject(err))
      })
    })
  }

  /** Stream newline-delimited command output without retaining the full stdout. */
  private runCommandRecords(
    cmd: string,
    args: string[],
    signal: AbortSignal | undefined,
    onRecord: (record: string) => void,
    spawnOptions?: { argv0?: string },
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(abortError(signal))
        return
      }

      const proc = spawn(cmd, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        ...(spawnOptions?.argv0 ? { argv0: spawnOptions.argv0 } : {}),
      })
      const decoder = new StringDecoder('utf8')
      let pending = ''
      let errorOutput = ''
      let errorBytes = 0
      let settled = false
      let sawOutput = false

      const finish = (callback: () => void): void => {
        if (settled) return
        settled = true
        signal?.removeEventListener('abort', onAbort)
        callback()
      }
      const fail = (error: unknown): void => {
        proc.kill()
        finish(() => reject(error instanceof Error ? error : new Error(String(error))))
      }
      const emitRecords = (flush: boolean): void => {
        let newline = pending.indexOf('\n')
        while (newline >= 0) {
          const record = pending.slice(0, newline)
          pending = pending.slice(newline + 1)
          if (Buffer.byteLength(record) > RG_SESSION_MAX_RECORD_BYTES) {
            throw new Error(`Command "${cmd}" emitted an oversized search record`)
          }
          sawOutput = true
          onRecord(record)
          newline = pending.indexOf('\n')
        }
        if (flush && pending.length > 0) {
          sawOutput = true
          onRecord(pending)
          pending = ''
        }
        if (Buffer.byteLength(pending) > RG_SESSION_MAX_RECORD_BYTES) {
          throw new Error(`Command "${cmd}" emitted an oversized search record`)
        }
      }
      const onAbort = (): void => {
        proc.kill()
        finish(() => reject(abortError(signal)))
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      if (signal?.aborted) onAbort()

      proc.stdout.on('data', (chunk: Buffer) => {
        if (settled) return
        try {
          pending += decoder.write(chunk)
          emitRecords(false)
        } catch (error) {
          fail(error)
        }
      })
      proc.stderr.on('data', (chunk: Buffer) => {
        if (errorBytes >= RG_SESSION_MAX_ERROR_BYTES) return
        const remaining = RG_SESSION_MAX_ERROR_BYTES - errorBytes
        const retained = chunk.subarray(0, remaining)
        errorOutput += retained.toString('utf8')
        errorBytes += retained.length
      })

      proc.on('close', (code) => {
        if (settled) return
        try {
          pending += decoder.end()
          emitRecords(true)
        } catch (error) {
          fail(error)
          return
        }
        finish(() => {
          if (code === 0 && !sawOutput) {
            reject(new Error(`Command "${cmd}" returned no searchable output`))
          } else if (code === 0 || code === 1) {
            resolve()
          } else {
            reject(new Error(
              `Command "${cmd}" exited with code ${code}: ${errorOutput}`,
            ))
          }
        })
      })
      proc.on('error', fail)
    })
  }

  /** 检测命令是否存在 */
  private commandExists(cmd: string): Promise<boolean> {
    const cached = this.commandAvailability.get(cmd)
    if (cached) return cached
    const lookupPromise = new Promise<boolean>((resolve) => {
      const lookup = process.platform === 'win32' ? 'where' : 'which'
      const proc = spawn(lookup, [cmd], { stdio: 'ignore' })
      proc.on('close', (code) => resolve(code === 0))
      proc.on('error', () => resolve(false))
    })
    this.commandAvailability.set(cmd, lookupPromise)
    return lookupPromise
  }

  /** 递归查找 .jsonl 文件 */
  private async walkJsonlFiles(
    dir: string,
    signal?: AbortSignal,
  ): Promise<string[]> {
    throwIfAborted(signal)
    const results: string[] = []

    try {
      const entries = await fs.readdir(dir, { withFileTypes: true })
      for (const entry of entries) {
        throwIfAborted(signal)
        const fullPath = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          const sub = await this.walkJsonlFiles(fullPath, signal)
          results.push(...sub)
        } else if (entry.name.endsWith('.jsonl')) {
          results.push(fullPath)
        }
      }
    } catch (error) {
      throwIfAborted(signal)
      if (isAbortError(error)) throw error
      // 跳过不可访问的目录
    }

    return results
  }
}
