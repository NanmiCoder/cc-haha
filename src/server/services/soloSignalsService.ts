/**
 * soloSignalsService — Tier-1 signal collector for Solo Pipeline mode.
 *
 * Pairs with the pure-function `buildSoloSuggestions` engine. The
 * engine is deliberately I/O-free; this service is the thin layer
 * that gathers the optional `SoloSignalsTier1` bag from the host
 * filesystem, then hands it to the engine.
 *
 * Design constraints (mirrored from soloSuggestions.ts):
 *   - Each signal independently optional. A failure on one signal
 *     never blocks the others — the engine still produces useful
 *     output from a partial bag.
 *   - Bounded. Every I/O has a hard timeout and a per-signal cap.
 *     The grep-for-TODO signal scans only `dirtyFiles` (capped at
 *     ~20 by projectActivityService), never the full repo tree.
 *   - Deterministic on inputs. Given the same workDir state, the
 *     output is reproducible (modulo file mtimes, which the engine
 *     doesn't read).
 *   - Cheap. Per-call wall budget ~150ms even on a slow disk:
 *     1 git stash list (4s timeout, normally <50ms)
 *     0..20 small file reads for TODO grep (capped at 8KB each)
 *     2 small reads for the release-mismatch signal
 *     1 fs.access for git in-progress markers
 */

import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'

import type { SoloSignalsTier1 } from './soloSuggestions.js'
import type { RecentActivityResult } from './projectActivityService.js'

const execFileAsync = promisify(execFile)

/** Per-command timeout. Mirrors GIT_TIMEOUT_MS in projectActivityService. */
const GIT_TIMEOUT_MS = 4_000

/** TODO grep limits — bounded so a malicious / large dirty file can't pin us. */
const TODO_FILE_HEAD_BYTES = 8_192
const TODO_MAX_HITS = 8
const TODO_MAX_FILES_SCANNED = 20

/**
 * Read a small file head and return up to N matched markers + their
 * one-line excerpts. Reads at most TODO_FILE_HEAD_BYTES so a multi-
 * gigabyte text file (transcript, log) doesn't blow the budget.
 *
 * Returns [] on any read failure — missing file, binary, encoding —
 * so a single bad file doesn't fail the whole signal.
 */
async function scanFileForMarkers(
  absPath: string,
): Promise<Array<{ excerpt: string; line: number }>> {
  let text: string
  try {
    const fd = await fs.open(absPath, 'r')
    try {
      const buf = Buffer.alloc(TODO_FILE_HEAD_BYTES)
      const { bytesRead } = await fd.read(buf, 0, TODO_FILE_HEAD_BYTES, 0)
      text = buf.toString('utf-8', 0, bytesRead)
    } finally {
      await fd.close()
    }
  } catch {
    return []
  }
  // Skip files that look binary.
  if (text.includes('\u0000')) return []

  const hits: Array<{ excerpt: string; line: number }> = []
  const lines = text.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    if (hits.length >= TODO_MAX_HITS) break
    const line = lines[i]!
    const match = line.match(/\b(?:TODO|FIXME|XXX|HACK)\b[^\r\n]*/)
    if (match) {
      hits.push({
        excerpt: match[0]!.trim().slice(0, 200),
        line: i + 1,
      })
    }
  }
  return hits
}

/**
 * Conservative source-file classifier for the test-gap signal.
 * Mirrors the heuristic in soloSuggestions.ts (kept in sync via the
 * unit tests that exercise both). Duplicated locally rather than
 * imported so the engine stays I/O-free and this service stays
 * dependency-light.
 */
function isSourceFile(p: string): boolean {
  if (!p) return false
  if (/\.(test|spec)\.[a-z]+$/i.test(p)) return false
  if (/_test\.(py|go|rs)$/i.test(p)) return false
  if (/(^|[/\\])(tests?|__tests?__)[/\\]/i.test(p)) return false
  return /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|swift|rb|php|cs|cpp|c|h|hpp|sh|ps1)$/i.test(
    p,
  )
}

