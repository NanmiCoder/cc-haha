import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { execute } from './router'
import { resolveLayout } from './git'
import type { Token } from './commands'

export const now = Date.parse('2026-10-28T03:00:00Z')
export const timestamp = new Date(now).toISOString()
export const head = 'a'.repeat(40)
export const base = 'b'.repeat(40)
export const mergeSha = 'c'.repeat(40)
export const session = { client: 'test-client', host: 'test-host', session_id: 'opaque/会话:1' }
export const provenance = { source: 'fixture', reference: 'fixture://observation/1', observed_at: timestamp }
export const discovery = { ...provenance, complete: true, sessions: [], prs: [] }
export const cli = resolve(import.meta.dir, 'cli.ts')

export function fixture(separate = false) {
  const root = mkdtempSync(join(tmpdir(), 'issue-router-'))
  const primary = join(root, 'primary 空间\ncheckout')
  const home = join(root, 'isolated-home')
  mkdirSync(home)
  const env = {
    PATH: process.env.PATH!, HOME: home, USERPROFILE: home,
    GIT_CONFIG_GLOBAL: join(home, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
    CLAUDE_CONFIG_DIR: join(home, 'claude'), BUN_OPTIONS: '--no-env-file',
  }
  function git(...args: string[]) {
    const child = spawnSync('git', ['-C', primary, ...args], { env, encoding: 'utf8' })
    if (child.status !== 0) throw new Error(child.stderr)
    return child.stdout
  }
  mkdirSync(primary)
  git('init', '-b', 'main', ...(separate ? ['--separate-git-dir', join(root, 'separate-git')] : []))
  writeFileSync(join(primary, '.gitignore'), '/.issue-router/\n')
  writeFileSync(join(primary, 'file.txt'), 'fixture\n')
  git('add', '.gitignore', 'file.txt')
  git('commit', '-m', 'fixture')
  function call(input: Record<string, unknown>, at = now) {
    return execute(input, primary, at) as any
  }
  function init() {
    return call({ command: 'init', repository_id: '12345', repository: 'Fixture/repo', required_checks: ['pr-quality-gate'] })
  }
  function observe(numbers: number[], baseline = true, cursor = 'c1', before = '') {
    return call({ command: 'observe', scan_id: cursor, cursor_before: before, cursor_after: cursor, complete: true, baseline,
      candidates: numbers.map((number) => ({ number, title: `Issue ${number}`, state: 'open', fingerprint: `fp-${number}`, updated_at: timestamp })),
    })
  }
  function enqueue(number: number, modules = [`module-${number}`]) {
    return call({ command: 'enqueue', number, modules, branch: `fix/issue-${number}-fixture` })
  }
  function claim(number: number, owner = `owner-${number}`) {
    const result = call({ command: 'claim', number, owner, discovery })
    const token: Token = { run_id: result.run.run_id, owner, generation: result.run.generation }
    return { ...result, token }
  }
  function bind(claimed: ReturnType<typeof claim>) {
    const boundSession = claimed.run.issue_number === 1 ? session : { ...session, session_id: `${session.session_id}/${claimed.run.issue_number}` }
    call({ command: 'dispatch-start', ...claimed.token, action_key: claimed.action.action_key, sender: 'sender' })
    call({ command: 'bind-session', ...claimed.token, action_key: claimed.action.action_key, sender: 'sender', session: boundSession, worktree: join(root, `issue-${claimed.run.issue_number}`) })
    call({ command: 'consume', ...claimed.token })
  }
  let evidenceTick = 0
  function evidence(token: Token, prNumber: number, versions = { head, base }) {
    evidenceTick += 100
    const collected = { ...provenance, observed_at: new Date(now + evidenceTick).toISOString() }
    const main = call({ command: 'status' }).main_head
    if (main !== versions.base) call({ command: 'observe-main', ...provenance, sha: versions.base, previous: main, descendant_verified: true })
    const run = call({ command: 'status' }).runs.find((run: any) => run.run_id === token.run_id)
    call({ command: 'record-pr', ...token, ...collected, ...versions, number: prNumber, state: 'open', url: `https://example.invalid/pr/${prNumber}`, branch: run.branch })
    call({ command: 'validation', ...token, ...collected, ...versions, checks: [{ name: 'verify', result: 'passed' }] })
    call({ command: 'review', ...token, ...collected, ...versions, reviewer: 'independent-context', independent: true, verdict: 'approved' })
    call({ command: 'ci', ...token, ...collected, ...versions, complete: true, tested_sha: versions.head,
      association: 'head', association_reference: 'fixture://parents', checks: [{ name: 'pr-quality-gate', external_id: 'check-1', tested_sha: versions.head, selected: true, status: 'completed', conclusion: 'success' }] })
  }
  function acquire(token: Token, versions = { head, base }) {
    return call({ command: 'merge-acquire', ...token, ...versions,
      branch_protection: { ...provenance, strict: true, required_checks: ['pr-quality-gate'] } })
  }
  return { root, primary, env, git, call, init, observe, enqueue, claim, bind, evidence, acquire,
    layout: () => resolveLayout(primary), cleanup: () => rmSync(root, { recursive: true, force: true }) }
}
