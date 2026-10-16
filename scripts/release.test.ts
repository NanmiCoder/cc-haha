import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bumpVersion, prepareRelease, tagRelease } from './release'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function git(cwd: string, ...args: string[]) {
  const result = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' })
  if (result.exitCode !== 0) throw new Error(result.stderr.toString())
  return result.stdout.toString().trim()
}

/** A repository at 1.2.3 with notes for 1.2.4 and an `origin/main` ref. */
function fixtureRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'release-script-'))
  dirs.push(dir)
  mkdirSync(join(dir, 'desktop'))
  mkdirSync(join(dir, 'release-notes'))
  writeFileSync(join(dir, 'desktop/package.json'), '{\n  "name": "d",\n  "version": "1.2.3"\n}\n')
  writeFileSync(join(dir, 'release-notes/v1.2.4.md'), 'notes\n')
  git(dir, 'init', '-q', '-b', 'main')
  // The release script commits and tags in this repo itself; a CI runner has
  // no global git identity, so the fixture carries its own.
  git(dir, 'config', 'user.name', 'Release Test')
  git(dir, 'config', 'user.email', 'release-test@example.com')
  git(dir, 'config', 'commit.gpgsign', 'false')
  git(dir, 'config', 'tag.gpgsign', 'false')
  git(dir, 'add', '.')
  git(dir, 'commit', '-qm', 'base')
  return dir
}

describe('release script', () => {
  test('bumps versions', () => {
    expect(bumpVersion('1.2.3', 'patch')).toBe('1.2.4')
    expect(bumpVersion('1.2.3', 'minor')).toBe('1.3.0')
    expect(bumpVersion('1.2.3', 'major')).toBe('2.0.0')
    expect(bumpVersion('1.2.3', '4.5.6')).toBe('4.5.6')
    expect(bumpVersion('1.2.3', 'nope')).toBeNull()
  })

  test('commits the release on its own branch and never on main or as a tag', async () => {
    const dir = fixtureRepo()
    const result = await prepareRelease(dir, 'patch', { log: () => {} })

    expect(result).toEqual({ version: '1.2.4', branch: 'release/v1.2.4', committed: true })
    expect(git(dir, 'branch', '--show-current')).toBe('release/v1.2.4')
    expect(git(dir, 'log', '-1', '--format=%s')).toBe('release: v1.2.4')
    expect(git(dir, 'rev-list', '--count', 'main')).toBe('1')
    expect(git(dir, 'tag', '--list')).toBe('')
    expect(JSON.parse(readFileSync(join(dir, 'desktop/package.json'), 'utf8')).version).toBe('1.2.4')
  })

  test('refuses a release without notes and leaves the repository untouched', async () => {
    const dir = fixtureRepo()
    await expect(prepareRelease(dir, 'minor', { log: () => {} })).rejects.toThrow('Missing release notes file: release-notes/v1.3.0.md')
    expect(git(dir, 'branch', '--show-current')).toBe('main')
    expect(git(dir, 'status', '--porcelain')).toBe('')
  })

  test('tags the merged release commit only once main carries that version', async () => {
    const dir = fixtureRepo()
    await expect(tagRelease(dir, '1.2.4', { ref: 'main', fetch: false, log: () => {} }))
      .rejects.toThrow('main has desktop version 1.2.3, not 1.2.4. Merge the release PR first.')

    await prepareRelease(dir, 'patch', { log: () => {} })
    git(dir, 'switch', '-q', 'main')
    git(dir, 'merge', '-q', '--ff-only', 'release/v1.2.4')
    const merged = git(dir, 'rev-parse', 'main')
    const result = await tagRelease(dir, '1.2.4', { ref: 'main', fetch: false, log: () => {} })

    expect(result).toEqual({ tag: 'v1.2.4', commit: merged })
    expect(git(dir, 'rev-parse', 'v1.2.4^{commit}')).toBe(merged)
  })
})
