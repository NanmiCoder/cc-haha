import { beforeEach, describe, expect, it, vi } from 'vitest'

const reviewApi = vi.hoisted(() => ({
  getStatus: vi.fn(),
  getDiff: vi.fn(),
  stage: vi.fn(),
  unstage: vi.fn(),
  revert: vi.fn(),
  stageHunk: vi.fn(),
  unstageHunk: vi.fn(),
}))

const sessionsApi = vi.hoisted(() => ({
  getWorkspaceStatus: vi.fn(),
  getTurnCheckpoints: vi.fn(),
  getTurnCheckpointDiff: vi.fn(),
  getWorkspaceDiff: vi.fn(),
}))

vi.mock('../api/review', () => ({ reviewApi }))
vi.mock('../api/sessions', () => ({ sessionsApi }))

import {
  toGitReviewSource,
  useWorkspaceReviewStore,
  type WorkspaceReviewWriteOutcome,
} from './workspaceReviewStore'
import type {
  ReviewDiffResult,
  ReviewFile,
  ReviewStatusResult,
  ReviewWriteResult,
} from '../api/review'
import type { WorkspaceReviewSource } from '../lib/workspace/types'
import { translate } from '../i18n'

const SESSION = 'session-a'
const OTHER = 'session-b'
const UNSTAGED: WorkspaceReviewSource = { kind: 'unstaged' }
const STAGED: WorkspaceReviewSource = { kind: 'staged' }
const TURN: WorkspaceReviewSource = { kind: 'turn', turnKey: 't1' }
const BRANCH: WorkspaceReviewSource = { kind: 'branch', baseRef: 'main' }
const COMMIT: WorkspaceReviewSource = { kind: 'commit', commit: 'abc1234' }

function workspaceStatus(changedFiles: Array<Record<string, unknown>> = []) {
  return { checkpoints: [{
    target: { targetUserMessageId: 't1', userMessageIndex: 0, userMessageCount: 1 },
    workDir: '/repo',
    code: { available: true, filesChanged: changedFiles.map(file => file.path), insertions: 4, deletions: 2 },
  }] }
}

function refusalOf(outcome: WorkspaceReviewWriteOutcome): string | null {
  return outcome.state === 'refused' ? outcome.refusal : null
}

function store() {
  return useWorkspaceReviewStore.getState()
}

function entry(sessionId = SESSION, source = UNSTAGED) {
  return store().getEntry(sessionId, source)
}

function file(path: string, overrides: Partial<ReviewFile> = {}): ReviewFile {
  return {
    path,
    status: 'modified',
    additions: 1,
    deletions: 0,
    binary: false,
    staged: false,
    unstaged: true,
    conflicted: false,
    ...overrides,
  }
}

function status(snapshot: string, overrides: Partial<ReviewStatusResult> = {}): ReviewStatusResult {
  const files = overrides.files ?? [file('src/a.ts'), file('src/b.ts')]
  return {
    state: 'ok',
    source: { kind: 'unstaged' },
    snapshot,
    files,
    untracked: [],
    totals: { additions: files.length, deletions: 0, files: files.length },
    ...overrides,
  }
}

function diff(path: string, snapshot: string): ReviewDiffResult {
  return {
    state: 'ok',
    source: { kind: 'unstaged' },
    snapshot,
    path,
    diff: `--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old\n+new\n`,
  }
}

function writeResult(overrides: Partial<ReviewWriteResult> = {}): ReviewWriteResult {
  return { state: 'ok', snapshot: 'snap-2', results: [], ...overrides }
}

/** A promise the test resolves by hand, to order two in-flight requests. */
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve }
}

beforeEach(() => {
  useWorkspaceReviewStore.setState({ byKey: {} })
  for (const mock of Object.values(reviewApi)) mock.mockReset()
  for (const mock of Object.values(sessionsApi)) mock.mockReset()
})

