import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'bun:test'

function runCase(body: string) {
  const directory = mkdtempSync(join(tmpdir(), 'mobile-push-recovery-'))
  const script = `
    import { mock } from 'bun:test'
    import assert from 'node:assert/strict'
    const React = await import(${JSON.stringify(import.meta.resolve('react'))})
    const { ApiError } = await import(${JSON.stringify(import.meta.resolve('../core/client'))})
    let slots = [], cursor = 0, effects = []
    const hostSlots = []
    const same = (a, b) => a && b && a.length === b.length && a.every((value, i) => Object.is(value, b[i]))
    mock.module(${JSON.stringify(import.meta.resolve('react'))}, () => ({
      ...React, default: React,
      createContext(value) { const context = { value, Provider: null }; const Provider = () => null; Provider.context = context; context.Provider = Provider; return context },
      useContext: context => context.value,
      useCallback: callback => callback,
      useState(initial) { const id = cursor++; if (!(id in slots)) slots[id] = typeof initial === 'function' ? initial() : initial; return [slots[id], next => { slots[id] = typeof next === 'function' ? next(slots[id]) : next }] },
      useEffect(effect, deps) {
        const id = cursor++
        if (!slots[id] || !same(slots[id].deps, deps)) {
          const previous = slots[id]
          slots[id] = { deps }
          effects.push(() => { previous?.cleanup?.(); slots[id].cleanup = effect() })
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
    const appListeners = new Set()
    const AppState = { currentState: 'active', addEventListener: (_name, callback) => { appListeners.add(callback); return { remove: () => appListeners.delete(callback) } } }
    const emit = state => { AppState.currentState = state; appListeners.forEach(callback => callback(state)) }
    mock.module(${JSON.stringify(import.meta.resolve('react-native'))}, () => ({ Platform: { OS: 'android' }, AppState }))
    let permission = true, tokenListener, permissionListener
    mock.module(${JSON.stringify(import.meta.resolve('expo-notifications'))}, () => ({
      getPermissionsAsync: async () => ({ granted: permission }),
      addPushTokenListener: listener => { tokenListener = listener; return { remove: () => { tokenListener = undefined } } },
    }))
    let hostCalls = 0, tokenCalls = 0, registerCalls = 0, revoked = 0
    let hostImpl = async () => ({ platforms: { android: true, ios: false }, status: 'configured' })
    let tokenImpl = async () => 'fixture-token'
    let registerImpl = async () => ({ registered: true, status: 'registered', id: 'fixture-registration' })
    let revokeImpl = async () => {}
    const inputs = [], signals = []
    const client = {
      host: { id: 'fixture-host' },
      get: async (_path, options) => { hostCalls++; signals.push(options.signal); return hostImpl() },
    }
    const preferences = {
      notifications: { decisions: true, completed: true, errors: true },
      quietHours: { enabled: false, start: '23:00', end: '08:00' },
      timeSensitive: false, liveActivity: 'running', liveActivityShowCommand: false,
    }
    let preferencesError = '', connected = true, connectionError = ''
    mock.module(${JSON.stringify(import.meta.resolve('./AppContext'))}, () => ({
      useApp: () => ({ registry: { hosts: [{ id: 'fixture-host' }] } }),
      useConnection: () => ({ client: connected ? client : null, error: connectionError }),
      pushRegistrations: {
        register: async (_client, input, signal) => { registerCalls++; inputs.push(input); return registerImpl(signal) },
        clearRegistrations: async () => { revoked++; return revokeImpl() },
      },
    }))
    mock.module(${JSON.stringify(import.meta.resolve('./PreferencesContext'))}, () => ({ usePreferences: () => ({ preferences, ready: true, error: preferencesError }) }))
    mock.module(${JSON.stringify(import.meta.resolve('./devicePushToken'))}, () => ({
      getDevicePushToken: async () => { tokenCalls++; return tokenImpl() },
    }))
    mock.module(${JSON.stringify(import.meta.resolve('./notifyPromptGate'))}, () => ({ subscribePermissionDecided: listener => { permissionListener = listener; return () => { permissionListener = undefined } } }))
    mock.module(${JSON.stringify(import.meta.resolve('./notificationChannel'))}, () => ({ ensureNotificationChannel: async () => {} }))
    const module = await import(${JSON.stringify(import.meta.resolve('./PushRegistrationContext'))})
    const history = []
    let registerElement
    const walk = node => {
      if (Array.isArray(node)) { node.forEach(walk); return }
      if (!node || typeof node !== 'object') return
      if (node.type?.context) node.type.context.value = node.props.value
      if (node.type?.name === 'RegisterHost') registerElement = node
      walk(node.props?.children)
    }
    const provider = module.PushRegistrationProvider({ children: null })
    walk(provider)
    const hostProps = { ...registerElement.props, onChange: (_id, info) => history.push(info) }
    const render = async () => {
      slots = hostSlots; cursor = 0
      registerElement.type(hostProps)
      const pending = effects; effects = []; pending.forEach(effect => effect())
      await flush()
    }
    const unmount = () => { hostSlots.forEach(slot => slot?.cleanup?.()); effects = [] }
    const retry = () => module.useRetryPushRegistration('fixture-host')()
    const status = () => history.at(-1)
    ${body}
    unmount()
  `
  try {
    const path = join(directory, 'recovery.ts')
    writeFileSync(path, script)
    execFileSync(process.execPath, [path], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] })
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

