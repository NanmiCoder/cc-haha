import { afterEach, describe, expect, test } from 'bun:test'
import {
  clearDeepSeekAccountModelCatalogCache,
  DEEPSEEK_ACCOUNT_MODEL_CATALOG,
  DEEPSEEK_MODELS_ENDPOINT,
  fetchDeepSeekAccountModelCatalog,
  getDeepSeekAccountModelCatalog,
  parseDeepSeekModelListing,
} from './modelCatalog.js'

// Shape of the account `GET https://api.deepseek.com/models` answer.
const ACCOUNT_LISTING = {
  object: 'list',
  data: [
    {
      id: 'deepseek-flash',
      object: 'model',
      owned_by: 'deepseek',
      name: 'DeepSeek-V4.1-Flash',
      context_window: 1048576,
      max_output_tokens: 393216,
      input_modalities: ['text', 'image'],
      output_modalities: ['text'],
      effort: { supported_levels: ['low', 'high', 'max'], default_level: 'high' },
      api_capabilities: { anthropic_messages: { system_prompt_update: 'in-history' } },
    },
    {
      id: 'deepseek-v4-pro',
      object: 'model',
      owned_by: 'deepseek',
      name: 'DeepSeek-V4-Pro',
      context_window: 1048576,
      max_output_tokens: 393216,
      input_modalities: ['text'],
      output_modalities: ['text'],
      api_capabilities: { anthropic_messages: { system_prompt_update: 'leading-only' } },
    },
  ],
}

function listingFetch(
  body: unknown,
  seen: Array<{ url: string; init?: RequestInit }> = [],
  status = 200,
): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    seen.push({ url: String(input), init })
    return Response.json(body, { status })
  }) as typeof fetch
}

afterEach(() => {
  clearDeepSeekAccountModelCatalogCache()
})

describe('DeepSeek account model catalog', () => {
  test('reads the account listing with the account token header and no redirects', async () => {
    const seen: Array<{ url: string; init?: RequestInit }> = []
    const models = await fetchDeepSeekAccountModelCatalog('account-token', listingFetch(ACCOUNT_LISTING, seen))

    expect(models).toEqual([
      {
        id: 'deepseek-flash',
        name: 'DeepSeek-V4.1-Flash',
        contextWindow: 1048576,
        maxOutputTokens: 393216,
        inputModalities: ['text', 'image'],
      },
      {
        id: 'deepseek-v4-pro',
        name: 'DeepSeek-V4-Pro',
        contextWindow: 1048576,
        maxOutputTokens: 393216,
        inputModalities: ['text'],
      },
    ])
    expect(seen).toHaveLength(1)
    expect(seen[0]!.url).toBe(DEEPSEEK_MODELS_ENDPOINT)
    expect(DEEPSEEK_MODELS_ENDPOINT).toBe('https://api.deepseek.com/models')
    const headers = new Headers(seen[0]!.init?.headers)
    expect(headers.get('x-dsh-auth-token')).toBe('account-token')
    expect(headers.has('authorization')).toBe(false)
    expect(seen[0]!.init?.redirect).toBe('error')
  })

  test('sends the listing through the app network proxy the other account requests use', async () => {
    const seen: Array<{ url: string; init?: RequestInit }> = []
    await getDeepSeekAccountModelCatalog({
      token: 'account-token',
      fetchOverride: listingFetch(ACCOUNT_LISTING, seen),
      forceRefresh: true,
      resolveProxyUrl: async () => 'http://127.0.0.1:7890',
    })

    expect((seen[0]!.init as RequestInit & { proxy?: string }).proxy).toBe('http://127.0.0.1:7890')
  })

  test('falls back to the bundled catalog when the proxy cannot be resolved', async () => {
    const seen: Array<{ url: string; init?: RequestInit }> = []
    const models = await getDeepSeekAccountModelCatalog({
      token: 'account-token',
      fetchOverride: listingFetch(ACCOUNT_LISTING, seen),
      forceRefresh: true,
      resolveProxyUrl: async () => {
        throw new Error('system proxy bridge unavailable')
      },
    })

    expect(models).toBe(DEEPSEEK_ACCOUNT_MODEL_CATALOG)
    expect(seen).toHaveLength(0)
  })

  test('drops repeats and models the Messages transport cannot drive', () => {
    const models = parseDeepSeekModelListing({
      data: [
        { id: 'deepseek-flash', name: 'DeepSeek-V4.1-Flash', api_capabilities: { anthropic_messages: {} } },
        { id: 'deepseek-flash', name: 'Repeated', api_capabilities: { anthropic_messages: {} } },
        { id: 'chat-only', name: 'No Messages API', api_capabilities: { openai_chat: {} } },
        {
          id: 'image-out',
          api_capabilities: { anthropic_messages: {} },
          output_modalities: ['image'],
        },
        {
          id: 'needs-newer-client',
          api_capabilities: { anthropic_messages: {} },
          client_requirements: { 'deepseek-harness': { min_version: '99.0.0' } },
        },
        {
          id: 'old-enough-client',
          api_capabilities: { anthropic_messages: {} },
          client_requirements: { 'deepseek-harness': { min_version: '0.1.0' }, other: { min_version: '99.0.0' } },
        },
        { name: 'no id', api_capabilities: { anthropic_messages: {} } },
      ],
    })

    expect(models.map((model) => model.id)).toEqual(['deepseek-flash', 'old-enough-client'])
    expect(models[0]).toEqual({ id: 'deepseek-flash', name: 'DeepSeek-V4.1-Flash', inputModalities: ['text'] })
    expect(models[1]!.name).toBe('old-enough-client')
  })

  test('rejects a listing without a usable model', () => {
    expect(() => parseDeepSeekModelListing({ models: [] })).toThrow('no data array')
    expect(() => parseDeepSeekModelListing({ data: [{ id: 'chat-only' }] })).toThrow('no usable model')
  })

  test('serves the bundled catalog, which matches DeepSeek Harness, while signed out', async () => {
    const seen: Array<{ url: string; init?: RequestInit }> = []
    const models = await getDeepSeekAccountModelCatalog({
      token: null,
      fetchOverride: listingFetch(ACCOUNT_LISTING, seen),
      forceRefresh: true,
    })

    expect(models).toBe(DEEPSEEK_ACCOUNT_MODEL_CATALOG)
    expect(models.map((model) => [model.id, model.name])).toEqual([
      ['deepseek-flash', 'DeepSeek-V4.1-Flash'],
      ['deepseek-v4-pro', 'DeepSeek-V4-Pro'],
    ])
    expect(seen).toHaveLength(0)
  })

  test('keeps the last listing of an account when a refresh fails, but never shares it with another account', async () => {
    const listed = await getDeepSeekAccountModelCatalog({
      token: 'account-a',
      fetchOverride: listingFetch({ data: [{ id: 'deepseek-next', api_capabilities: { anthropic_messages: {} } }] }),
      forceRefresh: true,
    })
    expect(listed.map((model) => model.id)).toEqual(['deepseek-next'])

    const failing = listingFetch({ error: 'unavailable' }, [], 503)
    const kept = await getDeepSeekAccountModelCatalog({ token: 'account-a', fetchOverride: failing, forceRefresh: true })
    expect(kept.map((model) => model.id)).toEqual(['deepseek-next'])

    const otherAccount = await getDeepSeekAccountModelCatalog({ token: 'account-b', fetchOverride: failing, forceRefresh: true })
    expect(otherAccount).toBe(DEEPSEEK_ACCOUNT_MODEL_CATALOG)
  })
})