describe('source routing', () => {
  it('never sends the session-changes source to the Git service', () => {
    // `turn` is answered by the workspace status/diff endpoints, which the Git
    // review service refuses outright.
    expect(toGitReviewSource(TURN)).toBeNull()
    expect(toGitReviewSource(UNSTAGED)).toEqual(UNSTAGED)
  })

  it('labels the session-changes entry as what it is, not as a Git comparison', async () => {
    sessionsApi.getTurnCheckpoints.mockResolvedValueOnce(
      workspaceStatus([{ path: 'src/a.ts', status: 'modified', additions: 4, deletions: 2 }]),
    )

    await store().load(SESSION, TURN)

    expect(reviewApi.getStatus).not.toHaveBeenCalled()
    expect(sessionsApi.getTurnCheckpoints).toHaveBeenCalledWith(SESSION, undefined, true)
    expect(sessionsApi.getWorkspaceStatus).not.toHaveBeenCalled()
    expect(entry(SESSION, TURN).status?.files.map((f) => f.path)).toEqual(['src/a.ts'])

    // Calling this `unstaged` claimed an index -> working-tree comparison that
    // never ran, and hid the fact that the panel is showing live Git state.
    expect(entry(SESSION, TURN).status?.source).toEqual({ kind: 'turn', turnKey: 't1' })
    expect(entry(SESSION, TURN).status?.source.resolvedBase).toBeUndefined()
    // No Git version token exists for this view, so no write can be guarded.
    expect(entry(SESSION, TURN).status?.snapshot).toBe('turn:t1')
    expect(entry(SESSION, TURN).readOnly).toBe(true)
  })

  it('marks the session-changes entry read-only even before anything is loaded', () => {
    expect(entry(SESSION, TURN).readOnly).toBe(true)
    expect(entry(SESSION, UNSTAGED).readOnly).toBe(false)
    // Zustand selects with `getEntry`, so an unseen key must not build a new
    // object every call or every render produces a new snapshot.
    expect(entry(SESSION, TURN)).toBe(entry(SESSION, TURN))
    expect(entry(SESSION, UNSTAGED)).toBe(entry(SESSION, UNSTAGED))
  })

  it('labels the session-changes diff with the same source as its status', async () => {
    sessionsApi.getTurnCheckpoints.mockResolvedValueOnce(
      workspaceStatus([{ path: 'src/a.ts', status: 'modified', additions: 4, deletions: 2 }]),
    )
    await store().load(SESSION, TURN)
    sessionsApi.getTurnCheckpointDiff.mockResolvedValueOnce({
      state: 'ok',
      path: 'src/a.ts',
      diff: '--- a/src/a.ts\n+++ b/src/a.ts\n',
    })

    await store().loadDiff(SESSION, TURN, 'src/a.ts')

    expect(entry(SESSION, TURN).diffsByPath['src/a.ts']?.source).toEqual({
      kind: 'turn',
      turnKey: 't1',
    })
  })

  it('refuses every write against the session-changes entry and never calls the API', async () => {
    sessionsApi.getTurnCheckpoints.mockResolvedValueOnce(
      workspaceStatus([{ path: 'src/a.ts', status: 'modified', additions: 4, deletions: 2 }]),
    )
    await store().load(SESSION, TURN)

    for (const operation of ['stage', 'unstage', 'revert'] as const) {
      const outcome = await store()[operation](SESSION, TURN, ['src/a.ts'])
      expect(refusalOf(outcome)).toBe('read_only_source')
    }
    expect(reviewApi.stage).not.toHaveBeenCalled()
    expect(reviewApi.unstage).not.toHaveBeenCalled()
    expect(reviewApi.revert).not.toHaveBeenCalled()
  })

  it('refuses writes against branch and commit comparisons too', async () => {
    // Both compare against history. The server rejects them; refusing here
    // keeps the request off the wire and gives the panel a reason to show.
    for (const source of [BRANCH, COMMIT]) {
      reviewApi.getStatus.mockResolvedValueOnce(status('snap-ro'))
      await store().load(SESSION, source)
      expect(entry(SESSION, source).readOnly).toBe(true)

      for (const operation of ['stage', 'unstage', 'revert'] as const) {
        expect(refusalOf(await store()[operation](SESSION, source, ['src/a.ts'])))
          .toBe('read_only_source')
      }
    }
    expect(reviewApi.stage).not.toHaveBeenCalled()
    expect(reviewApi.revert).not.toHaveBeenCalled()
  })

  it('keeps staged and unstaged as separate entries for the same session', async () => {
    reviewApi.getStatus.mockResolvedValueOnce(status('snap-unstaged'))
    await store().load(SESSION, UNSTAGED)
    reviewApi.getStatus.mockResolvedValueOnce(status('snap-staged'))
    await store().load(SESSION, STAGED)

    expect(entry(SESSION, UNSTAGED).status?.snapshot).toBe('snap-unstaged')
    expect(entry(SESSION, STAGED).status?.snapshot).toBe('snap-staged')
  })
})

