import '../../../preload.ts'
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { createHash } from 'crypto'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import { addMcpConfig } from '../../services/mcp/config.js'
import { _setGlobalConfigCacheForTesting, getProjectPathForConfig } from '../../utils/config.js'
import * as configUtils from '../../utils/config.js'
import { runWithCwdOverride } from '../../utils/cwd.js'
import { getGlobalClaudeFile } from '../../utils/env.js'
import { handleMcpApi } from '../api/mcp.js'
import * as mcpHostPreflight from '../services/mcpHostPreflight.js'

type ProjectState = { projectPath: string; revision: string | null; selected: boolean; conflict?: boolean; error?: string; configHash?: string }
type ProjectResult = { projectPath: string; selected: boolean; success: boolean; revision?: string | null; error?: string; configHash?: string | null }

const config = { type: 'http', url: 'https://example.invalid/mcp', headers: { Authorization: 'Bearer ${FIXTURE_TOKEN}' } }
let fixture: string
let originalEnv: { nodeEnv?: string; configDir?: string }
let preflight: ReturnType<typeof spyOn>

function resetCaches() {
  getGlobalClaudeFile.cache.clear?.()
  getProjectPathForConfig.cache.clear?.()
  _setGlobalConfigCacheForTesting(null)
}

async function request(method: string, urlPath: string, body?: unknown) {
  const url = new URL(urlPath, 'http://localhost:3456')
  const req = new Request(url, {
    method,
    ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  })
  const response = await handleMcpApi(req, url, url.pathname.split('/').filter(Boolean))
  return { status: response.status, body: await response.json() }
}

async function project(name: string, contents?: unknown) {
  const dir = path.join(fixture, name)
  await fs.mkdir(dir, { recursive: true })
  if (contents !== undefined) await fs.writeFile(path.join(dir, '.mcp.json'), JSON.stringify(contents, null, 2))
  return dir
}

async function read(dir: string) {
  return JSON.parse(await fs.readFile(path.join(dir, '.mcp.json'), 'utf8'))
}

async function preview(paths: string[], sourceCwd?: string, configHashes?: string[]) {
  const query = new URLSearchParams()
  for (const dir of paths) query.append('projectPath', dir)
  if (sourceCwd) query.set('sourceCwd', sourceCwd)
  for (const hash of configHashes ?? []) query.append('configHash', hash)
  const result = await request('GET', `/api/mcp/shared/projects?${query}`)
  expect(result.status).toBe(200)
  return result
}

function target(state: ProjectState, selected: boolean) {
  return { projectPath: state.projectPath, selected, expectedRevision: state.revision }
}

