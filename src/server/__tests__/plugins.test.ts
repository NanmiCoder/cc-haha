import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import type { AppState } from '../../state/AppStateStore.js'
import { isEnabledPluginSettingValue } from '../../utils/plugins/dependencyResolver.js'
import { clearInstalledPluginsCache } from '../../utils/plugins/installedPluginsManager.js'
import { clearPluginCache, loadAllPluginsCacheOnly } from '../../utils/plugins/pluginLoader.js'
import { refreshActivePlugins } from '../../utils/plugins/refresh.js'
import { resetSettingsCache } from '../../utils/settings/settingsCache.js'
import { handlePluginsApi } from '../api/plugins.js'
import { conversationService } from '../services/conversationService.js'
import { __resetWebSocketHandlerStateForTests, getSlashCommands } from '../ws/handler.js'

let tmpDir: string
let originalConfigDir: string | undefined
let originalHasSession: typeof conversationService.hasSession
let originalRequestControl: typeof conversationService.requestControl

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

describe('Plugins API', () => {
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-plugins-api-'))
    originalConfigDir = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = tmpDir
    clearInstalledPluginsCache()
    clearPluginCache('plugins-api-test-setup')
    resetSettingsCache()
    __resetWebSocketHandlerStateForTests()
    originalHasSession = conversationService.hasSession.bind(conversationService)
    originalRequestControl = conversationService.requestControl.bind(conversationService)
  })

  afterEach(async () => {
    conversationService.hasSession = originalHasSession
    conversationService.requestControl = originalRequestControl
    __resetWebSocketHandlerStateForTests()
    clearInstalledPluginsCache()
    clearPluginCache('plugins-api-test-teardown')
    resetSettingsCache()
    if (originalConfigDir === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR
    } else {
      process.env.CLAUDE_CONFIG_DIR = originalConfigDir
    }
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('GET /api/plugins returns an empty plugin list for a clean config', async () => {
    const { req, url, segments } = makeRequest('GET', '/api/plugins')
    const res = await handlePluginsApi(req, url, segments)

    expect(res.status).toBe(200)
    const body = await res.json() as {
      plugins: unknown[]
      marketplaces: unknown[]
      summary: { total: number; enabled: number; errorCount: number }
    }

    expect(body.plugins).toEqual([])
    expect(Array.isArray(body.marketplaces)).toBe(true)
    expect(body.summary.total).toBe(0)
    expect(body.summary.enabled).toBe(0)
    expect(body.summary.errorCount).toBe(0)
  })

  it('treats enabledPlugins version constraint arrays as enabled plugins', async () => {
    const marketplaceRoot = path.join(tmpDir, 'marketplace-root')
    const pluginRoot = path.join(marketplaceRoot, 'plugins', 'demo')
    const pluginsDir = path.join(tmpDir, 'plugins')
    const marketplaceFile = path.join(marketplaceRoot, '.claude-plugin', 'marketplace.json')

    await fs.mkdir(path.join(pluginRoot, '.claude-plugin'), { recursive: true })
    await fs.mkdir(path.dirname(marketplaceFile), { recursive: true })
    await fs.mkdir(pluginsDir, { recursive: true })

    await fs.writeFile(
      path.join(pluginRoot, '.claude-plugin', 'plugin.json'),
      JSON.stringify({
        name: 'demo',
        version: '1.0.0',
        description: 'Demo plugin',
      }),
      'utf-8',
    )
    await fs.writeFile(
      marketplaceFile,
      JSON.stringify({
        name: 'test-market',
        owner: { name: 'Test' },
        plugins: [
          {
            name: 'demo',
            source: './plugins/demo',
            version: '1.0.0',
          },
        ],
      }),
      'utf-8',
    )
    await fs.writeFile(
      path.join(pluginsDir, 'known_marketplaces.json'),
      JSON.stringify({
        'test-market': {
          source: { source: 'directory', path: marketplaceRoot },
          installLocation: marketplaceRoot,
          lastUpdated: new Date(0).toISOString(),
        },
      }),
      'utf-8',
    )
    await fs.writeFile(
      path.join(tmpDir, 'settings.json'),
      JSON.stringify({
        enabledPlugins: {
          'demo@test-market': ['^1.0.0'],
        },
      }),
      'utf-8',
    )

    expect(isEnabledPluginSettingValue(true)).toBe(true)
    expect(isEnabledPluginSettingValue(['^1.0.0'])).toBe(true)
    expect(isEnabledPluginSettingValue(false)).toBe(false)
    expect(isEnabledPluginSettingValue(undefined)).toBe(false)

    const cacheOnlyResult = await loadAllPluginsCacheOnly()
    expect(cacheOnlyResult.enabled).toContainEqual(
      expect.objectContaining({ source: 'demo@test-market', enabled: true }),
    )

    clearPluginCache('plugins-api-test-full-load')

    const { req, url, segments } = makeRequest('GET', '/api/plugins')
    const res = await handlePluginsApi(req, url, segments)

    expect(res.status).toBe(200)
    const body = await res.json() as {
      plugins: Array<{ id: string; enabled: boolean }>
      summary: { enabled: number }
    }
    expect(body.plugins).toContainEqual(
      expect.objectContaining({ id: 'demo@test-market', enabled: true }),
    )
    expect(body.summary.enabled).toBe(1)
  })

  it('POST /api/plugins/reload returns numeric counters', async () => {
    const { req, url, segments } = makeRequest('POST', '/api/plugins/reload', {})
    const res = await handlePluginsApi(req, url, segments)

    expect(res.status).toBe(200)
    const body = await res.json() as {
      ok: boolean
      summary: Record<string, number>
    }

    expect(body.ok).toBe(true)
    expect(typeof body.summary.enabled).toBe('number')
    expect(typeof body.summary.skills).toBe('number')
    expect(typeof body.summary.errors).toBe('number')
  })

  it('POST /api/plugins/reload hot-reloads an active CLI session and updates slash commands', async () => {
    const controlRequests: Array<{ sessionId: string; request: Record<string, unknown> }> = []
    conversationService.hasSession = ((sessionId: string) => sessionId === 'session-plugins') as typeof conversationService.hasSession
    conversationService.requestControl = (async (
      sessionId: string,
      request: Record<string, unknown>,
    ) => {
      controlRequests.push({ sessionId, request })
      return {
        commands: [
          {
            name: 'draw:render',
            description: 'Render a drawing.',
            argumentHint: '<prompt>',
          },
        ],
        agents: [{ name: 'draw-agent' }],
        plugins: [{ name: 'draw', path: '/tmp/draw', source: 'draw@test' }],
        mcpServers: [{ name: 'plugin:draw:server', type: 'connected' }],
        error_count: 0,
      }
    }) as typeof conversationService.requestControl

    const { req, url, segments } = makeRequest(
      'POST',
      '/api/plugins/reload?sessionId=session-plugins',
      {},
    )
    const res = await handlePluginsApi(req, url, segments)

    expect(res.status).toBe(200)
    const body = await res.json() as {
      session: {
        applied: boolean
        commands: number
        agents: number
        plugins: number
        mcpServers: number
        errors: number
      }
    }

    expect(controlRequests).toEqual([
      {
        sessionId: 'session-plugins',
        request: { subtype: 'reload_plugins' },
      },
    ])
    expect(body.session).toEqual({
      applied: true,
      commands: 1,
      agents: 1,
      plugins: 1,
      mcpServers: 1,
      errors: 0,
    })
    expect(getSlashCommands('session-plugins')).toEqual([
      {
        name: 'draw:render',
        description: 'Render a drawing.',
        argumentHint: '<prompt>',
      },
    ])
  })

  it('refreshActivePlugins rereads settings after an external enable toggle', async () => {
    const marketplaceRoot = path.join(tmpDir, 'marketplace-root')
    const pluginRoot = path.join(marketplaceRoot, 'plugins', 'draw')
    const pluginsDir = path.join(tmpDir, 'plugins')
    const marketplaceFile = path.join(
      marketplaceRoot,
      '.claude-plugin',
      'marketplace.json',
    )

    await fs.mkdir(path.join(pluginRoot, '.claude-plugin'), { recursive: true })
    await fs.mkdir(path.join(pluginRoot, 'commands'), { recursive: true })
    await fs.mkdir(path.join(pluginRoot, 'skills', 'paint'), { recursive: true })
    await fs.mkdir(path.dirname(marketplaceFile), { recursive: true })
    await fs.mkdir(pluginsDir, { recursive: true })

    await fs.writeFile(
      path.join(pluginRoot, '.claude-plugin', 'plugin.json'),
      JSON.stringify({
        name: 'draw',
        version: '1.0.0',
        description: 'Drawing plugin',
      }),
      'utf-8',
    )
    await fs.writeFile(
      path.join(pluginRoot, 'commands', 'render.md'),
      '---\ndescription: Render a drawing.\n---\nRender this drawing.',
      'utf-8',
    )
    await fs.writeFile(
      path.join(pluginRoot, 'skills', 'paint', 'SKILL.md'),
      '---\ndescription: Paint with the drawing plugin.\n---\nPaint this drawing.',
      'utf-8',
    )
    await fs.writeFile(
      marketplaceFile,
      JSON.stringify({
        name: 'test-market',
        owner: { name: 'Test' },
        plugins: [
          {
            name: 'draw',
            source: './plugins/draw',
            version: '1.0.0',
          },
        ],
      }),
      'utf-8',
    )
    await fs.writeFile(
      path.join(pluginsDir, 'known_marketplaces.json'),
      JSON.stringify({
        'test-market': {
          source: { source: 'directory', path: marketplaceRoot },
          installLocation: marketplaceRoot,
          lastUpdated: new Date(0).toISOString(),
        },
      }),
      'utf-8',
    )

    const settingsPath = path.join(tmpDir, 'settings.json')
    await fs.writeFile(
      settingsPath,
      JSON.stringify({
        enabledPlugins: {
          'draw@test-market': false,
        },
      }),
      'utf-8',
    )

    const disabledResult = await loadAllPluginsCacheOnly()
    expect(disabledResult.enabled).toEqual([])
    expect(disabledResult.disabled).toContainEqual(
      expect.objectContaining({ source: 'draw@test-market', enabled: false }),
    )

    await fs.writeFile(
      settingsPath,
      JSON.stringify({
        enabledPlugins: {
          'draw@test-market': true,
        },
      }),
      'utf-8',
    )

    let appState = {
      plugins: {
        enabled: [],
        disabled: disabledResult.disabled,
        commands: [],
        errors: [],
        needsRefresh: true,
      },
      mcp: { pluginReconnectKey: 0 },
      agentDefinitions: { allAgents: [], errors: [] },
    } as unknown as AppState

    const result = await refreshActivePlugins(updater => {
      appState = updater(appState)
    })

    expect(result.enabled_count).toBe(1)
    expect(result.command_count).toBe(1)
    expect(result.skill_count).toBe(1)
    expect(result.pluginCommands).toContainEqual(
      expect.objectContaining({
        name: 'draw:render',
        description: 'Render a drawing.',
      }),
    )
    expect(result.pluginSkills).toContainEqual(
      expect.objectContaining({
        name: 'draw:paint',
        description: 'Paint with the drawing plugin.',
      }),
    )
    expect(appState.plugins.commands).toContainEqual(
      expect.objectContaining({ name: 'draw:render' }),
    )
    expect(appState.plugins.commands).toContainEqual(
      expect.objectContaining({ name: 'draw:paint' }),
    )
  })
})

