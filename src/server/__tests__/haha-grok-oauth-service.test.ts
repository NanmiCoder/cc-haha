import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import {
  HahaGrokOAuthService,
  getHahaGrokOAuthFilePath,
} from '../services/hahaGrokOAuthService.js'
import { resetSettingsCache } from '../../utils/settings/settingsCache.js'

let tempDir: string
let previousConfigDir: string | undefined
let previousFetch: typeof globalThis.fetch
let service: HahaGrokOAuthService
const originalSystemProxyUrl = process.env.CC_HAHA_SYSTEM_PROXY_URL
const originalHttpProxy = process.env.HTTP_PROXY
const originalHttpsProxy = process.env.HTTPS_PROXY
const originalLowerHttpProxy = process.env.http_proxy
const originalLowerHttpsProxy = process.env.https_proxy

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'haha-grok-oauth-test-'))
  previousConfigDir = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = tempDir
  resetSettingsCache()
  previousFetch = globalThis.fetch
  service = new HahaGrokOAuthService()
})

afterEach(async () => {
  service.dispose()
  globalThis.fetch = previousFetch
  if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = previousConfigDir
  restoreEnv('CC_HAHA_SYSTEM_PROXY_URL', originalSystemProxyUrl)
  restoreEnv('HTTP_PROXY', originalHttpProxy)
  restoreEnv('HTTPS_PROXY', originalHttpsProxy)
  restoreEnv('http_proxy', originalLowerHttpProxy)
  restoreEnv('https_proxy', originalLowerHttpsProxy)
  resetSettingsCache()
  await fs.rm(tempDir, { recursive: true, force: true })
})

describe('HahaGrokOAuthService', () => {
  test('starts a random 127.0.0.1 PKCE callback and persists exchanged tokens', async () => {
    globalThis.fetch = (async (_input, init) => {
      expect(init?.method).toBe('POST')
      const body = new URLSearchParams(String(init?.body))
      expect(body.get('grant_type')).toBe('authorization_code')
      expect(body.get('client_secret')).toBeNull()
      return Response.json({
        access_token: 'grok-access',
        refresh_token: 'grok-refresh',
        expires_in: 3600,
      })
    }) as typeof fetch

    const session = await service.startSession()
    const authorizeUrl = new URL(session.authorizeUrl)
    const redirectUri = new URL(authorizeUrl.searchParams.get('redirect_uri')!)
    expect(redirectUri.hostname).toBe('127.0.0.1')
    expect(Number(redirectUri.port)).toBeGreaterThan(0)
    expect(authorizeUrl.searchParams.get('state')).toBe(session.state)
    expect(authorizeUrl.searchParams.get('code_challenge_method')).toBe('S256')

    const callback = new URL(session.redirectUri)
    callback.searchParams.set('code', 'code')
    callback.searchParams.set('state', session.state)
    const callbackResponse = await previousFetch(callback)
    expect(callbackResponse.status).toBe(200)
    expect(await service.loadTokens()).toMatchObject({
      accessToken: 'grok-access',
      refreshToken: 'grok-refresh',
    })
    if (process.platform !== 'win32') {
      expect((await fs.stat(getHahaGrokOAuthFilePath())).mode & 0o777).toBe(0o600)
    }
  })

  test('refreshes an expiring token and preserves an unrotated refresh token', async () => {
    await service.saveTokens({
      accessToken: 'old-access',
      refreshToken: 'old-refresh',
      expiresAt: Date.now() - 1,
      email: 'user@example.com',
    })
    service.setRefreshFn(async () => ({
      access_token: 'new-access',
      expires_in: 3600,
    }))

    await expect(service.ensureFreshTokens()).resolves.toMatchObject({
      accessToken: 'new-access',
      refreshToken: 'old-refresh',
      email: 'user@example.com',
    })
    await expect(service.loadTokens()).resolves.toMatchObject({
      accessToken: 'new-access',
      refreshToken: 'old-refresh',
    })
  })

  test('uses direct, system, and manual network settings for token refresh', async () => {
    process.env.CC_HAHA_SYSTEM_PROXY_URL = 'http://127.0.0.1:7897'
    process.env.HTTP_PROXY = 'http://stale-parent.example:8080'
    process.env.HTTPS_PROXY = 'http://stale-parent.example:8080'
    process.env.http_proxy = 'http://stale-parent.example:8080'
    process.env.https_proxy = 'http://stale-parent.example:8080'

    const cases = [
      { mode: 'direct', url: '', expectedProxyUrl: null },
      { mode: 'system', url: '', expectedProxyUrl: 'http://127.0.0.1:7897' },
      { mode: 'manual', url: ' http://127.0.0.1:7890 ', expectedProxyUrl: 'http://127.0.0.1:7890' },
    ] as const

    for (const testCase of cases) {
      await fs.writeFile(
        path.join(tempDir, 'settings.json'),
        JSON.stringify({
          network: {
            aiRequestTimeoutMs: 45_000,
            proxy: { mode: testCase.mode, url: testCase.url },
          },
        }),
        'utf-8',
      )
      resetSettingsCache()
      await service.saveTokens({
        accessToken: 'old-access',
        refreshToken: 'old-refresh',
        expiresAt: Date.now() - 1,
        email: 'user@example.com',
      })

      service.setRefreshFn(async (_refreshToken, options) => {
        expect(options?.proxyUrl).toBe(testCase.expectedProxyUrl)
        expect(options?.timeoutMs).toBe(45_000)
        return {
          access_token: 'new-access',
          expires_in: 3600,
        }
      })

      await expect(service.ensureFreshTokens()).resolves.toMatchObject({
        accessToken: 'new-access',
      })
    }
  })
})
