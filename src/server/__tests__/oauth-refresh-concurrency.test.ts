import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, writeFile, rm } from 'fs/promises'
import { existsSync } from 'fs'
import { pathToFileURL } from 'url'
import { tmpdir } from 'os'
import { join } from 'path'
import { HahaOpenAIOAuthService } from '../services/hahaOpenAIOAuthService.js'
import { HahaGrokOAuthService } from '../services/hahaGrokOAuthService.js'
import { ensureFreshOpenAITokens } from '../../services/openaiAuth/index.js'
import { clearOpenAIOAuthTokenCache } from '../../services/openaiAuth/storage.js'
import { ensureFreshGrokTokens } from '../../services/grokAuth/refresh.js'

const originalEnv = { ...process.env }
const originalFetch = globalThis.fetch
let directory: string
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'oauth-refresh-concurrency-'))
  process.env.CLAUDE_CONFIG_DIR = directory
  globalThis.fetch = (async () => { throw new Error('Unexpected network request') }) as typeof fetch
})
afterEach(async () => {
  for (const key of ['CLAUDE_CONFIG_DIR', 'OPENAI_CODEX_OAUTH_FILE', 'GROK_OAUTH_FILE']) {
    if (originalEnv[key] === undefined) delete process.env[key]
    else process.env[key] = originalEnv[key]
  }
  globalThis.fetch = originalFetch
  clearOpenAIOAuthTokenCache()
  await rm(directory, { recursive: true, force: true })
})