describe('Plugins catalog & install API', () => {
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-plugins-catalog-'))
    originalConfigDir = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = tmpDir
    clearInstalledPluginsCache()
    clearPluginCache('plugins-catalog-test-setup')
    resetSettingsCache()
    __resetWebSocketHandlerStateForTests()
  })

  afterEach(async () => {
    __resetWebSocketHandlerStateForTests()
    clearInstalledPluginsCache()
    clearPluginCache('plugins-catalog-test-teardown')
    resetSettingsCache()
    if (originalConfigDir === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR
    } else {
      process.env.CLAUDE_CONFIG_DIR = originalConfigDir
    }
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('GET /api/plugins/catalog returns the curated entries with installed=false on a clean config', async () => {
    const { req, url, segments } = makeRequest('GET', '/api/plugins/catalog')
    const res = await handlePluginsApi(req, url, segments)

    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      catalog: Array<{
        id: string
        marketplace: string
        installed: boolean
        category: string
      }>
    }

    expect(body.catalog.length).toBeGreaterThan(0)
    const sp = body.catalog.find((e) => e.id === 'superpowers')
    expect(sp).toBeDefined()
    expect(sp?.marketplace).toBe('claude-plugins-official')
    expect(sp?.installed).toBe(false)
  })

  it('POST /api/plugins/marketplace registers a local directory marketplace from input', async () => {
    const marketplaceRoot = path.join(tmpDir, 'local-market')
    await fs.mkdir(path.join(marketplaceRoot, '.claude-plugin'), { recursive: true })
    await fs.writeFile(
      path.join(marketplaceRoot, '.claude-plugin', 'marketplace.json'),
      JSON.stringify({
        name: 'my-local-mkt',
        owner: { name: 'Tester' },
        plugins: [],
      }),
      'utf-8',
    )

    const { req, url, segments } = makeRequest('POST', '/api/plugins/marketplace', {
      input: marketplaceRoot,
    })
    const res = await handlePluginsApi(req, url, segments)

    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      ok: true
      name: string
      alreadyMaterialized: boolean
    }
    expect(body.ok).toBe(true)
    expect(body.name).toBe('my-local-mkt')
    expect(body.alreadyMaterialized).toBe(false)

    // Idempotent re-add: same source returns alreadyMaterialized.
    const second = makeRequest('POST', '/api/plugins/marketplace', {
      input: marketplaceRoot,
    })
    const secondRes = await handlePluginsApi(second.req, second.url, second.segments)
    const secondBody = (await secondRes.json()) as { alreadyMaterialized: boolean }
    expect(secondBody.alreadyMaterialized).toBe(true)
  })

  it('POST /api/plugins/marketplace rejects invalid input', async () => {
    const { req, url, segments } = makeRequest('POST', '/api/plugins/marketplace', {
      input: 'this is not a valid source spec',
    })
    const res = await handlePluginsApi(req, url, segments)
    expect(res.status).toBe(400)
  })

  it('POST /api/plugins/install enables a catalog plugin and flips installed in catalog', async () => {
    // Pre-materialize the official marketplace from a fake local directory so
    // addMarketplaceSource short-circuits (source-idempotent) and we never
    // touch the network. We register it under the official name with the
    // exact OFFICIAL_MARKETPLACE_SOURCE shape the catalog uses.
    const marketplaceRoot = path.join(tmpDir, 'fake-official')
    const pluginRoot = path.join(marketplaceRoot, 'plugins', 'superpowers')
    const pluginsDir = path.join(tmpDir, 'plugins')

    await fs.mkdir(path.join(pluginRoot, '.claude-plugin'), { recursive: true })
    await fs.mkdir(path.join(marketplaceRoot, '.claude-plugin'), { recursive: true })
    await fs.mkdir(pluginsDir, { recursive: true })

    await fs.writeFile(
      path.join(pluginRoot, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'superpowers', version: '0.0.0', description: 'test' }),
      'utf-8',
    )
    await fs.writeFile(
      path.join(marketplaceRoot, '.claude-plugin', 'marketplace.json'),
      JSON.stringify({
        name: 'claude-plugins-official',
        owner: { name: 'Anthropic' },
        plugins: [
          { name: 'superpowers', source: './plugins/superpowers', version: '0.0.0' },
        ],
      }),
      'utf-8',
    )
    await fs.writeFile(
      path.join(pluginsDir, 'known_marketplaces.json'),
      JSON.stringify({
        'claude-plugins-official': {
          source: { source: 'github', repo: 'anthropics/claude-plugins-official' },
          installLocation: marketplaceRoot,
          lastUpdated: new Date(0).toISOString(),
        },
      }),
      'utf-8',
    )

    // Sanity: catalog reports installed=false initially.
    const before = makeRequest('GET', '/api/plugins/catalog')
    const beforeBody = (await (await handlePluginsApi(
      before.req,
      before.url,
      before.segments,
    )).json()) as { catalog: Array<{ id: string; installed: boolean }> }
    expect(
      beforeBody.catalog.find((e) => e.id === 'superpowers')?.installed,
    ).toBe(false)

    // Install — addMarketplaceSource is source-idempotent (source matches
    // pre-registered entry), so this only writes settings + V2 file.
    const inst = makeRequest('POST', '/api/plugins/install', {
      id: 'superpowers',
      marketplace: 'claude-plugins-official',
    })
    const instRes = await handlePluginsApi(inst.req, inst.url, inst.segments)
    expect(instRes.status).toBe(200)
    const instBody = (await instRes.json()) as {
      ok: true
      marketplaceAdded: boolean
    }
    expect(instBody.ok).toBe(true)
    expect(instBody.marketplaceAdded).toBe(false) // already materialized

    // settings.json should now have the enabled entry.
    const settings = JSON.parse(
      await fs.readFile(path.join(tmpDir, 'settings.json'), 'utf-8'),
    ) as { enabledPlugins: Record<string, unknown> }
    expect(settings.enabledPlugins['superpowers@claude-plugins-official']).toBe(true)

    // Catalog now reports installed=true (V2 installed file populated by enable).
    const after = makeRequest('GET', '/api/plugins/catalog')
    const afterBody = (await (await handlePluginsApi(
      after.req,
      after.url,
      after.segments,
    )).json()) as { catalog: Array<{ id: string; installed: boolean }> }
    expect(
      afterBody.catalog.find((e) => e.id === 'superpowers')?.installed,
    ).toBe(true)
  })

  it('POST /api/plugins/install rejects unknown catalog entries', async () => {
    const { req, url, segments } = makeRequest('POST', '/api/plugins/install', {
      id: 'does-not-exist',
      marketplace: 'claude-plugins-official',
    })
    const res = await handlePluginsApi(req, url, segments)
    expect(res.status).toBe(404)
  })
})

describe('Language servers API', () => {
  it('GET /api/plugins/language-servers returns status for every known language', async () => {
    const { req, url, segments } = makeRequest(
      'GET',
      '/api/plugins/language-servers',
    )
    const res = await handlePluginsApi(req, url, segments)

    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      servers: Array<{
        language: string
        label: string
        installed: boolean
        resolvedPath: string | null
        install: Record<string, unknown>
      }>
    }

    const ids = body.servers.map((s) => s.language).sort()
    expect(ids).toEqual(
      ['c', 'cpp', 'csharp', 'go', 'java', 'lua', 'php', 'python', 'rust', 'typescript'].sort(),
    )
    for (const server of body.servers) {
      expect(typeof server.installed).toBe('boolean')
      expect(typeof server.label).toBe('string')
    }
  })
})

