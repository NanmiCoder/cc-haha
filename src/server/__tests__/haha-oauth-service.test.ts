/**
 * Unit tests for HahaOAuthService — the core service layer for haha's self-managed OAuth.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import {
  HahaOAuthService,
  type StoredOAuthTokens,
} from '../services/hahaOAuthService.js'
import { SYSTEM_PROXY_URL_ENV } from '../services/networkSettings.js'

let tmpDir: string
let originalConfigDir: string | undefined
let originalSystemProxyUrl: string | undefined
let originalFetch: typeof globalThis.fetch
let service: HahaOAuthService

async function setup() {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'haha-oauth-test-'))
  originalConfigDir = process.env.CLAUDE_CONFIG_DIR
  originalSystemProxyUrl = process.env[SYSTEM_PROXY_URL_ENV]
  originalFetch = globalThis.fetch
  delete process.env[SYSTEM_PROXY_URL_ENV]
  process.env.CLAUDE_CONFIG_DIR = tmpDir
  service = new HahaOAuthService()
}

async function teardown() {
  if (originalConfigDir === undefined) {
    delete process.env.CLAUDE_CONFIG_DIR
  } else {
    process.env.CLAUDE_CONFIG_DIR = originalConfigDir
  }
  if (originalSystemProxyUrl === undefined) {
    delete process.env[SYSTEM_PROXY_URL_ENV]
  } else {
    process.env[SYSTEM_PROXY_URL_ENV] = originalSystemProxyUrl
  }
  globalThis.fetch = originalFetch
  await fs.rm(tmpDir, { recursive: true, force: true })
}

describe('HahaOAuthService — file storage', () => {
  beforeEach(setup)
  afterEach(teardown)

  test('loadTokens returns null when file does not exist', async () => {
    expect(await service.loadTokens()).toBeNull()
  })

  test('saveTokens writes file with 0600 permissions', async () => {
    const tokens: StoredOAuthTokens = {
      accessToken: 'sk-ant-oat01-xxx',
      refreshToken: 'sk-ant-ort01-xxx',
      expiresAt: Date.now() + 3600_000,
      scopes: ['user:inference', 'user:profile'],
      subscriptionType: 'max',
    }
    await service.saveTokens(tokens)

    const oauthPath = path.join(tmpDir, 'cc-haha', 'oauth.json')
    const stat = await fs.stat(oauthPath)
    if (process.platform !== 'win32') {
      expect(stat.mode & 0o777).toBe(0o600)
    }

    const loaded = await service.loadTokens()
    expect(loaded).toEqual(tokens)
  })

  test('deleteTokens removes file', async () => {
    await service.saveTokens({
      accessToken: 'a',
      refreshToken: null,
      expiresAt: null,
      scopes: [],
      subscriptionType: null,
    })
    await service.deleteTokens()
    expect(await service.loadTokens()).toBeNull()
  })
})

describe('HahaOAuthService — session management', () => {
  beforeEach(setup)
  afterEach(teardown)

  test('startSession creates session with PKCE + state', () => {
    const session = service.startSession({ serverPort: 54321 })
    expect(session.state).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(session.codeVerifier).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(session.authorizeUrl).toContain('code_challenge_method=S256')
    expect(session.authorizeUrl).toContain(`state=${encodeURIComponent(session.state)}`)
    expect(session.authorizeUrl).toContain('redirect_uri=')
    expect(session.authorizeUrl).toContain(encodeURIComponent(
      'http://localhost:54321/callback',
    ))
  })

  test('getSession returns stored session by state', () => {
    const session = service.startSession({ serverPort: 54321 })
    const found = service.getSession(session.state)
    expect(found?.codeVerifier).toBe(session.codeVerifier)
  })

  test('getSession returns null for unknown state', () => {
    expect(service.getSession('unknown-state')).toBeNull()
  })

  test('consumeSession removes session after fetch', () => {
    const session = service.startSession({ serverPort: 54321 })
    expect(service.consumeSession(session.state)).not.toBeNull()
    expect(service.getSession(session.state)).toBeNull()
  })

  test('completeSession stores subscription type fetched from profile info', async () => {
    process.env[SYSTEM_PROXY_URL_ENV] = 'http://127.0.0.1:17890'
    const session = service.startSession({ serverPort: 54321 })
    ;(service as any).exchangeWithCustomCallback = async () => ({
      access_token: 'fresh-access-token',
      refresh_token: 'fresh-refresh-token',
      expires_in: 3600,
      scope: 'user:inference',
    })
    let profileProxyUrl: string | null | undefined
    service.setFetchProfileFn(async (_accessToken, options) => {
      profileProxyUrl = options?.proxyUrl
      return { subscriptionType: 'team' }
    })

    const tokens = await service.completeSession('authorization-code', session.state)

    expect(tokens.subscriptionType).toBe('team')
    expect(profileProxyUrl).toBe('http://127.0.0.1:17890')
    expect((await service.loadTokens())?.subscriptionType).toBe('team')
  })

  test('routes the Claude token exchange through the dynamic system proxy bridge', async () => {
    const bridgeUrl = 'http://127.0.0.1:17890'
    process.env[SYSTEM_PROXY_URL_ENV] = bridgeUrl
    let seen:
      | { args: unknown[]; proxyUrl: string | null | undefined }
      | undefined
    service.setExchangeFn(async (...args) => {
      const opts = args[6] as { proxyUrl?: string | null } | undefined
      seen = { args: args.slice(0, 4), proxyUrl: opts?.proxyUrl }
      return {
        access_token: 'access',
        refresh_token: 'refresh',
        expires_in: 3600,
        scope: 'user:inference',
      }
    })

    await (service as any).exchangeWithCustomCallback(
      'authorization-code',
      'state',
      'verifier',
      54321,
    )

    expect(seen?.args).toEqual(['authorization-code', 'state', 'verifier', 54321])
    expect(seen?.proxyUrl).toBe(bridgeUrl)
  })

  test('keeps the token endpoint error body when the exchange is rejected', async () => {
    service.setExchangeFn(async () => {
      throw Object.assign(new Error('Request failed with status code 400'), {
        isAxiosError: true,
        response: { status: 400, data: { error: 'invalid_grant' } },
      })
    })

    await expect(
      (service as any).exchangeWithCustomCallback('code', 'state', 'verifier', 54321),
    ).rejects.toThrow('Token exchange failed (400): {"error":"invalid_grant"}')
  })
})

describe('HahaOAuthService — account uuid', () => {
  beforeEach(setup)
  afterEach(teardown)

  test('looks the uuid up once per login and caches it', async () => {
    process.env[SYSTEM_PROXY_URL_ENV] = 'http://127.0.0.1:17890'
    let calls = 0
    let proxyUrl: string | null | undefined
    service.setFetchAccountUuidFn(async (_token, opts) => {
      calls++
      proxyUrl = opts?.proxyUrl
      return 'account-uuid'
    })

    expect(await service.getAccountUuid('token-1')).toBe('account-uuid')
    expect(await service.getAccountUuid('token-2')).toBe('account-uuid')

    expect(calls).toBe(1)
    expect(proxyUrl).toBe('http://127.0.0.1:17890')
  })

  test('forgets the uuid on logout so another account is looked up afresh', async () => {
    const answers = ['first-account', 'second-account']
    service.setFetchAccountUuidFn(async () => answers.shift() ?? null)

    expect(await service.getAccountUuid('token-a')).toBe('first-account')
    await service.deleteTokens()
    expect(await service.getAccountUuid('token-b')).toBe('second-account')
  })

  test('returns null instead of throwing when the profile lookup fails', async () => {
    service.setFetchAccountUuidFn(async () => {
      throw new Error('profile endpoint unreachable')
    })

    expect(await service.getAccountUuid('token')).toBeNull()
  })

  test('does not ask the profile endpoint with a token that lacks user:profile', async () => {
    let calls = 0
    service.setFetchAccountUuidFn(async () => {
      calls++
      return 'account-uuid'
    })
    await service.saveTokens({
      accessToken: 'inference-only',
      refreshToken: null,
      expiresAt: null,
      scopes: ['user:inference'],
      subscriptionType: 'pro',
    })

    expect(await service.getAccountUuid('inference-only')).toBeNull()
    expect(calls).toBe(0)
  })

  test('backs off after a failed lookup instead of retrying on every session', async () => {
    let calls = 0
    service.setFetchAccountUuidFn(async () => {
      calls++
      return null
    })

    expect(await service.getAccountUuid('token')).toBeNull()
    expect(await service.getAccountUuid('token')).toBeNull()
    expect(calls).toBe(1)

    // A new login is a fresh start: the previous failure says nothing about it.
    await service.deleteTokens()
    expect(await service.getAccountUuid('token')).toBeNull()
    expect(calls).toBe(2)
  })

  test('does not hold up the caller for a slow profile endpoint', async () => {
    service.setFetchAccountUuidFn(
      () => new Promise<string | null>((resolve) => setTimeout(() => resolve('late'), 5_000)),
    )

    const startedAt = Date.now()
    const uuid = await service.getAccountUuid('token')

    expect(uuid).toBeNull()
    expect(Date.now() - startedAt).toBeLessThan(4_000)
  })
})

describe('HahaOAuthService — ensureFreshAccessToken', () => {
  beforeEach(setup)
  afterEach(teardown)

  test('returns null when no token file exists', async () => {
    expect(await service.ensureFreshAccessToken()).toBeNull()
  })

  test('returns token unchanged if not expired', async () => {
    const tokens: StoredOAuthTokens = {
      accessToken: 'still-valid',
      refreshToken: 'refresh-xxx',
      expiresAt: Date.now() + 30 * 60_000,
      scopes: ['user:inference'],
      subscriptionType: 'max',
    }
    await service.saveTokens(tokens)

    expect(await service.ensureFreshAccessToken()).toBe('still-valid')
  })

  test('refreshes token when expired (within 5-min buffer)', async () => {
    process.env[SYSTEM_PROXY_URL_ENV] = 'http://127.0.0.1:17890'
    const oldTokens: StoredOAuthTokens = {
      accessToken: 'expired',
      refreshToken: 'refresh-xxx',
      expiresAt: Date.now() + 60_000,
      scopes: ['user:inference'],
      subscriptionType: 'max',
    }
    await service.saveTokens(oldTokens)

    let refreshProxyUrl: string | null | undefined
    service.setRefreshFn(async (_refreshToken, options) => {
      refreshProxyUrl = options?.proxyUrl
      return {
        accessToken: 'new-fresh-token',
        refreshToken: 'new-refresh-xxx',
        expiresAt: Date.now() + 3600_000,
        scopes: ['user:inference'],
        subscriptionType: 'max',
        rateLimitTier: null,
      }
    })

    const fresh = await service.ensureFreshAccessToken()
    expect(fresh).toBe('new-fresh-token')
    expect(refreshProxyUrl).toBe('http://127.0.0.1:17890')

    const loaded = await service.loadTokens()
    expect(loaded?.accessToken).toBe('new-fresh-token')
  })

  test('deduplicates concurrent expiry refreshes from parallel model requests', async () => {
    await service.saveTokens({
      accessToken: 'expiring-shared-token',
      refreshToken: 'refresh-shared-token',
      expiresAt: Date.now() + 60_000,
      scopes: ['user:inference'],
      subscriptionType: 'pro',
    })
    let refreshCalls = 0
    service.setRefreshFn(async () => {
      refreshCalls += 1
      await Promise.resolve()
      return {
        accessToken: 'expiry-recovered-token',
        refreshToken: 'refresh-next',
        expiresAt: Date.now() + 60 * 60_000,
        scopes: ['user:inference'],
        subscriptionType: 'pro',
        rateLimitTier: null,
      }
    })

    const [first, second] = await Promise.all([
      service.ensureFreshTokens(),
      service.ensureFreshTokens(),
    ])

    expect(first?.accessToken).toBe('expiry-recovered-token')
    expect(second?.accessToken).toBe('expiry-recovered-token')
    expect(refreshCalls).toBe(1)
  })

  test('returns null when refresh fails', async () => {
    await service.saveTokens({
      accessToken: 'expired',
      refreshToken: 'bad-refresh',
      expiresAt: Date.now() + 60_000,
      scopes: ['user:inference'],
      subscriptionType: null,
    })
    service.setRefreshFn(async () => {
      throw new Error('401 Unauthorized')
    })

    expect(await service.ensureFreshAccessToken()).toBeNull()
  })

  test('forces a refresh after a server-side 401 even when the token is not locally expired', async () => {
    await service.saveTokens({
      accessToken: 'rejected-by-server',
      refreshToken: 'refresh-xxx',
      expiresAt: Date.now() + 30 * 60_000,
      scopes: ['user:inference'],
      subscriptionType: 'max',
    })
    service.setRefreshFn(async () => ({
      accessToken: 'accepted-after-refresh',
      refreshToken: null,
      expiresAt: Date.now() + 60 * 60_000,
      scopes: ['user:inference'],
      subscriptionType: null,
      rateLimitTier: null,
    }))

    const refreshed = await service.recoverFromUnauthorized('rejected-by-server')

    expect(refreshed).toMatchObject({
      accessToken: 'accepted-after-refresh',
      refreshToken: 'refresh-xxx',
      subscriptionType: 'max',
    })
    expect(await service.loadTokens()).toEqual(refreshed)
  })

  test('reuses a token already rotated by another session instead of refreshing it again', async () => {
    await service.saveTokens({
      accessToken: 'already-rotated',
      refreshToken: 'refresh-xxx',
      expiresAt: Date.now() + 30 * 60_000,
      scopes: ['user:inference'],
      subscriptionType: 'pro',
    })
    let refreshCalls = 0
    service.setRefreshFn(async () => {
      refreshCalls += 1
      throw new Error('refresh should not be called')
    })

    const refreshed = await service.recoverFromUnauthorized('older-rejected-token')

    expect(refreshed?.accessToken).toBe('already-rotated')
    expect(refreshCalls).toBe(0)
  })

  test('deduplicates concurrent recovery for the same rejected token', async () => {
    await service.saveTokens({
      accessToken: 'shared-rejected-token',
      refreshToken: 'refresh-xxx',
      expiresAt: Date.now() + 30 * 60_000,
      scopes: ['user:inference'],
      subscriptionType: 'pro',
    })
    let refreshCalls = 0
    service.setRefreshFn(async () => {
      refreshCalls += 1
      await Promise.resolve()
      return {
        accessToken: 'shared-recovered-token',
        refreshToken: 'refresh-next',
        expiresAt: Date.now() + 60 * 60_000,
        scopes: ['user:inference'],
        subscriptionType: 'pro',
        rateLimitTier: null,
      }
    })

    const [first, second] = await Promise.all([
      service.recoverFromUnauthorized('shared-rejected-token'),
      service.recoverFromUnauthorized('shared-rejected-token'),
    ])

    expect(first?.accessToken).toBe('shared-recovered-token')
    expect(second?.accessToken).toBe('shared-recovered-token')
    expect(refreshCalls).toBe(1)
  })
})
