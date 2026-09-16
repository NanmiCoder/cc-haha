import { afterEach, describe, expect, it } from 'bun:test'
import {
  cancelQqQrLogin,
  pollQqQrLogin,
  resetQqQrLoginsForTest,
  setQqQrConnector,
  startQqQrLogin,
  type StartQrConnect,
} from '../qr-auth.js'

type Controls = {
  displayQr: (url: string) => void
  succeed: (credentials: Array<{ appId: string; appSecret: string; userOpenid?: string }>) => void
  fail: (error: Error) => void
  disposed: () => number
  options: () => { displayQrCodeToConsole?: boolean; source?: string } | undefined
}

/**
 * A stand-in for the connector SDK that lets a test drive its callbacks.
 *
 * `startQqQrLogin` resolves the connector asynchronously, so a test that drives
 * a callback on the very next line would otherwise race the registration.
 * Actions queued before the connector starts are replayed the moment it does.
 */
function installFakeConnector(): Controls {
  let callbacks: Parameters<StartQrConnect>[0] | null = null
  let options: Parameters<StartQrConnect>[1]
  let disposeCount = 0
  const queued: Array<(cb: Parameters<StartQrConnect>[0]) => void> = []

  const run = (action: (cb: Parameters<StartQrConnect>[0]) => void) => {
    if (callbacks) action(callbacks)
    else queued.push(action)
  }

  const impl: StartQrConnect = (cb, opts) => {
    callbacks = cb
    options = opts
    for (const action of queued.splice(0)) action(cb)
    return () => {
      disposeCount += 1
    }
  }
  setQqQrConnector(impl)

  return {
    displayQr: (url) => run((cb) => cb.onQrDisplayed?.(url)),
    succeed: (credentials) => run((cb) => cb.onSuccess(credentials)),
    fail: (error) => run((cb) => cb.onFailure(error)),
    disposed: () => disposeCount,
    options: () => options,
  }
}

afterEach(() => {
  resetQqQrLoginsForTest()
  setQqQrConnector(null)
})

describe('startQqQrLogin', () => {
  it('resolves with the QR URL the connector reports and never prints it', async () => {
    const controls = installFakeConnector()
    const pending = startQqQrLogin({ sessionKey: 'k1' })
    controls.displayQr('https://qq.example/scan?token=1')

    const started = await pending

    expect(started).toMatchObject({
      sessionKey: 'k1',
      verificationUrl: 'https://qq.example/scan?token=1',
    })
    // A desktop app renders the QR itself; console output would be noise and
    // would leak the code into the sidecar log.
    expect(controls.options()?.displayQrCodeToConsole).toBe(false)
    expect(controls.options()?.source).toBe('claude-code-haha')
  })

  it('rejects and disposes the connector when it fails before showing a code', async () => {
    const controls = installFakeConnector()
    const pending = startQqQrLogin({ sessionKey: 'k2' })
    controls.fail(new Error('connector exploded'))

    await expect(pending).rejects.toThrow('connector exploded')
    expect(controls.disposed()).toBe(1)
  })

  // Each start mints a fresh key, so without superseding, an abandoned scan
  // keeps a connector polling the vendor until its TTL expires — and every
  // retry stacks another one on top.
  it('disposes an abandoned attempt when a new scan starts', async () => {
    const first = installFakeConnector()
    const startedFirst = startQqQrLogin({ sessionKey: 'abandoned' })
    first.displayQr('https://qq.example/one')
    await startedFirst

    const second = installFakeConnector()
    const startedSecond = startQqQrLogin({ sessionKey: 'fresh' })
    second.displayQr('https://qq.example/two')
    await startedSecond

    expect(first.disposed()).toBe(1)
    expect(pollQqQrLogin({ sessionKey: 'abandoned' })).toMatchObject({ status: 'not_started' })
    expect(pollQqQrLogin({ sessionKey: 'fresh' })).toMatchObject({ status: 'waiting' })
  })

  it('supersedes a previous attempt on the same session key', async () => {
    const first = installFakeConnector()
    const startedFirst = startQqQrLogin({ sessionKey: 'same' })
    first.displayQr('https://qq.example/one')
    await startedFirst

    const second = installFakeConnector()
    const startedSecond = startQqQrLogin({ sessionKey: 'same' })
    second.displayQr('https://qq.example/two')
    await startedSecond

    expect(first.disposed()).toBe(1)
    expect(pollQqQrLogin({ sessionKey: 'same' })).toMatchObject({ status: 'waiting' })
  })
})

describe('pollQqQrLogin', () => {
  async function started(sessionKey = 'poll') {
    const controls = installFakeConnector()
    const pending = startQqQrLogin({ sessionKey })
    controls.displayQr('https://qq.example/scan')
    await pending
    return controls
  }

  it('waits until the connector reports credentials', async () => {
    const controls = await started()

    expect(pollQqQrLogin({ sessionKey: 'poll' })).toMatchObject({ connected: false, status: 'waiting' })

    controls.succeed([{ appId: 'app-1', appSecret: 'secret-1', userOpenid: 'ou-1' }])

    expect(pollQqQrLogin({ sessionKey: 'poll' })).toEqual({
      connected: true,
      appId: 'app-1',
      appSecret: 'secret-1',
      userOpenid: 'ou-1',
    })
  })

  it('latches success so a later poll cannot resurrect the attempt', async () => {
    const controls = await started()
    controls.succeed([{ appId: 'app-1', appSecret: 'secret-1' }])

    expect(pollQqQrLogin({ sessionKey: 'poll' })).toMatchObject({ connected: true })
    expect(pollQqQrLogin({ sessionKey: 'poll' })).toMatchObject({ status: 'not_started' })
  })

  it('treats incomplete credentials as a failure rather than binding a broken bot', async () => {
    const controls = await started()
    controls.succeed([{ appId: 'app-1', appSecret: '' }])

    expect(pollQqQrLogin({ sessionKey: 'poll' })).toMatchObject({ connected: false, status: 'failed' })
  })

  it('maps an expiry failure to expired and any other failure to failed', async () => {
    const expiring = await started('expiry')
    expiring.fail(new Error('device code expired'))
    expect(pollQqQrLogin({ sessionKey: 'expiry' })).toMatchObject({ status: 'expired' })

    const failing = await started('other')
    failing.fail(new Error('network down'))
    expect(pollQqQrLogin({ sessionKey: 'other' })).toMatchObject({ status: 'failed' })
  })

  it('reports a rotated QR exactly once so the UI redraws without flicker', async () => {
    const controls = await started()

    controls.displayQr('https://qq.example/refreshed')

    const afterRotation = pollQqQrLogin({ sessionKey: 'poll' })
    expect(afterRotation).toMatchObject({
      status: 'waiting',
      verificationUrl: 'https://qq.example/refreshed',
    })

    // A repeat poll must not keep re-delivering the same URL, or the settings
    // page would regenerate the image on every tick.
    const settled = pollQqQrLogin({ sessionKey: 'poll' })
    expect(settled.connected).toBe(false)
    expect((settled as { verificationUrl?: string }).verificationUrl).toBeUndefined()
  })

  it('reports an unknown session key instead of throwing', () => {
    expect(pollQqQrLogin({ sessionKey: 'missing' })).toMatchObject({ status: 'not_started' })
  })

  it('disposes the connector when the attempt is cancelled', async () => {
    const controls = await started()

    cancelQqQrLogin('poll')

    expect(controls.disposed()).toBe(1)
    expect(pollQqQrLogin({ sessionKey: 'poll' })).toMatchObject({ status: 'not_started' })
  })
})
