import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { getCcHahaDir, getClaudeConfigHomeDir } from '../../../utils/envUtils.js'
import {
  LOCAL_INDEX_BUSY_TIMEOUT_MS,
  prepareManagedDatabasePath,
} from './managedDatabasePath.js'
import {
  assertScheduledRunIndexSchemaSupported,
  migrateScheduledRunIndexDatabase,
} from './scheduledRunMigrations.js'

export type ScheduledRunRecord = {
  id: string
  taskId: string
  taskName: string
  startedAt: string
  completedAt?: string
  status: string
  prompt: string
  output?: string
  error?: string
  exitCode?: number
  durationMs?: number
  sessionId?: string
  [key: string]: unknown
}

export type ScheduledRunSummary = {
  id: string
  taskId: string
  startedAt: string
  completedAt?: string
  status: string
  hasOutput: boolean
  hasError: boolean
  exitCode?: number
  durationMs?: number
  sessionId?: string
}

export type ScheduledRunIndexStatus = {
  sourcePath: string
  sourceSize: number
  sourceMtimeMs: number
  sourceFingerprint: string
  revision: number
  state: 'ready' | 'degraded'
  lastErrorCode: string | null
}

export interface ScheduledRunIndex {
  replaceAll(input: {
    runs: ScheduledRunRecord[]
    source: {
      path: string
      size: number
      mtimeMs: number
      fingerprint: string
    }
    failAfterRows?: number
  }): ScheduledRunIndexStatus
  list(options?: {
    taskId?: string
    limit?: number
    cursor?: string
    summaryOnly?: boolean
    nonterminalOnly?: boolean
    completedAfterMs?: number
  }): {
    runs: ScheduledRunSummary[]
    nextCursor?: string
    revision: number
    revisionToken: string
    reset?: boolean
  }
  getStatus(): ScheduledRunIndexStatus
  markDegraded(errorCode: string): void
  close(): void
}

type SourceRow = {
  source_path: string
  source_size: number
  source_mtime_ms: number
  source_fingerprint: string
  revision: number
  state: 'ready' | 'degraded'
  last_error_code: string | null
}

type RunRow = {
  run_id: string
  task_id: string
  started_at: string
  completed_at: string | null
  status: string
  has_output: number
  has_error: number
  exit_code: number | null
  duration_ms: number | null
  session_id: string | null
  source_ordinal: number
  started_at_ms: number
}

type CursorPosition = [number, number, string]
type VersionedCursor = [1, string, number, number, string]

function stableToken(value: string): string {
  return createHash('sha256').update(value).digest('base64url')
}

function queryScope(options: {
  taskId?: string
  nonterminalOnly?: boolean
  completedAfterMs?: number
}): string {
  return stableToken(JSON.stringify({
    taskId: options.taskId ?? null,
    nonterminalOnly: options.nonterminalOnly === true,
    completedAfterMs: options.completedAfterMs ?? null,
  }))
}

function cursorRevisionFor(
  sourceGeneration: string,
  options: {
    taskId?: string
    nonterminalOnly?: boolean
    completedAfterMs?: number
  },
): string {
  return `${sourceGeneration}:scope:${queryScope(options)}`
}

function encodeCursor(position: CursorPosition, revision: string): string {
  return Buffer.from(JSON.stringify([
    1,
    revision,
    position[0],
    position[1],
    position[2],
  ] satisfies VersionedCursor)).toString('base64url')
}

