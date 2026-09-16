import { afterEach, describe, expect, it } from 'bun:test'
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { collectPatchPaths, ReviewService, type ReviewSource } from './reviewService.js'

const SESSION = 'session-review'
const cleanupDirs = new Set<string>()

afterEach(async () => {
  for (const dir of cleanupDirs) {
    await fs.rm(dir, { recursive: true, force: true })
  }
  cleanupDirs.clear()
})

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  cleanupDirs.add(dir)
  return dir
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' })
}

function tryGit(cwd: string, ...args: string[]): void {
  try {
    git(cwd, ...args)
  } catch {
    // Conflict fixtures rely on commands that exit non-zero by design.
  }
}

/** Fresh repository with committer identity, an explicit `main`, and no commits. */
async function initRepo(prefix = 'review-service-'): Promise<string> {
  const repoDir = await makeTempDir(prefix)
  git(repoDir, 'init')
  git(repoDir, 'config', 'user.email', 'review-service@example.com')
  git(repoDir, 'config', 'user.name', 'Review Service')
  git(repoDir, 'config', 'commit.gpgsign', 'false')
  git(repoDir, 'checkout', '-q', '-b', 'main')
  return repoDir
}

function makeService(workDir: string | null, backupRoot?: string): ReviewService {
  return new ReviewService(
    async (sessionId) => (sessionId === SESSION ? workDir : null),
    backupRoot ? { backupRoot } : {},
  )
}

async function write(repoDir: string, relativePath: string, content: string): Promise<void> {
  const target = path.join(repoDir, relativePath)
  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.writeFile(target, content)
}

const UNSTAGED: ReviewSource = { kind: 'unstaged' }
const STAGED: ReviewSource = { kind: 'staged' }
const UNCOMMITTED: ReviewSource = { kind: 'uncommitted' }

/**
 * tracked.txt (10 lines, committed) modified in the working tree,
 * staged-only.txt staged, untracked.txt untracked, binary.dat modified.
 */
async function createMixedRepo(): Promise<string> {
  const repoDir = await initRepo()
  await write(repoDir, 'tracked.txt', 'l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nl9\nl10\n')
  await write(repoDir, 'staged-only.txt', 'staged base\n')
  await fs.writeFile(path.join(repoDir, 'binary.dat'), Buffer.from([0, 1, 2, 3, 0, 4]))
  git(repoDir, 'add', '-A')
  git(repoDir, 'commit', '-m', 'initial')

  await write(repoDir, 'tracked.txt', 'L1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nl9\nL10\n')
  await write(repoDir, 'staged-only.txt', 'staged base\nstaged change\n')
  git(repoDir, 'add', 'staged-only.txt')
  await fs.writeFile(path.join(repoDir, 'binary.dat'), Buffer.from([0, 9, 9, 9, 0, 4, 7]))
  await write(repoDir, 'untracked.txt', 'brand new\n')

  return repoDir
}

describe('ReviewService sources', () => {
  it('reports index -> working tree for unstaged, with untracked listed separately', async () => {
    const repoDir = await createMixedRepo()
    const service = makeService(repoDir)

    const result = await service.getStatus(SESSION, UNSTAGED)

    expect(result.state).toBe('ok')
    expect(result.source).toEqual({ kind: 'unstaged' })
    expect(result.files.map((file) => file.path).sort()).toEqual([
      'binary.dat',
      'tracked.txt',
      'untracked.txt',
    ])
    // staged-only.txt is identical in index and working tree, so it is NOT an
    // unstaged change — the old HEAD-based diff could not express that.
    expect(result.files.some((file) => file.path === 'staged-only.txt')).toBe(false)
    expect(result.untracked).toEqual(['untracked.txt'])

    const tracked = result.files.find((file) => file.path === 'tracked.txt')
    expect(tracked).toMatchObject({
      status: 'modified',
      additions: 2,
      deletions: 2,
      binary: false,
      staged: false,
      unstaged: true,
      conflicted: false,
    })
    expect(result.files.find((file) => file.path === 'binary.dat')?.binary).toBe(true)
    expect(result.files.find((file) => file.path === 'untracked.txt')).toMatchObject({
      status: 'untracked',
      additions: 1,
      deletions: 0,
    })
    expect(result.totals.files).toBe(3)
  })

  it('reports HEAD -> index for staged and excludes untracked files', async () => {
    const repoDir = await createMixedRepo()
    const service = makeService(repoDir)

    const result = await service.getStatus(SESSION, STAGED)

    expect(result.state).toBe('ok')
    expect(result.files.map((file) => file.path)).toEqual(['staged-only.txt'])
    expect(result.untracked).toEqual([])
    expect(result.files[0]).toMatchObject({
      status: 'modified',
      additions: 1,
      deletions: 0,
      staged: true,
      unstaged: false,
    })
    expect(result.source).toMatchObject({ kind: 'staged' })
    expect(result.source.resolvedBase).toBe(git(repoDir, 'rev-parse', 'HEAD').trim())
  })

  it('reports HEAD -> working tree for uncommitted, including untracked files', async () => {
    const repoDir = await createMixedRepo()
    const service = makeService(repoDir)

    const result = await service.getStatus(SESSION, UNCOMMITTED)

    expect(result.state).toBe('ok')
    expect(result.files.map((file) => file.path).sort()).toEqual([
      'binary.dat',
      'staged-only.txt',
      'tracked.txt',
      'untracked.txt',
    ])
    expect(result.untracked).toEqual(['untracked.txt'])
    expect(result.totals.files).toBe(4)
  })

  it('separates staged and unstaged halves of the same file', async () => {
    const repoDir = await initRepo()
    await write(repoDir, 'both.txt', 'one\n')
    git(repoDir, 'add', '-A')
    git(repoDir, 'commit', '-m', 'initial')

    await write(repoDir, 'both.txt', 'one\ntwo\n')
    git(repoDir, 'add', 'both.txt')
    await write(repoDir, 'both.txt', 'one\ntwo\nthree\n')

    const service = makeService(repoDir)
    const staged = await service.getStatus(SESSION, STAGED)
    const unstaged = await service.getStatus(SESSION, UNSTAGED)
    const uncommitted = await service.getStatus(SESSION, UNCOMMITTED)

    expect(staged.files[0]).toMatchObject({ path: 'both.txt', additions: 1, deletions: 0 })
    expect(unstaged.files[0]).toMatchObject({ path: 'both.txt', additions: 1, deletions: 0 })
    expect(uncommitted.files[0]).toMatchObject({ path: 'both.txt', additions: 2, deletions: 0 })
    // Same file, both columns set — the UI needs this to offer stage and revert
    // independently.
    expect(unstaged.files[0]).toMatchObject({ staged: true, unstaged: true })
  })

  it('resolves the merge-base for a branch source and includes uncommitted work', async () => {
    const repoDir = await initRepo()
    await write(repoDir, 'base.txt', 'base\n')
    git(repoDir, 'add', '-A')
    git(repoDir, 'commit', '-m', 'base')
    const mergeBase = git(repoDir, 'rev-parse', 'HEAD').trim()

    git(repoDir, 'checkout', '-q', '-b', 'feature')
    await write(repoDir, 'feature.txt', 'feature\n')
    git(repoDir, 'add', '-A')
    git(repoDir, 'commit', '-m', 'feature commit')

    git(repoDir, 'checkout', '-q', 'main')
    await write(repoDir, 'main-only.txt', 'main\n')
    git(repoDir, 'add', '-A')
    git(repoDir, 'commit', '-m', 'main commit')
    git(repoDir, 'checkout', '-q', 'feature')

    // Uncommitted edit on the feature branch: a `base..HEAD` comparison would
    // hide it, a single-revision diff shows it.
    await write(repoDir, 'base.txt', 'base\nuncommitted\n')

    const service = makeService(repoDir)
    const result = await service.getStatus(SESSION, { kind: 'branch', baseRef: 'main' })

    expect(result.state).toBe('ok')
    expect(result.source).toMatchObject({ kind: 'branch', baseRef: 'main', resolvedBase: mergeBase })
    expect(result.files.map((file) => file.path).sort()).toEqual(['base.txt', 'feature.txt'])
    expect(result.files.some((file) => file.path === 'main-only.txt')).toBe(false)
  })

  it('reports an unknown base ref instead of silently falling back', async () => {
    const repoDir = await createMixedRepo()
    const service = makeService(repoDir)

    const result = await service.getStatus(SESSION, { kind: 'branch', baseRef: 'no-such-branch' })

    expect(result.state).toBe('error')
    expect(result.error).toContain('Unknown base ref')
    expect(result.files).toEqual([])
  })

  it('compares a commit against its parent', async () => {
    const repoDir = await initRepo()
    await write(repoDir, 'file.txt', 'one\n')
    git(repoDir, 'add', '-A')
    git(repoDir, 'commit', '-m', 'root')
    const rootSha = git(repoDir, 'rev-parse', 'HEAD').trim()

    await write(repoDir, 'file.txt', 'one\ntwo\n')
    await write(repoDir, 'second.txt', 'second\n')
    git(repoDir, 'add', '-A')
    git(repoDir, 'commit', '-m', 'second')
    const secondSha = git(repoDir, 'rev-parse', 'HEAD').trim()

    const service = makeService(repoDir)
    const result = await service.getStatus(SESSION, { kind: 'commit', commit: secondSha })

    expect(result.state).toBe('ok')
    expect(result.source).toMatchObject({ kind: 'commit', commit: secondSha, resolvedBase: rootSha })
    expect(result.files.map((file) => file.path).sort()).toEqual(['file.txt', 'second.txt'])
    expect(result.files.find((file) => file.path === 'second.txt')?.status).toBe('added')
    // Historical comparison: working-tree columns stay off.
    expect(result.files.every((file) => !file.staged && !file.unstaged)).toBe(true)
  })

  it('compares a root commit against the empty tree', async () => {
    const repoDir = await initRepo()
    await write(repoDir, 'first.txt', 'a\nb\n')
    git(repoDir, 'add', '-A')
    git(repoDir, 'commit', '-m', 'root')
    const rootSha = git(repoDir, 'rev-parse', 'HEAD').trim()
    const emptyTree = git(repoDir, 'hash-object', '-t', 'tree', '/dev/null').trim()

    const service = makeService(repoDir)
    const result = await service.getStatus(SESSION, { kind: 'commit', commit: rootSha })

    expect(result.state).toBe('ok')
    expect(result.source.resolvedBase).toBe(emptyTree)
    expect(result.files).toHaveLength(1)
    expect(result.files[0]).toMatchObject({ path: 'first.txt', status: 'added', additions: 2 })
  })

  it('reports renames with their old path', async () => {
    const repoDir = await initRepo()
    await write(repoDir, 'old-name.txt', 'alpha\nbeta\ngamma\n')
    git(repoDir, 'add', '-A')
    git(repoDir, 'commit', '-m', 'initial')
    git(repoDir, 'mv', 'old-name.txt', 'new-name.txt')

    const service = makeService(repoDir)
    const result = await service.getStatus(SESSION, STAGED)

    expect(result.files).toHaveLength(1)
    expect(result.files[0]).toMatchObject({
      path: 'new-name.txt',
      oldPath: 'old-name.txt',
      status: 'renamed',
    })
  })

  it('marks unmerged paths as conflicted', async () => {
    const repoDir = await initRepo()
    await write(repoDir, 'conflict.txt', 'base\n')
    git(repoDir, 'add', '-A')
    git(repoDir, 'commit', '-m', 'base')
    git(repoDir, 'checkout', '-q', '-b', 'other')
    await write(repoDir, 'conflict.txt', 'other side\n')
    git(repoDir, 'add', '-A')
    git(repoDir, 'commit', '-m', 'other')
    git(repoDir, 'checkout', '-q', 'main')
    await write(repoDir, 'conflict.txt', 'my side\n')
    git(repoDir, 'add', '-A')
    git(repoDir, 'commit', '-m', 'mine')
    tryGit(repoDir, 'merge', 'other')

    const service = makeService(repoDir)
    const result = await service.getStatus(SESSION, UNSTAGED)
    const conflicted = result.files.find((file) => file.path === 'conflict.txt')

    expect(conflicted).toMatchObject({ status: 'conflicted', conflicted: true })

    // Hunk-level operations are not offered for unmerged paths.
    const hunk = await service.stageHunk(SESSION, {
      patch: [
        'diff --git a/conflict.txt b/conflict.txt',
        '--- a/conflict.txt',
        '+++ b/conflict.txt',
        '@@ -1 +1 @@',
        '-my side',
        '+resolved',
      ].join('\n'),
      snapshot: result.snapshot,
    })
    expect(hunk.state).toBe('error')
    expect(hunk.error).toContain('whole-file')
  })

  it('scopes the review to a session workdir inside a larger repository', async () => {
    const repoDir = await initRepo()
    await write(repoDir, 'root.txt', 'root\n')
    await write(repoDir, 'sub/inside.txt', 'inside\n')
    git(repoDir, 'add', '-A')
    git(repoDir, 'commit', '-m', 'initial')
    await write(repoDir, 'root.txt', 'root changed\n')
    await write(repoDir, 'sub/inside.txt', 'inside changed\n')

    const service = makeService(path.join(repoDir, 'sub'))
    const result = await service.getStatus(SESSION, UNSTAGED)

    expect(result.files.map((file) => file.path)).toEqual(['inside.txt'])
  })
})

