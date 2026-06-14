import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { handlePluginsApi } from '../api/plugins.js'
import { clearPluginOptionsCache } from '../../utils/plugins/pluginOptionsStorage.js'
import { resetSettingsCache } from '../../utils/plugins/pluginOptionsStorage.js'

let tmpDir: string
let originalConfigDir: string | undefined

function makeRequest(method: string, urlStr: string, body?: unknown) {
  const url = new URL(urlStr, 'http://localhost:3456')
  const init: RequestInit = { method }
  if (body) {
    init.headers = { 'Content-Type': 'application/json' }
    init.body = JSON.stringify(body)
  }
  const req = new Request(url.toString(), init)
  return { req, url, segments: url.pathname.split('/').filter(Boolean) }
}

async function setupPluginFixture(pluginId: string, userConfig: Record<string, unknown>) {
  const ccHahaDir = path.join(tmpDir, 'cc-haha')
  await fs.mkdir(ccHahaDir, { recursive: true })

  // Write providers index with a test plugin
  const index = {
    schemaVersion: 1,
    activeId: null,
    providers: [{
      id: pluginId,
      name: 'test-plugin',
      baseUrl: 'https://example.com/v1',
      apiKey: 'sk-test',
      apiFormat: 'anthropic',
      runtimeKind: 'anthropic_compatible',
      models: { main: 'test-model', haiku: '', sonnet: '', opus: '' },
    }],
  }
  await fs.writeFile(path.join(ccHahaDir, 'providers.json'), JSON.stringify(index, null, 2))

  // Write plugin manifest with userConfig
  const pluginDir = path.join(tmpDir, 'plugins', 'test-plugin', '.claude-plugin')
  await fs.mkdir(pluginDir, { recursive: true })
  await fs.writeFile(path.join(pluginDir, 'plugin.json'), JSON.stringify({
    name: 'test-plugin',
    version: '1.0.0',
    description: 'Test plugin',
    userConfig,
  }))

  // Register as marketplace plugin
  const marketplaceDir = path.join(tmpDir, 'plugins', '.claude-plugin')
  await fs.mkdir(marketplaceDir, { recursive: true })
  await fs.writeFile(path.join(marketplaceDir, 'marketplace.json'), JSON.stringify({
    name: 'test-market',
    metadata: { description: 'Test marketplace' },
    plugins: [{ name: 'test-plugin', source: './test-plugin' }],
  }))
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-plugins-options-'))
  originalConfigDir = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = tmpDir
  clearPluginOptionsCache()
})

afterEach(async () => {
  if (originalConfigDir !== undefined) {
    process.env.CLAUDE_CONFIG_DIR = originalConfigDir
  } else {
    delete process.env.CLAUDE_CONFIG_DIR
  }
  await fs.rm(tmpDir, { recursive: true, force: true })
})

describe('GET /api/plugins/options', () => {
  it('returns schema and masked values for a plugin with userConfig', async () => {
    const pluginId = 'test-plugin@test-market'
    await setupPluginFixture(pluginId, {
      API_KEY: {
        type: 'string',
        title: 'API Key',
        required: true,
        sensitive: true,
      },
      BASE_URL: {
        type: 'string',
        title: 'Base URL',
        default: 'https://example.com',
      },
    })

    // Save some options first
    const settingsDir = path.join(tmpDir, 'cc-haha')
    await fs.mkdir(settingsDir, { recursive: true })
    const settings = {
      pluginConfigs: {
        [pluginId]: {
          options: { BASE_URL: 'https://custom.com' },
        },
      },
    }
    await fs.writeFile(path.join(settingsDir, 'settings.json'), JSON.stringify(settings))

    const { req, url, segments } = makeRequest('GET', `/api/plugins/options?id=${encodeURIComponent(pluginId)}`)
    const res = await handlePluginsApi(req, url, segments)

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.pluginId).toBe(pluginId)
    expect(body.schema).toHaveProperty('API_KEY')
    expect(body.schema).toHaveProperty('BASE_URL')
    // Non-sensitive value should be returned as-is
    expect(body.values.BASE_URL).toBe('https://custom.com')
  })

  it('returns 400 when id is missing', async () => {
    const { req, url, segments } = makeRequest('GET', '/api/plugins/options')
    const res = await handlePluginsApi(req, url, segments)

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('Missing required "id"')
  })
})

describe('POST /api/plugins/options', () => {
  it('saves non-sensitive values to settings.json', async () => {
    const pluginId = 'test-plugin@test-market'
    await setupPluginFixture(pluginId, {
      BASE_URL: { type: 'string', title: 'Base URL' },
    })

    const { req, url, segments } = makeRequest('POST', '/api/plugins/options', {
      id: pluginId,
      values: { BASE_URL: 'https://new-url.com' },
    })
    const res = await handlePluginsApi(req, url, segments)

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)

    // Verify saved to settings.json
    const settingsPath = path.join(tmpDir, 'cc-haha', 'settings.json')
    const saved = JSON.parse(await fs.readFile(settingsPath, 'utf-8'))
    expect(saved.pluginConfigs[pluginId].options.BASE_URL).toBe('https://new-url.com')
  })

  it('filters out keys not in schema', async () => {
    const pluginId = 'test-plugin@test-market'
    await setupPluginFixture(pluginId, {
      BASE_URL: { type: 'string', title: 'Base URL' },
    })

    const { req, url, segments } = makeRequest('POST', '/api/plugins/options', {
      id: pluginId,
      values: { BASE_URL: 'https://ok.com', EVIL_KEY: 'injected' },
    })
    const res = await handlePluginsApi(req, url, segments)

    expect(res.status).toBe(200)
    const settingsPath = path.join(tmpDir, 'cc-haha', 'settings.json')
    const saved = JSON.parse(await fs.readFile(settingsPath, 'utf-8'))
    expect(saved.pluginConfigs[pluginId].options).not.toHaveProperty('EVIL_KEY')
    expect(saved.pluginConfigs[pluginId].options.BASE_URL).toBe('https://ok.com')
  })

  it('returns 400 when id is missing', async () => {
    const { req, url, segments } = makeRequest('POST', '/api/plugins/options', {
      values: { KEY: 'value' },
    })
    const res = await handlePluginsApi(req, url, segments)

    expect(res.status).toBe(400)
  })

  it('returns 400 when values is not an object', async () => {
    const { req, url, segments } = makeRequest('POST', '/api/plugins/options', {
      id: 'test@test-market',
      values: 'not-an-object',
    })
    const res = await handlePluginsApi(req, url, segments)

    expect(res.status).toBe(400)
  })
})
