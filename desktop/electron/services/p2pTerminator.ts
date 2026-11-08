import type { BrowserWindowConstructorOptions, Session } from 'electron'
import type { DesktopPublicAccessStatus } from '../../src/lib/desktopHost/types'

/** The host window's own in-memory session; nothing else uses it. */
export const P2P_PARTITION = 'cc-haha-p2p'
/** How long a stopping host may take to close its peer connections before its window is destroyed. */
export const GRACEFUL_STOP_MS = 200
/** Quick start failures in a row before the host waits for the next update or server restart. */
export const MAX_START_FAILURES = 5
/** A window that ran at least this long before failing starts its backoff over. */
const STABLE_MS = 60_000
const STOP_SCRIPT = 'window.p2pHost && window.p2pHost.stop(); undefined'

export type P2PHostState = NonNullable<DesktopPublicAccessStatus['p2pState']>

/**
 * Runs the desktop's WebRTC endpoint for phones (see electron/p2p/hostPage.ts)
 * in a hidden, sandboxed window while remote access is wanted and the user
 * allows direct connections. The window loads only our bundled script, can
 * reach only the local server's loopback port, and cannot navigate anywhere.
 */
export const P2P_WINDOW_OPTIONS: BrowserWindowConstructorOptions = Object.freeze({
  show: false,
  skipTaskbar: true,
  focusable: false,
  width: 1,
  height: 1,
  webPreferences: {
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    // Relaying must keep running while the desktop sits in the background.
    backgroundThrottling: false,
    partition: P2P_PARTITION,
    devTools: false,
    spellcheck: false,
  },
})

/**
 * Chromium hides local addresses behind mDNS names unless the page passes a
 * media permission check; with them hidden, LAN and IPv6 paths are lost. Only
 * the host's own partition passes that check, so the workspace browser and
 * previews keep the default privacy, and every actual request is denied.
 */
export function configureP2PSessionPermissions(session: Pick<Session, 'setPermissionCheckHandler' | 'setPermissionRequestHandler'>) {
  session.setPermissionCheckHandler((_contents, permission) => permission === 'media')
  session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
}

/** Remote access is on or on its way (the host talks to the main port, not the gateway) and direct connections are allowed. */
export function p2pHostWanted(status: Pick<DesktopPublicAccessStatus, 'state' | 'p2pEnabled'>) {
  return status.p2pEnabled !== false && (status.state === 'connecting' || status.state === 'reconnecting' || status.state === 'online')
}

/** The loopback endpoint the host window connects to, authorized by its own per-launch token. */
export function p2pEndpointUrl(serverUrl: string, endpointToken: string) {
  const url = new URL('/api/public-access/p2p/endpoint', serverUrl)
  url.protocol = 'ws:'
  url.searchParams.set('endpointToken', endpointToken)
  return url.toString()
}

type HostWindow = {
  loadURL(url: string): Promise<void>
  isDestroyed(): boolean
  destroy(): void
  on(event: 'closed', listener: () => void): unknown
  webContents: {
    executeJavaScript(code: string): Promise<unknown>
    on(event: 'render-process-gone' | 'will-navigate', listener: (...args: any[]) => void): unknown
    setWindowOpenHandler(handler: () => { action: 'deny' }): void
  }
}

