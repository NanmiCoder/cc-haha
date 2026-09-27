import type {
  SearchContentBinding,
  SearchContentDatabase,
  SearchContentWriteOperation,
} from './searchContentDatabase.js'

export type SearchContentRole = 'user' | 'assistant'
export type SearchContentSourceState = 'ready' | 'pending' | 'degraded'
export type SearchContentReadinessState = 'building' | 'ready' | 'degraded'

export type SearchContentSourceWrite = {
  path: string
  projectPath: string
  ownerSessionId: string
  ownerTranscriptPath: string
  modifiedAtMs: number
  sizeBytes: number
  mtimeMs: number
  fileIdentity: string | null
  fingerprint: string
  indexedBytes: number
  indexedLines: number
  parserVersion: number
  state: SearchContentSourceState
  lastErrorCode: string | null
  updatedAtMs: number
}

export type SearchContentSource = SearchContentSourceWrite

export type SearchContentDocumentWrite = {
  jsonlLine: number
  byteStart: number
  byteLength: number
  segmentIndex: number
  role: SearchContentRole
  messageId: string | null
  timestamp: string | null
  body: string
  normalizedBody: string
}

export type SearchContentReadinessWrite = {
  state: SearchContentReadinessState
  generation?: number
  discovered: number
  indexed: number
  degraded?: number
  lastErrorCode?: string | null
  updatedAtMs?: number
}

export type SearchContentReadiness = {
  scope: string
  state: SearchContentReadinessState
  generation: number
  discovered: number
  indexed: number
  degraded: number
  lastErrorCode: string | null
  updatedAtMs: number
}

export type SearchContentMatch = {
  sourcePath: string
  ownerSessionId: string
  ownerTranscriptPath: string
  projectPath: string
  modifiedAtMs: number
  byteStart: number
  byteLength: number
  sourceSizeBytes: number
  sourceMtimeMs: number
  sourceFileIdentity: string | null
  sourceFingerprint: string
  sourceIndexedBytes: number
  sourceParserVersion: number
  lineNumber: number
  segmentIndex: number
  role: SearchContentRole
  messageId: string | null
  timestamp: string | null
  body: string
}

export type SearchContentSessionMatches = {
  ownerSessionId: string
  ownerTranscriptPath: string
  projectPath: string
  modifiedAtMs: number
  matchCount: number
  matches: SearchContentMatch[]
}

export type SearchContentQueryResult = {
  sessions: SearchContentSessionMatches[]
  truncated: boolean
}

export type SearchContentQueryOptions = {
  project?: string
  modifiedAfterMs?: number
  modifiedBeforeMs?: number
  limit?: number
  matchesPerSession?: number
  caseSensitive?: boolean
}

export type SearchContentSuggestions = {
  sessions: Array<{ ownerSessionId: string; ownerTranscriptPath: string; projectPath: string; modifiedAtMs: number }>
  truncated: boolean
}

export interface SearchContentIndex {
  querySessionSuggestions(query: string, limit?: number): SearchContentSuggestions | null
  getSource(path: string): SearchContentSource | null
  listSources(): SearchContentSource[]
  countSources(): number
  replaceSource(
    source: SearchContentSourceWrite,
    documents: Iterable<SearchContentDocumentWrite>,
  ): void
  appendSource(
    source: SearchContentSourceWrite,
    documents: Iterable<SearchContentDocumentWrite>,
  ): void
  deleteSource(path: string): void
  getReadiness(): SearchContentReadiness | null
  setReadiness(readiness: SearchContentReadinessWrite): void
  query(
    query: string,
    options?: SearchContentQueryOptions,
  ): SearchContentQueryResult | null
}

type SourceRow = {
  path: string
  project_path: string
  owner_session_id: string
  owner_transcript_path: string
  modified_at_ms: number
  size_bytes: number
  mtime_ms: number
  file_identity: string | null
  fingerprint: string
  indexed_bytes: number
  indexed_lines: number
  parser_version: number
  state: SearchContentSourceState
  last_error_code: string | null
  updated_at_ms: number
}

type ReadinessRow = {
  scope: string
  state: SearchContentReadinessState
  generation: number
  discovered: number
  indexed: number
  degraded: number
  last_error_code: string | null
  updated_at_ms: number
}

