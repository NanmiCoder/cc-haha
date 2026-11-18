/**
 * Claude subscription usage for the desktop (#1804): GET /api/haha-oauth/usage and
 * HahaOAuthService.getPlanUsage. Network calls are stubbed or go to a loopback server.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import { handleHahaOAuthApi } from '../api/haha-oauth.js'
import {
  fetchClaudePlanUsage,
  HahaOAuthService,
  hahaOAuthService,
  type StoredOAuthTokens,
} from '../services/hahaOAuthService.js'
import { SYSTEM_PROXY_URL_ENV } from '../services/networkSettings.js'

const PROFILE_TOKENS: StoredOAuthTokens = {
  accessToken: 'usage-access-token',
  refreshToken: 'usage-refresh-token',
  expiresAt: Date.now() + 60 * 60_000,
  scopes: ['user:inference', 'user:profile'],
  subscriptionType: 'max',
}

const USAGE = {
  five_hour: { utilization: 42, resets_at: '2026-11-08T18:00:00.000Z' },
  seven_day: { utilization: 7, resets_at: '2026-11-12T09:00:00.000Z' },
}

// The inherited proxy variables are cleared too: with one set in the shell that
// runs the tests, the "no proxy configured" cases would read it.
const INHERITED_PROXY_ENV_KEYS = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy'] as const
const ENV_KEYS = [
  'CLAUDE_CONFIG_DIR',
  SYSTEM_PROXY_URL_ENV,
  ...INHERITED_PROXY_ENV_KEYS,
  'USER_TYPE',
  'USE_LOCAL_OAUTH',
  'CLAUDE_LOCAL_OAUTH_API_BASE',
] as const
let saved: Record<string, string | undefined> = {}
let tmpDir = ''
let service: HahaOAuthService

function httpError(status: number) {
  return Object.assign(new Error(`HTTP ${status}`), { isAxiosError: true, response: { status } })
}

beforeEach(async () => {
  saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]))
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'haha-oauth-usage-test-'))
  process.env.CLAUDE_CONFIG_DIR = tmpDir
  delete process.env[SYSTEM_PROXY_URL_ENV]
  for (const key of INHERITED_PROXY_ENV_KEYS) delete process.env[key]
  service = new HahaOAuthService()
})

afterEach(async () => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
  hahaOAuthService.setFetchPlanUsageFn()
  await fs.rm(tmpDir, { recursive: true, force: true })
})

describe('HahaOAuthService.getPlanUsage', () => {
  test('says the account is not logged in without calling the usage endpoint', async () => {
    let calls = 0
    service.setFetchPlanUsageFn(async () => { calls += 1; return USAGE })

    const result = await service.getPlanUsage()

    expect(result).toMatchObject({ available: false, reason: 'not_logged_in' })
    expect(Number.isNaN(Date.parse(result.fetchedAt))).toBe(false)
    expect(calls).toBe(0)
  })

  test('asks for a new login when the token was issued without the profile scope', async () => {
    await service.saveTokens({ ...PROFILE_TOKENS, scopes: ['user:inference'] })
    let calls = 0
    service.setFetchPlanUsageFn(async () => { calls += 1; return USAGE })

    expect(await service.getPlanUsage()).toMatchObject({ available: false, reason: 'missing_scope' })
    expect(calls).toBe(0)
  })

  test('returns the subscription usage read with the stored access token', async () => {
    await service.saveTokens(PROFILE_TOKENS)
    const seen: Array<{ token: string; proxyUrl: string | null | undefined }> = []
    service.setFetchPlanUsageFn(async (token, opts) => { seen.push({ token, proxyUrl: opts?.proxyUrl }); return USAGE })

    const result = await service.getPlanUsage()

    expect(result).toMatchObject({ available: true, usage: USAGE })
    expect(seen).toEqual([{ token: 'usage-access-token', proxyUrl: null }])
  })

  test('refreshes a rejected token once and reads the usage with the new one', async () => {
    await service.saveTokens(PROFILE_TOKENS)
    service.setRefreshFn(async () => ({
      accessToken: 'usage-refreshed-token',
      refreshToken: 'usage-refresh-next',
      expiresAt: Date.now() + 60 * 60_000,
      scopes: ['user:inference', 'user:profile'],
      subscriptionType: 'max',
      rateLimitTier: null,
    }))
    const tokens: string[] = []
    service.setFetchPlanUsageFn(async (token) => {
      tokens.push(token)
      if (token === 'usage-access-token') throw httpError(401)
      return USAGE
    })

    expect(await service.getPlanUsage()).toMatchObject({ available: true, usage: USAGE })
    expect(tokens).toEqual(['usage-access-token', 'usage-refreshed-token'])
  })

  test('reports a failed request with its HTTP status instead of throwing', async () => {
    await service.saveTokens(PROFILE_TOKENS)
    service.setFetchPlanUsageFn(async () => { throw httpError(503) })

    expect(await service.getPlanUsage()).toMatchObject({ available: false, reason: 'request_failed', status: 503 })
  })
})

describe('fetchClaudePlanUsage', () => {
  test('sends the OAuth bearer token and beta header to /api/oauth/usage', async () => {
    const received: Array<{ path: string; authorization: string | null; beta: string | null }> = []
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(req) {
        received.push({
          path: new URL(req.url).pathname,
          authorization: req.headers.get('authorization'),
          beta: req.headers.get('anthropic-beta'),
        })
        return Response.json(USAGE)
      },
    })
    try {
      // The local OAuth configuration is the only way to point the official
      // endpoints at a loopback server; production URLs stay allowlisted.
      process.env.USER_TYPE = 'ant'
      process.env.USE_LOCAL_OAUTH = '1'
      process.env.CLAUDE_LOCAL_OAUTH_API_BASE = `http://127.0.0.1:${server.port}`

      const usage = await fetchClaudePlanUsage('loopback-token', { proxyUrl: null })

      expect(usage).toEqual(USAGE)
      expect(received).toEqual([{ path: '/api/oauth/usage', authorization: 'Bearer loopback-token', beta: 'oauth-2025-04-20' }])
    } finally {
      server.stop(true)
    }
  })
})

describe('GET /api/haha-oauth/usage', () => {
  test('answers with the plan usage of the logged-in account', async () => {
    await hahaOAuthService.saveTokens(PROFILE_TOKENS)
    hahaOAuthService.setFetchPlanUsageFn(async () => USAGE)
    const url = new URL('http://localhost:3456/api/haha-oauth/usage')

    const res = await handleHahaOAuthApi(new Request(url), url, url.pathname.split('/').filter(Boolean))

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ available: true, usage: USAGE })
  })

  test('answers not logged in when no Claude account is connected', async () => {
    const url = new URL('http://localhost:3456/api/haha-oauth/usage')

    const res = await handleHahaOAuthApi(new Request(url), url, url.pathname.split('/').filter(Boolean))

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ available: false, reason: 'not_logged_in' })
  })
})
