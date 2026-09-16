/**
 * Git review domain (workspace M4).
 *
 * `workspaceService` mixes live Git state with session file history and always
 * compares against `HEAD`; that is the right behaviour for the chat "changed
 * files" card, and it must keep working. A review surface needs the opposite:
 * every comparison names both of its sides explicitly, so "staged" and
 * "unstaged" are different questions rather than two labels on one `HEAD` diff.
 *
 * This service therefore owns its own read model (status + per-file diff) and
 * the real write operations (stage / unstage / hunk staging / revert). Every
 * write carries the `snapshot` token the user was looking at and is re-checked
 * against live Git before anything is applied, so a hunk can never land on a
 * file that changed after it was read.
 */

import * as fs from 'node:fs/promises'
import { execFile as execFileCallback } from 'node:child_process'
import { createHash } from 'node:crypto'
import * as os from 'node:os'
import * as path from 'node:path'
import { promisify } from 'node:util'
import { getCcHahaDir } from '../../utils/envUtils.js'
import { parseStatus, type WorkspaceFileStatus } from './workspaceService.js'
import {
  isSameOrInsidePathForPlatform,
  normalizeDriveRootPathForPlatform,
} from './windowsDrivePath.js'

const execFile = promisify(execFileCallback)

const GIT_TIMEOUT_MS = 10_000
const MAX_GIT_BUFFER_BYTES = 8_000_000
/** Read a whole untracked file into memory only below this size. */
const MAX_UNTRACKED_STAT_BYTES = 256 * 1024
/**
 * Above this, an untracked file is not line-counted at all. Between the two
 * limits the count is exact but streamed in fixed-size chunks, so a 24 MB log
 * reports its real line count instead of the `+0 -0` a plain size check used
 * to produce.
 */
const MAX_UNTRACKED_SCAN_BYTES = 32 * 1024 * 1024
/** Chunk used by the streaming line count; bounds peak memory, not file size. */
const UNTRACKED_SCAN_CHUNK_BYTES = 256 * 1024
/**
 * Largest untracked file turned into a synthesized "new file" diff. The diff
 * string is JSON-serialized into one HTTP response and then held per file in
 * the renderer, so an uncapped read of a multi-megabyte log is charged twice.
 */
const MAX_UNTRACKED_DIFF_BYTES = 1024 * 1024
/** SHA-1 empty tree. Only a fallback: the real oid is read from git so that
 * SHA-256 repositories resolve their own empty tree instead of this one. */
const FALLBACK_EMPTY_TREE_SHA = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'
const VCS_METADATA_DIRECTORY_NAMES = new Set(['.git', '.svn', '.hg', '.bzr', '.jj', '.sl'])
/** `-z` record separator used by every git porcelain/diff parser below. */
const NUL = '\u0000'

/**
 * Environment variables that re-point git at a different repository, index or
 * object store. Inheriting them means the review of one session silently reads
 * and *writes* another repository — `GIT_INDEX_FILE` in particular would make
 * `git add` stage into a file the user never named.
 */
const GIT_RETARGETING_ENV_VARS = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_COMMON_DIR',
  'GIT_NAMESPACE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_PREFIX',
  'GIT_CEILING_DIRECTORIES',
] as const

const NO_HEAD_MESSAGE =
  'Repository has no commits yet, so there is no HEAD to compare against'

/**
 * `missing_workdir` used to carry no message at all, so the panel fell through
 * to its "no changes" empty state and showed a green check for a worktree that
 * had been deleted.
 */
const MISSING_WORKDIR_MESSAGE =
  'The session working directory no longer exists, so there is nothing to compare'

const TURN_SOURCE_REJECTION =
  'Review source "turn" is served by the session turn history, not the Git review service'

/**
 * Reason this source cannot be written to, or `null` when it can.
 *
 * Read-only-ness used to be enforced only by the renderer hiding its buttons,
 * so `POST /review/revert` with `{kind:'commit'}` ran a real working-tree
 * write against a comparison whose left-hand side is history. The write would
 * have discarded current work while claiming to act on a commit.
 */
function rejectUnwritableSource(source: ReviewSource | undefined): string | null {
  if (!source) return null
  switch (source.kind) {
    case 'turn':
      return TURN_SOURCE_REJECTION
    case 'branch':
    case 'commit':
      return `Review source "${source.kind}" is a read-only comparison; stage, unstage and revert only apply to the index and the working tree`
    default:
      return null
  }
}

// ---------------------------------------------------------------------------
// Wire types
// ---------------------------------------------------------------------------

export type ReviewSource =
  | { kind: 'unstaged' }
  | { kind: 'staged' }
  | { kind: 'uncommitted' }
  | { kind: 'branch'; baseRef: string }
  | { kind: 'commit'; commit: string }
  | { kind: 'turn'; turnKey: string }

export type ResolvedReviewSource = ReviewSource & {
  /**
   * The left-hand side the comparison actually ran against: the merge-base for
   * `branch`, the parent (or empty tree) for `commit`, the `HEAD` sha for the
   * `HEAD`-based working-tree sources. Absent for `unstaged`, whose left-hand
   * side is the index rather than a revision.
   */
  resolvedBase?: string
}

export type ReviewFileStatus = WorkspaceFileStatus | 'conflicted'

export type ReviewFile = {
  path: string
  oldPath?: string
  status: ReviewFileStatus
  additions: number
  deletions: number
  binary: boolean
  /** The file has content in the index that differs from `HEAD`. */
  staged: boolean
  /** The file has content in the working tree that differs from the index. */
  unstaged: boolean
  /** Unmerged path: only whole-file operations are offered. */
  conflicted: boolean
  /**
   * Set when the file was too large to measure: `additions`/`deletions` are
   * then "not counted", not "zero". Without this a 24 MB untracked log was
   * indistinguishable from an empty new file.
   */
  statsTruncated?: boolean
}

export type ReviewTotals = {
  additions: number
  deletions: number
  files: number
}

export type ReviewState =
  | 'ok'
  | 'not_git_repo'
  | 'missing_workdir'
  | 'no_head'
  | 'error'

export type ReviewStatusResult = {
  state: ReviewState
  source: ResolvedReviewSource
  /** Opaque version token; changes whenever the underlying Git state changes. */
  snapshot: string
  files: ReviewFile[]
  /** Untracked paths inside `files`, listed separately so bulk actions can skip them. */
  untracked: string[]
  totals: ReviewTotals
  error?: string
}

export type ReviewDiffResult = {
  state: ReviewState | 'missing'
  source: ResolvedReviewSource
  snapshot: string
  path: string
  oldPath?: string
  diff?: string
  binary?: boolean
  /**
   * The file is larger than the review diff cap, so `diff` carries the header
   * only and deliberately contains no hunk — a partial `@@` block would be an
   * appliable patch that silently truncates the file it is applied to.
   */
  truncated?: boolean
  /** Size of the untracked file that was too large to render, in bytes. */
  bytes?: number
  error?: string
}

/** What a write actually did to one path. */
export type ReviewPathAction = 'staged' | 'unstaged' | 'reverted' | 'deleted' | 'noop'

export type ReviewPathResult = {
  path: string
  ok: boolean
  /**
   * `deleted` means the file was removed from disk because Git had never
   * stored it — the only revert outcome that is not recoverable from Git.
   */
  action?: ReviewPathAction
  error?: string
}

export type ReviewWriteState = ReviewState | 'stale' | 'partial'

export type ReviewWriteResult = {
  state: ReviewWriteState
  /** Snapshot as of *after* the write (or the live one that rejected a stale write). */
  snapshot: string
  results: ReviewPathResult[]
  /** Refreshed status for the requested source, when the caller named one. */
  status?: ReviewStatusResult
  /** Directory holding recoverable copies of everything `revert` destroyed. */
  backupDir?: string
  /** Paths whose tracked content was restored from Git. Still in the worktree. */
  revertedPaths?: string[]
  /**
   * Paths that were **deleted from disk**. Git has no copy of these; only
   * `backupDir` does. The caller must name them to the user rather than
   * describing the operation as "discard changes".
   */
  deletedPaths?: string[]
  error?: string
}

export type ReviewPathsRequest = {
  paths: string[]
  snapshot: string
  /** When set, the result carries a freshly recomputed status for this source. */
  source?: ReviewSource
}

