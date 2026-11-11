import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { OPENAI_CODEX_CLIENT_VERSION } from './client.js'
import {
  OPENAI_CODEX_RELEASE_SOURCES,
  resolveOpenAICodexClientVersion,
} from './clientVersion.js'
import {
  clearOpenAICodexModelCatalogCache,
  fetchOpenAICodexModelCatalog,
  getOpenAICodexModelCatalog,
} from './modelCatalog.js'
import { OPENAI_CODEX_MODEL_CATALOG } from './models.js'
import { clearOpenAIOAuthTokenCache } from './storage.js'
import { order } from '../../utils/semver.js'

const isReleaseLookup = (input: Parameters<typeof fetch>[0]) =>
  (OPENAI_CODEX_RELEASE_SOURCES as readonly string[]).includes(String(input))

/** A stable release `minors` minor versions after the pinned one. */
function releaseAfterPinned(minors: number): string {
  const [major, minor] = OPENAI_CODEX_CLIENT_VERSION.split('.').map(Number)
  return `${major}.${minor! + minors}.0`
}

describe('OpenAI Codex model catalog', () => {
  let tmpDir: string
  let originalTokenFile: string | undefined

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'openai-model-catalog-'))
    originalTokenFile = process.env.OPENAI_CODEX_OAUTH_FILE
    process.env.OPENAI_CODEX_OAUTH_FILE = path.join(tmpDir, 'openai-oauth.json')
    await fs.writeFile(
      process.env.OPENAI_CODEX_OAUTH_FILE,
      JSON.stringify({
        accessToken: 'catalog-access-token',
        refreshToken: 'catalog-refresh-token',
        expiresAt: Date.now() + 60 * 60_000,
        accountId: 'acct_catalog',
      }),
      'utf8',
    )
    clearOpenAIOAuthTokenCache()
    clearOpenAICodexModelCatalogCache()
  })

  afterEach(async () => {
    if (originalTokenFile === undefined) delete process.env.OPENAI_CODEX_OAUTH_FILE
    else process.env.OPENAI_CODEX_OAUTH_FILE = originalTokenFile
    clearOpenAIOAuthTokenCache()
    clearOpenAICodexModelCatalogCache()
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  test('loads the account model list with auth and removes unsupported product-only efforts', async () => {
    let requestUrl = ''
    let requestHeaders = new Headers()
    const models = await fetchOpenAICodexModelCatalog(async (input, init) => {
      requestUrl = String(input)
      requestHeaders = new Headers(init?.headers)
      return Response.json({
        models: [
          {
            slug: 'gpt-next-account-only',
            display_name: 'GPT Next',
            description: 'Account-scoped model.',
            default_reasoning_level: 'xhigh',
            supported_reasoning_levels: [
              { effort: 'low' },
              { effort: 'xhigh' },
              { effort: 'ultra' },
            ],
            visibility: 'list',
            supported_in_api: false,
            context_window: 400_000,
            effective_context_window_percent: 90,
          },
          {
            slug: 'hidden-model',
            visibility: 'hide',
            supported_in_api: true,
            supported_reasoning_levels: [],
          },
        ],
      })
    })

    expect(new URL(requestUrl).searchParams.get('client_version')).toBe(
      OPENAI_CODEX_CLIENT_VERSION,
    )
    expect(requestHeaders.get('Authorization')).toBe('Bearer catalog-access-token')
    expect(requestHeaders.get('ChatGPT-Account-Id')).toBe('acct_catalog')
    expect(requestHeaders.get('originator')).toBe('codex_cli_rs')
    expect(models).toEqual([
      {
        value: 'gpt-next-account-only',
        label: 'GPT Next',
        description: 'Account-scoped model',
        defaultReasoningEffort: 'xhigh',
        supportedReasoningEfforts: ['low', 'xhigh'],
        contextWindow: 360_000,
      },
    ])
  })

  test('reads the highest window a model allows, and keeps the bundled one when the account omits it', async () => {
    const models = await fetchOpenAICodexModelCatalog(async () => Response.json({
      models: [
        { slug: 'gpt-next-account-only', visibility: 'list', context_window: 400_000, max_context_window: 900_000, effective_context_window_percent: 90 },
        { slug: 'gpt-6-astra', visibility: 'list', context_window: 272_000 },
        { slug: 'gpt-unlisted-limit', visibility: 'list', context_window: 272_000 },
      ],
    }))
    const byValue = Object.fromEntries(models.map(model => [model.value, model]))

    // The account's own number, scaled by the same percent as the default window.
    expect(byValue['gpt-next-account-only']!.maxContextWindow).toBe(810_000)
    // Omitted by the account: the bundled GPT-6 limit (872,000 x 95%).
    expect(byValue['gpt-6-astra']!.maxContextWindow).toBe(828_400)
    // Omitted and unknown to us: no limit is claimed.
    expect(byValue['gpt-unlisted-limit']!.maxContextWindow).toBeUndefined()
  })

  // Live behavior: the endpoint lists a model only from its rollout gate, which
  // for GPT-6.1 is client_version 0.159.0 though the entries report 0.153.0.
  const gatedModelsEndpoint = (gates: Record<string, string>, seen: { versions: string[]; userAgents: (string | null)[] }) =>
    (async (input, init) => {
      if (isReleaseLookup(input)) throw new Error('release sources are unreachable')
      const version = new URL(String(input)).searchParams.get('client_version') ?? '0.0.0'
      seen.versions.push(version)
      seen.userAgents.push(new Headers(init?.headers).get('User-Agent'))
      return Response.json({
        models: Object.entries(gates)
          .filter(([, gate]) => order(version, gate) >= 0)
          .map(([slug]) => ({ slug, visibility: 'list', minimal_client_version: '0.153.0' })),
      })
    }) as typeof fetch

  test('the pinned version alone still sees the GPT-6.1 models', async () => {
    const seen = { versions: [] as string[], userAgents: [] as (string | null)[] }
    const models = await getOpenAICodexModelCatalog({
      tokens: { accessToken: 'desktop-token', accountId: 'desktop-account' },
      forceRefresh: true,
      throwOnError: true,
      fetchOverride: gatedModelsEndpoint(
        { 'gpt-6.1-sol': '0.159.0', 'gpt-6.1-terra': '0.159.0', 'gpt-6-sol': '0.155.0' },
        seen,
      ),
    })

    expect(models.map(model => model.value)).toEqual(['gpt-6.1-sol', 'gpt-6.1-terra', 'gpt-6-sol'])
    expect(seen.versions).toEqual([OPENAI_CODEX_CLIENT_VERSION])
    expect(seen.userAgents).toEqual([`codex-cli/${OPENAI_CODEX_CLIENT_VERSION}`])
  })

  test('an explicit refresh reports the latest Codex release so newly gated models appear', async () => {
    const seen = { versions: [] as string[], userAgents: [] as (string | null)[] }
    const latest = releaseAfterPinned(5)
    const listModels = gatedModelsEndpoint({ 'gpt-next': latest, 'gpt-6-sol': '0.155.0' }, seen)
    const releaseProxies: (string | undefined)[] = []
    const fetchOverride = (async (input, init) => {
      if (!isReleaseLookup(input)) return listModels(input, init)
      releaseProxies.push((init as RequestInit & { proxy?: string }).proxy)
      // The mirror lags npm by a release.
      return Response.json({ version: String(input).includes('npmmirror') ? releaseAfterPinned(4) : latest })
    }) as typeof fetch
    const tokens = { accessToken: 'desktop-token', accountId: 'desktop-account' }
    // A release looked up earlier must not stand in for the refresh's own lookup.
    await resolveOpenAICodexClientVersion({
      fetchOverride: (async () => Response.json({ version: releaseAfterPinned(1) })) as typeof fetch,
    })

    const models = await getOpenAICodexModelCatalog({
      tokens,
      forceRefresh: true,
      throwOnError: true,
      resolveProxyUrl: async () => 'http://127.0.0.1:7890',
      fetchOverride,
    })

    expect(models.map(model => model.value)).toEqual(['gpt-next', 'gpt-6-sol'])
    expect(seen.versions).toEqual([latest])
    expect(seen.userAgents).toEqual([`codex-cli/${latest}`])
    expect(releaseProxies).toEqual(['http://127.0.0.1:7890', 'http://127.0.0.1:7890'])
  })

  test('uses explicitly supplied credentials instead of CLI storage', async () => {
    const models = await getOpenAICodexModelCatalog({
      tokens: { accessToken: 'desktop-token', accountId: 'desktop-account' },
      forceRefresh: true,
      fetchOverride: async (_input, init) => {
        const headers = new Headers(init?.headers)
        expect(headers.get('Authorization')).toBe('Bearer desktop-token')
        expect(headers.get('ChatGPT-Account-Id')).toBe('desktop-account')
        return Response.json({ models: [{ slug: 'gpt-6-astra', visibility: 'list' }] })
      },
    })
    expect(models.map(model => model.value)).toEqual(['gpt-6-astra'])
  })

  test('explicit logout never requests a catalog with CLI credentials', async () => {
    let requests = 0
    const models = await getOpenAICodexModelCatalog({
      tokens: null,
      forceRefresh: true,
      fetchOverride: async () => {
        requests += 1
        return Response.json({ models: [{ slug: 'cli-only', visibility: 'list' }] })
      },
    })
    expect(requests).toBe(0)
    expect(models).toEqual(OPENAI_CODEX_MODEL_CATALOG)
  })

  test('forces a new listing through the configured proxy and retains it after a reported failure', async () => {
    let calls = 0
    const options = {
      tokens: { accessToken: 'desktop-token', accountId: 'same-account' },
      forceRefresh: true, throwOnError: true,
      resolveProxyUrl: async () => 'http://127.0.0.1:7890',
      fetchOverride: (async (url, init) => {
        expect((init as RequestInit & { proxy?: string }).proxy).toBe('http://127.0.0.1:7890')
        if (isReleaseLookup(url)) return Response.json({ version: OPENAI_CODEX_CLIENT_VERSION })
        calls += 1
        expect(init?.redirect).toBe('error')
        return calls === 3 ? new Response(null, { status: 503 })
          : Response.json({ models: [null, { slug: `codex-new-${calls}`, visibility: 'list' }] })
      }) as typeof fetch,
    }
    expect((await getOpenAICodexModelCatalog(options))[0]?.value).toBe('codex-new-1')
    expect((await getOpenAICodexModelCatalog(options))[0]?.value).toBe('codex-new-2')
    await expect(getOpenAICodexModelCatalog(options)).rejects.toThrow('HTTP 503')
    expect((await getOpenAICodexModelCatalog({ ...options, forceRefresh: false }))[0]?.value).toBe('codex-new-2')
    expect(calls).toBe(3)
  })

  test('falls back to the bundled Codex catalog when the endpoint fails', async () => {
    const models = await getOpenAICodexModelCatalog({
      forceRefresh: true,
      fetchOverride: async () => new Response('unavailable', { status: 503 }),
    })

    expect(models.slice(0, 3).map((model) => model.value)).toEqual([
      'gpt-6-astra',
      'gpt-6-sol',
      'gpt-6-luna',
    ])
  })

  test('answers without waiting on an unreachable endpoint', async () => {
    // `/api/models` sits inside the gate that blocks the desktop first paint,
    // so an endpoint that never answers must not hold the catalog call open.
    const models = await getOpenAICodexModelCatalog({
      fetchOverride: () => new Promise<Response>(() => {}),
    })

    expect(models).toEqual(OPENAI_CODEX_MODEL_CATALOG)
  })

  test('stops re-requesting an endpoint that just failed', async () => {
    let calls = 0
    let releaseLookups = 0
    const fetchOverride = async (input: Parameters<typeof fetch>[0]) => {
      if (isReleaseLookup(input)) {
        releaseLookups += 1
        return Response.json({ version: OPENAI_CODEX_CLIENT_VERSION })
      }
      calls += 1
      return new Response('unavailable', { status: 503 })
    }

    await getOpenAICodexModelCatalog({ fetchOverride })
    await new Promise((resolve) => setTimeout(resolve, 5))
    await getOpenAICodexModelCatalog({ fetchOverride })
    await getOpenAICodexModelCatalog({ fetchOverride })
    await new Promise((resolve) => setTimeout(resolve, 5))

    expect(calls).toBe(1)
    expect(releaseLookups).toBe(OPENAI_CODEX_RELEASE_SOURCES.length)
  })
})
