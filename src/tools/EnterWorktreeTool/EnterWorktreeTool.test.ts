import { afterAll, expect, mock, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSandboxedTestEnvironment } from '../../../scripts/pr/test-environment.js'

const home = realpathSync(mkdtempSync(join(tmpdir(), 'enter-worktree-failure-')))
const repo = join(home, 'repo')
const subdirectory = join(repo, 'package')
mkdirSync(subdirectory, { recursive: true })
const originalEnv = { ...process.env }
const previousMacro = (globalThis as any).MACRO
const originalProcessCwd = process.cwd()
;(globalThis as any).MACRO = { VERSION: 'fixture', BUILD_TIME: 'fixture' }
for (const key of Object.keys(process.env)) delete process.env[key]
Object.assign(process.env, createSandboxedTestEnvironment(home, { DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1' }, originalEnv))
const initialized = Bun.spawnSync(['git', 'init', '-b', 'main', repo], { env: process.env, stdout: 'pipe', stderr: 'pipe' })
if (initialized.exitCode !== 0) throw new Error(initialized.stderr.toString())
const { getCwd } = await import('../../utils/cwd.js')
const { setCwd } = await import('../../utils/Shell.js')
const originalCwd = getCwd()
const originalWorktree = { ...await import('../../utils/worktree.js') }
let creationCwd: string | undefined
mock.module('../../utils/worktree.js', () => ({ ...originalWorktree, createWorktreeForSession: async () => {
  creationCwd = getCwd()
  throw new Error('fixture creation failure')
} }))
const { EnterWorktreeTool } = await import('./EnterWorktreeTool.js')

afterAll(() => {
  process.chdir(originalProcessCwd)
  setCwd(originalCwd)
  mock.module('../../utils/worktree.js', () => originalWorktree)
  for (const key of Object.keys(process.env)) delete process.env[key]
  Object.assign(process.env, originalEnv)
  if (previousMacro === undefined) delete (globalThis as any).MACRO
  else (globalThis as any).MACRO = previousMacro
  rmSync(home, { recursive: true, force: true })
})

test('a failed creation from a repository subdirectory restores both CLI cwd values', async () => {
  process.chdir(subdirectory)
  setCwd(subdirectory)
  await expect(EnterWorktreeTool.call({ name: 'blocked' } as any, {} as any, {} as any, {} as any)).rejects.toThrow('fixture creation failure')
  expect(creationCwd).toBe(repo)
  expect(getCwd()).toBe(subdirectory)
  expect(process.cwd()).toBe(subdirectory)
  expect(originalWorktree.getCurrentWorktreeSession()).toBeNull()
})
