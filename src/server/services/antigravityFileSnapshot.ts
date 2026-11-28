import { createHash, randomUUID } from 'node:crypto'
import { closeSync, constants as fsConstants, fstatSync, lstatSync, openSync, readFileSync, realpathSync, type Stats } from 'node:fs'
import { lstat, mkdir, open, realpath, rename, unlink, type FileHandle } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, parse, relative, resolve } from 'node:path'
import { diffLines } from 'diff'
import { getClaudeConfigHomeDir } from '../../utils/envUtils.js'
import { resolveBackupPath, type FileHistoryBackup } from '../../utils/fileHistory.js'

const GIT_TIMEOUT_MS = 1_500
const MAX_GIT_STDOUT_BYTES = 8 * 1024 * 1024
const MAX_DIRTY_BASELINE_FILES = 500
const MAX_SNAPSHOT_FILE_BYTES = 4 * 1024 * 1024
const MAX_TOTAL_BASELINE_BYTES = 32 * 1024 * 1024
const MAX_CHANGED_FILES_PER_TURN = 500
const LS_TREE_CHUNK_SIZE = 200
const CAT_FILE_CONCURRENCY = 8
const O_NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0

type GitBaseline = {
  repoRoot: string
  /** Relative POSIX path from repoRoot to canonicalWorkDir, or '' when workDir === repoRoot. */
  statusPathspec: string
  headSha: string | null
  /**
   * Files already dirty or untracked at turn start, keyed by repo-relative POSIX path.
   * `Buffer` = exact pre-turn bytes; `null` = file did not exist on disk (deleted in worktree);
   * `undefined` = file was skipped (oversized/unsafe) so pre-turn bytes are unknown.
   */
  dirtyBefore: Map<string, Buffer | null | undefined>
}

type CapturedTurn = {
  userMessageId: string
  turnSeq: number
  gitBaseline: GitBaseline | null
  pendingToolBefore: Map<string, Buffer | null | undefined>
  completedToolPaths: Set<string>
}

export type AntigravityTurnSnapshotResult = {
  snapshotEntry: Record<string, unknown>
  filesChanged: number
  insertions: number
  deletions: number
}

type GitBytesResult =
  | { ok: true; stdout: Buffer }
  | { ok: false }

function isSafePathSegment(segment: string): boolean {
  return Boolean(segment) && segment !== '.' && segment !== '..' && !segment.includes('/') && !segment.includes('\\')
}

function normalizePosixPath(filePath: string): string {
  return filePath.replace(/\\/g, '/')
}