for (const [provider, Service, ensureCli, envKey] of [
  ['OpenAI', HahaOpenAIOAuthService, ensureFreshOpenAITokens, 'OPENAI_CODEX_OAUTH_FILE'],
  ['Grok', HahaGrokOAuthService, ensureFreshGrokTokens, 'GROK_OAUTH_FILE'],
] as const) describe(`${provider} desktop refresh coordination`, () => {
  const expired = { accessToken: 'old-access', refreshToken: 'old-refresh', expiresAt: 1, email: null, accountId: null }

  test('shares one rotation across desktop instances and the CLI entry point', async () => {
    const service = new Service()
    const second = new Service()
    process.env[envKey] = service.getOAuthFilePath()
    await service.saveTokens(expired)
    let release!: () => void
    let started!: () => void
    const ready = new Promise<void>(resolve => { started = resolve })
    const gate = new Promise<void>(resolve => { release = resolve })
    let calls = 0
    const refresh = async () => {
      calls++
      started()
      await gate
      return { access_token: 'fresh', refresh_token: 'rotated', expires_in: 3600 }
    }
    service.setRefreshFn(refresh)
    second.setRefreshFn(refresh)
    globalThis.fetch = (async () => Response.json(await refresh())) as typeof fetch
    const first = service.ensureFreshTokens()
    await ready
    const rest = [second.ensureFreshTokens(), ensureCli()]
    await Bun.sleep(20)
    release()
    const results = await Promise.all([first, ...rest])
    expect(calls).toBe(1)
    expect(results.every(tokens => tokens?.refreshToken === 'rotated')).toBe(true)
  })

  for (const mutation of ['logout', 'new login'] as const) test(`does not overwrite ${mutation} with a late refresh`, async () => {
    const service = new Service()
    await service.saveTokens(expired)
    let release!: () => void
    let started!: () => void
    const ready = new Promise<void>(resolve => { started = resolve })
    const gate = new Promise<void>(resolve => { release = resolve })
    service.setRefreshFn(async () => {
      started()
      await gate
      return { access_token: 'late', refresh_token: 'late-refresh', expires_in: 3600 }
    })
    const result = service.ensureFreshTokens().catch(error => error)
    await ready
    const replacement = { ...expired, accessToken: 'other-account', refreshToken: 'other-refresh' }
    if (mutation === 'logout') await service.deleteTokens()
    else await service.saveTokens(replacement)
    release()
    expect(await result).toBeInstanceOf(Error)
    expect(await service.loadTokens()).toEqual(mutation === 'logout' ? null : replacement)
  })

  test('preserves refresh errors and can retry without discarding credentials', async () => {
    const service = new Service()
    await service.saveTokens(expired)
    service.setRefreshFn(async () => { throw new Error('upstream temporarily unavailable: 503') })
    await expect(service.ensureFreshTokens()).rejects.toThrow('503')
    expect(await service.loadTokens()).toEqual(expired)
    service.setRefreshFn(async () => ({ access_token: 'fresh', expires_in: 3600 }))
    expect((await service.ensureFreshTokens())?.accessToken).toBe('fresh')
  })

  test('rejects a changed credential store without returning or overwriting the other account', async () => {
    const service = new Service()
    await service.saveTokens(expired)
    let release!: () => void
    let started!: () => void
    const ready = new Promise<void>(resolve => { started = resolve })
    const gate = new Promise<void>(resolve => { release = resolve })
    service.setRefreshFn(async () => {
      started()
      await gate
      return { access_token: 'late', refresh_token: 'late-refresh', expires_in: 3600 }
    })
    const pending = service.ensureFreshTokens().catch(error => error)
    await ready
    process.env.CLAUDE_CONFIG_DIR = join(directory, 'other-store')
    const other = { ...expired, accessToken: 'other', refreshToken: 'other-refresh' }
    await service.saveTokens(other)
    release()
    expect(await pending).toBeInstanceOf(Error)
    expect(await service.loadTokens()).toEqual(other)
    process.env.CLAUDE_CONFIG_DIR = directory
    expect(await service.loadTokens()).toEqual(expired)
  })

  test('serializes desktop and CLI refresh in separate processes sharing a token file', async () => {
    const service = new Service()
    await service.saveTokens(expired)
    const sourceRoot = join(import.meta.dir, '..', '..')
    const callsPath = join(directory, 'calls.log')
    const goPath = join(directory, 'go')
    const children = ['desktop', 'cli'].map(entry => {
      const modulePath = entry === 'desktop'
        ? join(sourceRoot, 'server', 'services', `haha${provider}OAuthService.ts`)
        : join(sourceRoot, 'services', `${provider.toLowerCase()}Auth`, provider === 'OpenAI' ? 'index.ts' : 'refresh.ts')
      const readyPath = join(directory, `${entry}.ready`)
      const script = `
        import { appendFileSync, existsSync, writeFileSync } from 'fs';
        const refresh = async () => {
          appendFileSync(${JSON.stringify(callsPath)}, 'POST\\n');
          await Bun.sleep(150);
          return { access_token: 'fresh', refresh_token: 'rotated', expires_in: 3600 };
        };
        globalThis.fetch = async () => Response.json(await refresh());
        const mod = await import(${JSON.stringify(pathToFileURL(modulePath).href)});
        ${entry === 'desktop' ? `const service = new mod.Haha${provider}OAuthService(); service.setRefreshFn(refresh);` : ''}
        writeFileSync(${JSON.stringify(readyPath)}, 'ready');
        while (!existsSync(${JSON.stringify(goPath)})) await Bun.sleep(10);
        const result = await ${entry === 'desktop' ? 'service.ensureFreshTokens()' : `mod.ensureFresh${provider}Tokens()`};
        if (result?.refreshToken !== 'rotated') throw new Error('Incorrect refresh result');
      `
      return Bun.spawn([process.execPath, '-e', script], {
        cwd: directory,
        env: { ...process.env, [envKey]: service.getOAuthFilePath(), HOME: directory, USERPROFILE: directory },
        stdout: 'pipe', stderr: 'pipe',
      })
    })
    try {
      const deadline = Date.now() + 15_000
      while (!existsSync(join(directory, 'desktop.ready')) || !existsSync(join(directory, 'cli.ready'))) {
        if (Date.now() > deadline) throw new Error('OAuth fixture children failed to start')
        await Bun.sleep(20)
      }
      await writeFile(goPath, 'go')
      for (const child of children) {
        const stderr = await new Response(child.stderr).text()
        expect({ exitCode: await child.exited, stderr }).toEqual({ exitCode: 0, stderr: '' })
      }
      expect((await readFile(callsPath, 'utf8')).trim().split('\n')).toEqual(['POST'])
      expect((await service.loadTokens())?.refreshToken).toBe('rotated')
    } finally {
      children.forEach(child => child.kill())
      await Promise.all(children.map(child => child.exited))
    }
  }, 20_000)
})