describe('ReviewService diffs', () => {
  it('returns a per-file diff for the requested source only', async () => {
    const repoDir = await createMixedRepo()
    const service = makeService(repoDir)

    const unstaged = await service.getFileDiff(SESSION, { source: UNSTAGED, path: 'tracked.txt' })
    expect(unstaged.state).toBe('ok')
    expect(unstaged.diff).toContain('+L1')

    // staged-only.txt has no unstaged content, so it is absent from that diff.
    const absent = await service.getFileDiff(SESSION, { source: UNSTAGED, path: 'staged-only.txt' })
    expect(absent.state).toBe('missing')

    const staged = await service.getFileDiff(SESSION, { source: STAGED, path: 'staged-only.txt' })
    expect(staged.state).toBe('ok')
    expect(staged.diff).toContain('+staged change')
  })

  it('synthesizes a new-file diff for untracked files', async () => {
    const repoDir = await createMixedRepo()
    const service = makeService(repoDir)

    const result = await service.getFileDiff(SESSION, { source: UNSTAGED, path: 'untracked.txt' })

    expect(result.state).toBe('ok')
    expect(result.diff).toContain('new file mode')
    expect(result.diff).toContain('+brand new')
    expect(result.binary).toBe(false)
  })

  it('flags binary diffs instead of streaming their bytes', async () => {
    const repoDir = await createMixedRepo()
    const service = makeService(repoDir)

    const result = await service.getFileDiff(SESSION, { source: UNSTAGED, path: 'binary.dat' })

    expect(result.state).toBe('ok')
    expect(result.binary).toBe(true)
    expect(result.diff).toContain('Binary files')
  })
})

