import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { changedFilesForLocalPrCheck } from './changed-files'

let originalCwd: string
let originalBaseRef: string | undefined
let tempDir: string

function runGit(args: string[]) {
  const result = Bun.spawnSync(['git', ...args], {
    cwd: tempDir,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (result.exitCode !== 0) {
    throw new Error(new TextDecoder().decode(result.stderr) || new TextDecoder().decode(result.stdout))
  }
}

function writeFile(relativePath: string, content: string) {
  const filePath = join(tempDir, relativePath)
  mkdirSync(join(filePath, '..'), { recursive: true })
  writeFileSync(filePath, content)
}

function commit(message: string) {
  runGit(['add', '.'])
  runGit(['commit', '-m', message])
}

describe('changedFilesForLocalPrCheck', () => {
  beforeEach(() => {
    originalCwd = process.cwd()
    originalBaseRef = process.env.PR_BASE_REF
    delete process.env.PR_BASE_REF
    tempDir = mkdtempSync(join(tmpdir(), 'cc-haha-changed-files-'))
    process.chdir(tempDir)
    runGit(['init', '-b', 'main'])
    runGit(['config', 'user.email', 'test@example.com'])
    runGit(['config', 'user.name', 'Test User'])
    writeFile('README.md', '# test\n')
    commit('base')
  })

  afterEach(() => {
    process.chdir(originalCwd)
    if (originalBaseRef === undefined) {
      delete process.env.PR_BASE_REF
    } else {
      process.env.PR_BASE_REF = originalBaseRef
    }
    rmSync(tempDir, { recursive: true, force: true })
  })

  test('uses only local changes in a dirty detached worktree', async () => {
    writeFile('scripts/quality-gate/coverage-thresholds.json', '{}\n')
    commit('historical policy change')
    runGit(['checkout', '--detach', 'HEAD'])
    writeFile('src/server/current.ts', 'export const current = true\n')

    await expect(changedFilesForLocalPrCheck()).resolves.toEqual(['src/server/current.ts'])
  })

  test('keeps branch commits and local changes on a normal branch', async () => {
    runGit(['checkout', '-b', 'feature/test'])
    writeFile('src/server/committed.ts', 'export const committed = true\n')
    commit('feature change')
    writeFile('desktop/src/local.ts', 'export const local = true\n')

    await expect(changedFilesForLocalPrCheck()).resolves.toEqual([
      'src/server/committed.ts',
      'desktop/src/local.ts',
    ])
  })
})
