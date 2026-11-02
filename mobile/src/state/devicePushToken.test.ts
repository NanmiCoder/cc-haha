import { execFileSync } from 'node:child_process'
import { test } from 'bun:test'

test('native push failures distinguish missing build configuration from transient service failures', () => {
  const script = `
    import { mock } from 'bun:test'
    import assert from 'node:assert/strict'
    let request = async () => ({ data: 'fixture-token' })
    let timeout, cleared = 0
    globalThis.setTimeout = callback => { timeout = callback; return 1 }
    globalThis.clearTimeout = () => { cleared++ }
    mock.module(${JSON.stringify(import.meta.resolve('expo-notifications'))}, () => ({ getDevicePushTokenAsync: () => request() }))
    const { getDevicePushToken, DevicePushTokenError } = await import(${JSON.stringify(import.meta.resolve('./devicePushToken'))})
    assert.equal(await getDevicePushToken(), 'fixture-token')
    request = async () => { throw Object.assign(new Error('Default FirebaseApp is not initialized in this process app.cchaha.mobile. Make sure to call FirebaseApp.initializeApp(Context) first.'), { code: 'E_REGISTRATION_FAILED' }) }
    await assert.rejects(getDevicePushToken(), error => error instanceof DevicePushTokenError && error.code === 'NOT_CONFIGURED')
    request = async () => { throw Object.assign(new Error('Fetching the token failed: SERVICE_NOT_AVAILABLE'), { code: 'E_REGISTRATION_FAILED' }) }
    await assert.rejects(getDevicePushToken(), error => error.code === 'UNAVAILABLE')
    request = async () => ({ data: '' })
    await assert.rejects(getDevicePushToken(), error => error.code === 'UNAVAILABLE')
    request = () => new Promise(() => {})
    const pending = getDevicePushToken()
    timeout()
    await assert.rejects(pending, error => error.code === 'TIMEOUT')
    assert.equal(cleared, 5)
  `
  execFileSync(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'inherit'] })
})

test('the Expo relay token separates a build without an EAS project from network failures', () => {
  const script = `
    import { mock } from 'bun:test'
    import assert from 'node:assert/strict'
    let request = async () => ({ type: 'expo', data: 'ExponentPushToken[fixture]' })
    let timeout
    globalThis.setTimeout = callback => { timeout = callback; return 1 }
    globalThis.clearTimeout = () => {}
    mock.module(${JSON.stringify(import.meta.resolve('expo-notifications'))}, () => ({ getExpoPushTokenAsync: (...args) => { assert.deepEqual(args, []); return request() } }))
    const { getExpoPushToken } = await import(${JSON.stringify(import.meta.resolve('./devicePushToken'))})
    assert.equal(await getExpoPushToken(), 'ExponentPushToken[fixture]')
    request = async () => { throw Object.assign(new Error('No "projectId" found.'), { code: 'ERR_NOTIFICATIONS_NO_EXPERIENCE_ID' }) }
    await assert.rejects(getExpoPushToken(), error => error.code === 'NOT_CONFIGURED')
    request = async () => { throw Object.assign(new Error('Network request failed'), { code: 'ERR_NOTIFICATIONS_NETWORK_ERROR' }) }
    await assert.rejects(getExpoPushToken(), error => error.code === 'UNAVAILABLE')
    request = () => new Promise(() => {})
    const pending = getExpoPushToken()
    timeout()
    await assert.rejects(pending, error => error.code === 'TIMEOUT')
  `
  execFileSync(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'inherit'] })
})