test('a transient foreground GET failure retries without reopening the app and recovers', () => {
  runCase(`
    hostImpl = async () => {
      if (hostCalls === 1) throw new ApiError('offline', 0, 'NETWORK_ERROR')
      return { platforms: { android: true, ios: false }, status: 'configured' }
    }
    await render()
    assert.equal(status().status, 'error')
    assert.equal(timers.size, 1, 'transient failure must schedule a foreground retry')
    assert.equal(status().issue, 'network')
    await advance(2000)
    assert.equal(status().status, 'registered')
    assert.equal(hostCalls, 2)
    assert.equal(registerCalls, 1)
    assert.equal(timers.size, 0)
  `)
})

test('automatic retries are bounded and manual retry starts a fresh attempt', () => {
  runCase(`
    hostImpl = async () => { throw new ApiError('offline', 0, 'NETWORK_ERROR') }
    await render()
    for (const delay of [2000, 5000, 15000]) await advance(delay)
    assert.equal(hostCalls, 4)
    assert.equal(timers.size, 0, 'retry budget must stop background polling')
    hostImpl = async () => ({ platforms: { android: true, ios: false }, status: 'configured' })
    retry(); await flush()
    assert.equal(status().status, 'registered')
    assert.equal(hostCalls, 5)
  `)
})

test('backgrounding and unmounting cancel retries while returning to foreground rechecks', () => {
  runCase(`
    hostImpl = async () => { throw new ApiError('offline', 0, 'NETWORK_ERROR') }
    await render()
    emit('background')
    assert.equal(timers.size, 0)
    await advance(60000)
    assert.equal(hostCalls, 1)
    emit('active'); await flush()
    assert.equal(hostCalls, 2)
    assert.equal(timers.size, 1)
    unmount()
    assert.equal(timers.size, 0)
    await advance(60000)
    assert.equal(hostCalls, 2)
  `)
})

for (const heldStage of ['GET', 'PUT']) {
  for (const fails of [false, true]) {
    test(`a queued native rotation drains once after backgrounding during ${heldStage}${fails ? ' even when it fails' : ''}`, () => {
      runCase(`
        let release
        const held = new Promise(resolve => { release = resolve })
        const configured = { platforms: { android: true, ios: false }, status: 'configured' }
        const registered = { registered: true, status: 'registered', id: 'fixture-registration' }
        hostImpl = () => ${heldStage === 'GET'} && hostCalls === 1 ? held : Promise.resolve(configured)
        registerImpl = () => {
          if (${heldStage === 'PUT'} && registerCalls === 1) return held
          if (${fails} && registerCalls === 2) throw new ApiError('offline', 0, 'NETWORK_ERROR')
          return Promise.resolve(registered)
        }
        await render()
        tokenListener({ data: 'intermediate-token' })
        tokenListener({ data: 'latest-token' })
        retry()
        emit('background')
        const updates = history.length
        assert.equal(signals[0].aborted, false)
        release(${heldStage === 'GET' ? 'configured' : 'registered'})
        await flush()
        assert.deepEqual(inputs.map(input => input.token), ['fixture-token', 'latest-token'])
        assert.equal(tokenCalls, 1, 'queued rotation uses the native token already received')
        assert.equal(hostCalls, 2)
        assert.equal(timers.size, 0, 'background rotation must not schedule retries')
        assert.equal(history.length, updates, 'background completion cannot publish foreground status')
        await advance(60000)
        assert.equal(registerCalls, 2)
        assert.equal(hostCalls, 2)
      `)
    })
  }
}

