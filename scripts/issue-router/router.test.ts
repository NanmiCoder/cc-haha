import { afterEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fixture, now, timestamp, discovery, cli, session, head, base, mergeSha, provenance } from './test-helpers'
import { execute } from './router'
import { resolveLayout } from './git'

const fixtures: ReturnType<typeof fixture>[] = []
function setup(numbers = [1, 2, 3], separate = false) {
  const f = fixture(separate)
  fixtures.push(f)
  f.init()
  f.observe(numbers)
  return f
}
afterEach(() => { for (const f of fixtures.splice(0)) f.cleanup() })
const failure = (fn: () => unknown, message: string) => expect(fn).toThrow(message)

describe('shared repository identity', () => {
  for (const separate of [false, true]) test(`linked worktrees share the primary database (separate=${separate})`, () => {
    const f = setup([1], separate)
    const linked = join(f.root, 'linked 空间\nworktree')
    f.git('worktree', 'add', '--detach', linked, 'HEAD')
    expect(resolveLayout(linked)).toEqual(f.layout())
    f.enqueue(1)
    expect((execute({ command: 'status' }, linked, now) as any).issues[0].queue_state).toBe('queued')
    expect(existsSync(join(linked, '.issue-router'))).toBe(false)
    mkdirSync(join(f.layout().stateRoot, 'reports'))
    writeFileSync(join(f.layout().stateRoot, 'reports', 'result.json'), '{}')
    expect(f.git('status', '--short')).toBe('')
  })

  test('unavailable primary never falls back to the linked worktree', () => {
    const f = setup([1])
    const linked = join(f.root, 'linked')
    f.git('worktree', 'add', '--detach', linked, 'HEAD')
    rmSync(f.primary, { recursive: true })
    failure(() => resolveLayout(linked), 'Cannot read Git metadata')
    expect(existsSync(join(linked, '.issue-router'))).toBe(false)
  })

  test('explicit shared exclude preserves bytes and does not edit primary sources', () => {
    const f = fixture(true)
    fixtures.push(f)
    writeFileSync(join(f.primary, '.gitignore'), '# user file without router rule\n')
    failure(() => f.init(), 'State must be ignored')
    const path = join(f.layout().commonDir, 'info', 'exclude')
    writeFileSync(path, '# keep existing\nexisting-pattern')
    const before = f.git('status', '--short')
    f.call({ command: 'install-exclude' })
    const installed = readFileSync(path, 'utf8')
    f.call({ command: 'install-exclude' })
    expect(readFileSync(path, 'utf8')).toBe(installed)
    expect(installed).toBe('# keep existing\nexisting-pattern\n/.issue-router/\n')
    f.init()
    expect(f.git('status', '--short')).toBe(before)
  })
})