type MatchRow = {
  owner_rank: number
  owner_match_count: number
  source_path: string
  owner_session_id: string
  owner_transcript_path: string
  project_path: string
  modified_at_ms: number
  byte_start: number
  byte_length: number
  source_size_bytes: number
  source_mtime_ms: number
  source_file_identity: string | null
  source_fingerprint: string
  source_indexed_bytes: number
  source_parser_version: number
  jsonl_line: number
  segment_index: number
  role: SearchContentRole
  message_id: string | null
  timestamp: string | null
  body: string
}

const DEFAULT_SESSION_LIMIT = 50
const MAX_SESSION_LIMIT = 100
const DEFAULT_MATCHES_PER_SESSION = 5
const MAX_MATCHES_PER_SESSION = 20

export function normalizeSearchContent(value: string): string {
  return value.toLowerCase()
}

function clampInteger(
  value: number | undefined,
  fallback: number,
  maximum: number,
): number {
  if (!Number.isFinite(value)) return fallback
  return Math.max(1, Math.min(maximum, Math.trunc(value!)))
}

function sourceFromRow(row: SourceRow): SearchContentSource {
  return {
    path: row.path,
    projectPath: row.project_path,
    ownerSessionId: row.owner_session_id,
    ownerTranscriptPath: row.owner_transcript_path,
    modifiedAtMs: row.modified_at_ms,
    sizeBytes: row.size_bytes,
    mtimeMs: row.mtime_ms,
    fileIdentity: row.file_identity,
    fingerprint: row.fingerprint,
    indexedBytes: row.indexed_bytes,
    indexedLines: row.indexed_lines,
    parserVersion: row.parser_version,
    state: row.state,
    lastErrorCode: row.last_error_code,
    updatedAtMs: row.updated_at_ms,
  }
}

function readinessFromRow(row: ReadinessRow): SearchContentReadiness {
  return {
    scope: row.scope,
    state: row.state,
    generation: row.generation,
    discovered: row.discovered,
    indexed: row.indexed,
    degraded: row.degraded,
    lastErrorCode: row.last_error_code,
    updatedAtMs: row.updated_at_ms,
  }
}

function upsertSource(
  writer: SearchContentWriteOperation,
  source: SearchContentSourceWrite,
): void {
  writer.run(`
    INSERT INTO search_sources (
      path, project_path, owner_session_id, owner_transcript_path,
      modified_at_ms, size_bytes, mtime_ms, file_identity, fingerprint,
      indexed_bytes, indexed_lines, parser_version, state,
      last_error_code, updated_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(path) DO UPDATE SET
      project_path = excluded.project_path,
      owner_session_id = excluded.owner_session_id,
      owner_transcript_path = excluded.owner_transcript_path,
      modified_at_ms = excluded.modified_at_ms,
      size_bytes = excluded.size_bytes,
      mtime_ms = excluded.mtime_ms,
      file_identity = excluded.file_identity,
      fingerprint = excluded.fingerprint,
      indexed_bytes = excluded.indexed_bytes,
      indexed_lines = excluded.indexed_lines,
      parser_version = excluded.parser_version,
      state = excluded.state,
      last_error_code = excluded.last_error_code,
      updated_at_ms = excluded.updated_at_ms
  `,
  source.path,
  source.projectPath,
  source.ownerSessionId,
  source.ownerTranscriptPath,
  source.modifiedAtMs,
  source.sizeBytes,
  source.mtimeMs,
  source.fileIdentity,
  source.fingerprint,
  source.indexedBytes,
  source.indexedLines,
  source.parserVersion,
  source.state,
  source.lastErrorCode,
  source.updatedAtMs)
}

