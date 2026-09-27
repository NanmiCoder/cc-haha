import type { Database } from 'bun:sqlite'

export const TRACE_INDEX_SCHEMA_VERSION = 6
export const TRACE_INDEX_SCHEMA_UNSUPPORTED =
  'TRACE_INDEX_SCHEMA_UNSUPPORTED' as const

const SCHEMA_V1 = `
CREATE TABLE trace_sources (
  session_id TEXT PRIMARY KEY,
  file_path TEXT NOT NULL UNIQUE,
  size_bytes INTEGER NOT NULL,
  mtime_ms REAL NOT NULL,
  indexed_bytes INTEGER NOT NULL,
  revision INTEGER NOT NULL,
  last_reset_revision INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('ready', 'degraded')),
  last_error_code TEXT,
  updated_at_ms INTEGER NOT NULL
);

CREATE TABLE trace_calls (
  session_id TEXT NOT NULL REFERENCES trace_sources(session_id) ON DELETE CASCADE,
  call_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  byte_start INTEGER NOT NULL,
  byte_length INTEGER NOT NULL,
  revision INTEGER NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  status TEXT NOT NULL,
  source TEXT NOT NULL,
  model TEXT,
  duration_ms REAL,
  failed INTEGER NOT NULL CHECK (failed IN (0, 1)),
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  PRIMARY KEY (session_id, call_id)
);

CREATE INDEX trace_calls_order_idx
  ON trace_calls(session_id, started_at, ordinal);
CREATE INDEX trace_calls_revision_idx
  ON trace_calls(session_id, revision);

CREATE TABLE trace_events (
  session_id TEXT NOT NULL REFERENCES trace_sources(session_id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,
  event_id TEXT NOT NULL,
  byte_start INTEGER NOT NULL,
  byte_length INTEGER NOT NULL,
  revision INTEGER NOT NULL,
  timestamp TEXT NOT NULL,
  phase TEXT NOT NULL,
  severity TEXT NOT NULL,
  call_id TEXT,
  source TEXT,
  model TEXT,
  PRIMARY KEY (session_id, ordinal)
);

CREATE INDEX trace_events_order_idx
  ON trace_events(session_id, timestamp, ordinal);
CREATE INDEX trace_events_revision_idx
  ON trace_events(session_id, revision);
`

const SCHEMA_V2 = `
ALTER TABLE trace_sources ADD COLUMN file_identity TEXT;
ALTER TABLE trace_sources ADD COLUMN fingerprint TEXT;
ALTER TABLE trace_sources ADD COLUMN pending_tail_bytes INTEGER NOT NULL DEFAULT 0;

CREATE TABLE trace_sessions (
  session_id TEXT PRIMARY KEY REFERENCES trace_sources(session_id) ON DELETE CASCADE,
  revision INTEGER NOT NULL,
  last_reset_revision INTEGER NOT NULL,
  next_ordinal INTEGER NOT NULL,
  api_calls INTEGER NOT NULL,
  failed_calls INTEGER NOT NULL,
  total_duration_ms REAL NOT NULL,
  total_input_tokens INTEGER NOT NULL,
  total_output_tokens INTEGER NOT NULL,
  summary_updated_at TEXT
);

CREATE TABLE trace_session_models (
  session_id TEXT NOT NULL REFERENCES trace_sessions(session_id) ON DELETE CASCADE,
  model TEXT NOT NULL,
  call_count INTEGER NOT NULL CHECK (call_count > 0),
  PRIMARY KEY (session_id, model)
);

INSERT INTO trace_sessions (
  session_id, revision, last_reset_revision, next_ordinal,
  api_calls, failed_calls, total_duration_ms,
  total_input_tokens, total_output_tokens, summary_updated_at
)
SELECT
  source.session_id,
  source.revision,
  source.last_reset_revision,
  COALESCE((
    SELECT MAX(ordinal) + 1 FROM (
      SELECT ordinal FROM trace_calls WHERE session_id = source.session_id
      UNION ALL
      SELECT ordinal FROM trace_events WHERE session_id = source.session_id
    )
  ), 0),
  COUNT(call.call_id),
  COALESCE(SUM(call.failed), 0),
  COALESCE(SUM(call.duration_ms), 0),
  COALESCE(SUM(call.input_tokens), 0),
  COALESCE(SUM(call.output_tokens), 0),
  (
    SELECT COALESCE(latest.completed_at, latest.started_at)
    FROM trace_calls AS latest
    WHERE latest.session_id = source.session_id
    ORDER BY latest.started_at DESC, latest.ordinal DESC
    LIMIT 1
  )
FROM trace_sources AS source
LEFT JOIN trace_calls AS call ON call.session_id = source.session_id
GROUP BY source.session_id;

INSERT INTO trace_session_models (session_id, model, call_count)
SELECT session_id, model, COUNT(*)
FROM trace_calls
WHERE model IS NOT NULL
GROUP BY session_id, model;
`