describe('load', () => {
  it('reads the status once and serves the cache until asked to refresh', async () => {
    reviewApi.getStatus.mockResolvedValue(status('snap-1'))
    await store().load(SESSION, UNSTAGED)
    await store().load(SESSION, UNSTAGED)
    expect(reviewApi.getStatus).toHaveBeenCalledTimes(1)

    await store().load(SESSION, UNSTAGED, { force: true })
    expect(reviewApi.getStatus).toHaveBeenCalledTimes(2)
  })

  it('surfaces a failed read as an error rather than an empty change list', async () => {
    reviewApi.getStatus.mockRejectedValueOnce(new Error('git exploded'))
    await store().load(SESSION, UNSTAGED)

    expect(entry().error).toBe('git exploded')
    expect(entry().loading).toBe(false)
    expect(entry().status).toBeNull()
  })

  it('ignores a status response that a newer refresh has already superseded', async () => {
    // Two refreshes can be in flight after a rapid double click; the older
    // answer arriving last would roll the panel back to a stale change list.
    const slow = deferred<ReviewStatusResult>()
    const fast = deferred<ReviewStatusResult>()
    reviewApi.getStatus.mockReturnValueOnce(slow.promise).mockReturnValueOnce(fast.promise)

    const first = store().load(SESSION, UNSTAGED)
    const second = store().load(SESSION, UNSTAGED, { force: true })

    fast.resolve(status('snap-new'))
    await second
    slow.resolve(status('snap-old'))
    await first

    expect(entry().status?.snapshot).toBe('snap-new')
  })
})

describe('snapshot invalidation', () => {
  it('drops every cached per-file diff when the snapshot changes', async () => {
    // This is the data-integrity guard: a hunk read against an old snapshot
    // describes content the user is no longer looking at, and applying it would
    // patch lines that have since moved.
    reviewApi.getStatus.mockResolvedValueOnce(status('snap-1'))
    await store().load(SESSION, UNSTAGED)
    reviewApi.getDiff.mockResolvedValueOnce(diff('src/a.ts', 'snap-1'))
    await store().loadDiff(SESSION, UNSTAGED, 'src/a.ts')
    reviewApi.getDiff.mockResolvedValueOnce(diff('src/b.ts', 'snap-1'))
    await store().loadDiff(SESSION, UNSTAGED, 'src/b.ts')

    expect(Object.keys(entry().diffsByPath)).toEqual(['src/a.ts', 'src/b.ts'])

    reviewApi.getStatus.mockResolvedValueOnce(status('snap-2'))
    await store().load(SESSION, UNSTAGED, { force: true })

    expect(entry().diffsByPath).toEqual({})
    expect(entry().diffLoadingByPath).toEqual({})
  })

  it('keeps cached diffs when a refresh returns the same snapshot', async () => {
    // The counterpart: refreshing an unchanged tree must not re-fetch every
    // open file, or the refresh button becomes a full reload of the panel.
    reviewApi.getStatus.mockResolvedValue(status('snap-1'))
    await store().load(SESSION, UNSTAGED)
    reviewApi.getDiff.mockResolvedValueOnce(diff('src/a.ts', 'snap-1'))
    await store().loadDiff(SESSION, UNSTAGED, 'src/a.ts')

    await store().load(SESSION, UNSTAGED, { force: true })

    expect(entry().diffsByPath['src/a.ts']?.diff).toContain('+new')
  })

  it('drops a diff that arrives for a snapshot the panel has moved past', async () => {
    reviewApi.getStatus.mockResolvedValueOnce(status('snap-2'))
    await store().load(SESSION, UNSTAGED)

    reviewApi.getDiff.mockResolvedValueOnce(diff('src/a.ts', 'snap-1'))
    await store().loadDiff(SESSION, UNSTAGED, 'src/a.ts')

    expect(entry().diffsByPath['src/a.ts']).toBeUndefined()
    expect(entry().diffLoadingByPath['src/a.ts']).toBe(false)
  })

  it('clears cached diffs after a write, because every write moves the snapshot', async () => {
    reviewApi.getStatus.mockResolvedValueOnce(status('snap-1'))
    await store().load(SESSION, UNSTAGED)
    reviewApi.getDiff.mockResolvedValueOnce(diff('src/a.ts', 'snap-1'))
    await store().loadDiff(SESSION, UNSTAGED, 'src/a.ts')

    reviewApi.stage.mockResolvedValueOnce(writeResult({ results: [{ path: 'src/a.ts', ok: true }] }))
    await store().stage(SESSION, UNSTAGED, ['src/a.ts'])

    expect(entry().diffsByPath).toEqual({})
  })
})