function decodeCursor(
  cursor: string | undefined,
  expectedRevision: string,
): { position: CursorPosition | null; reset: boolean } {
  if (!cursor) return { position: null, reset: false }
  try {
    const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
    if (
      Array.isArray(decoded) &&
      decoded.length === 5 &&
      decoded[0] === 1 &&
      typeof decoded[1] === 'string' &&
      typeof decoded[2] === 'number' &&
      Number.isFinite(decoded[2]) &&
      typeof decoded[3] === 'number' &&
      Number.isSafeInteger(decoded[3]) &&
      decoded[3] >= 0 &&
      typeof decoded[4] === 'string'
    ) {
      if (decoded[1] !== expectedRevision) return { position: null, reset: true }
      return { position: [decoded[2], decoded[3], decoded[4]], reset: false }
    }
  } catch {
    // Invalid and pre-versioned cursors safely restart from the current head.
  }
  return { position: null, reset: true }
}

function statusFromRow(row: SourceRow | null): ScheduledRunIndexStatus {
  if (!row) {
    return {
      sourcePath: '',
      sourceSize: 0,
      sourceMtimeMs: 0,
      sourceFingerprint: '',
      revision: 0,
      state: 'degraded',
      lastErrorCode: 'SCHEDULED_RUN_INDEX_NOT_BUILT',
    }
  }
  return {
    sourcePath: row.source_path,
    sourceSize: row.source_size,
    sourceMtimeMs: row.source_mtime_ms,
    sourceFingerprint: row.source_fingerprint,
    revision: row.revision,
    state: row.state,
    lastErrorCode: row.last_error_code,
  }
}

function summaryFromRow(row: RunRow): ScheduledRunSummary {
  return {
    id: row.run_id,
    taskId: row.task_id,
    startedAt: row.started_at,
    ...(row.completed_at === null ? {} : { completedAt: row.completed_at }),
    status: row.status,
    hasOutput: row.has_output === 1,
    hasError: row.has_error === 1,
    ...(row.exit_code === null ? {} : { exitCode: row.exit_code }),
    ...(row.duration_ms === null ? {} : { durationMs: row.duration_ms }),
    ...(row.session_id === null ? {} : { sessionId: row.session_id }),
  }
}

function summaryFromRecord(run: ScheduledRunRecord): ScheduledRunSummary {
  return {
    id: run.id,
    taskId: run.taskId,
    startedAt: run.startedAt,
    ...(run.completedAt === undefined ? {} : { completedAt: run.completedAt }),
    status: run.status,
    hasOutput: typeof run.output === 'string',
    hasError: typeof run.error === 'string',
    ...(run.exitCode === undefined ? {} : { exitCode: run.exitCode }),
    ...(run.durationMs === undefined ? {} : { durationMs: run.durationMs }),
    ...(run.sessionId === undefined ? {} : { sessionId: run.sessionId }),
  }
}

export function paginateScheduledRunRecords(
  runs: ScheduledRunRecord[],
  options: {
    taskId?: string
    limit?: number
    cursor?: string
    summaryOnly?: boolean
    nonterminalOnly?: boolean
    completedAfterMs?: number
  } = {},
  cursorRevision = 'memory',
): {
  runs: Array<ScheduledRunRecord | ScheduledRunSummary>
  nextCursor?: string
  revisionToken: string
  reset?: boolean
} {
  const limit = Math.max(Math.trunc(options.limit ?? 100), 0)
  const revisionToken = cursorRevision
  const expectedCursorRevision = cursorRevisionFor(revisionToken, options)
  const decodedCursor = decodeCursor(options.cursor, expectedCursorRevision)
  const cursor = decodedCursor.position
  const ordered = runs
    .map((run, sourceOrdinal) => ({
      run,
      sourceOrdinal,
      startedAtMs: Number.isFinite(Date.parse(run.startedAt)) ? Date.parse(run.startedAt) : 0,
    }))
    .filter(item => !options.taskId || item.run.taskId === options.taskId)
    .filter(item => !options.nonterminalOnly || ![
      'completed',
      'failed',
      'timeout',
      'missed',
    ].includes(item.run.status))
    .filter(item => options.completedAfterMs === undefined || (
      ['completed', 'failed', 'timeout', 'missed'].includes(item.run.status) &&
      Number.isFinite(Date.parse(item.run.completedAt ?? item.run.startedAt)) &&
      Date.parse(item.run.completedAt ?? item.run.startedAt) >= options.completedAfterMs
    ))
    .sort((a, b) =>
      b.startedAtMs - a.startedAtMs ||
      a.sourceOrdinal - b.sourceOrdinal ||
      a.run.id.localeCompare(b.run.id),
    )
    .filter(item => !cursor ||
      item.startedAtMs < cursor[0] ||
      (item.startedAtMs === cursor[0] && item.sourceOrdinal > cursor[1]) ||
      (item.startedAtMs === cursor[0] && item.sourceOrdinal === cursor[1] && item.run.id > cursor[2]),
    )
  const selected = ordered.slice(0, limit)
  const hasMore = ordered.length > limit
  const tail = selected.at(-1)
  return {
    runs: options.summaryOnly
      ? selected.map(item => summaryFromRecord(item.run))
      : selected.map(item => item.run),
    ...(hasMore && tail
      ? {
          nextCursor: encodeCursor(
            [tail.startedAtMs, tail.sourceOrdinal, tail.run.id],
            expectedCursorRevision,
          ),
        }
      : {}),
    revisionToken,
    ...(decodedCursor.reset ? { reset: true } : {}),
  }
}

