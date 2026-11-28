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
import { OPENAI_CODEX_CLIENT_VERSION } from '../../services/openaiAuth/client.js'
import { OPENAI_CODEX_RELEASE_SOURCES } from '../../services/openaiAuth/clientVersion.js'
import { MODEL_CONTEXT_WINDOWS_ENV_KEY } from '../../utils/model/modelContextWindows.js'
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
      let catalogRequests = 0
      fetchSpy.mockImplementation((async (input, init) => {
        expect((init as RequestInit & { proxy?: string }).proxy).toBe('http://127.0.0.1:7890')
        if ((OPENAI_CODEX_RELEASE_SOURCES as readonly string[]).includes(String(input))) {
          return Response.json({ version: OPENAI_CODEX_CLIENT_VERSION })
        }
        catalogRequests += 1
        const url = new URL(String(input))
        expect(url.origin + url.pathname).toBe(fixture.url)
        expect(new Headers(init?.headers).get('Authorization')).toBe(`Bearer fake-${fixture.provider.split('-')[0]}`)
        return Response.json(fixture.body(`${fixture.model}-${generation}`))
      }) as typeof fetch)

      const path = `/api/models/catalog?provider=${fixture.provider}`
      expect((await handleModelsApi(...request(`${path}&refresh=true`))).status).toBe(200)
      const cached = await (await handleModelsApi(...request(path))).json()
      expect(cached.models.map((model: { id: string }) => model.id)).toEqual([`${fixture.model}-1`])
      expect(catalogRequests).toBe(1)
      generation = 2
      const refreshed = await (await handleModelsApi(...request(`${path}&refresh=true`))).json()
      const modelId = `${fixture.model}-2`
      expect(refreshed.models.map((model: { id: string }) => model.id)).toEqual([modelId])
      expect(catalogRequests).toBe(2)
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

  test('openai-official lists each model\'s default window and the highest one it can be set to', async () => {
    fetchSpy.mockImplementation((async (input) => {
      if ((OPENAI_CODEX_RELEASE_SOURCES as readonly string[]).includes(String(input))) {
        return Response.json({ version: OPENAI_CODEX_CLIENT_VERSION })
      }
      return Response.json({ models: [
        { slug: 'gpt-6-astra', visibility: 'list', context_window: 272_000, max_context_window: 872_000 },
        // Not in the bundled catalog and no stated maximum: no cap is invented.
        { slug: 'codex-future', visibility: 'list', context_window: 500_000 },
      ] })
    }) as typeof fetch)

    const response = await handleModelsApi(...request('/api/models/catalog?provider=openai-official&refresh=true'))
    const { models } = await response.json() as { models: Array<{ id: string; context: string; maxContext?: string }> }
    expect(models.find(model => model.id === 'gpt-6-astra')).toMatchObject({ context: '258400', maxContext: '828400' })
    const future = models.find(model => model.id === 'codex-future')!
    expect(future.context).toBe('475000')
    expect(future.maxContext).toBeUndefined()
  })

  test('uses account catalog windows for newly discovered models in the session environment', async () => {
    const model = 'gpt-6.2-sol'
    let catalogRequests = 0
    fetchSpy.mockImplementation((async (input) => {
      if ((OPENAI_CODEX_RELEASE_SOURCES as readonly string[]).includes(String(input))) {
        return Response.json({ version: OPENAI_CODEX_CLIENT_VERSION })
      }
      expect(String(input)).toStartWith(fixtures[0]!.url)
      catalogRequests++
      return Response.json({ models: [
        { slug: model, visibility: 'list', context_window: 500_000, max_context_window: 872_000 },
        { slug: 'gpt-6-sol', visibility: 'list', context_window: 400_000 },
      ] })
    }) as typeof fetch)

    const providers = new ProviderService()
    const path = '/api/models/catalog?provider=openai-official'
    const { models } = await (await handleModelsApi(...request(`${path}&refresh=true`))).json()
    expect(models.find((entry: { id: string }) => entry.id === model).context).toBe('475000')
    const mapping = { ...(await providers.getOfficialProviderModels('openai-official')), main: model }
    const save = (modelContextWindows: Record<string, number>) => handleProvidersApi(...request(
      '/api/providers/openai-official/models', 'PUT', { models: mapping, modelContextWindows },
    ))
    expect((await save({})).status).toBe(200)
    await providers.activateProvider('openai-official')
    const sessionWindows = async () => {
      const env = await providers.getProviderRuntimeEnv('openai-official')
      expect(env.ANTHROPIC_MODEL).toBe(model)
      return JSON.parse(env[MODEL_CONTEXT_WINDOWS_ENV_KEY]!) as Record<string, number>
    }
    expect(await sessionWindows()).toMatchObject({
      [model]: 475_000,
      'gpt-6-sol': 380_000,
      'gpt-5.5': 258_400,
    })
    expect(catalogRequests).toBe(1)

    expect((await save({ [model]: 700_000 })).status).toBe(200)
    expect((await sessionWindows())[model]).toBe(700_000)
    expect((await save({})).status).toBe(200)

    clearOpenAICodexModelCatalogCache()
    expect((await sessionWindows())[model]).toBe(475_000)
    expect(catalogRequests).toBe(2)

    await hahaOpenAIOAuthService.deleteTokens()
    expect((await sessionWindows())[model]).toBeUndefined()
    expect(catalogRequests).toBe(2)
  })

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

  test('launch resolves the current account when login changes during the catalog request', async () => {
    const model = 'gpt-6.2-sol'
    const oldRequestStarted = Promise.withResolvers<void>()
    const oldReply = Promise.withResolvers<Response>()
    const reply = (window: number) => Response.json({ models: [
      { slug: model, visibility: 'list', context_window: window },
    ] })
    const catalogAccounts: Array<string | null> = []
    fetchSpy.mockImplementation((async (input, init) => {
      if ((OPENAI_CODEX_RELEASE_SOURCES as readonly string[]).includes(String(input))) {
        return Response.json({ version: OPENAI_CODEX_CLIENT_VERSION })
      }
      const account = new Headers(init?.headers).get('ChatGPT-Account-Id')
      catalogAccounts.push(account)
      if (account === 'fake-account') {
        oldRequestStarted.resolve()
        return oldReply.promise
      }
      expect(account).toBe('new-account')
      return reply(300_000)
    }) as typeof fetch)

    const launch = new ProviderService().getProviderRuntimeEnv('openai-official')
    await oldRequestStarted.promise
    await hahaOpenAIOAuthService.saveTokens({ accessToken: 'fake-new-token', refreshToken: null, expiresAt: null,
      accountId: 'new-account', email: null })
    oldReply.resolve(reply(500_000))

    expect(JSON.parse((await launch)[MODEL_CONTEXT_WINDOWS_ENV_KEY]!)[model]).toBe(285_000)
    expect(catalogAccounts).toEqual(['fake-account', 'new-account'])
  })

  test.each(['old reply', 'old rejection', 'logout'] as const)(
    'explicit refresh follows a changed ChatGPT login after %s',
    async outcome => {
      const oldRequestStarted = Promise.withResolvers<void>()
      const oldReply = Promise.withResolvers<Response>()
      const model = 'gpt-6.2-sol'
      const reply = (window: number) => Response.json({ models: [
        { slug: model, visibility: 'list', context_window: window },
      ] })
      const catalogAccounts: Array<string | null> = []
      fetchSpy.mockImplementation((async (input, init) => {
        if ((OPENAI_CODEX_RELEASE_SOURCES as readonly string[]).includes(String(input))) {
          return Response.json({ version: OPENAI_CODEX_CLIENT_VERSION })
        }
        const account = new Headers(init?.headers).get('ChatGPT-Account-Id')
        catalogAccounts.push(account)
        if (account === 'fake-account') {
          oldRequestStarted.resolve()
          return oldReply.promise
        }
        expect(account).toBe('new-account')
        return reply(300_000)
      }) as typeof fetch)

      const path = '/api/models/catalog?provider=openai-official'
      const refresh = handleModelsApi(...request(`${path}&refresh=true`))
      await oldRequestStarted.promise
      if (outcome === 'logout') {
        await hahaOpenAIOAuthService.deleteTokens()
      } else {
        await hahaOpenAIOAuthService.saveTokens({ accessToken: 'fake-new-token', refreshToken: null, expiresAt: null,
          accountId: 'new-account', email: null })
      }
      oldReply.resolve(outcome === 'old rejection' ? new Response(null, { status: 401 }) : reply(500_000))

      const response = await refresh
      if (outcome === 'logout') {
        expect(response.status).toBe(502)
        expect(await response.json()).toMatchObject({ error: 'MODEL_CATALOG_REFRESH_FAILED' })
        expect(catalogAccounts).toEqual(['fake-account'])
      } else {
        expect(response.status).toBe(200)
        const { models } = await response.json()
        expect(models).toEqual([expect.objectContaining({ id: model, context: '285000' })])
        expect(await (await handleModelsApi(...request(path))).json()).toEqual({ models })
        expect(catalogAccounts).toEqual(['fake-account', 'new-account'])
      }
    },
  )

  test('grok-official lists default and max context windows, applies account windows and overrides, and enforces catalog caps', async () => {
    const model = 'grok-4.8-preview'
    let catalogRequests = 0
    fetchSpy.mockImplementation((async (input) => {
      expect(String(input)).toBe(fixtures[1]!.url)
      catalogRequests++
      return Response.json({ models: [
        { id: 'grok-4.7', name: 'Grok 4.7', context_window: 500_000, max_context_window: 1_000_000 },
        { id: model, name: 'Grok 4.8 Preview', context_window: 750_000 },
      ] })
    }) as typeof fetch)

    const providers = new ProviderService()
    const path = '/api/models/catalog?provider=grok-official'
    const { models } = await (await handleModelsApi(...request(`${path}&refresh=true`))).json() as {
      models: Array<{ id: string; context: string; maxContext?: string }>
    }
    expect(models.find((entry) => entry.id === 'grok-4.7')).toMatchObject({ context: '500000', maxContext: '1000000' })
    expect(models.find((entry) => entry.id === model)).toMatchObject({ context: '750000' })
    expect(models.find((entry) => entry.id === model)?.maxContext).toBeUndefined()

    const mapping = { ...(await providers.getOfficialProviderModels('grok-official')), main: model }
    const save = (modelContextWindows: Record<string, number>) => handleProvidersApi(...request(
      '/api/providers/grok-official/models', 'PUT', { models: mapping, modelContextWindows },
    ))
    expect((await save({ 'grok-4.7': 1_000_001 })).status).toBe(400)
    expect((await save({ 'grok-4.7': 1_000_000 })).status).toBe(200)
    await providers.activateProvider('grok-official')

    const sessionWindows = async () => {
      const env = await providers.getProviderRuntimeEnv('grok-official')
      expect(env.ANTHROPIC_MODEL).toBe(model)
      return JSON.parse(env[MODEL_CONTEXT_WINDOWS_ENV_KEY]!) as Record<string, number>
    }
    expect(await sessionWindows()).toMatchObject({
      'grok-4.7': 1_000_000,
      [model]: 750_000,
      'grok-4.6': 500_000,
    })
    expect(catalogRequests).toBe(1)

    expect((await save({ [model]: 256_000 })).status).toBe(200)
    expect((await sessionWindows())[model]).toBe(256_000)
    expect((await save({})).status).toBe(200)

    clearGrokModelCatalogCache()
    expect((await sessionWindows())[model]).toBe(750_000)
    expect(catalogRequests).toBe(2)

    await hahaGrokOAuthService.deleteTokens()
    expect((await sessionWindows())[model]).toBeUndefined()
    expect(catalogRequests).toBe(2)
  })
})
