/**
 * Unit tests for YuanclawOpenAIOAuthService — yuanclaw 自管 OpenAI OAuth 的核心 service 层。
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import {
  YuanclawOpenAIOAuthService,
  type StoredOpenAIOAuthTokens,
} from '../services/yuanclawOpenAIOAuthService.js'

let tmpDir: string
let originalConfigDir: string | undefined
let service: YuanclawOpenAIOAuthService

async function setup() {
  tmpDir = await fs.mkdtemp(
    path.join(os.tmpdir(), 'yuanclaw-openai-oauth-test-'),
  )
  originalConfigDir = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = tmpDir
  service = new YuanclawOpenAIOAuthService()
}

async function teardown() {
  if (originalConfigDir === undefined) {
    delete process.env.CLAUDE_CONFIG_DIR
  } else {
    process.env.CLAUDE_CONFIG_DIR = originalConfigDir
  }
  await fs.rm(tmpDir, { recursive: true, force: true })
}

describe('YuanclawOpenAIOAuthService — file storage', () => {
  beforeEach(setup)
  afterEach(teardown)

  test('loadTokens returns null when file does not exist', async () => {
    expect(await service.loadTokens()).toBeNull()
  })

  test('saveTokens writes file with 0600 permissions', async () => {
    const tokens: StoredOpenAIOAuthTokens = {
      accessToken: 'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.mock-access',
      refreshToken: 'eyJhbGciOiJSUzI1NiJ9.mock-refresh',
      expiresAt: Date.now() + 3600_000,
      email: 'test@example.com',
      accountId: 'acct_123',
    }
    await service.saveTokens(tokens)

    const oauthPath = path.join(tmpDir, 'yuanclaw', 'openai-oauth.json')
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
      email: null,
      accountId: null,
    })
    await service.deleteTokens()
    expect(await service.loadTokens()).toBeNull()
  })
})

describe('YuanclawOpenAIOAuthService — session management', () => {
  beforeEach(setup)
  afterEach(teardown)

  test('startSession creates session with PKCE + state', () => {
    const session = service.startSession({ serverPort: 54321 })
    expect(session.state).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(session.codeVerifier).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(session.authorizeUrl).toContain('code_challenge_method=S256')
    expect(session.authorizeUrl).toContain(
      `state=${encodeURIComponent(session.state)}`,
    )
    expect(session.authorizeUrl).toContain(
      'codex_cli_simplified_flow=true',
    )
    expect(session.authorizeUrl).toContain(
      encodeURIComponent('http://localhost:54321/auth/callback'),
    )
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
})

describe('YuanclawOpenAIOAuthService — ensureFreshAccessToken', () => {
  beforeEach(setup)
  afterEach(teardown)

  test('returns null when no token file exists', async () => {
    expect(await service.ensureFreshAccessToken()).toBeNull()
  })

  test('returns token unchanged if not expired', async () => {
    const tokens: StoredOpenAIOAuthTokens = {
      accessToken: 'still-valid',
      refreshToken: 'refresh-xxx',
      expiresAt: Date.now() + 30 * 60_000,
      email: 'test@example.com',
      accountId: 'acct_123',
    }
    await service.saveTokens(tokens)

    expect(await service.ensureFreshAccessToken()).toBe('still-valid')
  })

  test('returns null when tokens expired and no refresh token', async () => {
    await service.saveTokens({
      accessToken: 'expired',
      refreshToken: null,
      expiresAt: Date.now() - 1_000,
      email: null,
      accountId: null,
    })

    expect(await service.ensureFreshAccessToken()).toBeNull()
  })

  test('refreshes token when expired (within 5-min buffer)', async () => {
    await service.saveTokens({
      accessToken: 'expired',
      refreshToken: 'refresh-xxx',
      expiresAt: Date.now() + 60_000,
      email: 'test@example.com',
      accountId: 'acct_123',
    })

    service.setRefreshFn(async () => ({
      access_token: 'new-fresh-token',
      refresh_token: 'new-refresh-xxx',
      expires_in: 3600,
      id_token: 'mock-id-token',
    }))

    const fresh = await service.ensureFreshAccessToken()
    expect(fresh).toBe('new-fresh-token')

    const loaded = await service.loadTokens()
    expect(loaded?.accessToken).toBe('new-fresh-token')
  })

  test('returns null when refresh fails', async () => {
    await service.saveTokens({
      accessToken: 'expired',
      refreshToken: 'bad-refresh',
      expiresAt: Date.now() + 60_000,
      email: null,
      accountId: null,
    })
    service.setRefreshFn(async () => {
      throw new Error('401 Unauthorized')
    })

    expect(await service.ensureFreshAccessToken()).toBeNull()
  })
})