describe('queue, owner and external dispatch', () => {
  test('baseline is mandatory and never queues historical issues', () => {
    const f = fixture()
    fixtures.push(f)
    f.init()
    failure(() => f.observe([1], false), 'First complete scan must be baseline')
    f.observe([1])
    expect(f.call({ command: 'status' }).inbox_pending).toBe(0)
    failure(() => f.claim(1), 'Issue is not queued')
    f.enqueue(1)
    const claimed = f.claim(1)
    expect(claimed.action.kind).toBe('create')
    expect(claimed.action.payload.marker).toContain(claimed.run.run_id)
    failure(() => f.claim(1), 'Issue is not queued')
  })

  test('module conflict rolls back the run and global slot together', () => {
    const f = setup()
    f.enqueue(1, ['server'])
    f.enqueue(2, ['server', 'desktop'])
    f.enqueue(3, ['desktop'])
    f.claim(1)
    failure(() => f.claim(2), 'Resource module:server is occupied')
    f.claim(3)
    const state = f.call({ command: 'status' })
    expect(state.runs).toHaveLength(2)
    expect(state.issues.find((issue: any) => issue.number === 2).queue_state).toBe('queued')
    expect(state.resources.filter((r: any) => r.name.startsWith('slot:'))).toHaveLength(2)
    failure(() => f.claim(2), 'Both global execution slots')
  })

  test('sending CAS, unknown creation and expired leases never reopen ownership', () => {
    const f = setup()
    f.enqueue(1)
    const claimed = f.claim(1)
    const args = { ...claimed.token, action_key: claimed.action.action_key, sender: 'sender' }
    f.call({ command: 'dispatch-start', ...args })
    failure(() => f.call({ command: 'dispatch-start', ...args, sender: 'other' }), 'Only pending actions')
    failure(() => f.call({ command: 'bind-session', ...args, sender: 'other', session, worktree: '/fixture' }), 'Only the sender')
    f.call({ command: 'dispatch-unknown', ...args, reference: 'fixture://network-lost' })
    const state = f.call({ command: 'status' }, now + 86_400_000)
    expect(state.runs[0].lease_expired).toBe(true)
    expect(state.actions[0].status).toBe('unknown')
    expect(state.resources.filter((r: any) => r.name.startsWith('slot:'))).toHaveLength(1)
    failure(() => f.claim(1), 'Issue is not queued')
    f.call({ command: 'reconcile', ...claimed.token, action_key: claimed.action.action_key, outcome: 'absent', reference: 'fixture://negative-search' })
    failure(() => f.call({ command: 'dispatch-start', ...args }), 'Only pending actions')
    f.call({ command: 'reconcile', ...claimed.token, action_key: claimed.action.action_key, outcome: 'found', reference: 'fixture://found', session, worktree: '/fixture' })
    expect(f.call({ command: 'status' }).runs[0].session).toEqual(session)
    expect(f.call({ command: 'status' }).actions).toHaveLength(0)
  })

  test('incremental candidates and cursor recover atomically, idempotent resume stays on original session', () => {
    const f = setup([1])
    f.enqueue(1)
    const claimed = f.claim(1)
    f.bind(claimed)
    const db = new Database(f.layout().database)
    db.exec("CREATE TRIGGER fail_inbox BEFORE INSERT ON inbox BEGIN SELECT RAISE(ABORT, 'fixture crash'); END")
    const observation = { command: 'observe', scan_id: 'scan2', cursor_before: 'c1', cursor_after: 'c2', complete: true,
      candidates: [{ number: 1, title: 'More facts', fingerprint: 'fp-new', state: 'open', updated_at: timestamp }] }
    failure(() => f.call(observation), 'fixture crash')
    expect(f.call({ command: 'status' }).cursor).toBe('c1')
    expect(f.call({ command: 'status' }).issues[0].fingerprint).toBe('fp-1')
    db.exec('DROP TRIGGER fail_inbox')
    db.close()
    f.call(observation)
    expect(f.call(observation).replay).toBe(true)
    failure(() => f.call({ ...observation, cursor_after: 'different' }), 'different contents')
    const resume = f.call({ command: 'consume', ...claimed.token }).action
    expect(resume.kind).toBe('resume')
    expect(JSON.parse(resume.payload).session).toEqual(session)
    expect(f.call({ command: 'consume', ...claimed.token }).action.action_key).toBe(resume.action_key)
    expect(f.call({ command: 'status' }).runs).toHaveLength(1)
    expect(f.call({ command: 'status' }).inbox_pending).toBe(0)
    f.call({ command: 'dispatch-start', ...claimed.token, action_key: resume.action_key, sender: 'sender' })
    f.call({ command: 'ack', ...claimed.token, action_key: resume.action_key, sender: 'sender', reference: 'fixture://delivered' })
    expect(f.call({ command: 'status' }).issues[0].delivered).toBe('fp-new')
  })

  test('handoff invalidates late owners, retains slots and rejects unresolved external writes', () => {
    const f = setup([1])
    f.enqueue(1)
    const claimed = f.claim(1)
    const handoff = { command: 'handoff', ...claimed.token, new_owner: 'owner-new', old_executor_stopped: true,
      stopped_reference: 'fixture://stopped', session: { ...session, client: 'another-client', host: 'another-host' }, worktree: '/new-fixture' }
    f.call({ command: 'dispatch-start', ...claimed.token, action_key: claimed.action.action_key, sender: 'sender' })
    failure(() => f.call(handoff), 'Resolve all external operations')
    f.call({ command: 'bind-session', ...claimed.token, action_key: claimed.action.action_key, sender: 'sender', session, worktree: '/fixture' })
    const handedOff = f.call(handoff)
    const { run_id, owner, generation } = handedOff
    const token = { run_id, owner, generation }
    expect(token.generation).toBe(2)
    failure(() => f.call({ command: 'progress', ...claimed.token, phase: 'blocked', next_step: 'late', reference: 'fixture://late' }), 'owner/generation changed')
    f.call({ command: 'progress', ...token, phase: 'ci', next_step: 'wait CI', reference: 'fixture://ci' })
    expect(f.call({ command: 'status' }).resources.every((r: any) => r.generation === 2)).toBe(true)
    failure(() => f.call({ command: 'dispatch-start', ...token, action_key: claimed.action.action_key, sender: 'new-sender' }), 'another run/generation')
  })

  test('existing execution is adopted and its PR/branch remain stable', () => {
    const f = setup([1])
    f.enqueue(1)
    const found = { ...discovery, sessions: [session], prs: [{ number: 50, url: 'https://example.invalid/pr/50', branch: 'fix/issue-1-fixture' }] }
    failure(() => f.call({ command: 'claim', number: 1, owner: 'owner', discovery: found }), 'explicitly adopted')
    const result = f.call({ command: 'claim', number: 1, owner: 'owner', discovery: found, adopt: { session, worktree: '/existing' } })
    expect(result.action.kind).toBe('resume')
    expect(result.run.pr_number).toBe(50)
    const token = { run_id: result.run.run_id, owner: 'owner', generation: 1 }
    failure(() => f.call({ command: 'record-pr', ...token, ...provenance, head, base, number: 51, state: 'open', url: 'https://example.invalid/pr/51', branch: 'fix/issue-1-fixture' }), 'stable branch and original PR')
  })

  test('PR objects, duplicate coverage, closed issues and stale scans cannot create work', () => {
    const f = setup()
    f.call({ command: 'cover', number: 1, covered_by: 2, reference: 'fixture://same-repro' })
    failure(() => f.enqueue(1), 'open, uncovered')
    failure(() => f.call({ command: 'cover', number: 2, covered_by: 1, reference: 'fixture://cycle' }), 'must not form a cycle')
    f.call({ command: 'observe', scan_id: 'scan2', cursor_before: 'c1', cursor_after: 'c2', complete: true,
      candidates: [{ number: 3, title: 'Closed', state: 'closed', fingerprint: 'closed', updated_at: timestamp },
        { number: 4, title: 'PR', state: 'open', fingerprint: 'pr', updated_at: timestamp, is_pr: true }] })
    failure(() => f.enqueue(3), 'open, uncovered')
    failure(() => f.enqueue(4), 'Unknown issue')
    failure(() => f.observe([5], false, 'c3', 'c1'), 'Another scan advanced')
    failure(() => f.call({ command: 'observe', scan_id: 'incomplete', cursor_before: 'c2', cursor_after: 'c3', complete: false, candidates: [] }), 'Invalid input')
  })
})

