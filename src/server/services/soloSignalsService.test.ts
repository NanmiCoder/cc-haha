import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  gatherSoloSignalsTier1,
  _SOLO_SIGNALS_INTERNALS,
} from './soloSignalsService'
import type { RecentActivityResult } from './projectActivityService'

const { isSourceFile, siblingTestCandidates, compareSemver } =
  _SOLO_SIGNALS_INTERNALS

/**
 * Tier-1 collector tests are filesystem-driven (it IS the I/O layer
 * that pairs with the pure engine), so we set up a real temp dir
 * fixture for each describe block. Cheap — under 50ms per setup.
 */

function emptyActivity(workDir: string): RecentActivityResult {
  return { hasActivity: false, workDir }
}

function activityWithDirtyFiles(
  workDir: string,
  dirtyFiles: string[],
): RecentActivityResult {
  return {
    hasActivity: true,
    workDir,
    git: {
      branch: null,
      defaultBranch: null,
      aheadCount: 0,
      behindCount: 0,
      dirtyCount: dirtyFiles.length,
      dirtyFiles,
    },
  }
}

describe('isSourceFile', () => {
  it('classifies typical source files', () => {
    expect(isSourceFile('src/foo.ts')).toBe(true)
    expect(isSourceFile('packages/x/src/main.go')).toBe(true)
    expect(isSourceFile('lib/bar.py')).toBe(true)
  })
  it('rejects test files by extension and folder convention', () => {
    expect(isSourceFile('src/foo.test.ts')).toBe(false)
    expect(isSourceFile('src/foo.spec.tsx')).toBe(false)
    expect(isSourceFile('src/foo_test.go')).toBe(false)
    expect(isSourceFile('src/__tests__/foo.ts')).toBe(false)
    expect(isSourceFile('tests/foo.ts')).toBe(false)
  })
  it('rejects non-code files', () => {
    expect(isSourceFile('README.md')).toBe(false)
    expect(isSourceFile('package.json')).toBe(false)
    expect(isSourceFile('')).toBe(false)
  })
})

describe('siblingTestCandidates', () => {
  it('emits .test / .spec / __tests__ shapes for TS', () => {
    const out = siblingTestCandidates('src/lib/foo.ts')
    expect(out).toContain('src/lib/foo.test.ts')
    expect(out).toContain('src/lib/foo.spec.ts')
    expect(out).toContain('src/lib/__tests__/foo.ts')
  })
  it('emits _test.go for Go (the only convention)', () => {
    const out = siblingTestCandidates('pkg/svc/foo.go')
    expect(out).toEqual(['pkg/svc/foo_test.go'])
  })
  it('emits test_X.py / X_test.py / tests/test_X.py for Python', () => {
    const out = siblingTestCandidates('lib/foo.py')
    expect(out).toContain('lib/test_foo.py')
    expect(out).toContain('lib/foo_test.py')
    expect(out).toContain('tests/test_foo.py')
  })
  it('handles repo-root files (no leading slash leak)', () => {
    const out = siblingTestCandidates('foo.ts')
    expect(out.every((p) => !p.startsWith('/'))).toBe(true)
  })
})

describe('compareSemver', () => {
  it('returns sign of difference', () => {
    expect(compareSemver('0.5.10', '0.5.9')).toBe(1)
    expect(compareSemver('0.5.9', '0.5.10')).toBe(-1)
    expect(compareSemver('0.5.10', '0.5.10')).toBe(0)
  })
  it('compares MAJOR.MINOR.PATCH in order', () => {
    expect(compareSemver('1.0.0', '0.99.99')).toBeGreaterThan(0)
    expect(compareSemver('0.6.0', '0.5.99')).toBeGreaterThan(0)
  })
})

// ─── gatherSoloSignalsTier1 — filesystem fixture tests ──────────────

let tmpRoot: string
beforeAll(async () => {
  tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'solo-signals-'))
})
afterAll(async () => {
  if (tmpRoot) await rm(tmpRoot, { recursive: true, force: true })
})

async function makeFixture(name: string): Promise<string> {
  const dir = path.join(tmpRoot, name)
  await mkdir(dir, { recursive: true })
  return dir
}

