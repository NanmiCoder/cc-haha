import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'bun:test'

/** Isolated process: native modules are mocked before AppContext can load them. */
function runCase(body: string, options: { mutates?: boolean } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'mobile-credential-recovery-'))
  const script = `
    import { mock } from 'bun:test'
    import assert from 'node:assert/strict'
    const React = await import(${JSON.stringify(import.meta.resolve('react'))})
    let slots = [], cursor = 0, effects = []
    const providerSlots = [], connectionSlots = []
    const same = (a, b) => a && b && a.length === b.length && a.every((value, i) => Object.is(value, b[i]))
    mock.module(${JSON.stringify(import.meta.resolve('react'))}, () => ({
      ...React, default: React,
      createContext(value) { const context = { value, Provider: null }; const Provider = () => null; Provider.context = context; context.Provider = Provider; return context },
      useContext: context => context.value,
      useCallback: callback => callback,
      useState(initial) { const id = cursor++; if (!(id in slots)) slots[id] = typeof initial === 'function' ? initial() : initial; const owner = slots; return [slots[id], next => { owner[id] = typeof next === 'function' ? next(owner[id]) : next }] },
      useMemo(make, deps) { const id = cursor++; if (!slots[id] || !same(slots[id].deps, deps)) slots[id] = { deps, value: make() }; return slots[id].value },
      useEffect(effect, deps) {
        const id = cursor++, owner = slots
        if (!slots[id] || !same(slots[id].deps, deps)) {
          const previous = slots[id]
          slots[id] = { deps }
          effects.push(() => { previous?.cleanup?.(); owner[id].cleanup = effect() })
        }
      },
    }))
    let now = 0, timerId = 0
    const timers = new Map()
    globalThis.setTimeout = (callback, delay) => { const id = ++timerId; timers.set(id, { callback, at: now + delay }); return id }
    globalThis.clearTimeout = id => timers.delete(id)
    const flush = async () => { for (let i = 0; i < 40; i++) await Promise.resolve() }
    const advance = async milliseconds => {
      now += milliseconds
      for (let i = 0; i < 20; i++) {
        const due = [...timers].find(([, timer]) => timer.at <= now)
        if (!due) return
        timers.delete(due[0]); due[1].callback(); await flush()
      }
      throw new Error('unbounded retry loop')
    }
    const listeners = new Set()
    const AppState = { currentState: 'active', addEventListener: (_name, listener) => { listeners.add(listener); return { remove: () => listeners.delete(listener) } } }
    const emit = state => { AppState.currentState = state; [...listeners].forEach(listener => listener(state)) }
    mock.module(${JSON.stringify(import.meta.resolve('react-native'))}, () => ({ Platform: { OS: 'ios' }, AppState }))
    const hostA = { id: 'fixture-a', name: 'Fixture A', url: 'https://a.fixture.invalid', auth: 'remote' }
    const hostB = { id: 'fixture-b', name: 'Fixture B', url: 'http://127.0.0.1:3456', auth: 'lan' }
    const metadata = new Map([['cc-haha.hosts', JSON.stringify({ version: 1, hosts: [hostA, hostB], selectedId: hostA.id })]])
    const secrets = new Map([['cc-haha.host.fixture-a', 'native_fake-a'], ['cc-haha.host.fixture-b', 'fake-lan-b']])
    const originalMetadata = metadata.get('cc-haha.hosts')
    const reads = [], writes = []
    let read = async key => secrets.get(key) ?? null
    mock.module(${JSON.stringify(import.meta.resolve('@react-native-async-storage/async-storage'))}, () => ({ default: {
      getItem: async key => metadata.get(key) ?? null,
      setItem: async (key, value) => { writes.push(['metadata-set', key]); metadata.set(key, value) },
      removeItem: async key => { writes.push(['metadata-remove', key]); metadata.delete(key) },
    } }))
    mock.module(${JSON.stringify(import.meta.resolve('expo-secure-store'))}, () => ({
      getItemAsync: async key => { reads.push(key); return read(key) },
      setItemAsync: async (key, value) => { writes.push(['secret-set', key]); secrets.set(key, value) },
      deleteItemAsync: async key => { writes.push(['secret-remove', key]); secrets.delete(key) },
    }))
    mock.module(${JSON.stringify(import.meta.resolve('expo-crypto'))}, () => ({ getRandomBytes: () => new Uint8Array(16) }))
    mock.module(${JSON.stringify(import.meta.resolve('../../modules/cchaha-duty'))}, () => ({ default: null }))
    mock.module(${JSON.stringify(import.meta.resolve('./pushRegistrations'))}, () => ({ PushRegistrationCoordinator: class {} }))
    mock.module(${JSON.stringify(import.meta.resolve('./pushProvider'))}, () => ({ PushTokens: class {} }))
    mock.module(${JSON.stringify(import.meta.resolve('./backgroundDuty'))}, () => ({ BackgroundDuty: class { setAppActive() {} retain() {} } }))
    mock.module(${JSON.stringify(import.meta.resolve('./devicePushToken'))}, () => ({ getDevicePushToken() {}, getExpoPushToken() {} }))
    mock.module(${JSON.stringify(import.meta.resolve('./h5'))}, () => ({ isH5: false, h5Location: () => null }))
    let attached
    const retained = []
    const hostRelocator = {
      attach: target => { attached = target; return () => { if (attached === target) attached = undefined } },
      retain: async ids => { retained.push(ids) },
    }
    mock.module(${JSON.stringify(import.meta.resolve('./api'))}, () => ({ createApiClient: (host, credential) => ({ host, credential }), hostRelocator }))
    const module = await import(${JSON.stringify(import.meta.resolve('./AppContext'))})
    const flushEffects = async () => { const pending = effects; effects = []; pending.forEach(effect => effect()); await flush() }
    let context
    const renderProvider = async () => {
      slots = providerSlots; cursor = 0
      const element = module.AppProvider({ children: null })
      const result = element.type(element.props)
      context = result.type.context
      context.value = result.props.value
      await flushEffects()
    }
    await renderProvider(); await renderProvider()
    let selected = hostA.id, connection
    const render = async () => {
      slots = connectionSlots; cursor = 0
      connection = module.useConnection(selected)
      await flushEffects()
      slots = connectionSlots; cursor = 0
      connection = module.useConnection(selected)
      await flushEffects()
      return connection
    }
    const unmount = () => { connectionSlots.forEach(slot => slot?.cleanup?.()); effects = [] }
    ${body}
    unmount()
    assert.equal(timers.size, 0, 'unmount cancels retry timers')
    if (!${JSON.stringify(!!options.mutates)}) {
      assert.equal(writes.length, 0, 'recovery must not mutate metadata or secrets')
      assert.equal(metadata.get('cc-haha.hosts'), originalMetadata)
    }
  `
  try {
    const path = join(directory, 'recovery.ts')
    writeFileSync(path, script)
    execFileSync(process.execPath, ['--no-env-file', path], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] })
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

