import { expect, test } from 'bun:test'
import { mkdtemp, mkdir, writeFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { countExternalMigrationProcesses } from './migrationInventory.js'

test('migration inventory preserves stale and unknown registrations and excludes owned processes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'migration-inventory-'))
  try {
    await mkdir(join(root, 'sessions'))
    for (const pid of [123, 456, 789]) await writeFile(join(root, 'sessions', `${pid}.json`), JSON.stringify({ pid }))
    await writeFile(join(root, 'sessions', 'notes.json'), '{}')
    expect(await countExternalMigrationProcesses([123], root, pid => pid !== 456)).toBe(1)
    expect((await readdir(join(root, 'sessions'))).sort()).toEqual(['123.json', '456.json', '789.json', 'notes.json'])
  } finally { await rm(root, { recursive: true, force: true }) }
})
