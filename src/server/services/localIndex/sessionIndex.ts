import type { SessionProtocolState } from '../../../shared/sessionProtocol.js'
import type { LocalIndexDatabase } from './database.js'
import { createActivityIndex, type ActivityIndex } from './activityIndex.js'
import type {
  ClaudeCodeStats,
  StatsDateRange,
} from '../../../utils/stats.js'
import type {
  LocalIndexMode,
  LocalIndexStatus,
  PersistedRepositorySession,
  PersistedWorktreeSession,
  TranscriptEntryLocator,
  TranscriptProjection,
} from './types.js'

export type IndexedSessionRow = {
  transcriptPath: string
  id: string
  title: string
  createdAt: string
  modifiedAt: string
  messageCount: number
  projectPath: string
  workDir: string | null
  permissionMode?: string
  runtimeProviderId?: string | null
  runtimeModelId?: string
  effortLevel?: string
  sessionApiFormat?: SessionProtocolState
  repository?: PersistedRepositorySession
  worktreeSession?: PersistedWorktreeSession | null
}

export type SessionIndexPage = {
  sessions: IndexedSessionRow[]
  total: number
}

export type SessionFileMatch = {
  filePath: string
  projectDir: string
}

export type SessionSearchCandidateFilters = {
  project?: string
  modifiedAfterMs?: number
  modifiedBeforeMs?: number
}

export type IndexedSessionSearchCandidate = Pick<
  IndexedSessionRow,
  'transcriptPath' | 'id' | 'title' | 'modifiedAt' | 'projectPath' | 'workDir'
>

export type SessionEntryLocatorPage = {
  source: SessionSourceRecord
  entries: TranscriptEntryLocator[]
}

export interface SessionIndexReader {
  listSessions(options?: {
    project?: string
    limit?: number
    offset?: number
  }): SessionIndexPage
  findSessionFiles(sessionId: string): SessionFileMatch[]
  findSearchCandidates?(
    filters: SessionSearchCandidateFilters,
  ): IndexedSessionSearchCandidate[] | null
}

export interface LocalIndexGateway extends SessionIndexReader {
  start(): Promise<void>
  stop(): Promise<void>
  getMode(): LocalIndexMode
  getPublicStatus(): LocalIndexStatus
  isSessionScopeReady(): boolean
  isActivityScopeReady?(): boolean
  getActivityStats?(range: StatsDateRange, now?: Date): ClaudeCodeStats | null
  rebuild(): Promise<LocalIndexStatus>
  getSessionEntryLocators?(
    transcriptPath: string,
    entryTypes?: string[],
  ): SessionEntryLocatorPage | null
}

export type SessionSourceRecord = {
  path: string
  size: number
  mtimeMs: number
  fileIdentity: string | null
  fingerprint: string
  indexedBytes: number
  parserVersion: number
  state: 'ready' | 'pending' | 'degraded'
  lastErrorCode: string | null
  updatedAtMs: number
}

export type PersistedBackfillState = {
  scope: string
  state: string
  watermark: string | null
  discovered: number
  indexed: number
  degraded: number
  lastErrorCode: string | null
  updatedAtMs: number
}

export interface SessionIndex extends SessionIndexReader, ActivityIndex {
  getSource(path: string): SessionSourceRecord | null
  listSources(): SessionSourceRecord[]
  countSources(): number
  getProjectionSeed(path: string): TranscriptProjection | null
  getBackfillState(scope: string): PersistedBackfillState | null
  getSessionEntryLocators(
    transcriptPath: string,
    entryTypes?: string[],
  ): SessionEntryLocatorPage | null
}

type SessionRow = {
  transcript_path: string
  session_id: string
  project_path: string
  title: string
  created_at: string
  modified_at: string
  modified_at_ms: number
  message_count: number
  work_dir: string | null
  permission_mode: string | null
  runtime_provider_id: string | null
  runtime_provider_present: number
  runtime_model_id: string | null
  effort_level: string | null
  session_api_format: SessionProtocolState | null
  repository_json: string | null
  worktree_session_json: string | null
}

