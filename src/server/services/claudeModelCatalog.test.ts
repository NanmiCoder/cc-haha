import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getClaudeCodeUserAgent } from '../../utils/userAgent.js'
import { hahaOAuthService } from './hahaOAuthService.js'
import {
  CLAUDE_MODEL_CATALOG,
  CLAUDE_MODELS_ENDPOINT,
  clearDesktopClaudeModelCatalogCache,
  getDesktopClaudeModelCatalog,
} from './claudeModelCatalog.js'

const ENV_KEYS = [
  'HOME', 'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_OAUTH_TOKEN',
  'CC_HAHA_SYSTEM_PROXY_URL', 'CC_HAHA_SYSTEM_PROXY_ERROR', 'NO_PROXY', 'no_proxy',
] as const

type FetchCall = { url: URL; init: RequestInit | undefined }

describe('desktop Claude model catalog', () => {
  let directory: string
  let originalEnv: Record<string, string | undefined>
  let originalFetch: typeof fetch
  let calls: FetchCall[]

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'desktop-claude-models-'))
    originalEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]))
    process.env.HOME = directory
    process.env.CLAUDE_CONFIG_DIR = directory
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'other-cli-token'
    delete process.env.CC_HAHA_SYSTEM_PROXY_URL
    delete process.env.CC_HAHA_SYSTEM_PROXY_ERROR
    delete process.env.NO_PROXY
    delete process.env.no_proxy
    await writeFile(join(directory, '.credentials.json'), JSON.stringify({
      claudeAiOauth: { accessToken: 'other-cli-token', expiresAt: Date.now() + 3_600_000 },
    }))
    await writeFile(join(directory, 'settings.json'), JSON.stringify({
      network: { proxy: { mode: 'direct', url: '' } },
    }))
    originalFetch = globalThis.fetch
    globalThis.fetch = (async () => { throw new Error('Unexpected non-mock fetch') }) as typeof fetch
    calls = []
    clearDesktopClaudeModelCatalogCache()
  })

  afterEach(async () => {
    clearDesktopClaudeModelCatalogCache()
    globalThis.fetch = originalFetch
    for (const key of ENV_KEYS) {
      if (originalEnv[key] === undefined) delete process.env[key]
      else process.env[key] = originalEnv[key]
    }
    await rm(directory, { recursive: true, force: true })
  })

  const saveAccount = (name = 'first') => hahaOAuthService.saveTokens({
    accessToken: `desktop-${name}`,
    refreshToken: null,
    expiresAt: null,
    scopes: ['user:inference'],
    subscriptionType: 'pro',
  })

  const mockFetch = (handler: (call: FetchCall) => Response | Promise<Response>): typeof fetch => (
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const call = { url: new URL(input instanceof Request ? input.url : String(input)), init }
      calls.push(call)
      return handler(call)
    }
  ) as typeof fetch

  const refresh = (fetchOverride: typeof fetch) => getDesktopClaudeModelCatalog({
    fetchOverride, forceRefresh: true, throwOnError: true,
  })

  test('discovers new IDs across pages with desktop OAuth, deduplication and upstream metadata', async () => {
    await saveAccount()
    const fetchOverride = mockFetch(({ url }) => url.searchParams.has('after_id')
      ? Response.json({
        data: [
          { id: 'claude-future', display_name: 'Duplicate' },
          { id: 'claude-later', display_name: 'Claude Later' },
          { id: 'claude-retired', lifecycle: 'retired' },
        ], has_more: false, last_id: 'claude-later',
      })
      : Response.json({
        data: [null, { id: '' }, { id: ' claude-future ', display_name: 'Claude Future',
          max_input_tokens: 2_000_000,
          capabilities: { effort: { supported: true, low: { supported: true }, high: { supported: true } } },
        }], has_more: true, last_id: 'claude-future',
      }))

    const result = await refresh(fetchOverride)
    expect(result).toEqual([
      { id: 'claude-future', name: 'Claude Future', description: '', context: '2000000',
        supportedReasoningEfforts: ['low', 'high'], defaultReasoningEffort: 'low' },
      { id: 'claude-later', name: 'Claude Later', description: '', context: '' },
    ])
    expect(calls).toHaveLength(2)
    expect(calls[0]?.url.origin + calls[0]?.url.pathname).toBe(CLAUDE_MODELS_ENDPOINT)
    expect(calls[0]?.url.searchParams.get('limit')).toBe('1000')
    expect(calls[0]?.url.searchParams.has('after_id')).toBe(false)
    expect(calls[1]?.url.searchParams.get('after_id')).toBe('claude-future')
    for (const call of calls) {
      const headers = new Headers(call.init?.headers)
      expect(headers.get('Authorization')).toBe('Bearer desktop-first')
      expect(headers.has('x-api-key')).toBe(false)
      expect(headers.get('anthropic-version')).toBe('2023-06-01')
      expect(headers.get('anthropic-beta')).toBe('claude-code-20250219,oauth-2025-04-20')
      expect(headers.get('User-Agent')).toBe(getClaudeCodeUserAgent())
      expect(call.init?.redirect).toBe('error')
      expect(call.init?.signal).toBeInstanceOf(AbortSignal)
    }
    expect(calls[1]?.init?.signal).toBe(calls[0]?.init?.signal)
    expect(await getDesktopClaudeModelCatalog({ fetchOverride })).toEqual(result)
    expect(calls).toHaveLength(2)
  })

  test('keeps bundled metadata when absent upstream and respects explicit lack of effort support', async () => {
    await saveAccount()
    const result = await refresh(mockFetch(() => Response.json({ data: [
      { id: 'claude-opus-5-5' },
      { id: 'claude-sonnet-5-5', capabilities: { effort: { supported: false } } },
    ] })))
    expect(result[0]).toEqual(CLAUDE_MODEL_CATALOG.find(model => model.id === 'claude-opus-5-5'))
    expect(result[1]?.supportedReasoningEfforts).toEqual([])
    expect(result[1]?.defaultReasoningEffort).toBeUndefined()
  })

  test('isolates account switches and logout and never uses available CLI credentials', async () => {
    const fetchOverride = mockFetch(({ init }) => Response.json({ data: [{
      id: new Headers(init?.headers).get('Authorization') === 'Bearer desktop-first' ? 'claude-first' : 'claude-second',
    }] }))
    expect(await getDesktopClaudeModelCatalog({ fetchOverride })).toEqual(CLAUDE_MODEL_CATALOG)
    await expect(refresh(fetchOverride)).rejects.toThrow('Claude OAuth token is unavailable')
    expect(calls).toHaveLength(0)

    await saveAccount('first')
    expect((await refresh(fetchOverride)).map(model => model.id)).toEqual(['claude-first'])
    await saveAccount('second')
    expect((await refresh(fetchOverride)).map(model => model.id)).toEqual(['claude-second'])
    await hahaOAuthService.deleteTokens()
    expect(await getDesktopClaudeModelCatalog({ fetchOverride })).toEqual(CLAUDE_MODEL_CATALOG)
    await expect(refresh(fetchOverride)).rejects.toThrow('Claude OAuth token is unavailable')
    expect(calls).toHaveLength(2)
  })

  test('uses app network proxy configuration for listing requests', async () => {
    await saveAccount()
    await writeFile(join(directory, 'settings.json'), JSON.stringify({
      network: { proxy: { mode: 'manual', url: 'http://127.0.0.1:8123' } },
    }))
    await refresh(mockFetch(() => Response.json({ data: [{ id: 'claude-proxy' }] })))
    expect((calls[0]?.init as RequestInit & { proxy?: string }).proxy).toBe('http://127.0.0.1:8123')
  })

  test('manual refresh bypasses a warm cache and failures preserve the last complete listing', async () => {
    await saveAccount()
    const first = await refresh(mockFetch(() => Response.json({ data: [{ id: 'claude-before' }] })))
    const second = await refresh(mockFetch(() => Response.json({ data: [{ id: 'claude-after' }] })))
    expect(first.map(model => model.id)).toEqual(['claude-before'])
    expect(second.map(model => model.id)).toEqual(['claude-after'])

    const fail = mockFetch(() => new Response('private upstream text', { status: 401 }))
    await expect(refresh(fail)).rejects.toThrow('Claude models endpoint returned HTTP 401')
    expect(await getDesktopClaudeModelCatalog({ fetchOverride: fail })).toEqual(second)
    expect(calls).toHaveLength(3)
  })

  test.each([
    { name: 'empty result', body: { data: [] }, message: 'returned no models' },
    { name: 'invalid result', body: { models: [{ id: 'claude-wrong' }] }, message: 'invalid response' },
    { name: 'invalid pagination flag', body: { data: [{ id: 'claude-first' }], has_more: 'yes' }, message: 'invalid response' },
    { name: 'missing cursor', body: { data: [{ id: 'claude-first' }], has_more: true }, message: 'invalid pagination cursor' },
  ])('rejects $name and does not cache it as a successful discovery', async ({ body, message }) => {
    await saveAccount()
    const fetchOverride = mockFetch(() => Response.json(body))
    await expect(refresh(fetchOverride)).rejects.toThrow(message)
    expect(await getDesktopClaudeModelCatalog({ fetchOverride })).toEqual(CLAUDE_MODEL_CATALOG)
    expect(calls).toHaveLength(1)
  })

  test('rejects repeated cursors without replacing a complete cache with partial results', async () => {
    await saveAccount()
    const existing = await refresh(mockFetch(() => Response.json({ data: [{ id: 'claude-complete' }] })))
    const fetchOverride = mockFetch(() => Response.json({
      data: [{ id: 'claude-partial' }], has_more: true, last_id: 'claude-partial',
    }))
    await expect(refresh(fetchOverride)).rejects.toThrow('invalid pagination cursor')
    expect(await getDesktopClaudeModelCatalog({ fetchOverride })).toEqual(existing)
    expect(calls).toHaveLength(3)
  })

  test('bounds an endless paginated response and reports timeout failures', async () => {
    await saveAccount()
    const fetchOverride = mockFetch(() => Response.json({
      data: [{ id: `claude-page-${calls.length}` }], has_more: true, last_id: `claude-page-${calls.length}`,
    }))
    await expect(refresh(fetchOverride)).rejects.toThrow('pagination did not finish')
    expect(calls).toHaveLength(10)
    await expect(refresh(mockFetch(() => {
      throw new DOMException('The operation timed out', 'TimeoutError')
    }))).rejects.toThrow('The operation timed out')
  })

  test('unreadable desktop credentials do not fall through to CLI credentials', async () => {
    await saveAccount()
    await writeFile(join(directory, 'cc-haha', 'oauth.json'), 'invalid JSON')
    const fetchOverride = mockFetch(() => { throw new Error('unexpected call') })
    expect(await getDesktopClaudeModelCatalog({ fetchOverride })).toEqual(CLAUDE_MODEL_CATALOG)
    await expect(refresh(fetchOverride)).rejects.toThrow('Claude OAuth token is unavailable')
    expect(calls).toHaveLength(0)
  })
})
