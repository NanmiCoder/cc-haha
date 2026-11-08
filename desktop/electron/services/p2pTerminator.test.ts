import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import {
  configureP2PSessionPermissions,
  GRACEFUL_STOP_MS,
  hostPageUrl,
  MAX_START_FAILURES,
  P2P_PARTITION,
  P2P_WINDOW_OPTIONS,
  p2pEndpointUrl,
  p2pHostWanted,
  P2PTerminator,
} from './p2pTerminator'

const desktopDir = path.basename(process.cwd()) === 'desktop' ? process.cwd() : path.join(process.cwd(), 'desktop')
const mainSource = readFileSync(path.join(desktopDir, 'electron/main.ts'), 'utf8')
const STOP_SCRIPT = 'window.p2pHost && window.p2pHost.stop(); undefined'

function fakeWindows(options: { stopHangs?: boolean } = {}) {
  const windows: Array<{
    destroyed: boolean
    loaded?: string
    scripts: string[]
    handlers: Record<string, (...args: any[]) => void>
    openHandler?: () => { action: 'deny' }
    options: unknown
  }> = []
  const createWindow = (windowOptions: unknown) => {
    const record = { destroyed: false, scripts: [] as string[], handlers: {} as Record<string, (...args: any[]) => void>, options: windowOptions } as (typeof windows)[number]
    windows.push(record)
    return {
      loadURL: async (url: string) => { record.loaded = url },
      isDestroyed: () => record.destroyed,
      destroy: () => { record.destroyed = true },
      on: () => {},
      webContents: {
        executeJavaScript: (code: string) => {
          record.scripts.push(code)
          return options.stopHangs && code === STOP_SCRIPT ? new Promise<unknown>(() => {}) : Promise.resolve(undefined)
        },
        on: (event: string, listener: (...args: any[]) => void) => { record.handlers[event] = listener },
        setWindowOpenHandler: (handler: () => { action: 'deny' }) => { record.openHandler = handler },
      },
    }
  }
  return { windows, createWindow }
}
function fakeTimers() {
  const timers: Array<{ ms: number; run: () => void; cleared: boolean }> = []
  return {
    timers,
    pending: () => timers.filter(timer => !timer.cleared),
    setTimer: (callback: () => void, ms: number) => {
      const timer = { ms, cleared: false, run: () => { timer.cleared = true; callback() } }
      timers.push(timer)
      return timers.length - 1
    },
    clearTimer: (handle: unknown) => { if (typeof handle === 'number' && timers[handle]) timers[handle]!.cleared = true },
  }
}
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve() }

afterEach(() => { vi.restoreAllMocks() })