test('backgrounding discards an ordinary refresh queued behind an in-flight request', () => {
  runCase(`
    let release
    hostImpl = () => new Promise(resolve => { release = resolve })
    await render()
    retry()
    emit('background')
    release({ platforms: { android: true, ios: false }, status: 'configured' })
    await flush()
    await advance(60000)
    assert.equal(hostCalls, 1)
    assert.equal(registerCalls, 1)
    assert.equal(timers.size, 0)
  `)
})

test('unmounting cancels a native rotation queued before backgrounding', () => {
  runCase(`
    let release, putSignal
    registerImpl = signal => {
      putSignal = signal
      return new Promise(resolve => { release = resolve })
    }
    await render()
    tokenListener({ data: 'latest-token' })
    emit('background')
    const updates = history.length
    unmount()
    assert.equal(putSignal.aborted, true, 'stop still requests compensation for the accepted PUT')
    release({ registered: true, status: 'registered', id: 'fixture-registration' })
    await flush()
    await advance(60000)
    assert.deepEqual(inputs.map(input => input.token), ['fixture-token'])
    assert.equal(hostCalls, 1)
    assert.equal(timers.size, 0)
    assert.equal(history.length, updates)
  `)
})

test('a late GET finishes safely but cannot publish stale state or replay a pending old token', () => {
  runCase(`
    let resolveOld
    hostImpl = () => hostCalls === 1 ? new Promise(resolve => { resolveOld = resolve }) : Promise.resolve({ platforms: { android: true, ios: false }, status: 'configured' })
    await render()
    tokenListener({ data: 'stale-pending-token' })
    emit('background')
    assert.equal(signals[0].aborted, false, 'backgrounding must let an accepted registration drain safely')
    tokenImpl = async () => 'fresh-token'
    emit('active')
    resolveOld({ platforms: { android: true, ios: false }, status: 'configured' })
    await flush()
    assert.equal(registerCalls, 2, 'the in-flight attempt may finish before the new foreground check')
    assert.equal(inputs.at(-1).token, 'fresh-token', 'foregrounding must re-read the latest native token')
    assert.equal(inputs.some(input => input.token === 'stale-pending-token'), false)
    assert.equal(history.filter(info => info.status === 'registered').length, 1, 'only the current foreground result can update status')
    assert.equal(status().status, 'registered')
  `)
})

for (const [name, setup, expectedStatus, issue] of [
  ['401', "hostImpl = async () => { throw new ApiError('denied', 401) }", 'error', 'authorization'],
  ['403', "hostImpl = async () => { throw new ApiError('denied', 403) }", 'error', 'authorization'],
  ['old desktop', "hostImpl = async () => { throw new ApiError('missing', 404) }", 'unsupported', 'hostUnsupported'],
  ['unsupported method', "hostImpl = async () => { throw new ApiError('missing', 405) }", 'unsupported', 'hostUnsupported'],
  ['missing native configuration', "tokenImpl = async () => { throw Object.assign(new Error('missing Firebase'), { code: 'NOT_CONFIGURED' }) }", 'unsupported', 'deviceNotConfigured'],
  ['damaged preferences', "preferencesError = 'invalid preferences'", 'error', 'storage'],
]) {
  test(`${name} does not enter an automatic retry loop`, () => {
    runCase(`
      ${setup}
      await render()
      assert.equal(status().status, ${JSON.stringify(expectedStatus)})
      assert.equal(status().issue, ${JSON.stringify(issue)})
      assert.equal(timers.size, 0)
      const calls = hostCalls
      await advance(60000)
      assert.equal(hostCalls, calls)
      assert.equal(registerCalls, 0)
    `)
  })
}