describe('gatherSoloSignalsTier1 — empty / non-git workDir', () => {
  it('returns an empty bag for a non-git scratch dir', async () => {
    const dir = await makeFixture('non-git')
    const out = await gatherSoloSignalsTier1(dir, emptyActivity(dir))
    // No git → stash count is 0 (skipped from output), no version
    // mismatch (no desktop/package.json), no in-progress markers.
    expect(out).toEqual({})
  })

  it('returns {} when workDir is empty string', async () => {
    expect(await gatherSoloSignalsTier1('', emptyActivity(''))).toEqual({})
  })
})

describe('gatherSoloSignalsTier1 — missing-tests detection', () => {
  it('flags a dirty source file with no on-disk sibling test', async () => {
    const dir = await makeFixture('missing-tests')
    await mkdir(path.join(dir, 'src'), { recursive: true })
    await writeFile(path.join(dir, 'src', 'foo.ts'), 'export const x = 1\n')
    // No foo.test.ts, no foo.spec.ts, no __tests__/foo.ts.

    const out = await gatherSoloSignalsTier1(
      dir,
      activityWithDirtyFiles(dir, ['src/foo.ts']),
    )
    expect(out.missingTestFiles).toEqual(['src/foo.ts'])
  })

  it('does NOT flag when a sibling test exists on disk (even if not dirty)', async () => {
    const dir = await makeFixture('has-test-sibling')
    await mkdir(path.join(dir, 'src'), { recursive: true })
    await writeFile(path.join(dir, 'src', 'foo.ts'), 'export const x = 1\n')
    await writeFile(path.join(dir, 'src', 'foo.test.ts'), 'test("x", () => {})\n')

    const out = await gatherSoloSignalsTier1(
      dir,
      activityWithDirtyFiles(dir, ['src/foo.ts']),
    )
    expect(out.missingTestFiles).toBeUndefined()
  })

  it('does NOT flag when the test file is in the dirty set itself', async () => {
    // The test sibling doesn't physically exist yet, but it appears
    // as dirty alongside the source — meaning the user IS adding
    // tests in this same change. Don't nag them about it.
    const dir = await makeFixture('test-being-added')
    await mkdir(path.join(dir, 'src'), { recursive: true })
    await writeFile(path.join(dir, 'src', 'foo.ts'), 'x\n')

    const out = await gatherSoloSignalsTier1(
      dir,
      activityWithDirtyFiles(dir, ['src/foo.ts', 'src/foo.test.ts']),
    )
    expect(out.missingTestFiles).toBeUndefined()
  })

  it('returns a stable order matching the dirty-file order', async () => {
    const dir = await makeFixture('stable-order')
    await mkdir(path.join(dir, 'src'), { recursive: true })
    await writeFile(path.join(dir, 'src', 'a.ts'), 'a\n')
    await writeFile(path.join(dir, 'src', 'b.ts'), 'b\n')

    const out = await gatherSoloSignalsTier1(
      dir,
      activityWithDirtyFiles(dir, ['src/b.ts', 'src/a.ts']),
    )
    expect(out.missingTestFiles).toEqual(['src/b.ts', 'src/a.ts'])
  })
})

describe('gatherSoloSignalsTier1 — TODO/FIXME marker detection', () => {
  it('captures markers from dirty files only', async () => {
    const dir = await makeFixture('todo-hits')
    await mkdir(path.join(dir, 'src'), { recursive: true })
    await writeFile(
      path.join(dir, 'src', 'foo.ts'),
      'const x = 1\n// TODO: fix the null case\nconst y = 2\n',
    )
    // This second file would also have a TODO but it's not in the
    // dirty set, so it should NOT be scanned.
    await writeFile(
      path.join(dir, 'src', 'untouched.ts'),
      '// FIXME: untouched\n',
    )

    const out = await gatherSoloSignalsTier1(
      dir,
      activityWithDirtyFiles(dir, ['src/foo.ts']),
    )
    expect(out.todoHits).toBeDefined()
    expect(out.todoHits!.length).toBe(1)
    expect(out.todoHits![0]!.path).toBe('src/foo.ts')
    expect(out.todoHits![0]!.excerpt).toContain('TODO')
    expect(out.todoHits![0]!.excerpt).toContain('null case')
  })

  it('skips binary-looking dirty files', async () => {
    const dir = await makeFixture('todo-binary')
    await writeFile(
      path.join(dir, 'blob.dat'),
      Buffer.from([0x00, 0x01, 0x02, 0x03]),
    )

    const out = await gatherSoloSignalsTier1(
      dir,
      activityWithDirtyFiles(dir, ['blob.dat']),
    )
    expect(out.todoHits).toBeUndefined()
  })

  it('matches FIXME / XXX / HACK as well as TODO', async () => {
    const dir = await makeFixture('todo-variants')
    await writeFile(
      path.join(dir, 'a.md'),
      'FIXME: doc this\nrandom line\nXXX: temporary hack\n',
    )

    const out = await gatherSoloSignalsTier1(
      dir,
      activityWithDirtyFiles(dir, ['a.md']),
    )
    expect(out.todoHits).toBeDefined()
    expect(out.todoHits!.length).toBe(2)
  })

  it('does NOT match noise like "PSEUDOTODO" or "FIXMEnow"', async () => {
    const dir = await makeFixture('todo-noise')
    await mkdir(path.join(dir, 'src'), { recursive: true })
    await writeFile(
      path.join(dir, 'src', 'foo.ts'),
      'AUTOTODO is fine\nFIXMEnow should not match\n',
    )

    const out = await gatherSoloSignalsTier1(
      dir,
      activityWithDirtyFiles(dir, ['src/foo.ts']),
    )
    expect(out.todoHits).toBeUndefined()
  })
})

