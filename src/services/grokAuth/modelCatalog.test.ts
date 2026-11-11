import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import {
  clearGrokModelCatalogCache,
  fetchGrokModelCatalog,
  getGrokModelCatalog,
  GROK_MODELS_ENDPOINT,
} from './modelCatalog.js'
import { GROK_MODEL_CATALOG, getGrokRuntimeModelCatalog } from './models.js'
import { GROK_CLI_VERSION } from './fetch.js'
import { GROK_OAUTH_FILE_ENV_KEY } from './storage.js'

describe('Grok model catalog', () => {
  let tmpDir: string
  let original: string | undefined

  beforeEach(async () => {
    clearGrokModelCatalogCache()
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'grok-models-'))
    original = process.env[GROK_OAUTH_FILE_ENV_KEY]
    process.env[GROK_OAUTH_FILE_ENV_KEY] = path.join(tmpDir, 'tokens.json')
    await fs.writeFile(process.env[GROK_OAUTH_FILE_ENV_KEY], JSON.stringify({
      accessToken: 'access', refreshToken: 'refresh', expiresAt: Date.now() + 3_600_000,
    }))
  })

  afterEach(async () => {
    clearGrokModelCatalogCache()
    if (original === undefined) delete process.env[GROK_OAUTH_FILE_ENV_KEY]
    else process.env[GROK_OAUTH_FILE_ENV_KEY] = original
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  test('uses upstream request ids rather than display ids, accepts metadata variants, and deduplicates', async () => {
    const models = await fetchGrokModelCatalog(async () => Response.json({ data: [
      { id: 'display-id', model: 'grok-next', name: 'Grok Next' },
      { modelId: 'grok-next-fast' },
      { model_id: 'grok-next-small' },
      { _meta: { model: 'grok-next-meta', name: 'Metadata model' } },
      { model: 'grok-next' },
      null,
    ] }))
    expect(models.map(model => model.value)).toEqual(['grok-next', 'grok-next-fast', 'grok-next-small', 'grok-next-meta'])
  })

  test('explicit logout never uses a separately signed-in CLI account', async () => {
    let calls = 0
    await expect(getGrokModelCatalog({
      accessToken: null, forceRefresh: true, throwOnError: true,
      fetchOverride: async () => { calls += 1; return Response.json({ data: [] }) },
    })).rejects.toThrow('token is unavailable')
    expect(calls).toBe(0)
  })

  test('a late background listing cannot replace refreshed runtime metadata', async () => {
    let complete!: (response: Response) => void
    await getGrokModelCatalog({ accessToken: 'desktop',
      fetchOverride: (() => new Promise<Response>(resolve => { complete = resolve })) as typeof fetch })
    // Let the background request enter fetch before the user explicitly refreshes.
    for (let tick = 0; tick < 5; tick += 1) await Promise.resolve()
    await getGrokModelCatalog({ accessToken: 'desktop', forceRefresh: true,
      fetchOverride: async () => Response.json({ models: [{ model: 'grok-fresh', context_window: 1000000 }] }) })
    complete(Response.json({ models: [{ model: 'grok-old', context_window: 500000 }] }))
    await new Promise(resolve => setTimeout(resolve, 5))
    expect(getGrokRuntimeModelCatalog().map(model => [model.value, model.contextWindow])).toEqual([['grok-fresh', 1000000]])
  })

  test('a 200 error envelope is not a successful model listing', async () => {
    await expect(getGrokModelCatalog({ accessToken: 'desktop', forceRefresh: true, throwOnError: true,
      fetchOverride: async () => Response.json({ error: { message: 'temporary failure' } }),
    })).rejects.toThrow('error response')
    expect(getGrokRuntimeModelCatalog()).toEqual(GROK_MODEL_CATALOG)
  })

  test('forces a fresh account listing through the configured proxy and reports failures', async () => {
    let calls = 0
    const fetchOverride = (async (_url, init) => {
      calls += 1
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer desktop-token')
      expect((init as RequestInit & { proxy?: string }).proxy).toBe('http://127.0.0.1:7890')
      expect(init?.redirect).toBe('error')
      return calls === 3 ? new Response(null, { status: 401 }) : Response.json({ models: [{ model: `grok-new-${calls}` }] })
    }) as typeof fetch
    const options = { accessToken: 'desktop-token', fetchOverride, forceRefresh: true, throwOnError: true,
      resolveProxyUrl: async () => 'http://127.0.0.1:7890' }
    expect((await getGrokModelCatalog(options))[0]?.value).toBe('grok-new-1')
    expect((await getGrokModelCatalog(options))[0]?.value).toBe('grok-new-2')
    // The WS consumer also supplies an email key. Explicit credentials remain
    // authoritative so it sees the listing the settings card just refreshed.
    expect((await getGrokModelCatalog({ ...options, forceRefresh: false, accountKey: 'fixture@example.test' }))[0]?.value)
      .toBe('grok-new-2')
    await expect(getGrokModelCatalog(options)).rejects.toThrow('HTTP 401')
    expect((await getGrokModelCatalog({ ...options, forceRefresh: false }))[0]?.value).toBe('grok-new-2')
    expect(calls).toBe(3)
  })

  test('normalizes the official models response and filters non-API entries', async () => {
    let seen: { url: string; headers: Headers } | undefined
    const models = await fetchGrokModelCatalog(async (input, init) => {
      seen = { url: String(input), headers: new Headers(init?.headers) }
      return Response.json({ models: {
        build: {
          info: {
            id: 'grok-build',
            name: 'Grok Build',
            context_window: 500000,
            supported_in_api: false,
          },
        },
        frontier: {
          info: {
            id: 'grok-4.5',
            name: 'Grok 4.5',
            context_window: 500000,
            supported_in_api: true,
            supports_reasoning_effort: true,
            reasoning_effort: 'high',
            reasoning_efforts: [
              { value: 'high', default: true },
              { value: 'medium' },
              { value: 'low' },
            ],
          },
        },
      } })
    })
    expect(seen?.url).toBe(GROK_MODELS_ENDPOINT)
    expect(seen?.headers.get('Authorization')).toBe('Bearer access')
    expect(seen?.headers.get('x-grok-client-version')).toBe(GROK_CLI_VERSION)
    expect(GROK_MODELS_ENDPOINT).toEndWith('/v1/models')
    expect(models.map((model) => model.value)).toEqual(['grok-4.5'])
    expect(models[0]).toMatchObject({
      contextWindow: 500000,
      supportsReasoningEffort: true,
      reasoningEffort: 'high',
      reasoningEfforts: ['high', 'medium', 'low'],
    })
  })

  test('falls back to the static public catalog on failure', async () => {
    const models = await getGrokModelCatalog({
      forceRefresh: true,
      fetchOverride: async () => new Response('nope', { status: 503 }),
    })
    expect(models[0]?.value).toBe('grok-4.7')
    expect(models.some((model) => model.value === 'grok-4.5')).toBe(true)
  })

  test('answers without waiting on an unreachable endpoint', async () => {
    clearGrokModelCatalogCache()
    // `/api/models` sits inside the gate that blocks the desktop first paint,
    // so an endpoint that never answers must not hold the catalog call open.
    const models = await getGrokModelCatalog({
      accountKey: 'unreachable',
      fetchOverride: () => new Promise<Response>(() => {}),
    })
    expect(models).toEqual(GROK_MODEL_CATALOG)
  })

  test('stops re-requesting an endpoint that just failed', async () => {
    clearGrokModelCatalogCache()
    let calls = 0
    const fetchOverride = async () => {
      calls += 1
      return new Response('nope', { status: 503 })
    }

    await getGrokModelCatalog({ accountKey: 'flaky', fetchOverride })
    await new Promise((resolve) => setTimeout(resolve, 5))
    await getGrokModelCatalog({ accountKey: 'flaky', fetchOverride })
    await getGrokModelCatalog({ accountKey: 'flaky', fetchOverride })
    await new Promise((resolve) => setTimeout(resolve, 5))

    expect(calls).toBe(1)
  })
})
