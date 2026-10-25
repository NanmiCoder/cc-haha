import { describe, expect, test } from 'bun:test'
import providerPresets from '../../../src/server/config/providerPresets.json'
import { BUILT_IN_PROVIDER_IDS } from '../../../src/server/types/provider'
import { ApiClient, type FetchAdapter } from './client'
import {
  OFFICIAL_RUNTIME_SOURCES,
  canSetRuntimeEffort,
  contextLabel,
  effortUnavailableReason,
  loadRuntimeDirectory,
  loadRuntimeModels,
  modelDetail,
  runtimeSelection,
  runtimeModelSelection,
  runtimeSourceName,
  savedProviderModels,
  type Provider,
  type ProviderPreset,
} from './runtimeCatalog'

// Runtime-load the production policy without pulling the desktop's type graph into mobile tsc.
const policyModule = new URL(
  '../../../src/server/publicAccess.ts',
  import.meta.url
).href
const { isPublicBusinessPathAllowed } = (await import(policyModule)) as {
  isPublicBusinessPathAllowed(url: URL, method: string): boolean
}
const presetMetadata = providerPresets as ProviderPreset[]
const provider = (
  id: string,
  presetId = 'custom',
  model = 'deepseek-flash'
): Provider => ({
  id,
  name: id,
  presetId,
  apiFormat: 'anthropic',
  baseUrl: 'https://fixture.invalid',
  models: { main: model, haiku: model, sonnet: model, opus: model },
})
const signal = () => new AbortController().signal
function clientFixture(
  options: {
    missing?: string[]
    failAuth?: string[]
    providers?: Provider[]
  } = {}
) {
  const requests: string[] = []
  const available = [
    {
      id: 'server-model',
      name: 'From selected account',
      supportedReasoningEfforts: ['low', 'max'],
      defaultReasoningEffort: 'max',
    },
  ]
  const fetch: FetchAdapter = async (input, init) => {
    const url = new URL(input)
    requests.push(url.pathname + url.search)
    expect(init.method).toBe('GET')
    // These are the real public-access whitelist and built-in identities, not the mobile fixture server.
    expect(isPublicBusinessPathAllowed(url, init.method)).toBe(true)
    let body: unknown
    if (url.pathname === '/api/providers')
      body = {
        providers: options.providers ?? [
          provider('custom-active'),
          provider('inactive'),
        ],
        activeId: 'custom-active',
      }
    else if (url.pathname === '/api/models')
      body = {
        models: [
          {
            id: 'active-model',
            name: 'Active',
            supportedReasoningEfforts: ['medium'],
          },
        ],
        provider: { id: 'custom-active', name: 'Custom' },
      }
    else if (url.pathname === '/api/providers/presets')
      body = { presets: providerPresets }
    else if (url.pathname === '/api/providers/auth-status') {
      const id = url.searchParams.get('providerId')!
      expect([...BUILT_IN_PROVIDER_IDS] as string[]).toContain(id)
      if (options.failAuth?.includes(id)) throw new Error('offline')
      body = { hasAuth: !options.missing?.includes(id), source: 'none' }
    } else if (url.pathname === '/api/models/catalog') {
      expect([...BUILT_IN_PROVIDER_IDS] as string[]).toContain(
        url.searchParams.get('provider')!
      )
      body = { models: available }
    } else throw new Error(`Unexpected endpoint: ${input}`)
    return {
      ok: true,
      status: 200,
      url: input,
      redirected: false,
      text: async () => JSON.stringify(body),
    }
  }
  return {
    client: new ApiClient(
      {
        id: 'fixture',
        name: 'Fixture',
        url: 'https://fixture.invalid',
        auth: 'remote',
      },
      'fake-native-token',
      { fetch }
    ),
    requests,
    available,
  }
}

