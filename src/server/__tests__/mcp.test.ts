import '../../../preload.ts'
import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import { getOriginalCwd, setCwdState, setOriginalCwd } from '../../bootstrap/state.js'
import * as mcpClient from '../../services/mcp/client.js'
import * as mcpConfig from '../../services/mcp/config.js'
import { _setGlobalConfigCacheForTesting, getProjectPathForConfig } from '../../utils/config.js'
import { getGlobalClaudeFile } from '../../utils/env.js'
import { runWithCwdOverride } from '../../utils/cwd.js'
import { normalizePathForConfigKey } from '../../utils/path.js'
import * as mcpHostPreflight from '../services/mcpHostPreflight.js'
import { handleMcpApi } from '../api/mcp.js'
import { conversationService } from '../services/conversationService.js'

let tmpDir: string
let projectRoot: string
let originalConfigDir: string | undefined
let connectSpy: ReturnType<typeof spyOn> | undefined
let getClaudeCodeMcpConfigsSpy: ReturnType<typeof spyOn> | undefined
let getAllMcpConfigsSpy: ReturnType<typeof spyOn> | undefined
let getMcpConfigByNameSpy: ReturnType<typeof spyOn> | undefined
let reconnectSpy: ReturnType<typeof spyOn> | undefined
let hostPreflightSpy: ReturnType<typeof spyOn> | undefined
let originalRequestControl: typeof conversationService.requestControl
let originalHasSession: typeof conversationService.hasSession
let originalGetActiveSessions: typeof conversationService.getActiveSessions
let originalGetSessionWorkDir: typeof conversationService.getSessionWorkDir

function clearConfigPathCaches() {
  getGlobalClaudeFile.cache.clear?.()
  getProjectPathForConfig.cache.clear?.()
  _setGlobalConfigCacheForTesting(null)
}

async function setup() {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-mcp-test-'))
  projectRoot = path.join(tmpDir, 'project')
  await fs.mkdir(path.join(projectRoot, '.claude'), { recursive: true })

  originalConfigDir = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = tmpDir
  clearConfigPathCaches()
}

async function teardown() {
  if (originalConfigDir !== undefined) {
    process.env.CLAUDE_CONFIG_DIR = originalConfigDir
  } else {
    delete process.env.CLAUDE_CONFIG_DIR
  }

  clearConfigPathCaches()
  await fs.rm(tmpDir, { recursive: true, force: true })
}

function makeRequest(
  method: string,
  urlStr: string,
  body?: Record<string, unknown>,
): { req: Request; url: URL; segments: string[] } {
  const url = new URL(urlStr, 'http://localhost:3456')
  const init: RequestInit = { method }
  if (body) {
    init.headers = { 'Content-Type': 'application/json' }
    init.body = JSON.stringify(body)
  }
  const req = new Request(url.toString(), init)
  return {
    req,
    url,
    segments: url.pathname.split('/').filter(Boolean),
  }
}

