import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { OPENAI_CODEX_CLIENT_VERSION } from './client.js'
import {
  clearOpenAICodexModelCatalogCache,
  fetchOpenAICodexModelCatalog,
  getOpenAICodexModelCatalog,
  getOpenAIRuntimeModelCatalog,
} from './modelCatalog.js'
import { OPENAI_CODEX_MODEL_CATALOG } from './models.js'
import { clearOpenAIOAuthTokenCache } from './storage.js'

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
    const models = await fetchOpenAICodexModelCatalog(
      async (input, init) => {
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
      },
      {
        accessToken: 'desktop-catalog-access-token',
        accountId: 'acct_desktop',
      },
    )

    expect(OPENAI_CODEX_CLIENT_VERSION).toBe('0.153.4')
    expect(new URL(requestUrl).searchParams.get('client_version')).toBe(
      OPENAI_CODEX_CLIENT_VERSION,
    )
    expect(requestHeaders.get('Authorization')).toBe('Bearer desktop-catalog-access-token')
    expect(requestHeaders.get('ChatGPT-Account-Id')).toBe('acct_desktop')
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

  test('does not restore the runtime catalog after an in-flight refresh is cleared', async () => {
    let resolveFetch: ((response: Response) => void) | undefined
    const request = getOpenAICodexModelCatalog({
      tokens: { accessToken: 'old-account-token', accountId: 'acct_old' },
      forceRefresh: true,
      fetchOverride: () => new Promise<Response>((resolve) => {
        resolveFetch = resolve
      }),
    })
    while (!resolveFetch) await Promise.resolve()

    clearOpenAICodexModelCatalogCache()
    resolveFetch(Response.json({
      models: [{
        slug: 'old-account-only',
        display_name: 'Old Account Only',
        visibility: 'list',
      }],
    }))
    expect((await request).map(model => model.value)).toEqual(['old-account-only'])
    expect(getOpenAIRuntimeModelCatalog()).toEqual(OPENAI_CODEX_MODEL_CATALOG)
  })

  test('does not let an old forced request overwrite a different account after a normal refresh', async () => {
    let finishOld!: (response: Response) => void
    const oldRequest = getOpenAICodexModelCatalog({
      tokens: { accessToken: 'old-token', accountId: 'account-a' },
      forceRefresh: true,
      fetchOverride: () => new Promise(resolve => { finishOld = resolve }),
    })
    await Promise.resolve()

    const currentOptions = {
      tokens: { accessToken: 'current-token', accountId: 'account-b' },
      fetchOverride: async () => Response.json({
        models: [{ slug: 'account-b-model', visibility: 'list' }],
      }),
    }
    await getOpenAICodexModelCatalog(currentOptions)
    await new Promise(resolve => setTimeout(resolve, 5))
    expect((await getOpenAICodexModelCatalog(currentOptions)).map(model => model.value))
      .toEqual(['account-b-model'])

    finishOld(Response.json({ models: [{ slug: 'account-a-model', visibility: 'list' }] }))
    await oldRequest
    expect(getOpenAIRuntimeModelCatalog().map(model => model.value)).toEqual(['account-b-model'])
    expect((await getOpenAICodexModelCatalog(currentOptions)).map(model => model.value))
      .toEqual(['account-b-model'])
  })

  test('updates runtime metadata when the background catalog finishes without another read', async () => {
    await getOpenAICodexModelCatalog({
      tokens: { accessToken: 'background-token', accountId: 'background-account' },
      fetchOverride: async () => Response.json({
        models: [{ slug: 'background-model', visibility: 'list', context_window: 400_000 }],
      }),
    })
    await new Promise(resolve => setTimeout(resolve, 5))
    expect(getOpenAIRuntimeModelCatalog()).toEqual([
      expect.objectContaining({ value: 'background-model', contextWindow: 380_000 }),
    ])
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

  test('falls back to the bundled GPT-5.6 catalog when the endpoint fails', async () => {
    const models = await getOpenAICodexModelCatalog({
      forceRefresh: true,
      fetchOverride: async () => new Response('unavailable', { status: 503 }),
    })

    expect(models.slice(0, 3).map((model) => model.value)).toEqual([
      'gpt-5.6-sol',
      'gpt-5.6-terra',
      'gpt-5.6-luna',
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
    const fetchOverride = async () => {
      calls += 1
      return new Response('unavailable', { status: 503 })
    }

    await getOpenAICodexModelCatalog({ fetchOverride })
    await new Promise((resolve) => setTimeout(resolve, 5))
    await getOpenAICodexModelCatalog({ fetchOverride })
    await getOpenAICodexModelCatalog({ fetchOverride })
    await new Promise((resolve) => setTimeout(resolve, 5))

    expect(calls).toBe(1)
  })
})