describe('loadDiff', () => {
  it('reads each file once and then serves the cache', async () => {
    reviewApi.getStatus.mockResolvedValueOnce(status('snap-1'))
    await store().load(SESSION, UNSTAGED)
    reviewApi.getDiff.mockResolvedValue(diff('src/a.ts', 'snap-1'))

    await store().loadDiff(SESSION, UNSTAGED, 'src/a.ts')
    await store().loadDiff(SESSION, UNSTAGED, 'src/a.ts')

    expect(reviewApi.getDiff).toHaveBeenCalledTimes(1)
  })

  it('passes the pre-rename path so a renamed file can still be diffed', async () => {
    reviewApi.getStatus.mockResolvedValueOnce(status('snap-1'))
    await store().load(SESSION, UNSTAGED)
    reviewApi.getDiff.mockResolvedValueOnce(diff('src/new.ts', 'snap-1'))

    await store().loadDiff(SESSION, UNSTAGED, 'src/new.ts', 'src/old.ts')

    expect(reviewApi.getDiff).toHaveBeenCalledWith(SESSION, UNSTAGED, 'src/new.ts', 'src/old.ts')
  })

  it('records a failed read as an error diff instead of an endless spinner', async () => {
    reviewApi.getStatus.mockResolvedValueOnce(status('snap-1'))
    await store().load(SESSION, UNSTAGED)
    reviewApi.getDiff.mockRejectedValueOnce(new Error('bad object'))

    await store().loadDiff(SESSION, UNSTAGED, 'src/a.ts')

    expect(entry().diffsByPath['src/a.ts']).toMatchObject({ state: 'error', error: 'bad object' })
    expect(entry().diffLoadingByPath['src/a.ts']).toBe(false)
  })
})

describe('writes', () => {
  it('refuses a write when no snapshot has been read, and says why', async () => {
    // Without a snapshot the server has nothing to compare against, so its
    // "did the tree move?" check would pass unconditionally. Refusing here is
    // what keeps that guard from being inert — and the caller gets a reason
    // rather than a `null` that renders as nothing happening at all.
    const result = await store().stage(SESSION, UNSTAGED, ['src/a.ts'])

    expect(refusalOf(result)).toBe('no_snapshot')
    expect(result.results).toEqual([])
    expect(reviewApi.stage).not.toHaveBeenCalled()
  })

  it('refuses a write with no paths, and says why', async () => {
    reviewApi.getStatus.mockResolvedValueOnce(status('snap-1'))
    await store().load(SESSION, UNSTAGED)

    expect(refusalOf(await store().revert(SESSION, UNSTAGED, []))).toBe('no_paths')
    expect(reviewApi.revert).not.toHaveBeenCalled()
  })

  it('carries the snapshot the user was looking at into every write', async () => {
    reviewApi.getStatus.mockResolvedValueOnce(status('snap-1'))
    await store().load(SESSION, UNSTAGED)
    reviewApi.unstage.mockResolvedValueOnce(writeResult())

    await store().unstage(SESSION, UNSTAGED, ['src/a.ts'])

    expect(reviewApi.unstage).toHaveBeenCalledWith(SESSION, {
      paths: ['src/a.ts'],
      snapshot: 'snap-1',
      source: UNSTAGED,
    })
  })

  it('flags a stale result and keeps the status the user was reading', async () => {
    // `stale` means the server applied nothing. Replacing the status here would
    // hide the fact that the listed changes are the ones the write was refused
    // against, and the UI is supposed to ask for a refresh instead of retrying.
    reviewApi.getStatus.mockResolvedValueOnce(status('snap-1'))
    await store().load(SESSION, UNSTAGED)
    const before = entry().status

    reviewApi.revert.mockResolvedValueOnce(writeResult({ state: 'stale', error: 'snapshot moved' }))
    const result = await store().revert(SESSION, UNSTAGED, ['src/a.ts'])

    expect(result?.state).toBe('stale')
    expect(entry().stale).toBe(true)
    expect(entry().status).toBe(before)
    // A stale answer is not an operation error — the banner explains it.
    expect(entry().error).toBeNull()
    expect(reviewApi.revert).toHaveBeenCalledTimes(1)
    expect(reviewApi.getStatus).toHaveBeenCalledTimes(1)
  })

  it('requires fresh status before clearing stale with a new write', async () => {
    reviewApi.getStatus.mockResolvedValueOnce(status('snap-1'))
    await store().load(SESSION, UNSTAGED)
    reviewApi.stage.mockResolvedValueOnce(writeResult({ state: 'stale' }))
    await store().stage(SESSION, UNSTAGED, ['src/a.ts'])

    reviewApi.getStatus.mockResolvedValueOnce(status('snap-2'))
    await store().load(SESSION, UNSTAGED, { force: true })
    reviewApi.stage.mockResolvedValueOnce(writeResult({ status: status('snap-2') }))
    await store().stage(SESSION, UNSTAGED, ['src/a.ts'])

    expect(entry().stale).toBe(false)
    expect(entry().status?.snapshot).toBe('snap-2')
  })

  it('remembers where a discard backed the content up', async () => {
    reviewApi.getStatus.mockResolvedValueOnce(status('snap-1'))
    await store().load(SESSION, UNSTAGED)
    reviewApi.revert.mockResolvedValueOnce(writeResult({ backupDir: '/tmp/cc-haha-backup-1' }))

    await store().revert(SESSION, UNSTAGED, ['src/a.ts'])

    expect(entry().lastBackupDir).toBe('/tmp/cc-haha-backup-1')
  })
})