describe('MCP API', () => {
  beforeEach(async () => {
    await setup()

    hostPreflightSpy = spyOn(mcpHostPreflight, 'inspectMcpHostCommand').mockResolvedValue({
      ok: true,
      resolvedCommand: '/usr/bin/mock-command',
    })
    originalRequestControl = conversationService.requestControl.bind(conversationService)
    originalHasSession = conversationService.hasSession.bind(conversationService)
    originalGetSessionWorkDir = conversationService.getSessionWorkDir.bind(conversationService)
    originalGetActiveSessions = conversationService.getActiveSessions.bind(conversationService)

    connectSpy = spyOn(mcpClient, 'connectToServer').mockImplementation(async (name, config) => ({
      name,
      type: 'connected',
      client: {} as never,
      capabilities: {},
      config,
      cleanup: mock(async () => {}),
    }))
  })

  afterEach(async () => {
    connectSpy?.mockRestore()
    connectSpy = undefined
    getClaudeCodeMcpConfigsSpy?.mockRestore()
    getClaudeCodeMcpConfigsSpy = undefined
    getAllMcpConfigsSpy?.mockRestore()
    getAllMcpConfigsSpy = undefined
    getMcpConfigByNameSpy?.mockRestore()
    getMcpConfigByNameSpy = undefined
    reconnectSpy?.mockRestore()
    reconnectSpy = undefined
    hostPreflightSpy?.mockRestore()
    hostPreflightSpy = undefined
    conversationService.requestControl = originalRequestControl
    conversationService.hasSession = originalHasSession
    conversationService.getSessionWorkDir = originalGetSessionWorkDir
    conversationService.getActiveSessions = originalGetActiveSessions
    await teardown()
  })

  it('writes local MCP config and disabled state to the requested cwd project', async () => {
    const previousNodeEnv = process.env.NODE_ENV
    const previousOriginalCwd = getOriginalCwd()
    const projectA = path.join(tmpDir, 'project-a')
    const projectB = path.join(tmpDir, 'project-b')
    const projectAKey = normalizePathForConfigKey(projectA)
    const projectBKey = normalizePathForConfigKey(projectB)
    await fs.mkdir(projectA, { recursive: true })
    await fs.mkdir(projectB, { recursive: true })

    process.env.NODE_ENV = 'development'
    clearConfigPathCaches()
    setOriginalCwd(projectA)
    setCwdState(projectA)

    try {
      const create = makeRequest('POST', '/api/mcp', {
        cwd: projectB,
        name: 'scoped-server',
        scope: 'local',
        config: {
          type: 'stdio',
          command: 'node',
          args: ['server.js'],
          env: {},
        },
      })

      const createRes = await handleMcpApi(create.req, create.url, create.segments)
      expect(createRes.status).toBe(201)

      const disable = makeRequest('POST', '/api/mcp/scoped-server/toggle', {
        cwd: projectB,
      })
      const disableRes = await handleMcpApi(disable.req, disable.url, disable.segments)
      expect(disableRes.status).toBe(200)

      const rawConfig = JSON.parse(
        await fs.readFile(path.join(tmpDir, '.claude.json'), 'utf8'),
      )

      expect(rawConfig.projects?.[projectAKey]?.mcpServers?.['scoped-server']).toBeUndefined()
      expect(rawConfig.projects?.[projectAKey]?.disabledMcpServers ?? []).not.toContain('scoped-server')
      expect(rawConfig.projects?.[projectBKey]?.mcpServers?.['scoped-server']).toMatchObject({
        type: 'stdio',
        command: 'node',
      })
      expect(rawConfig.projects?.[projectBKey]?.disabledMcpServers).toContain('scoped-server')
    } finally {
      if (previousNodeEnv === undefined) {
        delete process.env.NODE_ENV
      } else {
        process.env.NODE_ENV = previousNodeEnv
      }
      setOriginalCwd(previousOriginalCwd)
      setCwdState(previousOriginalCwd)
      clearConfigPathCaches()
    }
  })

  it('creates and lists local MCP servers for the requested cwd', async () => {
    const create = makeRequest('POST', '/api/mcp', {
      cwd: projectRoot,
      name: 'chrome-devtools',
      scope: 'local',
      config: {
        type: 'stdio',
        command: 'npx',
        args: ['chrome-devtools-mcp@latest'],
        env: {
          DEBUG: '1',
        },
      },
    })

    const createRes = await handleMcpApi(create.req, create.url, create.segments)
    expect(createRes.status).toBe(201)
    const createdBody = await createRes.json()
    expect(createdBody.server.name).toBe('chrome-devtools')
    expect(createdBody.server.transport).toBe('stdio')
    expect(createdBody.server.status).toBe('checking')
    expect(createdBody.server.projectPath).toBe(normalizePathForConfigKey(projectRoot))

    const list = makeRequest('GET', `/api/mcp?cwd=${encodeURIComponent(projectRoot)}`)
    const listRes = await handleMcpApi(list.req, list.url, list.segments)
    expect(listRes.status).toBe(200)
    const listBody = await listRes.json()

    expect(listBody.servers).toHaveLength(1)
    expect(listBody.servers[0].name).toBe('chrome-devtools')
    expect(listBody.servers[0].status).toBe('checking')
    expect(listBody.servers[0].config.command).toBe('npx')
    expect(listBody.servers[0].projectPath).toBe(normalizePathForConfigKey(projectRoot))
    expect(connectSpy).not.toHaveBeenCalled()
  })

  it('allows unicode letters and numbers in MCP server names while rejecting separators', async () => {
    for (const name of ['某某服务器', 'context七', 'テストサーバー', '서버1', 'café-tools']) {
      const create = makeRequest('POST', '/api/mcp', {
        cwd: projectRoot,
        name,
        scope: 'local',
        config: {
          type: 'stdio',
          command: 'npx',
          args: [`${name}-mcp`],
          env: {},
        },
      })

      const createRes = await handleMcpApi(create.req, create.url, create.segments)
      expect(createRes.status).toBe(201)
      const body = await createRes.json()
      expect(body.server.name).toBe(name)
    }

    for (const name of ['bad name', 'bad/name', 'bad.name']) {
      const create = makeRequest('POST', '/api/mcp', {
        cwd: projectRoot,
        name,
        scope: 'local',
        config: {
          type: 'stdio',
          command: 'npx',
          args: ['bad-mcp'],
          env: {},
        },
      })

      const createRes = await handleMcpApi(create.req, create.url, create.segments)
      expect(createRes.status).toBe(400)
      await expect(createRes.json()).resolves.toMatchObject({
        message: expect.stringContaining(`Invalid name ${name}`),
      })
    }
  })

  it('lists project paths that contain user-private MCP servers', async () => {
    const previousNodeEnv = process.env.NODE_ENV
    const projectB = path.join(tmpDir, 'project-b')
    await fs.mkdir(projectB, { recursive: true })
    process.env.NODE_ENV = 'development'
    clearConfigPathCaches()

    try {
      const create = makeRequest('POST', '/api/mcp', {
        cwd: projectB,
        name: 'private-context7',
        scope: 'local',
        config: {
          type: 'stdio',
          command: 'npx',
          args: ['@upstash/context7-mcp'],
          env: {},
        },
      })
      const createRes = await handleMcpApi(create.req, create.url, create.segments)
      expect(createRes.status).toBe(201)

      const projectPaths = makeRequest('GET', '/api/mcp/project-paths')
      const projectPathsRes = await handleMcpApi(projectPaths.req, projectPaths.url, projectPaths.segments)
      expect(projectPathsRes.status).toBe(200)
      const body = await projectPathsRes.json()

      expect(body.projectPaths).toEqual([normalizePathForConfigKey(projectB)])
    } finally {
      if (previousNodeEnv === undefined) {
        delete process.env.NODE_ENV
      } else {
        process.env.NODE_ENV = previousNodeEnv
      }
      clearConfigPathCaches()
    }
  })

  it('lists project paths whose .mcp.json declares project-scoped MCP servers (GH #1126)', async () => {
    const previousNodeEnv = process.env.NODE_ENV
    // A directory that never hosted a session — the shape of the bug report.
    const freshProject = path.join(tmpDir, 'fresh-project')
    await fs.mkdir(freshProject, { recursive: true })
    process.env.NODE_ENV = 'development'
    clearConfigPathCaches()

    try {
      const create = makeRequest('POST', '/api/mcp', {
        cwd: freshProject,
        name: 'shared-tools',
        scope: 'project',
        config: {
          type: 'stdio',
          command: 'npx',
          args: ['shared-mcp'],
          env: {},
        },
      })
      const createRes = await handleMcpApi(create.req, create.url, create.segments)
      expect(createRes.status).toBe(201)

      // The request the settings page replays after an app restart to decide
      // which project paths to query. The target directory must show up here,
      // or the saved server silently disappears from the UI.
      const projectPaths = makeRequest('GET', '/api/mcp/project-paths')
      const projectPathsRes = await handleMcpApi(projectPaths.req, projectPaths.url, projectPaths.segments)
      expect(projectPathsRes.status).toBe(200)
      const body = await projectPathsRes.json()

      expect(body.projectPaths).toEqual([normalizePathForConfigKey(freshProject)])
    } finally {
      if (previousNodeEnv === undefined) {
        delete process.env.NODE_ENV
      } else {
        process.env.NODE_ENV = previousNodeEnv
      }
      clearConfigPathCaches()
    }
  })

  it('self-heals the registry for pre-existing .mcp.json files on first browse (GH #1126)', async () => {
    const previousNodeEnv = process.env.NODE_ENV
    // Simulates a target project configured by a build without target
    // registration (or a hand-written .mcp.json): file exists, no registry entry.
    const legacyProject = path.join(tmpDir, 'legacy-project')
    await fs.mkdir(legacyProject, { recursive: true })
    await fs.writeFile(
      path.join(legacyProject, '.mcp.json'),
      JSON.stringify({ mcpServers: { 'legacy-tools': { type: 'stdio', command: 'npx', args: ['x'] } } }),
    )
    process.env.NODE_ENV = 'development'
    clearConfigPathCaches()

    try {
      const before = makeRequest('GET', '/api/mcp/project-paths')
      const beforeRes = await handleMcpApi(before.req, before.url, before.segments)
      expect((await beforeRes.json()).projectPaths).toEqual([])

      // Browsing the project (the settings page's per-path list request)
      // registers it, and it stays discoverable from then on.
      const list = makeRequest('GET', `/api/mcp?cwd=${encodeURIComponent(legacyProject)}`)
      const listRes = await handleMcpApi(list.req, list.url, list.segments)
      expect(listRes.status).toBe(200)

      const after = makeRequest('GET', '/api/mcp/project-paths')
      const afterRes = await handleMcpApi(after.req, after.url, after.segments)
      expect((await afterRes.json()).projectPaths).toEqual([
        normalizePathForConfigKey(legacyProject),
      ])
    } finally {
      if (previousNodeEnv === undefined) {
        delete process.env.NODE_ENV
      } else {
        process.env.NODE_ENV = previousNodeEnv
      }
      clearConfigPathCaches()
    }
  })

  it('keeps a project server discoverable after moving it to another target project (GH #1126)', async () => {
    const previousNodeEnv = process.env.NODE_ENV
    const projectA = path.join(tmpDir, 'move-src')
    const projectB = path.join(tmpDir, 'move-dst')
    await fs.mkdir(projectA, { recursive: true })
    await fs.mkdir(projectB, { recursive: true })
    process.env.NODE_ENV = 'development'
    clearConfigPathCaches()

    try {
      const create = makeRequest('POST', '/api/mcp', {
        cwd: projectA,
        name: 'shared-tools',
        scope: 'project',
        config: {
          type: 'stdio',
          command: 'npx',
          args: ['shared-mcp'],
          env: {},
        },
      })
      const createRes = await handleMcpApi(create.req, create.url, create.segments)
      expect(createRes.status).toBe(201)

      const update = makeRequest('PUT', '/api/mcp/shared-tools', {
        cwd: projectB,
        previousCwd: projectA,
        scope: 'project',
        config: {
          type: 'stdio',
          command: 'npx',
          args: ['shared-mcp'],
          env: {},
        },
      })
      const updateRes = await handleMcpApi(update.req, update.url, update.segments)
      expect(updateRes.status).toBe(200)

      // The new target must be discoverable; the drained source (its
      // .mcp.json is now empty) must not linger in the list.
      const projectPaths = makeRequest('GET', '/api/mcp/project-paths')
      const projectPathsRes = await handleMcpApi(projectPaths.req, projectPaths.url, projectPaths.segments)
      const body = await projectPathsRes.json()

      expect(body.projectPaths).toEqual([normalizePathForConfigKey(projectB)])
    } finally {
      if (previousNodeEnv === undefined) {
        delete process.env.NODE_ENV
      } else {
        process.env.NODE_ENV = previousNodeEnv
      }
      clearConfigPathCaches()
    }
  })

  it('updates project MCP servers from their previous cwd into the selected target cwd', async () => {
    const projectA = path.join(tmpDir, 'project-a')
    const projectB = path.join(tmpDir, 'project-b')
    await fs.mkdir(projectA, { recursive: true })
    await fs.mkdir(projectB, { recursive: true })

    const create = makeRequest('POST', '/api/mcp', {
      cwd: projectA,
      name: 'shared-tools',
      scope: 'project',
      config: {
        type: 'stdio',
        command: 'npx',
        args: ['old-tools'],
        env: {},
      },
    })
    const createRes = await handleMcpApi(create.req, create.url, create.segments)
    expect(createRes.status).toBe(201)

    const update = makeRequest('PUT', '/api/mcp/shared-tools', {
      cwd: projectB,
      previousCwd: projectA,
      scope: 'project',
      config: {
        type: 'stdio',
        command: 'npx',
        args: ['new-tools'],
        env: {},
      },
    })
    const updateRes = await handleMcpApi(update.req, update.url, update.segments)
    expect(updateRes.status).toBe(200)

    const projectAConfig = JSON.parse(await fs.readFile(path.join(projectA, '.mcp.json'), 'utf8'))
    const projectBConfig = JSON.parse(await fs.readFile(path.join(projectB, '.mcp.json'), 'utf8'))

    expect(projectAConfig.mcpServers?.['shared-tools']).toBeUndefined()
    expect(projectBConfig.mcpServers?.['shared-tools']).toMatchObject({
      type: 'stdio',
      command: 'npx',
      args: ['new-tools'],
    })
  })

  it('retries status after a failed connection instead of reusing its cached failure', async () => {
    connectSpy?.mockRestore()
    connectSpy = undefined
    const connect = spyOn(Client.prototype, 'connect')
      .mockRejectedValueOnce(new Error('fixture temporarily unavailable'))
      .mockResolvedValue(undefined)
    try {
      const create = makeRequest('POST', '/api/mcp', {
        cwd: projectRoot, name: 'retry-probe', scope: 'local',
        config: { type: 'sse', url: 'http://127.0.0.1:1/mcp' },
      })
      await handleMcpApi(create.req, create.url, create.segments)
      const status = makeRequest('GET', `/api/mcp/retry-probe/status?cwd=${encodeURIComponent(projectRoot)}`)
      expect((await (await handleMcpApi(status.req, status.url, status.segments)).json()).server.status).toBe('failed')
      expect((await (await handleMcpApi(status.req, status.url, status.segments)).json()).server.status).toBe('connected')
      expect(connect).toHaveBeenCalledTimes(2)
    } finally {
      await runWithCwdOverride(projectRoot, () => mcpClient.clearServerCache('retry-probe', mcpConfig.getMcpConfigByName('retry-probe')!))
      connect.mockRestore()
    }
  })

  it('does not discard a replacement connection when an older status probe fails', async () => {
    connectSpy?.mockRestore()
    connectSpy = undefined
    let failOld!: (error: Error) => void
    let markStarted!: () => void
    const started = new Promise<void>(resolve => { markStarted = resolve })
    const connect = spyOn(Client.prototype, 'connect')
      .mockImplementationOnce(() => {
        markStarted()
        return new Promise<void>((_resolve, reject) => { failOld = reject })
      })
      .mockResolvedValue(undefined)
    let config: NonNullable<ReturnType<typeof mcpConfig.getMcpConfigByName>>
    try {
      const create = makeRequest('POST', '/api/mcp', {
        cwd: projectRoot, name: 'replaced-probe', scope: 'local',
        config: { type: 'sse', url: 'http://127.0.0.1:1/mcp' },
      })
      await handleMcpApi(create.req, create.url, create.segments)
      config = runWithCwdOverride(projectRoot, () => mcpConfig.getMcpConfigByName('replaced-probe')!)
      const status = makeRequest('GET', `/api/mcp/replaced-probe/status?cwd=${encodeURIComponent(projectRoot)}`)
      const probing = handleMcpApi(status.req, status.url, status.segments)
      await started
      await runWithCwdOverride(projectRoot, () => mcpClient.clearServerCache('replaced-probe', config))
      const replacement = await runWithCwdOverride(projectRoot, () => mcpClient.connectToServer('replaced-probe', config))
      expect(replacement.type).toBe('connected')
      failOld(new Error('old probe failed'))
      expect((await (await probing).json()).server.status).toBe('failed')
      const retained = await runWithCwdOverride(projectRoot, () => mcpClient.connectToServer('replaced-probe', config))
      expect(retained).toBe(replacement)
      expect(connect).toHaveBeenCalledTimes(2)
    } finally {
      failOld?.(new Error('fixture cleanup'))
      await runWithCwdOverride(projectRoot, () => mcpClient.clearServerCache('replaced-probe', mcpConfig.getMcpConfigByName('replaced-probe')!))
      connect.mockRestore()
    }
  })

  it('checks a single server status on demand', async () => {
    const create = makeRequest('POST', '/api/mcp', {
      cwd: projectRoot,
      name: 'deepwiki',
      scope: 'user',
      config: {
        type: 'http',
        url: 'https://mcp.example.com/mcp',
        headers: {},
      },
    })
    await handleMcpApi(create.req, create.url, create.segments)

    const status = makeRequest('GET', `/api/mcp/deepwiki/status?cwd=${encodeURIComponent(projectRoot)}`)
    const statusRes = await handleMcpApi(status.req, status.url, status.segments)

    expect(statusRes.status).toBe(200)
    const body = await statusRes.json()
    expect(body.server.name).toBe('deepwiki')
    expect(body.server.status).toBe('connected')
    expect(connectSpy).toHaveBeenCalled()
  })

  it('lists runtime-visible claude.ai MCP connectors as read-only settings entries', async () => {
    getAllMcpConfigsSpy = spyOn(mcpConfig, 'getAllMcpConfigs').mockResolvedValue({
      servers: {
        'claude.ai Docs': {
          type: 'claudeai-proxy',
          url: 'https://mcp.example.com/docs',
          id: 'srv_docs',
          scope: 'claudeai',
        },
      },
      errors: [],
    })

    const list = makeRequest('GET', `/api/mcp?cwd=${encodeURIComponent(projectRoot)}`)
    const listRes = await handleMcpApi(list.req, list.url, list.segments)

    expect(listRes.status).toBe(200)
    const listBody = await listRes.json()

    expect(listBody.servers).toContainEqual(
      expect.objectContaining({
        name: 'claude.ai Docs',
        scope: 'claudeai',
        transport: 'claudeai-proxy',
        canEdit: false,
        canRemove: false,
      }),
    )
    expect(connectSpy).not.toHaveBeenCalled()
  })

  it('rejects stdio MCP creation when the host command is unavailable', async () => {
    hostPreflightSpy?.mockResolvedValueOnce({
      ok: false,
      message: 'Host command "npx" is not available in PATH.',
    })

    const create = makeRequest('POST', '/api/mcp', {
      cwd: projectRoot,
      name: 'chrome-devtools',
      scope: 'local',
      config: {
        type: 'stdio',
        command: 'npx',
        args: ['chrome-devtools-mcp@latest'],
        env: {},
      },
    })

    const createRes = await handleMcpApi(create.req, create.url, create.segments)

    expect(createRes.status).toBe(400)
    await expect(createRes.json()).resolves.toMatchObject({
      message: 'Host command "npx" is not available in PATH.',
    })
  })

  it('surfaces host preflight failures in live status checks without connecting', async () => {
    const create = makeRequest('POST', '/api/mcp', {
      cwd: projectRoot,
      name: 'chrome-devtools',
      scope: 'local',
      config: {
        type: 'stdio',
        command: 'npx',
        args: ['chrome-devtools-mcp@latest'],
        env: {},
      },
    })
    await handleMcpApi(create.req, create.url, create.segments)

    hostPreflightSpy?.mockResolvedValueOnce({
      ok: false,
      message: 'Host command "npx" is not available in PATH.',
    })

    const status = makeRequest('GET', `/api/mcp/chrome-devtools/status?cwd=${encodeURIComponent(projectRoot)}`)
    const statusRes = await handleMcpApi(status.req, status.url, status.segments)

    expect(statusRes.status).toBe(200)
    await expect(statusRes.json()).resolves.toMatchObject({
      server: {
        name: 'chrome-devtools',
        status: 'failed',
        statusDetail: 'Host command "npx" is not available in PATH.',
      },
    })
    expect(connectSpy).not.toHaveBeenCalled()
  })

  it('updates, toggles, and deletes MCP servers', async () => {
    const create = makeRequest('POST', '/api/mcp', {
      cwd: projectRoot,
      name: 'context7',
      scope: 'local',
      config: {
        type: 'stdio',
        command: 'npx',
        args: ['@upstash/context7-mcp'],
        env: {},
      },
    })
    await handleMcpApi(create.req, create.url, create.segments)

    const update = makeRequest('PUT', '/api/mcp/context7', {
      cwd: projectRoot,
      scope: 'user',
      config: {
        type: 'http',
        url: 'https://mcp.example.com/mcp',
        headers: {
          Authorization: 'Bearer demo',
        },
      },
    })
    const updateRes = await handleMcpApi(update.req, update.url, update.segments)
    expect(updateRes.status).toBe(200)
    const updatedBody = await updateRes.json()
    expect(updatedBody.server.transport).toBe('http')
    expect(updatedBody.server.scope).toBe('user')

    const disable = makeRequest('POST', '/api/mcp/context7/toggle', { cwd: projectRoot })
    const disableRes = await handleMcpApi(disable.req, disable.url, disable.segments)
    expect(disableRes.status).toBe(200)
    const disabledBody = await disableRes.json()
    expect(disabledBody.server.enabled).toBe(false)
    expect(disabledBody.server.status).toBe('disabled')

    const enable = makeRequest('POST', '/api/mcp/context7/toggle', { cwd: projectRoot })
    const enableRes = await handleMcpApi(enable.req, enable.url, enable.segments)
    expect(enableRes.status).toBe(200)
    const enabledBody = await enableRes.json()
    expect(enabledBody.server.enabled).toBe(true)

    const remove = makeRequest('DELETE', `/api/mcp/context7?scope=user&cwd=${encodeURIComponent(projectRoot)}`)
    const removeRes = await handleMcpApi(remove.req, remove.url, remove.segments)
    expect(removeRes.status).toBe(200)

    const list = makeRequest('GET', `/api/mcp?cwd=${encodeURIComponent(projectRoot)}`)
    const listRes = await handleMcpApi(list.req, list.url, list.segments)
    const listBody = await listRes.json()
    expect(listBody.servers.some((server: { name: string }) => server.name === 'context7')).toBe(false)
  })

  it('deletes project MCP servers inherited from a parent .mcp.json', async () => {
    const parent = path.join(tmpDir, 'workspace')
    const child = path.join(parent, 'nested-project')
    await fs.mkdir(child, { recursive: true })
    const parentMcpJson = path.join(parent, '.mcp.json')
    await fs.writeFile(
      parentMcpJson,
      JSON.stringify(
        {
          mcpServers: {
            inherited: { type: 'stdio', command: 'npx', args: ['inherited-mcp'] },
          },
        },
        null,
        2,
      ),
    )

    // The server is visible from the nested cwd and advertised as removable.
    const list = makeRequest('GET', `/api/mcp?cwd=${encodeURIComponent(child)}`)
    const listRes = await handleMcpApi(list.req, list.url, list.segments)
    const listBody = await listRes.json()
    expect(listBody.servers).toContainEqual(
      expect.objectContaining({
        name: 'inherited',
        scope: 'project',
        canRemove: true,
        configLocation: parentMcpJson,
        projectPath: normalizePathForConfigKey(parent),
      }),
    )

    const remove = makeRequest(
      'DELETE',
      `/api/mcp/inherited?scope=project&cwd=${encodeURIComponent(child)}`,
    )
    const removeRes = await handleMcpApi(remove.req, remove.url, remove.segments)
    expect(removeRes.status).toBe(200)

    // Removed from the file that declares it, without creating one in the cwd.
    const parentConfig = JSON.parse(await fs.readFile(parentMcpJson, 'utf8'))
    expect(parentConfig.mcpServers?.inherited).toBeUndefined()
    await expect(fs.stat(path.join(child, '.mcp.json'))).rejects.toThrow()

    const listAfter = makeRequest('GET', `/api/mcp?cwd=${encodeURIComponent(child)}`)
    const listAfterRes = await handleMcpApi(listAfter.req, listAfter.url, listAfter.segments)
    const listAfterBody = await listAfterRes.json()
    expect(listAfterBody.servers.some((server: { name: string }) => server.name === 'inherited')).toBe(false)
  })

  it('edits project MCP servers inherited from a parent .mcp.json', async () => {
    const parent = path.join(tmpDir, 'edit-workspace')
    const child = path.join(parent, 'nested-project')
    await fs.mkdir(child, { recursive: true })
    const parentMcpJson = path.join(parent, '.mcp.json')
    await fs.writeFile(
      parentMcpJson,
      JSON.stringify(
        { mcpServers: { inherited: { type: 'stdio', command: 'npx', args: ['old-args'] } } },
        null,
        2,
      ),
    )

    const update = makeRequest('PUT', '/api/mcp/inherited', {
      cwd: child,
      previousCwd: child,
      scope: 'project',
      config: { type: 'stdio', command: 'npx', args: ['new-args'], env: {} },
    })
    const updateRes = await handleMcpApi(update.req, update.url, update.segments)
    expect(updateRes.status).toBe(200)

    // The edit moves the entry out of the inherited file into the target cwd.
    const parentConfig = JSON.parse(await fs.readFile(parentMcpJson, 'utf8'))
    const childConfig = JSON.parse(await fs.readFile(path.join(child, '.mcp.json'), 'utf8'))
    expect(parentConfig.mcpServers?.inherited).toBeUndefined()
    expect(childConfig.mcpServers?.inherited).toMatchObject({
      type: 'stdio',
      command: 'npx',
      args: ['new-args'],
    })
  })

  it('preserves unrelated content when rewriting .mcp.json on delete', async () => {
    const proj = path.join(tmpDir, 'preserve')
    await fs.mkdir(proj, { recursive: true })
    const mcpJsonPath = path.join(proj, '.mcp.json')
    await fs.writeFile(
      mcpJsonPath,
      JSON.stringify(
        {
          $schema: 'https://example.com/mcp.schema.json',
          mcpServers: {
            doomed: { type: 'stdio', command: 'npx', args: ['doomed-mcp'] },
            kept: {
              type: 'http',
              url: 'https://mcp.example.com/mcp',
              headers: { Authorization: 'Bearer ${MY_MCP_TOKEN}' },
            },
          },
        },
        null,
        2,
      ),
    )

    const remove = makeRequest(
      'DELETE',
      `/api/mcp/doomed?scope=project&cwd=${encodeURIComponent(proj)}`,
    )
    const removeRes = await handleMcpApi(remove.req, remove.url, remove.segments)
    expect(removeRes.status).toBe(200)

    const rewritten = JSON.parse(await fs.readFile(mcpJsonPath, 'utf8'))
    expect(rewritten.mcpServers.doomed).toBeUndefined()
    // Top-level keys outside mcpServers survive, and ${VAR} placeholders are
    // written back verbatim rather than expanded into resolved values.
    expect(rewritten.$schema).toBe('https://example.com/mcp.schema.json')
    expect(rewritten.mcpServers.kept.headers.Authorization).toBe('Bearer ${MY_MCP_TOKEN}')
  })

  it('reports why a delete failed instead of a generic 500', async () => {
    const create = makeRequest('POST', '/api/mcp', {
      cwd: projectRoot,
      name: 'mismatched',
      scope: 'user',
      config: { type: 'stdio', command: 'npx', args: ['mismatched-mcp'] },
    })
    await handleMcpApi(create.req, create.url, create.segments)

    // Asking to remove a user-scoped server from local scope cannot succeed; the
    // caller needs the reason, not an opaque "unexpected error occurred".
    const remove = makeRequest(
      'DELETE',
      `/api/mcp/mismatched?scope=local&cwd=${encodeURIComponent(projectRoot)}`,
    )
    const removeRes = await handleMcpApi(remove.req, remove.url, remove.segments)

    expect(removeRes.status).toBe(400)
    await expect(removeRes.json()).resolves.toMatchObject({
      error: 'BAD_REQUEST',
      message: 'No project-local MCP server found with name: mismatched',
    })
  })

  it('rejects delete requests for scopes that cannot be edited', async () => {
    getMcpConfigByNameSpy = spyOn(mcpConfig, 'getMcpConfigByName').mockReturnValue({
      type: 'stdio',
      command: 'npx',
      args: ['managed-mcp'],
      scope: 'enterprise',
    })

    const remove = makeRequest(
      'DELETE',
      `/api/mcp/managed-server?scope=enterprise&cwd=${encodeURIComponent(projectRoot)}`,
    )
    const removeRes = await handleMcpApi(remove.req, remove.url, remove.segments)

    expect(removeRes.status).toBe(400)
    await expect(removeRes.json()).resolves.toMatchObject({
      message: 'MCP server "managed-server" cannot be removed from scope "enterprise"',
    })
  })

  it('rejects delete requests carrying an unknown scope', async () => {
    const remove = makeRequest(
      'DELETE',
      `/api/mcp/whatever?scope=bogus&cwd=${encodeURIComponent(projectRoot)}`,
    )
    const removeRes = await handleMcpApi(remove.req, remove.url, remove.segments)

    expect(removeRes.status).toBe(400)
    await expect(removeRes.json()).resolves.toMatchObject({
      error: 'BAD_REQUEST',
      message: expect.stringContaining('Invalid scope: bogus'),
    })
  })

  it('syncs MCP toggles into the active CLI session control channel', async () => {
    const create = makeRequest('POST', '/api/mcp', {
      cwd: projectRoot,
      name: 'session-sync',
      scope: 'local',
      config: {
        type: 'stdio',
        command: 'npx',
        args: ['session-sync-mcp'],
        env: {},
      },
    })
    await handleMcpApi(create.req, create.url, create.segments)

    const requestControl = mock(async () => ({}))
    conversationService.hasSession = ((sessionId: string) => sessionId === 'session-1') as typeof conversationService.hasSession
    conversationService.getSessionWorkDir = ((sessionId: string) => (
      sessionId === 'session-1' ? projectRoot : ''
    )) as typeof conversationService.getSessionWorkDir
    conversationService.requestControl = requestControl as typeof conversationService.requestControl

    const disable = makeRequest('POST', '/api/mcp/session-sync/toggle', {
      cwd: projectRoot,
      sessionId: 'session-1',
    })
    const disableRes = await handleMcpApi(disable.req, disable.url, disable.segments)

    expect(disableRes.status).toBe(200)
    expect(requestControl).toHaveBeenCalledWith(
      'session-1',
      { subtype: 'mcp_toggle', serverName: 'session-sync', enabled: false, alreadyPersisted: true },
      120_000,
    )
  })

  it('reports no selected session and clears every running session in the same project', async () => {
    const create = makeRequest('POST', '/api/mcp', {
      cwd: projectRoot, name: 'all-sessions', scope: 'local',
      config: { type: 'stdio', command: 'mock', args: [], env: {} },
    })
    await handleMcpApi(create.req, create.url, create.segments)
    conversationService.getActiveSessions = () => ['first', 'second', 'other']
    conversationService.hasSession = () => true
    conversationService.getSessionWorkDir = id => id === 'other' ? tmpDir : projectRoot
    const requestControl = mock(async () => ({}))
    conversationService.requestControl = requestControl as typeof conversationService.requestControl
    const toggle = makeRequest('POST', '/api/mcp/all-sessions/toggle', { cwd: projectRoot })
    const response = await handleMcpApi(toggle.req, toggle.url, toggle.segments)
    expect((await response.json()).sessionSync).toEqual({ applied: false, reason: 'no_session' })
    expect(requestControl.mock.calls.map(call => call[0])).toEqual(['first', 'second'])
  })

  it('reports a failed background session sync while keeping the persisted disable', async () => {
    const create = makeRequest('POST', '/api/mcp', {
      cwd: projectRoot, name: 'failed-sync', scope: 'local',
      config: { type: 'stdio', command: 'mock', args: [], env: {} },
    })
    await handleMcpApi(create.req, create.url, create.segments)
    conversationService.getActiveSessions = () => ['first', 'second']
    conversationService.hasSession = () => true
    conversationService.getSessionWorkDir = () => projectRoot
    conversationService.requestControl = (async (id: string) => {
      if (id === 'second') throw new Error('control transport closed')
      return {}
    }) as typeof conversationService.requestControl
    const toggle = makeRequest('POST', '/api/mcp/failed-sync/toggle', { cwd: projectRoot, sessionId: 'first' })
    const response = await handleMcpApi(toggle.req, toggle.url, toggle.segments)
    const body = await response.json()
    expect(body.server.enabled).toBe(false)
    expect(body.sessionSync).toEqual({ applied: false, reason: 'failed', error: 'control transport closed' })
  })

  it('applies disable immediately while a slow enable probe is pending', async () => {
    const create = makeRequest('POST', '/api/mcp', {
      cwd: projectRoot, name: 'slow-toggle', scope: 'local',
      config: { type: 'stdio', command: 'mock', args: [], env: {} },
    })
    await handleMcpApi(create.req, create.url, create.segments)
    const toggle = makeRequest('POST', '/api/mcp/slow-toggle/toggle', { cwd: projectRoot })
    await handleMcpApi(toggle.req, toggle.url, toggle.segments)
    let release!: () => void
    let probeStarted!: () => void
    const started = new Promise<void>(resolve => { probeStarted = resolve })
    const pending = new Promise<void>(resolve => { release = resolve })
    connectSpy!.mockImplementation(async (name, config) => {
      probeStarted()
      await pending
      return { name, type: 'connected', config, client: {} as never, capabilities: {}, cleanup: async () => {} }
    })
    const enable = makeRequest('POST', '/api/mcp/slow-toggle/toggle', { cwd: projectRoot })
    const enabling = handleMcpApi(enable.req, enable.url, enable.segments)
    await started
    const disable = makeRequest('POST', '/api/mcp/slow-toggle/toggle', { cwd: projectRoot })
    const disabling = handleMcpApi(disable.req, disable.url, disable.segments)
    try {
      const disabled = await Promise.race([disabling, Bun.sleep(100).then(() => null)])
      expect(disabled).not.toBeNull()
      expect((await disabled!.json()).server).toMatchObject({ enabled: false, status: 'disabled' })
    } finally { release() }
    expect((await (await enabling).json()).server).toMatchObject({ enabled: false, status: 'disabled' })
    expect(connectSpy).toHaveBeenCalledTimes(1)
  })

  it('retains the not-running sync receipt when enable preflight fails', async () => {
    const create = makeRequest('POST', '/api/mcp', {
      cwd: projectRoot, name: 'preflight-sync', scope: 'local',
      config: { type: 'stdio', command: 'mock', args: [], env: {} },
    })
    await handleMcpApi(create.req, create.url, create.segments)
    conversationService.hasSession = () => false
    const disable = makeRequest('POST', '/api/mcp/preflight-sync/toggle', { cwd: projectRoot })
    await handleMcpApi(disable.req, disable.url, disable.segments)
    hostPreflightSpy!.mockResolvedValue({ ok: false, message: 'Missing mock executable' })
    const enable = makeRequest('POST', '/api/mcp/preflight-sync/toggle', { cwd: projectRoot, sessionId: 'stopped' })
    const response = await handleMcpApi(enable.req, enable.url, enable.segments)
    expect(await response.json()).toMatchObject({
      server: { enabled: true, status: 'failed' },
      sessionSync: { applied: false, reason: 'not_running' },
    })
  })

  it('does not sync a project-specific toggle into a session from another project', async () => {
    const otherProject = path.join(tmpDir, 'other-project')
    await fs.mkdir(otherProject, { recursive: true })
    const create = makeRequest('POST', '/api/mcp', {
      cwd: projectRoot,
      name: 'project-only',
      scope: 'local',
      config: {
        type: 'stdio',
        command: 'npx',
        args: ['project-only-mcp'],
        env: {},
      },
    })
    await handleMcpApi(create.req, create.url, create.segments)

    const requestControl = mock(async () => ({}))
    conversationService.hasSession = ((sessionId: string) => sessionId === 'session-2') as typeof conversationService.hasSession
    conversationService.getSessionWorkDir = ((sessionId: string) => (
      sessionId === 'session-2' ? otherProject : ''
    )) as typeof conversationService.getSessionWorkDir
    conversationService.requestControl = requestControl as typeof conversationService.requestControl

    const disable = makeRequest('POST', '/api/mcp/project-only/toggle', {
      cwd: projectRoot,
      sessionId: 'session-2',
    })
    const disableRes = await handleMcpApi(disable.req, disable.url, disable.segments)
    const body = await disableRes.json()

    expect(disableRes.status).toBe(200)
    expect(body.server.enabled).toBe(false)
    expect(body.sessionSync).toEqual({ applied: false, reason: 'different_project' })
    expect(requestControl).not.toHaveBeenCalled()
  })

  it('reconnects plugin-scoped MCP servers exposed via the merged server list', async () => {
    const pluginServerName = 'plugin:telegram:telegram'
    const pluginServerConfig = {
      scope: 'dynamic',
      type: 'stdio',
      command: 'bun',
      args: ['run', 'start'],
      env: {
        CLAUDE_PLUGIN_ROOT: '/tmp/telegram-plugin',
      },
      pluginSource: 'telegram@claude-plugins-official',
    } as const

    getClaudeCodeMcpConfigsSpy = spyOn(mcpConfig, 'getClaudeCodeMcpConfigs').mockResolvedValue({
      servers: {
        [pluginServerName]: pluginServerConfig,
      },
      errors: [],
    })

    reconnectSpy = spyOn(mcpClient, 'reconnectMcpServerImpl').mockResolvedValue({
      name: pluginServerName,
      client: {
        name: pluginServerName,
        type: 'connected',
        client: {} as never,
        capabilities: {},
        config: pluginServerConfig,
        cleanup: mock(async () => {}),
      },
    })

    const reconnect = makeRequest('POST', `/api/mcp/${encodeURIComponent(pluginServerName)}/reconnect`, {
      cwd: projectRoot,
    })
    const reconnectRes = await handleMcpApi(reconnect.req, reconnect.url, reconnect.segments)

    expect(reconnectRes.status).toBe(200)
    expect(reconnectSpy).toHaveBeenCalledWith(pluginServerName, pluginServerConfig)

    const body = await reconnectRes.json()
    expect(body.server.name).toBe(pluginServerName)
    expect(body.server.scope).toBe('dynamic')
  })

  it('returns a failed server state when reconnect preflight fails on the host machine', async () => {
    const pluginServerName = 'plugin:telegram:telegram'
    const pluginServerConfig = {
      scope: 'dynamic',
      type: 'stdio',
      command: 'npx',
      args: ['telegram-mcp'],
      env: {},
      pluginSource: 'telegram@claude-plugins-official',
    } as const

    getClaudeCodeMcpConfigsSpy = spyOn(mcpConfig, 'getClaudeCodeMcpConfigs').mockResolvedValue({
      servers: {
        [pluginServerName]: pluginServerConfig,
      },
      errors: [],
    })

    hostPreflightSpy?.mockResolvedValueOnce({
      ok: false,
      message: 'Host command "npx" is not available in PATH.',
    })

    reconnectSpy = spyOn(mcpClient, 'reconnectMcpServerImpl').mockResolvedValue({
      name: pluginServerName,
      client: {
        name: pluginServerName,
        type: 'connected',
        client: {} as never,
        capabilities: {},
        config: pluginServerConfig,
        cleanup: mock(async () => {}),
      },
    })

    const reconnect = makeRequest('POST', `/api/mcp/${encodeURIComponent(pluginServerName)}/reconnect`, {
      cwd: projectRoot,
    })
    const reconnectRes = await handleMcpApi(reconnect.req, reconnect.url, reconnect.segments)

    expect(reconnectRes.status).toBe(200)
    expect(reconnectSpy).not.toHaveBeenCalled()
    await expect(reconnectRes.json()).resolves.toMatchObject({
      server: {
        name: pluginServerName,
        status: 'failed',
        statusDetail: 'Host command "npx" is not available in PATH.',
      },
    })
  })
})
