import { afterEach, beforeEach, expect, test } from 'bun:test'
import * as fs from 'node:fs'
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as paths from 'node:path'
import { Worker } from 'node:worker_threads'
import { findNativeGitRoot, projectRootFunctions, resolveCanonicalNativeGitRoot } from './projectRoot.js'

let root: string
beforeEach(async () => { root = await realpath(await mkdtemp(paths.join(tmpdir(), 'native-project-root-'))) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

async function resolveInWorker(startPaths: string[]): Promise<Array<string | null>> {
  const worker = new Worker(`
    const { parentPort, workerData } = require('node:worker_threads');
    const fs = require('node:fs');
    const paths = require('node:path');
    ${projectRootFunctions()}
    parentPort.postMessage(workerData.map(startPath => {
      const root = findNativeGitRoot(startPath, fs, paths).root;
      return root === null ? null : resolveCanonicalNativeGitRoot(root, fs, paths);
    }));
  `, { eval: true, workerData: startPaths })
  try {
    return await new Promise((resolve, reject) => {
      worker.once('message', resolve)
      worker.once('error', reject)
      worker.once('exit', code => { if (code !== 0) reject(new Error(`Project root fixture worker exited (${code})`)) })
    })
  } finally {
    await worker.terminate()
  }
}

test('shared native root functions retain Unicode and authenticate worktrees inside an eval worker', async () => {
  const repository = paths.join(root, 'e\u0301-main')
  const child = paths.join(repository, 'src')
  const worktree = paths.join(root, 'worktree')
  const entry = paths.join(repository, '.git', 'worktrees', 'fixture')
  const borrowed = paths.join(root, 'borrowed')
  await mkdir(entry, { recursive: true })
  await mkdir(child)
  await mkdir(worktree)
  await mkdir(borrowed)
  await writeFile(paths.join(worktree, '.git'), `gitdir: ${entry}\n`)
  await writeFile(paths.join(borrowed, '.git'), `gitdir: ${entry}\n`)
  await writeFile(paths.join(entry, 'commondir'), '../..\n')
  await writeFile(paths.join(entry, 'gitdir'), paths.join(worktree, '.git') + '\n')

  expect(findNativeGitRoot(child, fs, paths)).toEqual({ root: repository, statCount: 2 })
  expect(resolveCanonicalNativeGitRoot(worktree, fs, paths)).toBe(repository)
  expect(resolveCanonicalNativeGitRoot(borrowed, fs, paths)).toBe(borrowed)
  expect(await resolveInWorker([child, worktree, borrowed])).toEqual([repository, repository, borrowed])
})

test('shared canonical resolver rejects a symlinked .git backlink and a forged common directory structure', async () => {
  const repository = paths.join(root, 'main')
  const worktree = paths.join(root, 'worktree')
  const entry = paths.join(repository, '.git', 'worktrees', 'fixture')
  const attacker = paths.join(root, 'attacker')
  const malformed = paths.join(root, 'malformed')
  await mkdir(entry, { recursive: true })
  await mkdir(worktree)
  await mkdir(attacker)
  await mkdir(malformed)
  await writeFile(paths.join(worktree, '.git'), `gitdir: ${entry}\n`)
  await writeFile(paths.join(entry, 'commondir'), '../..\n')
  await writeFile(paths.join(entry, 'gitdir'), paths.join(worktree, '.git') + '\n')
  await symlink(paths.join(worktree, '.git'), paths.join(attacker, '.git'), process.platform === 'win32' ? 'file' : undefined)
  expect(await resolveInWorker([attacker])).toEqual([attacker])
  await writeFile(paths.join(malformed, '.git'), `gitdir: ${entry}\n`)
  await writeFile(paths.join(entry, 'commondir'), '../../wrong\n')
  expect(await resolveInWorker([malformed])).toEqual([malformed])
})