export type ReviewHunkRequest = {
  /** Unified diff covering exactly ONE file. */
  patch: string
  snapshot: string
  source?: ReviewSource
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

type GitCommandResult = {
  stdout: string
  stderr: string
  code: number
  /**
   * The process never produced an exit status — git is missing, could not be
   * spawned, or was killed on timeout. Distinct from "git ran and refused",
   * which is what repository detection is allowed to interpret.
   */
  failedToRun?: boolean
}

type ReviewContext = {
  sessionId: string
  workDir: string
  workspaceRoot: string
  canonicalWorkspaceRoot: string
  repoRoot: string
  /** Workspace root expressed relative to the repo root, posix, '' at the root. */
  workDirFromRepo: string
}

type PrepareResult =
  | { kind: 'ok'; ctx: ReviewContext }
  | { kind: 'failed'; state: 'not_git_repo' | 'missing_workdir' | 'error'; error?: string }

type StatusEntry = {
  /** Path relative to the repo root. */
  repoPath: string
  repoOldPath?: string
  /** Path relative to the session workspace root. */
  path: string
  oldPath?: string
  code: string
  untracked: boolean
  conflicted: boolean
  stagedChange: boolean
  unstagedChange: boolean
  absolutePath: string
}

type NumstatEntry = {
  additions: number
  deletions: number
  binary: boolean
  repoPath: string
  repoOldPath?: string
}

type ResolvedSource = {
  source: ResolvedReviewSource
  /** Revisions/options spliced into `git diff <revArgs> <opts> -- <paths>`. */
  revArgs: string[]
  /** Whether untracked files belong to this comparison. */
  includeUntracked: boolean
  /** Whether the working-tree status informs staged/unstaged flags. */
  useWorkingTreeStatus: boolean
}

type SourceResolution =
  | { kind: 'ok'; resolved: ResolvedSource }
  | { kind: 'no_head'; source: ResolvedReviewSource; error: string }
  | { kind: 'error'; source: ResolvedReviewSource; error: string }

type ResolvedTarget = {
  requestedPath: string
  /** Path relative to the session workspace root, posix separators. */
  relativePath: string
  absolutePath: string
  canonicalPath: string
  /** Path relative to the repo root — what git pathspecs and patches use. */
  repoPath: string
}

type ReviewStatResult =
  | { kind: 'ok'; stat: Awaited<ReturnType<typeof fs.stat>> }
  | { kind: 'missing' }
  | { kind: 'error'; message: string }

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function toPosixPath(value: string): string {
  if (!value || value === '.') return ''
  return value.split(path.sep).join('/')
}

function statusFromLetter(letter: string): ReviewFileStatus {
  switch (letter) {
    case 'M':
      return 'modified'
    case 'A':
      return 'added'
    case 'D':
      return 'deleted'
    case 'R':
      return 'renamed'
    case 'C':
      return 'copied'
    case 'T':
      return 'type_changed'
    case 'U':
      return 'conflicted'
    case '?':
      return 'untracked'
    default:
      return 'unknown'
  }
}

function isConflictCode(code: string): boolean {
  const x = code[0] ?? ' '
  const y = code[1] ?? ' '
  // Porcelain v1 unmerged codes: DD AU UD UA DU AA UU.
  return x === 'U' || y === 'U' || code === 'AA' || code === 'DD'
}

function parseNumstat(stdout: string): NumstatEntry[] {
  const parts = stdout.split(NUL)
  const entries: NumstatEntry[] = []

  for (let i = 0; i < parts.length; i++) {
    const record = parts[i]
    if (!record) continue

    const fields = record.split('\t')
    if (fields.length < 3) continue

    const additions = fields[0] === '-' ? 0 : parseInt(fields[0] || '0', 10) || 0
    const deletions = fields[1] === '-' ? 0 : parseInt(fields[1] || '0', 10) || 0
    const binary = fields[0] === '-' && fields[1] === '-'
    const inlinePath = fields.slice(2).join('\t')

    if (inlinePath === '') {
      // Rename/copy in -z mode: the path field is empty and the old and new
      // paths follow as their own NUL-terminated records.
      const repoOldPath = toPosixPath(parts[i + 1] ?? '')
      const repoPath = toPosixPath(parts[i + 2] ?? '')
      i += 2
      if (!repoPath) continue
      entries.push({ additions, deletions, binary, repoPath, repoOldPath })
      continue
    }

    entries.push({ additions, deletions, binary, repoPath: toPosixPath(inlinePath) })
  }

  return entries
}

function parseNameStatus(stdout: string): Map<string, { letter: string; repoOldPath?: string }> {
  const parts = stdout.split(NUL)
  const byPath = new Map<string, { letter: string; repoOldPath?: string }>()

  for (let i = 0; i < parts.length; i++) {
    const code = parts[i]
    if (!code) continue

    const letter = code[0] ?? ''
    if (letter === 'R' || letter === 'C') {
      const repoOldPath = toPosixPath(parts[i + 1] ?? '')
      const repoPath = toPosixPath(parts[i + 2] ?? '')
      i += 2
      if (!repoPath) continue
      byPath.set(repoPath, { letter, repoOldPath })
      continue
    }

    const repoPath = toPosixPath(parts[i + 1] ?? '')
    i += 1
    if (!repoPath) continue
    byPath.set(repoPath, { letter })
  }

  return byPath
}

/**
 * Paths a unified diff touches, as they appear in the patch (repo-relative,
 * because the patch text comes from this service's own `git diff` output).
 * Used to reject multi-file and out-of-workspace patches before `git apply`.
 */
export function collectPatchPaths(patch: string): string[] {
  const paths = new Set<string>()

  for (const rawLine of patch.split(/\r?\n/)) {
    if (rawLine.startsWith('--- ') || rawLine.startsWith('+++ ')) {
      const target = rawLine.slice(4).split('\t')[0] ?? ''
      if (!target || target === '/dev/null') continue
      paths.add(stripPatchPrefix(target))
      continue
    }
    if (rawLine.startsWith('diff --git ')) {
      // `diff --git a/x b/x` — quoted paths with spaces are handled by the
      // ---/+++ lines above, so only take the unambiguous unquoted form.
      const rest = rawLine.slice('diff --git '.length)
      const halves = rest.match(/"(?:\\.|[^"\\])*"|[^ ]+/g) ?? []
      if (halves.length !== 2) continue
      for (const half of halves) {
        const stripped = stripPatchPrefix(half)
        if (stripped) paths.add(stripped)
      }
    }
  }

  return [...paths]
}

