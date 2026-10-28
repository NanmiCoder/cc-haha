import { afterEach, expect, test } from 'bun:test'
import { fixture, provenance, head, base, now, session, discovery, mergeSha } from './test-helpers'

const fixtures: ReturnType<typeof fixture>[] = []
afterEach(() => { for (const f of fixtures.splice(0)) f.cleanup() })
function owned() {
  const f = fixture()
  fixtures.push(f)
  f.init()
  f.observe([1])
  f.enqueue(1)
  const claimed = f.claim(1)
  f.bind(claimed)
  return { f, claimed }
}

test('repeated content transitions A→B→A→B each reach the original session exactly once', () => {
  const { f, claimed } = owned()
  let before = 'c1'
  const keys: string[] = []
  for (const [index, fingerprint] of ['B', 'fp-1', 'B'].entries()) {
    const cursor = `transition-${index}`
    f.call({ command: 'observe', scan_id: cursor, cursor_before: before, cursor_after: cursor, complete: true,
      candidates: [{ number: 1, title: 'Changed', fingerprint, state: 'open', updated_at: new Date(now + index + 1).toISOString() }] })
    const action = f.call({ command: 'consume', ...claimed.token }).action
    expect(action).not.toBeNull()
    expect(action.status).toBe('pending')
    expect(keys).not.toContain(action.action_key)
    keys.push(action.action_key)
    f.call({ command: 'dispatch-start', ...claimed.token, action_key: action.action_key, sender: 'sender' })
    f.call({ command: 'ack', ...claimed.token, action_key: action.action_key, sender: 'sender', reference: 'fixture://delivered' })
    expect(f.call({ command: 'consume', ...claimed.token }).action).toBeNull()
    before = cursor
  }
  expect(f.call({ command: 'status' }).runs).toHaveLength(1)
})

test('late older CI cannot replace the newer failed advisory snapshot on the same version', () => {
  const { f, claimed } = owned()
  f.evidence(claimed.token, 101)
  const ci = { command: 'ci', ...claimed.token, ...provenance, head, base, complete: true,
    tested_sha: head, association: 'head', association_reference: 'fixture://parents',
    checks: [{ name: 'pr-quality-gate', external_id: '1', tested_sha: head, selected: true, status: 'completed', conclusion: 'success' }] }
  f.call({ ...ci, observed_at: new Date(now + 5000).toISOString(), checks: [...ci.checks,
    { ...ci.checks[0], name: 'advisory', external_id: '2', conclusion: 'failure' }] }, now + 5000)
  expect(() => f.call(ci, now + 6000)).toThrow('older')
  expect(() => f.acquire(claimed.token)).toThrow('All selected CI')
})

test('a cancelled, never-sent merge can be reacquired when the original head returns', () => {
  const { f, claimed } = owned()
  f.evidence(claimed.token, 101)
  const original = f.acquire(claimed.token).action
  f.evidence(claimed.token, 101, { head: 'd'.repeat(40), base })
  f.evidence(claimed.token, 101)
  const again = f.acquire(claimed.token).action
  expect(again.action_key).toBe(original.action_key)
  expect(again.status).toBe('pending')
  f.call({ command: 'dispatch-start', ...claimed.token, action_key: again.action_key, sender: 'sender' })
})

test('new material blocks merge both before acquisition and just before sending', () => {
  const { f, claimed } = owned()
  f.evidence(claimed.token, 101)
  const acquired = f.acquire(claimed.token).action
  f.call({ command: 'observe', scan_id: 'new', cursor_before: 'c1', cursor_after: 'c2', complete: true,
    candidates: [{ number: 1, title: 'New acceptance', state: 'open', fingerprint: 'new', updated_at: provenance.observed_at }] })
  f.call({ command: 'consume', ...claimed.token })
  expect(() => f.acquire(claimed.token)).toThrow('material')
  expect(() => f.call({ command: 'dispatch-start', ...claimed.token, action_key: acquired.action_key, sender: 'sender' })).toThrow('material')
})

test('completed issue reopening reuses its history in analysis mode and cannot reuse a terminal PR as a new merge', () => {
  const { f, claimed } = owned()
  f.evidence(claimed.token, 101)
  const merge = f.acquire(claimed.token).action
  f.call({ command: 'dispatch-start', ...claimed.token, action_key: merge.action_key, sender: 'sender' })
  f.call({ command: 'reconcile', ...claimed.token, action_key: merge.action_key, outcome: 'found', reference: 'fixture://merged', merge_sha: mergeSha })
  f.call({ command: 'complete', ...claimed.token, merge_sha: mergeSha, main_ci_reference: 'fixture://main-ci', scenario_reference: 'fixture://scenario' })
  let before = 'c1'
  for (const [index, state] of ['closed', 'open'].entries()) {
    const cursor = `reopen-${state}`
    f.call({ command: 'observe', scan_id: cursor, cursor_before: before, cursor_after: cursor, complete: true,
      candidates: [{ number: 1, title: 'Reopened', fingerprint: state, state, updated_at: new Date(now + index + 1).toISOString() }] })
    before = cursor
  }
  expect(() => f.call({ command: 'consume', ...claimed.token })).toThrow('owner/generation changed')
  const reopened = f.call({ command: 'reopen', number: 1, owner: 'owner-reopened', previous_generation: 1,
    old_executor_stopped: true, reference: 'fixture://old-executor-stopped',
    discovery: { ...discovery, sessions: [session], prs: [{ number: 101, url: 'https://example.invalid/pr/101', branch: claimed.run.branch }] },
    adopt: { session, worktree: '/fixture' } })
  const token = { run_id: reopened.run_id, owner: reopened.owner, generation: reopened.generation }
  expect(token).toMatchObject({ run_id: claimed.token.run_id, generation: 2 })
  expect(JSON.parse(reopened.action.payload).mode).toBe('analysis')
  f.call({ command: 'dispatch-start', ...token, action_key: reopened.action.action_key, sender: 'sender' })
  f.call({ command: 'ack', ...token, action_key: reopened.action.action_key, sender: 'sender', reference: 'fixture://analysis-request' })
  f.call({ command: 'consume', ...token })
  f.evidence(token, 101, { head, base: mergeSha })
  f.call({ command: 'record-pr', ...token, ...provenance, observed_at: new Date(now + 1000).toISOString(),
    head, base: mergeSha, number: 101, state: 'merged', branch: claimed.run.branch, url: 'https://example.invalid/pr/101' })
  expect(() => f.acquire(token, { head, base: mergeSha })).toThrow('Only an open PR')
  f.call({ command: 'retire', ...token, executor_stopped: true, outcome: 'not_planned',
    reference: 'fixture://analysis-complete', pr_terminal_reference: 'fixture://merged-pr' })
  expect(f.call({ command: 'status' }).runs).toHaveLength(0)
  expect(f.call({ command: 'status' }).resources).toHaveLength(0)
})