function isWithinDir(targetPath: string, baseDir: string): boolean {
  const rel = relative(baseDir, targetPath)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

function pathsMatch(firstPath: string, secondPath: string): boolean {
  const first = resolve(firstPath)
  const second = resolve(secondPath)
  return process.platform === 'win32'
    ? first.toLowerCase() === second.toLowerCase()
    : first === second
}

function findSharedPathRoot(firstPath: string, secondPath: string): string {
  let rootPath = resolve(firstPath)
  while (!isWithinDir(secondPath, rootPath)) {
    const parentPath = dirname(rootPath)
    if (parentPath === rootPath) return parse(secondPath).root
    rootPath = parentPath
  }
  return rootPath
}

async function resolveThroughExistingAncestor(filePath: string): Promise<string | null> {
  let existingPath = resolve(filePath)
  const missingSegments: string[] = []
  while (true) {
    try {
      return resolve(await realpath(existingPath), ...missingSegments)
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') return null
      const parentPath = dirname(existingPath)
      if (parentPath === existingPath) return null
      missingSegments.unshift(basename(existingPath))
      existingPath = parentPath
    }
  }
}

function resolveThroughExistingAncestorSync(filePath: string): string | null {
  let existingPath = resolve(filePath)
  const missingSegments: string[] = []
  while (true) {
    try {
      return resolve(realpathSync(existingPath), ...missingSegments)
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') return null
      const parentPath = dirname(existingPath)
      if (parentPath === existingPath) return null
      missingSegments.unshift(basename(existingPath))
      existingPath = parentPath
    }
  }
}

/**
 * Verifies that neither `targetPath` nor any parent directory beneath the
 * shared root with `baseDir` traverses a symlink (allowing OS-level aliases
 * above `baseDir`, such as `/var -> /private/var` on macOS).
 */
async function isSafeNoSymlinkPath(baseDir: string, targetPath: string): Promise<boolean> {
  const resolvedBase = resolve(baseDir)
  const resolvedTarget = resolve(targetPath)
  const sharedRoot = findSharedPathRoot(resolvedBase, resolvedTarget)
  const [canonicalRoot, canonicalTarget] = await Promise.all([
    resolveThroughExistingAncestor(sharedRoot),
    resolveThroughExistingAncestor(resolvedTarget),
  ])
  if (!canonicalRoot || !canonicalTarget) return false
  const expected = resolve(canonicalRoot, relative(sharedRoot, resolvedTarget))
  if (!pathsMatch(canonicalTarget, expected)) return false

  try {
    const stats = await lstat(resolvedTarget)
    return stats.isFile() && !stats.isSymbolicLink() && stats.nlink === 1 && stats.size <= MAX_SNAPSHOT_FILE_BYTES
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === 'ENOENT'
  }
}

function isSafeNoSymlinkPathSync(baseDir: string, targetPath: string): boolean {
  const resolvedBase = resolve(baseDir)
  const resolvedTarget = resolve(targetPath)
  const sharedRoot = findSharedPathRoot(resolvedBase, resolvedTarget)
  const canonicalRoot = resolveThroughExistingAncestorSync(sharedRoot)
  const canonicalTarget = resolveThroughExistingAncestorSync(resolvedTarget)
  if (!canonicalRoot || !canonicalTarget) return false
  const expected = resolve(canonicalRoot, relative(sharedRoot, resolvedTarget))
  if (!pathsMatch(canonicalTarget, expected)) return false

  try {
    const stats = lstatSync(resolvedTarget)
    return stats.isFile() && !stats.isSymbolicLink() && stats.nlink === 1 && stats.size <= MAX_SNAPSHOT_FILE_BYTES
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === 'ENOENT'
  }
}

function bytesEqual(a: Buffer | null, b: Buffer | null): boolean {
  if (a === null || b === null) return a === b
  return a.equals(b)
}

function decodeStrictUtf8(content: Buffer | null): string | null | undefined {
  if (content === null) return null
  if (content.includes(0)) return undefined
  const text = content.toString('utf8')
  if (!Buffer.from(text, 'utf8').equals(content)) return undefined
  return text
}

function countUtf8DiffStats(before: Buffer | null, after: Buffer | null): { insertions: number; deletions: number } {
  const beforeText = decodeStrictUtf8(before)
  const afterText = decodeStrictUtf8(after)
  if (beforeText === undefined || afterText === undefined) return { insertions: 0, deletions: 0 }
  let insertions = 0
  let deletions = 0
  for (const change of diffLines(beforeText ?? '', afterText ?? '')) {
    if (change.added) insertions += change.count || 0
    if (change.removed) deletions += change.count || 0
  }
  return { insertions, deletions }
}

async function runGitBytes(cwd: string, args: string[], maxBytes = MAX_GIT_STDOUT_BYTES): Promise<GitBytesResult> {
  let proc: Bun.Subprocess<'ignore', 'pipe', 'ignore'>
  try {
    proc = Bun.spawn(['git', ...args], {
      cwd,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'ignore',
      windowsHide: true,
    })
  } catch {
    return { ok: false }
  }

  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    try { proc.kill() } catch { /* ignore */ }
  }, GIT_TIMEOUT_MS)

  try {
    const reader = proc.stdout.getReader()
    const chunks: Uint8Array[] = []
    let total = 0
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) {
        try { proc.kill() } catch { /* ignore */ }
        return { ok: false }
      }
      chunks.push(value)
    }
    const exitCode = await proc.exited
    if (timedOut || exitCode !== 0) return { ok: false }
    return { ok: true, stdout: Buffer.concat(chunks) }
  } catch {
    return { ok: false }
  } finally {
    clearTimeout(timer)
  }
}

