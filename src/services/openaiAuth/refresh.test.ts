import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { ensureFreshOpenAITokens, OpenAIOAuthService } from './index.js'
import { clearOpenAIOAuthTokenCache } from './storage.js'

describe('OpenAI refresh concurrency and failures', () => {
  let root: string
  let tokenFile: string
  let saved: NodeJS.ProcessEnv
  const originalFetch = globalThis.fetch
  beforeEach(async () => {
    saved = { ...process.env }
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'openai-refresh-'))
    tokenFile = path.join(root, 'tokens.json')
    process.env.CLAUDE_CONFIG_DIR = root
    process.env.OPENAI_CODEX_OAUTH_FILE = tokenFile
    clearOpenAIOAuthTokenCache()
    await fs.writeFile(tokenFile, JSON.stringify({ accessToken: 'expired', refreshToken: 'old-refresh', expiresAt: 1 }))
  })
  afterEach(async () => {
    globalThis.fetch = originalFetch
    process.env = saved
    clearOpenAIOAuthTokenCache()
    await fs.rm(root, { recursive: true, force: true })
  })

  test('shares a rotating refresh across exported helpers and service instances', async () => {
    let calls = 0
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    globalThis.fetch = async () => {
      calls++
      await gate
      return Response.json({ access_token: 'fresh', refresh_token: 'rotated', expires_in: 3600 })
    }
    const pending = Array.from({ length: 8 }, (_, i) => i % 2
      ? new OpenAIOAuthService().ensureFreshTokens() : ensureFreshOpenAITokens())
    await Bun.sleep(20)
    release()
    expect((await Promise.all(pending)).every(tokens => tokens?.refreshToken === 'rotated')).toBe(true)
    expect(calls).toBe(1)
  })

  for (const failure of ['network', '503', '401']) {
    test(`propagates ${failure} refresh failure without reporting missing credentials`, async () => {
      const before = await fs.readFile(tokenFile, 'utf8')
      globalThis.fetch = async () => {
        if (failure === 'network') throw new TypeError('fixture network unavailable')
        return Response.json({ error: 'fixture failure' }, { status: Number(failure) })
      }
      await expect(ensureFreshOpenAITokens()).rejects.toThrow(failure === 'network' ? 'network unavailable' : failure)
      expect(await fs.readFile(tokenFile, 'utf8')).toBe(before)
      globalThis.fetch = async () => Response.json({ access_token: 'recovered', expires_in: 3600 })
      expect((await ensureFreshOpenAITokens())?.accessToken).toBe('recovered')
    })
  }

  test('does not overwrite a replacement login with a late refresh response', async () => {
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    let started!: () => void
    const ready = new Promise<void>(resolve => { started = resolve })
    globalThis.fetch = async () => {
      started()
      await gate
      return Response.json({ access_token: 'late', refresh_token: 'late-refresh', expires_in: 3600 })
    }
    const pending = ensureFreshOpenAITokens().then(() => null, error => error)
    await ready
    await fs.writeFile(tokenFile, JSON.stringify({ accessToken: 'new-login', refreshToken: 'new-refresh', expiresAt: Date.now() + 3600000 }))
    release()
    expect(await pending).toBeInstanceOf(Error)
    expect(JSON.parse(await fs.readFile(tokenFile, 'utf8')).accessToken).toBe('new-login')
  })

  test('returns null only when no saved credentials exist', async () => {
    await fs.unlink(tokenFile)
    globalThis.fetch = async () => { throw new Error('must not fetch') }
    expect(await ensureFreshOpenAITokens()).toBeNull()
  })
})