describe('ReviewService write operations', () => {
  it('stages and unstages a file, flipping its columns back and forth', async () => {
    const repoDir = await createMixedRepo()
    const service = makeService(repoDir)

    const before = await service.getStatus(SESSION, UNSTAGED)
    const staged = await service.stage(SESSION, {
      paths: ['tracked.txt'],
      snapshot: before.snapshot,
      source: UNSTAGED,
    })

    expect(staged.state).toBe('ok')
    expect(staged.results).toEqual([{ path: 'tracked.txt', ok: true, action: 'staged' }])
    expect(staged.snapshot).not.toBe(before.snapshot)
    expect(staged.status?.files.some((file) => file.path === 'tracked.txt')).toBe(false)

    const afterStage = await service.getStatus(SESSION, STAGED)
    expect(afterStage.files.map((file) => file.path).sort()).toEqual([
      'staged-only.txt',
      'tracked.txt',
    ])

    const unstaged = await service.unstage(SESSION, {
      paths: ['tracked.txt'],
      snapshot: afterStage.snapshot,
      source: STAGED,
    })
    expect(unstaged.state).toBe('ok')

    const afterUnstage = await service.getStatus(SESSION, UNSTAGED)
    expect(afterUnstage.files.some((file) => file.path === 'tracked.txt')).toBe(true)
    expect(
      (await service.getStatus(SESSION, STAGED)).files.map((file) => file.path),
    ).toEqual(['staged-only.txt'])
  })

  it('stages untracked files through the same path', async () => {
    const repoDir = await createMixedRepo()
    const service = makeService(repoDir)

    const before = await service.getStatus(SESSION, UNSTAGED)
    const result = await service.stage(SESSION, {
      paths: ['untracked.txt'],
      snapshot: before.snapshot,
    })

    expect(result.state).toBe('ok')
    const staged = await service.getStatus(SESSION, STAGED)
    expect(staged.files.find((file) => file.path === 'untracked.txt')?.status).toBe('added')
  })

  it('applies only the hunk it is given', async () => {
    const repoDir = await createMixedRepo()
    const service = makeService(repoDir)

    const before = await service.getStatus(SESSION, UNSTAGED)
    const diff = await service.getFileDiff(SESSION, { source: UNSTAGED, path: 'tracked.txt' })
    const firstHunk = takeFirstHunk(diff.diff ?? '')
    expect(firstHunk).toContain('+L1')
    expect(firstHunk).not.toContain('+L10')

    const applied = await service.stageHunk(SESSION, {
      patch: firstHunk,
      snapshot: before.snapshot,
    })
    expect(applied.state).toBe('ok')

    const stagedDiff = await service.getFileDiff(SESSION, { source: STAGED, path: 'tracked.txt' })
    expect(stagedDiff.diff).toContain('+L1')
    expect(stagedDiff.diff).not.toContain('+L10')

    const remaining = await service.getFileDiff(SESSION, { source: UNSTAGED, path: 'tracked.txt' })
    expect(remaining.diff).toContain('+L10')
    expect(remaining.diff).not.toContain('+L1\n')

    // And back out again.
    const current = await service.getStatus(SESSION, STAGED)
    const reversed = await service.unstageHunk(SESSION, {
      patch: firstHunk,
      snapshot: current.snapshot,
    })
    expect(reversed.state).toBe('ok')
    const afterReverse = await service.getFileDiff(SESSION, { source: STAGED, path: 'tracked.txt' })
    expect(afterReverse.state).toBe('missing')
  })

  it('rejects a patch that spans more than one file', async () => {
    const repoDir = await createMixedRepo()
    const service = makeService(repoDir)
    const before = await service.getStatus(SESSION, UNSTAGED)

    const result = await service.stageHunk(SESSION, {
      patch: [
        'diff --git a/tracked.txt b/tracked.txt',
        '--- a/tracked.txt',
        '+++ b/tracked.txt',
        '@@ -1 +1 @@',
        '-l1',
        '+L1',
        'diff --git a/other.txt b/other.txt',
        '--- a/other.txt',
        '+++ b/other.txt',
        '@@ -1 +1 @@',
        '-x',
        '+y',
      ].join('\n'),
      snapshot: before.snapshot,
    })

    expect(result.state).toBe('error')
    expect(result.error).toContain('exactly one file')
  })

  it('reverts tracked content and leaves a recoverable backup', async () => {
    const repoDir = await createMixedRepo()
    const backupRoot = await makeTempDir('review-service-backup-')
    const service = makeService(repoDir, backupRoot)

    const before = await service.getStatus(SESSION, UNSTAGED)
    const modified = await fs.readFile(path.join(repoDir, 'tracked.txt'), 'utf8')

    const result = await service.revert(SESSION, {
      paths: ['tracked.txt'],
      snapshot: before.snapshot,
      source: UNSTAGED,
    })

    expect(result.state).toBe('ok')
    expect(result.backupDir).toBeTruthy()
    expect(await fs.readFile(path.join(repoDir, 'tracked.txt'), 'utf8')).toBe(
      'l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nl9\nl10\n',
    )
    expect(await fs.readFile(path.join(result.backupDir!, 'tracked.txt'), 'utf8')).toBe(modified)
    // The backup lives in the app's data dir, never inside the repository.
    expect(result.backupDir!.startsWith(backupRoot)).toBe(true)
    expect(result.backupDir!.startsWith(repoDir)).toBe(false)
    expect(result.status?.files.some((file) => file.path === 'tracked.txt')).toBe(false)
  })

  it('does not sweep untracked files into a bulk revert', async () => {
    const repoDir = await createMixedRepo()
    const backupRoot = await makeTempDir('review-service-backup-')
    const service = makeService(repoDir, backupRoot)

    const before = await service.getStatus(SESSION, UNSTAGED)
    const bulk = await service.revert(SESSION, {
      paths: before.files.filter((file) => file.status !== 'untracked').map((file) => file.path),
      snapshot: before.snapshot,
    })

    expect(bulk.state).toBe('ok')
    expect(await fs.readFile(path.join(repoDir, 'untracked.txt'), 'utf8')).toBe('brand new\n')

    // Naming it explicitly does remove it — after a backup is written.
    const current = await service.getStatus(SESSION, UNSTAGED)
    const explicit = await service.revert(SESSION, {
      paths: ['untracked.txt'],
      snapshot: current.snapshot,
    })
    expect(explicit.state).toBe('ok')
    await expect(fs.access(path.join(repoDir, 'untracked.txt'))).rejects.toThrow()
    expect(await fs.readFile(path.join(explicit.backupDir!, 'untracked.txt'), 'utf8')).toBe(
      'brand new\n',
    )
  })

  it('refuses to revert a directory pathspec', async () => {
    const repoDir = await initRepo()
    await write(repoDir, 'dir/inside.txt', 'one\n')
    git(repoDir, 'add', '-A')
    git(repoDir, 'commit', '-m', 'initial')
    await write(repoDir, 'dir/inside.txt', 'two\n')
    await write(repoDir, 'dir/extra.txt', 'untracked\n')

    const service = makeService(repoDir, await makeTempDir('review-service-backup-'))
    const before = await service.getStatus(SESSION, UNSTAGED)
    const result = await service.revert(SESSION, { paths: ['dir'], snapshot: before.snapshot })

    expect(result.state).toBe('error')
    expect(result.results[0]?.error).toContain('not a directory')
    expect(await fs.readFile(path.join(repoDir, 'dir/inside.txt'), 'utf8')).toBe('two\n')
    expect(await fs.readFile(path.join(repoDir, 'dir/extra.txt'), 'utf8')).toBe('untracked\n')
  })

  it('reports per-path results when only part of a multi-path write succeeds', async () => {
    const repoDir = await createMixedRepo()
    const service = makeService(repoDir)

    const before = await service.getStatus(SESSION, UNSTAGED)
    const result = await service.stage(SESSION, {
      paths: ['tracked.txt', 'does-not-exist.txt'],
      snapshot: before.snapshot,
      source: UNSTAGED,
    })

    expect(result.state).toBe('partial')
    expect(result.results.find((entry) => entry.path === 'tracked.txt')?.ok).toBe(true)
    expect(result.results.find((entry) => entry.path === 'does-not-exist.txt')?.ok).toBe(false)
    // The refreshed status reflects what actually landed.
    expect(result.status?.files.map((file) => file.path).sort()).toEqual([
      'binary.dat',
      'untracked.txt',
    ])
  })
})

describe('ReviewService concurrency guard', () => {
  it('rejects a write carrying a snapshot taken before the file changed', async () => {
    const repoDir = await createMixedRepo()
    const service = makeService(repoDir)

    const before = await service.getStatus(SESSION, UNSTAGED)
    const diff = await service.getFileDiff(SESSION, { source: UNSTAGED, path: 'tracked.txt' })
    const firstHunk = takeFirstHunk(diff.diff ?? '')

    // Someone (the agent, an editor, another session) changes the file after
    // the client read it. Size changes too, so this does not depend on mtime
    // resolution.
    await write(repoDir, 'tracked.txt', 'completely different content\nsecond line\nthird line\n')

    const stale = await service.stageHunk(SESSION, { patch: firstHunk, snapshot: before.snapshot })
    expect(stale.state).toBe('stale')
    expect(stale.snapshot).not.toBe(before.snapshot)
    expect(stale.results).toEqual([])

    // Nothing was applied.
    expect((await service.getStatus(SESSION, STAGED)).files.map((file) => file.path)).toEqual([
      'staged-only.txt',
    ])

    const staleStage = await service.stage(SESSION, {
      paths: ['tracked.txt'],
      snapshot: before.snapshot,
    })
    expect(staleStage.state).toBe('stale')
    expect((await service.getStatus(SESSION, STAGED)).files.map((file) => file.path)).toEqual([
      'staged-only.txt',
    ])

    // The refreshed token from the rejection works.
    const retry = await service.stage(SESSION, {
      paths: ['tracked.txt'],
      snapshot: staleStage.snapshot,
    })
    expect(retry.state).toBe('ok')
  })

  it('changes the snapshot when a modified file is edited again', async () => {
    const repoDir = await createMixedRepo()
    const service = makeService(repoDir)

    const first = await service.getStatus(SESSION, UNSTAGED)
    const unchanged = await service.getStatus(SESSION, UNSTAGED)
    expect(unchanged.snapshot).toBe(first.snapshot)

    // git status still reports ` M tracked.txt`, so the status output alone
    // would not notice this edit.
    await write(repoDir, 'tracked.txt', 'L1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nl9\nL10\nextra line\n')
    const after = await service.getStatus(SESSION, UNSTAGED)
    expect(after.snapshot).not.toBe(first.snapshot)
  })

  it('requires a snapshot on every write', async () => {
    const repoDir = await createMixedRepo()
    const service = makeService(repoDir)

    const result = await service.stage(SESSION, { paths: ['tracked.txt'], snapshot: '' })
    expect(result.state).toBe('error')
    expect(result.error).toContain('snapshot is required')
  })
})