/**
 * Generate the conventional sibling-test paths for a source file.
 * Examples:
 *   src/foo.ts        → src/foo.test.ts, src/foo.spec.ts, src/__tests__/foo.ts
 *   src/foo.go        → src/foo_test.go
 *   src/lib/bar.py    → src/lib/test_bar.py, tests/test_bar.py, src/lib/bar_test.py
 *
 * Conservative — we'd rather miss a sibling and fall through to the
 * `.test.` extension form than false-claim "test exists" against a
 * naming convention this repo doesn't follow.
 */
function siblingTestCandidates(sourcePath: string): string[] {
  const parsed = path.posix.parse(sourcePath.replace(/\\/g, '/'))
  const ext = parsed.ext.toLowerCase()
  const candidates: string[] = []
  const dir = parsed.dir
  const base = parsed.name

  if (ext === '.ts' || ext === '.tsx' || ext === '.js' || ext === '.jsx' || ext === '.mjs' || ext === '.cjs') {
    candidates.push(`${dir}/${base}.test${ext}`)
    candidates.push(`${dir}/${base}.spec${ext}`)
    candidates.push(`${dir}/__tests__/${base}${ext}`)
    candidates.push(`${dir}/__tests__/${base}.test${ext}`)
  } else if (ext === '.py') {
    candidates.push(`${dir}/test_${base}${ext}`)
    candidates.push(`${dir}/${base}_test${ext}`)
    candidates.push(`tests/test_${base}${ext}`)
  } else if (ext === '.go' || ext === '.rs') {
    candidates.push(`${dir}/${base}_test${ext}`)
  } else if (ext === '.java' || ext === '.kt' || ext === '.cs') {
    candidates.push(`${dir}/${base}Test${ext}`)
    candidates.push(`${dir}/${base}Tests${ext}`)
  } else {
    candidates.push(`${dir}/${base}.test${ext}`)
    candidates.push(`${dir}/${base}.spec${ext}`)
  }

  // Strip the leading slash that may appear when dir is empty.
  return candidates.map((p) => p.replace(/^\//, ''))
}

/**
 * Resolve test-gap signal: dirty source files that don't have a
 * sibling test on disk.
 *
 * Why on disk and not "in the dirty set": a test file that already
 * exists but wasn't touched in this change is still a valid test
 * sibling — we don't want to nag the user "add tests for foo.ts"
 * when foo.test.ts is sitting next to it. The dirty-set-only check
 * (without the disk fallback) would over-fire on every change to a
 * file with stable tests.
 */
async function detectMissingTests(
  workDir: string,
  dirtyFiles: ReadonlyArray<string>,
): Promise<string[]> {
  const sources = dirtyFiles.filter(isSourceFile)
  if (sources.length === 0) return []

  const dirtySet = new Set(dirtyFiles)
  const missing: string[] = []

  // Inline cap so a pathological dirty set can't fan out fs.access.
  const cap = Math.min(sources.length, TODO_MAX_FILES_SCANNED)
  for (let i = 0; i < cap; i++) {
    const src = sources[i]!
    const candidates = siblingTestCandidates(src)

    // Cheap path: any candidate already in the dirty set means the
    // test file is being touched right now — not a gap.
    if (candidates.some((c) => dirtySet.has(c))) continue

    // Expensive path: fs.access each candidate. Stop on first hit.
    let found = false
    for (const c of candidates) {
      try {
        await fs.access(path.join(workDir, c))
        found = true
        break
      } catch {
        // continue
      }
    }
    if (!found) missing.push(src)
  }

  return missing
}

/**
 * Resolve TODO/FIXME marker signal: scan only the dirty file set.
 * Returns at most TODO_MAX_HITS entries total; each file is read
 * head-only (TODO_FILE_HEAD_BYTES) so we never load a giant log /
 * fixture into memory.
 */
async function detectTodoMarkers(
  workDir: string,
  dirtyFiles: ReadonlyArray<string>,
): Promise<Array<{ path: string; excerpt: string }>> {
  const out: Array<{ path: string; excerpt: string }> = []
  const cap = Math.min(dirtyFiles.length, TODO_MAX_FILES_SCANNED)

  for (let i = 0; i < cap; i++) {
    if (out.length >= TODO_MAX_HITS) break
    const rel = dirtyFiles[i]!
    if (!isSourceFile(rel) && !/\.(md|txt|yml|yaml|json)$/i.test(rel)) {
      continue
    }
    const hits = await scanFileForMarkers(path.join(workDir, rel))
    for (const hit of hits) {
      if (out.length >= TODO_MAX_HITS) break
      out.push({ path: rel, excerpt: hit.excerpt })
    }
  }
  return out
}

/**
 * Resolve mid-flight git state: merge / rebase / cherry-pick markers
 * left in `.git/`. Single fs.access set; ordered so REBASE and
 * CHERRY_PICK take precedence over MERGE if a user somehow has
 * multiple markers (rare but possible after a botched recovery).
 *
 * Handles git-worktree gitfile pointers (`.git` is a file pointing
 * to the actual gitdir for secondary worktrees).
 */
async function detectGitInProgress(
  workDir: string,
): Promise<SoloSignalsTier1['gitInProgress']> {
  const gitPath = path.join(workDir, '.git')
  let resolvedGitDir: string
  try {
    const stat = await fs.stat(gitPath)
    if (stat.isFile()) {
      const content = await fs.readFile(gitPath, 'utf-8')
      const match = content.match(/^gitdir:\s*(.+?)\s*$/m)
      if (!match) return undefined
      resolvedGitDir = path.isAbsolute(match[1]!)
        ? match[1]!
        : path.join(workDir, match[1]!)
    } else {
      resolvedGitDir = gitPath
    }
  } catch {
    return undefined
  }

  const markers: Array<{ name: string; tag: NonNullable<SoloSignalsTier1['gitInProgress']> }> = [
    { name: 'rebase-merge', tag: 'rebase' },
    { name: 'rebase-apply', tag: 'rebase' },
    { name: 'CHERRY_PICK_HEAD', tag: 'cherry-pick' },
    { name: 'MERGE_HEAD', tag: 'merge' },
  ]

  for (const m of markers) {
    try {
      await fs.access(path.join(resolvedGitDir, m.name))
      return m.tag
    } catch {
      // continue
    }
  }
  return undefined
}

/**
 * Resolve stash count via `git stash list`. Bounded by GIT_TIMEOUT_MS;
 * absent stash returns 0, never throws.
 */
async function detectStashCount(workDir: string): Promise<number> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['--no-optional-locks', 'stash', 'list'],
      { cwd: workDir, timeout: GIT_TIMEOUT_MS },
    )
    const lines = String(stdout)
      .split('\n')
      .filter((l) => l.trim().length > 0)
    return lines.length
  } catch {
    return 0
  }
}