function insertDocuments(
  writer: SearchContentWriteOperation,
  sourcePath: string,
  documents: Iterable<SearchContentDocumentWrite>,
): void {
  for (const document of documents) {
    writer.run(`
      INSERT INTO search_documents (
        source_path, jsonl_line, byte_start, byte_length, segment_index,
        role, message_id, timestamp, body, normalized_body
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    sourcePath,
    document.jsonlLine,
    document.byteStart,
    document.byteLength,
    document.segmentIndex,
    document.role,
    document.messageId,
    document.timestamp,
    document.body,
    document.normalizedBody)
  }
}

// Keep these functions closed over their explicit arguments so the exact same
// SQL implementation can run in the inline compiled-safe commit worker.
function applySearchSource(
  writer: SearchContentWriteOperation,
  source: SearchContentSourceWrite,
  documents: Iterable<SearchContentDocumentWrite>,
  append: boolean,
  upsert: typeof upsertSource,
  insert: typeof insertDocuments,
): void {
  if (append && !writer.get('SELECT path FROM search_sources WHERE path = ?', source.path)) throw new Error('Cannot append an unindexed search source')
  upsert(writer, source)
  if (!append) writer.run('DELETE FROM search_documents WHERE source_path = ?', source.path)
  insert(writer, source.path, documents)
}

export function searchContentCommitFunctions(): string {
  return `const upsert = (${upsertSource.toString()}); const insert = (${insertDocuments.toString()}); const applySource = (${applySearchSource.toString()});`
}

function ftsPhrase(value: string): string {
  return `"${value.replace(/"/g, '""')}"`
}

