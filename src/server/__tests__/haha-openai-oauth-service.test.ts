/**
 * Unit tests for HahaOpenAIOAuthService — haha 自管 OpenAI OAuth 的核心 service 层。
 */

import { describe, test, expect, beforeEach, afterEach, spyOn } from 'bun:test'
import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import { createConnection, createServer } from 'net'
import {
  HahaOpenAIOAuthService,
  getHahaOpenAIOAuthFilePath,
  type StoredOpenAIOAuthTokens,
} from '../services/hahaOpenAIOAuthService.js'
import { resetSettingsCache } from '../../utils/settings/settingsCache.js'

let tmpDir: string
let originalConfigDir: string | undefined
let service: HahaOpenAIOAuthService
let callbackPort: number

async function getFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('Failed to allocate test port')))
        return
      }
      const port = address.port
      server.close(() => resolve(port))
    })
  })
}

async function getLocalCallback(
  callbackPath: string,
): Promise<{ status: number; body: string }> {
  return await new Promise((resolve, reject) => {
    const socket = createConnection(
      { host: 'localhost', port: callbackPort },
      () => {
        socket.write(
          `GET ${callbackPath} HTTP/1.1\r\nHost: localhost:${callbackPort}\r\nConnection: close\r\n\r\n`,
        )
      },
    )
    let raw = ''
    socket.setEncoding('utf8')
    socket.on('data', (chunk) => {
      raw += chunk
    })
    socket.on('end', () => {
      const status = Number.parseInt(
        raw.match(/^HTTP\/1\.[01] (\d{3})/)?.[1] ?? '0',
        10,
      )
      const body = raw.split('\r\n\r\n').slice(1).join('\r\n\r\n')
      resolve({ status, body })
    })
    socket.on('error', reject)
  })
}