describe('runtime choices use desktop provider identities and capability contracts', () => {
  test('settings names resolve the actual official identities and saved providers', () => {
    for (const source of OFFICIAL_RUNTIME_SOURCES)
      expect(runtimeSourceName(source.id, [])).toBe(source.name)
    expect(
      runtimeSourceName('saved', [{ id: 'saved', name: 'My DeepSeek' }])
    ).toBe('My DeepSeek')
    expect(runtimeSourceName('unknown', [])).toBe('电脑默认来源')
  })
  test('custom default still exposes all built-in accounts with provider-specific authentication', async () => {
    const fixture = clientFixture()
    const directory = await loadRuntimeDirectory(fixture.client, signal())
    expect(OFFICIAL_RUNTIME_SOURCES.map((source) => source.authId)).toEqual([
      ...BUILT_IN_PROVIDER_IDS,
    ])
    expect(directory.sources.map((source) => source.id)).toEqual([
      null,
      'openai-official',
      'grok-official',
      'deepseek-account',
      'custom-active',
      'inactive',
    ])
    expect(directory.sources.every((source) => source.auth === 'ready')).toBe(
      true
    )
    for (const id of BUILT_IN_PROVIDER_IDS)
      expect(fixture.requests).toContain(
        `/api/providers/auth-status?providerId=${id}`
      )
    expect(fixture.requests).not.toContain('/api/providers/auth-status')
  })

  test('switching back to Claude uses its explicit catalog and null runtime identity', async () => {
    const fixture = clientFixture()
    const directory = await loadRuntimeDirectory(fixture.client, signal())
    const models = await loadRuntimeModels(
      fixture.client,
      directory,
      null,
      signal()
    )
    expect(fixture.requests.at(-1)).toBe(
      '/api/models/catalog?provider=claude-official'
    )
    expect(runtimeSelection(null, models[0], 'max', false)).toEqual({
      providerId: null,
      modelId: 'server-model',
      effortLevel: 'max',
    })
    expect(models).toEqual(fixture.available)
  })

  test('inactive official accounts retain the server model capabilities; current provider uses its own list', async () => {
    const fixture = clientFixture()
    const directory = await loadRuntimeDirectory(fixture.client, signal())
    for (const id of ['openai-official', 'grok-official', 'deepseek-account']) {
      expect(
        await loadRuntimeModels(fixture.client, directory, id, signal())
      ).toEqual(fixture.available)
      expect(fixture.requests.at(-1)).toBe(`/api/models/catalog?provider=${id}`)
    }
    expect(
      await loadRuntimeModels(
        fixture.client,
        directory,
        'custom-active',
        signal()
      )
    ).toEqual(directory.defaults.models)
  })

  test('missing and failed account authorization remain distinct and never fetch a selectable catalog', async () => {
    const fixture = clientFixture({
      missing: ['claude-official', 'openai-official'],
      failAuth: ['grok-official'],
    })
    const directory = await loadRuntimeDirectory(fixture.client, signal())
    expect(directory.sources.find((source) => source.id === null)?.auth).toBe(
      'missing'
    )
    expect(
      directory.sources.find((source) => source.id === 'grok-official')?.auth
    ).toBe('error')
    const before = fixture.requests.length
    for (const id of [
      null,
      'openai-official',
      'grok-official',
      'deleted-provider',
    ])
      expect(
        await loadRuntimeModels(fixture.client, directory, id, signal())
      ).toEqual([])
    expect(fixture.requests).toHaveLength(before)
  })

  test('inactive saved provider resolves real preset capability differences without activating it or requesting an unsupported catalog', async () => {
    const standard = presetMetadata.find(
      (preset) => preset.reasoningProviderKind === 'zhipu_standard_api'
    )!
    expect(standard).toBeDefined()
    const fixture = clientFixture({
      providers: [
        provider('custom-active'),
        provider('standard', standard.id, 'glm-5.3'),
        provider('coding', 'custom', 'glm-5.3'),
      ],
    })
    const directory = await loadRuntimeDirectory(fixture.client, signal())
    const before = fixture.requests.length
    const standardModels = await loadRuntimeModels(
      fixture.client,
      directory,
      'standard',
      signal()
    )
    const codingModels = await loadRuntimeModels(
      fixture.client,
      directory,
      'coding',
      signal()
    )
    expect(standardModels[0].supportedReasoningEfforts).toEqual([
      'low',
      'high',
      'max',
    ])
    expect(codingModels[0].supportedReasoningEfforts).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ])
    expect(standardModels[0].defaultReasoningEffort).toBe('max')
    expect(fixture.requests).toHaveLength(before)
  })

  test('saved mappings retain context variants and apply preset capability overrides instead of treating metadata as models', () => {
    const saved = provider('mapped', 'fixture-preset', 'mapped[1m]')
    saved.model1mSupport = { main: true, opus: false }
    saved.models.haiku = 'small'
    saved.models.sonnet = 'small'
    saved.models.metadata = 'never-a-model'
    const models = savedProviderModels(saved, [
      {
        id: 'fixture-preset',
        defaultEnv: {
          ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES:
            'thinking,effort',
          ANTHROPIC_DEFAULT_HAIKU_MODEL_SUPPORTED_CAPABILITIES: '',
        },
      },
    ])
    expect(models.map((model) => model.id)).toEqual([
      'mapped[1m]',
      'small',
      'mapped',
    ])
    expect(
      models.find((model) => model.id === 'mapped')?.supportedReasoningEfforts
    ).toEqual(['low', 'medium', 'high'])
    expect(
      models.find((model) => model.id === 'small')?.supportedReasoningEfforts
    ).toEqual([])
  })

  test('global OpenAI/Grok effort is omitted while per-session supported effort still applies', () => {
    const model = {
      id: 'test',
      name: 'test',
      supportedReasoningEfforts: ['low', 'max'],
    }
    for (const id of ['openai-official', 'grok-official']) {
      expect(canSetRuntimeEffort(id, true)).toBe(false)
      expect(runtimeSelection(id, model, 'max', true)).toEqual({
        providerId: id,
        modelId: 'test',
      })
      expect(runtimeSelection(id, model, 'max', false).effortLevel).toBe('max')
    }
    for (const id of [null, 'deepseek-account', 'saved'])
      expect(runtimeSelection(id, model, 'max', true).effortLevel).toBe('max')
    expect(runtimeSelection('saved', model, 'unsupported', false)).toEqual({
      providerId: 'saved',
      modelId: 'test',
    })
  })
})