async function runGitText(cwd: string, args: string[]): Promise<string | null> {
  const out = await runGitBytes(cwd, args)
  return out.ok ? out.stdout.toString('utf8') : null
}

/**
 * Parses `git status --porcelain=v1 -z --untracked-files=all` into a map of
 * repo-relative POSIX path -> 2-char XY status code.
 * Returns null if the output exceeds the safety cap.
 */
export function parseGitPorcelainZ(raw: Buffer): Map<string, string> | null {
  const paths = new Map<string, string>()
  const text = raw.toString('utf8')
  const entries = text.split('\0')
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!
    if (entry.length < 4) continue
    const x = entry[0]!
    const y = entry[1]!
    const xy = `${x}${y}`
    const filePath = entry.slice(3)
    if (filePath) paths.set(filePath, xy)
    // Rename / copy entries emit a second NUL-terminated path for the original location.
    if (x === 'R' || y === 'R' || x === 'C' || y === 'C') {
      const origPath = entries[++i]
      if (origPath && !paths.has(origPath)) paths.set(origPath, xy)
    }
    if (paths.size > MAX_DIRTY_BASELINE_FILES) return null
  }
  return paths
}

function parseNulSeparatedPaths(raw: Buffer): string[] {
  return raw.toString('utf8').split('\0').filter(Boolean)
}

/**
 * Queries `git ls-tree -z <headSha> -- <paths...>` in chunks to learn the exact
 * git mode (`100644`, `100755`, `120000`, `160000`, etc.) of candidate paths at
 * `headSha`. Paths absent from the returned map did not exist in `headSha`.
 * Returns `null` if git fails/times out so callers treat HEAD state as unknown.
 */
async function readHeadTreeModes(
  repoRoot: string,
  headSha: string,
  repoRelPaths: string[],
): Promise<Map<string, string> | null> {
  const modes = new Map<string, string>()
  for (let offset = 0; offset < repoRelPaths.length; offset += LS_TREE_CHUNK_SIZE) {
    const chunk = repoRelPaths.slice(offset, offset + LS_TREE_CHUNK_SIZE)
    const res = await runGitBytes(repoRoot, ['ls-tree', '-z', headSha, '--', ...chunk])
    if (!res.ok) return null
    for (const record of res.stdout.toString('utf8').split('\0')) {
      if (!record) continue
      const tab = record.indexOf('\t')
      if (tab <= 0) continue
      const header = record.slice(0, tab)
      const filePath = record.slice(tab + 1)
      const space = header.indexOf(' ')
      if (space <= 0 || !filePath) continue
      modes.set(filePath, header.slice(0, space))
    }
  }
  return modes
}

/**
 * Safely reads a regular file (no symlinks along path or leaf, no hardlinks, bounded size).
 * Returns `null` if ENOENT, `undefined` if unsafe/directory/oversized/unreadable.
 */
async function readSafeFileBytes(baseDir: string, filePath: string): Promise<Buffer | null | undefined> {
  if (!(await isSafeNoSymlinkPath(baseDir, filePath))) return undefined

  let pathStats: Stats
  try {
    pathStats = await lstat(filePath)
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === 'ENOENT' ? null : undefined
  }
  if (pathStats.isSymbolicLink() || !pathStats.isFile() || pathStats.nlink !== 1) return undefined
  if (pathStats.size > MAX_SNAPSHOT_FILE_BYTES) return undefined

  let handle: FileHandle | undefined
  try {
    handle = await open(
      filePath,
      process.platform === 'win32' ? fsConstants.O_RDONLY : fsConstants.O_RDONLY | O_NOFOLLOW,
    )
    const stats = await handle.stat()
    if (!stats.isFile() || stats.nlink !== 1 || stats.size > MAX_SNAPSHOT_FILE_BYTES) return undefined
    if (stats.dev !== pathStats.dev || stats.ino !== pathStats.ino) return undefined
    return await handle.readFile()
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === 'ENOENT' ? null : undefined
  } finally {
    await handle?.close().catch(() => {})
  }
}

/**
 * Synchronous counterpart for capturing pre-edit bytes when a pending tool
 * notification arrives, closing any async race before the CLI writes to disk.
 */