function mockJwt(payload: Record<string, unknown>): string {
  const encode = (value: Record<string, unknown>) =>
    Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${encode({ alg: 'none' })}.${encode(payload)}.signature`
}

async function setup() {
  tmpDir = await fs.mkdtemp(
    path.join(os.tmpdir(), 'haha-openai-oauth-test-'),
  )
  originalConfigDir = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = tmpDir
  resetSettingsCache()
  callbackPort = await getFreePort()
  service = new HahaOpenAIOAuthService({ callbackPort })
}

async function teardown() {
  service.dispose()
  if (originalConfigDir === undefined) {
    delete process.env.CLAUDE_CONFIG_DIR
  } else {
    process.env.CLAUDE_CONFIG_DIR = originalConfigDir
  }
  resetSettingsCache()
  await fs.rm(tmpDir, { recursive: true, force: true })
}

describe('HahaOpenAIOAuthService — file storage', () => {
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
      idToken: 'mock-id-token',
      email: 'test@example.com',
      accountId: 'acct_123',
      clientId: 'app_EMoamEEZ73f0CkXaXp7hrann',
    }
    await service.saveTokens(tokens)

    const oauthPath = getHahaOpenAIOAuthFilePath()
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

  test('saveTokens cleans up tmp file when rename fails', async () => {
    const renameSpy = spyOn(fs, 'rename').mockImplementation(async () => {
      const error = new Error('rename failed') as NodeJS.ErrnoException
      error.code = 'EXDEV'
      throw error
    })

    try {
      await expect(
        service.saveTokens({
          accessToken: 'sensitive-access',
          refreshToken: 'sensitive-refresh',
          expiresAt: Date.now() + 3600_000,
          idToken: 'sensitive-id-token',
          email: 'test@example.com',
          accountId: 'acct_123',
        }),
      ).rejects.toThrow('rename failed')
    } finally {
      renameSpy.mockRestore()
    }

    const oauthPath = getHahaOpenAIOAuthFilePath()
    const files = await fs.readdir(path.dirname(oauthPath))
    expect(
      files.filter((name) => name.startsWith('openai-oauth.json.tmp.')),
    ).toEqual([])
    expect(await service.loadTokens()).toBeNull()
  })
})

describe('HahaOpenAIOAuthService — session management', () => {
  beforeEach(setup)
  afterEach(teardown)

  test('startSession creates session with PKCE + fixed Codex callback port', async () => {
    const session = await service.startSession({ serverPort: 54321 })
    expect(session.state).toMatch(/^[a-f0-9]{64}$/)
    expect(session.codeVerifier).toMatch(/^[a-f0-9]{128}$/)
    expect(session.authorizeUrl).toContain('code_challenge_method=S256')
    expect(session.authorizeUrl).toContain(
      `state=${encodeURIComponent(session.state)}`,
    )
    expect(session.authorizeUrl).toContain(
      'codex_cli_simplified_flow=true',
    )
    expect(session.authorizeUrl).toContain(
      encodeURIComponent(`http://localhost:${callbackPort}/auth/callback`),
    )
    expect(session.authorizeUrl).not.toContain(
      encodeURIComponent('http://localhost:54321/auth/callback'),
    )
    expect(session.authorizeUrl).not.toContain('originator=')
  })

  test('getSession returns stored session by state', async () => {
    const session = await service.startSession({ serverPort: 54321 })
    const found = service.getSession(session.state)
    expect(found?.codeVerifier).toBe(session.codeVerifier)
  })

  test('getSession returns null for unknown state', () => {
    expect(service.getSession('unknown-state')).toBeNull()
  })

  test('consumeSession removes session after fetch', async () => {
    const session = await service.startSession({ serverPort: 54321 })
    expect(service.consumeSession(session.state)).not.toBeNull()
    expect(service.getSession(session.state)).toBeNull()
  })

  test('callback listener exchanges the authorization code and saves tokens', async () => {
    const originalFetch = globalThis.fetch
    const session = await service.startSession({ serverPort: 54321 })
    let tokenRequestBody = ''

    globalThis.fetch = (async (_url, init) => {
      tokenRequestBody = String(init?.body ?? '')
      return new Response(
        JSON.stringify({
          access_token: 'openai-access-token',
          refresh_token: 'openai-refresh-token',
          expires_in: 3600,
          id_token: mockJwt({
            email: 'test@example.com',
            'https://api.openai.com/auth': {
              chatgpt_account_id: 'acct_123',
            },
          }),
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    }) as typeof fetch

    try {
      const res = await getLocalCallback(
        `/auth/callback?code=auth-code&state=${session.state}`,
      )

      expect(res.status).toBe(200)
      expect(res.body).toContain('OpenAI Login Successful')
      expect(tokenRequestBody).toContain('code=auth-code')
      expect(tokenRequestBody).toContain(
        `redirect_uri=${encodeURIComponent(`http://localhost:${callbackPort}/auth/callback`)}`,
      )
      expect(tokenRequestBody).toContain(
        `code_verifier=${session.codeVerifier}`,
      )

      const tokens = await service.loadTokens()
      expect(tokens?.accessToken).toBe('openai-access-token')
      expect(tokens?.refreshToken).toBe('openai-refresh-token')
      expect(tokens?.email).toBe('test@example.com')
      expect(tokens?.accountId).toBe('acct_123')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('callback listener uses saved manual network proxy for token exchange', async () => {
    const originalFetch = globalThis.fetch
    await fs.writeFile(
      path.join(tmpDir, 'settings.json'),
      JSON.stringify({
        network: {
          aiRequestTimeoutMs: 45_000,
          proxy: {
            mode: 'manual',
            url: ' http://127.0.0.1:7890 ',
          },
        },
      }),
      'utf-8',
    )
    resetSettingsCache()

    const session = await service.startSession({ serverPort: 54321 })
    let tokenRequestInit: RequestInit | undefined

    globalThis.fetch = (async (_url, init) => {
      tokenRequestInit = init
      return new Response(
        JSON.stringify({
          access_token: 'openai-access-token',
          refresh_token: 'openai-refresh-token',
          expires_in: 3600,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    }) as typeof fetch

    try {
      const res = await getLocalCallback(
        `/auth/callback?code=auth-code&state=${session.state}`,
      )

      expect(res.status).toBe(200)
      expect((tokenRequestInit as { proxy?: string } | undefined)?.proxy).toBe(
        'http://127.0.0.1:7890',
      )
      expect(tokenRequestInit?.signal).toBeInstanceOf(AbortSignal)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('callback listener renders an error page when token exchange fails', async () => {
    const originalFetch = globalThis.fetch
    const session = await service.startSession({ serverPort: 54321 })

    globalThis.fetch = (async () => {
      return new Response('bad request', { status: 400 })
    }) as typeof fetch

    try {
      const res = await getLocalCallback(
        `/auth/callback?code=bad-code&state=${session.state}`,
      )

      expect(res.status).toBe(200)
      expect(res.body).toContain('OpenAI Login Failed')
      expect(res.body).toContain('OpenAI token exchange failed: 400')
      expect(await service.loadTokens()).toBeNull()
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('callback listener clears the session after an invalid callback', async () => {
    const consoleSpy = spyOn(console, 'error').mockImplementation(() => {})
    const session = await service.startSession({ serverPort: 54321 })

    try {
      const res = await getLocalCallback(`/auth/callback?state=${session.state}`)

      expect(res.status).toBe(400)
      expect(res.body).toContain('Authorization code not found')
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(service.getSession(session.state)).toBeNull()
    } finally {
      consoleSpy.mockRestore()
    }
  })
})

describe('HahaOpenAIOAuthService — ensureFreshAccessToken', () => {
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

  test('preserves existing refresh token and id token when refresh omits them', async () => {
    await service.saveTokens({
      accessToken: 'expired',
      refreshToken: 'refresh-to-preserve',
      expiresAt: Date.now() + 60_000,
      idToken: 'id-token-to-preserve',
      email: 'test@example.com',
      accountId: 'acct_123',
      clientId: 'app_EMoamEEZ73f0CkXaXp7hrann',
    })

    service.setRefreshFn(async () => ({
      access_token: 'new-access-token',
      expires_in: 3600,
    }))

    const fresh = await service.ensureFreshAccessToken()
    expect(fresh).toBe('new-access-token')

    const loaded = await service.loadTokens()
    expect(loaded?.refreshToken).toBe('refresh-to-preserve')
    expect(loaded?.idToken).toBe('id-token-to-preserve')
    expect(loaded?.clientId).toBe('app_EMoamEEZ73f0CkXaXp7hrann')
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
