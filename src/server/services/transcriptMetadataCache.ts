// Durable cache for the per-transcript metadata projection.
//
// Building one means one full pass over the transcript (message count, last
// timestamp, launch info and titles all need it), which a fresh process paid
// again on the first open of a large session — measured 9.6 s for a 139 MB
// session that also had a 184 MB copy under another discovery root. The result
// is a few KB of plain scalars, so it is worth keeping next to the other
// regenerable indexes.
//
// Correctness does not depend on this file: a stored entry is used only when its
// signature still describes the transcript on disk, and the caller falls back to
// the scan otherwise. A missing, unreadable, or stale entry costs a scan, never
// a wrong answer.
import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { getCcHahaDir } from '../../utils/envUtils.js'

type Stored = { signature: string; projectDir: string; value: unknown }

const PRUNE_AFTER_MS = 7 * 24 * 60 * 60 * 1000
let pruned = false

/** Directory override exists so tests do not write into the real config dir. */
function cacheDirectory(): string {
  return process.env.CC_HAHA_TRANSCRIPT_METADATA_DIR
    ?? join(getCcHahaDir(), 'db', 'transcript-metadata-v1')
}

/** Keyed by the pair the in-memory cache uses, so the two agree on identity. */
function cachePath(configDir: string, filePath: string): string {
  const hash = createHash('sha256').update(`${configDir}\0${filePath}`).digest('hex').slice(0, 40)
  return join(cacheDirectory(), `${hash}.json`)
}

/** Sweep entries untouched for a week, at most once per process. */
function pruneOnce(): void {
  if (pruned) return
  pruned = true
  try {
    const cutoff = Date.now() - PRUNE_AFTER_MS
    for (const name of readdirSync(cacheDirectory())) {
      if (!name.endsWith('.json')) continue
      const path = join(cacheDirectory(), name)
      // One unreadable entry must not stop the sweep.
      try { if (statSync(path).mtimeMs < cutoff) rmSync(path, { force: true }) } catch { /* skip */ }
    }
  } catch { /* the directory may not exist yet */ }
}

export async function readStoredTranscriptMetadata<T>(
  configDir: string,
  filePath: string,
  signature: string,
  projectDir: string,
): Promise<T | null> {
  pruneOnce()
  try {
    const stored = JSON.parse(await readFile(cachePath(configDir, filePath), 'utf8')) as Stored
    if (stored.signature !== signature || stored.projectDir !== projectDir) return null
    return stored.value as T
  } catch {
    // Absent, unreadable, or not JSON — the caller scans instead.
    return null
  }
}

export function writeStoredTranscriptMetadata(
  configDir: string,
  filePath: string,
  signature: string,
  projectDir: string,
  value: unknown,
): void {
  const path = cachePath(configDir, filePath)
  const payload = JSON.stringify({ signature, projectDir, value } satisfies Stored)
  // Fire and forget: this is a cache, and the caller must not wait on it. The
  // rename keeps a concurrent reader from seeing a half-written file.
  void mkdir(cacheDirectory(), { recursive: true, mode: 0o700 })
    .then(() => writeFile(`${path}.tmp`, payload, 'utf8'))
    .then(() => rename(`${path}.tmp`, path))
    .catch(() => { void unlink(`${path}.tmp`).catch(() => {}) })
}

/** Test-only: forget the once-per-process prune so a test can observe it. */
export function __resetTranscriptMetadataPruneForTests(): void {
  pruned = false
}
