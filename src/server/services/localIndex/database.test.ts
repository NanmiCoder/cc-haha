import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { createHash } from 'node:crypto'
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import type { Database } from 'bun:sqlite'
import type { LocalIndexWriteOperation } from './database.js'
import { LOCAL_INDEX_SCHEMA_VERSION } from './migrations.js'

type EnvironmentName = 'HOME' | 'CLAUDE_CONFIG_DIR' | 'CC_HAHA_LOCAL_INDEX'

const originalEnvironment: Partial<Record<EnvironmentName, string>> = {}
const tempDirs: string[] = []

async function createTempDir(label: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), `cc-haha-${label}-`))
  tempDirs.push(directory)
  return directory
}

function restoreEnvironment(name: EnvironmentName): void {
  const value = originalEnvironment[name]
  if (value === undefined) {
    delete process.env[name]
  } else {
    process.env[name] = value
  }
}

async function loadConfig() {
  return import('./config.js')
}

async function loadDatabase() {
  return import('./database.js')
}

async function openRawDatabase(path: string): Promise<Database> {
  const { Database } = await import('bun:sqlite')
  return new Database(path)
}

function queryOne<T>(database: Database, sql: string): T | null {
  const statement = database.prepare<T, []>(sql)
  try {
    return statement.get()
  } finally {
    statement.finalize()
  }
}

function queryAll<T>(database: Database, sql: string): T[] {
  const statement = database.prepare<T, []>(sql)
  try {
    return statement.all()
  } finally {
    statement.finalize()
  }
}

const FROZEN_SCHEMA_V1 = `
CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE source_files (
  path TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('transcript')),
  size_bytes INTEGER NOT NULL,
  mtime_ms INTEGER NOT NULL,
  file_identity TEXT,
  prefix_hash TEXT NOT NULL,
  indexed_bytes INTEGER NOT NULL DEFAULT 0,
  parser_version INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('ready', 'pending', 'degraded')),
  last_error_code TEXT,
  updated_at_ms INTEGER NOT NULL
);
CREATE TABLE sessions (
  transcript_path TEXT PRIMARY KEY REFERENCES source_files(path) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  project_path TEXT NOT NULL,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL,
  modified_at TEXT NOT NULL,
  modified_at_ms INTEGER NOT NULL,
  message_count INTEGER NOT NULL,
  work_dir TEXT,
  repository_json TEXT,
  worktree_session_json TEXT,
  permission_mode TEXT,
  runtime_provider_id TEXT,
  runtime_provider_present INTEGER NOT NULL DEFAULT 0 CHECK (runtime_provider_present IN (0, 1)),
  runtime_model_id TEXT,
  effort_level TEXT
);
CREATE INDEX sessions_modified_idx ON sessions(modified_at_ms DESC, session_id, transcript_path);
CREATE INDEX sessions_project_modified_idx ON sessions(project_path, modified_at_ms DESC, session_id, transcript_path);
CREATE INDEX sessions_id_project_idx ON sessions(session_id, project_path, transcript_path);
CREATE TABLE backfill_state (
  scope TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  watermark TEXT,
  discovered INTEGER NOT NULL DEFAULT 0,
  indexed INTEGER NOT NULL DEFAULT 0,
  degraded INTEGER NOT NULL DEFAULT 0,
  last_error_code TEXT,
  updated_at_ms INTEGER NOT NULL
);
PRAGMA user_version = 1;
`

function seedFrozenV1(database: Database): void {
  database.exec(FROZEN_SCHEMA_V1)
  database.exec(`
    INSERT INTO schema_meta (key, value) VALUES ('fixture', 'v1-preserved');
    INSERT INTO source_files (
      path, kind, size_bytes, mtime_ms, file_identity, prefix_hash,
      indexed_bytes, parser_version, state, last_error_code, updated_at_ms
    ) VALUES (
      '/fixture/session.jsonl', 'transcript', 128, 1234, '1:2',
      'frozen-fingerprint', 128, 1, 'ready', NULL, 1234
    );
    INSERT INTO sessions (
      transcript_path, session_id, project_path, title, created_at,
      modified_at, modified_at_ms, message_count, work_dir,
      runtime_provider_present
    ) VALUES (
      '/fixture/session.jsonl', 'fixture-session', '-fixture', 'Frozen v1',
      '2026-07-15T00:00:00.000Z', '2026-07-15T00:01:00.000Z',
      1784073660000, 2, '/fixture', 0
    );
    INSERT INTO backfill_state (
      scope, state, watermark, discovered, indexed, degraded,
      last_error_code, updated_at_ms
    ) VALUES (
      '/fixture', 'ready', '/fixture/session.jsonl', 1, 1, 0, NULL, 1234
    );
  `)
}

function seedFrozenV2(database: Database): void {
  seedFrozenV1(database)
  database.exec(`
    CREATE TABLE session_entries (
      transcript_path TEXT NOT NULL REFERENCES source_files(path) ON DELETE CASCADE,
      ordinal INTEGER NOT NULL,
      jsonl_line INTEGER NOT NULL,
      byte_start INTEGER NOT NULL,
      byte_length INTEGER NOT NULL,
      entry_type TEXT NOT NULL,
      message_id TEXT,
      role TEXT,
      timestamp TEXT,
      parent_tool_use_id TEXT,
      PRIMARY KEY (transcript_path, ordinal)
    );
    CREATE INDEX session_entries_kind_idx
      ON session_entries(transcript_path, entry_type, ordinal);
    CREATE INDEX session_entries_message_idx
      ON session_entries(message_id, transcript_path);
    INSERT INTO session_entries (
      transcript_path, ordinal, jsonl_line, byte_start, byte_length,
      entry_type, message_id, role, timestamp, parent_tool_use_id
    ) VALUES (
      '/fixture/session.jsonl', 0, 1, 0, 128,
      'user', 'fixture-message', 'user', '2026-07-15T00:00:00.000Z', NULL
    );
    PRAGMA user_version = 2;
  `)
}

