import { afterEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  openTraceIndexDatabase,
  type TraceIndexDatabase,
} from './traceDatabase.js'
import { createTraceIndex, type TraceIndex } from './traceIndex.js'

let database: TraceIndexDatabase | undefined
let tmpDir: string | undefined

afterEach(async () => {
  database?.close()
  database = undefined
  if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true })
  tmpDir = undefined
})

async function createTestIndex(): Promise<TraceIndex> {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'trace-index-'))
  database = openTraceIndexDatabase({ path: path.join(tmpDir, 'trace-index-v1.sqlite') })
  return createTraceIndex(database)
}

function observingDatabase(sql: string[]): TraceIndexDatabase {
  const target = database!
  const wrapRead = (operation: Parameters<Parameters<TraceIndexDatabase['read']>[0]>[0]) => ({
    get<T>(statement: string, ...bindings: Parameters<typeof operation.get>[1][]) {
      sql.push(statement)
      return operation.get<T>(statement, ...bindings)
    },
    all<T>(statement: string, ...bindings: Parameters<typeof operation.all>[1][]) {
      sql.push(statement)
      return operation.all<T>(statement, ...bindings)
    },
  })
  return {
    read: callback => target.read(operation => callback(wrapRead(operation))),
    write: callback => target.write(operation => callback({
      ...wrapRead(operation),
      run: operation.run.bind(operation),
      exec: operation.exec.bind(operation),
    })),
    transaction: callback => target.transaction(operation => callback({
      ...wrapRead(operation),
      run: operation.run.bind(operation),
      exec: operation.exec.bind(operation),
    })),
    close: () => target.close(),
  }
}