function readSafeFileBytesSync(baseDir: string, filePath: string): Buffer | null | undefined {
  if (!isSafeNoSymlinkPathSync(baseDir, filePath)) return undefined

  let pathStats: Stats
  try {
    pathStats = lstatSync(filePath)
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === 'ENOENT' ? null : undefined
  }
  if (pathStats.isSymbolicLink() || !pathStats.isFile() || pathStats.nlink !== 1) return undefined
  if (pathStats.size > MAX_SNAPSHOT_FILE_BYTES) return undefined

  let fd: number | undefined
  try {
    fd = openSync(
      filePath,
      process.platform === 'win32' ? fsConstants.O_RDONLY : fsConstants.O_RDONLY | O_NOFOLLOW,
    )
    const stats = fstatSync(fd)
    if (!stats.isFile() || stats.nlink !== 1 || stats.size > MAX_SNAPSHOT_FILE_BYTES) return undefined
    if (stats.dev !== pathStats.dev || stats.ino !== pathStats.ino) return undefined
    return readFileSync(fd)
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === 'ENOENT' ? null : undefined
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd) } catch { /* ignore */ }
    }
  }
}

async function ensureSafeSessionBackupDir(sessionId: string): Promise<void> {
  if (!isSafePathSegment(sessionId)) {
    throw new Error(`Unsafe sessionId for Antigravity file snapshot: ${sessionId}`)
  }
  const configDir = getClaudeConfigHomeDir()
  await mkdir(configDir, { recursive: true })
  let current = configDir
  for (const segment of ['file-history', sessionId]) {
    current = join(current, segment)
    try {
      await mkdir(current)
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'EEXIST') throw error
    }
    const stats = await lstat(current)
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new Error(`Unsafe backup directory: ${current}`)
    }
  }
}

async function writeBackupBuffer(
  sessionId: string,
  trackingPath: string,
  version: number,
  suffix: string,
  content: Buffer | null,
  backupTime: Date,
): Promise<FileHistoryBackup> {
  if (content === null) {
    return { backupFileName: null, version, backupTime }
  }
  const hash = createHash('sha256').update(trackingPath).digest('hex').slice(0, 16)
  const backupFileName = `${hash}@v${version}-${suffix}`
  const backupPath = resolveBackupPath(backupFileName, sessionId)
  const tempPath = `${backupPath}.${randomUUID()}.tmp`

  let handle: FileHandle | undefined
  try {
    handle = await open(
      tempPath,
      fsConstants.O_WRONLY |
        fsConstants.O_CREAT |
        fsConstants.O_EXCL |
        (process.platform === 'win32' ? 0 : O_NOFOLLOW),
      0o600,
    )
    await handle.writeFile(content)
    await handle.sync()
    await handle.close()
    handle = undefined
    await rename(tempPath, backupPath)
  } catch (error) {
    await handle?.close().catch(() => {})
    await unlink(tempPath).catch(() => {})
    throw error
  }

  return { backupFileName, version, backupTime }
}

async function runBounded<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  if (items.length === 0) return
  let cursor = 0
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++
      await worker(items[index]!)
    }
  })
  await Promise.all(runners)
}

/**
 * Captures per-turn file diffs for an Antigravity ACP session and emits
 * standard `file-history-snapshot` v2 entries (before + completed after backups)
 * so cc-haha's turn-checkpoints & review diff views show exact per-turn changes.
 *
 * All turn transitions (`beginTurn`, `transitionTurn`, `completeTurn`) execute
 * strictly sequentially on `opChain` so rapid `steer()` calls can never race or
 * misattribute turns. Strictly best-effort: never fails or blocks a turn.
 */
export class AntigravityTurnFileTracker {
  private turnSeq = 0
  private activeTurn?: CapturedTurn
  /** Latest queued turn target so synchronous tool notifications are never dropped mid-transition. */
  private pendingTurnForTools?: CapturedTurn
  private opChain: Promise<void> = Promise.resolve()
  private canonicalWorkDirPromise?: Promise<string>

  constructor(
    private readonly sessionId: string,
    private readonly workDir: string,
  ) {}