describe('viewed marks', () => {
  it('toggles a path on and off without disturbing the others', () => {
    store().toggleViewed(SESSION, UNSTAGED, 'src/a.ts')
    store().toggleViewed(SESSION, UNSTAGED, 'src/b.ts')
    expect(entry().viewedPaths).toEqual(['src/a.ts', 'src/b.ts'])

    store().toggleViewed(SESSION, UNSTAGED, 'src/a.ts')
    expect(entry().viewedPaths).toEqual(['src/b.ts'])
  })
})

describe('clearSession', () => {
  it('drops only the entries of the session that ended', async () => {
    reviewApi.getStatus.mockResolvedValueOnce(status('snap-a'))
    await store().load(SESSION, UNSTAGED)
    reviewApi.getStatus.mockResolvedValueOnce(status('snap-a-staged'))
    await store().load(SESSION, STAGED)
    reviewApi.getStatus.mockResolvedValueOnce(status('snap-b'))
    await store().load(OTHER, UNSTAGED)

    store().clearSession(SESSION)

    expect(entry(SESSION, UNSTAGED).status).toBeNull()
    expect(entry(SESSION, STAGED).status).toBeNull()
    expect(entry(OTHER, UNSTAGED).status?.snapshot).toBe('snap-b')
  })

  it('discards a response that was already in flight when the session was cleared', async () => {
    // Otherwise a slow read repopulates the cache of a task the user has closed.
    const pending = deferred<ReviewStatusResult>()
    reviewApi.getStatus.mockReturnValueOnce(pending.promise)

    const load = store().load(SESSION, UNSTAGED)
    store().clearSession(SESSION)
    pending.resolve(status('snap-1'))
    await load

    expect(entry(SESSION, UNSTAGED).status).toBeNull()
  })
})