describe('trace index', () => {
  test('releases cached statements before close so the database directory can be removed immediately', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'trace-index-close-'))
    database = openTraceIndexDatabase({ path: path.join(tmpDir, 'trace-index-v1.sqlite') })
    database.read(operation => operation.all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    ))

    database.close()
    database = undefined
    await fs.rm(tmpDir, { recursive: true, force: true })
    await expect(fs.stat(tmpDir)).rejects.toMatchObject({ code: 'ENOENT' })
    tmpDir = undefined
  })

  test('uses an independent schema containing only scalar metadata and byte locators', async () => {
    await createTestIndex()

    const tables = database!.read(operation => operation.all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    ))
    const callColumns = database!.read(operation => operation.all<{ name: string }>(
      'PRAGMA table_info(trace_calls)',
    ))
    const sessionColumns = database!.read(operation => operation.all<{ name: string }>(
      'PRAGMA table_info(trace_sessions)',
    ))

    expect(tables.map(row => row.name)).toEqual([
      'trace_calls',
      'trace_events',
      'trace_session_models',
      'trace_sessions',
      'trace_sources',
    ])
    expect(callColumns.map(row => row.name)).toContain('byte_start')
    expect(callColumns.map(row => row.name)).toContain('byte_length')
    expect(callColumns.map(row => row.name)).not.toContain('request_json')
    expect(callColumns.map(row => row.name)).not.toContain('response_json')
    expect(sessionColumns.map(row => row.name)).toContain('reset_token')
    const allColumns = tables.flatMap(table => database!.read(operation =>
      operation.all<{ name: string }>(`PRAGMA table_info(${table.name})`),
    ))
    expect(allColumns.map(row => row.name)).not.toContain('request_body')
    expect(allColumns.map(row => row.name)).not.toContain('response_body')
    expect(allColumns.map(row => row.name)).not.toContain('pending_tail')
  })

  test('keeps the latest call locator and exposes revision-based changes without duplicates', async () => {
    const index = await createTestIndex()

    const first = index.replaceSession({
      source: {
        sessionId: 'session-1',
        filePath: '/tmp/session-1.jsonl',
        size: 128,
        mtimeMs: 100,
        indexedBytes: 128,
      },
      calls: [{
        id: 'call-1',
        ordinal: 0,
        byteStart: 0,
        byteLength: 128,
        startedAt: '2026-07-15T01:00:00.000Z',
        completedAt: null,
        status: 'pending',
        source: 'proxy',
        model: 'model-a',
        durationMs: null,
        failed: false,
        inputTokens: 0,
        outputTokens: 0,
      }],
      events: [],
    })

    const second = index.appendCall({
      source: {
        sessionId: 'session-1',
        filePath: '/tmp/session-1.jsonl',
        size: 290,
        mtimeMs: 200,
        indexedBytes: 290,
      },
      call: {
        id: 'call-1',
        ordinal: 1,
        byteStart: 128,
        byteLength: 162,
        startedAt: '2026-07-15T01:00:00.000Z',
        completedAt: '2026-07-15T01:00:00.025Z',
        status: 'completed',
        source: 'proxy',
        model: 'model-a',
        durationMs: 25,
        failed: false,
        inputTokens: 11,
        outputTokens: 7,
      },
    })

    expect(second.revision).toBe(first.revision + 1)
    expect(first.resetToken).toBeString()
    expect(second.resetToken).toBe(first.resetToken)
    expect(index.getSession('session-1')).toMatchObject({
      revision: second.revision,
      summary: {
        apiCalls: 1,
        failedCalls: 0,
        totalDurationMs: 25,
        totalInputTokens: 11,
        totalOutputTokens: 7,
        models: [{ model: 'model-a', calls: 1 }],
      },
      calls: [{
        id: 'call-1',
        byteStart: 128,
        byteLength: 162,
      }],
    })
    expect(index.getChanges('session-1', first.revision)).toMatchObject({
      revision: second.revision,
      reset: false,
      calls: [{ id: 'call-1', byteStart: 128, byteLength: 162 }],
      events: [],
    })
    expect(index.getSource('session-1')).toMatchObject({ nextOrdinal: 2 })
    expect(index.getCallLocator('session-1', 'call-1')).toMatchObject({
      source: { revision: second.revision, resetToken: first.resetToken },
      call: { id: 'call-1', byteStart: 128, byteLength: 162 },
    })

    const replaced = index.replaceSession({
      source: {
        sessionId: 'session-1',
        filePath: '/tmp/session-1.jsonl',
        size: 128,
        mtimeMs: 300,
        indexedBytes: 128,
      },
      calls: [{
        id: 'call-replaced',
        ordinal: 0,
        byteStart: 0,
        byteLength: 128,
        startedAt: '2026-07-15T01:00:02.000Z',
        completedAt: null,
        status: 'pending',
        source: 'proxy',
        model: null,
        durationMs: null,
        failed: false,
        inputTokens: 0,
        outputTokens: 0,
      }],
      events: [],
    })
    expect(replaced.resetToken).not.toBe(first.resetToken)
  })

  test('serves warm session summaries without querying call or event locator rows', async () => {
    const queries: string[] = []
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'trace-index-summary-'))
    database = openTraceIndexDatabase({ path: path.join(tmpDir, 'trace-index-v1.sqlite') })
    const index = createTraceIndex(observingDatabase(queries))
    index.replaceSession({
      source: {
        sessionId: 'summary-only',
        filePath: '/tmp/summary-only.jsonl',
        size: 64,
        mtimeMs: 100,
        indexedBytes: 64,
      },
      calls: [{
        id: 'call-summary',
        ordinal: 0,
        byteStart: 0,
        byteLength: 64,
        startedAt: '2026-07-15T01:00:00.000Z',
        completedAt: '2026-07-15T01:00:00.010Z',
        status: 'ok',
        source: 'proxy',
        model: 'model-summary',
        durationMs: 10,
        failed: false,
        inputTokens: 3,
        outputTokens: 2,
      }],
      events: [],
    })

    queries.length = 0
    const listed = index.listSessions()

    expect(listed.sessions[0]?.summary).toMatchObject({
      apiCalls: 1,
      totalInputTokens: 3,
      totalOutputTokens: 2,
    })
    expect(queries.some(statement => /FROM trace_(calls|events)/i.test(statement))).toBe(false)
  })

  test('migrates a frozen v1 trace database forward without losing locator state', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'trace-index-v1-'))
    const databasePath = path.join(tmpDir, 'trace-index-v1.sqlite')
    const frozen = new Database(databasePath)
    frozen.exec(`
      CREATE TABLE trace_sources (
        session_id TEXT PRIMARY KEY, file_path TEXT NOT NULL UNIQUE,
        size_bytes INTEGER NOT NULL, mtime_ms REAL NOT NULL,
        indexed_bytes INTEGER NOT NULL, revision INTEGER NOT NULL,
        last_reset_revision INTEGER NOT NULL, state TEXT NOT NULL,
        last_error_code TEXT, updated_at_ms INTEGER NOT NULL
      );
      CREATE TABLE trace_calls (
        session_id TEXT NOT NULL REFERENCES trace_sources(session_id) ON DELETE CASCADE,
        call_id TEXT NOT NULL, ordinal INTEGER NOT NULL, byte_start INTEGER NOT NULL,
        byte_length INTEGER NOT NULL, revision INTEGER NOT NULL, started_at TEXT NOT NULL,
        completed_at TEXT, status TEXT NOT NULL, source TEXT NOT NULL, model TEXT,
        duration_ms REAL, failed INTEGER NOT NULL, input_tokens INTEGER NOT NULL,
        output_tokens INTEGER NOT NULL, PRIMARY KEY (session_id, call_id)
      );
      CREATE TABLE trace_events (
        session_id TEXT NOT NULL REFERENCES trace_sources(session_id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL, event_id TEXT NOT NULL, byte_start INTEGER NOT NULL,
        byte_length INTEGER NOT NULL, revision INTEGER NOT NULL, timestamp TEXT NOT NULL,
        phase TEXT NOT NULL, severity TEXT NOT NULL, call_id TEXT, source TEXT, model TEXT,
        PRIMARY KEY (session_id, ordinal)
      );
      INSERT INTO trace_sources VALUES (
        'frozen', '/tmp/frozen.jsonl', 64, 100, 64, 7, 3, 'ready', NULL, 100
      );
      INSERT INTO trace_calls VALUES (
        'frozen', 'call-frozen', 4, 0, 64, 7,
        '2026-07-15T01:00:00.000Z', '2026-07-15T01:00:00.010Z',
        'ok', 'proxy', 'model-frozen', 10, 0, 3, 2
      );
      PRAGMA user_version = 1;
    `)
    frozen.close()

    database = openTraceIndexDatabase({ path: databasePath })
    const index = createTraceIndex(database)

    expect(database.read(operation => operation.get<{ user_version: number }>('PRAGMA user_version')))
      .toEqual({ user_version: 4 })
    expect(index.getSession('frozen')).toMatchObject({
      revision: 7,
      lastResetRevision: 3,
      resetToken: expect.any(String),
      nextOrdinal: 5,
      summary: {
        apiCalls: 1,
        totalInputTokens: 3,
        totalOutputTokens: 2,
      },
      calls: [{ id: 'call-frozen', ordinal: 4 }],
    })
  })

  test('migrates frozen v2 and v3 databases to v4 with safe ordering reconstruction', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'trace-index-v2-v3-'))

    for (const version of [2, 3]) {
      const databasePath = path.join(tmpDir, `trace-index-v${version}.sqlite`)
      let candidate = openTraceIndexDatabase({ path: databasePath })
      createTraceIndex(candidate).replaceSession({
        source: {
          sessionId: `frozen-v${version}`,
          filePath: `/tmp/frozen-v${version}.jsonl`,
          size: 128,
          mtimeMs: 100,
          indexedBytes: 128,
        },
        calls: [
          {
            id: 'call-z',
            ordinal: 4,
            byteStart: 0,
            byteLength: 64,
            startedAt: '2026-07-15T01:00:00.000Z',
            completedAt: '2026-07-15T01:00:00.010Z',
            status: 'ok',
            source: 'proxy',
            model: 'z-model',
            durationMs: 10,
            failed: false,
            inputTokens: 3,
            outputTokens: 2,
          },
          {
            id: 'call-a',
            ordinal: 5,
            byteStart: 64,
            byteLength: 64,
            startedAt: '2026-07-15T01:00:01.000Z',
            completedAt: '2026-07-15T01:00:01.010Z',
            status: 'ok',
            source: 'proxy',
            model: 'a-model',
            durationMs: 10,
            failed: false,
            inputTokens: 3,
            outputTokens: 2,
          },
        ],
        events: [],
      })
      candidate.close()

      const frozen = new Database(databasePath)
      frozen.exec(`
        DROP INDEX trace_session_models_order_idx;
        ALTER TABLE trace_session_models DROP COLUMN first_started_at;
        ALTER TABLE trace_session_models DROP COLUMN first_ordinal;
        ALTER TABLE trace_calls DROP COLUMN first_ordinal;
        ${version === 2 ? 'ALTER TABLE trace_sessions DROP COLUMN reset_token;' : ''}
        PRAGMA user_version = ${version};
      `)
      frozen.close()

      candidate = openTraceIndexDatabase({ path: databasePath })
      const migrated = createTraceIndex(candidate)
      expect(candidate.read(operation => operation.get<{ user_version: number }>(
        'PRAGMA user_version',
      ))).toEqual({ user_version: 4 })
      expect(migrated.getSummary(`frozen-v${version}`)?.summary.models).toEqual([
        { model: 'z-model', calls: 1 },
        { model: 'a-model', calls: 1 },
      ])
      expect(migrated.getSource(`frozen-v${version}`)).toMatchObject({
        state: 'degraded',
        lastErrorCode: 'TRACE_INDEX_V4_REBUILD_REQUIRED',
      })
      expect(candidate.read(operation => operation.all<{
        ordinal: number
        first_ordinal: number
      }>('SELECT ordinal, first_ordinal FROM trace_calls ORDER BY ordinal'))).toEqual([
        { ordinal: 4, first_ordinal: 4 },
        { ordinal: 5, first_ordinal: 5 },
      ])
      candidate.close()
    }
  })

  test('rolls back every v4 schema change when migration fails partway through', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'trace-index-v4-rollback-'))
    const databasePath = path.join(tmpDir, 'trace-index-v3-broken.sqlite')
    const initial = openTraceIndexDatabase({ path: databasePath })
    initial.close()
    const frozen = new Database(databasePath)
    frozen.exec(`
      DROP INDEX trace_session_models_order_idx;
      ALTER TABLE trace_session_models DROP COLUMN first_started_at;
      ALTER TABLE trace_session_models DROP COLUMN first_ordinal;
      ALTER TABLE trace_calls DROP COLUMN first_ordinal;
      ALTER TABLE trace_session_models ADD COLUMN first_started_at TEXT NOT NULL DEFAULT '';
      PRAGMA user_version = 3;
    `)
    frozen.close()

    expect(() => openTraceIndexDatabase({ path: databasePath })).toThrow()

    const inspected = new Database(databasePath)
    expect(inspected.query<{ user_version: number }, []>('PRAGMA user_version').get())
      .toEqual({ user_version: 3 })
    expect(inspected.query<{ name: string }, []>('PRAGMA table_info(trace_calls)').all()
      .map(column => column.name)).not.toContain('first_ordinal')
    inspected.close()
  })
})