  private getCanonicalWorkDir(): Promise<string> {
    if (!this.canonicalWorkDirPromise) {
      this.canonicalWorkDirPromise = realpath(this.workDir).catch(() => resolve(this.workDir))
    }
    return this.canonicalWorkDirPromise
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.opChain.catch(() => undefined).then(fn)
    this.opChain = next.then(() => undefined, () => undefined)
    return next
  }

  private createTurn(userMessageId: string): CapturedTurn {
    return {
      userMessageId,
      turnSeq: ++this.turnSeq,
      gitBaseline: null,
      pendingToolBefore: new Map(),
      completedToolPaths: new Set(),
    }
  }

  private async captureGitBaseline(): Promise<GitBaseline | null> {
    const rawRoot = await runGitText(this.workDir, ['rev-parse', '--show-toplevel'])
    const trimmedRoot = rawRoot?.trim()
    if (!trimmedRoot) return null
    const repoRoot = await realpath(trimmedRoot).catch(() => resolve(trimmedRoot))
    const canonicalWorkDir = await this.getCanonicalWorkDir()
    const relWorkDir = isWithinDir(canonicalWorkDir, repoRoot)
      ? normalizePosixPath(relative(repoRoot, canonicalWorkDir))
      : ''
    const statusArgs = ['status', '--porcelain=v1', '-z', '--untracked-files=all']
    if (relWorkDir) statusArgs.push('--', relWorkDir)

    const [rawHead, rawStatusRes] = await Promise.all([
      runGitText(repoRoot, ['rev-parse', '--verify', 'HEAD']),
      runGitBytes(repoRoot, statusArgs),
    ])
    if (!rawStatusRes.ok) return null
    const dirtyPaths = parseGitPorcelainZ(rawStatusRes.stdout)
    if (!dirtyPaths) return null

    const headSha = rawHead?.trim() || null
    const dirtyBefore = new Map<string, Buffer | null | undefined>()
    let totalBytes = 0

    for (const repoRelPath of dirtyPaths.keys()) {
      const absPath = resolve(repoRoot, repoRelPath)
      const bytes = await readSafeFileBytes(repoRoot, absPath)
      if (bytes instanceof Buffer) {
        if (totalBytes + bytes.byteLength > MAX_TOTAL_BASELINE_BYTES) {
          dirtyBefore.set(repoRelPath, undefined)
          continue
        }
        totalBytes += bytes.byteLength
      }
      dirtyBefore.set(repoRelPath, bytes)
    }

    return { repoRoot, statusPathspec: relWorkDir, headSha, dirtyBefore }
  }

  /**
   * Starts tracking a new user turn. Awaits the git baseline before the ACP
   * prompt is sent so pre-turn file contents are captured with zero race window.
   */
  beginTurn(userMessageId: string): Promise<void> {
    const nextTurn = this.createTurn(userMessageId)
    this.pendingTurnForTools = nextTurn
    return this.enqueue(async () => {
      this.activeTurn = nextTurn
      nextTurn.gitBaseline = await this.captureGitBaseline().catch(() => null)
    })
  }

  /**
   * Atomically finalizes the active turn (invoking `onPreviousSnapshot` if a
   * snapshot was produced) and immediately begins tracking `nextUserMessageId`.
   * Serialized on `opChain` so rapid consecutive `steer()` calls preserve exact
   * FIFO turn ownership.
   */
  transitionTurn(
    nextUserMessageId: string,
    onPreviousSnapshot: (snapshot: AntigravityTurnSnapshotResult) => Promise<void>,
  ): Promise<void> {
    const nextTurn = this.createTurn(nextUserMessageId)
    this.pendingTurnForTools = nextTurn
    return this.enqueue(async () => {
      const previous = this.activeTurn
      this.activeTurn = undefined
      if (previous) {
        const snapshot = await this.finalizeTurn(previous)
        if (snapshot) {
          try {
            await onPreviousSnapshot(snapshot)
          } catch {
            // Best-effort snapshot persistence must never prevent the steered turn.
          }
        }
      }
      this.activeTurn = nextTurn
      nextTurn.gitBaseline = await this.captureGitBaseline().catch(() => null)
    })
  }

