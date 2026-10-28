-- Frozen v3 changes/data applied to the frozen v1+v2 fixture. No created_at yet.
ALTER TABLE issues ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;
ALTER TABLE issues ADD COLUMN delivered_revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE inbox ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;
PRAGMA user_version = 3;
UPDATE issues SET number = 1704, title = 'Active fixture 1704', branch = 'fix/issue-1704-fixture' WHERE number = 7;
UPDATE inbox SET issue_number = 1704 WHERE issue_number = 7;
UPDATE runs SET issue_number = 1704,
  run_id = '53175620-20c9-44dc-8583-14e6e8616603', owner = 'fixture-active-owner', phase = 'working',
  branch = 'fix/issue-1704-fixture', session = '{"client":"fixture","host":"fixture-host","session_id":"active-1704"}',
  worktree = '/fixture/issue-1704' WHERE run_id = 'legacy-run';
UPDATE resources SET run_id = '53175620-20c9-44dc-8583-14e6e8616603' WHERE run_id = 'legacy-run';
UPDATE outbox SET run_id = '53175620-20c9-44dc-8583-14e6e8616603', kind = 'resume',
  payload = '{"number":1704,"fingerprint":"legacy-fingerprint","revision":1}' WHERE run_id = 'legacy-run';
INSERT INTO resources VALUES ('desktop-smoke', '53175620-20c9-44dc-8583-14e6e8616603', 3),
  ('main-merge', '53175620-20c9-44dc-8583-14e6e8616603', 3);
WITH RECURSIVE history(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM history WHERE n < 100)
INSERT INTO issues(number, title, state, fingerprint, updated_at, queue_state)
  SELECT n, 'History ' || n, 'open', 'history-' || n, '2026-10-20T00:00:00Z', 'baseline' FROM history;
