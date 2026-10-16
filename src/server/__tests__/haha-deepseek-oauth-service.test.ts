import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createHash } from 'crypto'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import {
  HahaDeepSeekOAuthService,
  getHahaDeepSeekOAuthFilePath,
} from '../services/hahaDeepSeekOAuthService.js'
import { resetSettingsCache } from '../../utils/settings/settingsCache.js'

type Recorded = {
  path: string
  headers: Headers
  body: Record<string, unknown> | null
}

let tempDir: string
let previousConfigDir: string | undefined
let previousPlatformOrigin: string | undefined
let platform: ReturnType<typeof Bun.serve>
let recorded: Recorded[]
let exchangeStatus: number
let exchangeGate: Promise<void> | null
let profileStatus: number
let profileData: unknown
let platformOmitsUser: boolean
let service: HahaDeepSeekOAuthService

function envelope(data: unknown): Response {
  return Response.json({ code: 0, data: { biz_code: 0, biz_data: data } })
}

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'haha-deepseek-oauth-'))
  previousConfigDir = process.env.CLAUDE_CONFIG_DIR
  previousPlatformOrigin = process.env.CC_HAHA_DEEPSEEK_PLATFORM_ORIGIN
  process.env.CLAUDE_CONFIG_DIR = tempDir
  resetSettingsCache()
  recorded = []
  exchangeStatus = 200
  exchangeGate = null
  profileStatus = 200
  profileData = null
  platformOmitsUser = false
  platform = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(request) {
      const url = new URL(request.url)
      const text = await request.text()
      recorded.push({
        path: url.pathname,
        headers: request.headers,
        body: text ? (JSON.parse(text) as Record<string, unknown>) : null,
      })
      const origin = url.origin
      if (url.pathname === '/auth-api/v0/dsh/auth_init') {
        return envelope({
          authorize_url: `${origin}/dsh/authorize?authorize_id=attempt-1`,
          authorize_id: 'attempt-1',
          expires_in: 600,
        })
      }
      if (url.pathname === '/auth-api/v0/dsh/auth_exchange') {
        if (exchangeGate) await exchangeGate
        if (exchangeStatus !== 200) return new Response('no', { status: exchangeStatus })
        return envelope({
          token: 'dsh_test_account_token',
          authorized_url: `${origin}/dsh/authorized?ok=1`,
          ...(platformOmitsUser
            ? {}
            : { user: { email: 'u***@example.com', id_profile: { name: 'Test User' } } }),
        })
      }
      if (url.pathname === '/auth-api/v0/users/current') {
        if (profileStatus !== 200) return new Response('no', { status: profileStatus })
        return envelope(profileData)
      }
      return envelope(null)
    },
  })
  process.env.CC_HAHA_DEEPSEEK_PLATFORM_ORIGIN = `http://127.0.0.1:${platform.port}`
  service = new HahaDeepSeekOAuthService()
})

afterEach(async () => {
  service.dispose()
  await platform.stop(true)
  if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = previousConfigDir
  if (previousPlatformOrigin === undefined) {
    delete process.env.CC_HAHA_DEEPSEEK_PLATFORM_ORIGIN
  } else {
    process.env.CC_HAHA_DEEPSEEK_PLATFORM_ORIGIN = previousPlatformOrigin
  }
  resetSettingsCache()
  await fs.rm(tempDir, { recursive: true, force: true })
})

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error('condition not met in time')
}