  /**
   * Records pre-edit disk bytes for a file path when a tool is pending
   * (e.g. awaiting permission) so non-Git and outside-repo files still get
   * exact before/after diffs.
   */
  recordPendingToolPath(filePath: string | undefined): void {
    const turn = this.pendingTurnForTools ?? this.activeTurn
    if (!turn || !filePath?.trim()) return
    const absPath = isAbsolute(filePath) ? resolve(filePath) : resolve(this.workDir, filePath)
    if (turn.pendingToolBefore.has(absPath)) return
    turn.pendingToolBefore.set(absPath, readSafeFileBytesSync(this.workDir, absPath))
  }

  /**
   * Records a file path modified by a completed structured edit/write tool.
   */
  recordCompletedToolPath(filePath: string | undefined): void {
    const turn = this.pendingTurnForTools ?? this.activeTurn
    if (!turn || !filePath?.trim()) return
    const absPath = isAbsolute(filePath) ? resolve(filePath) : resolve(this.workDir, filePath)
    turn.completedToolPaths.add(absPath)
  }

  /**
   * Completes tracking for the active turn, computes changed files, writes
   * backup pairs into `<CLAUDE_CONFIG_DIR>/file-history/<sessionId>/`, and
   * returns a `file-history-snapshot` v2 entry when at least one file changed
   * (or when a structured edit reverted to a net no-op and must suppress
   * stale transcript fallback).
   */
  completeTurn(): Promise<AntigravityTurnSnapshotResult | null> {
    return this.enqueue(async () => {
      const turn = this.activeTurn
      this.activeTurn = undefined
      if (this.pendingTurnForTools === turn) {
        this.pendingTurnForTools = undefined
      }
      if (!turn) return null
      return this.finalizeTurn(turn)
    })
  }

