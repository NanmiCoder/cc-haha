import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, utimes, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { getAutoMemPath } from '../../memdir/paths.js'
import { isProcessRunning } from '../../utils/genericProcessUtils.js'
import {
  readLastConsolidatedAt,
  tryAcquireConsolidationLock,
} from './consolidationLock.js'

// A PID that is (almost certainly) not running; guarded in beforeEach so a
// surprise live PID fails loudly instead of silently weakening the test.
const DEAD_PID = 999_999

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'autodream-lock-'))
  process.env.CLAUDE_COWORK_MEMORY_PATH_OVERRIDE = dir
  getAutoMemPath.cache.clear()
  expect(isProcessRunning(DEAD_PID)).toBe(false)
})

afterEach(async () => {
  delete process.env.CLAUDE_COWORK_MEMORY_PATH_OVERRIDE
  getAutoMemPath.cache.clear()
  await rm(dir, { recursive: true, force: true })
})

async function ageFile(path: string, mtimeMs: number): Promise<void> {
  const t = mtimeMs / 1000
  await utimes(path, t, t)
}

describe('consolidation lock time gate', () => {
  test('interrupted run residue does not postpone the next consolidation window', async () => {
    // Last successful consolidation finished 25h ago (older than minHours=24).
    const lastSuccess = Date.now() - 25 * 60 * 60 * 1000
    const lastFile = join(dir, '.consolidate-last')
    await writeFile(lastFile, String(DEAD_PID))
    await ageFile(lastFile, lastSuccess)

    // Crash residue: the lock was acquired 30 minutes ago by a process that
    // died mid-run, so its mtime is fresh but nothing was consolidated.
    const lockFile = join(dir, '.consolidate-lock')
    await writeFile(lockFile, String(DEAD_PID))
    await ageFile(lockFile, Date.now() - 30 * 60 * 1000)

    const lastAt = await readLastConsolidatedAt()

    // The time gate must key on the last SUCCESS, not the interrupted acquire.
    expect(Math.abs(lastAt - lastSuccess)).toBeLessThan(2000)
    expect((Date.now() - lastAt) / 3_600_000).toBeGreaterThanOrEqual(24)
  })

  test('falls back to the lock mtime while no success stamp exists yet', async () => {
    // Pre-split installs only have the lock file; its mtime still carries the
    // last-consolidated meaning until the first success writes the stamp.
    const lockFile = join(dir, '.consolidate-lock')
    const old = Date.now() - 48 * 60 * 60 * 1000
    await writeFile(lockFile, String(DEAD_PID))
    await ageFile(lockFile, old)

    const lastAt = await readLastConsolidatedAt()
    expect(Math.abs(lastAt - old)).toBeLessThan(2000)
  })

  test('legacy fallback freezes the mtime into the stamp so a later crash cannot postpone the gate', async () => {
    const lockFile = join(dir, '.consolidate-lock')
    const lastSuccess = Date.now() - 25 * 60 * 60 * 1000
    await writeFile(lockFile, String(DEAD_PID))
    await ageFile(lockFile, lastSuccess)

    // First read migrates: stamp now carries the legacy mtime.
    expect(Math.abs((await readLastConsolidatedAt()) - lastSuccess)).toBeLessThan(2000)

    // Simulate acquire-then-crash after migration: the lock mtime jumps to
    // "now" with a dead PID and no rollback ever runs.
    await writeFile(lockFile, String(DEAD_PID))
    await ageFile(lockFile, Date.now() - 60 * 1000)

    // The gate must still key on the migrated stamp, not the crashed acquire.
    const lastAt = await readLastConsolidatedAt()
    expect(Math.abs(lastAt - lastSuccess)).toBeLessThan(2000)
    expect((Date.now() - lastAt) / 3_600_000).toBeGreaterThanOrEqual(24)
  })

  test('live holder still blocks acquisition (mutex unchanged)', async () => {
    const lockFile = join(dir, '.consolidate-lock')
    await writeFile(lockFile, String(process.pid))

    expect(await tryAcquireConsolidationLock()).toBeNull()
  })
})