describe('HahaDeepSeekOAuthService', () => {
  test('runs the PKCE browser flow and stores the opaque account token', async () => {
    const session = await service.startSession({ locale: 'zh-CN' })

    const init = recorded.find((r) => r.path === '/auth-api/v0/dsh/auth_init')!
    expect(init.body).toMatchObject({
      code_challenge_method: 'S256',
      state: session.state,
      locale: 'zh_CN',
      login_source: 'web',
    })
    const redirect = new URL(String(init.body!.redirect_uri))
    expect(redirect.hostname).toBe('127.0.0.1')
    expect(redirect.pathname).toBe('/oauth/callback')
    expect(init.headers.get('x-client-locale')).toBe('zh_CN')
    expect(init.headers.get('x-client-bundle-id')).toBe('')
    expect(new URL(session.authorizeUrl).pathname).toBe('/dsh/authorize')

    const callback = new URL(session.redirectUri)
    callback.searchParams.set('code', 'one-time-code')
    callback.searchParams.set('state', session.state)
    const response = await fetch(callback, { redirect: 'manual' })

    // The browser is sent on to the platform's completion page, and only once
    // the grant is persisted.
    expect(response.status).toBe(302)
    const location = new URL(response.headers.get('location')!)
    expect(location.pathname).toBe('/dsh/authorized')
    expect(location.searchParams.get('login_source')).toBe('web')

    const exchange = recorded.find((r) => r.path === '/auth-api/v0/dsh/auth_exchange')!
    expect(exchange.body).toMatchObject({
      code: 'one-time-code',
      redirect_uri: session.redirectUri,
    })
    const verifier = String(exchange.body!.code_verifier)
    expect(createHash('sha256').update(verifier).digest('base64url')).toBe(
      String(init.body!.code_challenge),
    )

    const tokens = await service.loadTokens()
    expect(tokens).toMatchObject({
      token: 'dsh_test_account_token',
      issuer: process.env.CC_HAHA_DEEPSEEK_PLATFORM_ORIGIN,
      name: 'Test User',
      contact: 'u***@example.com',
    })
    expect(tokens!.deviceId).toBe(String(exchange.body!.device_id))
    if (process.platform !== 'win32') {
      expect((await fs.stat(getHahaDeepSeekOAuthFilePath())).mode & 0o777).toBe(0o600)
    }
    await expect(service.getStatus()).resolves.toEqual({
      loggedIn: true,
      name: 'Test User',
      contact: 'u***@example.com',
    })
  })

  test('ignores a callback with the wrong state and stores nothing', async () => {
    const session = await service.startSession()
    const callback = new URL(session.redirectUri)
    callback.searchParams.set('code', 'one-time-code')
    callback.searchParams.set('state', 'attacker-state')
    const response = await fetch(callback)
    expect(response.status).toBe(400)
    expect(recorded.some((r) => r.path.endsWith('/auth_exchange'))).toBe(false)
    await expect(service.getStatus()).resolves.toEqual({ loggedIn: false })
  })

  test('shows a failure page and stays signed out when the exchange is rejected', async () => {
    exchangeStatus = 500
    const session = await service.startSession()
    const callback = new URL(session.redirectUri)
    callback.searchParams.set('code', 'one-time-code')
    callback.searchParams.set('state', session.state)
    const response = await fetch(callback, { redirect: 'manual' })
    expect(response.status).toBe(200)
    expect(await response.text()).toContain('DeepSeek Login Failed')
    await expect(service.getStatus()).resolves.toEqual({ loggedIn: false })
  })

  test('cancels the unexchanged attempt on the platform when a new login replaces it', async () => {
    const first = await service.startSession()
    await service.startSession()
    await waitFor(() => recorded.some((r) => r.path === '/auth-api/v0/dsh/auth_cancel'))
    const cancel = recorded.find((r) => r.path === '/auth-api/v0/dsh/auth_cancel')!
    expect(cancel.body).toEqual({
      authorize_id: 'attempt-1',
      code_verifier: expect.any(String),
    })
    expect(createHash('sha256').update(String(cancel.body!.code_verifier)).digest('base64url'))
      .toBe(
        String(
          recorded.find((r) => r.path === '/auth-api/v0/dsh/auth_init')!.body!
            .code_challenge,
        ),
      )
    // The first attempt's loopback listener was released (the OS may hand the
    // same port to the next listener, so probe the handle, not the port).
    expect(first.authCodeListener).toBeUndefined()
  })

  test('a sign-out during the code exchange does not resurrect the grant', async () => {
    let release!: () => void
    exchangeGate = new Promise<void>((resolve) => { release = resolve })
    const session = await service.startSession()
    const callback = new URL(session.redirectUri)
    callback.searchParams.set('code', 'one-time-code')
    callback.searchParams.set('state', session.state)
    const browser = fetch(callback, { redirect: 'manual' })
    await waitFor(() => recorded.some((r) => r.path === '/auth-api/v0/dsh/auth_exchange'))

    await service.logout()
    release()
    const response = await browser

    expect(response.status).toBe(200)
    await expect(service.getStatus()).resolves.toEqual({ loggedIn: false })
    // The token the platform minted for the abandoned exchange is revoked.
    await waitFor(() => recorded.some((r) => r.path === '/auth-api/v0/users/logout'))
    expect(
      recorded.find((r) => r.path === '/auth-api/v0/users/logout')!.headers.get('x-dsh-auth-token'),
    ).toBe('dsh_test_account_token')
  })

  test('revokes the minted token when persisting the grant fails', async () => {
    // A directory where the token file belongs makes the atomic rename fail.
    await fs.mkdir(getHahaDeepSeekOAuthFilePath(), { recursive: true })
    const session = await service.startSession()
    const callback = new URL(session.redirectUri)
    callback.searchParams.set('code', 'one-time-code')
    callback.searchParams.set('state', session.state)
    const response = await fetch(callback, { redirect: 'manual' })

    expect(response.status).toBe(200)
    expect(await response.text()).toContain('DeepSeek Login Failed')
    await waitFor(() => recorded.some((r) => r.path === '/auth-api/v0/users/logout'))
  })

  test('releases the attempt on the platform when the callback is invalid', async () => {
    const session = await service.startSession()
    const callback = new URL(session.redirectUri)
    callback.searchParams.set('error', 'access_denied')
    callback.searchParams.set('state', session.state)
    await fetch(callback)

    await waitFor(() => recorded.some((r) => r.path === '/auth-api/v0/dsh/auth_cancel'))
    expect(recorded.find((r) => r.path === '/auth-api/v0/dsh/auth_cancel')!.body)
      .toMatchObject({ authorize_id: 'attempt-1' })
  })

  test('logout removes the grant locally and revokes it with the account header', async () => {
    await service.saveTokens({
      token: 'dsh_test_account_token',
      issuer: process.env.CC_HAHA_DEEPSEEK_PLATFORM_ORIGIN!,
      deviceId: 'device-1',
    })
    await service.logout()
    await expect(service.loadTokens()).resolves.toBeNull()
    await waitFor(() => recorded.some((r) => r.path === '/auth-api/v0/users/logout'))
    const logout = recorded.find((r) => r.path === '/auth-api/v0/users/logout')!
    expect(logout.headers.get('x-dsh-auth-token')).toBe('dsh_test_account_token')
  })

  test('a platform-revoked grant stops showing as signed in and is forgotten locally', async () => {
    await service.saveTokens({
      token: 'dsh_test_account_token',
      issuer: process.env.CC_HAHA_DEEPSEEK_PLATFORM_ORIGIN!,
      deviceId: 'device-1',
      name: 'Test User',
    })
    profileStatus = 401

    await expect(service.getStatus()).resolves.toEqual({ loggedIn: false })
    await expect(service.loadTokens()).resolves.toBeNull()
    expect(
      recorded.find((r) => r.path === '/auth-api/v0/users/current')!.headers.get('x-dsh-auth-token'),
    ).toBe('dsh_test_account_token')
  })

  test('an unreachable platform keeps the stored login and is not asked again immediately', async () => {
    await service.saveTokens({
      token: 'dsh_test_account_token',
      issuer: process.env.CC_HAHA_DEEPSEEK_PLATFORM_ORIGIN!,
      deviceId: 'device-1',
      name: 'Test User',
    })
    profileStatus = 503

    await expect(service.getStatus()).resolves.toMatchObject({ loggedIn: true, name: 'Test User' })
    await expect(service.getStatus()).resolves.toMatchObject({ loggedIn: true })
    expect(recorded.filter((r) => r.path === '/auth-api/v0/users/current')).toHaveLength(1)
    await expect(service.loadTokens()).resolves.not.toBeNull()
  })

  test('fills in the account name from the profile when the grant was stored without one', async () => {
    await service.saveTokens({
      token: 'dsh_test_account_token',
      issuer: process.env.CC_HAHA_DEEPSEEK_PLATFORM_ORIGIN!,
      deviceId: 'device-1',
    })
    profileData = { email: 'p***@example.com', id_profile: { name: 'Profile User' } }

    await expect(service.getStatus()).resolves.toEqual({
      loggedIn: true,
      name: 'Profile User',
      contact: 'p***@example.com',
    })
    await expect(service.loadTokens()).resolves.toMatchObject({ name: 'Profile User' })
  })

  test('reads the profile after login when the exchange response carries no user', async () => {
    profileData = { email: 'p***@example.com', id_profile: { name: 'Profile User' } }
    platformOmitsUser = true
    const session = await service.startSession()
    const callback = new URL(session.redirectUri)
    callback.searchParams.set('code', 'one-time-code')
    callback.searchParams.set('state', session.state)
    const response = await fetch(callback, { redirect: 'manual' })

    expect(response.status).toBe(302)
    await expect(service.loadTokens()).resolves.toMatchObject({
      name: 'Profile User',
      contact: 'p***@example.com',
    })
  })

  test('two overlapping starts leave exactly one live attempt', async () => {
    const [first, second] = await Promise.allSettled([
      service.startSession(),
      service.startSession(),
    ])

    expect(first.status).toBe('rejected')
    expect(second.status).toBe('fulfilled')
    expect(recorded.filter((r) => r.path === '/auth-api/v0/dsh/auth_init')).toHaveLength(1)

    const live = (second as PromiseFulfilledResult<{ redirectUri: string; state: string }>).value
    const callback = new URL(live.redirectUri)
    callback.searchParams.set('code', 'one-time-code')
    callback.searchParams.set('state', live.state)
    expect((await fetch(callback, { redirect: 'manual' })).status).toBe(302)
    await expect(service.getStatus()).resolves.toMatchObject({ loggedIn: true })
  })

  test('a sign-out while a login is still starting does not leave an attempt open', async () => {
    const starting = service.startSession()
    const outcome = starting.then(
      () => 'started',
      () => 'rejected',
    )
    await service.logout()

    await expect(outcome).resolves.toBe('rejected')
    expect(recorded.some((r) => r.path === '/auth-api/v0/dsh/auth_init')).toBe(false)
  })

  test('does not treat a grant from another platform origin as signed in', async () => {
    await service.saveTokens({
      token: 'dsh_mock_token',
      issuer: 'http://127.0.0.1:9',
      deviceId: 'device-1',
    })
    await expect(service.getStatus()).resolves.toEqual({ loggedIn: false })
  })
})
