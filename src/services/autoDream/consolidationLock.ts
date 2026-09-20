// Mutex lock (.consolidate-lock, body = holder PID) plus a success stamp
// (.consolidate-last) whose mtime IS lastConsolidatedAt.
//
// Split into two files so an interrupted run cannot postpone the next one:
// when the client dies mid-dream the process never reaches the rollback
// path, and while the lock mtime used to double as lastConsolidatedAt the
// fresh acquire timestamp silently delayed the next trigger by minHours
// (issue #1349). The lock mtime now only serves the mutex/stale-holder
// logic; the time gate reads the success stamp.
//
// Lives inside the memory dir (getAutoMemPath) so it keys on git-root
// like memory does, and so it's writable even when the memory path comes
// from an env/settings override whose parent may not be.

import { mkdir, readFile, stat, unlink, utimes, writeFile } from 'fs/promises'
import { join } from 'path'
import { getOriginalCwd } from '../../bootstrap/state.js'
import { getAutoMemPath } from '../../memdir/paths.js'
import { logForDebugging } from '../../utils/debug.js'
import { isProcessRunning } from '../../utils/genericProcessUtils.js'
import { listCandidates } from '../../utils/listSessionsImpl.js'
import { getProjectDir } from '../../utils/sessionStorage.js'

const LOCK_FILE = '.consolidate-lock'
const LAST_FILE = '.consolidate-last'

// Stale past this even if the PID is live (PID reuse guard).
const HOLDER_STALE_MS = 60 * 60 * 1000

function lockPath(): string {
  return join(getAutoMemPath(), LOCK_FILE)
}

function lastPath(): string {
  return join(getAutoMemPath(), LAST_FILE)
}

/**
 * mtime of the success stamp = lastConsolidatedAt. 0 if absent.
 *
 * Falls back to the lock mtime while no stamp exists yet, so installs
 * from before the split keep their existing schedule; the first fallback
 * read freezes the legacy mtime into the stamp so a later interrupted
 * acquire cannot postpone the gate.
 *
 * Per-turn cost: one stat (two on the pre-split fallback path).
 */
export async function readLastConsolidatedAt(): Promise<number> {
  try {
    const s = await stat(lastPath())
    return s.mtimeMs
  } catch {
    // No success stamp yet — fall through to the legacy lock mtime.
  }
  try {
    const s = await stat(lockPath())
    // One-time migration for pre-split installs: freeze the legacy mtime
    // into the stamp so a later acquire (which refreshes the lock mtime)
    // followed by a crash cannot postpone the gate. Best-effort — if the
    // write fails we still return the legacy value and retry next read.
    try {
      await writeFile(lastPath(), String(process.pid))
      const t = s.mtimeMs / 1000
      await utimes(lastPath(), t, t)
    } catch {
      // Keep the fallback value; migration retries on the next read.
    }
    return s.mtimeMs
  } catch {
    return 0
  }
}

/**
 * Acquire: write PID → mtime = now. Returns the pre-acquire mtime
 * (for rollback), or null if blocked / lost a race.
 *
 *   Success → do nothing. mtime stays at now.
 *   Failure → rollbackConsolidationLock(priorMtime) rewinds mtime.
 *   Crash   → mtime stuck, dead PID → next process reclaims.
 */
export async function tryAcquireConsolidationLock(): Promise<number | null> {
  const path = lockPath()

  let mtimeMs: number | undefined
  let holderPid: number | undefined
  try {
    const [s, raw] = await Promise.all([stat(path), readFile(path, 'utf8')])
    mtimeMs = s.mtimeMs
    const parsed = parseInt(raw.trim(), 10)
    holderPid = Number.isFinite(parsed) ? parsed : undefined
  } catch {
    // ENOENT — no prior lock.
  }

  if (mtimeMs !== undefined && Date.now() - mtimeMs < HOLDER_STALE_MS) {
    if (holderPid !== undefined && isProcessRunning(holderPid)) {
      logForDebugging(
        `[autoDream] lock held by live PID ${holderPid} (mtime ${Math.round((Date.now() - mtimeMs) / 1000)}s ago)`,
      )
      return null
    }
    // Dead PID or unparseable body — reclaim.
  }

  // Memory dir may not exist yet.
  await mkdir(getAutoMemPath(), { recursive: true })
  await writeFile(path, String(process.pid))

  // Two reclaimers both write → last wins the PID. Loser bails on re-read.
  let verify: string
  try {
    verify = await readFile(path, 'utf8')
  } catch {
    return null
  }
  if (parseInt(verify.trim(), 10) !== process.pid) return null

  return mtimeMs ?? 0
}

/**
 * Rewind mtime to pre-acquire after a failed fork. Clears the PID body —
 * otherwise our still-running process would look like it's holding.
 * priorMtime 0 → unlink (restore no-file).
 */
export async function rollbackConsolidationLock(
  priorMtime: number,
): Promise<void> {
  const path = lockPath()
  try {
    if (priorMtime === 0) {
      await unlink(path)
      return
    }
    await writeFile(path, '')
    const t = priorMtime / 1000 // utimes wants seconds
    await utimes(path, t, t)
  } catch (e: unknown) {
    logForDebugging(
      `[autoDream] rollback failed: ${(e as Error).message} — next trigger delayed to minHours`,
    )
  }
}

/**
 * Session IDs with mtime after sinceMs. listCandidates handles UUID
 * validation (excludes agent-*.jsonl) and parallel stat.
 *
 * Uses mtime (sessions TOUCHED since), not birthtime (0 on ext4).
 * Caller excludes the current session. Scans per-cwd transcripts — it's
 * a skip-gate, so undercounting worktree sessions is safe.
 */
export async function listSessionsTouchedSince(
  sinceMs: number,
): Promise<string[]> {
  const dir = getProjectDir(getOriginalCwd())
  const candidates = await listCandidates(dir, true)
  return candidates.filter(c => c.mtime > sinceMs).map(c => c.sessionId)
}

/**
 * Stamp a completed consolidation (auto-dream success or manual /dream).
 * Writes the success stamp whose mtime is lastConsolidatedAt. Optimistic —
 * fires when the run completes, best-effort.
 */
export async function recordConsolidation(): Promise<void> {
  try {
    // Memory dir may not exist yet (manual /dream before any auto-trigger).
    await mkdir(getAutoMemPath(), { recursive: true })
    await writeFile(lastPath(), String(process.pid))
  } catch (e: unknown) {
    logForDebugging(
      `[autoDream] recordConsolidation write failed: ${(e as Error).message}`,
    )
  }
}
