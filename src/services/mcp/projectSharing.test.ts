import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import * as fs from 'fs/promises'
import { writeFileSync } from 'fs'
import * as nativeFs from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { _setGlobalConfigCacheForTesting, getGlobalConfig, getProjectPathForConfig } from '../../utils/config.js'
import { runWithCwdOverride } from '../../utils/cwd.js'
import { getGlobalClaudeFile } from '../../utils/env.js'
import { getFsImplementation, setFsImplementation } from '../../utils/fsOperations.js'
import * as lockfile from '../../utils/lockfile.js'
import * as platform from '../../utils/platform.js'
import { addMcpConfig, findProjectMcpRegistryKey, getProjectMcpDirectoryIdentity, readProjectMcpJsonSnapshot, resolveProjectMcpDirectory, resolveProjectMcpDirectorySync, withProjectMcpConfigLock, writeMcpjsonFile } from './config.js'
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

  it('updates every target beyond the directory I/O pool capacity in input order', async () => {
    const directories = Array.from({ length: 20 }, (_, index) => join(fixture, `project-${index}`))
    for (const directory of directories) await fs.mkdir(directory)
    const config = { type: 'http' as const, url: 'https://fixture.invalid' }
    const results = await updateProjectMcpSelections('shared', config, directories.map(projectPath => ({
      projectPath, selected: true, expectedRevision: null,
    })))

    expect(results.map(result => ({ projectPath: result.projectPath, success: result.success, error: result.error }))).toEqual(
      directories.map(projectPath => ({ projectPath, success: true, error: undefined })),
    )
    for (const [index, directory] of directories.entries()) {
      const saved = readProjectMcpJsonSnapshot(join(directory, '.mcp.json'))
      expect(saved.servers.shared).toEqual(config)
      expect(results[index]?.revision).toBe(saved.revision)
      expect(findProjectMcpRegistryKey(directory, getGlobalConfig().projects ?? {})).toBe(directory)
    }
  })

  it('detects aliases across a large batch before writing and isolates a late revision conflict', async () => {
    const directories = Array.from({ length: 19 }, (_, index) => join(fixture, `project-${index}`))
    for (const directory of directories) await fs.mkdir(directory)
    const alias = join(fixture, 'first-alias')
    await fs.symlink(directories[0]!, alias, process.platform === 'win32' ? 'junction' : 'dir')
    const last = directories.at(-1)!
    const original = JSON.stringify({ mcpServers: {}, futureTop: true })
    await fs.writeFile(join(last, '.mcp.json'), original)
    const results = await updateProjectMcpSelections('shared', { type: 'http', url: 'https://fixture.invalid' }, [
      ...directories.map(projectPath => ({ projectPath, selected: true, expectedRevision: null })),
      { projectPath: alias, selected: true, expectedRevision: null },
    ])

    expect(results).toHaveLength(20)
    expect(results[0]).toMatchObject({ projectPath: directories[0], success: false, error: 'Duplicate project target' })
    expect(results.at(-1)).toMatchObject({ projectPath: directories[0], success: false, error: 'Duplicate project target' })
    expect(results[18]).toMatchObject({ projectPath: last, success: false, error: 'Project .mcp.json changed; reload the project list and retry' })
    expect(results.slice(1, 18).every(result => result.success)).toBe(true)
    await expect(fs.stat(join(directories[0]!, '.mcp.json'))).rejects.toThrow()
    expect(await fs.readFile(join(last, '.mcp.json'), 'utf8')).toBe(original)
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

  it('isolates a target preflight rejection, passes raw config and skips preflight for removal', async () => {
    const first = join(fixture, 'first')
    const second = join(fixture, 'second')
    await fs.mkdir(first)
    await fs.mkdir(second)
    const firstFile = join(first, '.mcp.json')
    const raw = { type: 'stdio' as const, command: '${ISSUE1765_RAW_COMMAND}', args: ['${ISSUE1765_RAW_ARGUMENT}'], env: { PATH: '${ISSUE1765_RAW_PATH}' } }
    const original = JSON.stringify({ mcpServers: { shared: raw }, futureTop: true })
    await fs.writeFile(firstFile, original)
    const initial = readProjectMcpJsonSnapshot(firstFile)
    const checked: Array<{ config: unknown; directory: string }> = []
    const preflight = async (config: unknown, directory: string) => {
      checked.push({ config, directory })
      return directory !== first
    }

    const results = await updateProjectMcpSelections('shared', raw, [
      { projectPath: first, selected: true, expectedRevision: initial.revision },
      { projectPath: second, selected: true, expectedRevision: null },
    ], undefined, raw, preflight)

    expect(results.map(result => result.success)).toEqual([false, true])
    expect(results[0]?.error).toContain('executable')
    expect(await fs.readFile(firstFile, 'utf8')).toBe(original)
    expect(checked).toEqual([{ config: raw, directory: first }, { config: raw, directory: second }])
    expect(JSON.parse(await fs.readFile(join(second, '.mcp.json'), 'utf8')).mcpServers.shared).toEqual(raw)

    const removed = await updateProjectMcpSelections('shared', raw, [
      { projectPath: second, selected: false, expectedRevision: results[1]!.revision ?? null },
    ], undefined, raw, preflight)
    expect(removed[0]).toMatchObject({ success: true, configHash: null })
    expect(checked).toHaveLength(2)
    expect(JSON.parse(await fs.readFile(join(second, '.mcp.json'), 'utf8'))).toEqual({ mcpServers: {} })
  })

  it('refuses to write into a different directory substituted while the project lock is held', async () => {
    const directory = join(fixture, 'project')
    const retired = join(fixture, 'retired-project')
    await fs.mkdir(directory)
    const original = JSON.stringify({ mcpServers: { kept: { command: 'node' } } })
    await fs.writeFile(join(directory, '.mcp.json'), original)
    await expect(withProjectMcpConfigLock(directory, async (file, assertLockHeld) => {
      await fs.rename(directory, retired)
      await fs.mkdir(directory)
      await writeMcpjsonFile({ mcpServers: { unintended: { command: 'node' } } }, file, { assertLockHeld })
    })).rejects.toThrow('Project directory identity changed')
    expect(await fs.readFile(join(retired, '.mcp.json'), 'utf8')).toBe(original)
    await expect(fs.stat(join(directory, '.mcp.json'))).rejects.toThrow()
  })

  it('rejects a realpath result for a different existing inode and never reuses that registry alias', async () => {
    const requested = join(fixture, 'requested')
    const substitute = join(fixture, 'substitute')
    await fs.mkdir(requested)
    await fs.mkdir(substitute)
    const left = await fs.stat(requested)
    const right = await fs.stat(substitute)
    expect([left.dev, left.ino]).not.toEqual([right.dev, right.ino])
    const originalRealpath = nativeFs.realpathSync
    const realpath = spyOn(nativeFs, 'realpathSync').mockImplementation(path => path === requested ? substitute : originalRealpath(path))
    try {
      expect(() => resolveProjectMcpDirectorySync(requested)).toThrow('Project directory identity could not be verified')
      // The async resolver's native realpath substitution is tested inside its
      // worker in projectDirectoryIo.test.ts; a main-thread spy cannot reach it.
      expect(findProjectMcpRegistryKey(substitute, { [requested]: { futureProject: true } })).toBeUndefined()
      expect(findProjectMcpRegistryKey(requested, { [requested]: { futureProject: true } })).toBeUndefined()
      expect(getProjectMcpDirectoryIdentity(resolveProjectMcpDirectorySync(substitute))).toBe(getProjectMcpDirectoryIdentity(substitute))
    } finally {
      realpath.mockRestore()
    }
  })
})
