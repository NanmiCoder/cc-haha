import '../../../preload.ts'
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import * as fs from 'fs/promises'
import { tmpdir } from 'os'
import { join, dirname } from 'path'
import { _setGlobalConfigCacheForTesting, getProjectPathForConfig } from '../../utils/config.js'
import { getGlobalClaudeFile } from '../../utils/env.js'
import { handleMcpApi } from '../api/mcp.js'
import * as hostPreflight from '../services/mcpHostPreflight.js'

type ProjectState = { projectPath: string; revision: string | null }
let fixture: string
let previousConfigDir: string | undefined
let previousNodeEnv: string | undefined
let inspect: ReturnType<typeof spyOn> | undefined

function resetCaches() {
  getGlobalClaudeFile.cache.clear?.()
  getProjectPathForConfig.cache.clear?.()
  _setGlobalConfigCacheForTesting(null)
}

async function request(method: string, urlPath: string, body?: unknown) {
  const url = new URL(urlPath, 'http://localhost:3456')
  const req = new Request(url, { method, ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) })
  const response = await handleMcpApi(req, url, url.pathname.split('/').filter(Boolean))
  return { status: response.status, body: await response.json() }
}

async function project(name: string, config?: unknown) {
  const directory = join(fixture, name)
  await fs.mkdir(directory, { recursive: true })
  if (config) await fs.writeFile(join(directory, '.mcp.json'), JSON.stringify({ futureTop: true, mcpServers: { shared: config } }))
  return directory
}

async function executable(directory: string, name = 'mcp-executable') {
  const file = join(directory, name)
  await fs.mkdir(dirname(file), { recursive: true })
  // Deliberately not a runnable script: preflight may only inspect access bits.
  await fs.writeFile(file, 'MCP preflight fixture; never execute\n', { mode: 0o755 })
  return file
}

async function preview(paths: string[], sourceCwd: string) {
  const query = new URLSearchParams({ sourceCwd })
  for (const projectPath of paths) query.append('projectPath', projectPath)
  const response = await request('GET', `/api/mcp/shared/projects?${query}`)
  expect(response.status).toBe(200)
  return response.body
}

function target(state: ProjectState, selected = true) {
  return { projectPath: state.projectPath, selected, expectedRevision: state.revision }
}

async function read(directory: string) {
  return JSON.parse(await fs.readFile(join(directory, '.mcp.json'), 'utf8'))
}