test('metadata ignores caller Git overrides and global configuration', () => {
  const { f } = owned()
  const previous = { GIT_DIR: process.env.GIT_DIR, GIT_WORK_TREE: process.env.GIT_WORK_TREE, GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL }
  try {
    process.env.GIT_DIR = `${f.root}/unrelated-git-dir`
    process.env.GIT_WORK_TREE = `${f.root}/unrelated-worktree`
    process.env.GIT_CONFIG_GLOBAL = `${f.root}/unrelated-global-config`
    expect(f.call({ command: 'status' }).repository).toBe('Fixture/repo')
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
})

test('equivalent timestamp encodings cannot replace a failed CI snapshot at the same instant', () => {
  const { f, claimed } = owned()
  f.evidence(claimed.token, 101)
  const ci = { command: 'ci', ...claimed.token, ...provenance, head, base, complete: true,
    tested_sha: head, association: 'head', association_reference: 'fixture://parents',
    checks: [{ name: 'pr-quality-gate', external_id: '1', tested_sha: head, selected: true, status: 'completed', conclusion: 'failure' }] }
  f.call({ ...ci, observed_at: '2026-10-28T03:00:05Z' }, now + 5000)
  expect(() => f.call({ ...ci, observed_at: '2026-10-28T03:00:05+00:00', checks: [{ ...ci.checks[0], conclusion: 'success' }] }, now + 6000)).toThrow('ambiguous')
  expect(() => f.acquire(claimed.token)).toThrow('All selected CI')
})

test('reopened analysis mode survives consumption and later owner handoff', () => {
  const { f, claimed } = owned()
  f.call({ command: 'retire', ...claimed.token, executor_stopped: true, outcome: 'not_planned', reference: 'fixture://stopped' })
  f.call({ command: 'observe', scan_id: 'new', cursor_before: 'c1', cursor_after: 'c2', complete: true,
    candidates: [{ number: 1, title: 'New material', state: 'open', fingerprint: 'new', updated_at: provenance.observed_at }] })
  const reopened = f.call({ command: 'reopen', number: 1, owner: 'reopened', previous_generation: 1,
    old_executor_stopped: true, reference: 'fixture://stopped', discovery: { ...discovery, sessions: [session] }, adopt: { session, worktree: '/fixture' } })
  const token = { run_id: reopened.run_id, owner: reopened.owner, generation: reopened.generation }
  const resumed = f.call({ command: 'consume', ...token }).action
  expect(JSON.parse(resumed.payload)).toMatchObject({ mode: 'analysis', original_pr: null, marker: `issue-router:${token.run_id}:2` })
  f.call({ command: 'dispatch-start', ...token, action_key: resumed.action_key, sender: 'sender' })
  f.call({ command: 'ack', ...token, action_key: resumed.action_key, sender: 'sender', reference: 'fixture://delivered' })
  const handed = f.call({ command: 'handoff', ...token, new_owner: 'handoff-owner', old_executor_stopped: true,
    stopped_reference: 'fixture://stopped', session, worktree: '/fixture' })
  expect(JSON.parse(handed.action.payload).mode).toBe('analysis')
})

test('confirmed merge evidence transfers during handoff while reopened generations cannot reuse it', () => {
  const { f, claimed } = owned()
  f.evidence(claimed.token, 101)
  const merge = f.acquire(claimed.token).action
  f.call({ command: 'dispatch-start', ...claimed.token, action_key: merge.action_key, sender: 'sender' })
  f.call({ command: 'reconcile', ...claimed.token, action_key: merge.action_key, outcome: 'found', reference: 'fixture://merged', merge_sha: mergeSha })
  const handed = f.call({ command: 'handoff', ...claimed.token, new_owner: 'after-merge-owner', old_executor_stopped: true,
    stopped_reference: 'fixture://stopped', session, worktree: '/fixture' })
  const token = { run_id: handed.run_id, owner: handed.owner, generation: handed.generation }
  f.call({ command: 'dispatch-start', ...token, action_key: handed.action.action_key, sender: 'sender' })
  f.call({ command: 'ack', ...token, action_key: handed.action.action_key, sender: 'sender', reference: 'fixture://handoff-delivered' })
  expect(f.call({ command: 'complete', ...token, merge_sha: mergeSha, main_ci_reference: 'fixture://main-ci', scenario_reference: 'fixture://scenario' }).completed).toBe(true)
  expect(f.call({ command: 'status' }).resources).toHaveLength(0)
})