/**
 * Detect release-version mismatch.
 *
 * Three failure modes the desktop release flow is sensitive to:
 *   notes-missing      — desktop/package.json was bumped but
 *                        release-notes/v<X>.md doesn't exist yet
 *   version-not-bumped — release-notes/v<X>.md exists for a version
 *                        higher than desktop/package.json (forgot
 *                        to run scripts/release.ts)
 *   tag-not-pushed     — version + notes match, but the matching
 *                        v<X> tag isn't on origin (push timing bug,
 *                        the v0.5.9 lesson)
 *
 * Returns undefined when everything is consistent OR when we can't
 * determine state (no desktop dir, no notes dir).
 */
async function detectReleaseMismatch(
  workDir: string,
): Promise<SoloSignalsTier1['releaseMismatch']> {
  let desktopVersion: string
  try {
    const raw = await fs.readFile(
      path.join(workDir, 'desktop', 'package.json'),
      'utf-8',
    )
    const parsed = JSON.parse(raw) as { version?: unknown }
    if (typeof parsed.version !== 'string') return undefined
    desktopVersion = parsed.version
  } catch {
    return undefined
  }

  // Find the latest vX.Y.Z.md in release-notes/ by semver sort (DESC).
  let latestNotes: string | undefined
  try {
    const entries = await fs.readdir(path.join(workDir, 'release-notes'))
    const semverRx = /^v(\d+)\.(\d+)\.(\d+)\.md$/
    const versions: Array<{ version: string; nums: number[] }> = []
    for (const e of entries) {
      const m = e.match(semverRx)
      if (!m) continue
      versions.push({
        version: `${m[1]}.${m[2]}.${m[3]}`,
        nums: [Number(m[1]), Number(m[2]), Number(m[3])],
      })
    }
    versions.sort((a, b) => {
      for (let i = 0; i < 3; i++) {
        if (a.nums[i] !== b.nums[i]) return b.nums[i]! - a.nums[i]!
      }
      return 0
    })
    latestNotes = versions[0]?.version
  } catch {
    return undefined
  }

  if (!latestNotes) {
    // No notes directory or no semver-named files. We can't tell.
    return undefined
  }

  if (latestNotes === desktopVersion) {
    // Versions match. Check if the tag was pushed.
    try {
      const { stdout } = await execFileAsync(
        'git',
        [
          '--no-optional-locks',
          'ls-remote',
          '--tags',
          'origin',
          `v${desktopVersion}`,
        ],
        { cwd: workDir, timeout: GIT_TIMEOUT_MS },
      )
      if (!String(stdout).trim()) {
        return {
          desktopVersion,
          latestNotes,
          kind: 'tag-not-pushed',
        }
      }
    } catch {
      // Network error / no remote — leave alone, don't false-fire.
    }
    return undefined
  }

  const cmp = compareSemver(latestNotes, desktopVersion)
  if (cmp > 0) {
    // notes ahead of desktop version → user forgot to bump version.
    return {
      desktopVersion,
      latestNotes,
      kind: 'version-not-bumped',
    }
  }
  // desktop ahead of notes → user bumped the version but didn't write notes.
  return {
    desktopVersion,
    latestNotes,
    kind: 'notes-missing',
  }
}

