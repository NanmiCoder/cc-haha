import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import { handleHahaGrokOAuthApi } from '../api/haha-grok-oauth.js'
import { hahaGrokOAuthService } from '../services/hahaGrokOAuthService.js'

let tempDir: string
let previousConfigDir: string | undefined

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'haha-grok-oauth-api-'))
  previousConfigDir = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = tempDir
})

afterEach(async () => {
  hahaGrokOAuthService.dispose()
  if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = previousConfigDir
  await fs.rm(tempDir, { recursive: true, force: true })
})

describe('Haha Grok OAuth API', () => {
  test('serves a clear local success page after browser authorization', async () => {
    const response = await handleHahaGrokOAuthApi(
      new Request('http://localhost/api/haha-grok-oauth/success'),
      new URL('http://localhost/api/haha-grok-oauth/success'),
      ['api', 'haha-grok-oauth', 'success'],
    )
    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toContain('text/html')
    expect(await response.text()).toContain('Grok Login Successful')
  })

  test('returns status without exposing token material and logs out', async () => {
    await hahaGrokOAuthService.saveTokens({
      accessToken: 'secret-access',
      refreshToken: 'secret-refresh',
      expiresAt: Date.now() + 3600_000,
      email: 'user@example.com',
    })
    const statusResponse = await handleHahaGrokOAuthApi(
      new Request('http://localhost/api/haha-grok-oauth'),
      new URL('http://localhost/api/haha-grok-oauth'),
      ['api', 'haha-grok-oauth'],
    )
    const statusText = await statusResponse.text()
    expect(statusText).toContain('user@example.com')
    expect(statusText).not.toContain('secret-access')
    expect(statusText).not.toContain('secret-refresh')

    const logoutResponse = await handleHahaGrokOAuthApi(
      new Request('http://localhost/api/haha-grok-oauth', { method: 'DELETE' }),
      new URL('http://localhost/api/haha-grok-oauth'),
      ['api', 'haha-grok-oauth'],
    )
    expect(logoutResponse.status).toBe(200)
    await expect(hahaGrokOAuthService.loadTokens()).resolves.toBeNull()
  })
})