describe('MCP project sharing API', () => {
  beforeEach(async () => {
    fixture = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-project-sharing-')))
    originalEnv = { nodeEnv: process.env.NODE_ENV, configDir: process.env.CLAUDE_CONFIG_DIR }
    process.env.NODE_ENV = 'development'
    process.env.CLAUDE_CONFIG_DIR = path.join(fixture, 'config')
    await fs.mkdir(process.env.CLAUDE_CONFIG_DIR, { recursive: true })
    resetCaches()
    preflight = spyOn(mcpHostPreflight, 'inspectMcpHostCommand').mockResolvedValue({ ok: true, resolvedCommand: '/fixture/node' })
  })

  afterEach(async () => {
    preflight.mockRestore()
    if (originalEnv.nodeEnv === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = originalEnv.nodeEnv
    if (originalEnv.configDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = originalEnv.configDir
    resetCaches()
    await fs.rm(fixture, { recursive: true, force: true })
  })

  it('previews direct raw declarations, conflicts and registry projects without expanding variables', async () => {
    const sourceRaw = { ...config, futureField: { keep: true } }
    const source = await project('source', { mcpServers: { shared: sourceRaw } })
    const matching = await project('matching', { mcpServers: { shared: sourceRaw } })
    const conflict = await project('conflict', { mcpServers: { shared: { type: 'http', url: 'https://other.invalid' } } })
    const fresh = await project('fresh')
    const globalFile = getGlobalClaudeFile()
    const globalContents = JSON.stringify({ mcpServers: { shared: { type: 'http', url: 'https://global.invalid' } }, projects: { [matching]: { mcpServers: { shared: { type: 'http', url: 'https://local.invalid' } } } } })
    await fs.writeFile(globalFile, globalContents)

    const result = await preview([source, conflict, fresh], source)

    expect(result.status).toBe(200)
    expect(result.body.config.headers.Authorization).toBe('Bearer ${FIXTURE_TOKEN}')
    expect(result.body.sourceConfig).toEqual(sourceRaw)
    expect(result.body.projects.find((state: ProjectState) => state.projectPath === matching).configHash)
      .toBe(result.body.projects.find((state: ProjectState) => state.projectPath === source).configHash)
    expect(result.body.projects).toEqual(expect.arrayContaining([
      expect.objectContaining({ projectPath: source, selected: true }),
      expect.objectContaining({ projectPath: matching, selected: true }),
      expect.objectContaining({ projectPath: conflict, selected: false, conflict: true }),
      expect.objectContaining({ projectPath: fresh, selected: false, revision: null }),
    ]))
    expect(await fs.readFile(globalFile, 'utf8')).toBe(globalContents)
  })

  it('copies to selected files while preserving source extensions, sibling entries and global state', async () => {
    const source = await project('source', { mcpServers: { shared: { ...config, futureField: { keep: true }, oauth: { xaa: true, futureOAuth: 'kept' } } } })
    const destination = await project('destination', { inputs: [{ id: 'kept' }], mcpServers: { sibling: { command: 'node', env: { TOKEN: '${OTHER_TOKEN}' }, futureSibling: true } } })
    await fs.chmod(path.join(destination, '.mcp.json'), 0o600)
    const snapshot = await preview([source, destination], source)
    const states = snapshot.body.projects as ProjectState[]
    const save = await request('PUT', '/api/mcp/shared/projects', { sourceCwd: source, config, targets: states.map(state => target(state, true)) })

    expect(save.status).toBe(200)
    expect(save.body.results.every((result: ProjectResult) => result.success)).toBe(true)
    const persisted = await read(destination)
    expect(persisted.inputs).toEqual([{ id: 'kept' }])
    expect(persisted.mcpServers.shared).toMatchObject({ ...config, futureField: { keep: true }, oauth: { xaa: true, futureOAuth: 'kept' } })
    expect(persisted.mcpServers.sibling).toEqual({ command: 'node', env: { TOKEN: '${OTHER_TOKEN}' }, futureSibling: true })
    expect((await fs.stat(path.join(destination, '.mcp.json'))).mode & 0o777).toBe(0o600)
    const global = JSON.parse(await fs.readFile(getGlobalClaudeFile(), 'utf8'))
    expect(Object.keys(global.projects ?? {})).toEqual(expect.arrayContaining([source, destination]))
  })

  it('deselects only direct target entries and never removes an inherited ancestor declaration', async () => {
    const parent = await project('parent', { $schema: 'fixture', mcpServers: { shared: config, sibling: { command: 'node' } } })
    const child = await project('parent/child')
    const direct = await project('direct', { futureTop: true, mcpServers: { shared: config, kept: { command: 'node', future: true } } })
    const states = (await preview([child, direct], parent)).body.projects as ProjectState[]
    const save = await request('PUT', '/api/mcp/shared/projects', { config, sourceCwd: parent, targets: states.filter(state => state.projectPath !== parent).map(state => target(state, false)) })

    expect(save.status).toBe(200)
    expect(save.body.results.every((result: ProjectResult) => result.success)).toBe(true)
    expect((await read(parent)).mcpServers.shared).toEqual(config)
    await expect(fs.stat(path.join(child, '.mcp.json'))).rejects.toThrow()
    expect(await read(direct)).toEqual({ futureTop: true, mcpServers: { kept: { command: 'node', future: true } } })
    const directResult = save.body.results.find((result: ProjectResult) => result.projectPath === direct)
    expect(directResult.revision).toBe(createHash('sha256').update(await fs.readFile(path.join(direct, '.mcp.json'))).digest('hex'))
  })

  it('rejects malformed targets without replacing their bytes and still saves independent targets', async () => {
    const broken = await project('broken')
    const good = await project('good')
    await fs.writeFile(path.join(broken, '.mcp.json'), '{"secret":"fixture-token",')
    const states = (await preview([broken, good])).body.projects as ProjectState[]
    expect(states.find(state => state.projectPath === broken)?.error).toBeTruthy()
    const save = await request('PUT', '/api/mcp/shared/projects', { config, targets: states.map(state => target(state, true)) })

    expect(save.status).toBe(200)
    expect(save.body.results.find((result: ProjectResult) => result.projectPath === broken)?.success).toBe(false)
    expect(save.body.results.find((result: ProjectResult) => result.projectPath === good)?.success).toBe(true)
    expect(JSON.stringify(save.body)).not.toContain('fixture-token')
    expect(await fs.readFile(path.join(broken, '.mcp.json'), 'utf8')).toBe('{"secret":"fixture-token",')
    expect((await read(good)).mcpServers.shared).toEqual(config)
  })

  it('rejects stale file revisions and never overwrites an external same-name replacement', async () => {
    const source = await project('source', { mcpServers: { shared: config } })
    const state = (await preview([source], source)).body.projects[0] as ProjectState
    const replacement = { futureTop: true, mcpServers: { shared: { type: 'http', url: 'https://replacement.invalid' } } }
    await fs.writeFile(path.join(source, '.mcp.json'), JSON.stringify(replacement))

    const save = await request('PUT', '/api/mcp/shared/projects', { config, sourceCwd: source, targets: [target(state, false)] })

    expect(save.status).toBe(200)
    expect(save.body.results[0].success).toBe(false)
    expect(save.body.results[0].error).toContain('changed')
    expect(await read(source)).toEqual(replacement)
  })

  it('rejects directory aliases in one mutation without applying conflicting duplicate targets', async () => {
    const destination = await project('destination')
    const alias = path.join(fixture, 'alias')
    await fs.symlink(destination, alias, 'dir')
    const states = (await preview([destination, alias])).body.projects as ProjectState[]
    expect(states).toHaveLength(1)
    const aliasPreview = (await preview([alias])).body.projects as ProjectState[]
    expect(aliasPreview[0]).toMatchObject({ projectPath: destination, requestedPath: alias })
    const save = await request('PUT', '/api/mcp/shared/projects', { config, targets: [target(states[0]!, true), { projectPath: alias, selected: false, expectedRevision: null }] })

    expect(save.status).toBe(200)
    expect(save.body.results.every((result: ProjectResult) => !result.success)).toBe(true)
    await expect(fs.stat(path.join(destination, '.mcp.json'))).rejects.toThrow()
  })

  it('retries a failed target after the original source was removed successfully', async () => {
    const source = await project('source', { mcpServers: { shared: config } })
    const other = await project('other', { mcpServers: { shared: config } })
    const states = (await preview([source, other], source)).body.projects as ProjectState[]
    const sourceState = states.find(state => state.projectPath === source)!
    const otherState = states.find(state => state.projectPath === other)!
    await fs.writeFile(path.join(other, '.mcp.json'), JSON.stringify({ mcpServers: { shared: config }, externallyAdded: true }))
    const first = await request('PUT', '/api/mcp/shared/projects', { config, sourceCwd: source, targets: [target(sourceState, false), target(otherState, false)] })
    expect(first.body.results.map((result: ProjectResult) => result.success)).toEqual([true, false])
    const refreshed = (await preview([other])).body.projects.find((state: ProjectState) => state.projectPath === other) as ProjectState

    const retry = await request('PUT', '/api/mcp/shared/projects', { config, sourceCwd: source, targets: [target(refreshed, false)] })

    expect(retry.body.results[0].success).toBe(true)
    expect(await read(other)).toEqual({ mcpServers: {}, externallyAdded: true })
  })

  it('serializes legacy project writes with shared updates so unrelated entries survive', async () => {
    const destination = await project('destination', { mcpServers: { kept: { command: 'node' } } })
    const state = (await preview([destination])).body.projects[0] as ProjectState

    const [save] = await Promise.all([
      request('PUT', '/api/mcp/shared/projects', { config, targets: [target(state, true)] }),
      runWithCwdOverride(destination, () => addMcpConfig('legacy', { type: 'http', url: 'https://legacy.invalid' }, 'project')),
    ])

    const persisted = await read(destination)
    expect(persisted.mcpServers.legacy).toEqual({ type: 'http', url: 'https://legacy.invalid' })
    expect(persisted.mcpServers.kept).toEqual({ command: 'node' })
    if (save.body.results[0].success) expect(persisted.mcpServers.shared).toEqual(config)
  })

  it('registers exact worktree and nested targets without replacing the main repository registry entry', async () => {
    const main = await project('main')
    const worktree = await project('worktree')
    const nested = await project('main/nested')
    const worktreeGitDir = path.join(main, '.git', 'worktrees', 'fixture')
    await fs.mkdir(worktreeGitDir, { recursive: true })
    await fs.writeFile(path.join(worktree, '.git'), `gitdir: ${worktreeGitDir}`)
    await fs.writeFile(path.join(worktreeGitDir, 'commondir'), '../..')
    await fs.writeFile(path.join(worktreeGitDir, 'gitdir'), path.join(worktree, '.git'))
    expect(getProjectPathForConfig(worktree)).toBe(main)
    expect(getProjectPathForConfig(nested)).toBe(main)
    await fs.writeFile(getGlobalClaudeFile(), JSON.stringify({ futureGlobal: true, projects: { [main]: { futureProject: true } } }))
    const states = (await preview([worktree, nested])).body.projects as ProjectState[]

    const save = await request('PUT', '/api/mcp/shared/projects', { config, targets: states.map(state => target(state, true)) })

    expect(save.body.results.every((result: ProjectResult) => result.success)).toBe(true)
    const global = JSON.parse(await fs.readFile(getGlobalClaudeFile(), 'utf8'))
    expect(global.futureGlobal).toBe(true)
    expect(global.projects[main]).toEqual({ futureProject: true })
    expect(Object.keys(global.projects)).toEqual(expect.arrayContaining([main, worktree, nested]))
    resetCaches()
    const rediscovered = await preview([])
    expect(rediscovered.body.projects.map((state: ProjectState) => state.projectPath)).toEqual(expect.arrayContaining([worktree, nested]))
  })

  it('retries a partially saved creation without treating its completed target as a name conflict', async () => {
    const first = await project('first')
    const second = await project('second')
    const states = (await preview([first, second])).body.projects as ProjectState[]
    await fs.writeFile(path.join(second, '.mcp.json'), JSON.stringify({ inputs: [{ id: 'external' }], mcpServers: {} }))
    const firstSave = await request('PUT', '/api/mcp/shared/projects', { config, targets: states.map(state => target(state, true)) })
    expect(firstSave.body.results.map((result: ProjectResult) => result.success)).toEqual([true, false])
    const updatedSecond = (await preview([second])).body.projects.find((state: ProjectState) => state.projectPath === second) as ProjectState
    const retry = await request('PUT', '/api/mcp/shared/projects', { config, targets: [
      { projectPath: first, selected: true, expectedRevision: firstSave.body.results[0].revision },
      target(updatedSecond, true),
    ] })

    expect(retry.body.results.every((result: ProjectResult) => result.success)).toBe(true)
    expect(retry.body.results[0].configHash).toBe(firstSave.body.results[0].configHash)
    expect((await read(first)).mcpServers.shared).toEqual(config)
    expect(await read(second)).toEqual({ inputs: [{ id: 'external' }], mcpServers: { shared: config } })
  })

  it('updates and removes shared declarations despite same-name local and user configuration', async () => {
    const source = await project('source', { mcpServers: { shared: config } })
    const userServer = { type: 'http', url: 'https://global.invalid' }
    const localServer = { type: 'http', url: 'https://local.invalid' }
    await fs.writeFile(getGlobalClaudeFile(), JSON.stringify({ futureGlobal: true, mcpServers: { shared: userServer }, projects: { [source]: { mcpServers: { shared: localServer }, futureProject: true } } }))
    const state = (await preview([source], source)).body.projects[0] as ProjectState
    const nextConfig = { type: 'http', url: 'https://edited.invalid', headers: {} }
    const save = await request('PUT', '/api/mcp/shared/projects', { sourceCwd: source, config: nextConfig, targets: [target(state, true)] })
    expect(save.body.results[0].success).toBe(true)
    expect((await read(source)).mcpServers.shared).toEqual({ type: 'http', url: 'https://edited.invalid' })
    const remove = await request('PUT', '/api/mcp/shared/projects', { sourceCwd: source, config: nextConfig, targets: [{ projectPath: source, selected: false, expectedRevision: save.body.results[0].revision }] })
    expect(remove.body.results[0].success).toBe(true)
    const global = JSON.parse(await fs.readFile(getGlobalClaudeFile(), 'utf8'))
    expect(global).toEqual({ futureGlobal: true, mcpServers: { shared: userServer }, projects: { [source]: { mcpServers: { shared: localServer }, futureProject: true } } })
  })

  it('treats an empty selection as a no-op and requires explicit file revisions for mutations', async () => {
    const destination = await project('destination')
    const empty = await request('PUT', '/api/mcp/shared/projects', { targets: [] })
    expect(empty).toEqual({ status: 200, body: { results: [] } })
    const invalid = await request('PUT', '/api/mcp/shared/projects', { config, targets: [{ projectPath: destination, selected: true }] })
    expect(invalid.status).toBe(400)
    await expect(fs.stat(path.join(destination, '.mcp.json'))).rejects.toThrow()
    await expect(fs.stat(getGlobalClaudeFile())).rejects.toThrow()
  })

  it('does not overwrite a different same-name declaration during creation', async () => {
    const contents = { mcpServers: { shared: { type: 'http', url: 'https://other.invalid' } } }
    const destination = await project('destination', contents)
    const state = (await preview([destination])).body.projects[0] as ProjectState
    expect(state).toMatchObject({ selected: false, conflict: true })
    const save = await request('PUT', '/api/mcp/shared/projects', { config, targets: [target(state, true)] })
    expect(save.body.results[0].success).toBe(false)
    expect(await read(destination)).toEqual(contents)
  })

  it('keeps unavailable targets visible and reports their errors independently', async () => {
    const missing = path.join(fixture, 'missing')
    const destination = await project('destination')
    const states = (await preview([missing, destination])).body.projects as ProjectState[]
    expect(states.find(state => state.projectPath === missing)).toMatchObject({ selected: false, error: 'Project directory is unavailable' })
    const save = await request('PUT', '/api/mcp/shared/projects', { config, targets: states.map(state => target(state, true)) })
    expect(save.body.results.map((result: ProjectResult) => result.success)).toEqual([false, true])
    expect((await read(destination)).mcpServers.shared).toEqual(config)
  })

  it('reports a saved file revision when discovery registration fails and permits retry', async () => {
    const destination = await project('destination')
    const state = (await preview([destination])).body.projects[0] as ProjectState
    const register = spyOn(configUtils, 'saveGlobalConfig').mockImplementation(() => { throw new Error('fixture provider secret') })
    let failed
    try {
      failed = await request('PUT', '/api/mcp/shared/projects', { config, targets: [target(state, true)] })
    } finally {
      register.mockRestore()
    }
    expect(failed.body.results[0]).toMatchObject({ success: false, persisted: true })
    expect(failed.body.results[0].configHash).toMatch(/^[0-9a-f]{64}$/)
    expect(failed.body.results[0].revision).toBe(createHash('sha256').update(await fs.readFile(path.join(destination, '.mcp.json'))).digest('hex'))
    expect(JSON.stringify(failed.body)).not.toContain('fixture provider secret')
    expect((await read(destination)).mcpServers.shared).toEqual(config)
    const retry = await request('PUT', '/api/mcp/shared/projects', { config, targets: [{ projectPath: destination, selected: true, expectedRevision: failed.body.results[0].revision }] })
    expect(retry.body.results[0].success).toBe(true)
    expect(retry.body.results[0].configHash).toBe(failed.body.results[0].configHash)
    expect(JSON.parse(await fs.readFile(getGlobalClaudeFile(), 'utf8')).projects[destination]).toBeTruthy()
  })

  it('retries copying immutable source extensions after the original declaration was removed', async () => {
    const sourceRaw = { ...config, futureField: { keep: true }, oauth: { xaa: true, futureOAuth: 'keep' } }
    const source = await project('source', { mcpServers: { shared: sourceRaw } })
    const first = await project('first')
    const second = await project('second')
    const initial = (await preview([source, first, second], source)).body
    expect(initial.sourceConfig).toEqual(sourceRaw)
    expect(initial.projects.find((state: ProjectState) => state.projectPath === source).configHash).toMatch(/^[0-9a-f]{64}$/)
    await fs.writeFile(path.join(second, '.mcp.json'), JSON.stringify({ mcpServers: {}, futureTop: true }))
    const save = await request('PUT', '/api/mcp/shared/projects', { config, sourceCwd: source, sourceConfig: initial.sourceConfig, targets: initial.projects.map((state: ProjectState) => target(state, state.projectPath !== source)) })
    expect(save.body.results.map((result: ProjectResult) => result.success)).toEqual([true, true, false])
    expect(save.body.results[0].configHash).toBeNull()
    const knownHashes = [initial.projects[0].configHash, save.body.results[1].configHash]
    const replacement = { type: 'http', url: 'https://replacement.invalid/mcp', futureField: { keep: false } }
    await fs.writeFile(path.join(source, '.mcp.json'), JSON.stringify({ mcpServers: { shared: replacement } }))
    const refreshed = (await preview([source, first, second], source, knownHashes)).body
    expect(refreshed.projects.find((state: ProjectState) => state.projectPath === source)).toMatchObject({ selected: false, conflict: true })
    const secondState = refreshed.projects.find((state: ProjectState) => state.projectPath === second) as ProjectState
    const retry = await request('PUT', '/api/mcp/shared/projects', { config, sourceCwd: source, sourceConfig: initial.sourceConfig, targets: [target(secondState, true)] })

    expect(retry.body.results[0].success).toBe(true)
    expect((await read(second)).mcpServers.shared).toEqual(sourceRaw)
    expect(retry.body.results[0].configHash).toBe(save.body.results[1].configHash)
  })

  it('uses only supplied membership hashes when refreshing a partially updated group', async () => {
    const source = await project('source', { mcpServers: { shared: config } })
    const other = await project('other', { mcpServers: { shared: config } })
    const initial = (await preview([source, other], source)).body
    const oldHash = initial.projects[0].configHash
    expect(oldHash).toMatch(/^[0-9a-f]{64}$/)
    await fs.writeFile(path.join(other, '.mcp.json'), JSON.stringify({ mcpServers: { shared: config }, futureTop: true }))
    const edited = { ...config, url: 'https://edited.invalid/mcp' }
    const save = await request('PUT', '/api/mcp/shared/projects', { config: edited, sourceCwd: source, sourceConfig: initial.sourceConfig, targets: initial.projects.map((state: ProjectState) => target(state, true)) })
    expect(save.body.results.map((result: ProjectResult) => result.success)).toEqual([true, false])
    const oldOnly = (await preview([source, other], source, [oldHash])).body.projects as ProjectState[]
    expect(oldOnly.find(state => state.projectPath === source)).toMatchObject({ selected: false, conflict: true })
    expect(oldOnly.find(state => state.projectPath === other)).toMatchObject({ selected: true })
    const current = (await preview([source, other], source, [oldHash, save.body.results[0].configHash])).body.projects as ProjectState[]
    expect(current.every(state => state.selected && !state.conflict)).toBe(true)
    const retry = await request('PUT', '/api/mcp/shared/projects', { config: edited, sourceCwd: source, sourceConfig: initial.sourceConfig, targets: [target(current.find(state => state.projectPath === other)!, true)] })
    expect(retry.body.results[0].success).toBe(true)
    expect(await read(other)).toEqual({ mcpServers: { shared: edited }, futureTop: true })
  })

  it('does not promote an external replacement to membership through a new sourceCwd', async () => {
    const source = await project('source', { mcpServers: { shared: config } })
    const other = await project('other', { mcpServers: { shared: config } })
    const initial = (await preview([source, other], source)).body
    const oldHash = initial.projects[0].configHash
    expect(oldHash).toMatch(/^[0-9a-f]{64}$/)
    const replacement = { type: 'http', url: 'https://replacement.invalid/mcp' }
    await fs.writeFile(path.join(other, '.mcp.json'), JSON.stringify({ mcpServers: { shared: replacement } }))
    const save = await request('PUT', '/api/mcp/shared/projects', { config, sourceCwd: source, sourceConfig: initial.sourceConfig, targets: initial.projects.map((state: ProjectState) => target(state, false)) })
    expect(save.body.results.map((result: ProjectResult) => result.success)).toEqual([true, false])
    const refreshed = (await preview([source, other], other, [oldHash])).body.projects as ProjectState[]
    expect(refreshed.find(state => state.projectPath === other)).toMatchObject({ selected: false, conflict: true })
    expect((await read(other)).mcpServers.shared).toEqual(replacement)
  })

  it('rejects invalid ephemeral source snapshots without exposing their contents or writing targets', async () => {
    const destination = await project('destination')
    for (const sourceConfig of [null, [], 42, { type: 'http', url: 42, futureSecret: 'fixture-secret' }]) {
      const save = await request('PUT', '/api/mcp/shared/projects', { config, sourceConfig, targets: [{ projectPath: destination, selected: true, expectedRevision: null }] })
      expect(save.status).toBe(400)
      expect(JSON.stringify(save.body)).not.toContain('fixture-secret')
      await expect(fs.stat(path.join(destination, '.mcp.json'))).rejects.toThrow()
    }
  })

  it('reuses a physical registry alias and exposes one project identity through API list contexts', async () => {
    const destination = await project('physical', { mcpServers: { shared: config } })
    const alias = path.join(fixture, 'alias')
    await fs.symlink(destination, alias, 'dir')
    await fs.writeFile(getGlobalClaudeFile(), JSON.stringify({ futureGlobal: true, projects: { [alias]: { futureProject: true } } }))
    const initial = (await preview([destination], destination)).body
    const save = await request('PUT', '/api/mcp/shared/projects', { config, sourceCwd: destination, sourceConfig: initial.sourceConfig, targets: [target(initial.projects[0], true)] })
    expect(save.body.results[0].success).toBe(true)
    const global = JSON.parse(await fs.readFile(getGlobalClaudeFile(), 'utf8'))
    expect(global).toEqual({ futureGlobal: true, projects: { [alias]: { futureProject: true } } })
    const registry = await request('GET', '/api/mcp/project-paths')
    expect(registry.body.projectPaths).toEqual([alias])
    const aliasList = await request('GET', `/api/mcp?cwd=${encodeURIComponent(alias)}`)
    const physicalList = await request('GET', `/api/mcp?cwd=${encodeURIComponent(destination)}`)
    const records = [...aliasList.body.servers, ...physicalList.body.servers].filter(server => server.name === 'shared')
    expect(records).toHaveLength(2)
    expect(records.every(server => server.projectPath === destination)).toBe(true)
    expect(new Set(records.map(server => JSON.stringify([server.name, server.scope, server.projectPath]))).size).toBe(1)
    expect(JSON.parse(await fs.readFile(getGlobalClaudeFile(), 'utf8'))).toEqual({ futureGlobal: true, projects: { [alias]: { futureProject: true } } })
  })
})
