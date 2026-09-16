import { api, type ApiRequestOptions } from './client'

/**
 * Typed client for the server-side Git review domain
 * (`/api/sessions/:id/review`).
 *
 * Deliberately separate from `sessionsApi.getWorkspaceStatus/Diff`: those serve
 * the chat "changed files" card, always compare against `HEAD`, and blend in
 * session history. Review names both sides of every comparison, and it is the
 * only client surface that writes to the index or the working tree.
 *
 * Shapes mirror `src/server/services/reviewService.ts`. They are declared here
 * rather than imported so the renderer keeps no build-time dependency on the
 * server sources, the same way `desktop/src/api/sessions.ts` does.
 */

export type ReviewSource =
  | { kind: 'unstaged' }
  | { kind: 'staged' }
  | { kind: 'uncommitted' }
  | { kind: 'branch'; baseRef: string }
  | { kind: 'commit'; commit: string }
  | { kind: 'turn'; turnKey: string }

/** Sources this API can serve. `turn` is answered by the session turn history. */
export type GitReviewSource = Exclude<ReviewSource, { kind: 'turn' }>

export type ResolvedReviewSource = GitReviewSource & {
  /**
   * Left-hand side the comparison actually ran against: the merge-base for
   * `branch`, the parent (or the empty tree) for `commit`, the `HEAD` sha for
   * the `HEAD`-based working-tree sources.
   */
  resolvedBase?: string
}

export type ReviewFileStatus =
  | 'modified'
  | 'added'
  | 'deleted'
  | 'renamed'
  | 'copied'
  | 'type_changed'
  | 'untracked'
  | 'conflicted'
  | 'unknown'

export type ReviewFile = {
  path: string
  oldPath?: string
  status: ReviewFileStatus
  additions: number
  deletions: number
  binary: boolean
  /** Index content differs from `HEAD`. */
  staged: boolean
  /** Working-tree content differs from the index. */
  unstaged: boolean
  /** Unmerged path: only whole-file operations are available. */
  conflicted: boolean
  /**
   * The file was too large to measure, so `additions`/`deletions` mean "not
   * counted", not "zero". Rendering `+0 -0` for one of these makes a 24 MB new
   * log look like an empty file.
   */
  statsTruncated?: boolean
}

export type ReviewTotals = {
  additions: number
  deletions: number
  files: number
}

export type ReviewState = 'ok' | 'not_git_repo' | 'missing_workdir' | 'no_head' | 'error'

export type ReviewStatusResult = {
  state: ReviewState
  source: ResolvedReviewSource
  /** Version token to hand back with every write; changes when Git state changes. */
  snapshot: string
  files: ReviewFile[]
  /** Untracked paths among `files`, so bulk actions can leave them alone. */
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
   * Larger than the review diff cap: `diff` is the header only and carries no
   * hunk on purpose, because a partial hunk is an appliable patch that would
   * truncate the file it lands on.
   */
  truncated?: boolean
  /** Size of the file that was too large to render, in bytes. */
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
   * stored it — the only revert outcome Git cannot undo.
   */
  action?: ReviewPathAction
  error?: string
}

/**
 * `stale` means the snapshot no longer matched and **nothing** was applied —
 * re-read the status and ask the user again rather than retrying blindly.
 * `partial` means some paths landed and some did not; `results` says which.
 */
export type ReviewWriteState = ReviewState | 'stale' | 'partial'

export type ReviewWriteResult = {
  state: ReviewWriteState
  snapshot: string
  results: ReviewPathResult[]
  /** Refreshed status for the source passed in the request. */
  status?: ReviewStatusResult
  /** Where `revert` put recoverable copies of the discarded content. */
  backupDir?: string
  /** Paths restored from Git. These still exist in the working tree. */
  revertedPaths?: string[]
  /**
   * Paths **deleted from disk**. Git holds no copy; only `backupDir` does.
   * Name these to the user instead of calling the operation "discard changes".
   */
  deletedPaths?: string[]
  error?: string
}

export type ReviewPathsRequest = {
  paths: string[]
  snapshot: string
  source?: GitReviewSource
}

export type ReviewHunkRequest = {
  /** Unified diff covering exactly one file. */
  patch: string
  snapshot: string
  source?: GitReviewSource
}

function buildSourceQuery(source: GitReviewSource): URLSearchParams {
  const query = new URLSearchParams({ source: source.kind })
  if (source.kind === 'branch') query.set('baseRef', source.baseRef)
  if (source.kind === 'commit') query.set('commit', source.commit)
  return query
}

function reviewPath(sessionId: string, suffix = '', query?: URLSearchParams): string {
  const qs = query?.toString()
  return `/api/sessions/${sessionId}/review${suffix}${qs ? `?${qs}` : ''}`
}

export const reviewApi = {
  getRevision(sessionId: string, source: GitReviewSource, options?: ApiRequestOptions) {
    return api.get<Pick<ReviewStatusResult, 'state' | 'source' | 'snapshot' | 'error'>>(reviewPath(sessionId, '/revision', buildSourceQuery(source)), options)
  },

  getStatus(sessionId: string, source: GitReviewSource, options?: ApiRequestOptions) {
    return api.get<ReviewStatusResult>(reviewPath(sessionId, '', buildSourceQuery(source)), options)
  },

  getDiff(
    sessionId: string,
    source: GitReviewSource,
    filePath: string,
    oldPath?: string,
    options?: ApiRequestOptions,
  ) {
    const query = buildSourceQuery(source)
    query.set('path', filePath)
    if (oldPath) query.set('oldPath', oldPath)
    return api.get<ReviewDiffResult>(reviewPath(sessionId, '/diff', query), options)
  },

  stage(sessionId: string, request: ReviewPathsRequest) {
    return api.post<ReviewWriteResult>(reviewPath(sessionId, '/stage'), request)
  },

  unstage(sessionId: string, request: ReviewPathsRequest) {
    return api.post<ReviewWriteResult>(reviewPath(sessionId, '/unstage'), request)
  },

  stageHunk(sessionId: string, request: ReviewHunkRequest) {
    return api.post<ReviewWriteResult>(reviewPath(sessionId, '/stage-hunk'), request)
  },

  unstageHunk(sessionId: string, request: ReviewHunkRequest) {
    return api.post<ReviewWriteResult>(reviewPath(sessionId, '/unstage-hunk'), request)
  },

  /**
   * Discards working-tree changes. Untracked files are only removed when they
   * are named explicitly, and the server backs up every affected file first —
   * `backupDir` in the result is where the content went.
   */
  revert(sessionId: string, request: ReviewPathsRequest) {
    return api.post<ReviewWriteResult>(reviewPath(sessionId, '/revert'), request)
  },
}