function stripPatchPrefix(value: string): string {
  let target = value
  if (target.startsWith('"') && target.endsWith('"') && target.length > 1) {
    const escapes: Record<string, string> = { a: '\x07', b: '\b', t: '\t', n: '\n', v: '\v', f: '\f', r: '\r', '\\': '\\', '"': '"' }
    const bytes: Buffer[] = []
    let offset = 1
    const escaped = /\\([0-7]{1,3}|[abtnvfr\\"])/g
    for (const match of target.matchAll(escaped)) {
      bytes.push(Buffer.from(target.slice(offset, match.index)))
      bytes.push(/^[0-7]/.test(match[1]!) ? Buffer.from([parseInt(match[1]!, 8)]) : Buffer.from(escapes[match[1]!]!))
      offset = match.index! + match[0].length
    }
    bytes.push(Buffer.from(target.slice(offset, -1)))
    target = Buffer.concat(bytes).toString('utf8')
  }
  // `git diff` writes `a/<path>` and `b/<path>`; `-p1` strips exactly one level.
  const slash = target.indexOf('/')
  if (slash === -1) return target
  return target.slice(slash + 1)
}

function quoteGitPath(value: string): string {
  if (!/[\x00-\x20"\\]/.test(value)) return value
  return JSON.stringify(value).replace(/\\u00([0-9a-f]{2})/g, (_match, hex) => `\\${parseInt(hex, 16).toString(8).padStart(3, '0')}`)
}

function countTextLines(content: string): number {
  if (!content) return 0
  const lines = content.split(/\r\n|\r|\n/)
  if (lines[lines.length - 1] === '') {
    lines.pop()
  }
  return lines.length
}

function sanitizeBackupSegment(value: string): string {
  const sanitized = value.replace(/[^A-Za-z0-9._-]/g, '_')
  return sanitized.length > 0 ? sanitized.slice(0, 120) : 'unknown'
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export type ReviewServiceOptions = {
  /**
   * Where `revert` writes recoverable copies. Defaults to the app's own data
   * directory — never the user's repository (a backup there would show up as
   * an untracked change) and never a bare config root.
   */
  backupRoot?: string
}

/**
 * Wrap a path so Git treats it as a literal filename rather than a pathspec.
 *
 * `--` only stops *option* parsing. Everything after it is still matched with
 * wildmatch, so `[`, `]`, `?`, `*`, `\\` and a leading `:` are magic — and
 * `git restore --worktree -- 'a[1].txt'` will happily discard `a1.txt` instead.
 * That is silent destruction of uncommitted work in any repository holding
 * Next.js/Remix-style `[slug]` route files, and the per-file backup taken
 * beforehand would have captured the wrong file.
 *
 * `:(literal)` disables every magic character for that one pathspec.
 */
function literalPathspec(repoPath: string): string {
  return `:(literal)${repoPath}`
}

export class ReviewService {
  private readonly backupRoot: string | undefined

  constructor(
    private readonly resolveSessionWorkDir: (sessionId: string) => Promise<string | null>,
    options: ReviewServiceOptions = {},
  ) {
    this.backupRoot = options.backupRoot
  }

  // -- reads ----------------------------------------------------------------

  private comparisonSnapshot(workspaceSnapshot: string, source: ResolvedReviewSource): string {
    if (source.kind === 'commit') return createHash('sha256').update(JSON.stringify(source)).digest('hex')
    if (source.kind === 'branch') return createHash('sha256').update(`${workspaceSnapshot}:${source.resolvedBase}`).digest('hex')
    return workspaceSnapshot
  }

  /** An invalidation probe without numstat collection or per-file diff payloads. */
  async getRevision(sessionId: string, source: ReviewSource): Promise<Pick<ReviewStatusResult, 'state' | 'source' | 'snapshot' | 'error'>> {
    if (source.kind === 'turn') return this.rejectTurnSource(source)
    const prepared = await this.prepare(sessionId)
    if (prepared.kind === 'failed') return { state: prepared.state, source, snapshot: '', error: prepared.error }
    const { ctx } = prepared
    const head = await this.resolveHead(ctx)
    const entries = source.kind === 'commit' ? { kind: 'ok' as const, entries: [] } : await this.readStatus(ctx)
    if (entries.kind === 'error') return { state: 'error', source, snapshot: '', error: entries.message }
    const workspaceSnapshot = source.kind === 'commit' ? '' : await this.computeSnapshot(ctx, head, entries.entries)
    const resolution = await this.resolveSource(ctx, source, head)
    if (resolution.kind !== 'ok') return { state: resolution.kind === 'no_head' ? 'no_head' : 'error', source: resolution.source, snapshot: workspaceSnapshot, error: resolution.error }
    return { state: 'ok', source: resolution.resolved.source, snapshot: this.comparisonSnapshot(workspaceSnapshot, resolution.resolved.source) }
  }

  async getStatus(sessionId: string, source: ReviewSource): Promise<ReviewStatusResult> {
    if (source.kind === 'turn') {
      return this.rejectTurnSource(source)
    }

    const prepared = await this.prepare(sessionId)
    if (prepared.kind === 'failed') {
      return {
        state: prepared.state,
        source,
        snapshot: '',
        files: [],
        untracked: [],
        totals: { additions: 0, deletions: 0, files: 0 },
        error: prepared.error,
      }
    }
    const { ctx } = prepared

    const head = await this.resolveHead(ctx)
    const statusEntries = source.kind === 'commit' ? { kind: 'ok' as const, entries: [] } : await this.readStatus(ctx)
    if (statusEntries.kind === 'error') {
      return {
        state: 'error',
        source,
        snapshot: '',
        files: [],
        untracked: [],
        totals: { additions: 0, deletions: 0, files: 0 },
        error: statusEntries.message,
      }
    }
    let snapshot = source.kind === 'commit' ? '' : await this.computeSnapshot(ctx, head, statusEntries.entries)

    const resolution = await this.resolveSource(ctx, source, head)
    if (resolution.kind !== 'ok') {
      return {
        state: resolution.kind === 'no_head' ? 'no_head' : 'error',
        source: resolution.source,
        snapshot,
        files: [],
        untracked: [],
        totals: { additions: 0, deletions: 0, files: 0 },
        error: resolution.error,
      }
    }

    snapshot = this.comparisonSnapshot(snapshot, resolution.resolved.source)

    const collected = await this.collectFiles(ctx, resolution.resolved, statusEntries.entries)
    if (collected.kind === 'error') {
      return {
        state: 'error',
        source: resolution.resolved.source,
        snapshot,
        files: [],
        untracked: [],
        totals: { additions: 0, deletions: 0, files: 0 },
        error: collected.message,
      }
    }

    return {
      state: 'ok',
      source: resolution.resolved.source,
      snapshot,
      files: collected.files,
      untracked: collected.files.filter((file) => file.status === 'untracked').map((file) => file.path),
      totals: {
        additions: collected.files.reduce((sum, file) => sum + file.additions, 0),
        deletions: collected.files.reduce((sum, file) => sum + file.deletions, 0),
        files: collected.files.length,
      },
    }
  }

  async getFileDiff(
    sessionId: string,
    request: { source: ReviewSource; path: string; oldPath?: string },
  ): Promise<ReviewDiffResult> {
    if (request.source.kind === 'turn') {
      const rejected = this.rejectTurnSource(request.source)
      return {
        state: 'error',
        source: rejected.source,
        snapshot: '',
        path: toPosixPath(request.path),
        error: rejected.error,
      }
    }

    const prepared = await this.prepare(sessionId)
    if (prepared.kind === 'failed') {
      return {
        state: prepared.state,
        source: request.source,
        snapshot: '',
        path: toPosixPath(request.path),
        error: prepared.error,
      }
    }
    const { ctx } = prepared

    const historical = request.source.kind === 'commit'
    const target = await this.resolveWorkspacePath(ctx, request.path, historical)
    const oldTarget = request.oldPath ? await this.resolveWorkspacePath(ctx, request.oldPath, historical) : null

    const head = await this.resolveHead(ctx)
    const statusEntries = historical ? { kind: 'ok' as const, entries: [] } : await this.readStatus(ctx)
    if (statusEntries.kind === 'error') {
      return {
        state: 'error',
        source: request.source,
        snapshot: '',
        path: target.relativePath,
        error: statusEntries.message,
      }
    }
    let snapshot = historical ? '' : await this.computeSnapshot(ctx, head, statusEntries.entries)

    const resolution = await this.resolveSource(ctx, request.source, head)
    if (resolution.kind !== 'ok') {
      return {
        state: resolution.kind === 'no_head' ? 'no_head' : 'error',
        source: resolution.source,
        snapshot,
        path: target.relativePath,
        error: resolution.error,
      }
    }
    const resolved = resolution.resolved
    snapshot = this.comparisonSnapshot(snapshot, resolved.source)

    const entry = statusEntries.entries.find((candidate) => candidate.path === target.relativePath)
    if (resolved.useWorkingTreeStatus && entry?.untracked) {
      if (!resolved.includeUntracked) {
        return {
          state: 'missing',
          source: resolved.source,
          snapshot,
          path: target.relativePath,
        }
      }
      const synthetic = await this.buildUntrackedDiff(entry.absolutePath, entry.repoPath)
      if (synthetic.kind === 'error') {
        return {
          state: 'error',
          source: resolved.source,
          snapshot,
          path: target.relativePath,
          error: synthetic.message,
        }
      }
      if (synthetic.kind === 'missing') {
        return { state: 'missing', source: resolved.source, snapshot, path: target.relativePath }
      }
      return {
        state: 'ok',
        source: resolved.source,
        snapshot,
        path: target.relativePath,
        diff: synthetic.diff,
        binary: synthetic.binary,
        ...(synthetic.truncated ? { truncated: true, bytes: synthetic.bytes } : {}),
      }
    }

    const pathspecs = [target.repoPath]
    const knownOldPath = oldTarget?.repoPath ?? (resolved.useWorkingTreeStatus ? entry?.repoOldPath : undefined)
    if (knownOldPath && knownOldPath !== target.repoPath) {
      pathspecs.push(knownOldPath)
    }

    const args = [
      'diff',
      ...resolved.revArgs,
      '--no-ext-diff',
      '--find-renames',
      '--find-copies',
      '--',
      ...pathspecs.map(literalPathspec),
    ]
    const result = await this.runGit(ctx.repoRoot, args)
    if (result.code !== 0) {
      return {
        state: 'error',
        source: resolved.source,
        snapshot,
        path: target.relativePath,
        error: this.formatGitError('Failed to read review diff', args, ctx.repoRoot, result),
      }
    }
    if (!result.stdout.trim()) {
      return { state: 'missing', source: resolved.source, snapshot, path: target.relativePath }
    }

    return {
      state: 'ok',
      source: resolved.source,
      snapshot,
      path: target.relativePath,
      oldPath: knownOldPath ? this.rebaseRepoPath(ctx, knownOldPath) ?? undefined : undefined,
      diff: result.stdout,
      binary: /^(Binary files |GIT binary patch)/m.test(result.stdout),
    }
  }

  // -- writes ---------------------------------------------------------------

  /** Stage working-tree content (including untracked files) into the index. */
  async stage(sessionId: string, request: ReviewPathsRequest): Promise<ReviewWriteResult> {
    if (request.source?.kind === 'staged') return this.writeFailure('error', 'Staged comparison only supports unstaging')
    return this.runPathWrite(sessionId, request, async (ctx, targets) => {
      const results: ReviewPathResult[] = []
      for (const target of targets) {
        const args = ['add', '--', literalPathspec(target.repoPath)]
        const result = await this.runGit(ctx.repoRoot, args)
        results.push(
          result.code === 0
            ? { path: target.relativePath, ok: true, action: 'staged' }
            : {
                path: target.relativePath,
                ok: false,
                action: 'staged',
                error: this.formatGitError('Failed to stage path', args, ctx.repoRoot, result),
              },
        )
      }
      return { results }
    })
  }

  /** Drop index content back to `HEAD` (or to "nothing" in a repo with no commits). */
  async unstage(sessionId: string, request: ReviewPathsRequest): Promise<ReviewWriteResult> {
    if (request.source?.kind === 'unstaged') return this.writeFailure('error', 'Unstaged comparison only supports staging or discarding')
    return this.runPathWrite(sessionId, request, async (ctx, targets, head, entries) => {
      const results: ReviewPathResult[] = []
      for (const target of targets) {
        // A rename is one displayed row but two index entries. Derive its
        // linked path from the validated status, never from a client pathspec.
        const entry = entries.find(candidate => candidate.path === target.relativePath)
        const paths = [literalPathspec(target.repoPath)]
        if (entry?.repoOldPath) {
          const oldPath = this.rebaseRepoPath(ctx, entry.repoOldPath)
          if (oldPath === null) {
            results.push({ path: target.relativePath, ok: false, error: 'Rename crosses workspace boundary' })
            continue
          }
          const oldTarget = await this.resolveWorkspacePath(ctx, oldPath)
          paths.push(literalPathspec(oldTarget.repoPath))
        }
        const restoreArgs = head
          ? ['restore', '--staged', '--', ...paths]
          : ['reset', '-q', '--', ...paths]
        let result = await this.runGit(ctx.repoRoot, restoreArgs)
        let args = restoreArgs

        if (result.code !== 0 && head) {
          // `git restore` is 2.23+; fall back to the older plumbing rather than
          // reporting a failure the user cannot act on.
          args = ['reset', '-q', 'HEAD', '--', ...paths]
          result = await this.runGit(ctx.repoRoot, args)
        }

        results.push(
          result.code === 0
            ? { path: target.relativePath, ok: true, action: 'unstaged' }
            : {
                path: target.relativePath,
                ok: false,
                action: 'unstaged',
                error: this.formatGitError('Failed to unstage path', args, ctx.repoRoot, result),
              },
        )
      }
      return { results }
    })
  }

  /** Apply one unified-diff fragment to the index. */
  async stageHunk(sessionId: string, request: ReviewHunkRequest): Promise<ReviewWriteResult> {
    return this.runHunkWrite(sessionId, request, false)
  }

  /** Reverse-apply one unified-diff fragment out of the index. */
  async unstageHunk(sessionId: string, request: ReviewHunkRequest): Promise<ReviewWriteResult> {
    return this.runHunkWrite(sessionId, request, true)
  }

  /**
   * Discard working-tree changes. Every affected file is copied into a
   * per-session backup directory first, so the content stays recoverable.
   *
   * Untracked files are only removed when the caller names them: a directory
   * pathspec is rejected outright, so a "revert everything" click built from
   * the tracked file list can never sweep away untracked work.
   */
  async revert(sessionId: string, request: ReviewPathsRequest): Promise<ReviewWriteResult> {
    if (request.source?.kind === 'staged') return this.writeFailure('error', 'Staged comparison does not display working-tree changes')
    return this.runPathWrite(sessionId, request, async (ctx, targets, _head, entries) => {
      const results: ReviewPathResult[] = []
      const backupDir = this.buildBackupDir(ctx.sessionId)
      let backupDirCreated = false

      for (const target of targets) {
        const entry = entries.find((candidate) => candidate.path === target.relativePath)
        const stat = await this.safeStat(target.absolutePath)

        if (stat.kind === 'error') {
          results.push({ path: target.relativePath, ok: false, error: stat.message })
          continue
        }
        if (stat.kind === 'ok' && stat.stat.isDirectory()) {
          results.push({
            path: target.relativePath,
            ok: false,
            error: `Revert requires a file path, not a directory: ${target.relativePath}`,
          })
          continue
        }

        if (stat.kind === 'ok') {
          const backup = await this.writeBackup(backupDir, target.relativePath, target.absolutePath)
          if (!backup.ok) {
            results.push({ path: target.relativePath, ok: false, error: backup.error })
            continue
          }
          backupDirCreated = true
        }

        if (entry?.untracked) {
          if (stat.kind === 'missing') {
            results.push({ path: target.relativePath, ok: true, action: 'noop' })
            continue
          }
          try {
            // Permanent removal: Git holds no copy of an untracked file, so
            // the backup written above is the only way back. The result says
            // `deleted` rather than `reverted` precisely so the caller cannot
            // describe this as "discard changes".
            await fs.rm(target.absolutePath, { force: true })
            results.push({ path: target.relativePath, ok: true, action: 'deleted' })
          } catch (error) {
            results.push({
              path: target.relativePath,
              ok: false,
              action: 'deleted',
              error: this.formatFsError('Failed to remove untracked file', target.absolutePath, error),
            })
          }
          continue
        }

        let args = ['restore', '--worktree', '--', literalPathspec(target.repoPath)]
        let result = await this.runGit(ctx.repoRoot, args)
        if (result.code !== 0) {
          args = ['checkout', '--', literalPathspec(target.repoPath)]
          result = await this.runGit(ctx.repoRoot, args)
        }
        results.push(
          result.code === 0
            ? { path: target.relativePath, ok: true, action: 'reverted' }
            : {
                path: target.relativePath,
                ok: false,
                action: 'reverted',
                error: this.formatGitError('Failed to revert path', args, ctx.repoRoot, result),
              },
        )
      }

      return { results, backupDir: backupDirCreated ? backupDir : undefined }
    })
  }

  // -- write orchestration --------------------------------------------------

  private async runPathWrite(
    sessionId: string,
    request: ReviewPathsRequest,
    apply: (
      ctx: ReviewContext,
      targets: ResolvedTarget[],
      head: string | null,
      entries: StatusEntry[],
    ) => Promise<{ results: ReviewPathResult[]; backupDir?: string }>,
  ): Promise<ReviewWriteResult> {
    if (!Array.isArray(request.paths) || request.paths.length === 0) {
      return this.writeFailure('error', 'paths must contain at least one path')
    }
    if (typeof request.snapshot !== 'string' || request.snapshot.length === 0) {
      return this.writeFailure('error', 'snapshot is required for review writes')
    }
    const refusal = rejectUnwritableSource(request.source)
    if (refusal) return this.writeFailure('error', refusal)

    const prepared = await this.prepare(sessionId)
    if (prepared.kind === 'failed') {
      return this.writeFailure(prepared.state, prepared.error)
    }
    const { ctx } = prepared

    // Resolved (and therefore validated) before the snapshot check so that a
    // traversal attempt is rejected outright instead of being masked by a
    // stale-token reply.
    const targets: ResolvedTarget[] = []
    for (const requestedPath of request.paths) {
      targets.push(await this.resolveWorkspacePath(ctx, requestedPath))
    }

    const head = await this.resolveHead(ctx)
    const statusEntries = await this.readStatus(ctx)
    if (statusEntries.kind === 'error') {
      return this.writeFailure('error', statusEntries.message)
    }
    const snapshot = await this.computeSnapshot(ctx, head, statusEntries.entries)
    if (snapshot !== request.snapshot) {
      return {
        state: 'stale',
        snapshot,
        results: [],
        error: 'Review snapshot changed since it was read; nothing was applied',
      }
    }

    const applied = await apply(ctx, targets, head, statusEntries.entries)
    return this.finishWrite(sessionId, ctx, request.source, applied.results, applied.backupDir)
  }

  private async runHunkWrite(
    sessionId: string,
    request: ReviewHunkRequest,
    reverse: boolean,
  ): Promise<ReviewWriteResult> {
    if (typeof request.patch !== 'string' || request.patch.trim().length === 0) {
      return this.writeFailure('error', 'patch is required')
    }
    if (typeof request.snapshot !== 'string' || request.snapshot.length === 0) {
      return this.writeFailure('error', 'snapshot is required for review writes')
    }
    const refusal = rejectUnwritableSource(request.source)
    if (refusal) return this.writeFailure('error', refusal)

    if (request.source && request.source.kind !== (reverse ? 'staged' : 'unstaged')) return this.writeFailure('error', 'Hunk action does not match the displayed comparison')

    const patchPaths = collectPatchPaths(request.patch)
    if (patchPaths.length !== 1) {
      return this.writeFailure(
        'error',
        `Hunk operations accept a patch for exactly one file (found ${patchPaths.length})`,
      )
    }

    const prepared = await this.prepare(sessionId)
    if (prepared.kind === 'failed') {
      return this.writeFailure(prepared.state, prepared.error)
    }
    const { ctx } = prepared

    // Patch paths are repo-relative because the patch text comes from this
    // service's own diff output; map back to a workspace path to reuse the
    // same traversal/symlink validation every other write goes through.
    const workspacePath = this.rebaseRepoPath(ctx, patchPaths[0]!)
    if (workspacePath === null) {
      throw new Error(`Path is outside workspace: ${patchPaths[0]}`)
    }
    const target = await this.resolveWorkspacePath(ctx, workspacePath)

    const head = await this.resolveHead(ctx)
    const statusEntries = await this.readStatus(ctx)
    if (statusEntries.kind === 'error') {
      return this.writeFailure('error', statusEntries.message)
    }

    const entry = statusEntries.entries.find((candidate) => candidate.path === target.relativePath)
    if (entry?.conflicted) {
      return this.writeFailure(
        'error',
        `Unmerged path only supports whole-file operations: ${target.relativePath}`,
      )
    }
    if (/^GIT binary patch$/m.test(request.patch)) {
      return this.writeFailure(
        'error',
        `Binary file only supports whole-file operations: ${target.relativePath}`,
      )
    }

    const snapshot = await this.computeSnapshot(ctx, head, statusEntries.entries)
    if (snapshot !== request.snapshot) {
      return {
        state: 'stale',
        snapshot,
        results: [],
        error: 'Review snapshot changed since it was read; nothing was applied',
      }
    }

    const patchDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-haha-review-patch-'))
    const patchFile = path.join(patchDir, 'hunk.patch')
    let results: ReviewPathResult[]
    try {
      const patch = request.patch.endsWith('\n') ? request.patch : `${request.patch}\n`
      await fs.writeFile(patchFile, patch, 'utf8')

      const args = [
        'apply',
        '--cached',
        '--whitespace=nowarn',
        ...(reverse ? ['--reverse'] : []),
        '--',
        patchFile,
      ]
      const result = await this.runGit(ctx.repoRoot, args)
      results = [
        result.code === 0
          ? { path: target.relativePath, ok: true }
          : {
              path: target.relativePath,
              ok: false,
              error: this.formatGitError(
                reverse ? 'Failed to unstage hunk' : 'Failed to stage hunk',
                args,
                ctx.repoRoot,
                result,
              ),
            },
      ]
    } finally {
      await fs.rm(patchDir, { recursive: true, force: true })
    }

    return this.finishWrite(sessionId, ctx, request.source, results)
  }

  private async finishWrite(
    sessionId: string,
    ctx: ReviewContext,
    source: ReviewSource | undefined,
    results: ReviewPathResult[],
    backupDir?: string,
  ): Promise<ReviewWriteResult> {
    const succeeded = results.filter((result) => result.ok).length
    const state: ReviewWriteState =
      succeeded === results.length ? 'ok' : succeeded === 0 ? 'error' : 'partial'

    const status = source ? await this.getStatus(sessionId, source) : undefined

    let snapshot = status?.snapshot ?? ''
    if (!snapshot) {
      const head = await this.resolveHead(ctx)
      const refreshed = await this.readStatus(ctx)
      snapshot = refreshed.kind === 'ok' ? await this.computeSnapshot(ctx, head, refreshed.entries) : ''
    }

    // The two outcomes are summarized separately because they are not the same
    // event: a reverted file still exists on disk, a deleted one does not.
    const deletedPaths = results
      .filter((result) => result.ok && result.action === 'deleted')
      .map((result) => result.path)
    const revertedPaths = results
      .filter((result) => result.ok && result.action === 'reverted')
      .map((result) => result.path)

    return {
      state,
      snapshot,
      results,
      status,
      backupDir,
      ...(revertedPaths.length > 0 ? { revertedPaths } : {}),
      ...(deletedPaths.length > 0 ? { deletedPaths } : {}),
      error: state === 'ok' ? undefined : results.find((result) => !result.ok)?.error,
    }
  }

  private writeFailure(
    state: ReviewWriteState,
    error: string | undefined,
  ): ReviewWriteResult {
    return { state, snapshot: '', results: [], error }
  }

  private rejectTurnSource(source: ReviewSource): ReviewStatusResult {
    return {
      state: 'error',
      source,
      snapshot: '',
      files: [],
      untracked: [],
      totals: { additions: 0, deletions: 0, files: 0 },
      error: TURN_SOURCE_REJECTION,
    }
  }

  // -- git plumbing ---------------------------------------------------------

  private async prepare(sessionId: string): Promise<PrepareResult> {
    const workDir = await this.requireWorkDir(sessionId)

    const stat = await this.safeStat(workDir)
    if (stat.kind === 'missing' || (stat.kind === 'ok' && !stat.stat.isDirectory())) {
      return { kind: 'failed', state: 'missing_workdir', error: MISSING_WORKDIR_MESSAGE }
    }
    if (stat.kind === 'error') {
      return { kind: 'failed', state: 'error', error: stat.message }
    }

    let canonicalWorkspaceRoot: string
    try {
      canonicalWorkspaceRoot = normalizeDriveRootPathForPlatform(await fs.realpath(workDir))
    } catch (error) {
      return {
        kind: 'failed',
        state: 'error',
        error: this.formatFsError('Failed to canonicalize workspace root', workDir, error),
      }
    }

    const toplevel = await this.runGit(workDir, ['rev-parse', '--show-toplevel'])
    if (toplevel.code !== 0 || !toplevel.stdout.trim()) {
      if (await this.isNotAGitRepository(workDir, toplevel)) {
        return { kind: 'failed', state: 'not_git_repo' }
      }
      return {
        kind: 'failed',
        state: 'error',
        error: this.formatGitError(
          'Failed to inspect git repository',
          ['rev-parse', '--show-toplevel'],
          workDir,
          toplevel,
        ),
      }
    }

    let repoRoot: string
    try {
      repoRoot = normalizeDriveRootPathForPlatform(
        await fs.realpath(path.resolve(toplevel.stdout.trim())),
      )
    } catch (error) {
      return {
        kind: 'failed',
        state: 'error',
        error: this.formatFsError(
          'Failed to canonicalize git repository root',
          toplevel.stdout.trim(),
          error,
        ),
      }
    }

    return {
      kind: 'ok',
      ctx: {
        sessionId,
        workDir,
        workspaceRoot: workDir,
        canonicalWorkspaceRoot,
        repoRoot,
        workDirFromRepo: toPosixPath(path.relative(repoRoot, canonicalWorkspaceRoot)),
      },
    }
  }

  /**
   * Whether a failed `rev-parse --show-toplevel` means "there is no repository
   * here", decided by exit status rather than by git's message.
   *
   * The previous test matched the English text `not a git repository`, which a
   * translated git does not print — every localized install reported `error`
   * instead of `not_git_repo`. `rev-parse --is-inside-work-tree` exits 0 inside
   * any repository and non-zero outside one, so the two cases separate without
   * reading a message. A git that never produced an exit status (missing
   * binary, timeout) proves nothing and stays an `error`.
   */
  private async isNotAGitRepository(
    dir: string,
    firstAttempt: GitCommandResult,
  ): Promise<boolean> {
    if (firstAttempt.failedToRun) return false
    const probe = await this.runGit(dir, ['rev-parse', '--is-inside-work-tree'])
    if (probe.failedToRun) return false
    return probe.code !== 0
  }

  private async requireWorkDir(sessionId: string): Promise<string> {
    const workDir = await this.resolveSessionWorkDir(sessionId)
    if (!workDir) {
      throw new Error(`Session not found: ${sessionId}`)
    }
    return path.resolve(normalizeDriveRootPathForPlatform(workDir))
  }

  private async resolveHead(ctx: ReviewContext): Promise<string | null> {
    const result = await this.runGit(ctx.repoRoot, ['rev-parse', '--verify', 'HEAD'])
    if (result.code !== 0) return null
    const sha = result.stdout.trim()
    return sha.length > 0 ? sha : null
  }

  private async readStatus(
    ctx: ReviewContext,
  ): Promise<{ kind: 'ok'; entries: StatusEntry[] } | { kind: 'error'; message: string }> {
    const args = ['status', '--porcelain=v1', '-z', '--untracked-files=all']
    const result = await this.runGit(ctx.repoRoot, args)
    if (result.code !== 0) {
      return {
        kind: 'error',
        message: this.formatGitError('Failed to read git status', args, ctx.repoRoot, result),
      }
    }

    const parts = result.stdout.split(NUL)
    const entries: StatusEntry[] = []

    for (let i = 0; i < parts.length; i++) {
      const record = parts[i]
      if (!record) continue

      const code = record.slice(0, 2)
      const repoPath = toPosixPath(record.slice(3))
      const x = code[0] ?? ' '
      const y = code[1] ?? ' '
      const untracked = code === '??'
      const conflicted = isConflictCode(code)

      let repoOldPath: string | undefined
      if (x === 'R' || x === 'C' || y === 'R' || y === 'C') {
        repoOldPath = toPosixPath(parts[++i] ?? '')
      }

      const scopedPath = this.rebaseRepoPath(ctx, repoPath)
      if (scopedPath === null) continue

      entries.push({
        repoPath,
        repoOldPath,
        path: scopedPath,
        oldPath: repoOldPath ? this.rebaseRepoPath(ctx, repoOldPath) ?? undefined : undefined,
        code,
        untracked,
        conflicted,
        stagedChange: !untracked && !conflicted && x !== ' ',
        unstagedChange: !untracked && !conflicted && y !== ' ',
        absolutePath: path.resolve(ctx.repoRoot, repoPath),
      })
    }

    entries.sort((a, b) => a.path.localeCompare(b.path))
    return { kind: 'ok', entries }
  }

  /**
   * Version token for the Git state the client is looking at.
   *
   * HEAD + index stat + status output would miss a second edit to a file that
   * is already reported as modified — precisely the case the guard exists for —
   * so the working-tree stat of each changed file is folded in as well. That
   * stays cheap: the set is the changed files, not the repository.
   */
  private async computeSnapshot(
    ctx: ReviewContext,
    head: string | null,
    entries: StatusEntry[],
  ): Promise<string> {
    const hash = createHash('sha256')
    hash.update(`head:${head ?? 'unborn'} `)

    // The index side is keyed off its *content* (the blob oids `--raw` prints),
    // not the `.git/index` mtime: `git status` refreshes the index stat cache
    // and rewrites the file, so an mtime-based token would change on every read
    // and reject every write as stale.
    const indexArgs = [
      'diff',
      '--cached',
      '--raw',
      '-z',
      '--find-renames',
      '--find-copies',
      '--',
      ...(ctx.workDirFromRepo ? [literalPathspec(ctx.workDirFromRepo)] : []),
    ]
    const indexResult = await this.runGit(ctx.repoRoot, indexArgs)
    hash.update(indexResult.code === 0 ? `index:${indexResult.stdout} ` : 'index:unavailable ')

    for (const entry of entries) {
      hash.update(`${entry.code}:${entry.path}:${entry.oldPath ?? ''}`)
      const stat = await this.safeStat(entry.absolutePath)
      hash.update(stat.kind === 'ok' ? `:${stat.stat.mtimeMs}:${stat.stat.size} ` : ':absent ')
    }

    return hash.digest('hex').slice(0, 32)
  }

  private async resolveSource(
    ctx: ReviewContext,
    source: ReviewSource,
    head: string | null,
  ): Promise<SourceResolution> {
    switch (source.kind) {
      case 'unstaged':
        return {
          kind: 'ok',
          resolved: {
            source: { kind: 'unstaged' },
            revArgs: [],
            includeUntracked: true,
            useWorkingTreeStatus: true,
          },
        }

      case 'staged':
        if (!head) {
          return { kind: 'no_head', source, error: NO_HEAD_MESSAGE }
        }
        return {
          kind: 'ok',
          resolved: {
            source: { kind: 'staged', resolvedBase: head },
            revArgs: ['--cached', head],
            includeUntracked: false,
            useWorkingTreeStatus: true,
          },
        }

      case 'uncommitted':
        if (!head) {
          return { kind: 'no_head', source, error: NO_HEAD_MESSAGE }
        }
        return {
          kind: 'ok',
          resolved: {
            source: { kind: 'uncommitted', resolvedBase: head },
            revArgs: [head],
            includeUntracked: true,
            useWorkingTreeStatus: true,
          },
        }

      case 'branch': {
        if (!head) {
          return { kind: 'no_head', source, error: NO_HEAD_MESSAGE }
        }
        if (!source.baseRef || source.baseRef.startsWith('-')) {
          return { kind: 'error', source, error: `Invalid base ref: ${source.baseRef}` }
        }
        const baseSha = await this.runGit(ctx.repoRoot, [
          'rev-parse',
          '--verify',
          `${source.baseRef}^{commit}`,
        ])
        if (baseSha.code !== 0) {
          return { kind: 'error', source, error: `Unknown base ref: ${source.baseRef}` }
        }
        const mergeBase = await this.runGit(ctx.repoRoot, [
          'merge-base',
          head,
          baseSha.stdout.trim(),
        ])
        if (mergeBase.code !== 0 || !mergeBase.stdout.trim()) {
          return {
            kind: 'error',
            source,
            error: `No merge base between HEAD and ${source.baseRef}`,
          }
        }
        const resolvedBase = mergeBase.stdout.trim()
        return {
          kind: 'ok',
          resolved: {
            // Single-revision diff: merge-base to the current working tree, so
            // uncommitted work shows up. `base..HEAD` would hide it.
            source: { kind: 'branch', baseRef: source.baseRef, resolvedBase },
            revArgs: [resolvedBase],
            includeUntracked: false,
            useWorkingTreeStatus: true,
          },
        }
      }

      case 'commit': {
        if (!source.commit || source.commit.startsWith('-')) {
          return { kind: 'error', source, error: `Invalid commit: ${source.commit}` }
        }
        const commitSha = await this.runGit(ctx.repoRoot, [
          'rev-parse',
          '--verify',
          `${source.commit}^{commit}`,
        ])
        if (commitSha.code !== 0) {
          return { kind: 'error', source, error: `Unknown commit: ${source.commit}` }
        }
        const sha = commitSha.stdout.trim()
        const parents = await this.runGit(ctx.repoRoot, ['rev-list', '--parents', '-n', '1', sha])
        if (parents.code !== 0) {
          return { kind: 'error', source, error: `Failed to resolve parents of ${source.commit}` }
        }
        const [, firstParent] = parents.stdout.trim().split(/\s+/)
        const base = firstParent ?? (await this.resolveEmptyTree(ctx))
        return {
          kind: 'ok',
          resolved: {
            source: { kind: 'commit', commit: sha, resolvedBase: base },
            revArgs: [base, sha],
            includeUntracked: false,
            useWorkingTreeStatus: false,
          },
        }
      }

      default:
        return { kind: 'error', source, error: TURN_SOURCE_REJECTION }
    }
  }

  /** Root commits have no parent; they are compared against the empty tree. */
  private async resolveEmptyTree(ctx: ReviewContext): Promise<string> {
    const result = await this.runGit(ctx.repoRoot, ['hash-object', '-t', 'tree', '/dev/null'])
    const sha = result.code === 0 ? result.stdout.trim() : ''
    return sha.length > 0 ? sha : FALLBACK_EMPTY_TREE_SHA
  }

  // -- file collection ------------------------------------------------------

  private async collectFiles(
    ctx: ReviewContext,
    resolved: ResolvedSource,
    entries: StatusEntry[],
  ): Promise<{ kind: 'ok'; files: ReviewFile[] } | { kind: 'error'; message: string }> {
    const diffOptions = ['-z', '--find-renames', '--find-copies', '--']
    const numstatArgs = ['diff', ...resolved.revArgs, '--numstat', ...diffOptions]
    const nameStatusArgs = ['diff', ...resolved.revArgs, '--name-status', ...diffOptions]

    const [numstatResult, nameStatusResult] = await Promise.all([
      this.runGit(ctx.repoRoot, numstatArgs),
      this.runGit(ctx.repoRoot, nameStatusArgs),
    ])
    if (numstatResult.code !== 0) {
      return {
        kind: 'error',
        message: this.formatGitError('Failed to read review stats', numstatArgs, ctx.repoRoot, numstatResult),
      }
    }
    if (nameStatusResult.code !== 0) {
      return {
        kind: 'error',
        message: this.formatGitError(
          'Failed to read review file list',
          nameStatusArgs,
          ctx.repoRoot,
          nameStatusResult,
        ),
      }
    }

    const nameStatusByRepoPath = parseNameStatus(nameStatusResult.stdout)
    const entryByPath = new Map(entries.map((entry) => [entry.path, entry]))
    const files = new Map<string, ReviewFile>()

    for (const stat of parseNumstat(numstatResult.stdout)) {
      const workspacePath = this.rebaseRepoPath(ctx, stat.repoPath)
      if (workspacePath === null) continue

      const entry = resolved.useWorkingTreeStatus ? entryByPath.get(workspacePath) : undefined
      const nameStatus = nameStatusByRepoPath.get(stat.repoPath)
      const oldRepoPath = stat.repoOldPath ?? nameStatus?.repoOldPath
      const oldPath = oldRepoPath ? this.rebaseRepoPath(ctx, oldRepoPath) ?? undefined : undefined

      files.set(workspacePath, {
        path: workspacePath,
        oldPath,
        status: this.resolveFileStatus(resolved, entry, nameStatus?.letter),
        additions: stat.additions,
        deletions: stat.deletions,
        binary: stat.binary,
        staged: entry?.stagedChange ?? false,
        unstaged: entry?.unstagedChange ?? false,
        conflicted: entry?.conflicted ?? false,
      })
    }

    if (resolved.useWorkingTreeStatus) {
      for (const entry of entries) {
        if (files.has(entry.path)) continue

        // Unmerged paths do not always show up in the plain diff, and untracked
        // files never do — both still belong in the review list.
        if (entry.conflicted) {
          files.set(entry.path, {
            path: entry.path,
            oldPath: entry.oldPath,
            status: 'conflicted',
            additions: 0,
            deletions: 0,
            binary: false,
            staged: false,
            unstaged: false,
            conflicted: true,
          })
          continue
        }

        if (entry.untracked && resolved.includeUntracked) {
          const stats = await this.readUntrackedStats(entry.absolutePath)
          files.set(entry.path, {
            path: entry.path,
            status: 'untracked',
            additions: stats.additions,
            deletions: 0,
            binary: stats.binary,
            staged: false,
            unstaged: true,
            conflicted: false,
            ...(stats.truncated ? { statsTruncated: true } : {}),
          })
        }
      }
    }

    return {
      kind: 'ok',
      files: [...files.values()].sort((a, b) => a.path.localeCompare(b.path)),
    }
  }

  /**
   * Which half of the porcelain code describes this source. `unstaged` reads the
   * worktree column, `staged` reads the index column; a file that is renamed in
   * the index and edited afterwards is therefore `renamed` under `staged` and
   * `modified` under `unstaged`, which is what the two comparisons actually show.
   */
  private resolveFileStatus(
    resolved: ResolvedSource,
    entry: StatusEntry | undefined,
    diffLetter: string | undefined,
  ): ReviewFileStatus {
    if (entry?.conflicted) return 'conflicted'
    if (entry?.untracked) return 'untracked'

    if (entry) {
      switch (resolved.source.kind) {
        case 'unstaged':
          return statusFromLetter(entry.code[1] ?? ' ')
        case 'staged':
          return statusFromLetter(entry.code[0] ?? ' ')
        case 'uncommitted':
          return parseStatus(entry.code)
        default:
          break
      }
    }

    return diffLetter ? statusFromLetter(diffLetter[0] ?? '') : 'unknown'
  }

  /**
   * Line count for an untracked file.
   *
   * The size check used to end in `additions: 0, binary: false`, which the
   * change list rendered as `+0 -0` — a 24 MB log looked exactly like an empty
   * new file. Anything the whole-file read would not cover is streamed instead,
   * and only a file past the scan limit reports "not counted" explicitly.
   */
  private async readUntrackedStats(
    absolutePath: string,
  ): Promise<{ additions: number; binary: boolean; truncated: boolean }> {
    const stat = await this.safeStat(absolutePath)
    if (stat.kind !== 'ok' || !stat.stat.isFile()) {
      return { additions: 0, binary: false, truncated: false }
    }
    if (stat.stat.size > MAX_UNTRACKED_SCAN_BYTES) {
      return { additions: 0, binary: false, truncated: true }
    }
    if (stat.stat.size > MAX_UNTRACKED_STAT_BYTES) {
      return this.scanUntrackedStats(absolutePath)
    }

    try {
      const buffer = await fs.readFile(absolutePath)
      if (buffer.includes(0)) {
        return { additions: 0, binary: true, truncated: false }
      }
      return {
        additions: countTextLines(buffer.toString('utf8')),
        binary: false,
        truncated: false,
      }
    } catch {
      return { additions: 0, binary: false, truncated: false }
    }
  }

  /** Chunked newline count; peak memory is one chunk regardless of file size. */
  private async scanUntrackedStats(
    absolutePath: string,
  ): Promise<{ additions: number; binary: boolean; truncated: boolean }> {
    let handle: Awaited<ReturnType<typeof fs.open>> | null = null
    try {
      handle = await fs.open(absolutePath, 'r')
      const chunk = Buffer.allocUnsafe(UNTRACKED_SCAN_CHUNK_BYTES)
      const LF = 0x0a
      const CR = 0x0d
      let lines = 0
      let previous = -1
      let total = 0

      for (;;) {
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, null)
        if (bytesRead === 0) break
        const view = chunk.subarray(0, bytesRead)
        // Only the first chunk decides "binary": git applies the same
        // heuristic, and scanning 32 MB for a NUL byte buys nothing.
        if (total === 0 && view.includes(0)) {
          return { additions: 0, binary: true, truncated: false }
        }
        for (let i = 0; i < bytesRead; i++) {
          const byte = view[i]!
          // Same terminator set as `countTextLines`: LF, CRLF and a lone CR.
          if (previous === CR && byte !== LF) lines++
          if (byte === LF) lines++
          previous = byte
        }
        total += bytesRead
      }

      if (previous === CR) lines++
      // A final line with no terminator still counts, as in the small-file path.
      else if (total > 0 && previous !== LF) lines++
      return { additions: lines, binary: false, truncated: false }
    } catch {
      return { additions: 0, binary: false, truncated: false }
    } finally {
      await handle?.close().catch(() => {})
    }
  }

  /** Untracked files have no git-side diff; synthesize the "new file" form. */
  private async buildUntrackedDiff(
    absolutePath: string,
    repoPath: string,
  ): Promise<
    | { kind: 'ok'; diff: string; binary: boolean; truncated?: boolean; bytes?: number }
    | { kind: 'missing' }
    | { kind: 'error'; message: string }
  > {
    const stat = await this.safeStat(absolutePath)
    if (stat.kind === 'error') return { kind: 'error', message: stat.message }
    if (stat.kind === 'missing' || !stat.stat.isFile()) return { kind: 'missing' }

    if (stat.stat.size > MAX_UNTRACKED_DIFF_BYTES) {
      // Header only, and deliberately no `@@` block. A partial hunk would be a
      // perfectly appliable patch whose effect is to stage a truncated copy of
      // the file, so the safe degradation is to emit nothing to apply.
      return {
        kind: 'ok',
        binary: false,
        truncated: true,
        bytes: stat.stat.size,
        diff: [
          `diff --git ${quoteGitPath(`a/${repoPath}`)} ${quoteGitPath(`b/${repoPath}`)}`,
          `new file mode ${stat.stat.mode & 0o111 ? '100755' : '100644'}`,
          '',
        ].join('\n'),
      }
    }

    let buffer: Buffer
    try {
      buffer = await fs.readFile(absolutePath)
    } catch (error) {
      return {
        kind: 'error',
        message: this.formatFsError('Failed to read untracked file', absolutePath, error),
      }
    }

    if (buffer.includes(0) || !Buffer.from(buffer.toString('utf8')).equals(buffer)) {
      return {
        kind: 'ok',
        binary: true,
        diff: [
          `diff --git ${quoteGitPath(`a/${repoPath}`)} ${quoteGitPath(`b/${repoPath}`)}`,
          `new file mode ${stat.stat.mode & 0o111 ? '100755' : '100644'}`,
          `Binary files /dev/null and b/${repoPath} differ`,
          '',
        ].join('\n'),
      }
    }

    // Unified patches delimit lines with LF. A CR belongs to the file bytes,
    // and a missing final LF must be represented by Git's explicit marker.
    const content = buffer.toString('utf8')
    const lines = content ? content.split('\n') : []
    if (content.endsWith('\n')) lines.pop()
    const hunkLines = lines.map((line) => `+${line}`)
    if (content && !content.endsWith('\n')) hunkLines.push('\\ No newline at end of file')

    return {
      kind: 'ok',
      binary: false,
      diff: [
        `diff --git ${quoteGitPath(`a/${repoPath}`)} ${quoteGitPath(`b/${repoPath}`)}`,
        `new file mode ${stat.stat.mode & 0o111 ? '100755' : '100644'}`,
        ...(lines.length ? [
          '--- /dev/null',
          `+++ ${quoteGitPath(`b/${repoPath}`)}`,
          `@@ -0,0 +1,${lines.length} @@`,
          ...hunkLines,
        ] : []),
        '',
      ].join('\n'),
    }
  }

  // -- path safety ----------------------------------------------------------

  /**
   * Same discipline as `workspaceService`: resolve against the session
   * workspace root, reject anything that escapes it before *and* after symlink
   * canonicalization, and keep Windows drive roots comparable. Unlike the file
   * preview there is no registered-access-root escape hatch — review writes
   * never touch files outside the session workspace.
   */
  private async resolveWorkspacePath(
    ctx: ReviewContext,
    requestedPath: string,
    historical = false,
  ): Promise<ResolvedTarget> {
    if (typeof requestedPath !== 'string' || requestedPath.trim().length === 0) {
      throw new Error('path is required')
    }

    const absolutePath = path.resolve(ctx.workspaceRoot, requestedPath)
    if (!isSameOrInsidePathForPlatform(absolutePath, ctx.workspaceRoot)) {
      throw new Error(`Path is outside workspace: ${requestedPath}`)
    }

    const relativePath = toPosixPath(path.relative(ctx.workspaceRoot, absolutePath))
    if (!relativePath) {
      throw new Error(`Path is not a file inside the workspace: ${requestedPath}`)
    }
    this.rejectVcsMetadataSegments(relativePath, requestedPath)

    if (historical) {
      // git show/diff reads tree objects, so the current file type and symlink
      // target have no authority over an historical repository path.
      const canonicalPath = path.resolve(ctx.canonicalWorkspaceRoot, relativePath)
      return { requestedPath, relativePath, absolutePath, canonicalPath, repoPath: toPosixPath(path.relative(ctx.repoRoot, canonicalPath)) }
    }

    // A symlink is never reviewed through its target. `revert` copies the file
    // into the backup directory with `copyFile`, which follows links, and
    // `git restore` would then rewrite the link rather than what it points at.
    const link = await this.safeLstat(absolutePath)
    if (link.kind === 'error') throw new Error(link.message)
    if (link.kind === 'ok' && link.stat.isSymbolicLink()) {
      throw new Error(`Path is a symbolic link and is not reviewable: ${requestedPath}`)
    }

    const canonicalPath = await this.resolveCanonicalTargetPath(
      ctx.canonicalWorkspaceRoot,
      absolutePath,
      requestedPath,
    )

    // The segment check above sees only what the caller typed. A gitignored
    // `meta -> .git` symlink makes `meta/config` look ordinary while resolving
    // inside the repository metadata — and a containment check alone accepts
    // it, because `.git` *is* inside the workspace. Re-checking the resolved
    // path is what actually keeps credentials out of the backup directory.
    this.rejectVcsMetadataSegments(
      toPosixPath(path.relative(ctx.canonicalWorkspaceRoot, canonicalPath)),
      requestedPath,
    )

    const repoPath = toPosixPath(path.relative(ctx.repoRoot, canonicalPath))
    if (!repoPath || repoPath === '..' || repoPath.startsWith('../')) {
      throw new Error(`Path is outside workspace: ${requestedPath}`)
    }

    return { requestedPath, relativePath, absolutePath, canonicalPath, repoPath }
  }

  private rejectVcsMetadataSegments(relativePath: string, requestedPath: string): void {
    for (const segment of relativePath.split('/')) {
      if (VCS_METADATA_DIRECTORY_NAMES.has(segment.toLowerCase())) {
        throw new Error(`Path is inside version-control metadata: ${requestedPath}`)
      }
    }
  }

  private async resolveCanonicalTargetPath(
    canonicalWorkspaceRoot: string,
    absolutePath: string,
    requestedPath: string,
  ): Promise<string> {
    let probePath = absolutePath
    const missingSuffix: string[] = []

    for (;;) {
      try {
        const canonicalBase = await fs.realpath(probePath)
        const canonicalTarget = path.resolve(canonicalBase, ...missingSuffix)
        if (!isSameOrInsidePathForPlatform(canonicalTarget, canonicalWorkspaceRoot)) {
          throw new Error(`Path is outside workspace: ${requestedPath}`)
        }
        return canonicalTarget
      } catch (error) {
        const err = error as NodeJS.ErrnoException
        if (err.code === 'ENOENT' || err.code === 'ENOTDIR') {
          if (probePath === canonicalWorkspaceRoot) {
            const candidate = path.resolve(canonicalWorkspaceRoot, ...missingSuffix)
            if (!isSameOrInsidePathForPlatform(candidate, canonicalWorkspaceRoot)) {
              throw new Error(`Path is outside workspace: ${requestedPath}`)
            }
            return candidate
          }

          missingSuffix.unshift(path.basename(probePath))
          const parentPath = path.dirname(probePath)
          if (parentPath === probePath) throw err
          probePath = parentPath
          continue
        }

        throw error instanceof Error && error.message.includes('outside workspace')
          ? error
          : new Error(
              this.formatFsError('Failed to canonicalize review path', absolutePath, error),
            )
      }
    }
  }

  /** Repo-relative path to workspace-relative, or null when outside the workspace. */
  private rebaseRepoPath(ctx: ReviewContext, repoPath: string): string | null {
    const normalized = toPosixPath(repoPath)
    if (!ctx.workDirFromRepo) return normalized

    const rebased = path.posix.relative(ctx.workDirFromRepo, normalized)
    if (!rebased || rebased === '.' || rebased === '..' || rebased.startsWith('../')) {
      return null
    }
    return rebased
  }

  // -- revert backups -------------------------------------------------------

  private buildBackupDir(sessionId: string): string {
    const root = this.backupRoot ?? path.join(getCcHahaDir(), 'review-backups')
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const suffix = Math.random().toString(36).slice(2, 8)
    return path.join(root, sanitizeBackupSegment(sessionId), `${stamp}-${suffix}`)
  }

  /**
   * The backup holds verbatim copies of the user's working tree, including
   * whatever secrets it contained, under a predictable app-data path. It is
   * created owner-only rather than at the process umask, and each copy is
   * narrowed too — `copyFile` otherwise carries the source mode across, so a
   * world-readable file stays world-readable in a directory that aggregates
   * many of them.
   */
  private async writeBackup(
    backupDir: string,
    relativePath: string,
    absolutePath: string,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    const destination = path.join(backupDir, ...relativePath.split('/'))
    try {
      await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 })
      await this.restrictPermissions(backupDir, 0o700)
      await fs.copyFile(absolutePath, destination)
      await this.restrictPermissions(destination, 0o600)
      return { ok: true }
    } catch (error) {
      return {
        ok: false,
        error: this.formatFsError('Failed to back up file before revert', absolutePath, error),
      }
    }
  }

  /** Best-effort: Windows has no POSIX mode bits and `chmod` is a near no-op. */
  private async restrictPermissions(targetPath: string, mode: number): Promise<void> {
    try {
      await fs.chmod(targetPath, mode)
    } catch {
      // A backup that could not be narrowed is still better than no backup.
    }
  }

  // -- process / fs plumbing ------------------------------------------------

  /**
   * Environment every review git command runs under.
   *
   * Two things are wrong with plain inheritance. `GIT_DIR`/`GIT_WORK_TREE`/
   * `GIT_INDEX_FILE` re-point git at a different repository or index, so a
   * value left in the app's environment would make `git add` stage somewhere
   * the user never named. And the user's locale translates git's messages,
   * which the output parsers and the repository probe below read.
   */
  private buildGitEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env }
    for (const name of GIT_RETARGETING_ENV_VARS) delete env[name]
    env.LC_ALL = 'C'
    env.LANG = 'C'
    // No review command may prompt: a credential prompt would hang until the
    // 10s timeout with no way for the user to answer it.
    env.GIT_TERMINAL_PROMPT = '0'
    return env
  }

  private async runGit(cwd: string, args: string[]): Promise<GitCommandResult> {
    // `core.quotePath=false` keeps non-ASCII paths as UTF-8 instead of the
    // C-quoted `"\303\251.txt"` form. A quoted path in patch text made
    // `collectPatchPaths` validate a filename that does not exist, while
    // `git apply` unquoted it again and wrote to the real file.
    const fullArgs = ['-c', 'core.quotePath=false', ...args]
    try {
      const result = await execFile('git', fullArgs, {
        cwd,
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: MAX_GIT_BUFFER_BYTES,
        encoding: 'utf8',
        env: this.buildGitEnv(),
      })
      return { stdout: result.stdout, stderr: result.stderr, code: 0 }
    } catch (error) {
      const err = error as NodeJS.ErrnoException & {
        stdout?: string | Buffer
        stderr?: string | Buffer
        code?: number | string
        killed?: boolean
      }
      // A string `code` is a spawn failure (ENOENT, EACCES); `killed` is the
      // timeout. Neither is git answering a question.
      const failedToRun = typeof err.code === 'string' || err.killed === true
      return {
        stdout: typeof err.stdout === 'string'
          ? err.stdout
          : Buffer.isBuffer(err.stdout)
            ? err.stdout.toString('utf8')
            : '',
        stderr: typeof err.stderr === 'string'
          ? err.stderr
          : Buffer.isBuffer(err.stderr)
            ? err.stderr.toString('utf8')
            : err.message || '',
        code: typeof err.code === 'number' ? err.code : 1,
        ...(failedToRun ? { failedToRun: true } : {}),
      }
    }
  }

  /** `lstat`, so the link itself is described rather than what it points at. */
  private async safeLstat(targetPath: string): Promise<ReviewStatResult> {
    try {
      return { kind: 'ok', stat: await fs.lstat(targetPath) }
    } catch (error) {
      const err = error as NodeJS.ErrnoException
      if (err.code === 'ENOENT' || err.code === 'ENOTDIR') {
        return { kind: 'missing' }
      }
      return {
        kind: 'error',
        message: this.formatFsError('Failed to stat review path', targetPath, error),
      }
    }
  }

  private async safeStat(targetPath: string): Promise<ReviewStatResult> {
    try {
      return { kind: 'ok', stat: await fs.stat(targetPath) }
    } catch (error) {
      const err = error as NodeJS.ErrnoException
      if (err.code === 'ENOENT' || err.code === 'ENOTDIR') {
        return { kind: 'missing' }
      }
      return {
        kind: 'error',
        message: this.formatFsError('Failed to stat review path', targetPath, error),
      }
    }
  }

  private formatFsError(prefix: string, targetPath: string, error: unknown): string {
    const err = error as NodeJS.ErrnoException
    const code = err.code ? `${err.code}: ` : ''
    return `${prefix} (${targetPath}): ${code}${err.message || 'unknown error'}`
  }

  private formatGitError(
    prefix: string,
    args: string[],
    cwd: string,
    result: GitCommandResult,
  ): string {
    const detail = result.stderr.trim() || result.stdout.trim() || 'unknown git failure'
    return `${prefix} (git ${args.join(' ')} in ${cwd}): ${detail}`
  }
}
