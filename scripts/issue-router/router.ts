import type { Database } from 'bun:sqlite'
import { createHash, randomUUID } from 'node:crypto'
import { commandSchema, type Command, type Token } from './commands'
import { ensure, installExclude, resolveLayout } from './git'
import { backupState, initState, migrateState, openState, restoreState } from './schema'

type Run = {
  run_id: string; issue_number: number; owner: string; generation: number; active: number; phase: string
  branch: string; session: string | null; worktree: string | null; pr_number: number | null; pr_url: string | null
  head: string | null; base: string | null; next_step: string; updated_at: number; lease_until: number
}
type Issue = {
  number: number; title: string; state: string; fingerprint: string; delivered: string | null
  updated_at: string; queue_state: string; covered_by: number | null; branch: string | null; modules: string
  revision: number; delivered_revision: number
  created_at: string | null
}
type Action = {
  action_key: string; run_id: string; generation: number; kind: string; status: string
  payload: string; sender: string | null; result: string | null; updated_at: number
}

const json = (value: unknown) => JSON.stringify(value)
const hash = (value: unknown) => createHash('sha256').update(json(value)).digest('hex')

/** All mutations finish in one short IMMEDIATE transaction. No network calls. */
class Router {
  constructor(private db: Database, private now: number) {}

  meta(key: string) {
    return (this.db.query('SELECT value FROM meta WHERE key = ?').get(key) as any)?.value as string | undefined
  }