test('model rows show description and a readable context size without inventing either', () => {
  expect(contextLabel('200k')).toBe('200K 上下文')
  expect(contextLabel('1m')).toBe('1M 上下文')
  expect(contextLabel('128000')).toBe('128K 上下文')
  expect(contextLabel('1048576')).toBe('1M 上下文')
  expect(contextLabel('1500000')).toBe('1.5M 上下文')
  expect(contextLabel('')).toBeUndefined()
  expect(contextLabel('unknown')).toBeUndefined()
  expect(contextLabel('0')).toBeUndefined()
  expect(modelDetail({ description: '日常编码', context: '200k' })).toBe(
    '日常编码 · 200K 上下文'
  )
  expect(modelDetail({ description: 'main · sonnet' })).toBe('main · sonnet')
  expect(modelDetail({ context: '' })).toBe('')
})


test('model selection retains only effort supported by the destination model', () => {
  const previous = { providerId: 'provider-a', modelId: 'one', effortLevel: 'high' }
  expect(runtimeModelSelection('provider-b', {
    id: 'two', name: 'Two', supportedReasoningEfforts: ['low', 'high'], defaultReasoningEffort: 'low',
  }, previous)).toEqual({ providerId: 'provider-b', modelId: 'two', effortLevel: 'high' })
  expect(runtimeModelSelection('provider-b', {
    id: 'three', name: 'Three', supportedReasoningEfforts: ['low'], defaultReasoningEffort: 'low',
  }, previous).effortLevel).toBe('low')
  expect(runtimeModelSelection('provider-b', { id: 'plain', name: 'Plain' }, previous).effortLevel).toBeUndefined()
})

test('model changes preserve fast mode only within the same official OpenAI account', () => {
  const previous = { providerId: 'openai-official', modelId: 'one', openAIFastMode: true }
  const model = { id: 'two', name: 'Two' }
  expect(runtimeModelSelection('openai-official', model, previous).openAIFastMode).toBe(true)
  expect(runtimeModelSelection('provider-b', model, previous).openAIFastMode).toBeUndefined()
})

describe('effort control explanation', () => {
  const base = { source: { auth: 'ready' as const }, model: {}, catalogReady: true, canSetEffort: true }
  test('each reason names what the user has to fix', () => {
    expect(effortUnavailableReason({ ...base, source: { auth: 'missing' } })).toContain('请先在电脑上登录')
    expect(effortUnavailableReason({ ...base, source: { auth: 'error' } })).toContain('尚未确认此供应商的授权状态')
    expect(effortUnavailableReason({ ...base, source: undefined })).toContain('供应商已不可用')
    expect(effortUnavailableReason({ ...base, model: undefined })).toContain('当前模型已不在供应商列表')
    expect(effortUnavailableReason({ ...base, canSetEffort: false })).toContain('沿用电脑默认强度')
    expect(effortUnavailableReason(base)).toBe('当前模型没有可调的思考强度。')
  })
})
