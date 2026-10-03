import { describe, expect, it, vi } from 'vitest'
import {
  WORKSPACE_BROWSER_INITIAL_SRC,
  WORKSPACE_BROWSER_PARTITION,
} from '../../src/lib/workspace/browserGuestContract'
import {
  applyWorkspaceBrowserAttachPolicy,
  installWorkspaceBrowserGuestPolicy,
  resolveWorkspaceBrowserGuest,
} from './workspaceBrowserGuest'

const PRELOAD = '/app/electron-dist/preview-preload.cjs'
const browserAttach = { partition: WORKSPACE_BROWSER_PARTITION, src: WORKSPACE_BROWSER_INITIAL_SRC }

describe('workspace browser attach policy', () => {
  it('pins the sandboxed preferences and the preview preload, whatever the element asked for', () => {
    // Everything a `<webview>` attribute or `webpreferences` string could
    // request on its way here.
    const requested: Record<string, unknown> = {
      preload: '/tmp/evil.js',
      preloadURL: 'file:///tmp/evil.js',
      nodeIntegration: true,
      nodeIntegrationInSubFrames: true,
      nodeIntegrationInWorker: true,
      contextIsolation: false,
      sandbox: false,
      webSecurity: false,
      allowRunningInsecureContent: true,
      experimentalFeatures: true,
      enableBlinkFeatures: 'Foo',
      disableBlinkFeatures: 'Bar',
      additionalArguments: ['--evil'],
      plugins: true,
      webviewTag: true,
      zoomFactor: 3,
    }
    expect(applyWorkspaceBrowserAttachPolicy(requested, browserAttach, { preload: PRELOAD })).toBe(true)
    expect(requested).toEqual({
      preload: PRELOAD,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      plugins: false,
      webviewTag: false,
      zoomFactor: 1,
    })
  })

  it.each([
    ['the renderer session', { partition: undefined, src: WORKSPACE_BROWSER_INITIAL_SRC }],
    ['another partition', { partition: 'persist:other', src: WORKSPACE_BROWSER_INITIAL_SRC }],
    ['a page the renderer picked', { partition: WORKSPACE_BROWSER_PARTITION, src: 'https://example.com/' }],
    ['a local file', { partition: WORKSPACE_BROWSER_PARTITION, src: 'file:///etc/passwd' }],
  ])('denies a guest for %s', (_name, params) => {
    const preferences: Record<string, unknown> = { nodeIntegration: true }
    expect(applyWorkspaceBrowserAttachPolicy(preferences, params, { preload: PRELOAD })).toBe(false)
  })

  it('cancels a denied attach and confines every attached guest until it is adopted', () => {
    const handlers = new Map<string, (...args: never[]) => void>()
    installWorkspaceBrowserGuestPolicy({
      on: (event, handler) => { handlers.set(event, handler) },
    }, { preload: PRELOAD })
    const willAttach = handlers.get('will-attach-webview') as unknown as (
      event: { preventDefault(): void }, preferences: Record<string, unknown>, params: unknown,
    ) => void
    const denied = { preventDefault: vi.fn() }
    willAttach(denied, {}, { partition: 'persist:other', src: WORKSPACE_BROWSER_INITIAL_SRC })
    expect(denied.preventDefault).toHaveBeenCalledTimes(1)
    const allowed = { preventDefault: vi.fn() }
    willAttach(allowed, {}, browserAttach)
    expect(allowed.preventDefault).not.toHaveBeenCalled()

    let openHandler: ((details: { url: string }) => unknown) | undefined
    const navigateHandlers: Array<(event: { preventDefault(): void }, url: string) => void> = []
    const didAttach = handlers.get('did-attach-webview') as unknown as (event: unknown, guest: unknown) => void
    didAttach({}, {
      setWindowOpenHandler: (handler: (details: { url: string }) => unknown) => { openHandler = handler },
      on: (_event: string, handler: (event: { preventDefault(): void }, url: string) => void) => { navigateHandlers.push(handler) },
    })
    expect(openHandler?.({ url: 'https://popup.example/' })).toEqual({ action: 'deny' })
    const blocked = { preventDefault: vi.fn() }
    navigateHandlers[0]!(blocked, 'file:///etc/passwd')
    const allowedNavigation = { preventDefault: vi.fn() }
    navigateHandlers[0]!(allowedNavigation, 'https://example.com/')
    expect(blocked.preventDefault).toHaveBeenCalledTimes(1)
    expect(allowedNavigation.preventDefault).not.toHaveBeenCalled()
  })
})

describe('workspace browser guest resolution', () => {
  const host = { id: 1 }
  const browserSession = { name: 'browser' }
  const guest = (overrides: Partial<{ type: string, host: unknown, session: unknown, destroyed: boolean }> = {}) => ({
    isDestroyed: () => overrides.destroyed ?? false,
    getType: () => overrides.type ?? 'webview',
    hostWebContents: 'host' in overrides ? overrides.host : host,
    session: 'session' in overrides ? overrides.session : browserSession,
  })

  it('adopts a webview of the main window in the browser partition', () => {
    const page = guest()
    expect(resolveWorkspaceBrowserGuest(7, { fromId: () => page, host, session: browserSession })).toBe(page)
  })

  it.each([
    ['a malformed id', 0, guest()],
    ['a fractional id', 1.5, guest()],
    ['a string id', '7', guest()],
    ['a missing guest', 7, null],
    ['a destroyed guest', 7, guest({ destroyed: true })],
    // The renderer's own webContents carries the local access token.
    ['the renderer itself', 7, guest({ type: 'window', host: null })],
    ['another window’s webview', 7, guest({ host: { id: 2 } })],
    ['a webview in another session', 7, guest({ session: { name: 'renderer' } })],
  ])('refuses %s', (_name, id, candidate) => {
    expect(() => resolveWorkspaceBrowserGuest(id, {
      fromId: () => candidate,
      host,
      session: browserSession,
    })).toThrow()
  })
})
