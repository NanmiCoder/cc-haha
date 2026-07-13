import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import { clearFreshGrokTokenCache, ensureFreshGrokTokens } from './refresh.js'
import { GROK_OAUTH_FILE_ENV_KEY } from './storage.js'

describe('Grok token refresh helper', () => {
  let tmpDir: string
  let tokenFile: string
  let original: string | undefined

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'grok-refresh-'))
    tokenFile = path.join(tmpDir, 'tokens.json')
    original = process.env[GROK_OAUTH_FILE_ENV_KEY]
    process.env[GROK_OAUTH_FILE_ENV_KEY] = tokenFile
    clearFreshGrokTokenCache()
    await fs.writeFile(tokenFile, JSON.stringify({
      accessToken: 'expired', refreshToken: 'old-refresh', expiresAt: 1,
    }))
  })

  afterEach(async () => {
    clearFreshGrokTokenCache()
    if (original === undefined) delete process.env[GROK_OAUTH_FILE_ENV_KEY]
    else process.env[GROK_OAUTH_FILE_ENV_KEY] = original
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  test('refreshes once and persists a rotated refresh token', async () => {
    let calls = 0
    const fetchOverride: typeof fetch = async () => {
      calls++
      return Response.json({
        access_token: 'fresh-access', refresh_token: 'rotated-refresh', expires_in: 3600,
      })
    }
    await expect(ensureFreshGrokTokens({ fetchOverride })).resolves.toMatchObject({
      accessToken: 'fresh-access', refreshToken: 'rotated-refresh',
    })
    await expect(ensureFreshGrokTokens({ fetchOverride })).resolves.toMatchObject({
      accessToken: 'fresh-access', refreshToken: 'rotated-refresh',
    })
    expect(calls).toBe(1)
    expect(JSON.parse(await fs.readFile(tokenFile, 'utf8'))).toMatchObject({
      accessToken: 'fresh-access', refreshToken: 'rotated-refresh',
    })
  })
})