describe('ReviewService edge states', () => {
  it('reports not_git_repo for a plain directory', async () => {
    const workDir = await makeTempDir('review-service-plain-')
    await write(workDir, 'file.txt', 'hello\n')
    const service = makeService(workDir)

    const result = await service.getStatus(SESSION, UNSTAGED)
    expect(result.state).toBe('not_git_repo')
    expect(result.files).toEqual([])

    const write1 = await service.stage(SESSION, { paths: ['file.txt'], snapshot: 'anything' })
    expect(write1.state).toBe('not_git_repo')
  })

  it('reports missing_workdir when the worktree directory is gone', async () => {
    const repoDir = await createMixedRepo()
    const service = makeService(repoDir)
    await fs.rm(repoDir, { recursive: true, force: true })

    const result = await service.getStatus(SESSION, UNSTAGED)
    expect(result.state).toBe('missing_workdir')

    const written = await service.revert(SESSION, { paths: ['tracked.txt'], snapshot: 'anything' })
    expect(written.state).toBe('missing_workdir')
  })

  it('reports no_head for HEAD-based sources in a repository without commits', async () => {
    const repoDir = await initRepo()
    await write(repoDir, 'staged.txt', 'staged\n')
    git(repoDir, 'add', 'staged.txt')
    await write(repoDir, 'staged.txt', 'staged\nedited\n')

    const service = makeService(repoDir)

    for (const source of [STAGED, UNCOMMITTED, { kind: 'branch', baseRef: 'main' } as const]) {
      const result = await service.getStatus(SESSION, source)
      expect(result.state).toBe('no_head')
      expect(result.error).toContain('no commits yet')
      expect(result.files).toEqual([])
    }

    // index -> working tree needs no HEAD and still works.
    const unstaged = await service.getStatus(SESSION, UNSTAGED)
    expect(unstaged.state).toBe('ok')
    expect(unstaged.files.map((file) => file.path)).toEqual(['staged.txt'])

    // And unstaging still works without a HEAD to reset to.
    const result = await service.unstage(SESSION, {
      paths: ['staged.txt'],
      snapshot: unstaged.snapshot,
    })
    expect(result.state).toBe('ok')
    expect(git(repoDir, 'status', '--porcelain=v1')).toContain('?? staged.txt')
  })

  it('throws a session-not-found error for an unknown session', async () => {
    const repoDir = await createMixedRepo()
    const service = makeService(repoDir)

    await expect(service.getStatus('other-session', UNSTAGED)).rejects.toThrow(/Session not found/)
  })

  it('rejects the turn source instead of falling back to current Git', async () => {
    const repoDir = await createMixedRepo()
    const service = makeService(repoDir)

    const status = await service.getStatus(SESSION, { kind: 'turn', turnKey: 'turn-7' })
    expect(status.state).toBe('error')
    expect(status.error).toContain('turn history')
    // Critically: no Git fallback. The repo has changes, and none are reported.
    expect(status.files).toEqual([])
    expect(status.snapshot).toBe('')

    const diff = await service.getFileDiff(SESSION, {
      source: { kind: 'turn', turnKey: 'turn-7' },
      path: 'tracked.txt',
    })
    expect(diff.state).toBe('error')
    expect(diff.diff).toBeUndefined()

    const staged = await service.stage(SESSION, {
      paths: ['tracked.txt'],
      snapshot: 'anything',
      source: { kind: 'turn', turnKey: 'turn-7' },
    })
    expect(staged.state).toBe('error')
    expect(staged.error).toContain('turn history')
  })

  it('rejects traversal paths on reads and writes', async () => {
    const baseDir = await makeTempDir('review-service-base-')
    const repoDir = path.join(baseDir, 'repo')
    await fs.mkdir(repoDir)
    git(repoDir, 'init')
    git(repoDir, 'config', 'user.email', 'review-service@example.com')
    git(repoDir, 'config', 'user.name', 'Review Service')
    await write(repoDir, 'inside.txt', 'inside\n')
    git(repoDir, 'add', '-A')
    git(repoDir, 'commit', '-m', 'initial')
    await fs.writeFile(path.join(baseDir, 'outside.txt'), 'secret\n')

    const service = makeService(repoDir, await makeTempDir('review-service-backup-'))
    const before = await service.getStatus(SESSION, UNSTAGED)

    await expect(
      service.stage(SESSION, { paths: ['../outside.txt'], snapshot: before.snapshot }),
    ).rejects.toThrow(/outside workspace/)
    await expect(
      service.revert(SESSION, { paths: ['../outside.txt'], snapshot: before.snapshot }),
    ).rejects.toThrow(/outside workspace/)
    await expect(
      service.getFileDiff(SESSION, { source: UNSTAGED, path: '../outside.txt' }),
    ).rejects.toThrow(/outside workspace/)
    await expect(
      service.stage(SESSION, { paths: ['.git/config'], snapshot: before.snapshot }),
    ).rejects.toThrow(/version-control metadata/)

    // A patch is an attack surface of its own: `git apply` would resolve these
    // paths itself, so they go through the same validation as a named path.
    await expect(
      service.stageHunk(SESSION, {
        snapshot: before.snapshot,
        patch: [
          'diff --git a/../outside.txt b/../outside.txt',
          '--- a/../outside.txt',
          '+++ b/../outside.txt',
          '@@ -1 +1 @@',
          '-secret',
          '+owned',
        ].join('\n'),
      }),
    ).rejects.toThrow(/outside workspace/)

    expect(await fs.readFile(path.join(baseDir, 'outside.txt'), 'utf8')).toBe('secret\n')
  })
})

describe('collectPatchPaths', () => {
  it('extracts the single target of a unified diff', () => {
    expect(
      collectPatchPaths(
        ['diff --git a/src/x.ts b/src/x.ts', '--- a/src/x.ts', '+++ b/src/x.ts', '@@ -1 +1 @@'].join(
          '\n',
        ),
      ),
    ).toEqual(['src/x.ts'])
  })

  it('treats a new file as one target', () => {
    expect(
      collectPatchPaths(
        ['diff --git a/new.txt b/new.txt', '--- /dev/null', '+++ b/new.txt'].join('\n'),
      ),
    ).toEqual(['new.txt'])
  })

  it('reports both sides of a multi-file patch', () => {
    const paths = collectPatchPaths(
      [
        'diff --git a/a.txt b/a.txt',
        '--- a/a.txt',
        '+++ b/a.txt',
        'diff --git a/b.txt b/b.txt',
        '--- a/b.txt',
        '+++ b/b.txt',
      ].join('\n'),
    )
    expect(paths.sort()).toEqual(['a.txt', 'b.txt'])
  })
})

/** Header plus the first `@@` block of a unified diff. */
function takeFirstHunk(diff: string): string {
  const lines = diff.split('\n')
  const firstHunk = lines.findIndex((line) => line.startsWith('@@'))
  if (firstHunk === -1) return diff
  const nextHunk = lines.findIndex((line, index) => index > firstHunk && line.startsWith('@@'))
  const end = nextHunk === -1 ? lines.length : nextHunk
  return `${lines.slice(0, end).join('\n')}\n`
}

