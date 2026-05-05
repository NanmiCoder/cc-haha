/**
 * Integration tests for /api/yuanclaw-openai-oauth/* endpoints.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import { handleYuanclawOpenAIOAuthApi } from '../api/yuanclaw-openai-oauth.js'
import { yuanclawOpenAIOAuthService } from '../services/yuanclawOpenAIOAuthService.js'

let tmpDir: string
let originalConfigDir: string | undefined

async function setup() {
  tmpDir = await fs.mkdtemp(
    path.join(os.tmpdir(), 'yuanclaw-openai-oauth-api-test-'),
  )
  originalConfigDir = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = tmpDir
}

async function teardown() {
  if (originalConfigDir === undefined) {
    delete process.env.CLAUDE_CONFIG_DIR
  } else {
    process.env.CLAUDE_CONFIG_DIR = originalConfigDir
  }
  await fs.rm(tmpDir, { recursive: true, force: true })
}

function buildReq(
  method: string,
  pathname: string,
  body?: unknown,
): { req: Request; url: URL; segments: string[] } {
  const url = new URL(`http://localhost:3456${pathname}`)
  const req = new Request(url.toString(), {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  const segments = url.pathname.split('/').filter(Boolean)
  return { req, url, segments }
}

describe('POST /api/yuanclaw-openai-oauth/start', () => {
  beforeEach(setup)
  afterEach(teardown)

  test('returns authorize URL with PKCE challenge', async () => {
    const { req, url, segments } = buildReq(
      'POST',
      '/api/yuanclaw-openai-oauth/start',
      { serverPort: 54321 },
    )
    const res = await handleYuanclawOpenAIOAuthApi(req, url, segments)
    expect(res.status).toBe(200)
    const data = (await res.json()) as { authorizeUrl: string; state: string }
    expect(data.authorizeUrl).toContain('code_challenge_method=S256')
    expect(data.authorizeUrl).toContain(
      'codex_cli_simplified_flow=true',
    )
    expect(data.authorizeUrl).toContain(
      encodeURIComponent('http://localhost:54321/auth/callback'),
    )
    expect(data.state).toMatch(/^[A-Za-z0-9_-]+$/)
  })

  test('400 if serverPort missing', async () => {
    const { req, url, segments } = buildReq(
      'POST',
      '/api/yuanclaw-openai-oauth/start',
      {},
    )
    const res = await handleYuanclawOpenAIOAuthApi(req, url, segments)
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string; message?: string }
    expect(body.error).toBe('BAD_REQUEST')
  })
})

describe('GET /api/yuanclaw-openai-oauth', () => {
  beforeEach(setup)
  afterEach(teardown)

  test('returns loggedIn=false when no token file', async () => {
    const { req, url, segments } = buildReq('GET', '/api/yuanclaw-openai-oauth')
    const res = await handleYuanclawOpenAIOAuthApi(req, url, segments)
    expect(res.status).toBe(200)
    const data = (await res.json()) as { loggedIn: boolean }
    expect(data.loggedIn).toBe(false)
  })

  test('returns loggedIn=true + metadata when token saved', async () => {
    await yuanclawOpenAIOAuthService.saveTokens({
      accessToken: 'openai-access-token-xxx',
      refreshToken: 'openai-refresh-token-xxx',
      expiresAt: Date.now() + 3600_000,
      email: 'test@example.com',
      accountId: 'acct_123',
    })

    const { req, url, segments } = buildReq('GET', '/api/yuanclaw-openai-oauth')
    const res = await handleYuanclawOpenAIOAuthApi(req, url, segments)
    expect(res.status).toBe(200)
    const data = (await res.json()) as {
      loggedIn: boolean
      expiresAt: number | null
      email: string | null
      accountId: string | null
    }
    expect(data.loggedIn).toBe(true)
    expect(data.email).toBe('test@example.com')
    expect(data.accountId).toBe('acct_123')
    // Never leak token values
    expect(JSON.stringify(data)).not.toContain('openai-access-token')
    expect(JSON.stringify(data)).not.toContain('openai-refresh-token')
  })

  test('returns loggedIn=false when stored token is expired and refresh fails', async () => {
    await yuanclawOpenAIOAuthService.saveTokens({
      accessToken: 'expired-token',
      refreshToken: 'revoked-refresh-token',
      expiresAt: Date.now() - 1_000,
      email: 'test@example.com',
      accountId: 'acct_123',
    })
    yuanclawOpenAIOAuthService.setRefreshFn(async () => {
      throw new Error('refresh revoked')
    })

    const { req, url, segments } = buildReq('GET', '/api/yuanclaw-openai-oauth')
    const res = await handleYuanclawOpenAIOAuthApi(req, url, segments)

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ loggedIn: false })
  })
})

describe('DELETE /api/yuanclaw-openai-oauth', () => {
  beforeEach(setup)
  afterEach(teardown)

  test('clears token file', async () => {
    await yuanclawOpenAIOAuthService.saveTokens({
      accessToken: 'a',
      refreshToken: null,
      expiresAt: null,
      email: null,
      accountId: null,
    })

    const { req, url, segments } = buildReq('DELETE', '/api/yuanclaw-openai-oauth')
    const res = await handleYuanclawOpenAIOAuthApi(req, url, segments)
    expect(res.status).toBe(200)
    expect(await yuanclawOpenAIOAuthService.loadTokens()).toBeNull()
  })
})
