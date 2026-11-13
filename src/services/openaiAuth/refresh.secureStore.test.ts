import { expect, test } from 'bun:test'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createSandboxedTestEnvironment } from '../../../scripts/pr/test-environment.js'

for (const cached of [false, true]) {
  test(`serializes standalone CLI refreshes in ${cached ? 'cached keychain' : 'plaintext'} storage`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'openai-secure-refresh-'))
    const config = join(root, '.claude')
    mkdirSync(config)
    writeFileSync(join(config, '.credentials.json'), JSON.stringify({ openaiCodexOauth: {
      accessToken: 'expired', refreshToken: 'rotating', expiresAt: 1,
    }, unrelated: { keep: true } }))
    const moduleUrl = (relative: string) => pathToFileURL(join(import.meta.dir, relative)).href
    const calls = join(root, 'calls')
    const go = join(root, 'go')
    const release = join(root, 'release')
    const script = (id: string) => `
      import { mock } from 'bun:test'
      import { appendFileSync, existsSync, writeFileSync } from 'node:fs'
      const { plainTextStorage } = await import(${JSON.stringify(moduleUrl('../../utils/secureStorage/plainTextStorage.ts'))})
      const { keychainCacheState } = await import(${JSON.stringify(moduleUrl('../../utils/secureStorage/macOsKeychainHelpers.ts'))})
      const read = () => {
        if (${cached} && Date.now() - keychainCacheState.cache.cachedAt < 30000) return keychainCacheState.cache.data
        const data = plainTextStorage.read()
        keychainCacheState.cache = { data, cachedAt: Date.now() }
        return data
      }
      mock.module(${JSON.stringify(moduleUrl('../../utils/secureStorage/index.ts'))}, () => ({
        getSecureStorage: () => ({ ...plainTextStorage, read, readAsync: async () => read() }),
      }))
      globalThis.fetch = async () => {
        appendFileSync(${JSON.stringify(calls)}, 'POST\\n')
        const count = (await Bun.file(${JSON.stringify(calls)}).text()).trim().split('\\n').length
        while (!existsSync(${JSON.stringify(release)})) await Bun.sleep(10)
        return count === 1
          ? Response.json({ access_token: 'fresh', refresh_token: 'rotated', expires_in: 3600 })
          : Response.json({ error: 'invalid_grant' }, { status: 400 })
      }
      const auth = await import(${JSON.stringify(moduleUrl('index.ts'))})
      read() // Both processes may cache the expired generation before locking.
      writeFileSync(${JSON.stringify(join(root, id + '.ready'))}, 'ready')
      while (!existsSync(${JSON.stringify(go)})) await Bun.sleep(10)
      const result = await auth.ensureFreshOpenAITokens()
      if (result?.refreshToken !== 'rotated') throw new Error('Wrong refreshed identity')
    `
    const children = ['one', 'two'].map(id => Bun.spawn([process.execPath, '--no-env-file', '-e', script(id)], {
      env: createSandboxedTestEnvironment(root), stdout: 'pipe', stderr: 'pipe',
    }))
    try {
      const deadline = Date.now() + 10_000
      while (!existsSync(join(root, 'one.ready')) || !existsSync(join(root, 'two.ready'))) {
        if (Date.now() > deadline) throw new Error('Fixture children did not initialize')
        await Bun.sleep(10)
      }
      writeFileSync(go, 'go')
      // Keep the first grant in flight long enough to expose an unlocked rival.
      const refreshDeadline = Date.now() + 1000
      while ((!existsSync(calls) || readFileSync(calls, 'utf8').trim().split('\n').length < 2) && Date.now() < refreshDeadline) await Bun.sleep(10)
      writeFileSync(release, 'release')
      const results = await Promise.all(children.map(async child => ({
        code: await child.exited, error: await new Response(child.stderr).text(),
      })))
      expect(results).toEqual([{ code: 0, error: '' }, { code: 0, error: '' }])
      expect(readFileSync(calls, 'utf8').trim().split('\n')).toEqual(['POST'])
      expect(JSON.parse(readFileSync(join(config, '.credentials.json'), 'utf8'))).toMatchObject({
        openaiCodexOauth: { accessToken: 'fresh', refreshToken: 'rotated' }, unrelated: { keep: true },
      })
    } finally {
      children.forEach(child => child.kill())
      await Promise.all(children.map(child => child.exited))
      rmSync(root, { recursive: true, force: true })
    }
  }, 20_000)
}

