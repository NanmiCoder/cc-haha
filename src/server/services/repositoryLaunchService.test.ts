import { afterEach, expect, test } from 'bun:test'
import { execFile as execFileCallback } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { clearFilesystemAccessRootsForTests } from './filesystemAccessRoots.js'
import { getRepositoryContext } from './repositoryLaunchService.js'

const execFile = promisify(execFileCallback)
let fixture: string | undefined

afterEach(async () => {
  clearFilesystemAccessRootsForTests()
  if (fixture) await rm(fixture, { recursive: true, force: true })
  fixture = undefined
})

test('repository context resolves every canonical worktree beyond the directory I/O pool capacity', async () => {
  fixture = await realpath(await mkdtemp(join(tmpdir(), 'repository-context-batch-')))
  const main = join(fixture, 'main')
  await mkdir(main)
  const git = async (...args: string[]) => execFile('git', args, {
    cwd: main,
    env: { ...process.env, GIT_CONFIG_GLOBAL: join(fixture!, 'empty-git-config'), GIT_CONFIG_NOSYSTEM: '1' },
  })
  await git('init', '--quiet', '--initial-branch=main')
  await git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '--quiet', '-m', 'fixture')

  const expected = [{ path: main, branch: 'main', current: true }]
  for (let index = 1; index < 20; index++) {
    const directory = join(fixture, `worktree-${String(index).padStart(2, '0')}`)
    const branch = `fixture-${index}`
    await git('worktree', 'add', '--quiet', '-b', branch, directory, 'HEAD')
    expected.push({ path: directory, branch, current: false })
    if (expected.length < 18) continue

    const context = await getRepositoryContext(main)
    expect({ total: expected.length, state: context.state, error: context.error }).toEqual({
      total: expected.length, state: 'ok', error: undefined,
    })
    expect(context.repoRoot).toBe(main)
    expect(context.worktrees).toEqual(expected)
    for (const worktree of expected) {
      expect(context.branches.find(branch => branch.name === worktree.branch)).toMatchObject({
        checkedOut: true, worktreePath: worktree.path, current: worktree.current,
      })
    }
  }
}, 30_000)