// A frozen snapshot of the v3 activity schema, kept verbatim so the v4 migration is exercised
// against the shape real databases were left in rather than against today's CREATE TABLE.
function seedFrozenV3(database: Database): void {
  seedFrozenV2(database)
  database.exec(`
    CREATE TABLE activity_sources (
      path TEXT PRIMARY KEY,
      parent_session_id TEXT NOT NULL,
      project_path TEXT NOT NULL,
      is_subagent INTEGER NOT NULL CHECK (is_subagent IN (0, 1)),
      size_bytes INTEGER NOT NULL,
      mtime_ms INTEGER NOT NULL,
      file_identity TEXT,
      prefix_hash TEXT NOT NULL,
      indexed_bytes INTEGER NOT NULL DEFAULT 0,
      parser_version INTEGER NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('ready', 'pending', 'degraded')),
      last_error_code TEXT,
      updated_at_ms INTEGER NOT NULL
    );
    CREATE TABLE activity_sessions (
      transcript_path TEXT PRIMARY KEY REFERENCES activity_sources(path) ON DELETE CASCADE,
      session_id TEXT NOT NULL,
      first_timestamp TEXT,
      last_timestamp TEXT,
      duration_ms INTEGER NOT NULL DEFAULT 0,
      message_count INTEGER NOT NULL DEFAULT 0,
      start_hour INTEGER,
      speculation_time_saved_ms INTEGER NOT NULL DEFAULT 0,
      shot_count INTEGER
    );
    CREATE TABLE activity_daily (
      transcript_path TEXT NOT NULL REFERENCES activity_sources(path) ON DELETE CASCADE,
      date TEXT NOT NULL,
      message_count INTEGER NOT NULL DEFAULT 0,
      tool_call_count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (transcript_path, date)
    );
    CREATE TABLE activity_daily_models (
      transcript_path TEXT NOT NULL REFERENCES activity_sources(path) ON DELETE CASCADE,
      date TEXT NOT NULL,
      model TEXT NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_input_tokens INTEGER NOT NULL DEFAULT 0,
      cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0,
      web_search_requests INTEGER NOT NULL DEFAULT 0,
      cost_usd REAL NOT NULL DEFAULT 0,
      context_window INTEGER NOT NULL DEFAULT 0,
      max_output_tokens INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (transcript_path, date, model)
    );
    CREATE TABLE activity_daily_tools (
      transcript_path TEXT NOT NULL REFERENCES activity_sources(path) ON DELETE CASCADE,
      date TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      call_count INTEGER NOT NULL,
      PRIMARY KEY (transcript_path, date, tool_name)
    );
    CREATE TABLE activity_daily_skills (
      transcript_path TEXT NOT NULL REFERENCES activity_sources(path) ON DELETE CASCADE,
      date TEXT NOT NULL,
      skill_name TEXT NOT NULL,
      call_count INTEGER NOT NULL,
      PRIMARY KEY (transcript_path, date, skill_name)
    );
    CREATE TABLE activity_backfill_state (
      scope TEXT PRIMARY KEY,
      state TEXT NOT NULL,
      watermark TEXT,
      discovered INTEGER NOT NULL DEFAULT 0,
      indexed INTEGER NOT NULL DEFAULT 0,
      degraded INTEGER NOT NULL DEFAULT 0,
      last_error_code TEXT,
      updated_at_ms INTEGER NOT NULL
    );
    CREATE INDEX activity_daily_date_idx
      ON activity_daily(date, transcript_path);
    CREATE INDEX activity_models_date_idx
      ON activity_daily_models(date, model, transcript_path);
    CREATE INDEX activity_tools_date_idx
      ON activity_daily_tools(date, tool_name, transcript_path);
    CREATE INDEX activity_skills_date_idx
      ON activity_daily_skills(date, skill_name, transcript_path);
    CREATE INDEX activity_sources_parent_idx
      ON activity_sources(parent_session_id, path);
    INSERT INTO activity_sources (
      path, parent_session_id, project_path, is_subagent, size_bytes, mtime_ms,
      file_identity, prefix_hash, indexed_bytes, parser_version, state,
      last_error_code, updated_at_ms
    ) VALUES (
      '/fixture/activity.jsonl', 'fixture-session', '-repo', 0, 512, 1750000000000,
      '1:2', 'fixture-hash', 512, 2, 'ready', NULL, 1750000000000
    );
    INSERT INTO activity_sessions (
      transcript_path, session_id, first_timestamp, last_timestamp,
      duration_ms, message_count, start_hour, speculation_time_saved_ms, shot_count
    ) VALUES (
      '/fixture/activity.jsonl', 'fixture-session', '2026-07-01T00:00:00.000Z',
      '2026-07-19T00:00:00.000Z', 1571040000, 17, 9, 0, NULL
    );
    PRAGMA user_version = 3;
  `)
}

async function transcriptHashes(paths: string[]): Promise<Record<string, string>> {
  return Object.fromEntries(await Promise.all(paths.map(async path => [
    path,
    createHash('sha256').update(await readFile(path)).digest('hex'),
  ])))
}

beforeEach(async () => {
  for (const name of [
    'HOME',
    'CLAUDE_CONFIG_DIR',
    'CC_HAHA_LOCAL_INDEX',
  ] as const) {
    originalEnvironment[name] = process.env[name]
  }

  const environmentRoot = await createTempDir('local-index-environment')
  process.env.HOME = join(environmentRoot, 'home')
  process.env.CLAUDE_CONFIG_DIR = join(environmentRoot, 'config')
  delete process.env.CC_HAHA_LOCAL_INDEX
})

afterEach(async () => {
  restoreEnvironment('HOME')
  restoreEnvironment('CLAUDE_CONFIG_DIR')
  restoreEnvironment('CC_HAHA_LOCAL_INDEX')
  await Promise.all(tempDirs.splice(0).map(
    directory => rm(directory, { recursive: true, force: true }),
  ))
})

