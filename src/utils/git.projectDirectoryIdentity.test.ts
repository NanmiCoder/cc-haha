import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as git from './git.js'

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'git-project-identity-'))
  git.findGitRoot.cache.clear()
  git.findCanonicalGitRoot.cache.clear()
})
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

test('permission keys retain native Unicode while existing project grouping keeps NFC', async () => {
  const repository = join(root, 'e\u0301-project')
  const child = join(repository, 'src')
  await mkdir(join(repository, '.git'), { recursive: true })
  await mkdir(child)
  expect(git.findGitRoot(child)).toBe(repository.normalize('NFC'))
  expect(git.findCanonicalGitRoot(child)).toBe(repository.normalize('NFC'))
  expect(git.findCanonicalGitRootPreservingPathIdentity(child)).toBe(repository)
})

test('native identity uses the existing authenticated worktree backlink and rejects a borrowed one', async () => {
  const repository = join(root, 'e\u0301-main')
  const worktree = join(root, 'worktree')
  const entry = join(repository, '.git', 'worktrees', 'fixture')
  await mkdir(entry, { recursive: true })
  await mkdir(worktree)
  await writeFile(join(worktree, '.git'), `gitdir: ${entry}\n`)
  await writeFile(join(entry, 'commondir'), '../..\n')
  await writeFile(join(entry, 'gitdir'), join(worktree, '.git') + '\n')
  expect(git.findCanonicalGitRootPreservingPathIdentity(worktree)).toBe(repository)
  git.findCanonicalGitRoot.cache.clear()
  await writeFile(join(entry, 'gitdir'), join(root, 'someone-else', '.git') + '\n')
  expect(git.findCanonicalGitRootPreservingPathIdentity(worktree)).toBe(worktree)
})
