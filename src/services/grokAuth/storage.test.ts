import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import {
  getGrokOAuthTokens,
  getGrokOAuthTokensAsync,
  GROK_OAUTH_FILE_ENV_KEY,
  saveGrokOAuthTokens,
} from './storage.js'

describe('Grok OAuth desktop token file', () => {
  let tmpDir: string
  let tokenFile: string
  let original: string | undefined

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'grok-oauth-'))
    tokenFile = path.join(tmpDir, 'tokens.json')
    original = process.env[GROK_OAUTH_FILE_ENV_KEY]
    process.env[GROK_OAUTH_FILE_ENV_KEY] = tokenFile
  })

  afterEach(async () => {
    if (original === undefined) delete process.env[GROK_OAUTH_FILE_ENV_KEY]
    else process.env[GROK_OAUTH_FILE_ENV_KEY] = original
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  test('reads camelCase desktop tokens without modifying the file', async () => {
    const raw = JSON.stringify({
      accessToken: 'access',
      refreshToken: 'refresh',
      expiresAt: 4_100_000_000_000,
      email: 'user@example.com',
    })
    await fs.writeFile(tokenFile, raw)

    expect(getGrokOAuthTokens()).toMatchObject({ accessToken: 'access' })
    await expect(getGrokOAuthTokensAsync()).resolves.toMatchObject({
      refreshToken: 'refresh',
    })
    expect(await fs.readFile(tokenFile, 'utf8')).toBe(raw)
  })

  test('accepts xAI snake_case token response fields and rejects missing authority', async () => {
    await fs.writeFile(tokenFile, JSON.stringify({
      access_token: 'access',
      refresh_token: 'refresh',
      expires_at: '2099-01-01T00:00:00.000Z',
      token_type: 'Bearer',
    }))
    expect(getGrokOAuthTokens()).toMatchObject({
      accessToken: 'access',
      refreshToken: 'refresh',
      tokenType: 'Bearer',
    })

    delete process.env[GROK_OAUTH_FILE_ENV_KEY]
    expect(getGrokOAuthTokens()).toBeNull()
    await expect(getGrokOAuthTokensAsync()).resolves.toBeNull()
  })

  test('atomically persists refreshed tokens for desktop and rotated refresh tokens', async () => {
    expect(saveGrokOAuthTokens({
      accessToken: 'fresh-access',
      refreshToken: 'rotated-refresh',
      expiresAt: 4_100_000_000_000,
    })).toBe(true)
    await expect(getGrokOAuthTokensAsync()).resolves.toMatchObject({
      accessToken: 'fresh-access',
      refreshToken: 'rotated-refresh',
    })
    const entries = await fs.readdir(tmpDir)
    expect(entries.filter((entry) => entry.includes('.tmp.'))).toEqual([])
  })
})