describe('local index config', () => {
  it('accepts only supported modes and sanitizes invalid mode warnings', async () => {
    const { resolveLocalIndexMode } = await loadConfig()

    expect(resolveLocalIndexMode(undefined)).toEqual({
      mode: 'on',
      warningCode: null,
    })
    expect(resolveLocalIndexMode('off')).toEqual({
      mode: 'off',
      warningCode: null,
    })
    expect(resolveLocalIndexMode('shadow')).toEqual({
      mode: 'shadow',
      warningCode: null,
    })
    expect(resolveLocalIndexMode('on')).toEqual({
      mode: 'on',
      warningCode: null,
    })

    const dangerousInput = '../../real-home\napi_key=do-not-leak'
    const result = resolveLocalIndexMode(dangerousInput)
    expect(result).toEqual({
      mode: 'on',
      warningCode: 'LOCAL_INDEX_INVALID_MODE',
    })
    expect(JSON.stringify(result)).not.toContain(dangerousInput)
    expect(resolveLocalIndexMode('ON')).toEqual(result)
    expect(resolveLocalIndexMode(' shadow ')).toEqual(result)
  })

  it('resolves the database path from the config active at startup time', async () => {
    const firstConfigDir = process.env.CLAUDE_CONFIG_DIR!
    const { getLocalIndexDatabasePath } = await loadConfig()
    const secondRoot = await createTempDir('local-index-second-profile')
    const secondConfigDir = join(secondRoot, 'config')

    process.env.CLAUDE_CONFIG_DIR = secondConfigDir

    expect(getLocalIndexDatabasePath()).toBe(
      join(secondConfigDir, 'cc-haha', 'db', 'index-v1.sqlite'),
    )
    expect(getLocalIndexDatabasePath()).not.toContain(firstConfigDir)
  })
})

