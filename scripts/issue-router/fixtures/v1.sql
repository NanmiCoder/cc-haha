-- Frozen v1 database, including an interrupted create operation and its owner.
PRAGMA application_id = 1230197332;
PRAGMA user_version = 1;
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
INSERT INTO meta VALUES ('repository_id', '12345'), ('repository', 'Fixture/repo'),
  ('required_checks', '["pr-quality-gate"]'), ('cursor', 'legacy-cursor'), ('baseline', 'true');
INSERT INTO issues(number, title, state, fingerprint, updated_at, queue_state, branch, modules)
  VALUES (7, 'Legacy issue', 'open', 'legacy-fingerprint', '2026-10-20T00:00:00Z', 'active', 'fix/issue-7-fixture', '["server"]');
INSERT INTO runs(run_id, issue_number, owner, generation, active, phase, branch, updated_at)
  VALUES ('legacy-run', 7, 'legacy-owner', 3, 1, 'dispatch', 'fix/issue-7-fixture', 1);
INSERT INTO resources VALUES ('slot:1', 'legacy-run', 3), ('module:server', 'legacy-run', 3);
INSERT INTO inbox VALUES ('legacy-event', 7, 'legacy-fingerprint', '{}', 0);
INSERT INTO outbox VALUES ('legacy-action', 'legacy-run', 3, 'create', 'unknown',
  '{"number":7,"fingerprint":"legacy-fingerprint","marker":"legacy-marker"}', 'legacy-sender', NULL, 1);
