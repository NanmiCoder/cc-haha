import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { handleModelsApi } from './models.js'
import { handleProvidersApi } from './providers.js'
import { ProviderService } from '../services/providerService.js'
import { hahaOAuthService } from '../services/hahaOAuthService.js'
import { hahaOpenAIOAuthService } from '../services/hahaOpenAIOAuthService.js'
import { hahaGrokOAuthService } from '../services/hahaGrokOAuthService.js'
import { clearDesktopClaudeModelCatalogCache } from '../services/claudeModelCatalog.js'
import { clearOpenAICodexModelCatalogCache } from '../../services/openaiAuth/modelCatalog.js'
import { clearGrokModelCatalogCache } from '../../services/grokAuth/modelCatalog.js'
import { clearDeepSeekAccountModelCatalogCache } from '../../services/deepseekAuth/modelCatalog.js'
import { listSessionModels } from '../services/sessionModelCatalog.js'

function request(path: string, method = 'GET', body?: unknown) {
  const url = new URL(path, 'http://localhost')
  return [new Request(url, { method, ...(body === undefined ? {} : {
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }) }), url, url.pathname.split('/').filter(Boolean)] as const
}

const fixtures = [
  { provider: 'openai-official', model: 'codex-future', url: 'https://chatgpt.com/backend-api/codex/models',
    body: (id: string) => ({ models: [{ slug: id, display_name: 'Future Codex', visibility: 'list' }] }) },
  { provider: 'grok-official', model: 'grok-future', url: 'https://cli-chat-proxy.grok.com/v1/models',
    body: (id: string) => ({ models: [{ id: 'display-only', model: id, name: 'Future Grok' }] }) },
  { provider: 'claude-official', model: 'claude-future', url: 'https://api.anthropic.com/v1/models',
    body: (id: string) => ({ data: [{ id, display_name: 'Future Claude' }], has_more: false }) },
]

describe('official model catalog API refresh', () => {
  let directory: string
  let originalConfig: string | undefined
  let originalHome: string | undefined
  let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, 'fetch'>>

  const clearCaches = () => {
    clearDesktopClaudeModelCatalogCache()
    clearOpenAICodexModelCatalogCache()
    clearGrokModelCatalogCache()
    clearDeepSeekAccountModelCatalogCache()
  }

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'official-catalog-api-'))
    originalConfig = process.env.CLAUDE_CONFIG_DIR
    originalHome = process.env.HOME
    process.env.CLAUDE_CONFIG_DIR = directory
    process.env.HOME = directory
    clearCaches()
    fetchSpy = spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected upstream request'))
    await writeFile(join(directory, 'settings.json'), JSON.stringify({
      network: { proxy: { mode: 'manual', url: 'http://127.0.0.1:7890' } },
      futureSetting: 'preserve',
    }))
    await hahaOAuthService.saveTokens({ accessToken: 'fake-claude', refreshToken: null, expiresAt: null,
      scopes: ['user:inference'], subscriptionType: 'pro' })
    await hahaOpenAIOAuthService.saveTokens({ accessToken: 'fake-openai', refreshToken: null, expiresAt: null,
      accountId: 'fake-account', email: 'fixture@example.test' })
    await hahaGrokOAuthService.saveTokens({ accessToken: 'fake-grok', refreshToken: null, expiresAt: null,
      email: 'fixture@example.test' })
  })

  afterEach(async () => {
    clearCaches()
    fetchSpy.mockRestore()
    if (originalConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = originalConfig
    if (originalHome === undefined) delete process.env.HOME
    else process.env.HOME = originalHome
    await rm(directory, { recursive: true, force: true })
  })

  for (const fixture of fixtures) {
    test(`${fixture.provider}: refreshes the card's account, preserves selection, then saves and consumes a new ID`, async () => {
      const providers = new ProviderService()
      await providers.activateProvider(fixture.provider === 'grok-official' ? 'openai-official' : 'grok-official')
      const originalActive = (await providers.listProviders()).activeId
      const originalMapping = await providers.getOfficialProviderModels(fixture.provider)
      let generation = 1
      fetchSpy.mockImplementation((async (input, init) => {
        const url = new URL(String(input))
        expect(url.origin + url.pathname).toBe(fixture.url)
        expect(new Headers(init?.headers).get('Authorization')).toBe(`Bearer fake-${fixture.provider.split('-')[0]}`)
        expect((init as RequestInit & { proxy?: string }).proxy).toBe('http://127.0.0.1:7890')
        return Response.json(fixture.body(`${fixture.model}-${generation}`))
      }) as typeof fetch)

      const path = `/api/models/catalog?provider=${fixture.provider}`
      expect((await handleModelsApi(...request(`${path}&refresh=true`))).status).toBe(200)
      const cached = await (await handleModelsApi(...request(path))).json()
      expect(cached.models.map((model: { id: string }) => model.id)).toEqual([`${fixture.model}-1`])
      expect(fetchSpy).toHaveBeenCalledTimes(1)
      generation = 2
      const refreshed = await (await handleModelsApi(...request(`${path}&refresh=true`))).json()
      const modelId = `${fixture.model}-2`
      expect(refreshed.models.map((model: { id: string }) => model.id)).toEqual([modelId])
      expect(fetchSpy).toHaveBeenCalledTimes(2)
      expect((await providers.listProviders()).activeId).toBe(originalActive)
      expect(await providers.getOfficialProviderModels(fixture.provider)).toEqual(originalMapping)

      const mapping = { main: modelId, haiku: modelId, sonnet: modelId, opus: modelId }
      const saved = await handleProvidersApi(...request(`/api/providers/${fixture.provider}/models`, 'PUT', { models: mapping }))
      expect(saved.status).toBe(200)
      expect(await new ProviderService().getOfficialProviderModels(fixture.provider)).toEqual(mapping)
      if (fixture.provider === 'claude-official') await providers.activateOfficial()
      else await providers.activateProvider(fixture.provider)
      const current = await (await handleModelsApi(...request('/api/models/current'))).json()
      expect(current.model.id).toBe(modelId)
      const list = await (await handleModelsApi(...request('/api/models'))).json()
      expect(list.models.map((model: { id: string }) => model.id)).toContain(modelId)
      const delegated = await listSessionModels()
      expect(delegated.some(model => model.modelId === modelId &&
        model.providerId === (fixture.provider === 'claude-official' ? null : fixture.provider))).toBe(true)

      fetchSpy.mockResolvedValue(new Response(null, { status: 401 }))
      const failed = await handleModelsApi(...request(`${path}&refresh=true`))
      expect(failed.status).toBe(502)
      expect(await failed.json()).toMatchObject({ error: 'MODEL_CATALOG_REFRESH_FAILED' })
      const retained = await (await handleModelsApi(...request(path))).json()
      expect(retained.models.map((model: { id: string }) => model.id)).toEqual([modelId])
    })
  }

  test('refresh without a desktop login reports failure for every account provider', async () => {
    await hahaOAuthService.deleteTokens()
    await hahaOpenAIOAuthService.deleteTokens()
    await hahaGrokOAuthService.deleteTokens()
    for (const provider of [...fixtures.map(fixture => fixture.provider), 'deepseek-account']) {
      const response = await handleModelsApi(...request(`/api/models/catalog?provider=${provider}&refresh=true`))
      expect(response.status).toBe(502)
    }
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