describe('ReviewService pathspec literalness', () => {
  /**
   * `--` only stops option parsing; everything after it is still matched with
   * wildmatch. Before `literalPathspec`, reverting `a[1].txt` also reverted
   * `a1.txt` — silent destruction of uncommitted work, with a backup that
   * captured the wrong file. Route files named `[slug].tsx` make this ordinary,
   * not exotic.
   */
  async function createGlobRepo(): Promise<string> {
    const repoDir = await initRepo('review-glob-')
    await write(repoDir, 'a1.txt', 'committed-a1\n')
    await write(repoDir, 'a[1].txt', 'committed-bracket\n')
    await write(repoDir, 'ab.txt', 'committed-ab\n')
    await write(repoDir, 'a\\b.txt', 'committed-backslash\n')
    git(repoDir, 'add', '-A')
    git(repoDir, 'commit', '-m', 'initial')
    return repoDir
  }

  it('reverts only the bracketed file it was given', async () => {
    const repoDir = await createGlobRepo()
    await write(repoDir, 'a1.txt', 'HOURS OF UNSAVED WORK\n')
    await write(repoDir, 'a[1].txt', 'edited-bracket\n')

    const service = makeService(repoDir, await makeTempDir('review-glob-backup-'))
    const status = await service.getStatus(SESSION, UNSTAGED)
    const result = await service.revert(SESSION, {
      paths: ['a[1].txt'],
      snapshot: status.snapshot,
      source: UNSTAGED,
    })

    expect(result.state).toBe('ok')
    expect(await fs.readFile(path.join(repoDir, 'a[1].txt'), 'utf8')).toBe('committed-bracket\n')
    // The sibling the glob would have matched must be untouched.
    expect(await fs.readFile(path.join(repoDir, 'a1.txt'), 'utf8')).toBe('HOURS OF UNSAVED WORK\n')
  })

  it('stages only the backslash-named file it was given', async () => {
    const repoDir = await createGlobRepo()
    await write(repoDir, 'a\\b.txt', 'edited-backslash\n')
    await write(repoDir, 'ab.txt', 'edited-ab\n')

    const service = makeService(repoDir)
    const status = await service.getStatus(SESSION, UNSTAGED)
    const result = await service.stage(SESSION, {
      paths: ['a\\b.txt'],
      snapshot: status.snapshot,
      source: UNSTAGED,
    })

    expect(result.state).toBe('ok')
    const porcelain = git(repoDir, 'status', '--porcelain')
    // `ab.txt` must still be unstaged: wildmatch treats `\` as an escape.
    expect(porcelain).toContain(' M ab.txt')
  })

  it('reaches a file whose name starts with the pathspec magic prefix', async () => {
    const repoDir = await initRepo('review-colon-')
    await write(repoDir, 'colon.txt', 'base\n')
    git(repoDir, 'add', '-A')
    git(repoDir, 'commit', '-m', 'initial')
    await fs.rename(path.join(repoDir, 'colon.txt'), path.join(repoDir, ':colon.txt'))
    await write(repoDir, ':colon.txt', 'edited\n')

    const service = makeService(repoDir)
    const status = await service.getStatus(SESSION, UNSTAGED)
    const result = await service.stage(SESSION, {
      paths: [':colon.txt'],
      snapshot: status.snapshot,
      source: UNSTAGED,
    })

    // A leading `:` is the "magic prefix" marker, so an unescaped pathspec
    // fails with `did not match any files` and the user cannot stage the file.
    expect(result.results[0]).toMatchObject({ path: ':colon.txt', ok: true })
  })
})

describe('ReviewService missing worktree', () => {
  /**
   * `missing_workdir` used to come back with no `error` string, so the panel
   * fell through to its empty state and drew a green "no changes" check over a
   * worktree that had been deleted.
   */
  it('explains a deleted worktree instead of reporting it as no changes', async () => {
    const repoDir = await createMixedRepo()
    const service = makeService(repoDir)
    await fs.rm(repoDir, { recursive: true, force: true })

    const status = await service.getStatus(SESSION, UNSTAGED)
    expect(status.state).toBe('missing_workdir')
    expect(status.error).toBeTruthy()
    expect(status.error).toContain('no longer exists')

    const diff = await service.getFileDiff(SESSION, { source: UNSTAGED, path: 'tracked.txt' })
    expect(diff.state).toBe('missing_workdir')
    expect(diff.error).toContain('no longer exists')

    const written = await service.revert(SESSION, { paths: ['tracked.txt'], snapshot: 'x' })
    expect(written.state).toBe('missing_workdir')
    expect(written.error).toContain('no longer exists')
  })
})

describe('ReviewService untracked size limits', () => {
  /** 30 bytes per line, so the byte size of the fixture is predictable. */
  function repeatLines(count: number): string {
    return `${'x'.repeat(29)}\n`.repeat(count)
  }

  it('counts a large untracked file instead of reporting it as empty', async () => {
    const repoDir = await initRepo('review-bigstat-')
    await write(repoDir, 'kept.txt', 'kept\n')
    git(repoDir, 'add', '-A')
    git(repoDir, 'commit', '-m', 'initial')

    // Over the 256 KB whole-file read limit: the old code short-circuited to
    // `additions: 0`, so the change list showed `+0 -0` for a fresh log.
    const lines = 40_000
    await write(repoDir, 'big.log', repeatLines(lines))
    expect((await fs.stat(path.join(repoDir, 'big.log'))).size).toBeGreaterThan(256 * 1024)

    const service = makeService(repoDir)
    const status = await service.getStatus(SESSION, UNSTAGED)
    const entry = status.files.find((file) => file.path === 'big.log')

    expect(entry).toMatchObject({ status: 'untracked', additions: lines, deletions: 0 })
    expect(entry?.statsTruncated).toBeUndefined()
    expect(status.totals.additions).toBe(lines)
  })

  it('says a file was not counted rather than counting it as zero', async () => {
    const repoDir = await initRepo('review-hugestat-')
    await write(repoDir, 'kept.txt', 'kept\n')
    git(repoDir, 'add', '-A')
    git(repoDir, 'commit', '-m', 'initial')

    // Sparse: the fixture needs the reported size, not 33 MB of real bytes.
    const hugePath = path.join(repoDir, 'huge.bin')
    await fs.writeFile(hugePath, '')
    await fs.truncate(hugePath, 32 * 1024 * 1024 + 1)

    const service = makeService(repoDir)
    const status = await service.getStatus(SESSION, UNSTAGED)
    const entry = status.files.find((file) => file.path === 'huge.bin')

    expect(entry?.statsTruncated).toBe(true)
    expect(entry?.additions).toBe(0)
  })

  it('caps the synthesized diff and emits no appliable hunk for it', async () => {
    const repoDir = await initRepo('review-bigdiff-')
    await write(repoDir, 'kept.txt', 'kept\n')
    git(repoDir, 'add', '-A')
    git(repoDir, 'commit', '-m', 'initial')

    const lines = 50_000
    await write(repoDir, 'big.log', repeatLines(lines))
    const size = (await fs.stat(path.join(repoDir, 'big.log'))).size
    expect(size).toBeGreaterThan(1024 * 1024)

    const service = makeService(repoDir)
    const diff = await service.getFileDiff(SESSION, { source: UNSTAGED, path: 'big.log' })

    expect(diff.state).toBe('ok')
    expect(diff.truncated).toBe(true)
    expect(diff.bytes).toBe(size)
    // The whole point of the cap: the payload stays small, and it carries no
    // `@@` block, because a partial hunk is an appliable patch that would
    // stage a truncated copy of the file.
    expect(diff.diff?.length ?? 0).toBeLessThan(1024)
    expect(diff.diff).not.toContain('@@')

    // Small untracked files keep their real diff.
    await write(repoDir, 'small.txt', 'one\ntwo\n')
    const small = await service.getFileDiff(SESSION, { source: UNSTAGED, path: 'small.txt' })
    expect(small.truncated).toBeUndefined()
    expect(small.diff).toContain('+two')
  })
})