describe('revert planning', () => {
  const TRACKED = 'src/a.ts'
  const NEW_FILE = 'src/brand-new.ts'

  async function loadMixed() {
    reviewApi.getStatus.mockResolvedValueOnce(status('snap-1', {
      files: [file(TRACKED), file(NEW_FILE, { status: 'untracked' })],
      untracked: [NEW_FILE],
    }))
    await store().load(SESSION, UNSTAGED)
  }

  /**
   * The per-file discard on an untracked file runs `fs.rm`: Git has never
   * stored the content, so nothing but the server-side backup survives. The
   * confirmation has to name that, which means the store has to distinguish
   * the two outcomes before the write instead of after it.
   */
  it('separates files that get restored from files that get deleted', async () => {
    await loadMixed()

    expect(store().describeRevert(SESSION, UNSTAGED, [TRACKED, NEW_FILE])).toEqual({
      revertPaths: [TRACKED],
      deletePaths: [NEW_FILE],
      unknownPaths: [],
    })
    expect(store().describeRevert(SESSION, UNSTAGED, [NEW_FILE])).toEqual({
      revertPaths: [],
      deletePaths: [NEW_FILE],
      unknownPaths: [],
    })
    expect(store().describeRevert(SESSION, UNSTAGED, [TRACKED])).toEqual({
      revertPaths: [TRACKED],
      deletePaths: [],
      unknownPaths: [],
    })
  })

  it('reports a path the loaded status does not describe instead of guessing', async () => {
    await loadMixed()

    expect(store().describeRevert(SESSION, UNSTAGED, ['src/gone.ts'])).toEqual({
      revertPaths: [],
      deletePaths: [],
      unknownPaths: ['src/gone.ts'],
    })
    // Nothing loaded at all: every path is unknown, not "safe to revert".
    expect(store().describeRevert(OTHER, UNSTAGED, [TRACKED])).toEqual({
      revertPaths: [],
      deletePaths: [],
      unknownPaths: [TRACKED],
    })
  })

  it('remembers which paths a revert deleted rather than restored', async () => {
    await loadMixed()
    reviewApi.revert.mockResolvedValueOnce(writeResult({
      backupDir: '/tmp/cc-haha-backup-1',
      revertedPaths: [TRACKED],
      deletedPaths: [NEW_FILE],
      results: [
        { path: TRACKED, ok: true, action: 'reverted' },
        { path: NEW_FILE, ok: true, action: 'deleted' },
      ],
    }))

    const outcome = await store().revert(SESSION, UNSTAGED, [TRACKED, NEW_FILE])

    expect(outcome.state).toBe('ok')
    expect(entry().lastDeletedPaths).toEqual([NEW_FILE])
    expect(entry().lastBackupDir).toBe('/tmp/cc-haha-backup-1')
  })

  it('clears the deleted list when the next write deletes nothing', async () => {
    await loadMixed()
    reviewApi.revert.mockResolvedValueOnce(writeResult({ deletedPaths: [NEW_FILE] }))
    await store().revert(SESSION, UNSTAGED, [NEW_FILE])
    expect(entry().lastDeletedPaths).toEqual([NEW_FILE])

    reviewApi.stage.mockResolvedValueOnce(writeResult())
    await store().stage(SESSION, UNSTAGED, [TRACKED])

    // Otherwise the panel keeps warning about a deletion that already happened.
    expect(entry().lastDeletedPaths).toEqual([])
  })
})

describe('unavailable worktree', () => {
  /**
   * `missing_workdir` used to arrive with no message, so the panel fell through
   * to its empty state and showed a green "no changes" check for a worktree
   * that had been deleted.
   */
  it('surfaces a missing worktree instead of an empty change list', async () => {
    reviewApi.getStatus.mockResolvedValueOnce(status('', {
      state: 'missing_workdir',
      files: [],
      totals: { additions: 0, deletions: 0, files: 0 },
      error: 'The session working directory no longer exists, so there is nothing to compare',
    }))

    await store().load(SESSION, UNSTAGED)

    expect(entry().status?.state).toBe('missing_workdir')
    expect(entry().error).toContain('no longer exists')
    expect(entry().loading).toBe(false)
    // A clean tree and a deleted worktree both have zero files; only the error
    // separates them for the panel.
    expect(entry().status?.files).toEqual([])
  })

  it('keeps a clean tree free of any error', async () => {
    reviewApi.getStatus.mockResolvedValueOnce(status('snap-clean', {
      files: [],
      totals: { additions: 0, deletions: 0, files: 0 },
    }))

    await store().load(SESSION, UNSTAGED)

    expect(entry().status?.state).toBe('ok')
    expect(entry().error).toBeNull()
  })
})