test('foreground resume recovers a saved credential after a temporary local read failure', () => {
  runCase(`
    read = async key => { if (reads.length === 1) throw new Error('keychain temporarily unavailable'); return secrets.get(key) ?? null }
    await render()
    assert.equal(connection.client, null)
    emit('background'); await advance(60000)
    assert.equal(reads.length, 1, 'do not retry while the phone is locked/backgrounded')
    emit('active'); await render()
    assert.equal(connection.client?.credential, 'native_fake-a', 'saved credential must recover without re-pairing')
    assert.equal(connection.error, '')
  `)
})

test('returning to a host clears an old credential error after a successful read', () => {
  runCase(`
    read = async key => { if (reads.length === 1) throw new Error('temporary read failure'); return secrets.get(key) ?? null }
    await render()
    selected = hostB.id; await render()
    assert.equal(connection.client?.credential, 'fake-lan-b')
    selected = hostA.id; await render()
    assert.equal(connection.client?.credential, 'native_fake-a')
    assert.equal(connection.error, '', 'a recovered host must not retain the previous pairing error')
  `)
})

test('temporary reads retry finitely in foreground and stop after recovery', () => {
  runCase(`
    read = async () => { throw new Error('storage unavailable') }
    await render()
    assert.equal(connection.credentialIssue, 'unavailable')
    for (const delay of [1000, 3000, 10000]) await advance(delay)
    assert.equal(reads.length, 4)
    assert.equal(timers.size, 0, 'persistent storage errors must not poll forever')
    read = async key => secrets.get(key) ?? null
    emit('background'); emit('active'); await render()
    assert.equal(connection.error, '')
    assert.equal(connection.credentialIssue, null)
    const client = connection.client
    emit('inactive'); emit('active'); await render()
    assert.equal(connection.client, client, 'ordinary foregrounding must preserve the established client')
    assert.equal(reads.length, 5)
  `)
})

test('a short local read failure recovers automatically while remaining in foreground', () => {
  runCase(`
    read = async key => { if (reads.length === 1) throw new Error('temporary read failure'); return secrets.get(key) ?? null }
    await render()
    await advance(1000); await render()
    assert.equal(connection.client?.credential, 'native_fake-a')
    assert.equal(connection.error, '')
    assert.equal(timers.size, 0)
    await advance(60000)
    assert.equal(reads.length, 2)
  `)
})

