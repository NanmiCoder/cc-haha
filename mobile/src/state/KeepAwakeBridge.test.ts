import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'bun:test'

/** Isolated process: React, React Native and expo-keep-awake are mocked before the bridge loads. */
function runCase(body: string) {
  const directory = mkdtempSync(join(tmpdir(), 'mobile-keep-awake-bridge-'))
  const script = `
    import { mock } from 'bun:test'
    import assert from 'node:assert/strict'
    const React = await import(${JSON.stringify(import.meta.resolve('react'))})
    let slots = [], cursor = 0, effects = []
    const same = (a, b) => a && b && a.length === b.length && a.every((value, i) => Object.is(value, b[i]))
    mock.module(${JSON.stringify(import.meta.resolve('react'))}, () => ({
      ...React, default: React,
      useRef(initial) { const id = cursor++; if (!(id in slots)) slots[id] = { current: initial }; return slots[id] },
      useEffect(effect, deps) {
        const id = cursor++
        if (!slots[id] || !same(slots[id].deps, deps)) {
          const previous = slots[id]
          slots[id] = { deps }
          effects.push(() => { previous?.cleanup?.(); slots[id].cleanup = effect() })
        }
      },
    }))
    const flush = async () => { for (let i = 0; i < 40; i++) await Promise.resolve() }
    const appListeners = new Set()
    const AppState = { currentState: 'active', addEventListener: (_name, listener) => { appListeners.add(listener); return { remove: () => appListeners.delete(listener) } } }
    const emit = state => { AppState.currentState = state; [...appListeners].forEach(listener => listener(state)) }
    mock.module(${JSON.stringify(import.meta.resolve('react-native'))}, () => ({ Platform: { OS: 'android' }, AppState }))
    const calls = []
    mock.module(${JSON.stringify(import.meta.resolve('expo-keep-awake'))}, () => ({
      activateKeepAwakeAsync: async tag => { calls.push('activate:' + tag) },
      deactivateKeepAwake: async tag => { calls.push('deactivate:' + tag) },
    }))
    let prefState = { preferences: { keepAwake: false }, ready: false, error: '' }
    mock.module(${JSON.stringify(import.meta.resolve('./PreferencesContext'))}, () => ({ usePreferences: () => prefState }))
    const module = await import(${JSON.stringify(import.meta.resolve('./KeepAwakeBridge'))})
    const render = async () => {
      cursor = 0
      module.KeepAwakeBridge()
      const pending = effects; effects = []; pending.forEach(effect => effect())
      await flush()
    }
    const unmount = async () => {
      slots.forEach(slot => slot?.cleanup?.())
      effects = []
      await flush()
    }
    ${body}
  `
  try {
    const path = join(directory, 'bridge.ts')
    writeFileSync(path, script)
    execFileSync(process.execPath, ['--no-env-file', path], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] })
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

test('KeepAwakeBridge tracks preference toggle, Android background/foreground, and unmount cleanup', () => {
  runCase(`
    await render()
    assert.deepEqual(calls, [])

    prefState = { preferences: { keepAwake: true }, ready: true, error: '' }
    await render()
    assert.deepEqual(calls, ['activate:cc-haha-keep-awake'])

    emit('background'); await flush()
    assert.deepEqual(calls, ['activate:cc-haha-keep-awake', 'deactivate:cc-haha-keep-awake'])

    emit('active'); await flush()
    assert.deepEqual(calls, [
      'activate:cc-haha-keep-awake',
      'deactivate:cc-haha-keep-awake',
      'activate:cc-haha-keep-awake',
    ])

    prefState = { preferences: { keepAwake: false }, ready: true, error: '' }
    await render()
    assert.deepEqual(calls, [
      'activate:cc-haha-keep-awake',
      'deactivate:cc-haha-keep-awake',
      'activate:cc-haha-keep-awake',
      'deactivate:cc-haha-keep-awake',
    ])

    prefState = { preferences: { keepAwake: true }, ready: true, error: '' }
    await render()
    await unmount()
    assert.equal(calls.at(-1), 'deactivate:cc-haha-keep-awake')
    assert.equal(appListeners.size, 0)
  `)
})