describe('version-bound merge gate', () => {
  test('old head/base evidence, advisory failures, missing/pending/cancelled checks fail closed', () => {
    const f = setup([1])
    f.enqueue(1)
    const claimed = f.claim(1)
    f.bind(claimed)
    f.evidence(claimed.token, 101)
    failure(() => f.acquire(claimed.token, { head: 'd'.repeat(40), base }), 'does not match')
    const ci = { command: 'ci', ...claimed.token, ...provenance, head, base, complete: true, tested_sha: head,
      association: 'head', association_reference: 'fixture://parents', checks: [{ name: 'pr-quality-gate', external_id: '1', tested_sha: head, selected: true, status: 'completed', conclusion: 'success' }] }
    for (const bad of [
      { ...ci, head: 'd'.repeat(40) }, { ...ci, base: 'd'.repeat(40) }, { ...ci, tested_sha: 'd'.repeat(40) },
    ]) failure(() => f.call(bad), bad.tested_sha !== head ? 'actually test this head' : 'does not match')
    let tick = 1000
    const recordCi = (value: Record<string, unknown>) => f.call({ ...value, observed_at: new Date(now + tick++).toISOString() })
    for (const check of [
      { name: 'pr-quality-gate', status: 'queued', conclusion: null },
      { name: 'pr-quality-gate', status: 'completed', conclusion: 'cancelled' },
      { name: 'pr-quality-gate', status: 'completed', conclusion: 'skipped' },
      { name: 'advisory', status: 'completed', conclusion: 'failure' },
    ]) {
      recordCi({ ...ci, checks: check.name === 'advisory' ? [...ci.checks, { ...ci.checks[0], ...check, external_id: '2' }] : [{ ...ci.checks[0], ...check }] })
      failure(() => f.acquire(claimed.token), 'All selected CI')
    }
    recordCi({ ...ci, checks: [{ ...ci.checks[0], name: 'something-else' }] })
    failure(() => f.acquire(claimed.token), 'Missing selected required check')
    recordCi(ci)
    const acquired = f.acquire(claimed.token)
    expect(acquired.resource).toBe('main-merge')
    f.call({ command: 'record-pr', ...claimed.token, ...provenance, observed_at: new Date(now + 2000).toISOString(), head: 'd'.repeat(40), base, number: 101, state: 'open', url: 'https://example.invalid/pr/101', branch: claimed.run.branch })
    failure(() => f.call({ command: 'dispatch-start', ...claimed.token, action_key: acquired.action.action_key, sender: 'sender' }), 'Only pending actions')
    failure(() => f.acquire(claimed.token, { head: 'd'.repeat(40), base }), 'Missing validation')
  })

  test('merge and desktop smoke resources serialize and completion requires verified outcome', () => {
    const f = setup([1, 2])
    f.enqueue(1)
    f.enqueue(2)
    const first = f.claim(1)
    const second = f.claim(2)
    for (const claimed of [first, second]) { f.bind(claimed); f.evidence(claimed.token, claimed.run.issue_number + 100) }
    f.call({ command: 'smoke-acquire', ...first.token })
    failure(() => f.call({ command: 'smoke-acquire', ...second.token }), 'Resource desktop-smoke')
    f.call({ command: 'smoke-release', ...first.token })
    f.call({ command: 'smoke-acquire', ...second.token })
    const merge = f.acquire(first.token).action
    failure(() => f.acquire(second.token), 'Resource main-merge')
    f.call({ command: 'dispatch-start', ...first.token, action_key: merge.action_key, sender: 'sender' })
    const complete = { command: 'complete', ...first.token, merge_sha: mergeSha, main_ci_reference: 'fixture://main-ci', scenario_reference: 'fixture://scenario' }
    failure(() => f.call(complete), 'Verify the merge result')
    f.call({ command: 'reconcile', ...first.token, action_key: merge.action_key, outcome: 'found', reference: 'fixture://merged', merge_sha: mergeSha })
    f.call(complete)
    expect(f.call({ command: 'status' }).runs).toHaveLength(1)
    failure(() => f.acquire(second.token), 'Main advanced')
    f.evidence(second.token, 102, { head, base: mergeSha })
    expect(f.acquire(second.token, { head, base: mergeSha }).resource).toBe('main-merge')
  })
})

