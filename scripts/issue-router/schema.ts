import { Database } from 'bun:sqlite'
import { chmodSync, closeSync, existsSync, linkSync, mkdirSync, openSync, realpathSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { ensure, type Layout, registerLayout, requireIgnored } from './git'

export const schemaVersion = 3
const applicationId = 0x49535254

// v1 is the initial contract; v2 adds lease/identity constraints, v3 versions
// content transitions. Neither migration nor lease expiry releases ownership.
const v1 = `
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE issues (
  number INTEGER PRIMARY KEY, title TEXT NOT NULL, state TEXT NOT NULL,
  fingerprint TEXT NOT NULL, delivered TEXT, updated_at TEXT NOT NULL,
  queue_state TEXT NOT NULL, covered_by INTEGER, branch TEXT UNIQUE, modules TEXT NOT NULL DEFAULT '[]'
);
CREATE TABLE runs (
  run_id TEXT PRIMARY KEY, issue_number INTEGER NOT NULL REFERENCES issues(number),
  owner TEXT NOT NULL, generation INTEGER NOT NULL DEFAULT 1, active INTEGER NOT NULL CHECK(active IN (0,1)),
  phase TEXT NOT NULL, branch TEXT NOT NULL, session TEXT, worktree TEXT,
  pr_number INTEGER, pr_url TEXT, head TEXT, base TEXT, next_step TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX one_active_run ON runs(issue_number) WHERE active = 1;
CREATE TABLE inbox (
  event_key TEXT PRIMARY KEY, issue_number INTEGER NOT NULL REFERENCES issues(number),
  fingerprint TEXT NOT NULL, payload TEXT NOT NULL, consumed INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE outbox (
  action_key TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(run_id), generation INTEGER NOT NULL,
  kind TEXT NOT NULL, status TEXT NOT NULL, payload TEXT NOT NULL,
  sender TEXT, result TEXT, updated_at INTEGER NOT NULL
);
CREATE TABLE resources (
  name TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(run_id), generation INTEGER NOT NULL
);
CREATE TABLE evidence (
  run_id TEXT NOT NULL REFERENCES runs(run_id), kind TEXT NOT NULL, payload TEXT NOT NULL,
  PRIMARY KEY(run_id, kind)
);
CREATE TABLE events (
  id INTEGER PRIMARY KEY, run_id TEXT, kind TEXT NOT NULL, data TEXT NOT NULL, created_at INTEGER NOT NULL
);
PRAGMA user_version = 1;
`

function upgradeV1(db: Database) {
  db.exec(`ALTER TABLE runs ADD COLUMN lease_until INTEGER NOT NULL DEFAULT 0;
    CREATE UNIQUE INDEX one_active_session ON runs(session) WHERE active = 1 AND session IS NOT NULL;
    CREATE UNIQUE INDEX one_active_worktree ON runs(worktree) WHERE active = 1 AND worktree IS NOT NULL;
    CREATE UNIQUE INDEX one_active_pr ON runs(pr_number) WHERE active = 1 AND pr_number IS NOT NULL;
    PRAGMA user_version = 2;`)
}

function upgradeV2(db: Database) {
  db.exec(`ALTER TABLE issues ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;
    ALTER TABLE issues ADD COLUMN delivered_revision INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE inbox ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;
    PRAGMA user_version = 3;`)
}

export function checkIdentity(db: Database, layout: Layout) {
  ensure((db.query('PRAGMA application_id').get() as any).application_id === applicationId,
    'database_identity', 'Not an issue-router database')
  ensure((db.query('PRAGMA quick_check').get() as any).quick_check === 'ok', 'database_corrupt', 'SQLite integrity check failed')
  const values = Object.fromEntries((db.query('SELECT key, value FROM meta').all() as any[]).map((r) => [r.key, r.value]))
  ensure(values.common_dir === layout.commonDir && values.primary === layout.primary,
    'database_identity', 'Database belongs to a different checkout; reconcile identity before recovery')
  ensure(values.repository_id && values.repository && values.required_checks, 'database_identity', 'Incomplete repository metadata')
  return values as Record<string, string>
}

export function version(db: Database) {
  return (db.query('PRAGMA user_version').get() as any).user_version as number
}

function connect(layout: Layout) {
  ensure(existsSync(layout.database), 'database_missing', 'State is missing; stop dispatching. Use explicit init only for a new router, or restore a backup')
  const db = new Database(layout.database, { readwrite: true, create: false, strict: true })
  try {
    db.exec('PRAGMA busy_timeout = 10000; PRAGMA foreign_keys = ON; PRAGMA synchronous = FULL;')
    checkIdentity(db, layout)
    return db
  } catch (error) {
    db.close()
    throw error
  }
}

export function openState(layout: Layout) {
  const db = connect(layout)
  if (version(db) !== schemaVersion) {
    const actual = version(db)
    db.close()
    ensure(false, 'schema_version', `Schema ${actual} requires explicit migrate; supported ${schemaVersion}`)
  }
  return db
}

export function initState(layout: Layout, repositoryId: string, repository: string, requiredChecks: string[]) {
  requireIgnored(layout)
  mkdirSync(layout.stateRoot, { recursive: true, mode: 0o700 })
  // Exclusive reservation makes concurrent init fail instead of adopting an
  // empty/partially initialized database. A crash requires explicit recovery.
  const fd = openSync(layout.database, 'wx', 0o600)
  closeSync(fd)
  registerLayout(layout)
  const db = new Database(layout.database, { readwrite: true, create: false, strict: true })
  try {
    db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON;')
    db.transaction(() => {
      db.exec(v1)
      upgradeV1(db)
      upgradeV2(db)
      db.exec(`PRAGMA application_id = ${applicationId}`)
      const put = db.query('INSERT INTO meta(key, value) VALUES (?, ?)')
      for (const [key, value] of Object.entries({
        common_dir: layout.commonDir, primary: layout.primary, repository_id: repositoryId,
        repository, required_checks: JSON.stringify(requiredChecks), cursor: '', baseline: 'false',
      })) put.run(key, value)
    }).immediate()
    return { database: layout.database, schema_version: schemaVersion }
  } finally {
    db.close()
  }
}

export function backupState(db: Database, layout: Layout) {
  const directory = join(layout.stateRoot, 'backups')
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const path = join(directory, `${Date.now()}-${randomUUID()}.sqlite3`)
  db.query('VACUUM INTO ?').run(path)
  chmodSync(path, 0o600)
  return { backup: path }
}

export function migrateState(layout: Layout) {
  const db = connect(layout)
  try {
    const previous = version(db)
    ensure([1, 2, schemaVersion].includes(previous), 'schema_version', `Unsupported schema ${previous}`)
    if (previous === schemaVersion) return { schema_version: schemaVersion, migrated: false }
    const backup = backupState(db, layout)
    db.transaction(() => {
      if (version(db) === 1) {
        upgradeV1(db)
      }
      if (version(db) === 2) upgradeV2(db)
    }).immediate()
    return { ...backup, schema_version: schemaVersion, migrated: true }
  } finally {
    db.close()
  }
}

/** Restore is explicit and requires stopped clients and a missing destination. */
export function restoreState(layout: Layout, backup: string) {
  requireIgnored(layout)
  ensure(!existsSync(layout.database) && !existsSync(`${layout.database}-wal`) && !existsSync(`${layout.database}-shm`),
    'restore_destination', 'Stop all clients and quarantine the existing database, WAL and SHM before restore')
  const source = new Database(realpathSync(backup), { readonly: true, create: false, strict: true })
  try {
    checkIdentity(source, layout)
    ensure([1, 2, schemaVersion].includes(version(source)), 'schema_version', 'Unsupported backup schema')
    mkdirSync(layout.stateRoot, { recursive: true, mode: 0o700 })
    // VACUUM INTO refuses to overwrite an existing nonempty file and includes
    // committed WAL data in a consistent snapshot, unlike a plain file copy.
    const staging = join(layout.stateRoot, `restore-${randomUUID()}.sqlite3`)
    try {
      source.query('VACUUM INTO ?').run(staging)
      chmodSync(staging, 0o600)
      const restored = new Database(staging, { readwrite: true, create: false, strict: true })
      try {
        restored.query("INSERT INTO meta(key, value) VALUES ('recovery_required', 'true') ON CONFLICT(key) DO UPDATE SET value = 'true'").run()
      } finally {
        restored.close()
      }
      // Hard-link publication is atomic and refuses concurrent initialization.
      linkSync(staging, layout.database)
    } finally {
      if (existsSync(staging)) unlinkSync(staging)
    }
    return { database: layout.database, schema_version: version(source), reconcile_required: true }
  } finally {
    source.close()
  }
}