export function getScheduledRunIndexDatabasePath(): string {
  return join(getCcHahaDir(), 'db', 'scheduled-runs-v1.sqlite')
}

export function openScheduledRunIndex(options?: {
  path?: string
  scope?: string
}): ScheduledRunIndex {
  const databasePath = options?.path ?? getScheduledRunIndexDatabasePath()
  prepareManagedDatabasePath({
    databasePath,
    filename: 'scheduled-runs-v1.sqlite',
    scope: options?.scope ?? (options?.path ? undefined : getClaudeConfigHomeDir()),
  })
  const database = new Database(databasePath)
  try {
    assertScheduledRunIndexSchemaSupported(database)
    database.exec(`PRAGMA busy_timeout = ${LOCAL_INDEX_BUSY_TIMEOUT_MS}`)
    database.exec('PRAGMA journal_mode = WAL')
    database.exec('PRAGMA synchronous = NORMAL')
    database.exec('PRAGMA foreign_keys = ON')
    database.exec('PRAGMA wal_autocheckpoint = 1000')
    migrateScheduledRunIndexDatabase(database)
  } catch (error) {
    database.close(true)
    throw error
  }

  const statusStatement = database.query<SourceRow, []>(`
    SELECT source_path, source_size, source_mtime_ms, source_fingerprint,
      revision, state, last_error_code
    FROM scheduled_run_source WHERE singleton = 1
  `)
  let closed = false

  const getStatus = () => statusFromRow(statusStatement.get())

  return {
    replaceAll(input) {
      if (closed) throw new Error('Scheduled-run index database is closed')
      const revision = getStatus().revision + 1
      database.exec('BEGIN IMMEDIATE')
      try {
        database.exec('DELETE FROM scheduled_runs')
        const insert = database.query(`
          INSERT INTO scheduled_runs (
            run_id, task_id, started_at, started_at_ms, completed_at, completed_at_ms,
            status, has_output, has_error, exit_code, duration_ms, session_id,
            source_ordinal, revision
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        input.runs.forEach((run, ordinal) => {
          const startedAtMs = Date.parse(run.startedAt)
          const completedAtMs = Date.parse(run.completedAt ?? run.startedAt)
          insert.run(
            run.id,
            run.taskId,
            run.startedAt,
            Number.isFinite(startedAtMs) ? startedAtMs : 0,
            run.completedAt ?? null,
            Number.isFinite(completedAtMs) ? completedAtMs : null,
            run.status,
            typeof run.output === 'string' ? 1 : 0,
            typeof run.error === 'string' ? 1 : 0,
            run.exitCode ?? null,
            run.durationMs ?? null,
            run.sessionId ?? null,
            ordinal,
            revision,
          )
          if (input.failAfterRows === ordinal + 1) {
            throw new Error('injected scheduled-run projection failure')
          }
        })
        database.query(`
          INSERT INTO scheduled_run_source (
            singleton, source_path, source_size, source_mtime_ms,
            source_fingerprint, revision, state, last_error_code, updated_at_ms
          ) VALUES (1, ?, ?, ?, ?, ?, 'ready', NULL, ?)
          ON CONFLICT(singleton) DO UPDATE SET
            source_path = excluded.source_path,
            source_size = excluded.source_size,
            source_mtime_ms = excluded.source_mtime_ms,
            source_fingerprint = excluded.source_fingerprint,
            revision = excluded.revision,
            state = 'ready',
            last_error_code = NULL,
            updated_at_ms = excluded.updated_at_ms
        `).run(
          input.source.path,
          input.source.size,
          input.source.mtimeMs,
          input.source.fingerprint,
          revision,
          Date.now(),
        )
        database.exec('COMMIT')
      } catch (error) {
        try { database.exec('ROLLBACK') } catch {}
        throw error
      }
      return getStatus()
    },
    list(options = {}) {
      if (closed) throw new Error('Scheduled-run index database is closed')
      const limit = Math.max(Math.trunc(options.limit ?? 100), 0)
      const status = getStatus()
      const revisionToken = `sqlite:${stableToken(status.sourceFingerprint)}`
      const cursorRevision = cursorRevisionFor(revisionToken, options)
      const decodedCursor = decodeCursor(options.cursor, cursorRevision)
      const cursor = decodedCursor.position
      const where: string[] = []
      const bindings: Array<number | string> = []
      if (options.taskId) {
        where.push('task_id = ?')
        bindings.push(options.taskId)
      }
      if (options.nonterminalOnly) {
        where.push("status NOT IN ('completed', 'failed', 'timeout', 'missed')")
      }
      if (options.completedAfterMs !== undefined) {
        where.push(`(
          status IN ('completed', 'failed', 'timeout', 'missed') AND
          completed_at_ms >= ?
        )`)
        bindings.push(options.completedAfterMs)
      }
      if (cursor) {
        where.push(`(
          started_at_ms < ? OR
          (started_at_ms = ? AND source_ordinal > ?) OR
          (started_at_ms = ? AND source_ordinal = ? AND run_id > ?)
        )`)
        bindings.push(cursor[0], cursor[0], cursor[1], cursor[0], cursor[1], cursor[2])
      }
      const rows = database.query<RunRow, Array<number | string>>(`
        SELECT run_id, task_id, started_at, completed_at, status,
          has_output, has_error, exit_code, duration_ms, session_id,
          source_ordinal, started_at_ms
        FROM scheduled_runs
        ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY started_at_ms DESC, source_ordinal ASC, run_id ASC
        LIMIT ?
      `).all(...bindings, limit + 1)
      const hasMore = rows.length > limit
      const selected = hasMore ? rows.slice(0, limit) : rows
      const runs = selected.map(summaryFromRow)
      const tail = selected.at(-1)
      return {
        runs,
        ...(hasMore && tail
          ? {
              nextCursor: encodeCursor(
                [tail.started_at_ms, tail.source_ordinal, tail.run_id],
                cursorRevision,
              ),
            }
          : {}),
        revision: status.revision,
        revisionToken,
        ...(decodedCursor.reset ? { reset: true } : {}),
      }
    },
    getStatus,
    markDegraded(errorCode) {
      database.query(`
        UPDATE scheduled_run_source
        SET state = 'degraded', last_error_code = ?, updated_at_ms = ?
        WHERE singleton = 1
      `).run(errorCode, Date.now())
    },
    close() {
      if (closed) return
      database.clearQueryCache()
      database.close(true)
      closed = true
    },
  }
}
