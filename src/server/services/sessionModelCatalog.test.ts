import { describe, expect, test, spyOn, mock } from 'bun:test'
import { buildSessionModelCatalog, resolveSessionRuntimeFromCatalog, listSessionModels } from './sessionModelCatalog.js'
import type { SavedProvider } from '../types/provider.js'
import { ProviderService } from './providerService.js'
import { hahaOAuthService } from './hahaOAuthService.js'
import { hahaOpenAIOAuthService } from './hahaOpenAIOAuthService.js'
import { hahaGrokOAuthService } from './hahaGrokOAuthService.js'
import { hahaDeepSeekOAuthService } from './hahaDeepSeekOAuthService.js'

const provider = (id: string): SavedProvider => ({ id, name: 'Same provider name', presetId: 'custom', apiKey: 'secret-key', baseUrl: 'https://secret.invalid', apiFormat: 'anthropic', models: { main: 'shared-model', opus: 'shared-model', sonnet: 'small-model', haiku: 'small-model' } })
const accounts = { claude: false, openai: false, grok: false, deepseek: false }
const parent = { providerId: 'first', modelId: 'shared-model', effortLevel: 'high' }

describe('session model catalog and strict runtime identity', () => {
  test('catalog is a whitelist projection, deduplicated within each provider only', () => {
    const catalog = buildSessionModelCatalog([provider('first'), provider('second')], accounts, 'first')
    expect(catalog).toHaveLength(4)
    expect(catalog.filter(item => item.modelId === 'shared-model').map(item => item.providerId)).toEqual(['first', 'second'])
    expect(JSON.stringify(catalog)).not.toContain('secret')
    expect(catalog.filter(item => item.isProviderDefault)).toHaveLength(2)
    expect(catalog.filter(item => item.isDefault).map(item => item.providerId)).toEqual(['first'])
    expect(new Set(catalog.map(item => item.providerName)).size).toBe(2)
  })
  test('bare model is rejected when providers share its name; explicit pair is preserved', () => {
    const catalog = buildSessionModelCatalog([provider('first'), provider('second')], accounts, 'first')
    expect(() => resolveSessionRuntimeFromCatalog({ model: 'shared-model' }, parent, catalog)).toThrow('ambiguous')
    expect(resolveSessionRuntimeFromCatalog({ runtime: { providerId: 'second', modelId: 'shared-model' } }, parent, catalog)).toEqual({ providerId: 'second', modelId: 'shared-model' })
  })
  test('provider-only uses its default and drops the old effort; omitted selection inherits the whole pair', () => {
    const catalog = buildSessionModelCatalog([provider('first'), provider('second')], accounts, 'first')
    expect(resolveSessionRuntimeFromCatalog({ providerId: 'second' }, parent, catalog)).toEqual({ providerId: 'second', modelId: 'shared-model' })
    expect(resolveSessionRuntimeFromCatalog({}, parent, catalog)).toEqual(parent)
  })
  test('deleted provider and unsupported effort never fall back', () => {
    const catalog = buildSessionModelCatalog([provider('second')], accounts)
    expect(() => resolveSessionRuntimeFromCatalog({}, parent, catalog)).toThrow('unavailable')
    expect(() => resolveSessionRuntimeFromCatalog({ runtime: { providerId: 'second', modelId: 'shared-model', effortLevel: 'invalid' } }, parent, catalog)).toThrow('effort')
    expect(() => resolveSessionRuntimeFromCatalog({ runtime: parent, model: 'shared-model' }, parent, catalog)).toThrow('not both')
  })
  test('all official accounts are catalogued locally and Claude external ID normalizes to null', () => {
    const catalog = buildSessionModelCatalog([], { claude: true, openai: true, grok: true, deepseek: true })
    expect(new Set(catalog.map(item => item.providerId))).toEqual(new Set([null, 'openai-official', 'grok-official', 'deepseek-account']))
    const claude = catalog.find(item => item.providerId === null && item.isProviderDefault)!
    expect(resolveSessionRuntimeFromCatalog({ providerId: 'claude-official', model: claude.modelId }, parent, catalog).providerId).toBeNull()
    expect(() => resolveSessionRuntimeFromCatalog({ runtime: { providerId: null, modelId: claude.modelId, openAIFastMode: true } }, parent, catalog)).toThrow('Fast mode')
  })
  test('provider context variants remain distinct catalog choices', () => {
    const configured = provider('first')
    configured.model1mSupport = { main: true, opus: false, sonnet: false, haiku: false, fable: false }
    const catalog = buildSessionModelCatalog([configured], accounts)
    expect(catalog.map(item => item.modelId)).toContain('shared-model[1m]')
    expect(catalog.map(item => item.modelId)).toContain('shared-model')
  })
})

test('inherited stale effort is normalized, while an explicit unsupported effort is rejected', () => {
  const catalog = [{ providerId: 'first', providerName: 'first', modelId: 'fixture-model', modelName: 'fixture-model', isDefault: true, supportedEfforts: [] }]
  const inherited = { providerId: 'first', modelId: 'fixture-model', effortLevel: 'high' }
  expect(resolveSessionRuntimeFromCatalog({}, inherited, catalog)).toEqual({ providerId: 'first', modelId: 'fixture-model' })
  expect(() => resolveSessionRuntimeFromCatalog({ runtime: inherited }, inherited, catalog)).toThrow('effort')
})

test('legacy parent slot aliases resolve only within their selected provider', () => {
  const catalog = buildSessionModelCatalog([provider('first'), { ...provider('second'), models: { ...provider('second').models, sonnet: 'different-small' } }], accounts)
  expect(resolveSessionRuntimeFromCatalog({}, { providerId: 'second', modelId: 'sonnet' }, catalog)).toEqual({ providerId: 'second', modelId: 'different-small' })
  expect(() => resolveSessionRuntimeFromCatalog({ model: 'sonnet' }, parent, catalog)).toThrow('ambiguous')
})

test('live directory stays local and includes configured official defaults without leaking tokens', async () => {
  try {
    const fetch = spyOn(globalThis, 'fetch').mockRejectedValue(new Error('No network allowed'))
    spyOn(ProviderService.prototype, 'listProviders').mockResolvedValue({ providers: [provider('saved')], activeId: 'openai-official', providerOrder: [] })
    spyOn(ProviderService.prototype, 'getOfficialProviderModels').mockResolvedValue({ main: 'configured-official', opus: 'configured-official', sonnet: 'small', haiku: 'small' })
    for (const service of [hahaOAuthService, hahaOpenAIOAuthService, hahaGrokOAuthService, hahaDeepSeekOAuthService]) spyOn(service, 'loadTokens').mockResolvedValue({ accessToken: 'private-token' } as never)
    const result = await listSessionModels()
    expect(fetch).not.toHaveBeenCalled()
    expect(result.find(item => item.providerId === 'openai-official' && item.isDefault)?.modelId).toBe('configured-official')
    expect(result.filter(item => item.isDefault)).toHaveLength(1)
    expect(JSON.stringify(result)).not.toContain('private-token')
    expect(JSON.stringify(result)).not.toContain('secret-key')
  } finally { mock.restore() }
})
