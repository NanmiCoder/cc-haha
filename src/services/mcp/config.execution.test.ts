import '../../../preload.ts'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { isMcpServerDisabledForExecution } from './config.js'
import { getGlobalClaudeFile } from '../../utils/env.js'
import { _setGlobalConfigCacheForTesting, getProjectPathForConfig } from '../../utils/config.js'

let root: string
let previousConfigDir: string | undefined
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'qa005-config-'))
  previousConfigDir = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = root
  getGlobalClaudeFile.cache.clear?.()
})
afterEach(async () => {
  if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = previousConfigDir
  getGlobalClaudeFile.cache.clear?.()
  _setGlobalConfigCacheForTesting(null)
  await rm(root, { recursive: true, force: true })
})

describe('MCP execution policy freshness', () => {
  test('reads another process write immediately even when the global cache still permits it', async () => {
    const key = getProjectPathForConfig(root)
    _setGlobalConfigCacheForTesting({ projects: { [key]: { disabledMcpServers: [] } } } as never)
    const file = getGlobalClaudeFile()
    expect(isMcpServerDisabledForExecution('echo', root)).toBe(false)
    const proc = Bun.spawn([process.execPath, '-e', 'require("fs").writeFileSync(process.argv[1], process.argv[2])', file,
      JSON.stringify({ projects: { [key]: { disabledMcpServers: ['echo'] } } })], { stdout: 'pipe', stderr: 'pipe' })
    expect(await proc.exited).toBe(0)
    expect(isMcpServerDisabledForExecution('echo', root)).toBe(true)
    expect(isMcpServerDisabledForExecution('echo', join(root, 'other'))).toBe(false)
    await writeFile(file, JSON.stringify({ projects: { [key]: { disabledMcpServers: [] } } }))
    expect(isMcpServerDisabledForExecution('echo', root)).toBe(false)
  })

  test('does not authorize execution from unreadable policy shapes', async () => {
    const key = getProjectPathForConfig(root)
    for (const contents of ['{', 'null', '[]', '{"projects":null}', JSON.stringify({ projects: { [key]: null } }),
      JSON.stringify({ projects: { [key]: { disabledMcpServers: 'echo' } } })]) {
      await writeFile(getGlobalClaudeFile(), contents)
      expect(() => isMcpServerDisabledForExecution('echo', root)).toThrow('Cannot read MCP enablement state')
    }
  })
})
