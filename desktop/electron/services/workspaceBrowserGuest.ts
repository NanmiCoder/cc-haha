import {
  WORKSPACE_BROWSER_INITIAL_SRC,
  WORKSPACE_BROWSER_PARTITION,
} from '../../src/lib/workspace/browserGuestContract'
import { isHttpUrl } from './navigationGuards'

/**
 * Attach boundary for workspace browser `<webview>` guests.
 *
 * The main window enables `webviewTag` only so the workspace browser can be
 * composited with the DOM: a native `WebContentsView` always paints above the
 * page, which is what made menus, dialogs and other pages flicker behind or
 * underneath it. In exchange, the renderer may now ask for a guest, so every
 * attach is decided here, deny by default:
 *
 * - only the shared browser partition, starting from the fixed blank document;
 * - every preference the element could have requested is replaced with the
 *   sandboxed set the old `WebContentsView` used, plus the preview preload the
 *   annotation agent relies on.
 */

/** Keys the embedding element may set that must never reach a guest. */
const STRIPPED_PREFERENCE_KEYS = [
  'preloadURL',
  'enableBlinkFeatures',
  'disableBlinkFeatures',
  'additionalArguments',
  'nodeIntegrationInWorker',
] as const

export type WorkspaceBrowserAttachParams = {
  partition?: unknown
  src?: unknown
}

export function applyWorkspaceBrowserAttachPolicy(
  webPreferences: Record<string, unknown>,
  params: WorkspaceBrowserAttachParams,
  options: { preload: string },
): boolean {
  if (params.partition !== WORKSPACE_BROWSER_PARTITION) return false
  if (params.src !== WORKSPACE_BROWSER_INITIAL_SRC) return false
  for (const key of STRIPPED_PREFERENCE_KEYS) delete webPreferences[key]
  Object.assign(webPreferences, {
    preload: options.preload,
    contextIsolation: true,
    nodeIntegration: false,
    nodeIntegrationInSubFrames: false,
    sandbox: true,
    webSecurity: true,
    allowRunningInsecureContent: false,
    experimentalFeatures: false,
    plugins: false,
    // A page cannot nest a guest of its own.
    webviewTag: false,
    // Electron starts a guest at its embedder's zoom. App zoom never applied to
    // the old native view, so a page still starts at 100%.
    zoomFactor: 1,
  })
  return true
}

export type WorkspaceBrowserGuestLike = {
  isDestroyed(): boolean
  getType(): string
  hostWebContents?: unknown
  session?: unknown
}

export function resolveWorkspaceBrowserGuest<Guest extends WorkspaceBrowserGuestLike>(
  webContentsId: unknown,
  options: {
    fromId: (id: number) => Guest | undefined | null
    host: unknown
    session: unknown
  },
): Guest {
  if (typeof webContentsId !== 'number' || !Number.isSafeInteger(webContentsId) || webContentsId <= 0) {
    throw new Error('invalid workspace browser guest id')
  }
  const guest = options.fromId(webContentsId)
  if (!guest || guest.isDestroyed()) throw new Error('workspace browser guest is gone')
  // The id travels through the renderer, so it is only a claim. Adopt nothing
  // that is not a webview of the main window in the browser's own partition —
  // least of all the renderer itself, whose session carries the local token.
  if (guest.getType() !== 'webview' || guest.hostWebContents !== options.host || guest.session !== options.session) {
    throw new Error('not a workspace browser guest of the main window')
  }
  return guest
}

type AttachEvent = { preventDefault(): void }
type GuestBaseline = {
  setWindowOpenHandler(handler: (details: { url: string }) => { action: 'deny' }): void
  on(event: 'will-navigate', handler: (event: AttachEvent, url: string) => void): unknown
}

/** Electron's `WebContents` declares each event as its own overload. */
export type WorkspaceBrowserGuestHostLike = {
  on(event: string, handler: (...args: never[]) => void): unknown
}

export function installWorkspaceBrowserGuestPolicy(
  host: WorkspaceBrowserGuestHostLike,
  options: { preload: string },
): void {
  host.on('will-attach-webview', (
    event: AttachEvent,
    webPreferences: Record<string, unknown>,
    params: WorkspaceBrowserAttachParams,
  ) => {
    if (!applyWorkspaceBrowserAttachPolicy(webPreferences, params, options)) event.preventDefault()
  })
  host.on('did-attach-webview', (_event: unknown, guest: GuestBaseline) => {
    // Until the browser service adopts it, a guest can neither open a window
    // nor leave http(s). Adoption replaces the popup handler with its own.
    guest.setWindowOpenHandler(() => ({ action: 'deny' }))
    guest.on('will-navigate', (event, url) => {
      if (!isHttpUrl(url)) event.preventDefault()
    })
  })
}