for (const replacedDuringRefresh of [false, true]) {
  test(`bypasses keychain cache ${replacedDuringRefresh ? 'before saving a late refresh' : 'after another process rotates tokens'}`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'openai-keychain-refresh-'))
    const moduleUrl = (relative: string) => pathToFileURL(join(import.meta.dir, relative)).href
    const script = `
      import { mock } from 'bun:test'
      const { keychainCacheState } = await import(${JSON.stringify(moduleUrl('../../utils/secureStorage/macOsKeychainHelpers.ts'))})
      const expired = { accessToken: 'old', refreshToken: 'old-grant', expiresAt: 1 }
      const replacement = { accessToken: 'other-account', refreshToken: 'other-grant', expiresAt: Date.now() + 3600000 }
      let backing = { openaiCodexOauth: ${replacedDuringRefresh ? 'expired' : 'replacement'} }
      keychainCacheState.cache = { data: { openaiCodexOauth: expired }, cachedAt: Date.now() }
      const read = () => {
        if (Date.now() - keychainCacheState.cache.cachedAt < 30000) return keychainCacheState.cache.data
        keychainCacheState.cache = { data: backing, cachedAt: Date.now() }
        return backing
      }
      mock.module(${JSON.stringify(moduleUrl('../../utils/secureStorage/index.ts'))}, () => ({ getSecureStorage: () => ({
        name: 'keychain', read, readAsync: async () => read(),
        update: data => { backing = data; return { success: true } },
      }) }))
      let requests = 0
      globalThis.fetch = async () => {
        requests++
        backing = { openaiCodexOauth: replacement }
        return Response.json({ access_token: 'late-old-account', refresh_token: 'late-old-grant', expires_in: 3600 })
      }
      const { ensureFreshOpenAITokens } = await import(${JSON.stringify(moduleUrl('index.ts'))})
      const result = await ensureFreshOpenAITokens().catch(error => error)
      console.log(JSON.stringify({ requests, rejected: result instanceof Error, accessToken: backing.openaiCodexOauth.accessToken, returned: result?.accessToken }))
    `
    const child = Bun.spawn([process.execPath, '--no-env-file', '-e', script], {
      env: createSandboxedTestEnvironment(root), stdout: 'pipe', stderr: 'pipe',
    })
    try {
      const output = await new Response(child.stdout).text()
      const error = await new Response(child.stderr).text()
      expect({ code: await child.exited, error }).toEqual({ code: 0, error: '' })
      expect(JSON.parse(output)).toMatchObject({
        requests: replacedDuringRefresh ? 1 : 0,
        rejected: replacedDuringRefresh,
        accessToken: 'other-account',
        ...(!replacedDuringRefresh ? { returned: 'other-account' } : {}),
      })
    } finally {
      child.kill()
      await child.exited
      rmSync(root, { recursive: true, force: true })
    }
  }, 20_000)
}

for (const expired of [false, true]) {
  test(`a transient keychain failure preserves ${expired ? 'refresh error' : 'signed-in'} semantics`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'openai-keychain-outage-'))
    const moduleUrl = (relative: string) => pathToFileURL(join(import.meta.dir, relative)).href
    const script = `
      import { mock, spyOn } from 'bun:test'
      const exec = await import(${JSON.stringify(moduleUrl('../../utils/execFileNoThrow.ts'))})
      const portable = await import(${JSON.stringify(moduleUrl('../../utils/execFileNoThrowPortable.ts'))})
      const asynchronous = spyOn(exec, 'execFileNoThrow').mockResolvedValue({ stdout: '', stderr: 'temporary lookup failure', code: 75 })
      spyOn(portable, 'execSyncWithDefaults_DEPRECATED').mockImplementation(() => { throw new Error('temporary lookup failure') })
      const { macOsKeychainStorage } = await import(${JSON.stringify(moduleUrl('../../utils/secureStorage/macOsKeychainStorage.ts'))})
      const { keychainCacheState } = await import(${JSON.stringify(moduleUrl('../../utils/secureStorage/macOsKeychainHelpers.ts'))})
      keychainCacheState.cache = { data: { openaiCodexOauth: {
        accessToken: 'cached-login', refreshToken: 'cached-grant', expiresAt: ${expired ? '1' : 'Date.now() + 3600000'},
      } }, cachedAt: Date.now() }
      mock.module(${JSON.stringify(moduleUrl('../../utils/secureStorage/index.ts'))}, () => ({ getSecureStorage: () => ({
        name: 'keychain', read: macOsKeychainStorage.read, readAsync: macOsKeychainStorage.readAsync,
        update: () => { throw new Error('Unexpected credential write') },
      }) }))
      let requests = 0
      globalThis.fetch = async () => { requests++; throw new Error('Unexpected refresh request') }
      const { ensureFreshOpenAITokens } = await import(${JSON.stringify(moduleUrl('index.ts'))})
      const result = await ensureFreshOpenAITokens().catch(error => error)
      let retryRejected = false
      let recovered
      if (${expired}) {
        const retry = await ensureFreshOpenAITokens().catch(error => error)
        retryRejected = retry instanceof Error
        asynchronous.mockResolvedValue({ stdout: JSON.stringify({ openaiCodexOauth: {
          accessToken: 'recovered-login', refreshToken: 'recovered-grant', expiresAt: Date.now() + 3600000,
        } }), stderr: '', code: 0 })
        recovered = await ensureFreshOpenAITokens()
      }
      console.log(JSON.stringify({ missing: result === null, rejected: result instanceof Error, requests, retryRejected, recovered: recovered?.accessToken }))
    `
    const child = Bun.spawn([process.execPath, '--no-env-file', '-e', script], {
      env: createSandboxedTestEnvironment(root), stdout: 'pipe', stderr: 'pipe',
    })
    try {
      const output = await new Response(child.stdout).text()
      const error = await new Response(child.stderr).text()
      expect({ code: await child.exited, error }).toEqual({ code: 0, error: '' })
      expect(JSON.parse(output)).toEqual({
        missing: false, rejected: expired, requests: 0, retryRejected: expired,
        ...(expired ? { recovered: 'recovered-login' } : {}),
      })
    } finally {
      child.kill()
      await child.exited
      rmSync(root, { recursive: true, force: true })
    }
  }, 20_000)
}
