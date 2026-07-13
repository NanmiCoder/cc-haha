import { describe, expect, test } from 'bun:test'
import {
  buildGrokAuthorizeUrl,
  exchangeGrokCodeForTokens,
  generateGrokCodeVerifier,
  generateGrokNonce,
  generateGrokState,
  GROK_OAUTH_CLIENT_ID,
  GROK_OAUTH_TOKEN_ENDPOINT,
  refreshGrokTokens,
} from './client.js'

describe('Grok OAuth client', () => {
  test('builds the xAI PKCE authorization request', () => {
    const verifier = generateGrokCodeVerifier()
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(generateGrokState()).toMatch(/^[a-f0-9]{64}$/)
    expect(generateGrokNonce()).toMatch(/^[a-f0-9]{32}$/)

    const url = new URL(buildGrokAuthorizeUrl({
      redirectUri: 'http://127.0.0.1:56121/callback',
      codeVerifier: verifier,
      state: 'state',
      nonce: 'nonce',
    }))
    expect(url.origin + url.pathname).toBe('https://auth.x.ai/oauth2/authorize')
    expect(url.searchParams.get('client_id')).toBe(GROK_OAUTH_CLIENT_ID)
    expect(url.searchParams.get('scope')).toBe(
      'openid profile email offline_access grok-cli:access api:access conversations:read conversations:write',
    )
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.has('plan')).toBe(false)
    expect(url.searchParams.has('referrer')).toBe(false)
  })

  test('exchanges and refreshes tokens without a client secret', async () => {
    const requests: Array<{ url: string; body: URLSearchParams }> = []
    const fetchOverride: typeof fetch = async (input, init) => {
      requests.push({
        url: String(input),
        body: new URLSearchParams(String(init?.body)),
      })
      return Response.json({ access_token: 'access', refresh_token: 'refresh' })
    }

    await exchangeGrokCodeForTokens({
      code: 'code',
      codeVerifier: 'verifier',
      redirectUri: 'http://127.0.0.1:56121/callback',
      fetchOverride,
    })
    await refreshGrokTokens('refresh', { fetchOverride })

    expect(requests.map((request) => request.url)).toEqual([
      GROK_OAUTH_TOKEN_ENDPOINT,
      GROK_OAUTH_TOKEN_ENDPOINT,
    ])
    expect(requests[0]!.body.get('grant_type')).toBe('authorization_code')
    expect(requests[0]!.body.get('code_verifier')).toBe('verifier')
    expect(requests[0]!.body.has('client_secret')).toBe(false)
    expect(requests[1]!.body.get('grant_type')).toBe('refresh_token')
    expect(requests[1]!.body.get('refresh_token')).toBe('refresh')
  })
})
