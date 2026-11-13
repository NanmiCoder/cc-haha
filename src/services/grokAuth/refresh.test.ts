import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import { clearFreshGrokTokenCache, ensureFreshGrokTokens, forceRefreshGrokTokens } from './refresh.js'
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

  test('shares concurrent proactive and forced refreshes for a rotating credential', async () => {
    let calls = 0
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const fetchOverride: typeof fetch = async () => {
      calls++
      await gate
      return Response.json({ access_token: 'fresh', refresh_token: 'rotated', expires_in: 3600 })
    }
    const pending = Array.from({ length: 8 }, (_, i) => i % 2
      ? forceRefreshGrokTokens({ fetchOverride }) : ensureFreshGrokTokens({ fetchOverride }))
    await Bun.sleep(20)
    release()
    const results = await Promise.all(pending)
    expect(calls).toBe(1)
    expect(results.every(tokens => tokens?.refreshToken === 'rotated')).toBe(true)
  })

  test('a delayed unauthorized response reuses the credential already refreshed for its access token', async () => {
    let calls = 0
    const fetchOverride: typeof fetch = async () => {
      calls++
      return Response.json({ access_token: `fresh-${calls}`, refresh_token: `rotated-${calls}`, expires_in: 3600 })
    }
    await forceRefreshGrokTokens({ fetchOverride }, 'expired')
    expect((await forceRefreshGrokTokens({ fetchOverride }, 'expired'))?.accessToken).toBe('fresh-1')
    expect(calls).toBe(1)
  })

  test('does not overwrite credentials replaced while a refresh is pending', async () => {
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    let started!: () => void
    const ready = new Promise<void>(resolve => { started = resolve })
    const pending = ensureFreshGrokTokens({ fetchOverride: async () => {
      started()
      await gate
      return Response.json({ access_token: 'stale-result', refresh_token: 'stale-refresh', expires_in: 3600 })
    } })
    const result = pending.then(() => null, error => error)
    await ready
    await fs.writeFile(tokenFile, JSON.stringify({ accessToken: 'new-login', refreshToken: 'new-login-refresh', expiresAt: Date.now() + 3600000 }))
    release()
    expect(await result).toBeInstanceOf(Error)
    expect(JSON.parse(await fs.readFile(tokenFile, 'utf8')).accessToken).toBe('new-login')
  })

  test('releases a failed flight so a later request can retry without changing saved tokens', async () => {
    const before = await fs.readFile(tokenFile, 'utf8')
    await expect(ensureFreshGrokTokens({ fetchOverride: async () => Response.json({}, { status: 503 }) })).rejects.toThrow('503')
    expect(await fs.readFile(tokenFile, 'utf8')).toBe(before)
    expect((await ensureFreshGrokTokens({ fetchOverride: async () => Response.json({ access_token: 'recovered', expires_in: 3600 }) }))?.accessToken).toBe('recovered')
  })
})
