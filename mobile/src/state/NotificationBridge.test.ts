import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'bun:test'

/** Isolated process: React, Expo and the app contexts are mocked before the bridge loads. */
function runCase(body: string) {
  const directory = mkdtempSync(join(tmpdir(), 'mobile-notification-bridge-'))
  const script = `
    import { mock } from 'bun:test'
    import assert from 'node:assert/strict'
    import { createHash, createHmac } from 'node:crypto'
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
    mock.module(${JSON.stringify(import.meta.resolve('react-native'))}, () => ({ Platform: { OS: 'ios' }, AppState }))
    const pushed = []
    mock.module(${JSON.stringify(import.meta.resolve('expo-router'))}, () => ({ router: { push: target => pushed.push(target) }, useRootNavigationState: () => ({ key: 'root' }) }))
    let presented = [], lastResponse = null, responseListener, receivedListener, handler
    const dismissed = []
    let cleared = 0
    mock.module(${JSON.stringify(import.meta.resolve('expo-notifications'))}, () => ({
      setNotificationHandler: value => { handler = value },
      setNotificationCategoryAsync: async () => {},
      addNotificationResponseReceivedListener: listener => { responseListener = listener; return { remove() {} } },
      getLastNotificationResponse: () => lastResponse,
      clearLastNotificationResponse: () => { cleared++; lastResponse = null },
      addNotificationReceivedListener: listener => { receivedListener = listener; return { remove() {} } },
      getPresentedNotificationsAsync: async () => presented,
      dismissNotificationAsync: async id => { dismissed.push(id) },
      getPermissionsAsync: async () => ({ granted: true }),
      scheduleNotificationAsync: async () => {},
    }))
    mock.module(${JSON.stringify(import.meta.resolve('./notificationChannel'))}, () => ({ ensureNotificationChannel: async () => {} }))
    mock.module(${JSON.stringify(import.meta.resolve('./PushRegistrationContext'))}, () => ({ usePushRegistration: () => undefined }))
    mock.module(${JSON.stringify(import.meta.resolve('./PreferencesContext'))}, () => ({ usePreferences: () => ({ preferences: {}, ready: false, error: '' }) }))
    mock.module(${JSON.stringify(import.meta.resolve('./DashboardContext'))}, () => ({ useDashboard: () => ({ snapshot: null, fresh: false }) }))
    const OLD = 'https://old-tunnel.trycloudflare.com', NEW = 'https://new-tunnel.trycloudflare.com', NEWER = 'https://newer-tunnel.trycloudflare.com'
    const desk = { id: 'desk', name: 'Desk', url: OLD, auth: 'remote' }
    const credentials = { desk: 'native_fixture-desk' }
    const relocated = []
    const app = {
      registry: { version: 1, hosts: [desk], selectedId: desk.id },
      ready: true,
      credential: async id => credentials[id] ?? null,
      relocate: async (id, url) => { relocated.push([id, url]) },
    }
    mock.module(${JSON.stringify(import.meta.resolve('./AppContext'))}, () => ({ useApp: () => app }))
    const sign = (url, credential = credentials.desk) =>
      createHmac('sha256', createHash('sha256').update(credential).digest('hex')).update('cc-haha-host-url\\n' + url).digest('base64url')
    const hostUrl = (identifier, url, mac = sign(url), date = 0) => ({
      date,
      request: { identifier, content: { title: '电脑地址已更新 · cc-haha', data: { hostId: 'desk', eventType: 'hostUrl', url, mac } }, trigger: { type: 'push' } },
    })
    const tap = (notification, actionIdentifier = 'expo.modules.notifications.actions.DEFAULT') => ({ notification, actionIdentifier })
    const module = await import(${JSON.stringify(import.meta.resolve('./NotificationBridge'))})
    const render = async () => {
      cursor = 0
      module.NotificationBridge()
      const pending = effects; effects = []; pending.forEach(effect => effect())
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

test('address notifications left in the notification center are applied at launch, newest last, and cleared', () => {
  runCase(`
    presented = [
      hostUrl('newer', NEWER, undefined, 2000),
      hostUrl('forged', 'https://evil.example', sign('https://evil.example', 'native_guess'), 3000),
      hostUrl('new', NEW, undefined, 1000),
      { date: 500, request: { identifier: 'chat', content: { data: { hostId: 'desk', sessionId: 's', eventType: 'completed' } }, trigger: { type: 'push' } } },
    ]
    await render()
    assert.deepEqual(relocated, [['desk', NEW], ['desk', NEWER]])
    // A forged one is left alone (and never applied); chat notifications are not touched.
    assert.deepEqual(dismissed, ['new', 'newer'])
    assert.deepEqual(pushed, [])
  `)
})

test('a tapped address notification relocates without opening a chat, and is consumed once', () => {
  runCase(`
    lastResponse = tap(hostUrl('tapped', NEW))
    await render()
    assert.deepEqual(relocated, [['desk', NEW]])
    assert.deepEqual(pushed, [])
    assert.equal(cleared, 1)
    assert.deepEqual(dismissed, ['tapped'])
    // The listener replays the same response: nothing happens twice.
    responseListener(tap(hostUrl('tapped', NEW))); await flush()
    assert.deepEqual(relocated, [['desk', NEW]])
    // Ordinary chat notifications still open their session.
    responseListener(tap({ date: 0, request: { identifier: 'chat', content: { data: { hostId: 'desk', sessionId: 'session-1', eventType: 'completed' } }, trigger: { type: 'push' } } }))
    assert.equal(pushed.length, 1)
    assert.equal(pushed[0].params.id, 'session-1')
  `)
})

test('an address notification arriving while the app is open is applied silently; unverified or unknown ones are ignored', () => {
  runCase(`
    await render()
    const notification = hostUrl('live', NEW)
    assert.deepEqual(await handler.handleNotification(notification), { shouldShowBanner: false, shouldShowList: false, shouldPlaySound: false, shouldSetBadge: false })
    receivedListener(notification); await flush()
    assert.deepEqual(relocated, [['desk', NEW]])
    receivedListener(hostUrl('forged', NEWER, sign(NEWER, 'native_guess'))); await flush()
    receivedListener({ date: 0, request: { identifier: 'ghost', content: { data: { hostId: 'ghost', eventType: 'hostUrl', url: NEWER, mac: sign(NEWER) } } } }); await flush()
    assert.deepEqual(relocated, [['desk', NEW]])
    // The settings test still shows its banner in the foreground.
    assert.equal((await handler.handleNotification({ request: { identifier: 't', content: { data: { hostId: 'desk', eventType: 'test' } } } })).shouldShowBanner, true)
  `)
})

test('coming back to the app picks up an address notification that arrived in the background', () => {
  runCase(`
    await render()
    assert.deepEqual(relocated, [])
    emit('background')
    presented = [hostUrl('while-away', NEW)]
    emit('active'); await flush()
    assert.deepEqual(relocated, [['desk', NEW]])
    assert.deepEqual(dismissed, ['while-away'])
  `)
})