describe('gatherSoloSignalsTier1 — release-mismatch detection', () => {
  it('detects notes-missing when desktop version is newer than the latest notes file', async () => {
    const dir = await makeFixture('release-notes-missing')
    await mkdir(path.join(dir, 'desktop'), { recursive: true })
    await mkdir(path.join(dir, 'release-notes'), { recursive: true })
    await writeFile(
      path.join(dir, 'desktop', 'package.json'),
      JSON.stringify({ name: 'app', version: '0.5.10' }),
    )
    // Latest notes is 0.5.9; package.json was bumped to 0.5.10.
    await writeFile(path.join(dir, 'release-notes', 'v0.5.9.md'), '# v0.5.9\n')

    const out = await gatherSoloSignalsTier1(dir, emptyActivity(dir))
    expect(out.releaseMismatch).toBeDefined()
    expect(out.releaseMismatch!.kind).toBe('notes-missing')
    expect(out.releaseMismatch!.desktopVersion).toBe('0.5.10')
    expect(out.releaseMismatch!.latestNotes).toBe('0.5.9')
  })

  it('detects version-not-bumped when notes exist for a higher version', async () => {
    const dir = await makeFixture('release-version-not-bumped')
    await mkdir(path.join(dir, 'desktop'), { recursive: true })
    await mkdir(path.join(dir, 'release-notes'), { recursive: true })
    await writeFile(
      path.join(dir, 'desktop', 'package.json'),
      JSON.stringify({ name: 'app', version: '0.5.9' }),
    )
    await writeFile(path.join(dir, 'release-notes', 'v0.5.9.md'), '# v0.5.9\n')
    await writeFile(path.join(dir, 'release-notes', 'v0.5.10.md'), '# v0.5.10\n')

    const out = await gatherSoloSignalsTier1(dir, emptyActivity(dir))
    expect(out.releaseMismatch).toBeDefined()
    expect(out.releaseMismatch!.kind).toBe('version-not-bumped')
    expect(out.releaseMismatch!.latestNotes).toBe('0.5.10')
  })

  it('returns undefined when versions are aligned and no remote check is possible', async () => {
    const dir = await makeFixture('release-aligned-no-remote')
    await mkdir(path.join(dir, 'desktop'), { recursive: true })
    await mkdir(path.join(dir, 'release-notes'), { recursive: true })
    await writeFile(
      path.join(dir, 'desktop', 'package.json'),
      JSON.stringify({ name: 'app', version: '0.5.10' }),
    )
    await writeFile(path.join(dir, 'release-notes', 'v0.5.10.md'), '# v0.5.10\n')
    // No git init — `git ls-remote` will throw, signal stays silent.

    const out = await gatherSoloSignalsTier1(dir, emptyActivity(dir))
    expect(out.releaseMismatch).toBeUndefined()
  })

  it('returns undefined when there are no release-notes files at all', async () => {
    const dir = await makeFixture('release-no-notes')
    await mkdir(path.join(dir, 'desktop'), { recursive: true })
    await writeFile(
      path.join(dir, 'desktop', 'package.json'),
      JSON.stringify({ name: 'app', version: '0.5.10' }),
    )

    const out = await gatherSoloSignalsTier1(dir, emptyActivity(dir))
    expect(out.releaseMismatch).toBeUndefined()
  })

  it('picks the highest semver from release-notes (not lexical max)', async () => {
    const dir = await makeFixture('release-semver-sort')
    await mkdir(path.join(dir, 'desktop'), { recursive: true })
    await mkdir(path.join(dir, 'release-notes'), { recursive: true })
    await writeFile(
      path.join(dir, 'desktop', 'package.json'),
      JSON.stringify({ name: 'app', version: '0.5.9' }),
    )
    // Lexical sort would pick v0.5.9 over v0.5.10. Semver-aware
    // sort must pick v0.5.10.
    await writeFile(path.join(dir, 'release-notes', 'v0.5.9.md'), '\n')
    await writeFile(path.join(dir, 'release-notes', 'v0.5.10.md'), '\n')

    const out = await gatherSoloSignalsTier1(dir, emptyActivity(dir))
    expect(out.releaseMismatch?.latestNotes).toBe('0.5.10')
  })
})

