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

  test('aggregates large replacement and append batches once after resolving duplicate calls', async () => {
    await createTestIndex()
    const target = database!
    let summaryUpdates = 0
    const index = createTraceIndex({
      ...target,
      transaction: callback => target.transaction(operation => callback({
        ...operation,
        run(statement, ...bindings) {
          if (statement.includes('UPDATE trace_sessions SET')) summaryUpdates += 1
          return operation.run(statement, ...bindings)
        },
      })),
    })
    const calls = Array.from({ length: 2_000 }, (_, ordinal) => ({
      id: `call-${ordinal}`, ordinal, byteStart: ordinal, byteLength: 1,
      startedAt: '2026-07-15T01:00:00.000Z', completedAt: null,
      status: 'ok', source: 'proxy', model: ordinal % 2 ? 'model-b' : 'model-a',
      durationMs: 2, failed: false, inputTokens: 3, outputTokens: 4,
    }))
    const source = { sessionId: 'batch', filePath: '/tmp/batch.jsonl', size: 2_002, indexedBytes: 2_002, mtimeMs: 1 }
    index.replaceSession({ source, calls, events: [] })
    expect(summaryUpdates).toBeLessThanOrEqual(2)
    expect(index.getSummary('batch')?.summary).toMatchObject({
      apiCalls: 2_000, totalInputTokens: 6_000,
      models: [{ model: 'model-a', calls: 1_000 }, { model: 'model-b', calls: 1_000 }],
    })
    summaryUpdates = 0
    index.appendEntries({ source, calls: [
      { ...calls[0]!, ordinal: 2_000, byteStart: 2_000, failed: true, inputTokens: 5 },
      { ...calls[1]!, ordinal: 2_001, byteStart: 2_001, model: 'model-a' },
    ], events: [] })
    expect(summaryUpdates).toBeLessThanOrEqual(2)
    expect(index.getSummary('batch')?.summary).toMatchObject({
      apiCalls: 2_000, failedCalls: 1, totalInputTokens: 6_002,
      models: [{ model: 'model-a', calls: 1_001 }, { model: 'model-b', calls: 999 }],
    })
  })

  test('looks up calls by start-time range through the ordered index, oldest first and bounded', async () => {
    await createTestIndex()
    const sql: string[] = []
    const index = createTraceIndex(observingDatabase(sql))
    expect(index.getCallsInRange('range', '2026-07-15T00:00:00.000Z', '2026-07-15T02:00:00.000Z', 10)).toBeNull()
    const calls = Array.from({ length: 60 }, (_, ordinal) => ({
      id: `call-${ordinal}`, ordinal, byteStart: ordinal * 10, byteLength: 10,
      // Written out of order: the range read must sort by startedAt.
      startedAt: `2026-07-15T01:${String(59 - ordinal).padStart(2, '0')}:00.000Z`, completedAt: null,
      status: 'ok', source: 'proxy', model: 'model-a',
      durationMs: 2, failed: false, inputTokens: 3, outputTokens: 4,
    }))
    index.replaceSession({ source: { sessionId: 'range', filePath: '/tmp/range.jsonl', size: 600, indexedBytes: 600, mtimeMs: 1 }, calls, events: [] })
    sql.length = 0
    const hit = index.getCallsInRange('range', '2026-07-15T01:10:00.000Z', '2026-07-15T01:12:00.000Z', 50)
    expect(hit?.source.sessionId).toBe('range')
    expect(hit?.calls.map(call => call.startedAt)).toEqual([
      '2026-07-15T01:10:00.000Z', '2026-07-15T01:11:00.000Z', '2026-07-15T01:12:00.000Z',
    ])
    expect(hit?.calls.map(call => call.id)).toEqual(['call-49', 'call-48', 'call-47'])
    expect(index.getCallsInRange('range', '2026-07-15T00:00:00.000Z', '2026-07-15T02:00:00.000Z', 5)?.calls.map(call => call.id))
      .toEqual(['call-59', 'call-58', 'call-57', 'call-56', 'call-55'])
    expect(index.getCallsInRange('range', '2026-07-15T03:00:00.000Z', '2026-07-15T04:00:00.000Z', 5)?.calls).toEqual([])
    const plan = database!.read(operation => operation.all<{ detail: string }>(
      `EXPLAIN QUERY PLAN ${sql.find(statement => statement.includes('started_at >= ?'))}`,
      'range', '2026-07-15T01:10:00.000Z', '2026-07-15T01:12:00.000Z', 50,
    ))
    expect(plan.map(row => row.detail).join('\n')).toMatch(/USING INDEX trace_calls_(page_)?order_idx/)
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
      .toEqual({ user_version: 6 })
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

  test('migrates frozen v2 and v3 databases forward with safe ordering reconstruction', async () => {
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
        DROP INDEX trace_calls_page_order_idx;
        DROP INDEX trace_calls_model_order_idx;
        ALTER TABLE trace_sources DROP COLUMN oversized_records;
        ALTER TABLE trace_sources DROP COLUMN scan_truncated;
        ALTER TABLE trace_sources DROP COLUMN window_start_byte;
        DROP INDEX trace_session_models_order_idx;
        ALTER TABLE trace_session_models DROP COLUMN first_started_at;
        ALTER TABLE trace_session_models DROP COLUMN first_ordinal;
        ALTER TABLE trace_calls DROP COLUMN first_ordinal;
        ALTER TABLE trace_calls DROP COLUMN request_bytes;
        ALTER TABLE trace_calls DROP COLUMN response_bytes;
        ALTER TABLE trace_calls DROP COLUMN response_status;
        ALTER TABLE trace_events DROP COLUMN title;
        ALTER TABLE trace_events DROP COLUMN message;
        ${version === 2 ? 'ALTER TABLE trace_sessions DROP COLUMN reset_token;' : ''}
        PRAGMA user_version = ${version};
      `)
      frozen.close()

      candidate = openTraceIndexDatabase({ path: databasePath })
      const migrated = createTraceIndex(candidate)
      expect(candidate.read(operation => operation.get<{ user_version: number }>(
        'PRAGMA user_version',
      ))).toEqual({ user_version: 6 })
      expect(migrated.getSummary(`frozen-v${version}`)?.summary.models).toEqual([
        { model: 'z-model', calls: 1 },
        { model: 'a-model', calls: 1 },
      ])
      expect(migrated.getSource(`frozen-v${version}`)).toMatchObject({
        state: 'degraded',
        lastErrorCode: 'TRACE_INDEX_V6_REBUILD_REQUIRED',
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

  test('migrates a v5 fixture to bounded windows while preserving existing rows and unknown tables', async () => {
    const index = await createTestIndex()
    index.replaceSession({
      source: { sessionId: 'v5', filePath: '/tmp/v5.jsonl', size: 100, indexedBytes: 100, mtimeMs: 1 },
      calls: [], events: [],
    })
    database!.write(operation => operation.exec(`
      CREATE TABLE future_extension (value TEXT);
      INSERT INTO future_extension VALUES ('preserve-me');
      DROP INDEX trace_calls_page_order_idx;
      DROP INDEX trace_calls_model_order_idx;
      ALTER TABLE trace_sources DROP COLUMN oversized_records;
      ALTER TABLE trace_sources DROP COLUMN scan_truncated;
      ALTER TABLE trace_sources DROP COLUMN window_start_byte;
      PRAGMA user_version = 5;
    `))
    database!.close()
    database = openTraceIndexDatabase({ path: path.join(tmpDir!, 'trace-index-v1.sqlite') })
    const upgraded = createTraceIndex(database)
    expect(upgraded.getSource('v5')).toMatchObject({
      size: 100, indexedBytes: 100, oversizedRecords: 0, scanTruncated: false, windowStartByte: 0,
      state: 'degraded', lastErrorCode: 'TRACE_INDEX_V6_REBUILD_REQUIRED',
    })
    expect(database.read(operation => operation.get<{ value: string }>('SELECT value FROM future_extension')))
      .toEqual({ value: 'preserve-me' })
    expect(database.read(operation => operation.get<{ user_version: number }>('PRAGMA user_version')))
      .toEqual({ user_version: 6 })
  })

  test('rolls back every v4 schema change when migration fails partway through', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'trace-index-v4-rollback-'))
    const databasePath = path.join(tmpDir, 'trace-index-v3-broken.sqlite')
    const initial = openTraceIndexDatabase({ path: databasePath })
    initial.close()
    const frozen = new Database(databasePath)
    frozen.exec(`
      DROP INDEX trace_calls_page_order_idx;
        DROP INDEX trace_calls_model_order_idx;
        ALTER TABLE trace_sources DROP COLUMN oversized_records;
        ALTER TABLE trace_sources DROP COLUMN scan_truncated;
        ALTER TABLE trace_sources DROP COLUMN window_start_byte;
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

test('strictly closes owned statements after Bun query-cache eviction', async () => {
  await createTestIndex()
  // Bun's internal query cache is bounded; our owned cache can outlive its entries.
  for (let index = 0; index < 256; index += 1) {
    expect(database!.read(operation => operation.get<{ value: number }>(`SELECT ${index} AS value`))).toEqual({ value: index })
  }
  expect(() => database!.close()).not.toThrow()
  expect(() => database!.close()).not.toThrow()
  expect(() => database!.read(operation => operation.get('SELECT 1'))).toThrow('Trace index database is closed')
})
