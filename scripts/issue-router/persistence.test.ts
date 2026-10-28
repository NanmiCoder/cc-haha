import { afterEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fixture, now, session } from './test-helpers'

const fixtures: ReturnType<typeof fixture>[] = []
afterEach(() => { for (const f of fixtures.splice(0)) f.cleanup() })
function legacy(version = 1) {
  const f = fixture()
  fixtures.push(f)
  const layout = f.layout()
  mkdirSync(layout.stateRoot)
  const db = new Database(layout.database)
  db.exec(readFileSync(join(import.meta.dir, 'fixtures/v1.sql'), 'utf8'))
  if (version === 2) db.exec(readFileSync(join(import.meta.dir, 'fixtures/v2.sql'), 'utf8'))
  db.query('INSERT INTO meta VALUES (?, ?)').run('primary', layout.primary)
  db.query('INSERT INTO meta VALUES (?, ?)').run('common_dir', layout.commonDir)
  db.close()
  return f
}

describe('issue router persistence upgrade', () => {
  test('frozen v1 migrates forward with a consistent pre-migration backup and never releases a legacy owner', () => {
    const f = legacy()
    expect(() => f.call({ command: 'status' })).toThrow('requires explicit migrate')
    const migrated = f.call({ command: 'migrate' })
    expect(migrated.schema_version).toBe(3)
    expect(migrated.migrated).toBe(true)
    const old = new Database(migrated.backup, { readonly: true })
    expect(old.query('PRAGMA user_version').get()).toEqual({ user_version: 1 })
    expect(old.query('SELECT owner, generation FROM runs').get()).toEqual({ owner: 'legacy-owner', generation: 3 })
    old.close()
    const state = f.call({ command: 'status' })
    expect(state.cursor).toBe('legacy-cursor')
    expect(state.runs[0]).toMatchObject({ run_id: 'legacy-run', owner: 'legacy-owner', generation: 3, lease_expired: true })
    expect(state.actions[0].status).toBe('unknown')
    expect(state.resources).toHaveLength(2)
    expect(f.call({ command: 'migrate' })).toEqual({ schema_version: 3, migrated: false })
    expect(() => f.call({ command: 'dispatch-start', run_id: 'legacy-run', owner: 'legacy-owner', generation: 3, action_key: 'legacy-action', sender: 'new-sender' })).toThrow('Only pending actions')
  })

  test('frozen v2 upgrades content delivery conservatively without resending an unknown action', () => {
    const f = legacy(2)
    const result = f.call({ command: 'migrate' })
    expect(result.schema_version).toBe(3)
    const snapshot = new Database(result.backup, { readonly: true })
    expect(snapshot.query('PRAGMA user_version').get()).toEqual({ user_version: 2 })
    snapshot.close()
    const state = f.call({ command: 'status' })
    expect(state.issues[0]).toMatchObject({ revision: 1, delivered_revision: 0 })
    expect(state.runs[0]).toMatchObject({ owner: 'legacy-owner', generation: 3 })
    expect(state.actions[0].status).toBe('unknown')
    const token = { run_id: 'legacy-run', owner: 'legacy-owner', generation: 3 }
    f.call({ command: 'reconcile', ...token, action_key: 'legacy-action', outcome: 'found', reference: 'fixture://found', session, worktree: '/fixture' })
    const action = f.call({ command: 'consume', ...token }).action
    expect(JSON.parse(action.payload).revision).toBe(1)
    expect(action.kind).toBe('resume')
  })

  test('consistent WAL backup restores queue, outbox and cursor with an explicit recovery barrier', () => {
    const f = fixture()
    fixtures.push(f)
    f.init()
    f.observe([1])
    f.enqueue(1)
    const claimed = f.claim(1)
    f.call({ command: 'dispatch-start', ...claimed.token, action_key: claimed.action.action_key, sender: 'sender' })
    const writer = new Database(f.layout().database)
    writer.exec('PRAGMA journal_mode = WAL')
    writer.query("UPDATE runs SET next_step = 'committed in WAL' WHERE run_id = ?").run(claimed.run.run_id)
    const backup = f.call({ command: 'backup' }).backup
    const snapshot = new Database(backup, { readonly: true })
    expect(snapshot.query('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' })
    expect(snapshot.query('SELECT next_step FROM runs').get()).toEqual({ next_step: 'committed in WAL' })
    snapshot.close()
    writer.close()
    expect(() => f.call({ command: 'restore', backup, clients_stopped: true })).toThrow('quarantine the existing')
    renameSync(f.layout().database, `${f.layout().database}.quarantined`)
    for (const suffix of ['-wal', '-shm']) {
      if (existsSync(`${f.layout().database}${suffix}`)) renameSync(`${f.layout().database}${suffix}`, `${f.layout().database}${suffix}.quarantined`)
    }
    const restored = f.call({ command: 'restore', backup, clients_stopped: true })
    expect(restored.reconcile_required).toBe(true)
    expect(f.call({ command: 'status' }).recovery_required).toBe(true)
    expect(() => f.call({ command: 'claim', number: 1, owner: 'late', discovery: {} })).toThrow()
    expect(() => f.call({ command: 'progress', ...claimed.token, phase: 'ci', next_step: 'wait', reference: 'fixture://progress' })).toThrow('Reconcile sessions')
    f.call({ command: 'recovery-confirm', clients_stopped: true, reference: 'fixture://all-sessions-prs-resources-audited' })
    const state = f.call({ command: 'status' })
    expect(state.runs[0].owner).toBe(claimed.token.owner)
    expect(state.actions[0].status).toBe('sending')
    expect(state.cursor).toBe('c1')
    f.call({ command: 'reconcile', ...claimed.token, action_key: claimed.action.action_key, outcome: 'found', reference: 'fixture://found', session, worktree: '/fixture' })
    expect(f.call({ command: 'status' }).runs[0].session).toEqual(session)
  })

  test('foreign, unsupported, damaged and missing databases stop instead of starting a second queue', () => {
    const f = legacy()
    const db = new Database(f.layout().database)
    db.query("UPDATE meta SET value = '/another/common' WHERE key = 'common_dir'").run()
    db.close()
    expect(() => f.call({ command: 'migrate' })).toThrow('different checkout')
    expect(() => f.call({ command: 'init', repository_id: '12345', repository: 'Fixture/repo' })).toThrow('EEXIST')
    expect(existsSync(join(f.layout().stateRoot, 'backups'))).toBe(false)
    const badBackup = join(f.root, 'damaged.sqlite3')
    writeFileSync(badBackup, 'invalid database')
    renameSync(f.layout().database, `${f.layout().database}.quarantined`)
    expect(() => f.call({ command: 'restore', backup: badBackup, clients_stopped: true })).toThrow()
    expect(existsSync(f.layout().database)).toBe(false)
    expect(() => f.call({ command: 'status' }, now)).toThrow('State is missing')
  })
})
