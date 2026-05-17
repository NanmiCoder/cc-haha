import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import * as mcpClient from '../../services/mcp/client.js'
import * as mcpConfig from '../../services/mcp/config.js'
import * as mcpHostPreflight from '../services/mcpHostPreflight.js'
import { handleMcpApi } from '../api/mcp.js'

let tmpDir: string
let projectRoot: string
let originalConfigDir: string | undefined
let connectSpy: ReturnType<typeof spyOn> | undefined
let getClaudeCodeMcpConfigsSpy: ReturnType<typeof spyOn> | undefined
let getAllMcpConfigsSpy: ReturnType<typeof spyOn> | undefined
let reconnectSpy: ReturnType<typeof spyOn> | undefined
let hostPreflightSpy: ReturnType<typeof spyOn> | undefined

async function setup() {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-mcp-test-'))
  projectRoot = path.join(tmpDir, 'project')
  await fs.mkdir(path.join(projectRoot, '.claude'), { recursive: true })

  originalConfigDir = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = tmpDir
}

async function teardown() {
  if (originalConfigDir !== undefined) {
    process.env.CLAUDE_CONFIG_DIR = originalConfigDir
  } else {
    delete process.env.CLAUDE_CONFIG_DIR
  }

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
    reconnectSpy?.mockRestore()
    reconnectSpy = undefined
    hostPreflightSpy?.mockRestore()
    hostPreflightSpy = undefined
    await teardown()
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

    const list = makeRequest('GET', `/api/mcp?cwd=${encodeURIComponent(projectRoot)}`)
    const listRes = await handleMcpApi(list.req, list.url, list.segments)
    expect(listRes.status).toBe(200)
    const listBody = await listRes.json()

    expect(listBody.servers).toHaveLength(1)
    expect(listBody.servers[0].name).toBe('chrome-devtools')
    expect(listBody.servers[0].status).toBe('checking')
    expect(listBody.servers[0].config.command).toBe('npx')
    expect(connectSpy).not.toHaveBeenCalled()
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