describe('ReviewService symlink containment', () => {
  /**
   * The `.git` guard reads the segments of the path the caller typed, and the
   * containment check runs on the resolved path — so a gitignored
   * `meta -> .git` symlink satisfies both: `meta/config` has no `.git`
   * segment, and `<repo>/.git/config` really is inside the workspace. `revert`
   * then copied the repository's credentials into the backup directory before
   * failing.
   */
  async function createSymlinkRepo(): Promise<{ repoDir: string; backupRoot: string }> {
    const repoDir = await initRepo('review-symlink-')
    await write(repoDir, 'tracked.txt', 'tracked\n')
    await write(repoDir, '.gitignore', 'meta\nlink.txt\n')
    git(repoDir, 'add', '-A')
    git(repoDir, 'commit', '-m', 'initial')
    await write(repoDir, 'tracked.txt', 'tracked edited\n')

    await fs.appendFile(
      path.join(repoDir, '.git', 'config'),
      '\n[credential]\n\thelper = store\n[remote "origin"]\n\turl = https://token:s3cr3t@example.com/x.git\n',
    )
    await fs.symlink('.git', path.join(repoDir, 'meta'))
    await fs.symlink('tracked.txt', path.join(repoDir, 'link.txt'))

    return { repoDir, backupRoot: await makeTempDir('review-symlink-backup-') }
  }

  it('refuses a path that resolves into .git through a symlink', async () => {
    const { repoDir, backupRoot } = await createSymlinkRepo()
    const service = makeService(repoDir, backupRoot)
    const status = await service.getStatus(SESSION, UNSTAGED)

    const attempt = await service
      .revert(SESSION, { paths: ['meta/config'], snapshot: status.snapshot })
      .then(() => null, (error: Error) => error)

    // The leak is checked first on purpose: `revert` backs the file up before
    // it runs git, so a guard that arrives late still copies the credentials
    // out even though the operation as a whole reports a failure.
    const copied: string[] = []
    async function walk(dir: string): Promise<void> {
      for (const item of await fs.readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, item.name)
        if (item.isDirectory()) await walk(full)
        else copied.push(full)
      }
    }
    await walk(backupRoot)
    for (const file of copied) {
      expect(await fs.readFile(file, 'utf8'), `${file} was copied out of .git`).not.toContain('s3cr3t')
    }
    expect(copied).toEqual([])

    expect(attempt?.message).toMatch(/version-control metadata/)
    await expect(
      service.getFileDiff(SESSION, { source: UNSTAGED, path: 'meta/config' }),
    ).rejects.toThrow(/version-control metadata/)
  })

  it('refuses a symlinked file rather than acting through it', async () => {
    const { repoDir, backupRoot } = await createSymlinkRepo()
    const service = makeService(repoDir, backupRoot)
    const status = await service.getStatus(SESSION, UNSTAGED)

    await expect(
      service.revert(SESSION, { paths: ['link.txt'], snapshot: status.snapshot }),
    ).rejects.toThrow(/symbolic link/)
    // The link target is untouched.
    expect(await fs.readFile(path.join(repoDir, 'tracked.txt'), 'utf8')).toBe('tracked edited\n')
  })

  it('keeps the revert backup directory readable only by its owner', async () => {
    if (process.platform === 'win32') return
    const { repoDir, backupRoot } = await createSymlinkRepo()
    const service = makeService(repoDir, backupRoot)
    const status = await service.getStatus(SESSION, UNSTAGED)

    const result = await service.revert(SESSION, {
      paths: ['tracked.txt'],
      snapshot: status.snapshot,
    })
    expect(result.state).toBe('ok')
    expect(result.backupDir).toBeTruthy()

    const dirMode = (await fs.stat(result.backupDir!)).mode & 0o777
    expect(dirMode).toBe(0o700)
    const fileMode = (await fs.stat(path.join(result.backupDir!, 'tracked.txt'))).mode & 0o777
    expect(fileMode).toBe(0o600)
  })
})

describe('ReviewService read-only sources', () => {
  async function createBranchRepo(): Promise<string> {
    const repoDir = await initRepo('review-readonly-')
    await write(repoDir, 'tracked.txt', 'base\n')
    git(repoDir, 'add', '-A')
    git(repoDir, 'commit', '-m', 'initial')
    await write(repoDir, 'tracked.txt', 'base\nworking copy\n')
    return repoDir
  }

  it('refuses every write against a branch or commit comparison', async () => {
    const repoDir = await createBranchRepo()
    const service = makeService(repoDir, await makeTempDir('review-readonly-backup-'))
    const head = git(repoDir, 'rev-parse', 'HEAD').trim()
    const status = await service.getStatus(SESSION, UNSTAGED)

    for (const source of [
      { kind: 'branch', baseRef: 'main' } as const,
      { kind: 'commit', commit: head } as const,
    ]) {
      for (const run of [
        () => service.stage(SESSION, { paths: ['tracked.txt'], snapshot: status.snapshot, source }),
        () => service.unstage(SESSION, { paths: ['tracked.txt'], snapshot: status.snapshot, source }),
        () => service.revert(SESSION, { paths: ['tracked.txt'], snapshot: status.snapshot, source }),
        () => service.stageHunk(SESSION, {
          snapshot: status.snapshot,
          source,
          patch: [
            'diff --git a/tracked.txt b/tracked.txt',
            '--- a/tracked.txt',
            '+++ b/tracked.txt',
            '@@ -1 +1,2 @@',
            ' base',
            '+working copy',
          ].join('\n'),
        }),
      ]) {
        const result = await run()
        expect(result.state).toBe('error')
        expect(result.error).toContain('read-only comparison')
      }
    }

    // The refusal is the point: the working tree must be exactly as it was.
    expect(await fs.readFile(path.join(repoDir, 'tracked.txt'), 'utf8')).toBe('base\nworking copy\n')
    expect(git(repoDir, 'status', '--porcelain=v1')).toContain(' M tracked.txt')
  })
})

describe('ReviewService non-ASCII paths', () => {
  /**
   * Without `core.quotePath=false` git writes `"\346\227\245..."` into the
   * patch header. `collectPatchPaths` then validated that escaped spelling —
   * a path that does not exist — while `git apply` unquoted it again and wrote
   * to the real file, so the validation guarded nothing.
   */
  it('reads and patches a non-ASCII path under its real name', async () => {
    const repoDir = await initRepo('review-utf8-')
    await write(repoDir, '文档/café-naïve.txt', 'ligne un\nligne deux\n')
    git(repoDir, 'add', '-A')
    git(repoDir, 'commit', '-m', 'initial')
    await write(repoDir, '文档/café-naïve.txt', 'ligne un\nligne deux\nligne trois\n')

    const service = makeService(repoDir)
    const status = await service.getStatus(SESSION, UNSTAGED)
    expect(status.files.map((file) => file.path)).toEqual(['文档/café-naïve.txt'])

    const diff = await service.getFileDiff(SESSION, {
      source: UNSTAGED,
      path: '文档/café-naïve.txt',
    })
    expect(diff.state).toBe('ok')
    expect(diff.diff).toContain('文档/café-naïve.txt')
    expect(diff.diff).not.toContain('\\346')
    // The whole reason the quoting matters: the guard reads these back.
    expect(collectPatchPaths(diff.diff!)).toEqual(['文档/café-naïve.txt'])

    const applied = await service.stageHunk(SESSION, {
      snapshot: status.snapshot,
      source: UNSTAGED,
      patch: takeFirstHunk(diff.diff!),
    })
    expect(applied.state).toBe('ok')
    expect(git(repoDir, 'status', '--porcelain=v1')).toContain('M  ')
    // The raw helper has no quoting override of its own, so it has to be asked
    // for the real name; that it needs asking is the bug this test guards.
    expect(
      git(repoDir, '-c', 'core.quotePath=false', 'diff', '--cached', '--name-only').trim(),
    ).toBe('文档/café-naïve.txt')
  })
})

describe('ReviewService git invocation hardening', () => {
  it('ignores GIT_DIR, GIT_WORK_TREE and GIT_INDEX_FILE from the environment', async () => {
    const decoy = await initRepo('review-decoy-')
    await write(decoy, 'decoy.txt', 'decoy\n')
    git(decoy, 'add', '-A')
    git(decoy, 'commit', '-m', 'decoy')
    await write(decoy, 'decoy.txt', 'decoy edited\n')

    const repoDir = await createMixedRepo()
    const service = makeService(repoDir)

    const saved = {
      GIT_DIR: process.env.GIT_DIR,
      GIT_WORK_TREE: process.env.GIT_WORK_TREE,
      GIT_INDEX_FILE: process.env.GIT_INDEX_FILE,
    }
    process.env.GIT_DIR = path.join(decoy, '.git')
    process.env.GIT_WORK_TREE = decoy
    process.env.GIT_INDEX_FILE = path.join(decoy, '.git', 'index')

    try {
      const status = await service.getStatus(SESSION, UNSTAGED)
      expect(status.state).toBe('ok')
      // The decoy repository must not appear anywhere in the answer.
      expect(status.files.map((file) => file.path).sort()).toEqual([
        'binary.dat',
        'tracked.txt',
        'untracked.txt',
      ])

      const staged = await service.stage(SESSION, {
        paths: ['tracked.txt'],
        snapshot: status.snapshot,
        source: UNSTAGED,
      })
      expect(staged.state).toBe('ok')
      // `GIT_INDEX_FILE` would have staged into the decoy's index instead.
      expect(git(repoDir, 'status', '--porcelain=v1')).toContain('M  tracked.txt')
      expect(git(decoy, 'status', '--porcelain=v1')).toContain(' M decoy.txt')
    } finally {
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
    }
  })

  it('forces a C locale and detects a missing repository by exit status', async () => {
    if (process.platform === 'win32') return

    const binDir = await makeTempDir('review-fakegit-bin-')
    const logDir = await makeTempDir('review-fakegit-log-')
    const logFile = path.join(logDir, 'calls.txt')
    // Exits non-zero and prints NOTHING: a detector that matches git's English
    // "not a git repository" text has nothing to match here, and a translated
    // git is exactly as unhelpful.
    await fs.writeFile(
      path.join(binDir, 'git'),
      [
        '#!/bin/sh',
        '{',
        '  echo "--ARGS--"',
        '  for a in "$@"; do echo "$a"; done',
        '  echo "--ENV--"',
        '  env',
        '} >> "$REVIEW_FAKE_GIT_LOG"',
        'exit 128',
        '',
      ].join('\n'),
      { mode: 0o755 },
    )

    const workDir = await makeTempDir('review-fakegit-work-')
    const savedPath = process.env.PATH
    const savedLog = process.env.REVIEW_FAKE_GIT_LOG
    const savedLcAll = process.env.LC_ALL
    process.env.PATH = `${binDir}${path.delimiter}${savedPath ?? ''}`
    process.env.REVIEW_FAKE_GIT_LOG = logFile
    process.env.LC_ALL = 'fr_FR.UTF-8'

    try {
      const status = await makeService(workDir).getStatus(SESSION, UNSTAGED)
      expect(status.state).toBe('not_git_repo')
    } finally {
      if (savedPath === undefined) delete process.env.PATH
      else process.env.PATH = savedPath
      if (savedLog === undefined) delete process.env.REVIEW_FAKE_GIT_LOG
      else process.env.REVIEW_FAKE_GIT_LOG = savedLog
      if (savedLcAll === undefined) delete process.env.LC_ALL
      else process.env.LC_ALL = savedLcAll
    }

    const log = await fs.readFile(logFile, 'utf8')
    expect(log).toContain('LC_ALL=C')
    expect(log).toContain('LANG=C')
    expect(log).not.toContain('LC_ALL=fr_FR.UTF-8')
    for (const name of ['GIT_DIR=', 'GIT_WORK_TREE=', 'GIT_INDEX_FILE=']) {
      expect(log).not.toContain(name)
    }
    // Every invocation carries the quoting override, not just the diff.
    expect(log).toContain('core.quotePath=false')
    // Detection asked a second question rather than reading a message.
    expect(log).toContain('--is-inside-work-tree')
  })
})