describe('gatherSoloSignalsTier1 — git-in-progress detection', () => {
  it('flags merge-in-progress when MERGE_HEAD exists', async () => {
    const dir = await makeFixture('git-merge')
    await mkdir(path.join(dir, '.git'), { recursive: true })
    await writeFile(
      path.join(dir, '.git', 'MERGE_HEAD'),
      'abc123abc123abc123abc123abc123abc123abc1\n',
    )
    const out = await gatherSoloSignalsTier1(dir, emptyActivity(dir))
    expect(out.gitInProgress).toBe('merge')
  })

  it('flags rebase-in-progress when rebase-merge dir exists', async () => {
    const dir = await makeFixture('git-rebase')
    await mkdir(path.join(dir, '.git', 'rebase-merge'), { recursive: true })
    const out = await gatherSoloSignalsTier1(dir, emptyActivity(dir))
    expect(out.gitInProgress).toBe('rebase')
  })

  it('flags cherry-pick when CHERRY_PICK_HEAD exists', async () => {
    const dir = await makeFixture('git-cherry')
    await mkdir(path.join(dir, '.git'), { recursive: true })
    await writeFile(path.join(dir, '.git', 'CHERRY_PICK_HEAD'), 'abc\n')
    const out = await gatherSoloSignalsTier1(dir, emptyActivity(dir))
    expect(out.gitInProgress).toBe('cherry-pick')
  })

  it('returns undefined for a clean .git', async () => {
    const dir = await makeFixture('git-clean')
    await mkdir(path.join(dir, '.git'), { recursive: true })
    const out = await gatherSoloSignalsTier1(dir, emptyActivity(dir))
    expect(out.gitInProgress).toBeUndefined()
  })

  it('handles a worktree gitfile pointer', async () => {
    // Secondary git worktrees have a .git FILE pointing to the
    // actual gitdir. Must still find MERGE_HEAD inside that gitdir.
    const dir = await makeFixture('git-worktree-pointer')
    const realGit = await makeFixture('git-worktree-pointer-realgit')
    await mkdir(realGit, { recursive: true })
    await writeFile(path.join(realGit, 'MERGE_HEAD'), 'abc\n')
    await writeFile(path.join(dir, '.git'), `gitdir: ${realGit}\n`)

    const out = await gatherSoloSignalsTier1(dir, emptyActivity(dir))
    expect(out.gitInProgress).toBe('merge')
  })
})

describe('gatherSoloSignalsTier1 — failure isolation', () => {
  it('one failing signal does not block the others', async () => {
    // Test fixture with both a valid TODO signal AND an absent
    // .git (so detectGitInProgress quickly returns undefined,
    // but detectStashCount fails). Other signals must still run.
    const dir = await makeFixture('failure-isolation')
    await mkdir(path.join(dir, 'src'), { recursive: true })
    await writeFile(
      path.join(dir, 'src', 'foo.ts'),
      '// TODO: needs love\nexport const x = 1\n',
    )

    const out = await gatherSoloSignalsTier1(
      dir,
      activityWithDirtyFiles(dir, ['src/foo.ts']),
    )
    expect(out.todoHits).toBeDefined()
    expect(out.missingTestFiles).toBeDefined()
    expect(out.gitInProgress).toBeUndefined()
    expect(out.stashCount).toBeUndefined() // No git → stays absent
  })
})