/** Lexical-numeric semver comparator; positive means a > b. */
function compareSemver(a: string, b: string): number {
  const aa = a.split('.').map((n) => Number(n) || 0)
  const bb = b.split('.').map((n) => Number(n) || 0)
  for (let i = 0; i < 3; i++) {
    const av = aa[i] ?? 0
    const bv = bb[i] ?? 0
    if (av !== bv) return av - bv
  }
  return 0
}

/**
 * Public entry: gather a Tier-1 bag for the given workDir.
 *
 * Hot-path-safe: every signal runs in parallel under
 * `Promise.allSettled` so a hang on (say) `git stash list` never
 * blocks the others. A signal that throws or times out is omitted
 * from the result; the engine treats missing fields as "not
 * detected" rather than "definitely zero".
 *
 * `recent` is the existing zero-token snapshot — we accept it as a
 * parameter so callers don't double-fetch (the welcome flow already
 * has it from `getRecentActivity`).
 */
export async function gatherSoloSignalsTier1(
  workDir: string,
  recent: RecentActivityResult,
): Promise<SoloSignalsTier1> {
  if (!workDir) return {}
  const dirtyFiles = recent.git?.dirtyFiles ?? []

  const [
    stashRes,
    missingTestsRes,
    todoRes,
    releaseRes,
    inProgressRes,
  ] = await Promise.allSettled([
    detectStashCount(workDir),
    detectMissingTests(workDir, dirtyFiles),
    detectTodoMarkers(workDir, dirtyFiles),
    detectReleaseMismatch(workDir),
    detectGitInProgress(workDir),
  ])

  const out: SoloSignalsTier1 = {}

  if (stashRes.status === 'fulfilled' && stashRes.value > 0) {
    out.stashCount = stashRes.value
  }
  if (missingTestsRes.status === 'fulfilled' && missingTestsRes.value.length > 0) {
    out.missingTestFiles = missingTestsRes.value
  }
  if (todoRes.status === 'fulfilled' && todoRes.value.length > 0) {
    out.todoHits = todoRes.value
  }
  if (releaseRes.status === 'fulfilled' && releaseRes.value) {
    out.releaseMismatch = releaseRes.value
  }
  if (inProgressRes.status === 'fulfilled' && inProgressRes.value) {
    out.gitInProgress = inProgressRes.value
  }

  return out
}

/** @internal — exposed so tests can lock the heuristics. */
export const _SOLO_SIGNALS_INTERNALS = {
  isSourceFile,
  siblingTestCandidates,
  compareSemver,
  TODO_MAX_HITS,
  TODO_MAX_FILES_SCANNED,
}