describe('ReviewService deep workspace writes', () => {
  it('writes only inside a nested session workspace', async () => {
    const repoDir = await initRepo('review-deep-')
    await write(repoDir, 'root-file.txt', 'root base\n')
    await write(repoDir, 'apps/web/src/deep.txt', 'deep base\n')
    await write(repoDir, 'apps/web/src/sibling.txt', 'sibling base\n')
    git(repoDir, 'add', '-A')
    git(repoDir, 'commit', '-m', 'initial')

    await write(repoDir, 'root-file.txt', 'root edited\n')
    await write(repoDir, 'apps/web/src/deep.txt', 'deep edited\n')
    await write(repoDir, 'apps/web/src/sibling.txt', 'sibling edited\n')
    await write(repoDir, 'apps/web/src/fresh.txt', 'fresh\n')

    const workDir = path.join(repoDir, 'apps/web/src')
    const backupRoot = await makeTempDir('review-deep-backup-')
    const service = makeService(workDir, backupRoot)

    const status = await service.getStatus(SESSION, UNSTAGED)
    // The file above the workspace is outside the review entirely.
    expect(status.files.map((file) => file.path).sort()).toEqual([
      'deep.txt',
      'fresh.txt',
      'sibling.txt',
    ])

    const reverted = await service.revert(SESSION, {
      paths: ['deep.txt', 'fresh.txt'],
      snapshot: status.snapshot,
      source: UNSTAGED,
    })

    expect(reverted.state).toBe('ok')
    expect(reverted.revertedPaths).toEqual(['deep.txt'])
    expect(reverted.deletedPaths).toEqual(['fresh.txt'])
    expect(await fs.readFile(path.join(workDir, 'deep.txt'), 'utf8')).toBe('deep base\n')
    expect(await fs.readFile(path.join(workDir, 'sibling.txt'), 'utf8')).toBe('sibling edited\n')
    expect(await fs.readFile(path.join(repoDir, 'root-file.txt'), 'utf8')).toBe('root edited\n')
    await expect(fs.stat(path.join(workDir, 'fresh.txt'))).rejects.toThrow()

    // Backups are keyed by the workspace-relative path, not the repo path.
    expect(await fs.readFile(path.join(reverted.backupDir!, 'deep.txt'), 'utf8')).toBe('deep edited\n')
    expect(await fs.readFile(path.join(reverted.backupDir!, 'fresh.txt'), 'utf8')).toBe('fresh\n')

    await expect(
      service.revert(SESSION, { paths: ['../../../root-file.txt'], snapshot: status.snapshot }),
    ).rejects.toThrow(/outside workspace/)
  })
})

describe('ReviewService untracked deletion reporting', () => {
  /**
   * `fs.rm` on an untracked file is permanent: Git has no copy, so only the
   * backup does. The result has to say "deleted" rather than "reverted", or
   * the confirmation dialog keeps promising that untracked files are safe.
   */
  it('reports deletion and restoration as different outcomes', async () => {
    const repoDir = await createMixedRepo()
    const backupRoot = await makeTempDir('review-delete-backup-')
    const service = makeService(repoDir, backupRoot)

    const status = await service.getStatus(SESSION, UNSTAGED)
    const result = await service.revert(SESSION, {
      paths: ['tracked.txt', 'untracked.txt'],
      snapshot: status.snapshot,
      source: UNSTAGED,
    })

    expect(result.state).toBe('ok')
    expect(result.deletedPaths).toEqual(['untracked.txt'])
    expect(result.revertedPaths).toEqual(['tracked.txt'])
    expect(result.results).toEqual([
      { path: 'tracked.txt', ok: true, action: 'reverted' },
      { path: 'untracked.txt', ok: true, action: 'deleted' },
    ])

    // The deleted file is gone from disk and recoverable only from the backup.
    await expect(fs.stat(path.join(repoDir, 'untracked.txt'))).rejects.toThrow()
    expect(await fs.readFile(path.join(result.backupDir!, 'untracked.txt'), 'utf8')).toBe('brand new\n')
    expect(await fs.readFile(path.join(repoDir, 'tracked.txt'), 'utf8')).toContain('l1\n')
  })

  it('reports nothing as deleted when only tracked files were reverted', async () => {
    const repoDir = await createMixedRepo()
    const service = makeService(repoDir, await makeTempDir('review-delete-backup2-'))

    const status = await service.getStatus(SESSION, UNSTAGED)
    const result = await service.revert(SESSION, {
      paths: ['tracked.txt'],
      snapshot: status.snapshot,
      source: UNSTAGED,
    })

    expect(result.revertedPaths).toEqual(['tracked.txt'])
    expect(result.deletedPaths).toBeUndefined()
  })
})

describe('ReviewService wildcard filenames', () => {
  /**
   * `[` `]` `\` and a leading `:` already have coverage above. `*` and `?` are
   * the other two wildmatch characters, and they are the ones that make a
   * single pathspec match an unbounded number of siblings.
   */
  it('reverts only the star- and question-named files it was given', async () => {
    const repoDir = await initRepo('review-wildcard-')
    await write(repoDir, 'report.txt', 'committed-report\n')
    await write(repoDir, 'report*.txt', 'committed-star\n')
    await write(repoDir, 'report?.txt', 'committed-question\n')
    await write(repoDir, 'reportX.txt', 'committed-x\n')
    git(repoDir, 'add', '-A')
    git(repoDir, 'commit', '-m', 'initial')

    for (const name of ['report.txt', 'report*.txt', 'report?.txt', 'reportX.txt']) {
      await write(repoDir, name, 'EDITED\n')
    }

    const service = makeService(repoDir, await makeTempDir('review-wildcard-backup-'))
    const status = await service.getStatus(SESSION, UNSTAGED)
    const result = await service.revert(SESSION, {
      paths: ['report*.txt', 'report?.txt'],
      snapshot: status.snapshot,
      source: UNSTAGED,
    })

    expect(result.state).toBe('ok')
    expect(await fs.readFile(path.join(repoDir, 'report*.txt'), 'utf8')).toBe('committed-star\n')
    expect(await fs.readFile(path.join(repoDir, 'report?.txt'), 'utf8')).toBe('committed-question\n')
    // `report*.txt` as a glob matches all four; `report?.txt` matches three.
    expect(await fs.readFile(path.join(repoDir, 'report.txt'), 'utf8')).toBe('EDITED\n')
    expect(await fs.readFile(path.join(repoDir, 'reportX.txt'), 'utf8')).toBe('EDITED\n')
  })
})


