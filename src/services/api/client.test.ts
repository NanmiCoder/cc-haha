import { afterAll, describe, expect, mock, spyOn, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { GROK_OAUTH_DUMMY_KEY } from '../grokAuth/fetch.js'

const httpModule = await import('src/utils/http.js')

spyOn(httpModule, 'getAuthHeaders').mockImplementation(() => ({}))
spyOn(httpModule, 'getMCPUserAgent').mockImplementation(() => 'client-test-agent')
spyOn(httpModule, 'getUserAgent').mockImplementation(() => 'client-test-agent')
spyOn(httpModule, 'getWebFetchUserAgent').mockImplementation(() => 'client-test-agent')
spyOn(httpModule, 'withOAuth401Retry').mockImplementation(async <T>(fn: () => Promise<T>) => fn())

afterAll(() => {
  mock.restore()
})

describe('resolveAnthropicClientApiKey', () => {
  test('does not inherit a local api key when a provider auth token is explicit', async () => {
    const { resolveAnthropicClientApiKey } = await import('./client.js')
    const getFallbackApiKey = mock(() => 'sk-keychain-fallback')

    const apiKey = resolveAnthropicClientApiKey({
      envAuthToken: 'provider-bearer-token',
      envApiKey: '',
      getFallbackApiKey,
    })

    expect(apiKey).toBeNull()
    expect(getFallbackApiKey).not.toHaveBeenCalled()
  })

  test('preserves an explicit api key when the caller opts into dual auth', async () => {
    const { resolveAnthropicClientApiKey } = await import('./client.js')
    const getFallbackApiKey = mock(() => 'sk-keychain-fallback')

    const apiKey = resolveAnthropicClientApiKey({
      explicitApiKey: 'sk-explicit-api-key',
      envAuthToken: 'provider-bearer-token',
      getFallbackApiKey,
    })

    expect(apiKey).toBe('sk-explicit-api-key')
    expect(getFallbackApiKey).not.toHaveBeenCalled()
  })

  test('falls back to the local api key when no provider auth token is present', async () => {
    const { resolveAnthropicClientApiKey } = await import('./client.js')
    const getFallbackApiKey = mock(() => 'sk-keychain-fallback')

    const apiKey = resolveAnthropicClientApiKey({
      envAuthToken: '',
      envApiKey: '',
      getFallbackApiKey,
    })

    expect(apiKey).toBe('sk-keychain-fallback')
    expect(getFallbackApiKey).toHaveBeenCalled()
  })
})

describe('resolveManagedProviderProxyAccessToken', () => {
  test('returns the desktop local credential only for the host-managed loopback proxy', async () => {
    const { resolveManagedProviderProxyAccessToken } = await import('./client.js')
    const input = {
      providerManagedByHost: '1',
      apiKey: 'proxy-managed',
      baseUrl: 'http://127.0.0.1:3456/proxy/providers/provider-1',
      localAccessToken: ' desktop-local-secret ',
    }

    expect(resolveManagedProviderProxyAccessToken(input)).toBe('desktop-local-secret')
    expect(resolveManagedProviderProxyAccessToken({
      ...input,
      baseUrl: 'http://127.0.0.1:3456/proxy',
    })).toBe('desktop-local-secret')
    expect(resolveManagedProviderProxyAccessToken({
      ...input,
      requestUrl: 'http://127.0.0.1:3456/proxy/providers/provider-1/v1/messages',
    })).toBe('desktop-local-secret')
  })

  test('never sends the desktop credential to unowned or direct provider URLs', async () => {
    const { resolveManagedProviderProxyAccessToken } = await import('./client.js')
    const input = {
      providerManagedByHost: '1',
      apiKey: 'proxy-managed',
      baseUrl: 'http://127.0.0.1:3456/proxy/providers/provider-1',
      localAccessToken: 'desktop-local-secret',
    }

    for (const override of [
      { providerManagedByHost: undefined },
      { apiKey: 'real-provider-key' },
      { baseUrl: 'https://api.example.com/proxy/providers/provider-1' },
      { baseUrl: 'http://localhost:3456/proxy/providers/provider-1' },
      { baseUrl: 'http://127.0.0.1:3456/api/status' },
      { baseUrl: 'http://127.0.0.1:3456/proxy/providers/provider-1?target=external' },
      { requestUrl: 'http://127.0.0.1:3457/proxy/providers/provider-1/v1/messages' },
      { requestUrl: 'http://127.0.0.1:3456/api/status' },
      { localAccessToken: undefined },
    ]) {
      expect(resolveManagedProviderProxyAccessToken({ ...input, ...override })).toBeNull()
    }
  })
})

describe('shouldUseOpenAICodexTransport', () => {
  test('lets ChatGPT Official marker override a saved Claude subscriber login', async () => {
    const { shouldUseOpenAICodexTransport } = await import('./client.js')

    expect(shouldUseOpenAICodexTransport({
      hasOpenAIAuth: true,
      isClaudeSubscriber: true,
      forceOpenAICodex: true,
      isOpenAIModel: true,
      hasAnthropicAuthToken: false,
      hasExplicitApiKey: false,
      hasFallbackApiKey: false,
    })).toBe(true)
  })

  test('keeps Claude subscriber transport when ChatGPT Official is not selected', async () => {
    const { shouldUseOpenAICodexTransport } = await import('./client.js')

    expect(shouldUseOpenAICodexTransport({
      hasOpenAIAuth: true,
      isClaudeSubscriber: true,
      forceOpenAICodex: false,
      isOpenAIModel: true,
      hasAnthropicAuthToken: false,
      hasExplicitApiKey: false,
      hasFallbackApiKey: false,
    })).toBe(false)
  })
})

describe('getAnthropicClient', () => {
  test('selects the isolated Grok transport with a dummy SDK key', async () => {
    const { getAnthropicClient } = await import('./client.js')
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'grok-client-test-'))
    const tokenFile = path.join(tempDir, 'grok-oauth.json')
    await fs.writeFile(tokenFile, JSON.stringify({
      accessToken: 'grok-access',
      refreshToken: 'grok-refresh',
      expiresAt: Date.now() + 3600_000,
    }))
    const previous = {
      marker: process.env.CC_HAHA_GROK_OAUTH_PROVIDER,
      tokenFile: process.env.GROK_OAUTH_FILE,
      configDir: process.env.CLAUDE_CONFIG_DIR,
    }
    process.env.CC_HAHA_GROK_OAUTH_PROVIDER = '1'
    process.env.GROK_OAUTH_FILE = tokenFile
    process.env.CLAUDE_CONFIG_DIR = tempDir
    try {
      const client = await getAnthropicClient({ maxRetries: 0, model: 'grok-4.5' })
      expect(client.apiKey).toBe(GROK_OAUTH_DUMMY_KEY)
      expect(client.authToken).toBeNull()
      expect(client._options.fetch).toBeFunction()
    } finally {
      if (previous.marker === undefined) delete process.env.CC_HAHA_GROK_OAUTH_PROVIDER
      else process.env.CC_HAHA_GROK_OAUTH_PROVIDER = previous.marker
      if (previous.tokenFile === undefined) delete process.env.GROK_OAUTH_FILE
      else process.env.GROK_OAUTH_FILE = previous.tokenFile
      if (previous.configDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = previous.configDir
      await fs.rm(tempDir, { recursive: true, force: true })
    }
  })

  test('passes bearer-token provider auth without an SDK api key', async () => {
    const { getAnthropicClient } = await import('./client.js')
    const originalAuthToken = process.env.ANTHROPIC_AUTH_TOKEN
    const originalApiKey = process.env.ANTHROPIC_API_KEY
    const originalSimple = process.env.CLAUDE_CODE_SIMPLE

    process.env.ANTHROPIC_AUTH_TOKEN = 'provider-bearer-token'
    process.env.CLAUDE_CODE_SIMPLE = '1'
    delete process.env.ANTHROPIC_API_KEY

    try {
      const client = await getAnthropicClient({
        maxRetries: 0,
        model: 'claude-sonnet-4-6',
      })

      expect(client.apiKey).toBeNull()
      expect(client._options.defaultHeaders).toMatchObject({
        Authorization: 'Bearer provider-bearer-token',
      })
    } finally {
      if (originalAuthToken === undefined) delete process.env.ANTHROPIC_AUTH_TOKEN
      else process.env.ANTHROPIC_AUTH_TOKEN = originalAuthToken

      if (originalApiKey === undefined) delete process.env.ANTHROPIC_API_KEY
      else process.env.ANTHROPIC_API_KEY = originalApiKey

      if (originalSimple === undefined) delete process.env.CLAUDE_CODE_SIMPLE
      else process.env.CLAUDE_CODE_SIMPLE = originalSimple
    }
  })

  test('authenticates the host-managed desktop provider proxy with the local access token', async () => {
    const { getAnthropicClient } = await import('./client.js')
    let requestHeaders: Headers | null = null
    const previous = {
      authToken: process.env.ANTHROPIC_AUTH_TOKEN,
      apiKey: process.env.ANTHROPIC_API_KEY,
      baseUrl: process.env.ANTHROPIC_BASE_URL,
      localAccessToken: process.env.CC_HAHA_LOCAL_ACCESS_TOKEN,
      providerManagedByHost: process.env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST,
      simple: process.env.CLAUDE_CODE_SIMPLE,
    }

    process.env.ANTHROPIC_AUTH_TOKEN = 'stale-provider-token'
    process.env.ANTHROPIC_API_KEY = 'proxy-managed'
    process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:3456/proxy/providers/provider-1'
    process.env.CC_HAHA_LOCAL_ACCESS_TOKEN = 'desktop-local-secret'
    process.env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST = '1'
    process.env.CLAUDE_CODE_SIMPLE = '1'

    try {
      const client = await getAnthropicClient({
        maxRetries: 0,
        model: 'openai-compatible-model',
        fetchOverride: async (_input, init) => {
          requestHeaders = new Headers(init?.headers)
          return Response.json({
            id: 'msg-local-proxy-auth',
            type: 'message',
            role: 'assistant',
            model: 'openai-compatible-model',
            content: [{ type: 'text', text: 'ok' }],
            stop_reason: 'end_turn',
            stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 1 },
          })
        },
      })

      expect(client.apiKey).toBe('proxy-managed')
      await client.messages.create({
        model: 'openai-compatible-model',
        max_tokens: 16,
        messages: [{ role: 'user', content: 'hello' }],
      })
      expect(requestHeaders?.get('x-api-key')).toBe('proxy-managed')
      expect(requestHeaders?.get('Authorization')).toBe('Bearer desktop-local-secret')
    } finally {
      for (const [envKey, value] of [
        ['ANTHROPIC_AUTH_TOKEN', previous.authToken],
        ['ANTHROPIC_API_KEY', previous.apiKey],
        ['ANTHROPIC_BASE_URL', previous.baseUrl],
        ['CC_HAHA_LOCAL_ACCESS_TOKEN', previous.localAccessToken],
        ['CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST', previous.providerManagedByHost],
        ['CLAUDE_CODE_SIMPLE', previous.simple],
      ] as const) {
        if (value === undefined) delete process.env[envKey]
        else process.env[envKey] = value
      }
    }
  })

  test('bypasses system proxy for local desktop provider proxy base URLs', async () => {
    const { getAnthropicClient } = await import('./client.js')
    const originalAuthToken = process.env.ANTHROPIC_AUTH_TOKEN
    const originalApiKey = process.env.ANTHROPIC_API_KEY
    const originalBaseUrl = process.env.ANTHROPIC_BASE_URL
    const originalHttpProxy = process.env.HTTP_PROXY
    const originalHttpsProxy = process.env.HTTPS_PROXY
    const originalNoProxy = process.env.NO_PROXY
    const originalLowerHttpProxy = process.env.http_proxy
    const originalLowerHttpsProxy = process.env.https_proxy
    const originalLowerNoProxy = process.env.no_proxy
    const originalSimple = process.env.CLAUDE_CODE_SIMPLE

    process.env.ANTHROPIC_AUTH_TOKEN = 'provider-bearer-token'
    process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:3456/proxy/providers/provider-1'
    process.env.HTTP_PROXY = 'http://127.0.0.1:1181'
    process.env.HTTPS_PROXY = 'http://127.0.0.1:1181'
    process.env.NO_PROXY = 'localhost,127.0.0.1,::1'
    process.env.CLAUDE_CODE_SIMPLE = '1'
    delete process.env.ANTHROPIC_API_KEY
    delete process.env.http_proxy
    delete process.env.https_proxy
    delete process.env.no_proxy

    try {
      const client = await getAnthropicClient({
        maxRetries: 0,
        model: 'deepseek-v4-pro',
      })

      expect(client._options.fetchOptions?.proxy).toBeUndefined()
    } finally {
      if (originalAuthToken === undefined) delete process.env.ANTHROPIC_AUTH_TOKEN
      else process.env.ANTHROPIC_AUTH_TOKEN = originalAuthToken

      if (originalApiKey === undefined) delete process.env.ANTHROPIC_API_KEY
      else process.env.ANTHROPIC_API_KEY = originalApiKey

      if (originalBaseUrl === undefined) delete process.env.ANTHROPIC_BASE_URL
      else process.env.ANTHROPIC_BASE_URL = originalBaseUrl

      if (originalHttpProxy === undefined) delete process.env.HTTP_PROXY
      else process.env.HTTP_PROXY = originalHttpProxy

      if (originalHttpsProxy === undefined) delete process.env.HTTPS_PROXY
      else process.env.HTTPS_PROXY = originalHttpsProxy

      if (originalNoProxy === undefined) delete process.env.NO_PROXY
      else process.env.NO_PROXY = originalNoProxy

      if (originalLowerHttpProxy === undefined) delete process.env.http_proxy
      else process.env.http_proxy = originalLowerHttpProxy

      if (originalLowerHttpsProxy === undefined) delete process.env.https_proxy
      else process.env.https_proxy = originalLowerHttpsProxy

      if (originalLowerNoProxy === undefined) delete process.env.no_proxy
      else process.env.no_proxy = originalLowerNoProxy

      if (originalSimple === undefined) delete process.env.CLAUDE_CODE_SIMPLE
      else process.env.CLAUDE_CODE_SIMPLE = originalSimple
    }
  })
})