type SourceRow = {
  path: string
  size_bytes: number
  mtime_ms: number
  file_identity: string | null
  prefix_hash: string
  indexed_bytes: number
  parser_version: number
  state: SessionSourceRecord['state']
  last_error_code: string | null
  updated_at_ms: number
}

type BackfillRow = {
  scope: string
  state: string
  watermark: string | null
  discovered: number
  indexed: number
  degraded: number
  last_error_code: string | null
  updated_at_ms: number
}

type SessionEntryRow = {
  ordinal: number
  jsonl_line: number
  byte_start: number
  byte_length: number
  entry_type: string
  message_id: string | null
  role: string | null
  timestamp: string | null
  parent_tool_use_id: string | null
}

function boundedInteger(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value)) return fallback
  return Math.max(0, Math.trunc(value!))
}

function sessionFromRow(row: SessionRow): IndexedSessionRow {
  const repository = parseStoredJson<PersistedRepositorySession>(row.repository_json)
  const worktreeSession = row.worktree_session_json === 'null'
    ? null
    : parseStoredJson<PersistedWorktreeSession>(row.worktree_session_json)
  return {
    transcriptPath: row.transcript_path,
    id: row.session_id,
    title: row.title,
    createdAt: row.created_at,
    modifiedAt: row.modified_at,
    messageCount: row.message_count,
    projectPath: row.project_path,
    workDir: row.work_dir,
    ...(row.permission_mode ? { permissionMode: row.permission_mode } : {}),
    ...(row.runtime_provider_present === 1
      ? { runtimeProviderId: row.runtime_provider_id }
      : {}),
    ...(row.runtime_model_id ? { runtimeModelId: row.runtime_model_id } : {}),
    ...(row.effort_level ? { effortLevel: row.effort_level } : {}),
    ...(row.session_api_format ? { sessionApiFormat: row.session_api_format } : {}),
    ...(repository ? { repository } : {}),
    ...(row.worktree_session_json !== null ? { worktreeSession } : {}),
  }
}

function sourceFromRow(row: SourceRow): SessionSourceRecord {
  return {
    path: row.path,
    size: row.size_bytes,
    mtimeMs: row.mtime_ms,
    fileIdentity: row.file_identity,
    fingerprint: row.prefix_hash,
    indexedBytes: row.indexed_bytes,
    parserVersion: row.parser_version,
    state: row.state,
    lastErrorCode: row.last_error_code,
    updatedAtMs: row.updated_at_ms,
  }
}

function parseStoredJson<T>(value: string | null | undefined): T | undefined {
  if (value === null || value === undefined) return undefined
  try {
    return JSON.parse(value) as T
  } catch {
    return undefined
  }
}

function backfillFromRow(row: BackfillRow): PersistedBackfillState {
  return {
    scope: row.scope,
    state: row.state,
    watermark: row.watermark,
    discovered: row.discovered,
    indexed: row.indexed,
    degraded: row.degraded,
    lastErrorCode: row.last_error_code,
    updatedAtMs: row.updated_at_ms,
  }
}

function locatorFromRow(row: SessionEntryRow): TranscriptEntryLocator {
  return {
    ordinal: row.ordinal,
    jsonlLine: row.jsonl_line,
    byteStart: row.byte_start,
    byteLength: row.byte_length,
    entryType: row.entry_type,
    messageId: row.message_id,
    role: row.role,
    timestamp: row.timestamp,
    parentToolUseId: row.parent_tool_use_id,
  }
}