export function createSearchContentIndex(
  database: SearchContentDatabase,
  options: { scope: string; now?: () => number },
): SearchContentIndex {
  const now = options.now ?? Date.now

  return {
    getSource(path) {
      const row = database.read(reader => reader.get<SourceRow>(
        'SELECT * FROM search_sources WHERE path = ?',
        path,
      ))
      return row ? sourceFromRow(row) : null
    },
    listSources() {
      return database.read(reader => reader.all<SourceRow>(
        'SELECT * FROM search_sources ORDER BY path',
      )).map(sourceFromRow)
    },
    countSources() {
      return database.read(reader => reader.get<{ total: number }>(
        'SELECT COUNT(*) AS total FROM search_sources',
      ))?.total ?? 0
    },
    replaceSource(source, documents) {
      database.transaction(writer => applySearchSource(writer, source, documents, false, upsertSource, insertDocuments))
    },
    appendSource(source, documents) {
      database.transaction(writer => applySearchSource(writer, source, documents, true, upsertSource, insertDocuments))
    },
    deleteSource(path) {
      database.transaction(writer => {
        writer.run('DELETE FROM search_sources WHERE path = ?', path)
      })
    },
    getReadiness() {
      const row = database.read(reader => reader.get<ReadinessRow>(
        'SELECT * FROM search_backfill_state WHERE scope = ?',
        options.scope,
      ))
      return row ? readinessFromRow(row) : null
    },
    setReadiness(readiness) {
      database.transaction(writer => {
        const current = writer.get<{ generation: number }>(
          'SELECT generation FROM search_backfill_state WHERE scope = ?',
          options.scope,
        )
        writer.run(`
          INSERT INTO search_backfill_state (
            scope, state, generation, discovered, indexed, degraded,
            last_error_code, updated_at_ms
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(scope) DO UPDATE SET
            state = excluded.state,
            generation = excluded.generation,
            discovered = excluded.discovered,
            indexed = excluded.indexed,
            degraded = excluded.degraded,
            last_error_code = excluded.last_error_code,
            updated_at_ms = excluded.updated_at_ms
        `,
        options.scope,
        readiness.state,
        readiness.generation ?? current?.generation ?? 0,
        readiness.discovered,
        readiness.indexed,
        readiness.degraded ?? 0,
        readiness.lastErrorCode ?? null,
        readiness.updatedAtMs ?? now())
      })
    },
    querySessionSuggestions(query, requestedLimit) {
      const normalized = normalizeSearchContent(query.trim())
      if (!normalized) return { sessions: [], truncated: false }
      const ready = database.read(reader => reader.get<ReadinessRow>(
        'SELECT * FROM search_backfill_state WHERE scope = ?', options.scope,
      ))
      if (ready?.state !== 'ready') return null
      const limit = clampInteger(requestedLimit, DEFAULT_SESSION_LIMIT, MAX_SESSION_LIMIT)
      const useFts = Array.from(normalized).length >= 3
      // Scan global FTS matches once. Correlating MATCH with each source
      // repeats that global scan for every transcript on common long queries.
      // Short queries instead seek each source and stop at its first segment.
      const selection = useFts
        ? `FROM search_documents_fts
           JOIN search_documents AS document ON document.id = search_documents_fts.rowid
           JOIN search_sources AS source ON source.path = document.source_path
           WHERE search_documents_fts MATCH ? AND source.state = 'ready'
             AND instr(document.normalized_body, ?) > 0`
        : `FROM search_sources AS source
           WHERE source.state = 'ready' AND EXISTS (
             SELECT 1 FROM search_documents AS document
             WHERE document.source_path = source.path AND instr(document.normalized_body, ?) > 0
           )`
      const rows = database.read(reader => reader.all<{
        owner_session_id: string; owner_transcript_path: string; project_path: string; modified_at_ms: number
      }>(`
        SELECT source.owner_session_id, source.owner_transcript_path,
          source.project_path, MAX(source.modified_at_ms) AS modified_at_ms
        ${selection}
        GROUP BY source.owner_transcript_path
        ORDER BY modified_at_ms DESC, source.owner_transcript_path
        LIMIT ?
      `, ...(useFts ? [ftsPhrase(normalized)] : []), normalized, limit + 1))
      return {
        sessions: rows.slice(0, limit).map(row => ({ ownerSessionId: row.owner_session_id,
          ownerTranscriptPath: row.owner_transcript_path, projectPath: row.project_path, modifiedAtMs: row.modified_at_ms })),
        truncated: rows.length > limit,
      }
    },
    query(query, queryOptions = {}) {
      const literalQuery = query.trim()
      const normalizedQuery = normalizeSearchContent(literalQuery)
      if (!normalizedQuery) return { sessions: [], truncated: false }
      const readinessRow = database.read(reader => reader.get<ReadinessRow>(
        'SELECT * FROM search_backfill_state WHERE scope = ?',
        options.scope,
      ))
      const readiness = readinessRow ? readinessFromRow(readinessRow) : null
      if (!readiness || readiness.state !== 'ready') return null

      const limit = clampInteger(
        queryOptions.limit,
        DEFAULT_SESSION_LIMIT,
        MAX_SESSION_LIMIT,
      )
      const matchesPerSession = clampInteger(
        queryOptions.matchesPerSession,
        DEFAULT_MATCHES_PER_SESSION,
        MAX_MATCHES_PER_SESSION,
      )
      const filters: string[] = [
        "source.state = 'ready'",
        queryOptions.caseSensitive
          ? 'instr(document.body, ?) > 0'
          : 'instr(document.normalized_body, ?) > 0',
      ]
      const bindings: SearchContentBinding[] = []
      const useFts = Array.from(normalizedQuery).length >= 3
      if (useFts) bindings.push(ftsPhrase(normalizedQuery))
      bindings.push(queryOptions.caseSensitive ? literalQuery : normalizedQuery)
      if (queryOptions.project !== undefined) {
        filters.push('source.project_path = ?')
        bindings.push(queryOptions.project)
      }
      if (queryOptions.modifiedAfterMs !== undefined) {
        filters.push('source.modified_at_ms >= ?')
        bindings.push(queryOptions.modifiedAfterMs)
      }
      if (queryOptions.modifiedBeforeMs !== undefined) {
        filters.push('source.modified_at_ms <= ?')
        bindings.push(queryOptions.modifiedBeforeMs)
      }
      bindings.push(limit + 1, matchesPerSession)

      const fromClause = useFts
        ? `search_documents_fts
           JOIN search_documents AS document
             ON document.id = search_documents_fts.rowid
           JOIN search_sources AS source
             ON source.path = document.source_path`
        : `search_documents AS document
           JOIN search_sources AS source
             ON source.path = document.source_path`
      const ftsFilter = useFts ? 'search_documents_fts MATCH ? AND ' : ''
      const sql = `
        WITH matched AS MATERIALIZED (
          SELECT
            document.id,
            document.source_path,
            source.owner_session_id,
            source.owner_transcript_path,
            source.project_path,
            source.modified_at_ms,
            source.size_bytes AS source_size_bytes,
            source.mtime_ms AS source_mtime_ms,
            source.file_identity AS source_file_identity,
            source.fingerprint AS source_fingerprint,
            source.indexed_bytes AS source_indexed_bytes,
            source.parser_version AS source_parser_version,
            document.jsonl_line,
            document.byte_start,
            document.byte_length,
            document.segment_index,
            document.role,
            document.message_id,
            document.timestamp,
            document.body
          FROM ${fromClause}
          WHERE ${ftsFilter}${filters.join(' AND ')}
        ),
        owner_counts AS (
          SELECT
            owner_transcript_path,
            MAX(modified_at_ms) AS owner_modified_at_ms,
            COUNT(*) AS owner_match_count
          FROM matched
          GROUP BY owner_transcript_path
        ),
        limited_owners AS (
          SELECT
            owner_transcript_path,
            owner_match_count,
            ROW_NUMBER() OVER (
              ORDER BY owner_modified_at_ms DESC, owner_transcript_path
            ) AS owner_rank
          FROM owner_counts
          ORDER BY owner_modified_at_ms DESC, owner_transcript_path
          LIMIT ?
        ),
        ranked_matches AS (
          SELECT
            matched.*,
            ROW_NUMBER() OVER (
              PARTITION BY matched.owner_transcript_path
              ORDER BY matched.modified_at_ms DESC,
                matched.source_path, matched.jsonl_line, matched.segment_index
            ) AS match_rank
          FROM matched
          JOIN limited_owners USING (owner_transcript_path)
        )
        SELECT
          limited_owners.owner_rank,
          limited_owners.owner_match_count,
          ranked_matches.source_path,
          ranked_matches.owner_session_id,
          ranked_matches.owner_transcript_path,
          ranked_matches.project_path,
          ranked_matches.modified_at_ms,
          ranked_matches.source_size_bytes,
          ranked_matches.source_mtime_ms,
          ranked_matches.source_file_identity,
          ranked_matches.source_fingerprint,
          ranked_matches.source_indexed_bytes,
          ranked_matches.source_parser_version,
          ranked_matches.jsonl_line,
          ranked_matches.byte_start,
          ranked_matches.byte_length,
          ranked_matches.segment_index,
          ranked_matches.role,
          ranked_matches.message_id,
          ranked_matches.timestamp,
          ranked_matches.body
        FROM ranked_matches
        JOIN limited_owners USING (owner_transcript_path)
        WHERE ranked_matches.match_rank <= ?
        ORDER BY limited_owners.owner_rank, ranked_matches.match_rank
      `

      const rows = database.read(reader => reader.all<MatchRow>(sql, ...bindings))

      const grouped = new Map<number, SearchContentSessionMatches>()
      for (const row of rows) {
        let session = grouped.get(row.owner_rank)
        if (!session) {
          session = {
            ownerSessionId: row.owner_session_id,
            ownerTranscriptPath: row.owner_transcript_path,
            projectPath: row.project_path,
            modifiedAtMs: row.modified_at_ms,
            matchCount: row.owner_match_count,
            matches: [],
          }
          grouped.set(row.owner_rank, session)
        }
        session.matches.push({
          sourcePath: row.source_path,
          ownerSessionId: row.owner_session_id,
          ownerTranscriptPath: row.owner_transcript_path,
          projectPath: row.project_path,
          modifiedAtMs: row.modified_at_ms,
          byteStart: row.byte_start,
          byteLength: row.byte_length,
          sourceSizeBytes: row.source_size_bytes,
          sourceMtimeMs: row.source_mtime_ms,
          sourceFileIdentity: row.source_file_identity,
          sourceFingerprint: row.source_fingerprint,
          sourceIndexedBytes: row.source_indexed_bytes,
          sourceParserVersion: row.source_parser_version,
          lineNumber: row.jsonl_line,
          segmentIndex: row.segment_index,
          role: row.role,
          messageId: row.message_id,
          timestamp: row.timestamp,
          body: row.body,
        })
      }

      const sessions = [...grouped.values()]
      return {
        sessions: sessions.slice(0, limit),
        truncated: sessions.length > limit,
      }
    },
  }
}
