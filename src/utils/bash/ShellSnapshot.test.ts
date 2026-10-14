import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAndSaveSnapshot } from './ShellSnapshot.js'

const originalConfigDir = process.env.CLAUDE_CONFIG_DIR
let configDir: string

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), 'cc-haha-shell-snapshot-'))
  process.env.CLAUDE_CONFIG_DIR = configDir
})

afterEach(() => {
  if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = originalConfigDir
  rmSync(configDir, { recursive: true, force: true })
})

describe.skipIf(process.platform === 'win32')('createAndSaveSnapshot', () => {
  test('writes a snapshot from a real bash login shell', async () => {
    const snapshotPath = await createAndSaveSnapshot('/bin/bash')

    expect(snapshotPath).toBeDefined()
    expect(snapshotPath!.startsWith(join(configDir, 'shell-snapshots'))).toBe(true)
    expect(existsSync(snapshotPath!)).toBe(true)
    expect(readFileSync(snapshotPath!, 'utf8').length).toBeGreaterThan(0)
  }, 20_000)
})
