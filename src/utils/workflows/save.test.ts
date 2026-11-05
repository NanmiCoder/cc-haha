import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, symlinkSync } from 'fs'
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { resolveProjectWorkflowsDir, saveWorkflowScript } from './save.js'

let root: string
let configDir: string
let repo: string
const originalConfigDir = process.env.CLAUDE_CONFIG_DIR

const SCRIPT = [
  "export const meta = { name: 'my-review', description: 'Review the diff' }",
  "return await agent('review')",
].join('\n')

describe('saveWorkflowScript', () => {
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'wf-save-'))
    configDir = join(root, 'claude')
    repo = join(root, 'repo')
    mkdirSync(configDir, { recursive: true })
    mkdirSync(join(repo, '.git'), { recursive: true })
    process.env.CLAUDE_CONFIG_DIR = configDir
  })

  afterEach(async () => {
    if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = originalConfigDir
    await rm(root, { recursive: true, force: true })
  })

  test('saves to the personal directory under CLAUDE_CONFIG_DIR', async () => {
    const result = await saveWorkflowScript({ script: SCRIPT, scope: 'user' })
    expect(result).toEqual({
      name: 'my-review',
      filePath: join(configDir, 'workflows', 'my-review.js'),
    })
    expect(await readFile(join(configDir, 'workflows', 'my-review.js'), 'utf8')).toBe(
      SCRIPT,
    )
  })

  test('saves to the repository root when no .claude/workflows exists yet', async () => {
    const result = await saveWorkflowScript({
      script: SCRIPT,
      scope: 'project',
      cwd: join(repo, 'packages', 'api'),
    })
    expect('filePath' in result && result.filePath).toBe(
      join(repo, '.claude', 'workflows', 'my-review.js'),
    )
  })

  test('prefers the closest existing .claude/workflows in a monorepo', async () => {
    const pkg = join(repo, 'packages', 'api')
    mkdirSync(join(pkg, '.claude', 'workflows'), { recursive: true })
    mkdirSync(join(repo, '.claude', 'workflows'), { recursive: true })
    expect(resolveProjectWorkflowsDir(pkg)).toBe(
      join(pkg, '.claude', 'workflows'),
    )

    const result = await saveWorkflowScript({
      script: SCRIPT,
      scope: 'project',
      cwd: pkg,
    })
    expect('filePath' in result && result.filePath).toBe(
      join(pkg, '.claude', 'workflows', 'my-review.js'),
    )
  })

  test('rejects a script whose meta will not parse', async () => {
    const result = await saveWorkflowScript({
      script: 'const x = 1\n',
      scope: 'user',
    })
    expect('error' in result && result.error).toContain('FIRST statement')
  })

  test('refuses to write through a symlinked target file', async () => {
    const outside = join(root, 'outside.js')
    await writeFile(outside, '// untouched\n', 'utf8')
    mkdirSync(join(configDir, 'workflows'), { recursive: true })
    symlinkSync(process.platform === 'win32' ? root : outside, join(configDir, 'workflows', 'my-review.js'), process.platform === 'win32' ? 'junction' : 'file')

    const result = await saveWorkflowScript({ script: SCRIPT, scope: 'user' })
    expect('error' in result && result.error).toContain('symlink')
    expect(await readFile(outside, 'utf8')).toBe('// untouched\n')
  })

  test('refuses when the project .claude directory is itself a symlink', async () => {
    const elsewhere = join(root, 'elsewhere')
    mkdirSync(elsewhere, { recursive: true })
    symlinkSync(elsewhere, join(repo, '.claude'), process.platform === 'win32' ? 'junction' : 'dir')

    const result = await saveWorkflowScript({
      script: SCRIPT,
      scope: 'project',
      cwd: repo,
    })
    expect('error' in result && result.error).toContain('symlink')
  })
})
