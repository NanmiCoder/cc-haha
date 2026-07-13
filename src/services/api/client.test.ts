import { describe, expect, mock, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { GROK_OAUTH_DUMMY_KEY } from '../grokAuth/fetch.js'

mock.module('src/utils/http.js', () => ({
  getAuthHeaders: mock(() => ({})),
  getMCPUserAgent: mock(() => 'client-test-agent'),
  getUserAgent: mock(() => 'client-test-agent'),
  getWebFetchUserAgent: mock(() => 'client-test-agent'),
  withOAuth401Retry: mock(async <T>(fn: () => Promise<T>) => fn()),
}))

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