test('unconfigured desktops do not poll but can be checked again manually', () => {
  runCase(`
    hostImpl = async () => ({ platforms: { android: false, ios: false }, status: 'notConfigured' })
    await render()
    assert.equal(status().status, 'notConfigured')
    assert.equal(timers.size, 0)
    hostImpl = async () => ({ platforms: { android: true, ios: false }, status: 'configured' })
    retry(); await flush()
    assert.equal(status().status, 'registered')
    assert.equal(hostCalls, 2)
  `)
})

test('unavailable device tokens retry finitely without reporting missing build configuration', () => {
  runCase(`
    tokenImpl = async () => {
      if (tokenCalls === 1) throw Object.assign(new Error('temporary token failure'), { code: 'UNAVAILABLE' })
      return 'fixture-token'
    }
    await render()
    assert.equal(status().status, 'error')
    assert.equal(status().issue, 'deviceUnavailable')
    assert.equal(hostCalls, 0, 'device capability is checked before computer connectivity')
    await advance(2000)
    assert.equal(status().status, 'registered')
  `)
})

test('permission denial remains visible when revoking old registration fails offline', () => {
  runCase(`
    permission = false
    revokeImpl = async () => { throw new ApiError('offline', 0, 'NETWORK_ERROR') }
    await render()
    assert.equal(status().status, 'permissionRequired')
    assert.equal(revoked, 1)
    assert.equal(tokenCalls, 0)
    assert.equal(timers.size, 0)
  `)
})

test('proof storage failures remain distinct from connection failures and do not retry', () => {
  runCase(`
    registerImpl = async () => { throw new Error('SecureStore write failed') }
    await render()
    assert.equal(status().status, 'error')
    assert.equal(status().issue, 'storage')
    assert.equal(timers.size, 0)
    assert.equal(registerCalls, 1)
  `)
})

test('late registration completion cannot update status after unmount', () => {
  runCase(`
    let finishPut, putSignal
    registerImpl = signal => { putSignal = signal; return new Promise(resolve => { finishPut = resolve }) }
    await render()
    assert.equal(registerCalls, 1)
    const before = history.length
    unmount()
    assert.equal(putSignal.aborted, true, 'coordinator must receive cancellation for compensating an accepted PUT')
    finishPut({ registered: true, status: 'registered', id: 'late-registration' })
    await flush()
    assert.equal(history.length, before, 'late accepted registration must not revive the departed screen')
    assert.equal(timers.size, 0)
    retry(); await flush()
    assert.equal(registerCalls, 1, 'unmount must remove manual retry registration')
  `)
})

test('losing connection credentials clears a previously registered status', () => {
  runCase(`
    await render()
    assert.equal(status().status, 'registered')
    connected = false
    connectionError = 'credential missing'
    await render()
    assert.equal(status().status, 'error')
    assert.equal(status().issue, 'authorization')
    assert.equal(timers.size, 0)
    retry(); await flush()
    assert.equal(registerCalls, 1)
  `)
})

test('a native token rotation in background registers once without starting retry polling', () => {
  runCase(`
    await render()
    assert.equal(status().status, 'registered')
    emit('background')
    const previousUpdates = history.length
    tokenListener({ data: 'background-rotated-token' })
    await flush()
    assert.equal(registerCalls, 2, 'background token rotation must update the computer once')
    assert.equal(inputs.at(-1).token, 'background-rotated-token')
    assert.equal(tokenCalls, 1, 'native rotation event already supplies the new token')
    assert.equal(timers.size, 0)
    assert.equal(history.length, previousUpdates, 'background work must not publish stale screen status')
    hostImpl = async () => { throw new ApiError('offline', 0, 'NETWORK_ERROR') }
    tokenListener({ data: 'another-background-token' })
    await flush()
    assert.equal(hostCalls, 3)
    assert.equal(timers.size, 0, 'failed background rotation must not start a retry timer')
    await advance(60000)
    assert.equal(hostCalls, 3)
  `)
})