async function withEnvironment(values: Record<string, string>, run: () => Promise<void>) {
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]))
  try {
    Object.assign(process.env, values)
    await run()
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

describe('project-sharing STDIO preflight', () => {
  beforeEach(async () => {
    fixture = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'mcp-project-preflight-')))
    previousConfigDir = process.env.CLAUDE_CONFIG_DIR
    previousNodeEnv = process.env.NODE_ENV
    process.env.CLAUDE_CONFIG_DIR = join(fixture, 'config')
    process.env.NODE_ENV = 'development'
    await fs.mkdir(process.env.CLAUDE_CONFIG_DIR, { recursive: true })
    resetCaches()
  })

  afterEach(async () => {
    inspect?.mockRestore()
    inspect = undefined
    if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = previousConfigDir
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = previousNodeEnv
    resetCaches()
    await fs.rm(fixture, { recursive: true, force: true })
  })

  it('checks relative commands in each target cwd without requiring a bulk request cwd', async () => {
    const raw = { type: 'stdio', command: './mcp-executable', args: [], futureField: true }
    const source = await project('source', raw)
    const other = await project('other')
    await executable(source)
    await executable(other)
    const initial = await preview([source, other], source)
    const saved = await request('PUT', '/api/mcp/shared/projects', {
      config: initial.config, sourceCwd: source, sourceConfig: initial.sourceConfig,
      targets: initial.projects.map((state: ProjectState) => target(state)),
    })

    expect(saved.status).toBe(200)
    expect(saved.body.results.map(result => result.success)).toEqual([true, true])
    for (const directory of [source, other]) expect((await read(directory)).mcpServers.shared).toMatchObject(raw)
    const legacy = await request('POST', '/api/mcp', { name: 'legacy-relative', scope: 'project', cwd: other, config: initial.config })
    expect(legacy.status).toBe(201)
  })

  it('expands command, arguments and env only in memory and writes their original variable expressions', async () => {
    const raw = { type: 'stdio', command: '${ISSUE1765_STDIO_EXECUTABLE}', args: ['${ISSUE1765_STDIO_ARGUMENT}'], env: { PATH: '${ISSUE1765_STDIO_PATH}', TOKEN: '${ISSUE1765_STDIO_TOKEN}' }, futureField: true }
    const source = await project('source', raw)
    const other = await project('other')
    const command = await executable(fixture)
    const actualInspect = hostPreflight.inspectMcpHostCommand
    inspect = spyOn(hostPreflight, 'inspectMcpHostCommand').mockImplementation(actualInspect)
    await withEnvironment({ ISSUE1765_STDIO_EXECUTABLE: command, ISSUE1765_STDIO_ARGUMENT: 'fake-expanded-argument', ISSUE1765_STDIO_PATH: join(fixture, 'bin'), ISSUE1765_STDIO_TOKEN: 'fake-expanded-token' }, async () => {
      const initial = await preview([source, other], source)
      const saved = await request('PUT', '/api/mcp/shared/projects', { config: initial.config, sourceCwd: source, sourceConfig: initial.sourceConfig, targets: initial.projects.map((state: ProjectState) => target(state)) })
      expect(saved.status).toBe(200)
      expect(saved.body.results.map(result => result.success)).toEqual([true, true])
      expect(inspect).toHaveBeenCalledWith(command, source, { PATH: join(fixture, 'bin'), TOKEN: 'fake-expanded-token' })
      expect(inspect).toHaveBeenCalledWith(command, other, { PATH: join(fixture, 'bin'), TOKEN: 'fake-expanded-token' })
      for (const directory of [source, other]) {
        expect((await read(directory)).mcpServers.shared).toEqual(raw)
        expect(await fs.readFile(join(directory, '.mcp.json'), 'utf8')).not.toContain('fake-expanded-token')
      }
    })
  })

  it('resolves variable-based relative PATH entries against each target', async () => {
    const raw = { type: 'stdio', command: 'project-mcp-tool', args: [], env: { PATH: '${ISSUE1765_STDIO_RELATIVE_PATH}' } }
    const source = await project('source', raw)
    const other = await project('other')
    await executable(source, 'bin/project-mcp-tool')
    await executable(other, 'bin/project-mcp-tool')
    await withEnvironment({ ISSUE1765_STDIO_RELATIVE_PATH: 'bin' }, async () => {
      const initial = await preview([source, other], source)
      const saved = await request('PUT', '/api/mcp/shared/projects', { config: initial.config, sourceCwd: source, sourceConfig: initial.sourceConfig, targets: initial.projects.map((state: ProjectState) => target(state)) })
      expect(saved.status).toBe(200)
      expect(saved.body.results.map(result => result.success)).toEqual([true, true])
      expect((await read(other)).mcpServers.shared.env.PATH).toBe('${ISSUE1765_STDIO_RELATIVE_PATH}')
    })
  })

  it('saves valid targets and permits retry after another target gains its executable', async () => {
    const raw = { type: 'stdio', command: './mcp-executable', args: [], futureField: true }
    const source = await project('source', raw)
    const other = await project('other')
    await executable(source)
    const initial = await preview([source, other], source)
    const saved = await request('PUT', '/api/mcp/shared/projects', { config: initial.config, sourceCwd: source, sourceConfig: initial.sourceConfig, targets: initial.projects.map((state: ProjectState) => target(state)) })
    expect(saved.status).toBe(200)
    expect(saved.body.results.map(result => result.success)).toEqual([true, false])
    expect(saved.body.results[1].error).toContain('executable')
    await expect(fs.stat(join(other, '.mcp.json'))).rejects.toThrow()
    await executable(other)
    const retry = await request('PUT', '/api/mcp/shared/projects', { config: initial.config, sourceCwd: source, sourceConfig: initial.sourceConfig, targets: [target(initial.projects.find((state: ProjectState) => state.projectPath === other))] })
    expect(retry.body.results[0].success).toBe(true)
    expect((await read(other)).mcpServers.shared).toMatchObject(raw)
  })

  it('rejects stale revisions before preflight and removes entries without checking an old command', async () => {
    const raw = { type: 'stdio', command: './missing-mcp-executable', args: [] }
    const source = await project('source', raw)
    const initial = await preview([source], source)
    inspect = spyOn(hostPreflight, 'inspectMcpHostCommand').mockResolvedValue({ ok: false, message: 'must-not-check-this-command' })
    await fs.writeFile(join(source, '.mcp.json'), JSON.stringify({ externallyAdded: true, mcpServers: { shared: raw } }))
    const stale = await request('PUT', '/api/mcp/shared/projects', { config: initial.config, sourceCwd: source, sourceConfig: initial.sourceConfig, targets: initial.projects.map((state: ProjectState) => target(state)) })
    expect(stale.status).toBe(200)
    expect(stale.body.results[0]).toMatchObject({ success: false, error: 'Project .mcp.json changed; reload the project list and retry' })
    expect(inspect).not.toHaveBeenCalled()
    const refreshed = await preview([source], source)
    const removed = await request('PUT', '/api/mcp/shared/projects', { config: initial.config, sourceCwd: source, sourceConfig: initial.sourceConfig, targets: refreshed.projects.map((state: ProjectState) => target(state, false)) })
    expect(removed.body.results[0]).toMatchObject({ success: true, configHash: null })
    expect(inspect).not.toHaveBeenCalled()
    expect(await read(source)).toEqual({ externallyAdded: true, mcpServers: {} })
  })

  it('does not disclose expanded command or environment values in target preflight errors', async () => {
    const raw = { type: 'stdio', command: '${ISSUE1765_STDIO_EXECUTABLE}', args: [], env: { TOKEN: '${ISSUE1765_STDIO_TOKEN}' } }
    const source = await project('source', raw)
    await withEnvironment({ ISSUE1765_STDIO_EXECUTABLE: join(fixture, 'fake-expanded-secret', 'missing-command'), ISSUE1765_STDIO_TOKEN: 'fake-expanded-private-token' }, async () => {
      const initial = await preview([source], source)
      const saved = await request('PUT', '/api/mcp/shared/projects', { config: initial.config, sourceCwd: source, sourceConfig: initial.sourceConfig, targets: initial.projects.map((state: ProjectState) => target(state)) })
      expect(saved.status).toBe(200)
      expect(saved.body.results[0].success).toBe(false)
      expect(saved.body.results[0].error).toContain('executable')
      expect(JSON.stringify(saved.body)).not.toContain('fake-expanded-secret')
      expect(JSON.stringify(saved.body)).not.toContain('fake-expanded-private-token')
      expect((await read(source)).mcpServers.shared).toEqual(raw)
    })
  })
})