describe('diff request fan-out', () => {
  it('issues one request per file even when re-rendered while it is in flight', async () => {
    reviewApi.getStatus.mockResolvedValueOnce(status('snap-1'))
    await store().load(SESSION, UNSTAGED)

    const pending = deferred<ReviewDiffResult>()
    reviewApi.getDiff.mockReturnValueOnce(pending.promise)

    // Two renders of the same file list before the first answer arrives. The
    // cache check alone does not see the first request, because nothing has
    // been written to `diffsByPath` yet.
    const first = store().loadDiff(SESSION, UNSTAGED, 'src/a.ts')
    const second = store().loadDiff(SESSION, UNSTAGED, 'src/a.ts')
    const third = store().loadDiff(SESSION, UNSTAGED, 'src/a.ts')

    expect(reviewApi.getDiff).toHaveBeenCalledTimes(1)

    pending.resolve(diff('src/a.ts', 'snap-1'))
    await Promise.all([first, second, third])

    expect(reviewApi.getDiff).toHaveBeenCalledTimes(1)
    expect(entry().diffsByPath['src/a.ts']?.diff).toContain('+new')
  })

  it('retries a mismatched file only after explicit status refresh', async () => {
    reviewApi.getStatus.mockResolvedValueOnce(status('snap-1'))
    await store().load(SESSION, UNSTAGED)

    const stale = deferred<ReviewDiffResult>()
    reviewApi.getDiff.mockReturnValueOnce(stale.promise)
    const pendingLoad = store().loadDiff(SESSION, UNSTAGED, 'src/a.ts')
    // A diff for a snapshot the panel moved past is discarded, which clears
    // the in-flight flag without filling the cache.
    stale.resolve(diff('src/a.ts', 'snap-old'))
    await pendingLoad
    expect(entry().diffsByPath['src/a.ts']).toBeUndefined()
    expect(entry().diffLoadingByPath['src/a.ts']).toBe(false)

    reviewApi.getStatus.mockResolvedValueOnce(status('snap-1'))
    await store().load(SESSION, UNSTAGED, { force: true })
    reviewApi.getDiff.mockResolvedValueOnce(diff('src/a.ts', 'snap-1'))
    await store().loadDiff(SESSION, UNSTAGED, 'src/a.ts')
    expect(reviewApi.getDiff).toHaveBeenCalledTimes(2)
  })

  it('guards the session-changes diff against the same duplicate request', async () => {
    sessionsApi.getTurnCheckpoints.mockResolvedValueOnce(
      workspaceStatus([{ path: 'src/a.ts', status: 'modified', additions: 1, deletions: 0 }]),
    )
    await store().load(SESSION, TURN)

    const pending = deferred<{ state: 'ok'; path: string; diff: string }>()
    sessionsApi.getTurnCheckpointDiff.mockReturnValueOnce(pending.promise)

    const first = store().loadDiff(SESSION, TURN, 'src/a.ts')
    const second = store().loadDiff(SESSION, TURN, 'src/a.ts')
    expect(sessionsApi.getTurnCheckpointDiff).toHaveBeenCalledTimes(1)

    pending.resolve({ state: 'ok', path: 'src/a.ts', diff: 'x' })
    await Promise.all([first, second])
    expect(sessionsApi.getTurnCheckpointDiff).toHaveBeenCalledTimes(1)
  })
})

describe('turn review labels', () => {
  const NEW_KEYS = [
    'workspace.review.sourceTurnHint',
    'workspace.review.readOnlySource',
    'workspace.review.revertDeleteTitle',
    'workspace.review.revertTrackedBody',
    'workspace.review.revertDeleteBody',
    'workspace.review.revertDeleteList',
    'workspace.review.revertDeleted',
    'workspace.review.missingWorkdir',
    'workspace.review.refusedNoSnapshot',
    'workspace.review.diffTruncated',
    'workspace.review.statsTruncated',
  ] as const

  it('carries the review keys the panel needs in every locale', () => {
    for (const locale of ['en', 'zh', 'zh-TW', 'jp', 'kr'] as const) {
      for (const key of NEW_KEYS) {
        expect(translate(locale, key), `${locale} is missing ${key}`).not.toBe(key)
      }
      // A locale that drops the placeholder would show the deletion warning
      // without saying how many files, or the list without any paths.
      expect(translate(locale, 'workspace.review.revertDeleteBody', { count: 3 })).toContain('3')
      expect(translate(locale, 'workspace.review.revertTrackedBody', { count: 2 })).toContain('2')
      expect(
        translate(locale, 'workspace.review.revertDeleteList', { paths: 'a.txt, b.txt' }),
      ).toContain('a.txt, b.txt')
      const deleted = translate(locale, 'workspace.review.revertDeleted', {
        count: 1,
        path: '/tmp/backup',
      })
      expect(deleted).toContain('1')
      expect(deleted).toContain('/tmp/backup')
    }
  })
})