/** The page: a strict CSP, then the bundled host script inline. */
export function hostPageUrl(script: string) {
  const html = '<!doctype html><meta charset="utf-8">' +
    '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'unsafe-inline\'; connect-src ws://127.0.0.1:*">' +
    `<script>${script.replace(/<\/script/gi, '<\\/script')}</script>`
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`
}

export class P2PTerminator {
  private window: HostWindow | null = null
  /** The current window has run `startP2PHost`, so it has peers to close on stop. */
  private live = false
  private wanted = false
  private failures = 0
  private gaveUp = false
  private hostState: Exclude<P2PHostState, 'off'> = 'starting'
  private retry: unknown
  private generation = 0
  private startedAt = 0

  constructor(private options: {
    createWindow(options: BrowserWindowConstructorOptions): HostWindow
    /** The bundled host script (electron-dist/p2p-host.js). */
    hostScript(): string
    /** See p2pEndpointUrl; null when no server runs. */
    endpoint(): string | null
    setTimer?: (callback: () => void, ms: number) => unknown
    clearTimer?: (handle: unknown) => void
    now?: () => number
  }) {}

  get running() { return this.window !== null }

  get state(): P2PHostState { return this.wanted ? this.hostState : 'off' }

  /** Run only while remote access is wanted and direct connections are allowed (see p2pHostWanted). */
  update(wanted: boolean): Promise<void> {
    this.wanted = wanted
    if (!wanted) return this.stop()
    if (this.gaveUp) this.resetFailures()
    if (!this.window && this.retry === undefined) void this.start()
    return Promise.resolve()
  }

  /** The local server restarted (new port or token): reconnect from scratch. */
  refresh(): Promise<void> {
    if (!this.wanted) return Promise.resolve()
    this.resetFailures()
    const stopped = this.stop()
    void this.start()
    return stopped
  }

  /** Quit and data migration: close every peer, then the window. Resolves within the grace period. */
  dispose(): Promise<void> {
    this.wanted = false
    return this.stop()
  }

  private resetFailures() {
    this.failures = 0
    this.gaveUp = false
  }

  private async start() {
    if (this.window) return
    // Without a server yet, the host starts on the next refresh (server ready).
    this.hostState = 'starting'
    const endpoint = this.options.endpoint()
    if (!endpoint) return
    const generation = ++this.generation
    this.startedAt = this.now()
    let stage = 'create window'
    try {
      const window = this.options.createWindow(P2P_WINDOW_OPTIONS)
      this.window = window
      window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
      window.webContents.on('will-navigate', (event: { preventDefault(): void }) => event.preventDefault())
      window.webContents.on('render-process-gone', (_event: unknown, details?: { reason?: string }) => {
        this.failed(generation, `renderer ${typeof details?.reason === 'string' ? details.reason : 'gone'}`)
      })
      window.on('closed', () => { if (this.window === window) this.failed(generation, 'window closed') })
      stage = 'load page'
      await window.loadURL(hostPageUrl(this.options.hostScript()))
      if (generation !== this.generation || window.isDestroyed()) return
      stage = 'start host'
      await window.webContents.executeJavaScript(`window.startP2PHost(${JSON.stringify(endpoint)}); undefined`)
      if (generation !== this.generation || window.isDestroyed()) return
      this.live = true
      this.hostState = 'ready'
    } catch {
      // Only the stage: messages from a failed script may echo the endpoint and its token.
      this.failed(generation, stage)
    }
  }

  private failed(generation: number, reason: string) {
    if (generation !== this.generation) return
    // A window that ran for a while failed once; one that dies right away keeps backing off.
    if (this.now() - this.startedAt > STABLE_MS) this.failures = 0
    void this.stop({ graceful: false })
    if (!this.wanted) return
    this.hostState = 'failed'
    this.failures++
    if (this.failures >= MAX_START_FAILURES) {
      this.gaveUp = true
      console.error(`[desktop] direct connections stopped after ${this.failures} failed host starts (last: ${reason}); retrying on the next remote access or server change`)
      return
    }
    const delay = Math.min(30_000, 1000 * 2 ** (this.failures - 1))
    this.retry = (this.options.setTimer ?? setTimeout)(() => {
      this.retry = undefined
      if (this.wanted && !this.window) void this.start()
    }, delay)
  }

  /**
   * A destroyed renderer cannot say goodbye, so phones would sit on a dead
   * direct path until ICE times out. A live host first closes its peer
   * connections (bounded by GRACEFUL_STOP_MS) and only then loses its window.
   */
  private stop({ graceful = true } = {}): Promise<void> {
    this.generation++
    if (this.retry !== undefined) (this.options.clearTimer ?? clearTimeout)(this.retry as never)
    this.retry = undefined
    const window = this.window
    const live = this.live
    this.window = null
    this.live = false
    if (!window || window.isDestroyed()) return Promise.resolve()
    if (!graceful || !live) {
      destroy(window)
      return Promise.resolve()
    }
    const clearTimer = this.options.clearTimer ?? clearTimeout
    return new Promise<void>((resolve) => {
      let finished = false
      const finish = () => {
        if (finished) return
        finished = true
        clearTimer(timer as never)
        destroy(window)
        resolve()
      }
      const timer = (this.options.setTimer ?? setTimeout)(finish, GRACEFUL_STOP_MS)
      try {
        window.webContents.executeJavaScript(STOP_SCRIPT).then(finish, finish)
      } catch {
        finish()
      }
    })
  }

  private now() { return (this.options.now ?? Date.now)() }
}

function destroy(window: HostWindow) {
  try {
    if (!window.isDestroyed()) window.destroy()
  } catch { /* already gone */ }
}