  putMeta(key: string, value: string) {
    this.db.query('INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value)
  }

  event(kind: string, data: unknown, runId: string | null = null) {
    this.db.query('INSERT INTO events(run_id, kind, data, created_at) VALUES (?, ?, ?, ?)').run(runId, kind, json(data), this.now)
  }

  issue(number: number) {
    const issue = this.db.query('SELECT * FROM issues WHERE number = ?').get(number) as Issue | null
    ensure(issue, 'issue_missing', `Unknown issue ${number}; observe it first`)
    return issue
  }

  eligibility(issue: Issue) {
    const since = this.meta('created_since')
    if (!since) return 'policy_unconfigured'
    if (!issue.created_at) return 'created_at_required'
    return Date.parse(issue.created_at) < Date.parse(since) ? 'before_created_since' : 'eligible'
  }

  eligible(issue: Issue) {
    const state = this.eligibility(issue)
    ensure(state === 'eligible', state, state === 'policy_unconfigured'
      ? 'Configure the fixed created_since boundary before new dispatch'
      : state === 'created_at_required' ? 'Issue created_at is unknown; observe real metadata before new dispatch'
        : 'Issue was created before the fixed created_since boundary')
  }

  owned(token: Token) {
    const run = this.db.query('SELECT * FROM runs WHERE run_id = ?').get(token.run_id) as Run | null
    ensure(run?.active && run.owner === token.owner && run.generation === token.generation, 'stale_owner', 'Run is inactive or owner/generation changed')
    return run
  }

  action(run: Run, key: string) {
    const action = this.db.query('SELECT * FROM outbox WHERE action_key = ?').get(key) as Action | null
    ensure(action && action.run_id === run.run_id && action.generation === run.generation, 'stale_action', 'Action belongs to another run/generation')
    return action
  }

  queue(run: Run, kind: string, identity: string, payload: unknown) {
    const key = `${kind}:${hash([run.run_id, run.generation, identity])}`
    this.db.query(`INSERT INTO outbox(action_key, run_id, generation, kind, status, payload, updated_at)
      VALUES (?, ?, ?, ?, 'pending', ?, ?) ON CONFLICT(action_key) DO UPDATE SET status = 'pending',
      payload = excluded.payload, updated_at = excluded.updated_at WHERE outbox.status = 'cancelled' AND outbox.kind = 'merge'`)
      .run(key, run.run_id, run.generation, kind, json(payload), this.now)
    return this.action(run, key)
  }

  delivered(run: Run, action: Action) {
    // An older acknowledgement must not overwrite delivery of newer material.
    const fingerprint = JSON.parse(action.payload).fingerprint
    const revision = JSON.parse(action.payload).revision
    // Legacy actions have no revision. Their result may be reconciled, then
    // consume queues a fresh current snapshot instead of guessing delivery.
    if (revision !== undefined) this.db.query('UPDATE issues SET delivered = ?, delivered_revision = ? WHERE number = ? AND revision = ?')
      .run(fingerprint, revision, run.issue_number, revision)
  }

  context(run: Run) {
    const initial = this.db.query("SELECT payload FROM outbox WHERE run_id = ? AND generation = ? AND kind IN ('create', 'resume')").all(run.run_id, run.generation) as any[]
    return {
      mode: initial.some((action) => JSON.parse(action.payload).mode === 'analysis') ? 'analysis' : 'implementation',
      original_pr: run.pr_number, marker: `issue-router:${run.run_id}:${run.generation}`,
    }
  }

  resource(run: Run, name: string) {
    const holder = this.db.query('SELECT * FROM resources WHERE name = ?').get(name) as any
    ensure(!holder || (holder.run_id === run.run_id && holder.generation === run.generation), 'resource_busy', `Resource ${name} is occupied`)
    this.db.query('INSERT OR IGNORE INTO resources(name, run_id, generation) VALUES (?, ?, ?)').run(name, run.run_id, run.generation)
  }

  saveEvidence(run: Run, kind: string, evidence: unknown) {
    const normalized = { ...(evidence as object), observed_at: new Date((evidence as any).observed_at).toISOString() }
    this.guardObservation(run, kind, normalized)
    this.db.query('INSERT INTO evidence(run_id, kind, payload) VALUES (?, ?, ?) ON CONFLICT(run_id, kind) DO UPDATE SET payload = excluded.payload')
      .run(run.run_id, kind, json(normalized))
    this.event(kind, normalized, run.run_id)
  }

  guardObservation(run: Run, kind: string, evidence: any) {
    const prior = this.db.query('SELECT data AS payload FROM events WHERE run_id = ? AND kind = ? ORDER BY id DESC LIMIT 1').get(run.run_id, kind) as any
    if (!prior) return
    const previous = JSON.parse(prior.payload)
    const incomingTime = Date.parse(evidence.observed_at)
    const previousTime = Date.parse(previous.observed_at)
    ensure(incomingTime >= previousTime, 'older_observation', 'Cannot overwrite newer evidence with an older observation')
    const normalize = (value: any) => ({ ...value, observed_at: new Date(value.observed_at).toISOString() })
    ensure(incomingTime !== previousTime || json(normalize(evidence)) === json(normalize(previous)),
      'ambiguous_observation', 'Different observations at the same time are ambiguous; re-query')
  }

  fresh(observedAt: string) {
    const age = this.now - Date.parse(observedAt)
    ensure(age >= -60_000 && age <= 15 * 60_000, 'stale_observation', 'External observation must be within 15 minutes of this operation')
  }

  versions(run: Run, command: { head: string; base: string }) {
    ensure(run.pr_number && run.head === command.head && run.base === command.base, 'version_mismatch', 'Evidence does not match the current PR head and base')
    ensure(run.base === this.meta('main_head'), 'base_changed', 'Main advanced; refresh/integrate the PR and all version-bound evidence')
  }

  bind(run: Run, action: Action, session: unknown, worktree: string) {
    ensure(action.kind === 'create', 'action_kind', 'Only create actions bind sessions')
    if (run.session) ensure(run.session === json(session) && run.worktree === worktree, 'session_conflict', 'Run already has another session/worktree')
    this.db.query('UPDATE runs SET session = ?, worktree = ?, phase = ?, updated_at = ? WHERE run_id = ?')
      .run(json(session), worktree, 'working', this.now, run.run_id)
    this.delivered(run, action)
  }

  consume(run: Run) {
    ensure(run.session, 'session_missing', 'Bind or reconcile the original session before continuing it')
    const issue = this.issue(run.issue_number)
    let action: Action | null = null
    if (issue.delivered_revision !== issue.revision) {
      const currentKey = `resume:${hash([run.run_id, run.generation, String(issue.revision)])}`
      this.db.query("UPDATE outbox SET status = 'cancelled' WHERE run_id = ? AND generation = ? AND kind = 'resume' AND status = 'pending' AND action_key != ?")
        .run(run.run_id, run.generation, currentKey)
      action = this.queue(run, 'resume', String(issue.revision), {
        number: issue.number, fingerprint: issue.fingerprint, revision: issue.revision, session: JSON.parse(run.session),
        ...this.context(run),
      })
    }
    this.db.query('UPDATE inbox SET consumed = 1 WHERE issue_number = ?').run(run.issue_number)
    return { action }
  }

  execute(command: Exclude<Command, { command: 'locate' | 'install-exclude' | 'init' | 'backup' | 'migrate' | 'restore' }>): unknown {
    if (command.command === 'status') {
      return {
        repository_id: this.meta('repository_id'), repository: this.meta('repository'), cursor: this.meta('cursor'),
        baseline: this.meta('baseline') === 'true', recovery_required: this.meta('recovery_required') === 'true',
        main_head: this.meta('main_head') ?? null,
        dispatch_policy: { created_since: this.meta('created_since') ?? null, max_active: null, same_module: 'parallel_isolated_worktrees' },
        issues: (this.db.query('SELECT * FROM issues ORDER BY number').all() as Issue[]).map((issue) => ({ ...issue, dispatch_eligibility: this.eligibility(issue) })),
        runs: (this.db.query('SELECT * FROM runs WHERE active = 1 ORDER BY updated_at').all() as Run[]).map((run) => ({
          ...run, session: run.session ? JSON.parse(run.session) : null, lease_expired: run.lease_until <= this.now,
          ...this.context(run),
        })),
        actions: (this.db.query("SELECT * FROM outbox WHERE status NOT IN ('sent', 'cancelled') ORDER BY rowid").all() as Action[])
          .map((action) => ({ ...action, payload: JSON.parse(action.payload) })),
        resources: this.db.query('SELECT * FROM resources ORDER BY name').all(),
        inbox_pending: (this.db.query('SELECT count(*) AS n FROM inbox WHERE consumed = 0').get() as any).n,
        last_event: (this.db.query('SELECT max(id) AS id FROM events').get() as any).id,
      }
    }
    if (command.command === 'recovery-confirm') {
      this.putMeta('recovery_required', 'false')
      this.event('recovery_confirmed', command)
      return { reconciled: true }
    }
    ensure(this.meta('recovery_required') !== 'true', 'recovery_required', 'Reconcile sessions, PRs and resources, then recovery-confirm before mutations')

    if (command.command === 'configure') {
      const since = new Date(command.created_since).toISOString()
      const previous = this.meta('created_since')
      ensure(!previous || previous === since, 'policy_fixed', 'created_since is already fixed; scans must not move the boundary')
      this.putMeta('created_since', since)
      this.event('configure', { created_since: since, reference: command.reference })
      return { created_since: since, max_active: null, same_module: 'parallel_isolated_worktrees' }
    }

    if (command.command === 'observe-main') {
      this.fresh(command.observed_at)
      const previous = this.meta('main_head') ?? null
      ensure(previous === command.previous || previous === command.sha, 'main_conflict', 'Main observation raced another update; re-query the ref and ancestry')
      this.putMeta('main_head', command.sha)
      this.event('observe_main', command)
      return { main_head: command.sha }
    }

    if (command.command === 'observe') {
      const scanKey = `scan:${command.scan_id}`
      const digest = hash(command)
      const prior = this.meta(scanKey)
      if (prior) {
        ensure(prior === digest, 'scan_conflict', 'Scan ID was already used with different contents')
        return { replay: true, cursor: this.meta('cursor') }
      }
      ensure(command.cursor_before === this.meta('cursor'), 'cursor_conflict', 'Another scan advanced the cursor; query again with overlap')
      ensure(command.baseline === (this.meta('baseline') !== 'true'), 'baseline_required', 'First complete scan must be baseline; later scans must be incremental')
      const candidates = command.candidates.filter((candidate) => !candidate.is_pr)
      ensure(new Set(candidates.map((candidate) => candidate.number)).size === candidates.length, 'duplicate_candidate', 'Combine repeated candidates before committing a scan')
      let inserted = 0
      for (const candidate of candidates) {
        const priorIssue = this.db.query('SELECT * FROM issues WHERE number = ?').get(candidate.number) as Issue | null
        const createdAt = candidate.created_at ? new Date(candidate.created_at).toISOString() : null
        ensure(!priorIssue?.created_at || !createdAt || priorIssue.created_at === createdAt,
          'created_at_conflict', 'Issue creation time is immutable; reconcile conflicting source metadata')
        // Overlap windows can return older snapshots. Never overwrite new data.
        if (priorIssue && Date.parse(candidate.updated_at) < Date.parse(priorIssue.updated_at)) continue
        const changed = !priorIssue || candidate.fingerprint !== priorIssue.fingerprint || candidate.state !== priorIssue.state
        const revision = priorIssue ? priorIssue.revision + (changed ? 1 : 0) : 1
        this.db.query(`INSERT INTO issues(number, title, state, fingerprint, updated_at, queue_state, revision, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(number) DO UPDATE SET title = excluded.title,
          state = excluded.state, fingerprint = excluded.fingerprint, updated_at = excluded.updated_at, revision = excluded.revision,
          created_at = COALESCE(issues.created_at, excluded.created_at)`)
          .run(candidate.number, candidate.title, candidate.state, candidate.fingerprint, candidate.updated_at, command.baseline ? 'baseline' : 'observed', revision, createdAt)
        if (changed) {
          const eventKey = hash([this.meta('repository_id'), candidate.number, revision])
          const result = this.db.query('INSERT OR IGNORE INTO inbox(event_key, issue_number, fingerprint, payload, consumed, revision) VALUES (?, ?, ?, ?, ?, ?)')
            .run(eventKey, candidate.number, candidate.fingerprint, json(candidate), command.baseline ? 1 : 0, revision)
          inserted += result.changes
        }
      }
      this.putMeta('cursor', command.cursor_after)
      this.putMeta('baseline', 'true')
      this.putMeta(scanKey, digest)
      this.event('observe', { scan_id: command.scan_id, cursor: command.cursor_after, inserted, baseline: command.baseline })
      return { inserted, cursor: command.cursor_after, baseline: command.baseline }
    }
    if (command.command === 'cover') {
      const issue = this.issue(command.number)
      this.issue(command.covered_by)
      ensure(command.number !== command.covered_by, 'coverage_cycle', 'Issue cannot cover itself')
      ensure(issue.queue_state !== 'active', 'active_run', 'An owned issue must be reconciled by its executor')
      let ancestor: number | null = command.covered_by
      const visited = new Set([command.number])
      while (ancestor !== null) {
        ensure(!visited.has(ancestor), 'coverage_cycle', 'Duplicate coverage must not form a cycle')
        visited.add(ancestor)
        ancestor = this.issue(ancestor).covered_by
      }
      this.db.query("UPDATE issues SET covered_by = ?, queue_state = 'covered' WHERE number = ?").run(command.covered_by, command.number)
      this.event('cover', command)
      return { covered_by: command.covered_by }
    }
    if (command.command === 'enqueue') {
      const issue = this.issue(command.number)
      this.eligible(issue)
      ensure(issue.state === 'open' && !issue.covered_by, 'not_eligible', 'Only open, uncovered issues can be queued')
      ensure(command.branch.startsWith(`fix/issue-${command.number}-`) || command.branch.startsWith(`feat/issue-${command.number}-`), 'branch_identity', 'Branch must identify this issue')
      ensure(!issue.branch || issue.branch === command.branch, 'branch_conflict', 'An issue keeps its original branch and PR')
      ensure(!['active', 'complete'].includes(issue.queue_state), 'active_run', 'Continue or reconcile the original task; do not requeue')
      this.db.query("UPDATE issues SET queue_state = 'queued', branch = ?, modules = ? WHERE number = ?")
        .run(command.branch, json([...new Set(command.modules)].sort()), issue.number)
      this.event('enqueue', command)
      return { queued: issue.number, branch: command.branch }
    }
    if (command.command === 'reopen') {
      const issue = this.issue(command.number)
      this.eligible(issue)
      const previous = this.db.query('SELECT * FROM runs WHERE issue_number = ? ORDER BY rowid DESC LIMIT 1').get(issue.number) as Run | null
      ensure(previous && !previous.active && previous.generation === command.previous_generation && issue.state === 'open' && !issue.covered_by,
        'reopen_conflict', 'Reopen requires the current completed generation and an open, uncovered issue')
      this.fresh(command.discovery.observed_at)
      ensure(command.discovery.sessions.length === (command.adopt ? 1 : 0) &&
        (!command.adopt || json(command.adopt.session) === json(command.discovery.sessions[0])), 'existing_execution', 'Adopt the known session or resolve discovery before reopening')
      ensure(command.discovery.prs.length === (previous.pr_number ? 1 : 0) && (!previous.pr_number ||
        command.discovery.prs[0].number === previous.pr_number && command.discovery.prs[0].branch === previous.branch),
      'pr_conflict', 'Reopening must retain the original PR and branch')
      const run = { ...previous, owner: command.owner, generation: previous.generation + 1, active: 1,
        session: command.adopt ? json(command.adopt.session) : null, worktree: command.adopt?.worktree ?? null }
      this.db.query("UPDATE runs SET active = 1, owner = ?, generation = ?, session = ?, worktree = ?, phase = 'dispatch', next_step = 'Analyze reopened issue; retain original PR', updated_at = ?, lease_until = ? WHERE run_id = ?")
        .run(run.owner, run.generation, run.session, run.worktree, this.now, this.now + command.lease_seconds * 1000, run.run_id)
      this.db.query("UPDATE issues SET queue_state = 'active' WHERE number = ?").run(issue.number)
      this.db.query('DELETE FROM evidence WHERE run_id = ?').run(run.run_id)
      const action = this.queue(run, command.adopt ? 'resume' : 'create', 'reopen', {
        number: issue.number, branch: issue.branch, fingerprint: issue.fingerprint, revision: issue.revision,
        mode: 'analysis', original_pr: previous.pr_number, session: command.adopt?.session,
        marker: `issue-router:${run.run_id}:${run.generation}`,
      })
      this.event('reopen', command, run.run_id)
      return { run_id: run.run_id, owner: run.owner, generation: run.generation, action }
    }
    if (command.command === 'claim') {
      const issue = this.issue(command.number)
      this.eligible(issue)
      ensure(issue.queue_state === 'queued' && issue.state === 'open' && !issue.covered_by, 'not_queued', 'Issue is not queued or already owned')
      this.fresh(command.discovery.observed_at)
      ensure(command.discovery.sessions.length <= 1 && command.discovery.prs.length <= 1, 'existing_execution', 'Multiple existing sessions/PRs require manual reconciliation')
      ensure(command.discovery.sessions.length === (command.adopt ? 1 : 0) &&
        (!command.adopt || json(command.adopt.session) === json(command.discovery.sessions[0])),
      'existing_execution', 'An existing session must be explicitly adopted with its real worktree')
      const existingPr = command.discovery.prs[0]
      ensure(!existingPr || existingPr.branch === issue.branch, 'pr_conflict', 'Existing PR must use the stable issue branch')
      const run: Run = {
        run_id: randomUUID(), issue_number: issue.number, owner: command.owner, generation: 1,
        active: 1, phase: command.adopt ? 'working' : 'dispatch', branch: issue.branch!,
        session: command.adopt ? json(command.adopt.session) : null, worktree: command.adopt?.worktree ?? null,
        pr_number: existingPr?.number ?? null, pr_url: existingPr?.url ?? null, head: null, base: null, next_step: '', updated_at: this.now,
        lease_until: this.now + command.lease_seconds * 1000,
      }
      this.db.query(`INSERT INTO runs(run_id, issue_number, owner, generation, active, phase, branch, updated_at, lease_until)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(run.run_id, run.issue_number, run.owner, run.generation, 1, run.phase, run.branch, run.updated_at, run.lease_until)
      this.db.query('UPDATE runs SET session = ?, worktree = ?, pr_number = ?, pr_url = ? WHERE run_id = ?')
        .run(run.session, run.worktree, run.pr_number, run.pr_url, run.run_id)
      this.db.query("UPDATE issues SET queue_state = 'active' WHERE number = ?").run(issue.number)
      const action = this.queue(run, command.adopt ? 'resume' : 'create', 'initial', {
        number: issue.number, branch: issue.branch, fingerprint: issue.fingerprint,
        revision: issue.revision,
        marker: `issue-router:${run.run_id}:1`, session: command.adopt?.session,
        mode: 'implementation', original_pr: run.pr_number,
      })
      this.event('claim', { ...run, discovery: command.discovery }, run.run_id)
      return { run, action: { ...action, payload: JSON.parse(action.payload) } }
    }

    const run = this.owned(command)
    if (command.command === 'consume') return this.consume(run)
    if (command.command === 'progress') {
      this.db.query('UPDATE runs SET phase = ?, next_step = ?, updated_at = ?, lease_until = ? WHERE run_id = ?')
        .run(command.phase, command.next_step, this.now, this.now + command.lease_seconds * 1000, run.run_id)
      this.event('progress', command, run.run_id)
      return { updated: true }
    }
    if (command.command === 'handoff') {
      ensure(command.new_owner !== run.owner, 'handoff_owner', 'Handoff requires a new owner')
      ensure(!(this.db.query("SELECT 1 FROM outbox WHERE run_id = ? AND status IN ('sending', 'unknown')").get(run.run_id)),
        'unresolved_dispatch', 'Resolve all external operations before handing off ownership')
      this.db.query("UPDATE outbox SET status = 'cancelled' WHERE run_id = ? AND status = 'pending'").run(run.run_id)
      const generation = run.generation + 1
      const context = this.context(run)
      const confirmed = this.db.query("SELECT * FROM outbox WHERE run_id = ? AND generation = ? AND kind = 'merge' AND status = 'sent' ORDER BY rowid DESC LIMIT 1").get(run.run_id, run.generation) as Action | null
      this.db.query('UPDATE runs SET owner = ?, generation = ?, session = ?, worktree = ?, updated_at = ? WHERE run_id = ?')
        .run(command.new_owner, generation, json(command.session), command.worktree, this.now, run.run_id)
      this.db.query('UPDATE resources SET generation = ? WHERE run_id = ?').run(generation, run.run_id)
      this.db.query('DELETE FROM evidence WHERE run_id = ?').run(run.run_id)
      if (confirmed) {
        const key = `merge:${hash([run.run_id, generation, `confirmed:${confirmed.action_key}`])}`
        this.db.query("INSERT INTO outbox(action_key, run_id, generation, kind, status, payload, result, updated_at) VALUES (?, ?, ?, 'merge', 'sent', ?, ?, ?)")
          .run(key, run.run_id, generation, confirmed.payload, confirmed.result, this.now)
        this.event('confirmed_merge_transfer', { from: confirmed.action_key, to: key, generation }, run.run_id)
      }
      this.event('handoff', command, run.run_id)
      const issue = this.issue(run.issue_number)
      const action = this.queue({ ...run, owner: command.new_owner, generation }, 'resume', 'handoff', {
        number: issue.number, fingerprint: issue.fingerprint, session: command.session,
        revision: issue.revision,
        ...context, marker: `issue-router:${run.run_id}:${generation}`,
      })
      return { run_id: run.run_id, owner: command.new_owner, generation, action }
    }
    if (['dispatch-start', 'dispatch-unknown', 'bind-session', 'ack', 'reconcile'].includes(command.command)) {
      const c = command as Extract<Command, { action_key: string }>
      const action = this.action(run, c.action_key)
      if (c.command === 'dispatch-start') {
        ensure(action.status === 'pending', 'dispatch_not_pending', 'Only pending actions may be sent; unknown/sending actions require reconciliation')
        ensure(!this.db.query("SELECT 1 FROM outbox WHERE run_id = ? AND action_key != ? AND status IN ('sending', 'unknown')").get(run.run_id, action.action_key),
          'unresolved_dispatch', 'Resolve the previous external operation before sending another')
        if (action.kind === 'create') ensure(this.issue(run.issue_number).state === 'open', 'issue_closed', 'Issue closed before dispatch; reconcile or retire explicitly')
        if (action.kind === 'merge') this.checkMerge(run)
        this.db.query("UPDATE outbox SET status = 'sending', sender = ?, updated_at = ? WHERE action_key = ? AND status = 'pending'")
          .run(c.sender, this.now, action.action_key)
      } else if (c.command === 'reconcile') {
        ensure(['sending', 'unknown', 'sent'].includes(action.status), 'not_dispatched', 'Reconciliation requires a dispatched action')
        if (c.outcome === 'found') {
          if (action.kind === 'create') {
            ensure(c.session && c.worktree, 'session_missing', 'Found create result requires real client/host/session_id and worktree')
            this.bind(run, action, c.session, c.worktree)
          }
          if (action.kind === 'merge') ensure(c.merge_sha, 'merge_missing', 'Found merge requires verified merge SHA')
          if (action.kind === 'merge' && action.status === 'sent') ensure(JSON.parse(action.result!).merge_sha === c.merge_sha, 'merge_conflict', 'Confirmed merge SHA cannot change')
          if (action.kind === 'merge' && action.status !== 'sent' && this.meta('main_head') === run.base) this.putMeta('main_head', c.merge_sha!)
          if (action.kind === 'resume') this.delivered(run, action)
          this.db.query("UPDATE outbox SET status = 'sent', result = ?, updated_at = ? WHERE action_key = ?")
            .run(json(c), this.now, action.action_key)
        } else {
          ensure(action.status !== 'sent', 'already_sent', 'A confirmed result cannot become unknown')
          // Even a negative lookup is not proof that a previously sent request
          // cannot complete later. There is deliberately no reset-to-pending.
          this.db.query("UPDATE outbox SET status = 'unknown', result = ?, updated_at = ? WHERE action_key = ?")
            .run(json(c), this.now, action.action_key)
        }
      } else {
        ensure(action.status === 'sending' && action.sender === c.sender, 'sender_conflict', 'Only the sender can acknowledge its in-flight action')
        if (c.command === 'bind-session') this.bind(run, action, c.session, c.worktree)
        if (c.command === 'ack') {
          ensure(action.kind === 'resume', 'action_kind', 'Create uses bind-session; merge uses reconcile with merge SHA')
          this.delivered(run, action)
        }
        this.db.query('UPDATE outbox SET status = ?, result = ?, updated_at = ? WHERE action_key = ?')
          .run(c.command === 'dispatch-unknown' ? 'unknown' : 'sent', json(c), this.now, action.action_key)
      }
      this.event(c.command, c, run.run_id)
      return { action: this.action(run, action.action_key) }
    }
    if (command.command === 'observe-external-merge') {
      ensure(run.pr_number === command.number && run.pr_url === command.url && run.branch === command.branch &&
        run.head === command.head && run.base === command.base, 'version_mismatch', 'External merge must match the original PR, branch, head and base')
      ensure(!this.db.query("SELECT 1 FROM outbox WHERE run_id = ? AND kind = 'merge' AND status != 'cancelled'").get(run.run_id),
        'merge_inflight', 'Reconcile the existing merge action; an external observation cannot replace it')
      this.fresh(command.observed_at)
      ensure(command.main_sha === this.meta('main_head'), 'base_unobserved', 'External merge ancestry must use the latest observed main')
      ensure(Date.parse(command.merged_at) <= Date.parse(command.observed_at), 'merge_time', 'Merge cannot occur after its observation')
      const reopened = this.db.query("SELECT created_at FROM events WHERE run_id = ? AND kind = 'reopen' ORDER BY id DESC LIMIT 1").get(run.run_id) as any
      ensure(!reopened || Date.parse(command.merged_at) >= reopened.created_at, 'merge_generation', 'Merge predates the reopened generation')
      const priorPr = this.db.query("SELECT data FROM events WHERE run_id = ? AND kind = 'pr' ORDER BY id DESC LIMIT 1").get(run.run_id) as any
      if (priorPr) {
        const pr = JSON.parse(priorPr.data)
        ensure(Date.parse(command.observed_at) > Date.parse(pr.observed_at) ||
          Date.parse(command.observed_at) === Date.parse(pr.observed_at) && pr.state === 'merged',
        'older_observation', 'External merge cannot replace a newer or conflicting PR observation')
      }
      const prior = this.db.query("SELECT data FROM events WHERE run_id = ? AND kind = 'external_merge' ORDER BY id DESC LIMIT 1").get(run.run_id) as any
      ensure(!prior || JSON.parse(prior.data).merge_sha === command.merge_sha, 'merge_conflict', 'Confirmed external merge SHA cannot change')
      this.saveEvidence(run, 'external_merge', { ...command, merged_at: new Date(command.merged_at).toISOString() })
      return { recorded: true, merge_sha: command.merge_sha }
    }
    if (command.command === 'record-pr') {
      ensure(run.branch === command.branch && (!run.pr_number || run.pr_number === command.number), 'pr_conflict', 'Keep the stable branch and original PR')
      this.fresh(command.observed_at)
      this.guardObservation(run, 'pr', command)
      ensure(command.base === this.meta('main_head'), 'base_unobserved', 'Observe the latest main ref and its ancestry before recording a PR base')
      const inflight = this.db.query("SELECT 1 FROM outbox WHERE run_id = ? AND generation = ? AND kind = 'merge' AND status IN ('sending', 'unknown', 'sent')").get(run.run_id, run.generation)
      ensure(!inflight, 'merge_inflight', 'Resolve/complete the merge before changing its PR versions')
      if (run.head !== command.head || run.base !== command.base) {
        this.db.query('DELETE FROM evidence WHERE run_id = ?').run(run.run_id)
        this.db.query("DELETE FROM resources WHERE run_id = ? AND name = 'main-merge'").run(run.run_id)
        this.db.query("UPDATE outbox SET status = 'cancelled' WHERE run_id = ? AND kind = 'merge' AND status = 'pending'").run(run.run_id)
      }
      this.db.query('UPDATE runs SET pr_number = ?, pr_url = ?, head = ?, base = ?, updated_at = ? WHERE run_id = ?')
        .run(command.number, command.url, command.head, command.base, this.now, run.run_id)
      if (command.state !== 'merged') this.db.query("DELETE FROM evidence WHERE run_id = ? AND kind = 'external_merge'").run(run.run_id)
      this.saveEvidence(run, 'pr', command)
      return { recorded: true }
    }
    if (command.command === 'validation' || command.command === 'review' || command.command === 'ci') {
      this.versions(run, command)
      this.fresh(command.observed_at)
      if (command.command === 'ci') {
        ensure(command.association !== 'head' || command.tested_sha === run.head, 'ci_association', 'Head CI must actually test this head')
        ensure(command.association !== 'merge' || command.tested_sha !== run.head, 'ci_association', 'Merge CI needs a distinct tested merge SHA and verified association')
        ensure(command.checks.every((check) => check.tested_sha === command.tested_sha), 'ci_association', 'Every check must belong to the associated test commit')
        ensure(new Set(command.checks.map((check) => check.name)).size === command.checks.length, 'ci_ambiguous', 'Adapter must select the latest attempt of each check; duplicate names are ambiguous')
      }
      this.saveEvidence(run, command.command, command)
      return { recorded: true }
    }
    if (command.command === 'smoke-acquire') {
      this.resource(run, 'desktop-smoke')
      return { resource: 'desktop-smoke' }
    }
    if (command.command === 'smoke-release') {
      this.db.query("DELETE FROM resources WHERE name = 'desktop-smoke' AND run_id = ? AND generation = ?").run(run.run_id, run.generation)
      return { released: true }
    }
    if (command.command === 'merge-acquire') {
      this.versions(run, command)
      this.fresh(command.branch_protection.observed_at)
      const required: string[] = JSON.parse(this.meta('required_checks')!)
      ensure(required.every((check) => command.branch_protection.required_checks.includes(check)), 'protection_mismatch', 'Observed strict branch protection must include all configured required checks')
      this.saveEvidence(run, 'protection', command.branch_protection)
      this.checkMerge(run)
      this.resource(run, 'main-merge')
      const action = this.queue(run, 'merge', `${run.head}:${run.base}`, { pr_number: run.pr_number, expected_head: run.head, expected_base: run.base })
      this.event('merge_acquire', command, run.run_id)
      return { resource: 'main-merge', action }
    }
    if (command.command === 'complete') {
      const merge = this.db.query("SELECT * FROM outbox WHERE run_id = ? AND generation = ? AND kind = 'merge' AND status = 'sent' ORDER BY rowid DESC LIMIT 1").get(run.run_id, run.generation) as Action | null
      let confirmed = !!merge && JSON.parse(merge.result!).merge_sha === command.merge_sha
      const external = this.db.query("SELECT payload FROM evidence WHERE run_id = ? AND kind = 'external_merge'").get(run.run_id) as any
      if (!confirmed && external) {
        const receipt = JSON.parse(external.payload)
        ensure(receipt.run_id === run.run_id && receipt.owner === run.owner && receipt.generation === run.generation &&
          receipt.number === run.pr_number && receipt.url === run.pr_url && receipt.branch === run.branch &&
          receipt.head === run.head && receipt.base === run.base && receipt.merge_sha === command.merge_sha &&
          receipt.main_sha === this.meta('main_head'), 'merge_unconfirmed', 'External merge receipt no longer matches the current run and main')
        confirmed = true
      }
      ensure(confirmed, 'merge_unconfirmed', 'Verify the merge result before completing the run')
      ensure(!this.db.query("SELECT 1 FROM outbox WHERE run_id = ? AND status IN ('pending', 'sending', 'unknown')").get(run.run_id), 'unresolved_dispatch', 'Resolve all external actions before completion')
      const issue = this.issue(run.issue_number)
      ensure(issue.revision === issue.delivered_revision, 'materials_pending', 'Deliver and reconcile new issue material before completion')
      this.db.query("UPDATE runs SET active = 0, phase = 'complete', updated_at = ? WHERE run_id = ?").run(this.now, run.run_id)
      this.db.query("UPDATE issues SET queue_state = 'complete' WHERE number = ?").run(run.issue_number)
      this.db.query('DELETE FROM resources WHERE run_id = ?').run(run.run_id)
      this.event('complete', command, run.run_id)
      return { completed: true }
    }
    if (command.command === 'retire') {
      ensure(!this.db.query("SELECT 1 FROM outbox WHERE run_id = ? AND status IN ('sending', 'unknown')").get(run.run_id), 'unresolved_dispatch', 'Resolve external operations before retiring')
      ensure(!run.pr_number || command.pr_terminal_reference, 'pr_unresolved', 'Retirement requires evidence that the original PR cannot still merge')
      const external = this.db.query(`SELECT 1 FROM events WHERE run_id = ? AND kind = 'external_merge'
        AND id > COALESCE((SELECT max(id) FROM events WHERE run_id = ? AND kind = 'reopen'), 0) LIMIT 1`).get(run.run_id, run.run_id)
      ensure(!external && !this.db.query("SELECT 1 FROM outbox WHERE run_id = ? AND generation = ? AND kind = 'merge' AND status = 'sent'").get(run.run_id, run.generation), 'merge_confirmed', 'Use complete after verifying the confirmed merge')
      this.db.query("UPDATE outbox SET status = 'cancelled' WHERE run_id = ? AND status = 'pending'").run(run.run_id)
      this.db.query("UPDATE runs SET active = 0, phase = 'complete', next_step = ?, updated_at = ? WHERE run_id = ?").run(command.outcome, this.now, run.run_id)
      this.db.query("UPDATE issues SET queue_state = 'complete' WHERE number = ?").run(run.issue_number)
      this.db.query('DELETE FROM resources WHERE run_id = ?').run(run.run_id)
      this.event('retire', command, run.run_id)
      return { retired: true, outcome: command.outcome }
    }
    ensure(false, 'unknown_command', 'Unsupported command')
  }

  checkMerge(run: Run) {
    ensure(!this.db.query("SELECT 1 FROM events WHERE run_id = ? AND kind = 'external_merge'").get(run.run_id),
      'pr_terminal', 'PR was already observed externally merged; verify completion instead of merging again')
    const issue = this.issue(run.issue_number)
    ensure(issue.state === 'open' && !issue.covered_by, 'issue_closed', 'Issue is closed or covered; do not merge automatically')
    ensure(issue.revision === issue.delivered_revision, 'materials_pending', 'Deliver and reconcile new issue material before merging')
    ensure(!this.db.query("SELECT 1 FROM outbox WHERE run_id = ? AND kind != 'merge' AND status IN ('pending', 'sending', 'unknown')").get(run.run_id),
      'unresolved_dispatch', 'Resolve all other external actions before merging')
    const evidence = Object.fromEntries((this.db.query('SELECT kind, payload FROM evidence WHERE run_id = ?').all(run.run_id) as any[]).map((row) => [row.kind, JSON.parse(row.payload)]))
    for (const kind of ['pr', 'validation', 'review', 'ci', 'protection']) ensure(evidence[kind], 'evidence_missing', `Missing ${kind} evidence`)
    ensure(evidence.pr.state === 'open', 'pr_terminal', 'Only an open PR may acquire a merge action')
    for (const kind of ['pr', 'validation', 'review', 'ci']) this.versions(run, evidence[kind])
    for (const kind of ['pr', 'ci', 'protection']) this.fresh(evidence[kind].observed_at)
    ensure(evidence.validation.checks.every((check: any) => check.result === 'passed'), 'validation_failed', 'Every selected local check must pass')
    ensure(evidence.review.independent && evidence.review.verdict === 'approved', 'review_failed', 'Independent review must approve this head and base')
    const required: string[] = [...new Set([...JSON.parse(this.meta('required_checks')!), ...evidence.protection.required_checks])]
    for (const name of required) ensure(evidence.ci.checks.some((check: any) => check.name === name && check.selected), 'ci_missing', `Missing selected required check ${name}`)
    ensure(evidence.ci.checks.every((check: any) => check.status === 'completed' &&
      (check.selected ? check.conclusion === 'success' : check.conclusion === 'skipped' && check.scope_reference)),
    'ci_failed', 'All selected CI, including advisory, must succeed; only scope-excluded checks may be skipped')
  }
}

export function execute(input: unknown, cwd = process.cwd(), now = Date.now()): unknown {
  const command = commandSchema.parse(input)
  const layout = resolveLayout(cwd)
  switch (command.command) {
    case 'locate': return layout
    case 'install-exclude': return installExclude(layout)
    case 'init': return initState(layout, command.repository_id, command.repository, [...new Set(command.required_checks)])
    case 'migrate': return migrateState(layout)
    case 'restore': return restoreState(layout, command.backup)
  }
  const db = openState(layout)
  try {
    if (command.command === 'backup') return backupState(db, layout)
    return db.transaction(() => new Router(db, now).execute(command)).immediate()
  } finally {
    db.close()
  }
}