export function createSessionIndex(database: LocalIndexDatabase): SessionIndex {
  const activityIndex = createActivityIndex(database)
  return {
    ...activityIndex,
    listSessions(options): SessionIndexPage {
      const limit = boundedInteger(options?.limit, 50)
      const offset = boundedInteger(options?.offset, 0)
      const project = options?.project

      return database.read(operation => {
        const total = project === undefined
          ? operation.get<{ total: number }>('SELECT COUNT(*) AS total FROM sessions')?.total ?? 0
          : operation.get<{ total: number }>(
            'SELECT COUNT(*) AS total FROM sessions WHERE project_path = ?',
            project,
          )?.total ?? 0
        const rows = project === undefined
          ? operation.all<SessionRow>(`
              SELECT transcript_path, session_id, project_path, title, created_at,
                modified_at, message_count, work_dir, permission_mode,
                runtime_provider_id, runtime_provider_present,
                runtime_model_id, effort_level, session_api_format,
                repository_json, worktree_session_json
              FROM sessions
              ORDER BY modified_at_ms DESC, session_id ASC, transcript_path ASC
              LIMIT ? OFFSET ?
            `, limit, offset)
          : operation.all<SessionRow>(`
              SELECT transcript_path, session_id, project_path, title, created_at,
                modified_at, message_count, work_dir, permission_mode,
                runtime_provider_id, runtime_provider_present,
                runtime_model_id, effort_level, session_api_format,
                repository_json, worktree_session_json
              FROM sessions
              WHERE project_path = ?
              ORDER BY modified_at_ms DESC, session_id ASC, transcript_path ASC
              LIMIT ? OFFSET ?
            `, project, limit, offset)

        return { sessions: rows.map(sessionFromRow), total }
      })
    },

    findSessionFiles(sessionId): SessionFileMatch[] {
      return database.read(operation => operation.all<{
        transcript_path: string
        project_path: string
      }>(`
          SELECT sessions.transcript_path, sessions.project_path
          FROM sessions
          JOIN source_files ON source_files.path = sessions.transcript_path
          WHERE sessions.session_id = ?
          ORDER BY source_files.mtime_ms DESC, sessions.transcript_path ASC
        `, sessionId).map(row => ({
        filePath: row.transcript_path,
        projectDir: row.project_path,
      })))
    },

    findSearchCandidates(filters): IndexedSessionSearchCandidate[] {
      const clauses: string[] = []
      const values: Array<string | number> = []
      if (filters.project !== undefined) {
        clauses.push('project_path = ?')
        values.push(filters.project)
      }
      if (filters.modifiedAfterMs !== undefined) {
        clauses.push('modified_at_ms >= ?')
        values.push(filters.modifiedAfterMs)
      }
      if (filters.modifiedBeforeMs !== undefined) {
        clauses.push('modified_at_ms <= ?')
        values.push(filters.modifiedBeforeMs)
      }
      const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''
      return database.read(operation => operation.all<Pick<
        SessionRow,
        | 'transcript_path'
        | 'session_id'
        | 'project_path'
        | 'title'
        | 'modified_at'
        | 'work_dir'
      >>(`
          SELECT transcript_path, session_id, project_path, title,
            modified_at, work_dir
          FROM sessions
          ${where}
          ORDER BY modified_at_ms DESC, session_id ASC, transcript_path ASC
        `, ...values).map(row => ({
        transcriptPath: row.transcript_path,
        id: row.session_id,
        title: row.title,
        modifiedAt: row.modified_at,
        projectPath: row.project_path,
        workDir: row.work_dir,
      })))
    },

    getSource(path): SessionSourceRecord | null {
      return database.read(operation => {
        const row = operation.get<SourceRow>(`
          SELECT path, size_bytes, mtime_ms, file_identity, prefix_hash,
            indexed_bytes, parser_version, state, last_error_code, updated_at_ms
          FROM source_files
          WHERE path = ?
        `, path)
        return row ? sourceFromRow(row) : null
      })
    },

    listSources(): SessionSourceRecord[] {
      return database.read(operation => operation.all<SourceRow>(`
          SELECT path, size_bytes, mtime_ms, file_identity, prefix_hash,
            indexed_bytes, parser_version, state, last_error_code, updated_at_ms
          FROM source_files
          ORDER BY path ASC
        `).map(sourceFromRow))
    },

    countSources(): number {
      return database.read(operation => operation.get<{ count: number }>(`
          SELECT COUNT(*) AS count
          FROM source_files
        `)?.count ?? 0)
    },

    getProjectionSeed(path): TranscriptProjection | null {
      return database.read(operation => {
        const row = operation.get<SessionRow & {
          indexed_bytes: number
          size_bytes: number
        }>(`
          SELECT sessions.transcript_path, sessions.session_id,
            sessions.project_path, sessions.title, sessions.created_at,
            sessions.modified_at, sessions.modified_at_ms,
            sessions.message_count, sessions.work_dir,
            sessions.permission_mode, sessions.runtime_provider_id,
            sessions.runtime_provider_present,
            sessions.runtime_model_id, sessions.effort_level, sessions.session_api_format,
            sessions.repository_json, sessions.worktree_session_json,
            source_files.indexed_bytes, source_files.size_bytes
          FROM sessions
          JOIN source_files ON source_files.path = sessions.transcript_path
          WHERE sessions.transcript_path = ?
        `, path)
        if (!row) return null
        const repository = parseStoredJson<NonNullable<TranscriptProjection['summary']['repository']>>(
          row.repository_json,
        )
        const worktreeSession = row.worktree_session_json === 'null'
          ? null
          : parseStoredJson<NonNullable<TranscriptProjection['summary']['worktreeSession']>>(
            row.worktree_session_json,
          )
        return {
          summary: {
            title: row.title,
            createdAt: row.created_at,
            modifiedAt: row.modified_at,
            messageCount: row.message_count,
            workDir: row.work_dir,
            ...(row.permission_mode ? { permissionMode: row.permission_mode } : {}),
            ...(row.runtime_provider_present === 1
              ? { runtimeProviderId: row.runtime_provider_id }
              : {}),
            ...(row.runtime_model_id ? { runtimeModelId: row.runtime_model_id } : {}),
            ...(row.effort_level ? { effortLevel: row.effort_level } : {}),
            ...(row.session_api_format ? { sessionApiFormat: row.session_api_format } : {}),
            ...(repository ? { repository } : {}),
            ...(row.worktree_session_json !== null
              ? { worktreeSession }
              : {}),
          },
          indexedBytes: row.indexed_bytes,
          pendingTailBytes: row.size_bytes - row.indexed_bytes,
          // v1 intentionally does not persist reducer internals. A process restart
          // therefore rebuilds this source before accepting a later append.
          malformedLineCount: 0,
        }
      })
    },

    getBackfillState(scope): PersistedBackfillState | null {
      return database.read(operation => {
        const row = operation.get<BackfillRow>(`
          SELECT scope, state, watermark, discovered, indexed, degraded,
            last_error_code, updated_at_ms
          FROM backfill_state
          WHERE scope = ?
        `, scope)
        return row ? backfillFromRow(row) : null
      })
    },

    getSessionEntryLocators(transcriptPath, entryTypes): SessionEntryLocatorPage | null {
      const normalizedTypes = entryTypes === undefined
        ? undefined
        : [...new Set(entryTypes.filter(type => type.length > 0))].slice(0, 32)
      return database.read(operation => {
        const source = operation.get<SourceRow>(`
          SELECT path, size_bytes, mtime_ms, file_identity, prefix_hash,
            indexed_bytes, parser_version, state, last_error_code, updated_at_ms
          FROM source_files
          WHERE path = ?
        `, transcriptPath)
        if (!source) return null

        let rows: SessionEntryRow[]
        if (normalizedTypes === undefined) {
          rows = operation.all<SessionEntryRow>(`
            SELECT ordinal, jsonl_line, byte_start, byte_length, entry_type,
              message_id, role, timestamp, parent_tool_use_id
            FROM session_entries
            WHERE transcript_path = ?
            ORDER BY ordinal ASC
          `, transcriptPath)
        } else if (normalizedTypes.length === 0) {
          rows = []
        } else {
          const placeholders = normalizedTypes.map(() => '?').join(', ')
          rows = operation.all<SessionEntryRow>(`
            SELECT ordinal, jsonl_line, byte_start, byte_length, entry_type,
              message_id, role, timestamp, parent_tool_use_id
            FROM session_entries
            WHERE transcript_path = ? AND entry_type IN (${placeholders})
            ORDER BY ordinal ASC
          `, transcriptPath, ...normalizedTypes)
        }

        return {
          source: sourceFromRow(source),
          entries: rows.map(locatorFromRow),
        }
      })
    },
  }
}
