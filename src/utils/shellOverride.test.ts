import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findSuitableShell } from './Shell.js'

const originalOverride = process.env.CLAUDE_CODE_SHELL
let dir: string | null = null

afterEach(() => {
  if (originalOverride === undefined) delete process.env.CLAUDE_CODE_SHELL
  else process.env.CLAUDE_CODE_SHELL = originalOverride
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = null
})

describe.skipIf(process.platform === 'win32')('CLAUDE_CODE_SHELL override', () => {
  test('falls back to detection when the override cannot run', async () => {
    dir = mkdtempSync(join(tmpdir(), 'cc-haha-shell-override-'))
    const brokenBash = join(dir, 'bash')
    // Not executable, so the X_OK check fails and the --version probe runs.
    writeFileSync(brokenBash, '#!/bin/sh\nexit 0\n', { mode: 0o644 })
    process.env.CLAUDE_CODE_SHELL = brokenBash

    const shell = await findSuitableShell()

    expect(shell).not.toBe(brokenBash)
    expect(shell).toMatch(/(bash|zsh)$/)
  })
})
