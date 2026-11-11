import { expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('network changes withhold the previous native credential until identity recovery succeeds', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mobile-recovery-hook-'))
  const script = `
    import { mock } from 'bun:test'
    import assert from 'node:assert/strict'
    let cursor = 0, effectCursor = 0
    const slots = [], effects = []
    let finish, reject
    const host = { id: 'fixture', name: 'Fixture', auth: 'remote', url: 'https://old.fixture.invalid', remoteIdentity: { hostId: 'a'.repeat(64) } }
    const context = { registry: { version: 2, hosts: [host], selectedId: host.id }, networkEpoch: 0,
      resolve: () => new Promise((resolve, fail) => { finish = resolve; reject = fail }) }
    mock.module(${JSON.stringify(import.meta.resolve('react'))}, () => ({
      createContext: () => ({}), useContext: () => context, useCallback: fn => fn, useMemo: fn => fn(),
      useState: initial => { const at = cursor++; if (!(at in slots)) slots[at] = initial; return [slots[at], next => { slots[at] = typeof next === 'function' ? next(slots[at]) : next }] },
      useEffect: (fn, deps) => { const at = effectCursor++; const old = effects[at];
        if (!old || deps.some((value, index) => value !== old.deps[index])) { old?.cleanup?.(); effects[at] = { deps, cleanup: fn() } } },
    }))
    mock.module(${JSON.stringify(import.meta.resolve('react-native'))}, () => ({ Platform: { OS: 'android' }, AppState: { currentState: 'active', addEventListener: () => ({ remove() {} }) } }))
    mock.module(${JSON.stringify(import.meta.resolve('@react-native-async-storage/async-storage'))}, () => ({ default: {} }))
    mock.module(${JSON.stringify(import.meta.resolve('expo-secure-store'))}, () => ({ getItemAsync() {}, setItemAsync() {}, deleteItemAsync() {} }))
    mock.module(${JSON.stringify(import.meta.resolve('expo-crypto'))}, () => ({ getRandomBytes: () => new Uint8Array(16) }))
    mock.module(${JSON.stringify(import.meta.resolve('../../modules/cchaha-duty'))}, () => ({ default: null }))
    mock.module(${JSON.stringify(import.meta.resolve('./devicePushToken'))}, () => ({ getDevicePushToken() {}, getExpoPushToken() {} }))
    mock.module(${JSON.stringify(import.meta.resolve('./remoteIdentityKeys'))}, () => ({ remoteIdentityKeys: null }))
    const createClient = (host, credential) => ({ host, credential })
    mock.module(${JSON.stringify(import.meta.resolve('./api'))}, () => ({
      createApiClient: createClient,
      createIdentityClient: createClient,
      hostRelocator: {},
    }))
    globalThis.setInterval = () => 1
    globalThis.clearInterval = () => {}
    const { useConnection } = await import(${JSON.stringify(import.meta.resolve('./AppContext'))})
    const render = () => { cursor = effectCursor = 0; return useConnection() }
    assert.equal(render().client, null)
    finish({ host, credential: 'old-fixture-token' })
    await new Promise(resolve => setTimeout(resolve, 0))
    assert.equal(render().credential, 'old-fixture-token')
    context.networkEpoch++
    const pending = render()
    assert.equal(pending.client, null, 'old endpoint cannot receive commands while re-verification is pending')
    assert.equal(pending.credential, undefined)
    finish({ host: { ...host, url: 'https://new.fixture.invalid' }, credential: 'new-fixture-token' })
    await new Promise(resolve => setTimeout(resolve, 0))
    assert.equal(render().client.host.url, 'https://new.fixture.invalid')
    assert.equal(render().credential, 'new-fixture-token')
    context.networkEpoch++
    render()
    reject(new Error('Unverified endpoint'))
    await new Promise(resolve => setTimeout(resolve, 0))
    assert.equal(render().client, null)
    assert.equal(render().credential, undefined)
    for (const effect of effects) effect.cleanup?.()
  `
  const path = join(dir, 'render.ts')
  writeFileSync(path, script)
  try { expect(execFileSync(process.execPath, ['--no-env-file', path], { cwd: dir, encoding: 'utf8' })).toBe('') }
  finally { rmSync(dir, { recursive: true, force: true }) }
})
