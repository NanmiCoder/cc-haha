// Lock file whose mtime is the consolidation timestamp. Legacy PID-only and
// empty bodies retain that meaning. New attempts explicitly record their
// in-progress state and prior timestamp, so crashes can be recovered safely.
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

type InProgressLock = { pid: number; priorMtime: number }

function parseInProgressLock(raw: string): InProgressLock | null {
  const match = /^(\d+) auto-dream-v1 (\d+(?:\.\d+)?)$/.exec(raw.trim())
  if (!match) return null
  const pid = Number(match[1])
  const priorMtime = Number(match[2])
  return Number.isSafeInteger(pid) && pid > 1 && Number.isFinite(priorMtime)
    ? { pid, priorMtime }
    : null
}

// Stale past this even if the PID is live (PID reuse guard).
const HOLDER_STALE_MS = 60 * 60 * 1000

function lockPath(): string {
  return join(getAutoMemPath(), LOCK_FILE)
}

/**
 * mtime of the lock file = lastConsolidatedAt. 0 if absent.
 * Only explicitly marked attempts can be identified as interrupted. A legacy
 * dead PID may represent a successful run, so its timestamp stays authoritative.
 */
export async function readLastConsolidatedAt(): Promise<number> {
  try {
    const [s, raw] = await Promise.all([stat(lockPath()), readFile(lockPath(), 'utf8')])
    const attempt = parseInProgressLock(raw)
    if (attempt && !isProcessRunning(attempt.pid)) return attempt.priorMtime
    return s.mtimeMs
  } catch {
    return 0
  }
}

/**
 * Acquire: write a versioned PID + prior timestamp → mtime = now. Returns the pre-acquire mtime
 * (for rollback), or null if blocked / lost a race.
 *
 *   Success → completeConsolidationLock() clears PID, keeping mtime.
 *   Failure → rollbackConsolidationLock(priorMtime) rewinds mtime.
 *   Crash   → mtime stuck, dead PID → next process reclaims.
 */
export async function tryAcquireConsolidationLock(): Promise<number | null> {
  const path = lockPath()

  let mtimeMs: number | undefined
  let holderPid: number | undefined
  let priorMtime = 0
  try {
    const [s, raw] = await Promise.all([stat(path), readFile(path, 'utf8')])
    mtimeMs = s.mtimeMs
    // Upgrade lazily on acquisition; never reinterpret a legacy PID as failure.
    priorMtime = parseInProgressLock(raw)?.priorMtime ?? s.mtimeMs
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
  const record = `${process.pid} auto-dream-v1 ${priorMtime}`
  await writeFile(path, record)

  // Two reclaimers both write → last wins the PID. Loser bails on re-read.
  let verify: string
  try {
    verify = await readFile(path, 'utf8')
  } catch {
    return null
  }
  if (verify !== record) return null

  return priorMtime
}

/** Mark success without leaving a dead PID that looks like an interrupted run. */
export async function completeConsolidationLock(): Promise<void> {
  const path = lockPath()
  try {
    const [s, raw] = await Promise.all([stat(path), readFile(path, 'utf8')])
    if (parseInProgressLock(raw)?.pid !== process.pid) return
    await writeFile(path, '')
    await utimes(path, s.atimeMs / 1000, s.mtimeMs / 1000)
  } catch (e: unknown) {
    logForDebugging(`[autoDream] completion stamp failed: ${(e as Error).message}`)
  }
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
 * Stamp from manual /dream. Optimistic — fires at prompt-build time,
 * no post-skill completion hook. Best-effort.
 */
export async function recordConsolidation(): Promise<void> {
  try {
    // Memory dir may not exist yet (manual /dream before any auto-trigger).
    await mkdir(getAutoMemPath(), { recursive: true })
    await writeFile(lockPath(), '')
  } catch (e: unknown) {
    logForDebugging(
      `[autoDream] recordConsolidation write failed: ${(e as Error).message}`,
    )
  }
}