describe('frozen turn identity and stale generations', () => {
  it('keeps a partial frozen checkpoint visibly unavailable even when it contains a successful file', async () => {
    const checkpoint = workspaceStatus([{ path: 'src/a.ts' }]).checkpoints[0]!
    sessionsApi.getTurnCheckpoints.mockResolvedValue({ checkpoints: [{
      ...checkpoint,
      code: { ...checkpoint.code, available: false, reason: 'Recorded file history is incomplete for: src/b.ts' },
      restoreAvailable: false,
    }] })
    await store().load(SESSION, TURN)
    expect(entry(SESSION, TURN).status?.state).toBe('error')
    expect(entry(SESSION, TURN).status?.files).toHaveLength(1)
    expect(entry(SESSION, TURN).error).toContain('src/b.ts')
    expect(entry(SESSION, TURN).readOnly).toBe(true)
    expect(sessionsApi.getWorkspaceStatus).not.toHaveBeenCalled()
    expect(sessionsApi.getWorkspaceDiff).not.toHaveBeenCalled()
  })

  it('uses distinct checkpoint identities for two turns touching the same path and never reads live Git', async () => {
    const first = { kind: 'turn', turnKey: 't1', userMessageIndex: 0 } as const
    const second = { kind: 'turn', turnKey: 't2', userMessageIndex: 1 } as const
    sessionsApi.getTurnCheckpoints.mockResolvedValue({ checkpoints: [
      { ...workspaceStatus([{ path: 'src/a.ts' }]).checkpoints[0], target: { targetUserMessageId: 't1', userMessageIndex: 0 } },
      { ...workspaceStatus([{ path: 'src/a.ts' }]).checkpoints[0], target: { targetUserMessageId: 't2', userMessageIndex: 1 } },
    ] })
    sessionsApi.getTurnCheckpointDiff.mockImplementation((_session, turn) => Promise.resolve({ state: 'ok', path: 'src/a.ts', diff: `frozen ${turn}` }))
    for (const source of [first, second]) {
      await store().load(SESSION, source)
      await store().loadDiff(SESSION, source, 'src/a.ts')
      expect(sessionsApi.getTurnCheckpointDiff).toHaveBeenCalledWith(SESSION, source.turnKey, 'src/a.ts', source.userMessageIndex, true)
      expect(entry(SESSION, source).diffsByPath['src/a.ts']?.diff).toBe(`frozen ${source.turnKey}`)
    }
    expect(sessionsApi.getWorkspaceStatus).not.toHaveBeenCalled()
    expect(sessionsApi.getWorkspaceDiff).not.toHaveBeenCalled()
    expect(reviewApi.getDiff).not.toHaveBeenCalled()
  })

  it('reports missing historical data without requesting the live workspace fallback', async () => {
    sessionsApi.getTurnCheckpoints.mockResolvedValue({ checkpoints: [] })
    await store().load(SESSION, TURN)
    expect(entry(SESSION, TURN).error).toContain('unavailable')
    expect(sessionsApi.getWorkspaceStatus).not.toHaveBeenCalled()
  })

  it('does not recreate a cleared task from a delayed diff', async () => {
    reviewApi.getStatus.mockResolvedValue(status('snap-1'))
    await store().load(SESSION, UNSTAGED)
    const response = deferred<ReviewDiffResult>()
    reviewApi.getDiff.mockReturnValue(response.promise)
    const pending = store().loadDiff(SESSION, UNSTAGED, 'src/a.ts')
    store().clearSession(SESSION)
    response.resolve(diff('src/a.ts', 'snap-1'))
    await pending
    expect(store().byKey).toEqual({})
  })
})


it('invalidates persisted viewed marks when the server snapshot changes', async () => {
  store().restoreViewed(SESSION, UNSTAGED, ['src/a.ts'], 'old-snapshot')
  reviewApi.getStatus.mockResolvedValue(status('new-snapshot'))
  await store().load(SESSION, UNSTAGED)
  expect(entry().viewedPaths).toEqual([])
  store().toggleViewed(SESSION, UNSTAGED, 'src/a.ts')
  expect(entry().viewedSnapshot).toBe('new-snapshot')
  await store().load(SESSION, UNSTAGED, { force: true })
  expect(entry().viewedPaths).toEqual(['src/a.ts'])
})
