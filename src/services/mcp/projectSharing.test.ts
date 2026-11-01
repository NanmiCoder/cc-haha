import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import * as fs from 'fs/promises'
import { writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { _setGlobalConfigCacheForTesting, getProjectPathForConfig } from '../../utils/config.js'
import { runWithCwdOverride } from '../../utils/cwd.js'
import { getGlobalClaudeFile } from '../../utils/env.js'
import { getFsImplementation, setFsImplementation } from '../../utils/fsOperations.js'
import * as lockfile from '../../utils/lockfile.js'
import * as platform from '../../utils/platform.js'
import { addMcpConfig, getProjectMcpDirectoryIdentity, readProjectMcpJsonSnapshot, resolveProjectMcpDirectory, withProjectMcpConfigLock, writeMcpjsonFile } from './config.js'
import { updateProjectMcpSelections } from './projectSharing.js'

let fixture: string
let configDir: string | undefined

describe('project MCP file mutation boundaries', () => {
  beforeEach(async () => {
    fixture = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'mcp-file-boundary-')))
    configDir = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = join(fixture, 'config')
    await fs.mkdir(process.env.CLAUDE_CONFIG_DIR, { recursive: true })
    getGlobalClaudeFile.cache.clear?.()
    getProjectPathForConfig.cache.clear?.()
    _setGlobalConfigCacheForTesting(null)
  })

  afterEach(async () => {
    if (configDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = configDir
    getGlobalClaudeFile.cache.clear?.()
    getProjectPathForConfig.cache.clear?.()
    _setGlobalConfigCacheForTesting(null)
    await fs.rm(fixture, { recursive: true, force: true })
  })

  it('rejects malformed existing files in legacy additions without replacing their bytes', async () => {
    const file = join(fixture, '.mcp.json')
    for (const contents of ['{', '[]', 'null', '42', '{"mcpServers":[]}', '{"mcpServers":null}', '{"mcpServers":"broken"}']) {
      await fs.writeFile(file, contents)
      await expect(runWithCwdOverride(fixture, () => addMcpConfig('new', { type: 'http', url: 'https://fixture.invalid' }, 'project'))).rejects.toThrow()
      expect(await fs.readFile(file, 'utf8')).toBe(contents)
    }
  })

  it('serializes simultaneous legacy additions instead of dropping sibling updates', async () => {
    await fs.writeFile(join(fixture, '.mcp.json'), JSON.stringify({ futureTop: true, mcpServers: { kept: { command: 'node' } } }))
    await Promise.all(['first', 'second', 'third'].map(name => runWithCwdOverride(fixture, () => addMcpConfig(name, { type: 'http', url: `https://${name}.invalid` }, 'project'))))
    const contents = JSON.parse(await fs.readFile(join(fixture, '.mcp.json'), 'utf8'))
    expect(Object.keys(contents.mcpServers).sort()).toEqual(['first', 'kept', 'second', 'third'])
    expect(contents.futureTop).toBe(true)
    expect((await fs.readdir(fixture)).filter(name => name.includes('.tmp.') || name.endsWith('.lock'))).toEqual([])
  })

  it('compares Windows case and separator aliases with the same target identity', () => {
    const currentPlatform = spyOn(platform, 'getPlatform').mockReturnValue('windows')
    try {
      expect(getProjectMcpDirectoryIdentity('C:\\Users\\Fixture\\Project')).toBe(getProjectMcpDirectoryIdentity('c:/users/fixture/project'))
      expect(getProjectMcpDirectoryIdentity('C:/Users/Fixture/Project-two')).not.toBe(getProjectMcpDirectoryIdentity('C:/Users/Fixture/Project'))
    } finally {
      currentPlatform.mockRestore()
    }
  })

  it('detects an external edit during temp-file preparation before replacing the destination', async () => {
    const file = join(fixture, '.mcp.json')
    await fs.writeFile(file, JSON.stringify({ mcpServers: { kept: { command: 'node' } } }))
    const revision = readProjectMcpJsonSnapshot(file).revision
    const external = JSON.stringify({ mcpServers: { kept: { command: 'externally-edited' } }, externallyAdded: true })
    const originalFs = getFsImplementation()
    let targetReads = 0
    setFsImplementation({
      ...originalFs,
      readFileSync: (target, options) => {
        if (target === file && ++targetReads === 2) writeFileSync(file, external)
        return originalFs.readFileSync(target, options)
      },
    })
    try {
      const result = await updateProjectMcpSelections('shared', { type: 'http', url: 'https://fixture.invalid' }, [
        { projectPath: fixture, selected: true, expectedRevision: revision },
      ])
      expect(result[0]?.success).toBe(false)
      expect(result[0]?.error).toContain('changed')
      expect(await fs.readFile(file, 'utf8')).toBe(external)
      expect((await fs.readdir(fixture)).some(name => name.includes('.tmp.'))).toBe(false)
    } finally {
      setFsImplementation(originalFs)
    }
  })

  it('refuses a replacement when its cooperative file lock has been compromised', async () => {
    const file = join(fixture, '.mcp.json')
    const original = JSON.stringify({ mcpServers: {} })
    await fs.writeFile(file, original)
    const revision = readProjectMcpJsonSnapshot(file).revision
    let compromise: (() => void) | undefined
    let released = false
    const lock = spyOn(lockfile, 'lock').mockImplementation(async (_target, options) => {
      compromise = () => options?.onCompromised?.(Object.assign(new Error('fixture lock lost'), { code: 'ECOMPROMISED' }))
      return async () => { released = true }
    })
    try {
      await expect(withProjectMcpConfigLock(fixture, async (lockedPath, assertLockHeld) => {
        compromise!()
        await writeMcpjsonFile({ mcpServers: { new: { command: 'node' } } }, lockedPath, { expectedRevision: revision, assertLockHeld })
      })).rejects.toThrow('Project MCP configuration lock was lost')
      expect(await fs.readFile(file, 'utf8')).toBe(original)
      expect(released).toBe(true)
    } finally {
      lock.mockRestore()
    }
  })

  it('preserves actual Unicode path bytes and keeps distinct POSIX directories separate', async () => {
    const decomposed = join(fixture, 'cafe\u0301')
    const composed = join(fixture, 'caf\u00e9')
    await fs.mkdir(decomposed, { recursive: true })
    await fs.mkdir(composed, { recursive: true })
    const decomposedReal = await fs.realpath(decomposed)
    const composedReal = await fs.realpath(composed)
    expect(await resolveProjectMcpDirectory(decomposed)).toBe(decomposedReal)
    const currentPlatform = spyOn(platform, 'getPlatform').mockReturnValue('linux')
    try {
      expect(getProjectMcpDirectoryIdentity(decomposed)).not.toBe(getProjectMcpDirectoryIdentity(composed))
    } finally {
      currentPlatform.mockRestore()
    }
    // Linux can store both byte-distinct names; some macOS filesystems resolve
    // both Unicode spellings to the same physical directory.
    const paths = [...new Set([decomposedReal, composedReal])]
    const results = await updateProjectMcpSelections('unicode', { type: 'http', url: 'https://fixture.invalid' }, paths.map(projectPath => ({ projectPath, selected: true, expectedRevision: null })))
    expect(results).toHaveLength(paths.length)
    expect(results.every(result => result.success)).toBe(true)
    for (const directory of paths) {
      expect(JSON.parse(await fs.readFile(join(directory, '.mcp.json'), 'utf8')).mcpServers.unicode.url).toBe('https://fixture.invalid')
    }
  })
})