describe('real CLI and independent processes', () => {
  test('machine JSON errors stop on missing and corrupt state, with no implicit init', () => {
    const f = fixture()
    fixtures.push(f)
    function run(command: string) {
      const result = spawnSync(process.execPath, ['--no-env-file', cli, command, '--cwd', f.primary], { env: f.env, encoding: 'utf8' })
      return { result, output: JSON.parse(result.stdout) }
    }
    expect(run('status').output.error.code).toBe('database_missing')
    expect(existsSync(f.layout().database)).toBe(false)
    f.init()
    writeFileSync(f.layout().database, 'not sqlite')
    const corrupt = run('status')
    expect(corrupt.result.status).toBe(1)
    expect(corrupt.output.ok).toBe(false)
    expect(readFileSync(f.layout().database, 'utf8')).toBe('not sqlite')
    expect(run('nonsense').output.error.code).toBe('input')
  })

  test('same issue, capacity and modules withstand parallel CLI connections', async () => {
    const f = setup([1, 2, 3, 4])
    f.enqueue(1, ['server'])
    f.enqueue(2, ['server'])
    f.enqueue(3, ['desktop'])
    f.enqueue(4, ['other'])
    const linked = join(f.root, 'linked')
    f.git('worktree', 'add', '--detach', linked, 'HEAD')
    async function claim(number: number, owner: string, cwd = f.primary) {
      const process = Bun.spawn([globalThis.process.execPath, '--no-env-file', cli, 'claim', '--cwd', cwd, '--input', '-'], { env: f.env, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' })
      process.stdin.write(JSON.stringify({ number, owner, discovery: { ...discovery, observed_at: new Date().toISOString() } }))
      process.stdin.end()
      const output = JSON.parse(await new Response(process.stdout).text())
      await process.exited
      return output
    }
    const same = await Promise.all(Array.from({ length: 6 }, (_, index) => claim(1, `owner-${index}`, index % 2 ? linked : f.primary)))
    expect(same.filter((result) => result.ok)).toHaveLength(1)
    const different = await Promise.all([claim(2, 'owner-2'), claim(3, 'owner-3'), claim(4, 'owner-4')])
    expect(different.filter((result) => result.ok)).toHaveLength(1)
    const state = f.call({ command: 'status' })
    expect(state.runs).toHaveLength(2)
    expect(state.resources.filter((r: any) => r.name.startsWith('slot:'))).toHaveLength(2)
    expect(state.resources.filter((r: any) => r.name === 'module:server')).toHaveLength(1)
  }, 20_000)
})
