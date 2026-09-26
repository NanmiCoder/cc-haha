import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cleanupOldSessionFiles } from './cleanup.js'

describe('local shell metadata retention', () => {
  const originalConfigDir = process.env.CLAUDE_CONFIG_DIR
  let configDir: string

  beforeEach(async () => {
    configDir = join(tmpdir(), `local-shell-cleanup-${crypto.randomUUID()}`)
    await mkdir(configDir, { recursive: true })
    process.env.CLAUDE_CONFIG_DIR = configDir
  })

  afterEach(async () => {
    await rm(configDir, { recursive: true, force: true })
    if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = originalConfigDir
  })

  test('removes expired sidecars and preserves recent sidecars', async () => {
    const localShellsDir = join(configDir, 'projects', 'project', 'session', 'local-shells')
    const expired = join(localShellsDir, 'local-shell-expired.meta.json')
    const recent = join(localShellsDir, 'local-shell-recent.meta.json')
    const now = new Date()
    const cutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000)
    const old = new Date(cutoff.getTime() - 1)
    await mkdir(localShellsDir, { recursive: true })
    await writeFile(expired, '{}')
    await writeFile(recent, '{}')
    await utimes(expired, old, old)

    const result = await cleanupOldSessionFiles(cutoff)

    expect(result).toEqual({ messages: 1, errors: 0 })
    await expect(stat(expired)).rejects.toThrow()
    await expect(stat(recent)).resolves.toBeDefined()
  })
})