describe('P2P endpoint window', () => {
  test('starts only when wanted and a server is running, and stops when no longer wanted', async () => {
    const { windows, createWindow } = fakeWindows()
    let endpoint: string | null = null
    const terminator = new P2PTerminator({ createWindow, hostScript: () => 'host()', endpoint: () => endpoint })
    terminator.update(true)
    await flush()
    expect(windows).toHaveLength(0)
    endpoint = 'ws://127.0.0.1:3456/api/public-access/p2p/endpoint?endpointToken=fixture'
    terminator.refresh()
    await flush()
    expect(windows).toHaveLength(1)
    expect(windows[0]!.scripts).toEqual([`window.startP2PHost(${JSON.stringify(endpoint)}); undefined`])
    const stopped = terminator.update(false)
    expect(terminator.running).toBe(false)
    await stopped
    expect(windows[0]!.destroyed).toBe(true)
  })

  test('stopping asks the host to close its peers before the window is destroyed', async () => {
    const { windows, createWindow } = fakeWindows()
    const terminator = new P2PTerminator({ createWindow, hostScript: () => 'host()', endpoint: () => 'ws://127.0.0.1:1/x' })
    terminator.update(true)
    await flush()
    const stopped = terminator.update(false)
    // The phone sees the peer connection close instead of waiting out an ICE timeout.
    expect(windows[0]!.scripts.at(-1)).toBe(STOP_SCRIPT)
    expect(windows[0]!.destroyed).toBe(false)
    await stopped
    expect(windows[0]!.destroyed).toBe(true)
  })

  test('a host that does not answer its stop request is destroyed after a short grace period', async () => {
    const { windows, createWindow } = fakeWindows({ stopHangs: true })
    const clock = fakeTimers()
    const terminator = new P2PTerminator({ createWindow, hostScript: () => 'host()', endpoint: () => 'ws://127.0.0.1:1/x', setTimer: clock.setTimer, clearTimer: clock.clearTimer })
    terminator.update(true)
    await flush()
    let done = false
    void terminator.dispose().then(() => { done = true })
    await flush()
    expect(done).toBe(false)
    expect(windows[0]!.destroyed).toBe(false)
    const grace = clock.pending().find(timer => timer.ms === GRACEFUL_STOP_MS)!
    expect(grace).toBeDefined()
    grace.run()
    await flush()
    expect(windows[0]!.destroyed).toBe(true)
    expect(done).toBe(true)
  })

  test('a crashed renderer is destroyed at once, without a stop request', async () => {
    const { windows, createWindow } = fakeWindows({ stopHangs: true })
    const clock = fakeTimers()
    const terminator = new P2PTerminator({ createWindow, hostScript: () => 'host()', endpoint: () => 'ws://127.0.0.1:1/x', setTimer: clock.setTimer, clearTimer: clock.clearTimer })
    terminator.update(true)
    await flush()
    windows[0]!.handlers['render-process-gone']!({}, { reason: 'crashed' })
    expect(windows[0]!.destroyed).toBe(true)
    expect(windows[0]!.scripts).not.toContain(STOP_SCRIPT)
    await terminator.dispose()
  })

  test('the window is locked down: hidden, sandboxed, isolated, never navigates or opens windows', async () => {
    expect(P2P_WINDOW_OPTIONS).toMatchObject({
      show: false,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, devTools: false, partition: P2P_PARTITION },
    })
    const { windows, createWindow } = fakeWindows()
    const terminator = new P2PTerminator({ createWindow, hostScript: () => 'host()', endpoint: () => 'ws://127.0.0.1:1/x' })
    terminator.update(true)
    await flush()
    const prevented: string[] = []
    windows[0]!.handlers['will-navigate']!({ preventDefault: () => prevented.push('navigate') })
    expect(prevented).toEqual(['navigate'])
    expect(windows[0]!.openHandler!()).toEqual({ action: 'deny' })
    const page = decodeURIComponent(windows[0]!.loaded!.slice('data:text/html;charset=utf-8,'.length))
    expect(page).toContain("default-src 'none'; script-src 'unsafe-inline'; connect-src ws://127.0.0.1:*")
    await terminator.dispose()
  })

  test('only the host partition reveals real local addresses; every other permission stays denied', () => {
    const handlers: { check?: (...args: any[]) => boolean; request?: (...args: any[]) => void } = {}
    configureP2PSessionPermissions({
      setPermissionCheckHandler: (handler: any) => { handlers.check = handler },
      setPermissionRequestHandler: (handler: any) => { handlers.request = handler },
    } as never)
    // Chromium shows host candidates (LAN, IPv6) only to a page whose media check passes.
    expect(handlers.check!(null, 'media', 'null', { mediaType: 'audio' })).toBe(true)
    expect(handlers.check!(null, 'media', 'null', { mediaType: 'video' })).toBe(true)
    for (const permission of ['geolocation', 'notifications', 'clipboard-read', 'midi', 'hid', 'serial', 'usb']) {
      expect(handlers.check!(null, permission, 'null', {})).toBe(false)
    }
    for (const permission of ['media', 'geolocation', 'notifications', 'openExternal']) {
      const callback = vi.fn()
      handlers.request!(null, permission, callback, {})
      expect(callback).toHaveBeenCalledWith(false)
    }
    // No global Chromium switch exposes local addresses to every page (workspace browser, previews).
    expect(mainSource).not.toContain('WebRtcHideLocalIpsWithMdns')
    expect(mainSource).not.toContain('configureWebRtcSwitches')
    expect(mainSource).toContain('configureP2PSessionPermissions(session.fromPartition(P2P_PARTITION))')
  })

  test('a crashed renderer restarts with backoff while still wanted', async () => {
    const { windows, createWindow } = fakeWindows()
    const clock = fakeTimers()
    let now = 0
    const terminator = new P2PTerminator({
      createWindow, hostScript: () => 'host()', endpoint: () => 'ws://127.0.0.1:1/x',
      setTimer: clock.setTimer, clearTimer: clock.clearTimer, now: () => now,
    })
    terminator.update(true)
    await flush()
    windows[0]!.handlers['render-process-gone']!()
    expect(windows[0]!.destroyed).toBe(true)
    expect(clock.pending().map(timer => timer.ms)).toEqual([1000])
    clock.pending()[0]!.run()
    await flush()
    windows[1]!.handlers['render-process-gone']!()
    expect(clock.timers.map(timer => timer.ms)).toEqual([1000, 2000])
    // A window that stayed up for minutes starts its backoff over.
    clock.timers[1]!.run()
    await flush()
    now += 5 * 60_000
    windows[2]!.handlers['render-process-gone']!()
    expect(clock.timers.map(timer => timer.ms)).toEqual([1000, 2000, 1000])
    await terminator.update(false)
    clock.timers[2]!.run()
    await flush()
    expect(windows).toHaveLength(3)
  })

  test('repeated quick start failures stop retrying, log once without the token, and resume on the next update', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown) => { unhandled.push(reason) }
    process.on('unhandledRejection', onUnhandled)
    try {
      const clock = fakeTimers()
      let attempts = 0
      const terminator = new P2PTerminator({
        createWindow: () => { attempts++; throw new Error('window creation failed') },
        hostScript: () => 'host()',
        endpoint: () => 'ws://127.0.0.1:1/api/public-access/p2p/endpoint?endpointToken=secret-endpoint-fixture',
        setTimer: clock.setTimer, clearTimer: clock.clearTimer, now: () => 0,
      })
      terminator.update(true)
      await flush()
      for (let failure = 1; failure < MAX_START_FAILURES; failure++) {
        expect(terminator.state).toBe('failed')
        clock.pending().at(-1)!.run()
        await flush()
      }
      expect(attempts).toBe(MAX_START_FAILURES)
      expect(clock.timers.map(timer => timer.ms)).toEqual([1000, 2000, 4000, 8000])
      expect(clock.pending()).toHaveLength(0)
      expect(terminator.state).toBe('failed')
      expect(error).toHaveBeenCalledOnce()
      expect(JSON.stringify(error.mock.calls)).not.toContain('secret-endpoint-fixture')
      await new Promise(resolve => setImmediate(resolve))
      expect(unhandled).toEqual([])
      // A later state change (or server restart) tries again from scratch.
      terminator.update(true)
      await flush()
      expect(attempts).toBe(MAX_START_FAILURES + 1)
      expect(clock.pending().map(timer => timer.ms)).toEqual([1000])
      await terminator.dispose()
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })

  test('reports its state: off, starting, ready, failed after a crash, off once unwanted', async () => {
    const { windows, createWindow } = fakeWindows()
    const clock = fakeTimers()
    let endpoint: string | null = null
    const terminator = new P2PTerminator({ createWindow, hostScript: () => 'host()', endpoint: () => endpoint, setTimer: clock.setTimer, clearTimer: clock.clearTimer })
    expect(terminator.state).toBe('off')
    terminator.update(true)
    expect(terminator.state).toBe('starting')
    endpoint = 'ws://127.0.0.1:1/x'
    terminator.refresh()
    expect(terminator.state).toBe('starting')
    await flush()
    expect(terminator.state).toBe('ready')
    windows[0]!.handlers['render-process-gone']!({}, { reason: 'oom' })
    expect(terminator.state).toBe('failed')
    await terminator.update(false)
    expect(terminator.state).toBe('off')
  })

  test('a server restart reconnects with the new endpoint', async () => {
    const { windows, createWindow } = fakeWindows()
    let endpoint = 'ws://127.0.0.1:1/x?endpointToken=a'
    const terminator = new P2PTerminator({ createWindow, hostScript: () => 'host()', endpoint: () => endpoint })
    terminator.update(true)
    await flush()
    endpoint = 'ws://127.0.0.1:2/x?endpointToken=b'
    terminator.refresh()
    await flush()
    expect(windows[0]!.destroyed).toBe(true)
    expect(windows[1]!.scripts[0]).toContain('endpointToken=b')
    await terminator.dispose()
  })

  test('a script cannot close its own tag inside the page', () => {
    const page = decodeURIComponent(hostPageUrl('a("</script><img>")').split(',')[1]!)
    expect(page.match(/<\/script>/g)).toHaveLength(1)
  })

  test('runs while remote access is wanted (also before it is online) and direct connections are allowed', () => {
    for (const state of ['connecting', 'reconnecting', 'online'] as const) {
      expect(p2pHostWanted({ state, p2pEnabled: true })).toBe(true)
      expect(p2pHostWanted({ state, p2pEnabled: false })).toBe(false)
    }
    for (const state of ['disabled', 'unconfigured', 'failed'] as const) expect(p2pHostWanted({ state, p2pEnabled: true })).toBe(false)
    expect(mainSource).toContain('getP2PTerminator().update(p2pHostWanted(status))')
  })

  test('the host connects with its own endpoint token, never the local access token', () => {
    const url = new URL(p2pEndpointUrl('http://127.0.0.1:3456', 'endpoint-fixture'))
    expect(url.toString()).toBe('ws://127.0.0.1:3456/api/public-access/p2p/endpoint?endpointToken=endpoint-fixture')
    expect(url.searchParams.has('localToken')).toBe(false)
    const block = mainSource.slice(mainSource.indexOf('function getP2PTerminator()'), mainSource.indexOf('function getPublicAccessManager()'))
    expect(block).toContain('p2pEndpointUrl(serverUrl, runtime.getP2PEndpointToken())')
    expect(block).not.toContain('getLocalAccessToken')
  })

  test('every public access status the settings page reads carries the host state', () => {
    const handlers = mainSource.split('\n').filter(line => line.includes('registerHandler(ELECTRON_IPC_CHANNELS.publicAccess'))
    expect(handlers.length).toBeGreaterThanOrEqual(6)
    for (const line of handlers) expect(line).toContain('publicAccessStatus')
  })
})
