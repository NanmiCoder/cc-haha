import { describe, expect, it } from 'vitest'
import { copyMigrationCredentials, removeMigrationCredentials, verifyMigrationCredentials, type MigrationCredentialReceipt, type MigrationCredentialStore } from './migrationCredentials'

function store() {
  const values = new Map<string, string>([['Claude Code', 'fake-api-key'], ['Claude Code-credentials', '{"fakeOauth":"token"}']])
  const api: MigrationCredentialStore = { async read(key) { return values.get(key) ?? null }, async write(key, value) { values.set(key, value) }, async remove(key) { values.delete(key) } }
  return { values, api }
}

describe('macOS migration credential copy', () => {
  it('copies both namespaces, validates, and never removes source credentials', async () => {
    const { values, api } = store()
    const created: MigrationCredentialReceipt[] = []
    const receipts = await copyMigrationCredentials('/home/.claude', true, '/new/data', api, async receipt => { created.push(receipt) })
    expect(receipts).toHaveLength(2)
    expect(JSON.stringify(receipts)).not.toContain('fake-api-key')
    await verifyMigrationCredentials(receipts, api)
    expect(values.get('Claude Code')).toBe('fake-api-key')
    expect(values.get('Claude Code-credentials')).toBe('{"fakeOauth":"token"}')
    await removeMigrationCredentials(created, api)
    expect(values.size).toBe(2)
  })

  it('rejects conflicting target credentials without overwriting either namespace', async () => {
    const { values, api } = store()
    const receipts = await copyMigrationCredentials('/home/.claude', true, '/new/data', api, async () => {})
    values.set(receipts[0]!.service, 'different-user')
    await expect(copyMigrationCredentials('/home/.claude', true, '/new/data', api, async () => {})).rejects.toThrow('different macOS credentials')
    expect(values.get(receipts[0]!.service)).toBe('different-user')
    expect(values.get('Claude Code')).toBe('fake-api-key')
  })

  it('reuses equal target credentials and does not mark them for rollback deletion', async () => {
    const { values, api } = store()
    await copyMigrationCredentials('/home/.claude', true, '/new/data', api, async () => {})
    const created: MigrationCredentialReceipt[] = []
    await copyMigrationCredentials('/home/.claude', true, '/new/data', api, async receipt => { created.push(receipt) })
    expect(created).toEqual([])
    expect(values.size).toBe(4)
  })

  it('requires verified credentials on startup and preserves independently changed entries on rollback', async () => {
    const { values, api } = store()
    const receipts = await copyMigrationCredentials('/home/.claude', true, '/new/data', api, async () => {})
    values.set(receipts[0]!.service, 'independently changed')
    await expect(verifyMigrationCredentials(receipts, api)).rejects.toThrow('unavailable')
    await removeMigrationCredentials(receipts, api)
    expect(values.get(receipts[0]!.service)).toBe('independently changed')
  })

  it('uses runtime NFC namespace hashing for decomposed macOS directory names', async () => {
    const first = store()
    const second = store()
    const receiptsNfc = await copyMigrationCredentials('/home/.claude', true, '/new/café', first.api, async () => {})
    const receiptsNfd = await copyMigrationCredentials('/home/.claude', true, '/new/cafe\u0301', second.api, async () => {})
    expect(receiptsNfd).toEqual(receiptsNfc)
  })
})