describe('ReviewService review safety regressions', () => {
  it.each([
    ['', 0o644], ['abc', 0o644], ['abc\n', 0o644], ['abc\r\nnext\r\n', 0o644], ['#!/bin/sh\nprintf ok', 0o755],
  ])('stages new-file bytes and mode exactly: %j / %s', async (content, mode) => {
    const repoDir = await initRepo()
    await write(repoDir, 'new.txt', content)
    await fs.chmod(path.join(repoDir, 'new.txt'), mode)
    const service = makeService(repoDir)
    const diff = await service.getFileDiff(SESSION, { source: UNSTAGED, path: 'new.txt' })
    expect(diff.state).toBe('ok')
    const result = await service.stageHunk(SESSION, { patch: diff.diff!, snapshot: diff.snapshot, source: UNSTAGED })
    expect(result.state).toBe('ok')
    expect(execFileSync('git', ['show', ':new.txt'], { cwd: repoDir })).toEqual(Buffer.from(content))
    expect(git(repoDir, 'ls-files', '--stage', 'new.txt').split(' ')[0]).toBe(mode === 0o755 ? '100755' : '100644')
  })

  it('rejects working-tree writes from the staged comparison without changing either side', async () => {
    const repoDir = await initRepo()
    await write(repoDir, 'both.txt', 'HEAD\n')
    git(repoDir, 'add', '.')
    git(repoDir, 'commit', '-m', 'base')
    await write(repoDir, 'both.txt', 'STAGED\n')
    git(repoDir, 'add', '.')
    await write(repoDir, 'both.txt', 'UNSTAGED\n')
    const service = makeService(repoDir)
    const status = await service.getStatus(SESSION, STAGED)
    for (const operation of ['stage', 'revert'] as const) {
      const result = await service[operation](SESSION, { source: STAGED, paths: ['both.txt'], snapshot: status.snapshot })
      expect(result.state).toBe('error')
      expect(git(repoDir, 'show', ':both.txt')).toBe('STAGED\n')
      expect(await fs.readFile(path.join(repoDir, 'both.txt'), 'utf8')).toBe('UNSTAGED\n')
    }
    const result = await service.unstage(SESSION, { source: STAGED, paths: ['both.txt'], snapshot: status.snapshot })
    expect(result.state).toBe('ok')
    expect(git(repoDir, 'show', ':both.txt')).toBe('HEAD\n')
    expect(await fs.readFile(path.join(repoDir, 'both.txt'), 'utf8')).toBe('UNSTAGED\n')
  })
})


describe('ReviewService rename and historical isolation regressions', () => {
  it.each([false, true])('unstages both ends of a cross-directory rename with later edits=%s', async (modified) => {
    const repoDir = await initRepo()
    await write(repoDir, 'old/name.txt', 'one\ntwo\nthree\nfour\n')
    git(repoDir, 'add', '.')
    git(repoDir, 'commit', '-m', 'base')
    await fs.mkdir(path.join(repoDir, 'new'))
    git(repoDir, 'mv', 'old/name.txt', 'new/name.txt')
    if (modified) await write(repoDir, 'new/name.txt', 'one\ntwo\nthree\nfour\nworking edit\n')
    const service = makeService(repoDir)
    const before = await service.getStatus(SESSION, STAGED)
    expect(before.files[0]).toMatchObject({ path: 'new/name.txt', oldPath: 'old/name.txt' })
    const result = await service.unstage(SESSION, { source: STAGED, paths: ['new/name.txt'], snapshot: before.snapshot })
    expect(result.state).toBe('ok')
    expect(git(repoDir, 'diff', '--cached', '--name-status')).toBe('')
    expect(await fs.readFile(path.join(repoDir, 'new/name.txt'), 'utf8')).toContain(modified ? 'working edit' : 'four')
  })

  it('does not partially unstage a rename whose other end is outside the workspace', async () => {
    const repoDir = await initRepo()
    await write(repoDir, 'outside.txt', 'base\n')
    await fs.mkdir(path.join(repoDir, 'workspace'))
    git(repoDir, 'add', '.')
    git(repoDir, 'commit', '-m', 'base')
    git(repoDir, 'mv', 'outside.txt', 'workspace/new.txt')
    const service = makeService(path.join(repoDir, 'workspace'))
    const before = await service.getStatus(SESSION, STAGED)
    const oldIndex = git(repoDir, 'ls-files', '--stage')
    const result = await service.unstage(SESSION, { source: STAGED, paths: ['new.txt'], snapshot: before.snapshot })
    expect(result.state).toBe('error')
    expect(git(repoDir, 'ls-files', '--stage')).toBe(oldIndex)
  })

  it.each(['untracked', 'directory', 'symlink'])('reads an added historical blob when current path is %s', async (currentType) => {
    const repoDir = await initRepo()
    await write(repoDir, 'file.txt', 'historical\n')
    git(repoDir, 'add', '.')
    git(repoDir, 'commit', '-m', 'base')
    const commit = git(repoDir, 'rev-parse', 'HEAD').trim()
    git(repoDir, 'rm', 'file.txt')
    git(repoDir, 'commit', '-m', 'delete')
    if (currentType === 'untracked') await write(repoDir, 'file.txt', 'unrelated live file\n')
    if (currentType === 'directory') await write(repoDir, 'file.txt/child.txt', 'unrelated live directory\n')
    if (currentType === 'symlink') await fs.symlink('does-not-exist', path.join(repoDir, 'file.txt'))
    const service = makeService(repoDir)
    const source: ReviewSource = { kind: 'commit', commit }
    expect((await service.getStatus(SESSION, source)).files.map(file => file.path)).toEqual(['file.txt'])
    const diff = await service.getFileDiff(SESSION, { source, path: 'file.txt' })
    expect(diff.state).toBe('ok')
    expect(diff.diff).toContain('+historical')
    expect(diff.diff).not.toContain('unrelated')
  })
})


describe('ReviewService exact new-file path headers', () => {
  it.each(['space name.txt', 'line\nbreak.txt', 'back\\slash.txt', 'trailing .txt '])('stages an empty file whose name needs Git quoting: %j', async (name) => {
    const repoDir = await initRepo()
    await write(repoDir, name, '')
    const service = makeService(repoDir)
    const diff = await service.getFileDiff(SESSION, { source: UNSTAGED, path: name })
    expect(collectPatchPaths(diff.diff!)).toEqual([name])
    const staged = await service.stageHunk(SESSION, { source: UNSTAGED, snapshot: diff.snapshot, patch: diff.diff! })
    expect(staged.state).toBe('ok')
    expect(execFileSync('git', ['show', `:${name}`], { cwd: repoDir })).toEqual(Buffer.alloc(0))
  })
})


it('keeps a commit review snapshot stable while unrelated working-tree files change', async () => {
  const repoDir = await createMixedRepo()
  const service = makeService(repoDir)
  const source: ReviewSource = { kind: 'commit', commit: 'HEAD' }
  const status = await service.getStatus(SESSION, source)
  await write(repoDir, 'untracked.txt', 'later change\n')
  const diff = await service.getFileDiff(SESSION, { source, path: 'tracked.txt' })
  expect(diff.snapshot).toBe(status.snapshot)
  expect(diff.state).toBe('ok')
})

describe('review comparison revisions', () => {
  it('changes the branch revision when its merge base moves without workspace changes', async () => {
    const repo = await initRepo()
    await write(repo, 'a.txt', 'base\n')
    git(repo, 'add', '.')
    git(repo, 'commit', '-qm', 'base')
    git(repo, 'branch', 'comparison')
    await write(repo, 'a.txt', 'next\n')
    git(repo, 'commit', '-qam', 'next')
    const service = makeService(repo)
    const source = { kind: 'branch' as const, baseRef: 'comparison' }
    const before = await service.getStatus(SESSION, source)
    git(repo, 'branch', '-f', 'comparison', 'HEAD')
    const after = await service.getStatus(SESSION, source)
    expect(before.files).toHaveLength(1)
    expect(after.files).toHaveLength(0)
    expect(after.snapshot).not.toBe(before.snapshot)
    expect((await service.getRevision(SESSION, source)).snapshot).toBe(after.snapshot)
  })
})


it('uses the same no-head revision as the full status for an unborn repository', async () => {
  const repo = await initRepo()
  await write(repo, 'new.txt', 'new\n')
  const service = makeService(repo)
  const full = await service.getStatus(SESSION, STAGED)
  const revision = await service.getRevision(SESSION, STAGED)
  expect(revision.state).toBe('no_head')
  expect(revision.snapshot).toBe(full.snapshot)
})
