-- Frozen v2 changes applied to the frozen v1 fixture, before revision tracking.
ALTER TABLE runs ADD COLUMN lease_until INTEGER NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX one_active_session ON runs(session) WHERE active = 1 AND session IS NOT NULL;
CREATE UNIQUE INDEX one_active_worktree ON runs(worktree) WHERE active = 1 AND worktree IS NOT NULL;
CREATE UNIQUE INDEX one_active_pr ON runs(pr_number) WHERE active = 1 AND pr_number IS NOT NULL;
PRAGMA user_version = 2;
