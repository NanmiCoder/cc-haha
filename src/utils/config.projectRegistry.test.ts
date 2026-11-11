import { expect, test } from 'bun:test'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { _setGlobalConfigCacheForTesting, enableConfigs, saveGlobalConfig } from './config.js'
import { getGlobalClaudeFile } from './env.js'

test('global config registry updaters persist new exact project keys and preserve unknown fields', async () => {
  const fixture = await mkdtemp(join(tmpdir(), 'config-project-registry-'))
  const previousNodeEnv = process.env.NODE_ENV
  const previousConfigDir = process.env.CLAUDE_CONFIG_DIR
  try {
    process.env.NODE_ENV = 'production'
    process.env.CLAUDE_CONFIG_DIR = fixture
    getGlobalClaudeFile.cache.clear?.()
    _setGlobalConfigCacheForTesting(null)
    const main = join(fixture, 'main')
    const worktree = join(fixture, 'worktree')
    const nested = join(main, 'nested')
    await mkdir(nested, { recursive: true })
    await mkdir(worktree, { recursive: true })
    await writeFile(getGlobalClaudeFile(), JSON.stringify({ futureGlobal: { keep: true }, projects: { [main]: { futureProject: { keep: true } } } }))
    enableConfigs()

    saveGlobalConfig(current => ({
      ...current,
      projects: {
        ...current.projects,
        [worktree]: { allowedTools: [], mcpContextUris: [], projectOnboardingSeenCount: 0 },
        [nested]: { allowedTools: [], mcpContextUris: [], projectOnboardingSeenCount: 0 },
      },
    }))

    const persisted = JSON.parse(await readFile(getGlobalClaudeFile(), 'utf8'))
    expect(persisted.projects[worktree]).toEqual({ allowedTools: [], mcpContextUris: [], projectOnboardingSeenCount: 0 })
    expect(persisted.projects[nested]).toEqual({ allowedTools: [], mcpContextUris: [], projectOnboardingSeenCount: 0 })
    expect(persisted.projects[main]).toEqual({ futureProject: { keep: true } })
    expect(persisted.futureGlobal).toEqual({ keep: true })
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = previousNodeEnv
    if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = previousConfigDir
    getGlobalClaudeFile.cache.clear?.()
    _setGlobalConfigCacheForTesting(null)
    await rm(fixture, { recursive: true, force: true })
  }
})
