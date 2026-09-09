import type { Database } from 'bun:sqlite'

export const LOCAL_INDEX_SCHEMA_VERSION = 5
export const LOCAL_INDEX_SCHEMA_UNSUPPORTED =
  'LOCAL_INDEX_SCHEMA_UNSUPPORTED' as const

const SCHEMA_V1 = `
CREATE TABLE schema_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

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
  runtime_provider_present INTEGER NOT NULL DEFAULT 0
    CHECK (runtime_provider_present IN (0, 1)),
  runtime_model_id TEXT,
  effort_level TEXT
);

CREATE INDEX sessions_modified_idx
  ON sessions(modified_at_ms DESC, session_id, transcript_path);
CREATE INDEX sessions_project_modified_idx
  ON sessions(project_path, modified_at_ms DESC, session_id, transcript_path);
CREATE INDEX sessions_id_project_idx
  ON sessions(session_id, project_path, transcript_path);

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
`

const SCHEMA_V2 = `
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
`

const SCHEMA_V3 = `
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
`

// Time actually spent working, as opposed to the calendar span between a session's first and last
// message. Existing rows default to 0 and are refilled when the bumped parser version rebuilds
// them; nothing reads the column before that rebuild lands.
const SCHEMA_V4 = `
ALTER TABLE activity_sessions ADD COLUMN active_duration_ms INTEGER NOT NULL DEFAULT 0;
`

// Additive cache migration. Parser v5 reprojects old rows from unchanged transcripts.
const SCHEMA_V5 = `
ALTER TABLE sessions ADD COLUMN session_api_format TEXT;
`

const MIGRATIONS = [
  { version: 1, sql: SCHEMA_V1 },
  { version: 2, sql: SCHEMA_V2 },
  { version: 3, sql: SCHEMA_V3 },
  { version: 4, sql: SCHEMA_V4 },
  { version: 5, sql: SCHEMA_V5 },
] as const

export class UnsupportedLocalIndexSchemaError extends Error {
  readonly code = LOCAL_INDEX_SCHEMA_UNSUPPORTED

  constructor() {
    super('Unsupported local index database schema')
    this.name = 'UnsupportedLocalIndexSchemaError'
  }
}

function getUserVersion(database: Database): number {
  const statement = database.prepare<{ user_version: number }, []>(
    'PRAGMA user_version',
  )
  try {
    return statement.get()?.user_version ?? 0
  } finally {
    statement.finalize()
  }
}

export function assertLocalIndexSchemaSupported(database: Database): void {
  const currentVersion = getUserVersion(database)
  if (currentVersion > LOCAL_INDEX_SCHEMA_VERSION) {
    throw new UnsupportedLocalIndexSchemaError()
  }
}

export function migrateLocalIndexDatabase(database: Database): void {
  const currentVersion = getUserVersion(database)
  if (currentVersion > LOCAL_INDEX_SCHEMA_VERSION) {
    throw new UnsupportedLocalIndexSchemaError()
  }
  if (currentVersion === LOCAL_INDEX_SCHEMA_VERSION) return

  database.transaction(() => {
    for (const migration of MIGRATIONS) {
      if (migration.version <= currentVersion) continue
      database.exec(migration.sql)
      database.exec(`PRAGMA user_version = ${migration.version}`)
    }
  })()
}