test('the H5 cookie/loopback empty credential remains a valid restored value', () => {
  runCase(`
    context.value = { ...context.value, credential: async () => '' }
    await render()
    assert.equal(connection.client?.credential, '')
    assert.equal(connection.credential, '')
    assert.equal(connection.credentialIssue, null)
    assert.equal(connection.error, '')
    emit('inactive'); emit('active'); await render()
    assert.equal(connection.credential, '')
    assert.equal(reads.length, 0, 'H5 must not fall back to native secret storage')
  `)
})

test('background startup defers credential reads until foreground', () => {
  runCase(`
    emit('background')
    await render()
    assert.equal(reads.length, 0)
    assert.equal(connection.client, null)
    emit('active'); await render()
    assert.equal(connection.client?.credential, 'native_fake-a')
  `)
})

test('a missing credential stays unavailable without deleting the paired host or retry polling', () => {
  runCase(`
    read = async () => null
    await render()
    assert.equal(connection.client, null)
    assert.equal(connection.credentialIssue, 'missing')
    assert.equal(connection.host.id, hostA.id)
    await advance(60000)
    assert.equal(reads.length, 1)
    assert.equal(connection.error.includes('移除'), false)
  `)
})

test('late reads from the old foreground cannot replace a recovered credential', () => {
  runCase(`
    let rejectOld
    read = key => reads.length === 1 ? new Promise((_, reject) => { rejectOld = reject }) : Promise.resolve(secrets.get(key) ?? null)
    await render()
    emit('background'); emit('active'); await render()
    assert.equal(connection.client?.credential, 'native_fake-a')
    rejectOld(new Error('stale failure')); await render()
    assert.equal(connection.error, '')
    assert.equal(connection.client?.credential, 'native_fake-a')
  `)
})

test('switching hosts and unmounting ignore late secret reads', () => {
  runCase(`
    let finishOld
    read = key => reads.length === 1 ? new Promise(resolve => { finishOld = resolve }) : Promise.resolve(secrets.get(key) ?? null)
    await render()
    selected = hostB.id; await render()
    finishOld('native_stale-a'); await render()
    assert.equal(connection.client?.credential, 'fake-lan-b')
    assert.equal(connection.credentialIssue, null)
    selected = hostA.id
    read = () => new Promise(resolve => { finishOld = resolve })
    await render(); unmount()
    finishOld('native_late-after-unmount'); await flush()
    assert.equal(timers.size, 0)
  `)
})

test('a failed reread cannot reuse a previous credential for the same host', () => {
  runCase(`
    await render()
    assert.equal(connection.client?.credential, 'native_fake-a')
    selected = hostB.id
    read = async () => { throw new Error('temporary storage failure') }
    await render()
    selected = hostA.id; await render()
    assert.equal(connection.client, null)
    assert.equal(connection.credential, undefined)
    assert.equal(connection.credentialIssue, 'unavailable')
  `)
})

test('a moved computer drops its cached link before the new address is published, and clients rebuild with it', () => {
  runCase(`
    const { hostLinks } = await import(${JSON.stringify(import.meta.resolve('../core/hostLink'))})
    const NEW = 'https://new-tunnel.trycloudflare.com'
    await render()
    assert.equal(connection.client.host.url, hostA.url)
    // The link cached for this computer and credential (what createApiClient reuses).
    let publishedAtDispose
    hostLinks.for(hostA, 'native_fake-a', () => ({
      credential: 'native_fake-a',
      dispose() { publishedAtDispose = providerSlots[0].hosts.find(host => host.id === hostA.id).url },
    }))
    // The registry is attached to the relocator, and it asks through the same action.
    assert.deepEqual(attached.host(hostA.id), hostA)
    assert.equal(attached.relocate, context.value.relocate)
    assert.deepEqual(retained.at(-1), [hostA.id, hostB.id])
    await context.value.relocate(hostA.id, NEW + '/')
    assert.equal(publishedAtDispose, hostA.url, 'the old link must be gone before anyone sees the new address')
    assert.equal(hostLinks.get(hostA), undefined)
    await renderProvider()
    assert.equal(attached.host(hostA.id).url, NEW)
    await render()
    assert.equal(connection.host.url, NEW)
    assert.equal(connection.client.host.url, NEW)
    assert.equal(connection.client.credential, 'native_fake-a')
    const stored = JSON.parse(metadata.get('cc-haha.hosts'))
    assert.deepEqual(stored, { version: 1, hosts: [{ ...hostA, url: NEW }, hostB], selectedId: hostA.id })
    assert.deepEqual(writes, [['metadata-set', 'cc-haha.hosts']], 'credentials are not touched')
    // The same address again changes nothing.
    await context.value.relocate(hostA.id, NEW)
    assert.equal(writes.length, 1)
  `, { mutates: true })
})