describe('local index database', () => {
  it('creates only the configured database parent and applies connection pragmas', async () => {
    const configDir = process.env.CLAUDE_CONFIG_DIR!
    const expectedPath = join(configDir, 'cc-haha', 'db', 'index-v1.sqlite')
    const { openLocalIndexDatabase } = await loadDatabase()

    const localIndexDatabase = openLocalIndexDatabase()
    try {
      expect(await readdir(dirname(expectedPath))).toContain(basename(expectedPath))
      expect(await readdir(configDir)).toEqual(['cc-haha'])
      expect(localIndexDatabase.read(operation =>
        operation.get<{ journal_mode: string }>('PRAGMA journal_mode')
          ?.journal_mode,
      )).toBe('wal')
      expect(localIndexDatabase.read(operation =>
        operation.get<{ synchronous: number }>('PRAGMA synchronous')
          ?.synchronous,
      )).toBe(1)
      expect(localIndexDatabase.read(operation =>
        operation.get<{ foreign_keys: number }>('PRAGMA foreign_keys')
          ?.foreign_keys,
      )).toBe(1)
      expect(localIndexDatabase.read(operation =>
        operation.get<{ timeout: number }>('PRAGMA busy_timeout')
          ?.timeout,
      )).toBe(100)
      expect(localIndexDatabase.read(operation =>
        operation.get<{ wal_autocheckpoint: number }>('PRAGMA wal_autocheckpoint')
          ?.wal_autocheckpoint,
      )).toBe(1000)
      expect(localIndexDatabase.read(operation =>
        operation.get<{ journal_size_limit: number }>('PRAGMA journal_size_limit')
          ?.journal_size_limit,
      )).toBe(16 * 1024 * 1024)
      expect(localIndexDatabase.getStorageStats()).toMatchObject({
        databaseBytes: expect.any(Number),
        walBytes: expect.any(Number),
      })
      expect(localIndexDatabase.checkpointPassive()).toMatchObject({
        busy: expect.any(Number),
        logFrames: expect.any(Number),
        checkpointedFrames: expect.any(Number),
      })
    } finally {
      localIndexDatabase.close()
    }
  })

  it('applies ordered v0 to current migrations and reopens idempotently', async () => {
    const databasePath = join(process.env.CLAUDE_CONFIG_DIR!, 'index.sqlite')
    const { openLocalIndexDatabase } = await loadDatabase()
    const first = openLocalIndexDatabase({ path: databasePath })

    expect(first.read(operation =>
      operation.get<{ user_version: number }>('PRAGMA user_version')
        ?.user_version,
    )).toBe(LOCAL_INDEX_SCHEMA_VERSION)
    expect(first.read(operation =>
      operation.all<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
      ).map(row => row.name),
    )).toEqual([
      'activity_backfill_state',
      'activity_daily',
      'activity_daily_models',
      'activity_daily_skills',
      'activity_daily_tools',
      'activity_sessions',
      'activity_sources',
      'backfill_state',
      'schema_meta',
      'session_entries',
      'sessions',
      'source_files',
    ])
    expect(first.read(operation =>
      operation.all<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      ).map(row => row.name),
    )).toEqual([
      'activity_daily_date_idx',
      'activity_models_date_idx',
      'activity_skills_date_idx',
      'activity_sources_parent_idx',
      'activity_tools_date_idx',
      'session_entries_kind_idx',
      'session_entries_message_idx',
      'sessions_id_project_idx',
      'sessions_modified_idx',
      'sessions_project_modified_idx',
    ])
    expect(first.read(operation =>
      operation.get<{ on_delete: string }>('PRAGMA foreign_key_list(sessions)')
        ?.on_delete,
    )).toBe('CASCADE')
    expect(first.read(operation =>
      operation.all<{ name: string }>('PRAGMA table_info(session_entries)')
        .map(column => column.name),
    )).toEqual([
      'transcript_path',
      'ordinal',
      'jsonl_line',
      'byte_start',
      'byte_length',
      'entry_type',
      'message_id',
      'role',
      'timestamp',
      'parent_tool_use_id',
    ])
    expect(first.read(operation =>
      operation.get<{ on_delete: string }>('PRAGMA foreign_key_list(session_entries)')
        ?.on_delete,
    )).toBe('CASCADE')
    first.write(operation => {
      operation.run(
        "INSERT INTO schema_meta (key, value) VALUES ('migration-proof', 'preserved')",
      )
    })
    first.close()

    const second = openLocalIndexDatabase({ path: databasePath })
    try {
      expect(second.read(operation =>
        operation.get<{ value: string }>(
          "SELECT value FROM schema_meta WHERE key = 'migration-proof'",
        )?.value,
      )).toBe('preserved')
      expect(second.read(operation =>
        operation.get<{ user_version: number }>('PRAGMA user_version')
          ?.user_version,
      )).toBe(LOCAL_INDEX_SCHEMA_VERSION)
    } finally {
      second.close()
    }
  })

  it('upgrades a frozen real v1 database to current without replaying v1 or losing rows', async () => {
    const databasePath = join(process.env.CLAUDE_CONFIG_DIR!, 'frozen-v1.sqlite')
    await mkdir(dirname(databasePath), { recursive: true })
    const seed = await openRawDatabase(databasePath)
    seedFrozenV1(seed)
    seed.close(true)
    const { openLocalIndexDatabase } = await loadDatabase()

    const upgraded = openLocalIndexDatabase({ path: databasePath })
    try {
      expect(upgraded.read(operation => operation.get<{ user_version: number }>(
        'PRAGMA user_version',
      )?.user_version)).toBe(LOCAL_INDEX_SCHEMA_VERSION)
      expect(upgraded.read(operation => operation.get<{ value: string }>(
        "SELECT value FROM schema_meta WHERE key = 'fixture'",
      )?.value)).toBe('v1-preserved')
      expect(upgraded.read(operation => operation.get<{ title: string }>(
        "SELECT title FROM sessions WHERE transcript_path = '/fixture/session.jsonl'",
      )?.title)).toBe('Frozen v1')
      expect(upgraded.read(operation => operation.get<{ state: string }>(
        "SELECT state FROM backfill_state WHERE scope = '/fixture'",
      )?.state)).toBe('ready')
      expect(upgraded.read(operation => operation.get<{ count: number }>(
        'SELECT COUNT(*) AS count FROM session_entries',
      )?.count)).toBe(0)
    } finally {
      upgraded.close()
    }

    const reopened = openLocalIndexDatabase({ path: databasePath })
    try {
      expect(reopened.read(operation => operation.get<{ count: number }>(
        "SELECT COUNT(*) AS count FROM sessions WHERE session_id = 'fixture-session'",
      )?.count)).toBe(1)
    } finally {
      reopened.close()
    }
  })

  it('upgrades a frozen real v2 database to current without losing session or locator rows', async () => {
    const databasePath = join(process.env.CLAUDE_CONFIG_DIR!, 'frozen-v2.sqlite')
    await mkdir(dirname(databasePath), { recursive: true })
    const seed = await openRawDatabase(databasePath)
    seedFrozenV2(seed)
    seed.close(true)
    const { openLocalIndexDatabase } = await loadDatabase()

    const upgraded = openLocalIndexDatabase({ path: databasePath })
    try {
      expect(upgraded.read(operation => operation.get<{ user_version: number }>(
        'PRAGMA user_version',
      )?.user_version)).toBe(LOCAL_INDEX_SCHEMA_VERSION)
      expect(upgraded.read(operation => operation.get<{ title: string }>(
        "SELECT title FROM sessions WHERE transcript_path = '/fixture/session.jsonl'",
      )?.title)).toBe('Frozen v1')
      expect(upgraded.read(operation => operation.get<{ message_id: string }>(
        "SELECT message_id FROM session_entries WHERE transcript_path = '/fixture/session.jsonl'",
      )?.message_id)).toBe('fixture-message')
      expect(upgraded.read(operation => operation.all<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'activity_%' ORDER BY name",
      ).map(row => row.name))).toEqual([
        'activity_backfill_state',
        'activity_daily',
        'activity_daily_models',
        'activity_daily_skills',
        'activity_daily_tools',
        'activity_sessions',
        'activity_sources',
      ])
      expect(upgraded.read(operation => operation.get<{ count: number }>(
        'SELECT COUNT(*) AS count FROM activity_sources',
      )?.count)).toBe(0)
    } finally {
      upgraded.close()
    }
  })

  it('upgrades a frozen real v3 database to current, keeping activity rows', async () => {
    const databasePath = join(process.env.CLAUDE_CONFIG_DIR!, 'frozen-v3.sqlite')
    await mkdir(dirname(databasePath), { recursive: true })
    const seed = await openRawDatabase(databasePath)
    seedFrozenV3(seed)
    seed.close(true)
    const { openLocalIndexDatabase } = await loadDatabase()

    const upgraded = openLocalIndexDatabase({ path: databasePath })
    try {
      expect(upgraded.read(operation => operation.get<{ user_version: number }>(
        'PRAGMA user_version',
      )?.user_version)).toBe(LOCAL_INDEX_SCHEMA_VERSION)
      expect(upgraded.read(operation => operation.all<{ name: string }>(
        'PRAGMA table_info(activity_sessions)',
      ).map(row => row.name))).toContain('active_duration_ms')
      const session = upgraded.read(operation => operation.get<{
        duration_ms: number
        active_duration_ms: number
        message_count: number
      }>(
        `SELECT duration_ms, active_duration_ms, message_count FROM activity_sessions
         WHERE transcript_path = '/fixture/activity.jsonl'`,
      ))
      // Pre-existing rows survive with the calendar span they were written with; the new column
      // backfills to 0 and is refilled once the bumped parser version rebuilds the source.
      expect(session?.duration_ms).toBe(1571040000)
      expect(session?.message_count).toBe(17)
      expect(session?.active_duration_ms).toBe(0)
    } finally {
      upgraded.close()
    }
  })

  it('upgrades a frozen v4 cache additively and preserves its existing rows', async () => {
    const databasePath = join(process.env.CLAUDE_CONFIG_DIR!, 'frozen-v4.sqlite')
    await mkdir(dirname(databasePath), { recursive: true })
    const seed = await openRawDatabase(databasePath)
    seedFrozenV3(seed)
    seed.exec('ALTER TABLE activity_sessions ADD COLUMN active_duration_ms INTEGER NOT NULL DEFAULT 0')
    seed.exec('PRAGMA user_version = 4')
    seed.exec("INSERT INTO schema_meta (key, value) VALUES ('future-extension', 'keep-me')")
    const originalSessions = queryAll<{ transcript_path: string; title: string }>(seed,
      'SELECT transcript_path, title FROM sessions ORDER BY transcript_path')
    seed.close(true)
    const { openLocalIndexDatabase } = await loadDatabase()
    const upgraded = openLocalIndexDatabase({ path: databasePath })
    try {
      expect(upgraded.read(operation => operation.all<{ name: string }>(
        'PRAGMA table_info(sessions)',
      ).map(row => row.name))).toContain('session_api_format')
      expect(upgraded.read(operation => operation.all<{ transcript_path: string; title: string }>(
        'SELECT transcript_path, title FROM sessions ORDER BY transcript_path',
      ))).toEqual(originalSessions)
      expect(upgraded.read(operation => operation.get<{ value: string }>(
        "SELECT value FROM schema_meta WHERE key = 'future-extension'",
      )?.value)).toBe('keep-me')
      expect(upgraded.read(operation => operation.get<{ count: number }>(
        'SELECT COUNT(*) AS count FROM sessions WHERE session_api_format IS NOT NULL',
      )?.count)).toBe(0)
    } finally {
      upgraded.close()
    }
  })

  it('rolls back an interrupted v2 to v3 migration without changing v2 data', async () => {
    const databasePath = join(process.env.CLAUDE_CONFIG_DIR!, 'blocked-v3.sqlite')
    await mkdir(dirname(databasePath), { recursive: true })
    const seed = await openRawDatabase(databasePath)
    seedFrozenV2(seed)
    seed.exec('CREATE TABLE activity_sources (migration_conflict TEXT)')
    seed.close(true)
    const { openLocalIndexDatabase } = await loadDatabase()

    expect(() => openLocalIndexDatabase({ path: databasePath })).toThrow()

    const inspection = await openRawDatabase(databasePath)
    try {
      expect(queryOne<{ user_version: number }>(inspection, 'PRAGMA user_version')
        ?.user_version).toBe(2)
      expect(queryOne<{ title: string }>(
        inspection,
        "SELECT title FROM sessions WHERE transcript_path = '/fixture/session.jsonl'",
      )?.title).toBe('Frozen v1')
      expect(queryOne<{ message_id: string }>(
        inspection,
        "SELECT message_id FROM session_entries WHERE transcript_path = '/fixture/session.jsonl'",
      )?.message_id).toBe('fixture-message')
      expect(queryAll<{ name: string }>(
        inspection,
        'PRAGMA table_info(activity_sources)',
      ).map(row => row.name)).toEqual(['migration_conflict'])
      expect(queryAll<{ name: string }>(
        inspection,
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'activity_%' ORDER BY name",
      ).map(row => row.name)).toEqual(['activity_sources'])
    } finally {
      inspection.close(true)
    }
  })

  it('rolls back an interrupted v1 to v2 migration without changing v1 data', async () => {
    const databasePath = join(process.env.CLAUDE_CONFIG_DIR!, 'blocked-v2.sqlite')
    await mkdir(dirname(databasePath), { recursive: true })
    const seed = await openRawDatabase(databasePath)
    seedFrozenV1(seed)
    seed.exec('CREATE TABLE session_entries (migration_conflict TEXT)')
    seed.close(true)
    const { openLocalIndexDatabase } = await loadDatabase()

    expect(() => openLocalIndexDatabase({ path: databasePath })).toThrow()

    const inspection = await openRawDatabase(databasePath)
    try {
      expect(queryOne<{ user_version: number }>(inspection, 'PRAGMA user_version')
        ?.user_version).toBe(1)
      expect(queryOne<{ value: string }>(
        inspection,
        "SELECT value FROM schema_meta WHERE key = 'fixture'",
      )?.value).toBe('v1-preserved')
      expect(queryAll<{ name: string }>(
        inspection,
        'PRAGMA table_info(session_entries)',
      ).map(row => row.name)).toEqual(['migration_conflict'])
    } finally {
      inspection.close(true)
    }
  })

  it('creates lossless session parity columns and numeric modified-time indexes', async () => {
    const databasePath = join(process.env.CLAUDE_CONFIG_DIR!, 'parity.sqlite')
    const { openLocalIndexDatabase } = await loadDatabase()
    const localIndexDatabase = openLocalIndexDatabase({ path: databasePath })

    try {
      const columns = localIndexDatabase.read(operation =>
        operation.all<{
          name: string
          notnull: number
          dflt_value: string | null
        }>('PRAGMA table_info(sessions)'),
      )
      expect(columns.find(column => column.name === 'modified_at_ms')).toMatchObject({
        notnull: 1,
        dflt_value: null,
      })
      expect(columns.find(column => column.name === 'runtime_provider_present')).toMatchObject({
        notnull: 1,
        dflt_value: '0',
      })

      const indexColumns = (name: string) => localIndexDatabase.read(operation =>
        operation.all<{
          name: string | null
          desc: number
          key: number
        }>(`PRAGMA index_xinfo(${name})`)
          .filter(column => column.key === 1)
          .map(column => ({ name: column.name, desc: column.desc })),
      )
      expect(indexColumns('sessions_modified_idx')).toEqual([
        { name: 'modified_at_ms', desc: 1 },
        { name: 'session_id', desc: 0 },
        { name: 'transcript_path', desc: 0 },
      ])
      expect(indexColumns('sessions_project_modified_idx')).toEqual([
        { name: 'project_path', desc: 0 },
        { name: 'modified_at_ms', desc: 1 },
        { name: 'session_id', desc: 0 },
        { name: 'transcript_path', desc: 0 },
      ])

      localIndexDatabase.write(operation => {
        for (const path of ['/absent.jsonl', '/explicit-null.jsonl', '/invalid.jsonl']) {
          operation.run(
            `INSERT INTO source_files (
              path, kind, size_bytes, mtime_ms, prefix_hash, indexed_bytes,
              parser_version, state, updated_at_ms
            ) VALUES (?, 'transcript', 0, 0, 'fingerprint', 0, 1, 'ready', 0)`,
            path,
          )
        }
        operation.run(
          `INSERT INTO sessions (
            transcript_path, session_id, project_path, title, created_at,
            modified_at, modified_at_ms, message_count, runtime_provider_id,
            runtime_provider_present
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          '/absent.jsonl',
          'absent',
          '-tmp',
          'Absent',
          '2026-07-15T00:00:00.000Z',
          '2026-07-15T00:00:00.000Z',
          1_752_537_600_000,
          0,
          null,
          0,
        )
        operation.run(
          `INSERT INTO sessions (
            transcript_path, session_id, project_path, title, created_at,
            modified_at, modified_at_ms, message_count, runtime_provider_id,
            runtime_provider_present
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          '/explicit-null.jsonl',
          'explicit-null',
          '-tmp',
          'Explicit null',
          '2026-07-15T00:00:00.000Z',
          '2026-07-15T00:00:00.000Z',
          1_752_537_600_000,
          0,
          null,
          1,
        )
      })
      expect(localIndexDatabase.read(operation =>
        operation.all<{
          session_id: string
          runtime_provider_id: string | null
          runtime_provider_present: number
        }>(
          `SELECT session_id, runtime_provider_id, runtime_provider_present
           FROM sessions
           ORDER BY session_id`,
        ),
      )).toEqual([
        {
          session_id: 'absent',
          runtime_provider_id: null,
          runtime_provider_present: 0,
        },
        {
          session_id: 'explicit-null',
          runtime_provider_id: null,
          runtime_provider_present: 1,
        },
      ])
      expect(() => localIndexDatabase.write(operation => {
        operation.run(
          `INSERT INTO sessions (
            transcript_path, session_id, project_path, title, created_at,
            modified_at, modified_at_ms, message_count, runtime_provider_present
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          '/invalid.jsonl',
          'invalid',
          '-tmp',
          'Invalid',
          '2026-07-15T00:00:00.000Z',
          '2026-07-15T00:00:00.000Z',
          1_752_537_600_000,
          0,
          2,
        )
      })).toThrow()
    } finally {
      localIndexDatabase.close()
    }
  })

  it('commits synchronous transactions and scopes their operation facade', async () => {
    const databasePath = join(process.env.CLAUDE_CONFIG_DIR!, 'transaction.sqlite')
    const { openLocalIndexDatabase } = await loadDatabase()
    const localIndexDatabase = openLocalIndexDatabase({ path: databasePath })
    let retainedOperation: LocalIndexWriteOperation | undefined

    try {
      expect(localIndexDatabase.transaction(operation => {
        retainedOperation = operation
        operation.run(
          "INSERT INTO schema_meta (key, value) VALUES ('first', 'one')",
        )
        operation.run(
          "INSERT INTO schema_meta (key, value) VALUES ('second', 'two')",
        )
        return 'committed'
      })).toBe('committed')
      expect(localIndexDatabase.read(operation =>
        operation.all<{ key: string }>(
          'SELECT key FROM schema_meta ORDER BY key',
        ).map(row => row.key),
      )).toEqual(['first', 'second'])
      expect(() => retainedOperation!.get('SELECT 1')).toThrow(
        'Local index database operation is no longer active',
      )
    } finally {
      localIndexDatabase.close()
    }
  })

  it('rolls back a partial transaction after SQL failure and remains usable', async () => {
    const databasePath = join(process.env.CLAUDE_CONFIG_DIR!, 'transaction-failure.sqlite')
    const { openLocalIndexDatabase } = await loadDatabase()
    const localIndexDatabase = openLocalIndexDatabase({ path: databasePath })

    try {
      expect(() => localIndexDatabase.transaction(operation => {
        operation.run(
          "INSERT INTO schema_meta (key, value) VALUES ('duplicate', 'first')",
        )
        operation.run(
          "INSERT INTO schema_meta (key, value) VALUES ('duplicate', 'second')",
        )
      })).toThrow()
      expect(localIndexDatabase.read(operation =>
        operation.get<{ count: number }>(
          "SELECT COUNT(*) AS count FROM schema_meta WHERE key = 'duplicate'",
        )?.count,
      )).toBe(0)

      expect(localIndexDatabase.transaction(operation => {
        operation.run(
          "INSERT INTO schema_meta (key, value) VALUES ('recovered', 'yes')",
        )
        return operation.get<{ value: string }>(
          "SELECT value FROM schema_meta WHERE key = 'recovered'",
        )?.value
      })).toBe('yes')
    } finally {
      localIndexDatabase.close()
    }
  })

  it('rejects thenables, rolls back their writes, and remains usable', async () => {
    const databasePath = join(process.env.CLAUDE_CONFIG_DIR!, 'transaction-thenable.sqlite')
    const { openLocalIndexDatabase } = await loadDatabase()
    const localIndexDatabase = openLocalIndexDatabase({ path: databasePath })
    let retainedOperation: LocalIndexWriteOperation | undefined

    try {
      expect(() => localIndexDatabase.transaction(operation => {
        retainedOperation = operation
        operation.run(
          "INSERT INTO schema_meta (key, value) VALUES ('async', 'unsafe')",
        )
        return Promise.resolve('not-supported')
      })).toThrow('Local index transactions must be synchronous')
      expect(localIndexDatabase.read(operation =>
        operation.get<{ value: string }>(
          "SELECT value FROM schema_meta WHERE key = 'async'",
        ),
      )).toBeNull()
      expect(() => localIndexDatabase.transaction(operation => {
        operation.run(
          "INSERT INTO schema_meta (key, value) VALUES ('thenable', 'unsafe')",
        )
        return { then() {} }
      })).toThrow('Local index transactions must be synchronous')
      expect(localIndexDatabase.read(operation =>
        operation.get<{ value: string }>(
          "SELECT value FROM schema_meta WHERE key = 'thenable'",
        ),
      )).toBeNull()
      expect(() => retainedOperation!.run(
        "INSERT INTO schema_meta (key, value) VALUES ('escaped', 'unsafe')",
      )).toThrow('Local index database operation is no longer active')

      expect(localIndexDatabase.transaction(operation =>
        operation.run(
          "INSERT INTO schema_meta (key, value) VALUES ('sync', 'safe')",
        ).changes,
      )).toBe(1)
    } finally {
      localIndexDatabase.close()
    }
  })

  it('consumes an async callback rejection after its operation becomes inactive', async () => {
    const databasePath = join(process.env.CLAUDE_CONFIG_DIR!, 'transaction-async-rejection.sqlite')
    const { openLocalIndexDatabase } = await loadDatabase()
    const localIndexDatabase = openLocalIndexDatabase({ path: databasePath })
    const unhandledRejections: unknown[] = []
    const onUnhandledRejection = (reason: unknown): void => {
      unhandledRejections.push(reason)
    }
    let operationBecameInactive = false
    process.on('unhandledRejection', onUnhandledRejection)

    try {
      expect(() => localIndexDatabase.transaction(async operation => {
        operation.run(
          "INSERT INTO schema_meta (key, value) VALUES ('async-late', 'unsafe')",
        )
        await Promise.resolve()
        try {
          operation.get('SELECT 1')
        } catch (error) {
          operationBecameInactive = error instanceof Error &&
            error.message === 'Local index database operation is no longer active'
        }
        throw new Error('async callback failed after await')
      })).toThrow('Local index transactions must be synchronous')

      await new Promise<void>(resolve => setImmediate(resolve))
      await new Promise<void>(resolve => setImmediate(resolve))
      expect(operationBecameInactive).toBeTrue()
      expect(unhandledRejections).toEqual([])
      expect(localIndexDatabase.read(operation =>
        operation.get<{ value: string }>(
          "SELECT value FROM schema_meta WHERE key = 'async-late'",
        ),
      )).toBeNull()
      expect(localIndexDatabase.transaction(operation =>
        operation.run(
          "INSERT INTO schema_meta (key, value) VALUES ('after-async', 'usable')",
        ).changes,
      )).toBe(1)
    } finally {
      process.off('unhandledRejection', onUnhandledRejection)
      localIndexDatabase.close()
    }
  })

  it('reports the stable synchronous error for hostile thenable access and execution', async () => {
    const databasePath = join(process.env.CLAUDE_CONFIG_DIR!, 'transaction-hostile-thenable.sqlite')
    const { openLocalIndexDatabase } = await loadDatabase()
    const localIndexDatabase = openLocalIndexDatabase({ path: databasePath })
    let thenInvoked = false

    try {
      const throwingGetter = Object.defineProperty({}, 'then', {
        get() {
          throw new Error('hostile then getter')
        },
      })
      expect(() => localIndexDatabase.transaction(operation => {
        operation.run(
          "INSERT INTO schema_meta (key, value) VALUES ('getter', 'unsafe')",
        )
        return throwingGetter
      })).toThrow('Local index transactions must be synchronous')

      expect(() => localIndexDatabase.transaction(operation => {
        operation.run(
          "INSERT INTO schema_meta (key, value) VALUES ('then-call', 'unsafe')",
        )
        return {
          then() {
            thenInvoked = true
            throw new Error('hostile then call')
          },
        }
      })).toThrow('Local index transactions must be synchronous')
      await Promise.resolve()
      expect(thenInvoked).toBeTrue()
      expect(localIndexDatabase.read(operation =>
        operation.get<{ count: number }>(
          "SELECT COUNT(*) AS count FROM schema_meta WHERE key IN ('getter', 'then-call')",
        )?.count,
      )).toBe(0)
    } finally {
      localIndexDatabase.close()
    }
  })

  it('rejects nested transactions with a stable error and no savepoint behavior', async () => {
    const databasePath = join(process.env.CLAUDE_CONFIG_DIR!, 'transaction-nested.sqlite')
    const { openLocalIndexDatabase } = await loadDatabase()
    const localIndexDatabase = openLocalIndexDatabase({ path: databasePath })

    try {
      expect(() => localIndexDatabase.transaction(operation => {
        operation.run(
          "INSERT INTO schema_meta (key, value) VALUES ('outer', 'rolled-back')",
        )
        localIndexDatabase.transaction(nestedOperation => {
          nestedOperation.run(
            "INSERT INTO schema_meta (key, value) VALUES ('inner', 'unsupported')",
          )
        })
      })).toThrow('Local index transactions cannot be nested')
      expect(localIndexDatabase.read(operation =>
        operation.get<{ count: number }>(
          "SELECT COUNT(*) AS count FROM schema_meta WHERE key IN ('outer', 'inner')",
        )?.count,
      )).toBe(0)
      expect(localIndexDatabase.transaction(operation =>
        operation.run(
          "INSERT INTO schema_meta (key, value) VALUES ('after-nested', 'usable')",
        ).changes,
      )).toBe(1)
    } finally {
      localIndexDatabase.close()
    }
  })

  it('preserves callback and commit failures when rollback cleanup also fails', async () => {
    const databasePath = join(process.env.CLAUDE_CONFIG_DIR!, 'transaction-error.sqlite')
    const { openLocalIndexDatabase } = await loadDatabase()
    const localIndexDatabase = openLocalIndexDatabase({ path: databasePath })

    try {
      expect(() => localIndexDatabase.transaction(operation => {
        operation.exec('ROLLBACK')
        throw new Error('primary callback failure')
      })).toThrow('primary callback failure')

      expect(() => localIndexDatabase.transaction(operation => {
        operation.exec('ROLLBACK')
      })).toThrow(/cannot commit/i)

      expect(localIndexDatabase.transaction(operation =>
        operation.run(
          "INSERT INTO schema_meta (key, value) VALUES ('after-errors', 'usable')",
        ).changes,
      )).toBe(1)
    } finally {
      localIndexDatabase.close()
    }
  })

  it('rolls back all v1 changes when the migration cannot complete', async () => {
    const databasePath = join(process.env.CLAUDE_CONFIG_DIR!, 'blocked.sqlite')
    await mkdir(dirname(databasePath), { recursive: true })
    const seed = await openRawDatabase(databasePath)
    seed.exec('CREATE TABLE sessions (conflict TEXT)')
    seed.close(true)
    const { openLocalIndexDatabase } = await loadDatabase()

    expect(() => openLocalIndexDatabase({ path: databasePath })).toThrow()

    const inspection = await openRawDatabase(databasePath)
    try {
      expect(queryOne<{ user_version: number }>(inspection, 'PRAGMA user_version')
        ?.user_version).toBe(0)
      expect(queryAll<{ name: string }>(
        inspection,
        "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
      ).map(row => row.name)).toEqual(['sessions'])
    } finally {
      inspection.close(true)
    }
  })

  it('rejects a future schema version without changing it', async () => {
    const databasePath = join(process.env.CLAUDE_CONFIG_DIR!, 'future.sqlite')
    await mkdir(dirname(databasePath), { recursive: true })
    const seed = await openRawDatabase(databasePath)
    seed.exec('CREATE TABLE future_schema_sentinel (value TEXT)')
    seed.exec(`PRAGMA user_version = ${LOCAL_INDEX_SCHEMA_VERSION + 1}`)
    const journalModeBefore = queryOne<{ journal_mode: string }>(
      seed,
      'PRAGMA journal_mode',
    )?.journal_mode
    seed.close(true)
    const familyBefore = (await readdir(dirname(databasePath)))
      .filter(name => name === basename(databasePath) || name.startsWith(`${basename(databasePath)}-`))
      .sort()
    const { openLocalIndexDatabase } = await loadDatabase()

    let error: unknown
    try {
      openLocalIndexDatabase({ path: databasePath })
    } catch (caught) {
      error = caught
    }
    expect(error).toMatchObject({ code: 'LOCAL_INDEX_SCHEMA_UNSUPPORTED' })

    const inspection = await openRawDatabase(databasePath)
    try {
      expect(queryOne<{ user_version: number }>(inspection, 'PRAGMA user_version')
        ?.user_version).toBe(LOCAL_INDEX_SCHEMA_VERSION + 1)
      expect(queryAll<{ name: string }>(
        inspection,
        "SELECT name FROM sqlite_master WHERE type = 'table'",
      ).map(row => row.name)).toContain('future_schema_sentinel')
      expect(queryOne<{ journal_mode: string }>(inspection, 'PRAGMA journal_mode')
        ?.journal_mode).toBe(journalModeBefore)
    } finally {
      inspection.close(true)
    }
    expect((await readdir(dirname(databasePath)))
      .filter(name => name === basename(databasePath) || name.startsWith(`${basename(databasePath)}-`))
      .sort()).toEqual(familyBefore)
  })

  it('reuses owned statements, scopes operations, and strictly closes them', async () => {
    const databasePath = join(process.env.CLAUDE_CONFIG_DIR!, 'close.sqlite')
    const { openLocalIndexDatabase } = await loadDatabase()
    const localIndexDatabase = openLocalIndexDatabase({ path: databasePath })
    localIndexDatabase.write(operation => {
      operation.run(
        "INSERT INTO schema_meta (key, value) VALUES ('close-proof', 'written')",
      )
    })

    const { Database } = await import('bun:sqlite')
    type QueryMethod = (
      sql: string,
    ) => ReturnType<InstanceType<typeof Database>['query']>
    const databasePrototype = Database.prototype as unknown as {
      query: QueryMethod
    }
    const originalQuery = databasePrototype.query
    const cachedSql = 'SELECT ? AS value'
    let prepareCount = 0
    let capturedStatement: ReturnType<QueryMethod> | undefined
    databasePrototype.query = function (sql: string) {
      const statement = originalQuery.call(this, sql)
      if (sql === cachedSql) {
        prepareCount += 1
        capturedStatement = statement
      }
      return statement
    }

    let retainedOperation: Parameters<typeof localIndexDatabase.read>[0] extends (
      operation: infer Operation,
    ) => unknown ? Operation : never
    try {
      expect(localIndexDatabase.read(operation => {
        retainedOperation = operation
        return operation.get<{ value: number }>(cachedSql, 1)?.value
      })).toBe(1)
      expect(localIndexDatabase.read(operation =>
        operation.get<{ value: number }>(cachedSql, 2)?.value,
      )).toBe(2)
      expect(prepareCount).toBe(1)
      expect(() => retainedOperation.get(cachedSql, 3)).toThrow(
        'Local index database operation is no longer active',
      )

      expect(() => localIndexDatabase.close()).not.toThrow()
      expect(() => capturedStatement?.get(4)).toThrow()
      expect(() => localIndexDatabase.read(() => null)).toThrow(
        'Local index database is closed',
      )
      expect(() => localIndexDatabase.transaction(() => null)).toThrow(
        'Local index database is closed',
      )
    } finally {
      databasePrototype.query = originalQuery
      localIndexDatabase.close()
    }
  })

  it('does not modify source transcripts while opening or migrating', async () => {
    const corpusRoot = await createTempDir('local-index-source-safety')
    const { createLocalIndexCorpus } = await import(
      '../../../../scripts/perf/local-index-corpus.js'
    )
    const corpus = await createLocalIndexCorpus({
      rootDir: corpusRoot,
      sessions: 8,
      entriesPerSession: 8,
      largeTranscriptBytes: 16 * 1024,
      seed: 20260714,
    })
    const before = await transcriptHashes(corpus.transcriptPaths)
    const databasePath = join(corpus.configDir, 'cc-haha', 'db', 'index-v1.sqlite')
    const { openLocalIndexDatabase } = await loadDatabase()

    openLocalIndexDatabase({ path: databasePath }).close()
    openLocalIndexDatabase({ path: databasePath }).close()

    expect(await transcriptHashes(corpus.transcriptPaths)).toEqual(before)
  })
})