  private async finalizeTurn(turn: CapturedTurn): Promise<AntigravityTurnSnapshotResult | null> {
    try {
      const canonicalWorkDir = await this.getCanonicalWorkDir()
      const resolvedWorkDir = resolve(this.workDir)
      const baseline = turn.gitBaseline
      const changes = new Map<string, { trackingPath: string; before: Buffer | null; after: Buffer | null }>()
      const unchangedToolEntries = new Map<string, { trackingPath: string; content: Buffer | null }>()

      const toIdentityWithoutDereferencingLeaf = (rawAbsPath: string): string => {
        const resolved = resolve(rawAbsPath)
        if (isWithinDir(resolved, resolvedWorkDir)) {
          return resolve(canonicalWorkDir, relative(resolvedWorkDir, resolved))
        }
        return resolved
      }

      const completedIdentities = new Set<string>()
      for (const toolPath of turn.completedToolPaths) {
        completedIdentities.add(toIdentityWithoutDereferencingLeaf(toolPath))
      }

      const toTrackingPath = (identityAbsPath: string): string => {
        if (isWithinDir(identityAbsPath, canonicalWorkDir)) {
          return normalizePosixPath(relative(canonicalWorkDir, identityAbsPath))
        }
        return identityAbsPath
      }

      // 1. Git-backed turn diff (covers edit_file, write_file, run_command, subagents, swarm).
      if (baseline) {
        const statusArgs = ['status', '--porcelain=v1', '-z', '--untracked-files=all']
        if (baseline.statusPathspec) statusArgs.push('--', baseline.statusPathspec)

        const [postHeadRaw, postStatusRes] = await Promise.all([
          runGitText(baseline.repoRoot, ['rev-parse', '--verify', 'HEAD']),
          runGitBytes(baseline.repoRoot, statusArgs),
        ])
        const postHead = postHeadRaw?.trim() || null
        const postDirty = postStatusRes.ok ? parseGitPorcelainZ(postStatusRes.stdout) : null

        if (postDirty) {
          const candidates = new Set<string>([...baseline.dirtyBefore.keys(), ...postDirty.keys()])
          if (postHead && postHead !== baseline.headSha) {
            const committedArgs = baseline.headSha
              ? ['diff', '--name-only', '-z', baseline.headSha, postHead]
              : ['ls-tree', '-r', '--name-only', '-z', postHead]
            if (baseline.statusPathspec) committedArgs.push('--', baseline.statusPathspec)
            const committedRes = await runGitBytes(baseline.repoRoot, committedArgs)
            if (committedRes.ok) {
              for (const committedPath of parseNulSeparatedPaths(committedRes.stdout)) {
                candidates.add(committedPath)
                if (candidates.size > MAX_DIRTY_BASELINE_FILES * 2) break
              }
            }
          }

          // Also check structured edit/write paths inside the repo that returned to
          // clean HEAD (no-op edit within the same turn) so we can suppress transcript fallback.
          for (const completedId of completedIdentities) {
            if (!isWithinDir(completedId, baseline.repoRoot)) continue
            const rel = normalizePosixPath(relative(baseline.repoRoot, completedId))
            if (rel && !rel.startsWith('..')) candidates.add(rel)
          }

          const headUnchanged = postHead === baseline.headSha
          const pathsNeedingHeadLookup: string[] = []
          for (const repoRelPath of candidates) {
            if (baseline.dirtyBefore.has(repoRelPath)) continue
            if (!baseline.headSha) continue
            // Newly untracked files when HEAD didn't change are provably absent from HEAD (0 git spawns).
            if (headUnchanged && postDirty.get(repoRelPath) === '??') continue
            pathsNeedingHeadLookup.push(repoRelPath)
          }

          const headModes = baseline.headSha && pathsNeedingHeadLookup.length > 0
            ? await readHeadTreeModes(baseline.repoRoot, baseline.headSha, pathsNeedingHeadLookup)
            : new Map<string, string>()

          // Pre-fetch worktree-filtered HEAD contents (respects core.autocrlf / .gitattributes)
          // only for regular tracked blobs (100644/100755) with bounded concurrency.
          const headBlobs = new Map<string, Buffer | undefined>()
          if (baseline.headSha && headModes) {
            const regularHeadPaths = pathsNeedingHeadLookup.filter((repoRelPath) => {
              const mode = headModes.get(repoRelPath)
              return mode === '100644' || mode === '100755'
            })
            await runBounded(regularHeadPaths, CAT_FILE_CONCURRENCY, async (repoRelPath) => {
              const res = await runGitBytes(
                baseline.repoRoot,
                ['cat-file', '--filters', `${baseline.headSha}:${repoRelPath}`],
                MAX_SNAPSHOT_FILE_BYTES,
              )
              headBlobs.set(repoRelPath, res.ok ? res.stdout : undefined)
            })
          }

          for (const repoRelPath of candidates) {
            if (changes.size >= MAX_CHANGED_FILES_PER_TURN) break
            const canonicalAbsPath = resolve(baseline.repoRoot, repoRelPath)
            const inWorkDir = isWithinDir(canonicalAbsPath, canonicalWorkDir)
            if (!inWorkDir && !completedIdentities.has(canonicalAbsPath)) continue

            let beforeBytes: Buffer | null | undefined
            if (baseline.dirtyBefore.has(repoRelPath)) {
              beforeBytes = baseline.dirtyBefore.get(repoRelPath)
            } else if (!baseline.headSha) {
              beforeBytes = null
            } else if (headUnchanged && postDirty.get(repoRelPath) === '??') {
              beforeBytes = null
            } else if (!headModes) {
              // `git ls-tree` failed/timed out -> HEAD state unknown, skip rather than misreporting creation.
              beforeBytes = undefined
            } else if (!headModes.has(repoRelPath)) {
              beforeBytes = null
            } else {
              const mode = headModes.get(repoRelPath)
              if (mode !== '100644' && mode !== '100755') {
                // Symlink (120000) or submodule (160000) in HEAD: skip safely.
                beforeBytes = undefined
              } else {
                beforeBytes = headBlobs.get(repoRelPath)
              }
            }
            if (beforeBytes === undefined) continue

            const afterBytes = await readSafeFileBytes(baseline.repoRoot, canonicalAbsPath)
            if (afterBytes === undefined) continue
            // Frozen turn review enforces strict UTF-8 on every recorded backup; skip
            // non-UTF-8 binary files so screenshots/artifacts never poison the whole turn.
            if (decodeStrictUtf8(beforeBytes) === undefined || decodeStrictUtf8(afterBytes) === undefined) continue

            if (bytesEqual(beforeBytes, afterBytes)) {
              if (completedIdentities.has(canonicalAbsPath)) {
                unchangedToolEntries.set(canonicalAbsPath, {
                  trackingPath: toTrackingPath(canonicalAbsPath),
                  content: beforeBytes,
                })
              }
              continue
            }

            changes.set(canonicalAbsPath, {
              trackingPath: toTrackingPath(canonicalAbsPath),
              before: beforeBytes,
              after: afterBytes,
            })
          }
        }
      }

      // 2. Non-Git / outside-repo / ignored files captured before pending tool execution.
      // Never dereference symlinks via `realpath()` before checking path safety.
      for (const [rawAbsPath, beforeBytes] of turn.pendingToolBefore) {
        if (changes.size >= MAX_CHANGED_FILES_PER_TURN) break
        const identityAbsPath = toIdentityWithoutDereferencingLeaf(rawAbsPath)
        if (changes.has(identityAbsPath) || unchangedToolEntries.has(identityAbsPath)) continue
        if (beforeBytes === undefined) continue
        const afterBytes = await readSafeFileBytes(this.workDir, rawAbsPath)
        if (afterBytes === undefined) continue
        if (decodeStrictUtf8(beforeBytes) === undefined || decodeStrictUtf8(afterBytes) === undefined) continue

        if (bytesEqual(beforeBytes, afterBytes)) {
          if (completedIdentities.has(identityAbsPath)) {
            unchangedToolEntries.set(identityAbsPath, {
              trackingPath: toTrackingPath(identityAbsPath),
              content: beforeBytes,
            })
          }
          continue
        }

        changes.set(identityAbsPath, {
          trackingPath: toTrackingPath(identityAbsPath),
          before: beforeBytes,
          after: afterBytes,
        })
      }

      if (changes.size === 0 && unchangedToolEntries.size === 0) return null

      await ensureSafeSessionBackupDir(this.sessionId)
      const now = new Date()
      const turnTag = randomUUID().slice(0, 8)
      const trackedFileBackups: Record<string, FileHistoryBackup> = {}
      const completedFileBackups: Record<string, FileHistoryBackup> = {}
      let insertions = 0
      let deletions = 0

      for (const { trackingPath, before, after } of changes.values()) {
        const beforeBackup = await writeBackupBuffer(
          this.sessionId,
          trackingPath,
          turn.turnSeq,
          `agy-before-${turnTag}`,
          before,
          now,
        )
        const afterBackup = await writeBackupBuffer(
          this.sessionId,
          trackingPath,
          turn.turnSeq,
          `agy-after-${turnTag}`,
          after,
          now,
        )
        trackedFileBackups[trackingPath] = beforeBackup
        completedFileBackups[trackingPath] = afterBackup
        const stats = countUtf8DiffStats(before, after)
        insertions += stats.insertions
        deletions += stats.deletions
      }

      for (const { trackingPath, content } of unchangedToolEntries.values()) {
        if (trackingPath in trackedFileBackups) continue
        const sharedBackup = await writeBackupBuffer(
          this.sessionId,
          trackingPath,
          turn.turnSeq,
          `agy-same-${turnTag}`,
          content,
          now,
        )
        trackedFileBackups[trackingPath] = sharedBackup
        completedFileBackups[trackingPath] = sharedBackup
      }

      const timestamp = now.toISOString()
      const snapshotEntry: Record<string, unknown> = {
        type: 'file-history-snapshot',
        messageId: turn.userMessageId,
        isSnapshotUpdate: false,
        snapshot: {
          schemaVersion: 2,
          messageId: turn.userMessageId,
          trackedFileBackups,
          completedFileBackups,
          timestamp,
        },
      }

      return {
        snapshotEntry,
        filesChanged: changes.size,
        insertions,
        deletions,
      }
    } catch {
      return null
    }
  }
}