const SCHEMA_V3 = `
ALTER TABLE trace_sessions
  ADD COLUMN reset_token TEXT NOT NULL DEFAULT '';

UPDATE trace_sessions
SET reset_token = lower(hex(randomblob(16)))
WHERE reset_token = '';
`

const SCHEMA_V4 = `
ALTER TABLE trace_calls
  ADD COLUMN first_ordinal INTEGER NOT NULL DEFAULT 0;

UPDATE trace_calls
SET first_ordinal = ordinal;

ALTER TABLE trace_session_models
  ADD COLUMN first_started_at TEXT NOT NULL DEFAULT '';

ALTER TABLE trace_session_models
  ADD COLUMN first_ordinal INTEGER NOT NULL DEFAULT 0;

UPDATE trace_session_models
SET
  first_started_at = COALESCE((
    SELECT call.started_at
    FROM trace_calls AS call
    WHERE call.session_id = trace_session_models.session_id
      AND call.model = trace_session_models.model
    ORDER BY call.started_at, call.first_ordinal
    LIMIT 1
  ), ''),
  first_ordinal = COALESCE((
    SELECT call.first_ordinal
    FROM trace_calls AS call
    WHERE call.session_id = trace_session_models.session_id
      AND call.model = trace_session_models.model
    ORDER BY call.started_at, call.first_ordinal
    LIMIT 1
  ), 0);

CREATE INDEX trace_session_models_order_idx
  ON trace_session_models(session_id, first_started_at, first_ordinal);

-- Earlier schemas retained only the latest locator ordinal for each call ID,
-- so they cannot reconstruct canonical Map insertion order for LWW records.
-- The projection is disposable: force the next source access to rebuild from
-- JSONL instead of serving a plausibly ordered but incorrect migrated summary.
UPDATE trace_sources
SET state = 'degraded', last_error_code = 'TRACE_INDEX_V4_REBUILD_REQUIRED';
`

const SCHEMA_V5 = `
-- Session overviews are served from locators without re-reading the JSONL, so
-- the locator has to carry the few body facts the trace tree header shows.
ALTER TABLE trace_calls ADD COLUMN request_bytes INTEGER;
ALTER TABLE trace_calls ADD COLUMN response_bytes INTEGER;
ALTER TABLE trace_calls ADD COLUMN response_status INTEGER;
ALTER TABLE trace_events ADD COLUMN title TEXT;
ALTER TABLE trace_events ADD COLUMN message TEXT;

-- Pre-existing locator rows have NULL body facts; a shell built from them
-- would look permanently pending (no response) or sizeless. The projection is
-- disposable: force a one-time rebuild from JSONL on next access instead of
-- serving shells that misreport completed calls.
UPDATE trace_sources
SET state = 'degraded', last_error_code = 'TRACE_INDEX_V5_REBUILD_REQUIRED';
`

const SCHEMA_V6 = `
ALTER TABLE trace_sources ADD COLUMN oversized_records INTEGER NOT NULL DEFAULT 0;
ALTER TABLE trace_sources ADD COLUMN scan_truncated INTEGER NOT NULL DEFAULT 0;
ALTER TABLE trace_sources ADD COLUMN window_start_byte INTEGER NOT NULL DEFAULT 0;
CREATE INDEX trace_calls_page_order_idx ON trace_calls(session_id, started_at, first_ordinal);
CREATE INDEX trace_calls_model_order_idx ON trace_calls(session_id, model, started_at, first_ordinal);
UPDATE trace_sources SET state = 'degraded', last_error_code = 'TRACE_INDEX_V6_REBUILD_REQUIRED';
`

const MIGRATIONS = [
  { version: 1, sql: SCHEMA_V1 },
  { version: 2, sql: SCHEMA_V2 },
  { version: 3, sql: SCHEMA_V3 },
  { version: 4, sql: SCHEMA_V4 },
  { version: 5, sql: SCHEMA_V5 },
  { version: 6, sql: SCHEMA_V6 },
] as const

export class UnsupportedTraceIndexSchemaError extends Error {
  readonly code = TRACE_INDEX_SCHEMA_UNSUPPORTED

  constructor() {
    super('Unsupported trace index database schema')
    this.name = 'UnsupportedTraceIndexSchemaError'
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

export function assertTraceIndexSchemaSupported(database: Database): void {
  if (getUserVersion(database) > TRACE_INDEX_SCHEMA_VERSION) {
    throw new UnsupportedTraceIndexSchemaError()
  }
}

export function migrateTraceIndexDatabase(database: Database): void {
  const currentVersion = getUserVersion(database)
  if (currentVersion > TRACE_INDEX_SCHEMA_VERSION) {
    throw new UnsupportedTraceIndexSchemaError()
  }
  if (currentVersion === TRACE_INDEX_SCHEMA_VERSION) return

  database.transaction(() => {
    for (const migration of MIGRATIONS) {
      if (migration.version <= currentVersion) continue
      database.exec(migration.sql)
      database.exec(`PRAGMA user_version = ${migration.version}`)
    }
  })()
}
