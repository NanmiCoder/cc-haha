import { describe, expect, test } from 'bun:test'
import {
  buildOpenAIAuthorizeUrl,
  exchangeOpenAICodeForTokens,
  generateOpenAICodeVerifier,
  generateOpenAIState,
  OPENAI_CODEX_CLIENT_ID,
  OPENAI_CODEX_TOKEN_USER_AGENT,
  refreshOpenAITokens,
} from './client.js'

describe('OpenAI Codex OAuth client', () => {
  test('generates hex PKCE verifier and state like the Codex-compatible flow', () => {
    const verifier = generateOpenAICodeVerifier()
    const state = generateOpenAIState()

    expect(verifier).toMatch(/^[a-f0-9]{128}$/)
    expect(state).toMatch(/^[a-f0-9]{64}$/)
  })

  test('builds authorize URL without non-Codex originator parameter', () => {
    const authorizeUrl = buildOpenAIAuthorizeUrl({
      redirectUri: 'http://localhost:1455/auth/callback',
      codeVerifier: 'a'.repeat(128),
      state: 'b'.repeat(64),
    })
    const parsed = new URL(authorizeUrl)
    const params = parsed.searchParams

    expect(parsed.origin + parsed.pathname).toBe(
      'https://auth.openai.com/oauth/authorize',
    )
    expect(params.get('client_id')).toBe(OPENAI_CODEX_CLIENT_ID)
    expect(params.get('redirect_uri')).toBe(
      'http://localhost:1455/auth/callback',
    )
    expect(params.get('scope')).toBe('openid profile email offline_access')
    expect(params.get('code_challenge_method')).toBe('S256')
    expect(params.get('id_token_add_organizations')).toBe('true')
    expect(params.get('codex_cli_simplified_flow')).toBe('true')
    expect(params.has('originator')).toBe(false)
  })

  test('exchanges authorization code with Codex-compatible token request headers', async () => {
    const originalFetch = globalThis.fetch
    let tokenRequestUrl = ''
    let tokenRequestBody = ''
    let tokenRequestHeaders = new Headers()

    globalThis.fetch = (async (input, init) => {
      tokenRequestUrl = String(input)
      tokenRequestBody = String(init?.body ?? '')
      tokenRequestHeaders = new Headers(init?.headers)

      return new Response(
        JSON.stringify({
          access_token: 'access-token',
          refresh_token: 'refresh-token',
          expires_in: 3600,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    }) as typeof fetch

    try {
      await exchangeOpenAICodeForTokens({
        code: 'auth-code',
        redirectUri: 'http://localhost:1455/auth/callback',
        codeVerifier: 'verifier',
      })

      expect(tokenRequestUrl).toBe('https://auth.openai.com/oauth/token')
      expect(tokenRequestHeaders.get('Accept')).toBe('application/json')
      expect(tokenRequestHeaders.get('Content-Type')).toBe(
        'application/x-www-form-urlencoded',
      )
      expect(tokenRequestHeaders.get('User-Agent')).toBe(
        OPENAI_CODEX_TOKEN_USER_AGENT,
      )
      expect(tokenRequestBody).toContain('grant_type=authorization_code')
      expect(tokenRequestBody).toContain('client_id=app_EMoamEEZ73f0CkXaXp7hrann')
      expect(tokenRequestBody).toContain('code=auth-code')
      expect(tokenRequestBody).toContain(
        `redirect_uri=${encodeURIComponent('http://localhost:1455/auth/callback')}`,
      )
      expect(tokenRequestBody).toContain('code_verifier=verifier')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('exchanges authorization code through configured proxy fetch options', async () => {
    const originalFetch = globalThis.fetch
    let tokenRequestInit: RequestInit | undefined

    globalThis.fetch = (async (_input, init) => {
      tokenRequestInit = init
      return new Response(
        JSON.stringify({
          access_token: 'access-token',
          refresh_token: 'refresh-token',
          expires_in: 3600,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    }) as typeof fetch

    try {
      await exchangeOpenAICodeForTokens({
        code: 'auth-code',
        redirectUri: 'http://localhost:1455/auth/callback',
        codeVerifier: 'verifier',
        proxyUrl: 'http://127.0.0.1:7890',
        timeoutMs: 30_000,
      })

      expect((tokenRequestInit as { proxy?: string } | undefined)?.proxy).toBe(
        'http://127.0.0.1:7890',
      )
      expect(tokenRequestInit?.signal).toBeInstanceOf(AbortSignal)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('refreshes tokens with Codex-compatible token request headers', async () => {
    const originalFetch = globalThis.fetch
    let tokenRequestBody = ''
    let tokenRequestHeaders = new Headers()

    globalThis.fetch = (async (_input, init) => {
      tokenRequestBody = String(init?.body ?? '')
      tokenRequestHeaders = new Headers(init?.headers)

      return new Response(
        JSON.stringify({
          access_token: 'access-token',
          expires_in: 3600,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    }) as typeof fetch

    try {
      await refreshOpenAITokens('refresh-token')

      expect(tokenRequestHeaders.get('User-Agent')).toBe(
        OPENAI_CODEX_TOKEN_USER_AGENT,
      )
      expect(tokenRequestBody).toContain('grant_type=refresh_token')
      expect(tokenRequestBody).toContain('refresh_token=refresh-token')
      expect(tokenRequestBody).toContain('scope=openid+profile+email')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('refreshes tokens through configured proxy fetch options', async () => {
    const originalFetch = globalThis.fetch
    let tokenRequestInit: RequestInit | undefined

    globalThis.fetch = (async (_input, init) => {
      tokenRequestInit = init
      return new Response(
        JSON.stringify({
          access_token: 'access-token',
          expires_in: 3600,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    }) as typeof fetch

    try {
      await refreshOpenAITokens('refresh-token', {
        proxyUrl: 'http://127.0.0.1:7890',
        timeoutMs: 30_000,
      })

      expect((tokenRequestInit as { proxy?: string } | undefined)?.proxy).toBe(
        'http://127.0.0.1:7890',
      )
      expect(tokenRequestInit?.signal).toBeInstanceOf(AbortSignal)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('includes sanitized token error response details for diagnostics', async () => {
    const originalFetch = globalThis.fetch

    globalThis.fetch = (async () => {
      return new Response(
        '{"error":"forbidden","code":"sensitive-code","refresh_token":"secret"}',
        { status: 403, headers: { 'Content-Type': 'application/json' } },
      )
    }) as typeof fetch

    try {
      await expect(
        exchangeOpenAICodeForTokens({
          code: 'auth-code',
          redirectUri: 'http://localhost:1455/auth/callback',
          codeVerifier: 'verifier',
        }),
      ).rejects.toThrow(
        'OpenAI token exchange failed: 403: {"error":"forbidden","code":"[redacted]","refresh_token":"[redacted]"}',
      )
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
