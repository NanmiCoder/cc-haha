import { readFileSync } from 'node:fs'
import path, { basename } from 'node:path'
import { matchWorkspaceShortcut } from '../../src/lib/workspace/shortcuts'
import type {
  PreviewBrowserControlsMessage,
  WorkspaceBrowserCaptureKind,
  WorkspaceBrowserEvent,
  WorkspaceBrowserFindOptions,
  WorkspaceBrowserHistoryEntry,
  WorkspaceBrowserMenuAction,
  WorkspaceBrowserMenuOptions,
} from '../../src/lib/desktopHost/types'
import { parsePreviewAgentMessage, type PreviewAgentMessage } from '../ipc/previewMessage'
import { parseHostMessage, type HostMessage } from '../../src/preview-agent/protocol'
import { WORKSPACE_BROWSER_INITIAL_SRC } from '../../src/lib/workspace/browserGuestContract'
import { isHttpUrl } from './navigationGuards'
import { normalizePreviewUrl, resolvePreviewScriptPath } from './preview'
import { normalizeZoomFactor } from './zoom'
import { WorkspaceBrowserMenuController, type WorkspaceBrowserMenuFactory } from './workspaceBrowserMenu'
import {
  DebuggerLeaseManager,
  type CdpEventNotice,
  type WorkspaceBrowserDebuggerLike,
} from './workspaceBrowserCdp'

export type { WorkspaceBrowserCaptureKind, WorkspaceBrowserEvent, WorkspaceBrowserFindOptions }
export { WORKSPACE_BROWSER_PARTITION } from '../../src/lib/workspace/browserGuestContract'

/** Mirrors the preview capture guard rails; a page controls these dimensions. */
const FULL_CAPTURE_MAX_EDGE = 16_384
const FULL_CAPTURE_MAX_PIXELS = 32_000_000

/**
 * A guest that is not on screen has no compositor frame, and `capturePage`
 * then waits ~30s before failing. Without a bound, a capture racing a tab
 * switch would keep the page's zoom chrome hidden for that long.
 */
const VIEWPORT_CAPTURE_TIMEOUT_MS = 5_000

/** Visit log bound. The native back/forward stack is unaffected by this cap. */
const MAX_HISTORY_ENTRIES = 200

/**
 * Default background guest resource guards.
 *
 * Every `<webview>` guest shares Chromium's single NetworkService process and
 * Electron main's IO thread with the desktop app itself, so a single runaway or
 * leaked background page can starve every desktop API request into timeouts.
 */
const DEFAULT_MAX_BACKGROUND_PAGES = 4
const DEFAULT_BACKGROUND_IDLE_EVICT_MS = 10 * 60_000
const DEFAULT_HEALTH_CHECK_INTERVAL_MS = 15_000
const DEFAULT_HIDDEN_MEMORY_LIMIT_KB = 1_536 * 1024 // 1.5 GiB
const DEFAULT_ACTIVE_MEMORY_LIMIT_KB = 3_072 * 1024 // 3.0 GiB
const DEFAULT_HARD_MEMORY_LIMIT_KB = 4_096 * 1024 // 4.0 GiB (immediate terminate)
const DEFAULT_HIDDEN_CPU_LIMIT_PERCENT = 120
const DEFAULT_MEMORY_STRIKE_THRESHOLD = 2
const DEFAULT_CPU_STRIKE_THRESHOLD = 3

export type WorkspaceBrowserProcessMetric = {
  pid: number
  cpu?: { percentCPUUsage?: number }
  memory?: { workingSetSize?: number, privateBytes?: number }
}

export type WorkspaceBrowserPageInfo = {
  tabId: string
  sessionId?: string
  url: string
  title: string
  visible: boolean
  zoomFactor: number
  appZoomFactor: number
}

export type WorkspaceBrowserPageClosedEvent = {
  tabId: string
  reason: 'closed' | 'crashed'
}

export type WorkspaceBrowserInternalPorts = {
  /** Local cc-haha server port: `/api/*` is blocked while `/preview-fs/*` and `/local-file/*` remain allowed. */
  serverPort?: number | null
  /** Internal loopback-only bridge/proxy ports blocked unconditionally for browser guests. */
  blockedPorts?: number[]
}

const CLOUD_METADATA_HOSTS = new Set([
  '169.254.169.254',
  '169.254.170.2',
  '100.100.100.200',
  'fd00:ec2::254',
  '::ffff:169.254.169.254',
  '::ffff:a9fe:a9fe',
  '::ffff:169.254.170.2',
  '::ffff:a9fe:aa02',
  '::ffff:100.100.100.200',
  '::ffff:6464:64c8',
  'metadata.google.internal',
  'metadata.goog',
])

function isLoopbackHost(hostname: string): boolean {
  if (
    hostname === 'localhost'
    || hostname.endsWith('.localhost')
    || hostname === '127.0.0.1'
    || hostname === '::1'
    || hostname === '::ffff:127.0.0.1'
    || hostname === '::ffff:7f00:1'
    || hostname === '0.0.0.0'
    || hostname === '::'
  ) {
    return true
  }
  if (/^127(?:\.\d{1,3}){3}$/.test(hostname)) return true
  if (/^::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}$/.test(hostname)) return true
  return false
}

function normalizeUrlPathnameForGuard(pathname: string): string {
  let decoded = pathname
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    decoded = pathname
  }
  return path.posix.normalize(decoded.replace(/\/+/g, '/')).toLowerCase()
}

/**
 * Defense-in-depth SSRF navigation guard for `<webview>` guests (`will-navigate`,
 * `will-redirect`, `setWindowOpenHandler`, `navigate`, and `create`).
 *
 * Blocks non-HTTP(S) schemes, cloud metadata endpoints, internal loopback
 * bridge/proxy ports, and the local server's `/api/*` endpoints while still
 * allowing legitimate `/preview-fs/*`, `/local-file/*`, and normal localhost
 * developer servers.
 */
export function isAllowedWorkspaceBrowserNavigationUrl(
  rawUrl: string,
  internalPorts?: WorkspaceBrowserInternalPorts,
): boolean {
  if (!isHttpUrl(rawUrl)) return false
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    return false
  }
  const hostname = parsed.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase()
  if (!hostname) return false
  if (CLOUD_METADATA_HOSTS.has(hostname)) return false

  if (isLoopbackHost(hostname) && internalPorts) {
    const port = parsed.port ? Number(parsed.port) : (parsed.protocol === 'https:' ? 443 : 80)
    if (internalPorts.blockedPorts?.includes(port)) return false
    if (internalPorts.serverPort && port === internalPorts.serverPort) {
      const normalizedPath = normalizeUrlPathnameForGuard(parsed.pathname)
      if (normalizedPath === '/api' || normalizedPath.startsWith('/api/')) {
        return false
      }
    }
  }
  return true
}

export type WorkspaceBrowserDownloadItemLike = {
  getFilename(): string
  getSavePath(): string
  getReceivedBytes(): number
  getTotalBytes(): number
  getState(): string
  on(event: 'updated', handler: (event: unknown, state: string) => void): unknown
  on(event: 'done', handler: (event: unknown, state: string) => void): unknown
}

export type WorkspaceBrowserSessionLike = {
  on(
    event: 'will-download',
    handler: (
      event: unknown,
      item: WorkspaceBrowserDownloadItemLike,
      webContents: unknown,
    ) => void,
  ): unknown
}

type WorkspaceBrowserNavigationHistoryLike = {
  canGoBack(): boolean
  canGoForward(): boolean
  goBack(): void
  goForward(): void
  clear?(): void
}

export type WorkspaceBrowserWebContentsLike = {
  loadURL(url: string): Promise<unknown>
  getURL(): string
  getTitle(): string
  isLoading(): boolean
  reload(): void
  reloadIgnoringCache(): void
  stop(): void
  findInPage(text: string, options?: WorkspaceBrowserFindOptions): number
  stopFindInPage(action: 'clearSelection'): void
  executeJavaScript(script: string): Promise<unknown>
  setWindowOpenHandler(handler: (details: { url: string }) => { action: 'deny' }): void
  on(event: 'did-start-loading', handler: () => void): unknown
  on(event: 'did-stop-loading', handler: () => void): unknown
  on(event: 'did-finish-load', handler: () => void): unknown
  on(event: 'did-start-navigation' | 'did-redirect-navigation', handler: (event: unknown, url: string, isInPlace: boolean, isMainFrame: boolean) => void): unknown
  on(event: 'zoom-changed', handler: (event: unknown, direction: string) => void): unknown
  on(event: 'before-input-event', handler: (event: { preventDefault(): void }, input: {
    type: string, key: string, code?: string, meta: boolean, control: boolean, shift: boolean, alt: boolean
  }) => void): unknown
  on(event: 'did-navigate', handler: (event: unknown, url: string) => void): unknown
  on(event: 'did-navigate-in-page', handler: (event: unknown, url: string, isMainFrame?: boolean) => void): unknown
  on(event: 'page-title-updated', handler: (event: unknown, title: string) => void): unknown
  on(
    event: 'did-fail-load',
    handler: (
      event: unknown,
      errorCode: number,
      errorDescription: string,
      validatedURL: string,
      isMainFrame: boolean,
    ) => void,
  ): unknown
  on(
    event: 'render-process-gone',
    handler: (event: unknown, details: { reason: string }) => void,
  ): unknown
  on(
    event: 'found-in-page',
    handler: (event: unknown, result: { activeMatchOrdinal: number, matches: number }) => void,
  ): unknown
  on(
    event: 'will-navigate' | 'will-redirect',
    handler: (event: { preventDefault: () => void }, url: string) => void,
  ): unknown
  on(event: 'destroyed', handler: () => void): unknown
  navigationHistory?: WorkspaceBrowserNavigationHistoryLike
  canGoBack?(): boolean
  canGoForward?(): boolean
  goBack?(): void
  goForward?(): void
  setZoomFactor?(factor: number): void
  getZoomFactor?(): number
  setBackgroundThrottling?(allowed: boolean): void
  getOSProcessId?(): number
  forcefullyCrashRenderer?(): void
  capturePage?(): Promise<{ toDataURL(): string }>
  printToPDF?(options: Record<string, unknown>): Promise<Uint8Array>
  debugger?: WorkspaceBrowserDebuggerLike
  session?: WorkspaceBrowserSessionLike
  close?(): void
  isDestroyed?(): boolean
  isFocused?(): boolean
}

export type WorkspaceBrowserParentWindowLike = {
  webContents?: {
    isDestroyed?(): boolean
    getZoomFactor?(): number
  }
  isDestroyed?(): boolean
}

export type WorkspaceBrowserCreateOptions = {
  sessionId?: string
  storageId: string
  url?: string
  /** The `<webview>` guest the renderer created for this page. */
  webContentsId: number
}

export type ElectronWorkspaceBrowserServiceOptions = {
  /**
   * Turns a renderer-reported id into the guest it names. It must throw for
   * anything that is not a workspace browser webview of the main window.
   */
  resolveGuest: (webContentsId: number) => WorkspaceBrowserWebContentsLike
  previewScriptPath: string
  emit: (event: WorkspaceBrowserEvent) => void
  /** Writes an exported PDF and resolves with the path it landed on. */
  writePdf?: (input: { data: Uint8Array, filename: string }) => Promise<string | null>
  platform?: NodeJS.Platform
  menuFactory?: WorkspaceBrowserMenuFactory
  /**
   * Runs a task after the current native dispatch. Electron applies its own
   * navigation zoom after `did-navigate` listeners return, so a correction made
   * inside the listener would be overwritten.
   */
  defer?: (task: () => void) => void
  /** Bounds a viewport capture; a hidden guest otherwise stalls for ~30s. */
  captureTimeoutMs?: number
  /** Reads the host app's zoom factor for coordinate mapping (`Z_page / Z_app`). */
  getAppZoomFactor?: () => number
  /** Optional idle grace period (ms) before detaching an unused CDP debugger. */
  cdpIdleGraceMs?: number
  /** Optional inactivity timeout (ms) before detaching an idle held CDP lease. */
  cdpLeaseInactivityTimeoutMs?: number
  /** Optional listener for CDP events forwarded from attached browser guests. */
  onCdpEvent?: (event: CdpEventNotice) => void
  /** Optional resolver for internal loopback ports blocked from guest navigation. */
  getInternalPorts?: () => WorkspaceBrowserInternalPorts
  /** Clock override for deterministic tests. */
  now?: () => number
  /** Maximum live hidden, non-agent-controlled pages kept warm before LRU eviction (`0` disables). */
  maxBackgroundPages?: number
  /** Idle duration (ms) before a hidden, non-agent-controlled page is suspended (`0` disables). */
  backgroundIdleEvictMs?: number
  /** Periodic interval (ms) for runaway guest checks and idle eviction (`0` disables timer). */
  healthCheckIntervalMs?: number
  /** Sustained memory limit (KB) for hidden guests before termination (`0` disables). */
  hiddenMemoryLimitKb?: number
  /** Sustained memory limit (KB) for visible/active guests before termination (`0` disables). */
  activeMemoryLimitKb?: number
  /** Immediate termination memory ceiling (KB) for any guest (`0` disables). */
  hardMemoryLimitKb?: number
  /** Sustained CPU percent limit for hidden guests before termination (`0` disables). */
  hiddenCpuLimitPercent?: number
  /** Consecutive samples over soft memory limit before termination. */
  memoryStrikeThreshold?: number
  /** Consecutive samples over hidden CPU limit before termination. */
  cpuStrikeThreshold?: number
  /** Reads OS process metrics (wired to `app.getAppMetrics()` in Electron main). */
  getProcessMetrics?: () => WorkspaceBrowserProcessMetric[]
  /** Returns the main window renderer PID so the watchdog can never touch it. */
  getHostProcessId?: () => number | null
  /** Optional diagnostic sink for resource-guard terminations. */
  onDiagnostic?: (message: string) => void
}

type WorkspaceBrowserPage = {
  tabId: string
  sessionId?: string
  storageId: string
  webContents: WorkspaceBrowserWebContentsLike
  /** Whether the renderer currently shows this page. Only it can take input. */
  presented: boolean
  /** The guest starts on a blank document whose entry must not be "Back". */
  initialEntryCleared: boolean
  zoomFactor: number
  controls: PreviewBrowserControlsMessage | null
  controlsSignature: string | null
  pickerArmed: boolean
  persistentPicker: Extract<HostMessage, { type: 'enter-picker' }> | null
  pickerGeneration: number
  supportsPickerGeneration: boolean
  agentControlActive: boolean
  closed: boolean
  history: WorkspaceBrowserHistoryEntry[]
  fullCapture: Promise<string> | null
  captureCount: number
  navigationId: number
  navigationUrl: string
  navigationOutcome: 'idle' | 'pending' | 'succeeded' | 'failed'
  navigationCommitted: boolean
  lastActiveAt: number
  hiddenSince: number | null
  activeDownloads: number
  memoryStrikes: number
  cpuStrikes: number
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isHostCaptureMessage(
  payload: unknown,
): payload is { v: 1, type: 'capture', kind: WorkspaceBrowserCaptureKind } {
  return isPlainRecord(payload) &&
    payload.v === 1 &&
    payload.type === 'capture' &&
    (payload.kind === 'full' || payload.kind === 'viewport')
}

function isHostPickerMessage(payload: unknown): payload is { v: 1, type: 'enter-picker' | 'exit-picker' } {
  return isPlainRecord(payload) &&
    payload.v === 1 &&
    (payload.type === 'enter-picker' || payload.type === 'exit-picker')
}

export function workspaceBrowserPdfFilename(url: string, title: string): string {
  const raw = title.trim() || (() => {
    try {
      return new URL(url).hostname
    } catch {
      return 'page'
    }
  })()
  const safe = raw.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80)
  return `${safe || 'page'}.pdf`
}

/**
 * Multi-page browser host.
 *
 * Each page is a `<webview>` guest the renderer keeps in a layer that is never
 * unmounted, so the page is composited with the DOM: menus, dialogs and other
 * pages draw over it like over any element. This service adopts the guest and
 * owns everything that happens *inside* it — navigation, history, find, zoom,
 * capture, downloads and the annotation agent.
 *
 * A page's lifetime is still decided by `close(tabId)` and nothing else.
 * Hiding a tab, moving the panel or unmounting the React surface only change
 * whether a page is drawn; the guest keeps its form state, scroll position and
 * navigation history the entire time.
 */
export class ElectronWorkspaceBrowserService {
  private readonly resolveGuest: (webContentsId: number) => WorkspaceBrowserWebContentsLike
  private readonly previewScriptPath: string
  private readonly emit: (event: WorkspaceBrowserEvent) => void
  private readonly writePdf?: (input: { data: Uint8Array, filename: string }) => Promise<string | null>
  private readonly platform: NodeJS.Platform
  private readonly defer: (task: () => void) => void
  private readonly captureTimeoutMs: number
  private readonly readAppZoomFactor?: () => number
  private readonly readInternalPorts?: () => WorkspaceBrowserInternalPorts
  private readonly now: () => number
  private readonly maxBackgroundPages: number
  private readonly backgroundIdleEvictMs: number
  private readonly healthCheckIntervalMs: number
  private readonly hiddenMemoryLimitKb: number
  private readonly activeMemoryLimitKb: number
  private readonly hardMemoryLimitKb: number
  private readonly hiddenCpuLimitPercent: number
  private readonly memoryStrikeThreshold: number
  private readonly cpuStrikeThreshold: number
  private readonly getProcessMetrics?: () => WorkspaceBrowserProcessMetric[]
  private readonly getHostProcessId?: () => number | null
  private readonly onDiagnostic?: (message: string) => void
  private healthMonitorTimer: ReturnType<typeof setInterval> | null = null
  private readonly cdp: DebuggerLeaseManager
  private cdpEventHandler: ((event: CdpEventNotice) => void) | null
  private readonly pageClosedListeners = new Set<(event: WorkspaceBrowserPageClosedEvent) => void>()
  private readonly pages = new Map<string, WorkspaceBrowserPage>()
  private readonly hookedSessions = new Set<WorkspaceBrowserSessionLike>()
  /**
   * Page zoom as Chromium keeps it: per host, shared by every page of the
   * partition. Electron overwrites a guest's zoom with its embedder's whenever
   * app zoom changes or the guest navigates, so this is the value to restore.
   */
  private readonly zoomByHost = new Map<string, number>()
  private parent: WorkspaceBrowserParentWindowLike | null = null
  private downloadSequence = 0
  private readonly menu?: WorkspaceBrowserMenuController

  constructor(options: ElectronWorkspaceBrowserServiceOptions) {
    this.resolveGuest = options.resolveGuest
    this.previewScriptPath = options.previewScriptPath
    this.emit = options.emit
    this.writePdf = options.writePdf
    this.platform = options.platform ?? process.platform
    this.defer = options.defer ?? (task => { setImmediate(task) })
    this.captureTimeoutMs = options.captureTimeoutMs ?? VIEWPORT_CAPTURE_TIMEOUT_MS
    this.readAppZoomFactor = options.getAppZoomFactor
    this.readInternalPorts = options.getInternalPorts
    this.now = options.now ?? (() => Date.now())
    this.maxBackgroundPages = options.maxBackgroundPages ?? DEFAULT_MAX_BACKGROUND_PAGES
    this.backgroundIdleEvictMs = options.backgroundIdleEvictMs ?? DEFAULT_BACKGROUND_IDLE_EVICT_MS
    this.healthCheckIntervalMs = options.healthCheckIntervalMs ?? DEFAULT_HEALTH_CHECK_INTERVAL_MS
    this.hiddenMemoryLimitKb = options.hiddenMemoryLimitKb ?? DEFAULT_HIDDEN_MEMORY_LIMIT_KB
    this.activeMemoryLimitKb = options.activeMemoryLimitKb ?? DEFAULT_ACTIVE_MEMORY_LIMIT_KB
    this.hardMemoryLimitKb = options.hardMemoryLimitKb ?? DEFAULT_HARD_MEMORY_LIMIT_KB
    this.hiddenCpuLimitPercent = options.hiddenCpuLimitPercent ?? DEFAULT_HIDDEN_CPU_LIMIT_PERCENT
    this.memoryStrikeThreshold = Math.max(1, options.memoryStrikeThreshold ?? DEFAULT_MEMORY_STRIKE_THRESHOLD)
    this.cpuStrikeThreshold = Math.max(1, options.cpuStrikeThreshold ?? DEFAULT_CPU_STRIKE_THRESHOLD)
    this.getProcessMetrics = options.getProcessMetrics
    this.getHostProcessId = options.getHostProcessId
    this.onDiagnostic = options.onDiagnostic
    this.cdpEventHandler = options.onCdpEvent ?? null
    this.cdp = new DebuggerLeaseManager({
      resolveWebContents: tabId => {
        const page = this.pages.get(tabId)
        if (!page || page.closed) return null
        return page.webContents
      },
      idleGraceMs: options.cdpIdleGraceMs,
      leaseInactivityTimeoutMs: options.cdpLeaseInactivityTimeoutMs,
      onEvent: event => this.cdpEventHandler?.(event),
    })
    if (options.menuFactory) this.menu = new WorkspaceBrowserMenuController(options.menuFactory)
  }

  getCdpManager(): DebuggerLeaseManager {
    return this.cdp
  }

  setCdpEventHandler(handler: ((event: CdpEventNotice) => void) | null): void {
    this.cdpEventHandler = handler
  }

  onPageClosed(listener: (event: WorkspaceBrowserPageClosedEvent) => void): () => void {
    this.pageClosedListeners.add(listener)
    return () => {
      this.pageClosedListeners.delete(listener)
    }
  }

  getPageZoomFactor(tabId: string): number {
    const page = this.requirePage(tabId)
    const nativeZoom = page.webContents.getZoomFactor?.()
    if (nativeZoom !== undefined && Number.isFinite(nativeZoom) && nativeZoom > 0) {
      page.zoomFactor = nativeZoom
      return nativeZoom
    }
    return Number.isFinite(page.zoomFactor) && page.zoomFactor > 0 ? page.zoomFactor : 1
  }

  getAppZoomFactor(): number {
    const raw = this.readAppZoomFactor?.() ?? this.parent?.webContents?.getZoomFactor?.()
    return raw !== undefined && Number.isFinite(raw) && raw > 0 ? raw : 1
  }

  listPages(options?: { sessionId?: string }): WorkspaceBrowserPageInfo[] {
    const appZoomFactor = this.getAppZoomFactor()
    const filterSessionId = options?.sessionId?.trim() || undefined
    const result: WorkspaceBrowserPageInfo[] = []
    for (const page of this.pages.values()) {
      if (page.closed || page.webContents.isDestroyed?.()) continue
      if (filterSessionId && page.sessionId !== filterSessionId) continue
      result.push(this.toPageInfo(page, appZoomFactor))
    }
    return result
  }

  getPageInfo(tabId: string): WorkspaceBrowserPageInfo | null {
    const page = this.pages.get(tabId)
    if (!page || page.closed || page.webContents.isDestroyed?.()) return null
    return this.toPageInfo(page, this.getAppZoomFactor())
  }

  async setAgentControlActive(tabId: string, active: boolean): Promise<void> {
    const page = this.pages.get(tabId)
    if (!page || page.closed || page.webContents.isDestroyed?.()) return
    page.agentControlActive = active
    page.lastActiveAt = this.now()
    if (active) {
      page.hiddenSince = null
      page.cpuStrikes = 0
      page.webContents.setBackgroundThrottling?.(false)
    } else {
      page.webContents.setBackgroundThrottling?.(true)
      if (!page.presented) page.hiddenSince ??= this.now()
    }
    if (active && (page.pickerArmed || page.persistentPicker !== null)) {
      page.pickerArmed = false
      page.persistentPicker = null
      page.pickerGeneration += 1
      this.emitState(page)
    }
    await this.syncAgentControlState(page)
  }

  async create(
    parent: WorkspaceBrowserParentWindowLike,
    tabId: string,
    options: WorkspaceBrowserCreateOptions,
  ): Promise<void> {
    // Validate before anything is registered: a throw after `openPage` would
    // leave a page this service can neither address nor release.
    const url = options.url ? normalizePreviewUrl(options.url) : null
    if (url && !this.isNavigationUrlAllowed(url)) {
      throw new Error('navigation to restricted internal or metadata url is blocked')
    }
    const webContents = this.resolveGuest(options.webContentsId)

    const sessionId = options.sessionId?.trim() || undefined
    this.parent = parent
    const existing = this.pages.get(tabId)
    if (existing) {
      // A live page is NEVER re-navigated from `create`. The renderer asks
      // again whenever it has to re-establish a page, and `loadURL` on a live
      // guest is a hard navigation: it would wipe the form the user filled in,
      // reset the scroll position and push a duplicate back entry.
      if (existing.webContents !== webContents) {
        throw new Error(`workspace browser tab already has a live page: ${tabId}`)
      }
      if (sessionId && !existing.sessionId) {
        existing.sessionId = sessionId
      }
      this.emitState(existing)
      return
    }
    const owner = this.findPageByWebContents(webContents)
    if (owner) throw new Error(`workspace browser guest already belongs to ${owner.tabId}`)

    const page = this.openPage(tabId, options.storageId, webContents, sessionId)
    // Resolving means "registered": the renderer may now send visibility,
    // Stop and navigation. The first load is an ordinary navigation, so its
    // failure reaches the tab as a `failed` event like any other — answering
    // `create` with it would make an adopted page look unregistered.
    this.emitState(page)
    if (url) {
      void webContents.loadURL(url).catch(() => {
        // Reported through `did-fail-load`, or superseded by a newer navigation.
      })
    }
  }

  async navigate(tabId: string, url: string): Promise<void> {
    const page = this.requirePage(tabId)
    const normalized = normalizePreviewUrl(url)
    if (!this.isNavigationUrlAllowed(normalized)) {
      throw new Error('navigation to restricted internal or metadata url is blocked')
    }
    page.pickerArmed = false
    page.persistentPicker = null
    page.pickerGeneration += 1
    await page.webContents.loadURL(normalized)
  }

  async showMenu(
    parent: WorkspaceBrowserParentWindowLike,
    tabId: string,
    options: WorkspaceBrowserMenuOptions,
  ): Promise<WorkspaceBrowserMenuAction | null> {
    const page = this.requirePage(tabId)
    if (parent !== this.parent || parent.isDestroyed?.() || parent.webContents?.isDestroyed?.()) {
      throw new Error('Workspace browser menu requires its live owner window')
    }
    if (!this.menu) throw new Error('Workspace browser native menu unavailable')
    const nativeZoom = page.webContents.getZoomFactor?.()
    if (nativeZoom !== undefined && Number.isFinite(nativeZoom) && nativeZoom > 0 && nativeZoom !== page.zoomFactor) {
      page.zoomFactor = nativeZoom
      // Menu actions return to the renderer. Its next zoom step must start
      // from the same current native value that the menu displays.
      this.emitState(page)
    }
    return this.menu.show(tabId, { ...options, zoomFactor: page.zoomFactor })
  }

  goBack(tabId: string): void {
    const webContents = this.requirePage(tabId).webContents
    if (webContents.navigationHistory) {
      webContents.navigationHistory.goBack()
      return
    }
    webContents.goBack?.()
  }

  goForward(tabId: string): void {
    const webContents = this.requirePage(tabId).webContents
    if (webContents.navigationHistory) {
      webContents.navigationHistory.goForward()
      return
    }
    webContents.goForward?.()
  }

  reload(tabId: string, options?: { ignoreCache?: boolean }): void {
    const webContents = this.requirePage(tabId).webContents
    if (options?.ignoreCache) webContents.reloadIgnoringCache()
    else webContents.reload()
  }

  stop(tabId: string): void {
    this.requirePage(tabId).webContents.stop()
  }

  /**
   * Records whether the renderer shows this page. Drawing is the renderer's
   * job; this decides which page may act as browser chrome (shortcuts, zoom
   * capsule) and closes a native menu that belonged to a page going away.
   */
  setVisible(tabId: string, visible: boolean): void {
    // Controller close may precede the component's passive unmount cleanup.
    // Only hide is an idempotent teardown; showing a missing page is still an error.
    if (!visible && !this.pages.has(tabId)) return
    const page = this.requirePage(tabId)
    const wasPresented = page.presented
    page.presented = visible
    if (!visible) {
      if (wasPresented) page.lastActiveAt = this.now()
      if (!page.agentControlActive) {
        page.hiddenSince ??= this.now()
        page.webContents.setBackgroundThrottling?.(true)
      }
      this.menu?.cancel(page.tabId)
      this.evictExcessBackgroundPages(page.tabId)
      return
    }
    page.hiddenSince = null
    page.lastActiveAt = this.now()
    page.cpuStrikes = 0
    page.memoryStrikes = 0
    page.webContents.setBackgroundThrottling?.(!page.agentControlActive)
    // Chromium may have changed this page's zoom while it was off screen (a
    // same-host page zoomed); the controls it shows must read the real value.
    this.emitState(page)
  }

  setZoom(tabId: string, factor: unknown): void {
    const page = this.requirePage(tabId)
    page.zoomFactor = normalizeZoomFactor(factor)
    this.zoomByHost.set(zoomHostKey(page.webContents.getURL()), page.zoomFactor)
    page.webContents.setZoomFactor?.(page.zoomFactor)
    // Chromium may apply zoom to another live page on the same origin.
    // Read every native value so controls never report an invented factor.
    for (const current of this.pages.values()) this.emitState(current)
  }

  /**
   * Electron copies the embedder's zoom into every guest when app zoom
   * changes. App zoom never scaled the old native page, so put each page back
   * at the zoom it had. Must run right after the embedder zoom changes.
   */
  restorePageZoom(): void {
    for (const page of this.pages.values()) {
      if (page.closed || page.webContents.isDestroyed?.()) continue
      page.webContents.setZoomFactor?.(page.zoomFactor)
    }
  }

  find(tabId: string, text: string, options?: WorkspaceBrowserFindOptions): void {
    const trimmed = text.trim()
    const page = this.requirePage(tabId)
    if (!trimmed) {
      page.webContents.stopFindInPage('clearSelection')
      return
    }
    page.webContents.findInPage(trimmed, options)
  }

  stopFind(tabId: string): void {
    this.requirePage(tabId).webContents.stopFindInPage('clearSelection')
  }

  async capture(tabId: string, kind: WorkspaceBrowserCaptureKind): Promise<void> {
    const page = this.requirePage(tabId)
    const dataUrl = await this.captureDataUrl(page, kind)
    this.emitFor(page, { type: 'screenshot', tabId: page.tabId, dataUrl, kind })
  }

  async message(tabId: string, payload: unknown): Promise<void> {
    const page = this.requirePage(tabId)
    const controls = parseHostMessage(JSON.stringify(payload))
    if (controls?.type === 'browser-controls') {
      page.controls = { v: 1, ...controls }
      await this.syncBrowserControls(page)
      return
    }
    if (isHostCaptureMessage(payload)) {
      await this.capture(tabId, payload.kind)
      return
    }
    if (isHostPickerMessage(payload)) {
      if (!controls || (controls.type !== 'enter-picker' && controls.type !== 'exit-picker')) return
      if (controls.type === 'enter-picker' && page.agentControlActive) {
        page.pickerArmed = false
        page.persistentPicker = null
        this.emitState(page)
        return
      }
      page.pickerGeneration += 1
      page.pickerArmed = controls.type === 'enter-picker'
      page.persistentPicker = controls.type === 'enter-picker' && controls.persistent ? controls : null
      this.emitState(page)
    }
    const raw = JSON.stringify(isHostPickerMessage(payload) ? { ...payload, generation: page.pickerGeneration } : payload)
    const generation = page.pickerGeneration
    try {
      await page.webContents.executeJavaScript(
        `globalThis.__PREVIEW_BRIDGE__?.handleHostRaw(${JSON.stringify(raw)})`,
      )
    } catch (error) {
      if (isHostPickerMessage(payload) && generation === page.pickerGeneration) {
        page.pickerArmed = false
        page.persistentPicker = null
        page.pickerGeneration += 1
        this.emitState(page)
      }
      throw error
    }
  }

  async printToPdf(tabId: string): Promise<void> {
    const page = this.requirePage(tabId)
    const webContents = page.webContents
    if (!webContents.printToPDF || !this.writePdf) throw new Error('pdf export unavailable')
    const filename = workspaceBrowserPdfFilename(webContents.getURL(), webContents.getTitle())
    const data = await webContents.printToPDF({ printBackground: true })
    const savePath = await this.writePdf({ data, filename })
    if (!savePath) return
    this.emit({
      type: 'download',
      tabId: page.tabId,
      download: {
        id: this.nextDownloadId(),
        filename: basename(savePath),
        savePath,
        receivedBytes: data.byteLength,
        totalBytes: data.byteLength,
        state: 'completed',
      },
    })
  }

  /**
   * The only call that ends a page's life. The renderer removes the guest's
   * element as well; closing here too means a page can never outlive its tab
   * even if that removal never happens.
   */
  close(tabId: string): void {
    const page = this.pages.get(tabId)
    if (!page) return
    this.pages.delete(tabId)
    page.closed = true
    this.menu?.cancel(page.tabId)
    this.cdp.handleTabClosed(page.tabId, 'closed')
    this.notifyPageClosed(page.tabId, 'closed')
    if (!page.webContents.isDestroyed?.()) {
      page.webContents.close?.()
    }
    if (this.pages.size === 0) this.stopHealthMonitor()
  }

  closeAll(): void {
    this.stopHealthMonitor()
    this.menu?.cancel()
    for (const tabId of [...this.pages.keys()]) this.close(tabId)
    this.cdp.disposeAll()
    this.parent = null
  }

  /**
   * Inspects live workspace browser guests for runaway memory/CPU usage and
   * reclaims idle or excess background guests so a misbehaving page can never
   * starve Chromium's shared NetworkService or Electron main's IO thread.
   */
  runHealthCheck(): void {
    if (this.pages.size === 0) {
      this.stopHealthMonitor()
      return
    }
    if (this.getProcessMetrics) {
      let metrics: WorkspaceBrowserProcessMetric[] = []
      try {
        metrics = this.getProcessMetrics()
      } catch {
        metrics = []
      }
      const metricsByPid = new Map<number, WorkspaceBrowserProcessMetric>()
      for (const metric of metrics) {
        if (typeof metric?.pid === 'number' && metric.pid > 0) {
          metricsByPid.set(metric.pid, metric)
        }
      }
      const hostPid = this.getHostProcessId?.() ?? null
      for (const page of [...this.pages.values()]) {
        if (page.closed || page.webContents.isDestroyed?.()) continue
        const pid = page.webContents.getOSProcessId?.()
        if (!pid || pid <= 0 || (hostPid !== null && pid === hostPid)) continue
        const metric = metricsByPid.get(pid)
        if (!metric) {
          page.memoryStrikes = 0
          page.cpuStrikes = 0
          continue
        }
        const memoryKb = Math.max(metric.memory?.privateBytes ?? 0, metric.memory?.workingSetSize ?? 0)
        const cpuPercent = metric.cpu?.percentCPUUsage ?? 0
        const isBackground = !page.presented && !page.agentControlActive
        const softMemoryLimitKb = isBackground ? this.hiddenMemoryLimitKb : this.activeMemoryLimitKb

        if (this.hardMemoryLimitKb > 0 && memoryKb >= this.hardMemoryLimitKb) {
          this.terminateRunawayPage(page, { pid, memoryKb, cpuPercent, cause: 'hard-memory' })
          continue
        }

        if (softMemoryLimitKb > 0 && memoryKb >= softMemoryLimitKb) {
          page.memoryStrikes += 1
        } else {
          page.memoryStrikes = 0
        }

        if (isBackground && this.hiddenCpuLimitPercent > 0 && cpuPercent >= this.hiddenCpuLimitPercent) {
          page.cpuStrikes += 1
        } else {
          page.cpuStrikes = 0
        }

        if (page.memoryStrikes >= this.memoryStrikeThreshold) {
          this.terminateRunawayPage(page, { pid, memoryKb, cpuPercent, cause: 'memory' })
          continue
        }
        if (page.cpuStrikes >= this.cpuStrikeThreshold) {
          this.terminateRunawayPage(page, { pid, memoryKb, cpuPercent, cause: 'cpu' })
        }
      }
    }

    this.evictIdleBackgroundPages()
    this.evictExcessBackgroundPages()
    if (this.pages.size === 0) this.stopHealthMonitor()
  }

  /**
   * Routes an in-page agent message. Returns whether this service owns the
   * sender, so the caller can fall through to the legacy singleton preview.
   */
  handleMessageFromView(sender: unknown, raw: unknown): boolean {
    const page = this.findPageByWebContents(sender)
    if (!page) return false
    if (typeof raw === 'string') void this.deliverAgentMessage(page, raw)
    return true
  }

  private openPage(
    tabId: string,
    storageId: string,
    webContents: WorkspaceBrowserWebContentsLike,
    sessionId?: string,
  ): WorkspaceBrowserPage {
    const now = this.now()
    const page: WorkspaceBrowserPage = {
      tabId,
      ...(sessionId ? { sessionId } : {}),
      storageId,
      webContents,
      presented: false,
      initialEntryCleared: false,
      zoomFactor: 1,
      controls: null,
      controlsSignature: null,
      pickerArmed: false,
      persistentPicker: null,
      pickerGeneration: 0,
      supportsPickerGeneration: false,
      agentControlActive: false,
      closed: false,
      history: [],
      fullCapture: null,
      captureCount: 0,
      navigationId: 0,
      navigationUrl: '',
      navigationOutcome: 'idle',
      navigationCommitted: false,
      lastActiveAt: now,
      hiddenSince: now,
      activeDownloads: 0,
      memoryStrikes: 0,
      cpuStrikes: 0,
    }
    this.pages.set(tabId, page)
    webContents.setBackgroundThrottling?.(true)
    this.installPageListeners(page)
    this.hookSession(webContents.session)
    // The guest attached at its embedder's zoom; a page starts at 100% or at
    // whatever its host was last zoomed to, exactly as a fresh native page did.
    this.restoreNavigationZoom(page)
    this.ensureHealthMonitor()
    this.evictExcessBackgroundPages(tabId)
    return page
  }

  private installPageListeners(page: WorkspaceBrowserPage): void {
    const webContents = page.webContents

    // Popups become tabs in this window instead of native child windows, which
    // would escape the workspace and the preload/permission boundary with it.
    webContents.setWindowOpenHandler(({ url }) => {
      if (this.isNavigationUrlAllowed(url)) this.emitFor(page, { type: 'new-window', tabId: page.tabId, url })
      return { action: 'deny' }
    })
    webContents.on('will-navigate', (event, url) => {
      if (!this.isNavigationUrlAllowed(url)) event.preventDefault()
    })
    webContents.on('will-redirect', (event, url) => {
      if (!this.isNavigationUrlAllowed(url)) event.preventDefault()
    })
    webContents.on('destroyed', () => {
      // A guest dies with its element. Unless the tab closed it, the renderer
      // lost the page (its layer went away) and the tab must offer a retry
      // instead of addressing a page that no longer exists.
      if (page.closed || this.pages.get(page.tabId) !== page) return
      this.pages.delete(page.tabId)
      page.closed = true
      this.menu?.cancel(page.tabId)
      this.cdp.handleTabClosed(page.tabId, 'closed')
      this.notifyPageClosed(page.tabId, 'closed')
      this.emit({ type: 'destroyed', tabId: page.tabId, reason: 'closed' })
      if (this.pages.size === 0) this.stopHealthMonitor()
    })

    webContents.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown' || !page.presented || page.closed) return
      const action = matchWorkspaceShortcut({
        key: input.key, code: input.code, metaKey: input.meta,
        ctrlKey: input.control, shiftKey: input.shift, altKey: input.alt,
      }, { platform: this.platform === 'darwin' ? 'mac' : 'other', context: 'browser' })
      if (!action) return
      // Prevent both the page event and the menu accelerator. The renderer's
      // owner-aware controller executes the same action as a DOM shortcut.
      event.preventDefault()
      this.emitFor(page, { type: 'shortcut', tabId: page.tabId, action })
    })
    webContents.on('did-start-navigation', (_event, url, isInPlace, isMainFrame) => {
      if (!isMainFrame) return
      if (isInPlace) {
        // Hash/history navigation keeps this document (and its event handlers)
        // alive. Exit the page picker too; clearing only host state strands it.
        void this.message(page.tabId, { v: 1, type: 'exit-picker' }).catch(error => {
          if (!page.closed) console.error('Failed to exit annotation after in-page navigation', error)
        })
      } else {
        page.pickerArmed = false
        page.persistentPicker = null
        page.pickerGeneration += 1
      }
      page.controlsSignature = null
      page.navigationId += 1
      page.navigationUrl = url
      page.navigationOutcome = 'pending'
      page.navigationCommitted = false
      this.emitState(page)
    })
    webContents.on('did-redirect-navigation', (_event, url, _isInPlace, isMainFrame) => {
      if (isMainFrame) page.navigationUrl = url
    })
    webContents.on('zoom-changed', () => {
      for (const current of this.pages.values()) this.emitState(current)
    })

    webContents.on('did-start-loading', () => this.emitState(page))
    webContents.on('did-stop-loading', () => this.emitState(page))
    webContents.on('page-title-updated', () => this.emitState(page))
    webContents.on('did-navigate', (_event, url) => {
      page.pickerArmed = false
      page.persistentPicker = null
      page.pickerGeneration += 1
      page.navigationUrl = url
      page.navigationCommitted = true
      if (!page.initialEntryCleared && url !== WORKSPACE_BROWSER_INITIAL_SRC) {
        // The blank document the guest attached with is a real history entry;
        // a native page had none, so the first page must not be able to go
        // "Back" to it.
        page.initialEntryCleared = true
        webContents.navigationHistory?.clear?.()
      }
      this.recordVisit(page, url)
      this.emitState(page)
      // Electron re-applies the embedder's zoom once these listeners return.
      this.defer(() => this.restoreNavigationZoom(page))
    })
    webContents.on('did-navigate-in-page', (_event, url, isMainFrame) => {
      if (isMainFrame === false) return
      page.navigationUrl = url
      page.navigationOutcome = 'succeeded'
      this.recordVisit(page, url)
      this.emitState(page)
    })
    webContents.on('did-finish-load', () => {
      if (page.navigationOutcome === 'pending' && page.navigationCommitted) {
        page.navigationOutcome = 'succeeded'
      }
      void this.injectPreviewAgent(page).catch(error => {
        if (!page.closed) console.error('Failed to initialize workspace browser controls', error)
      })
      this.emitState(page)
    })
    webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      // Subframe failures are normal on the open web and must not put the whole
      // tab into an error state.
      if (!isMainFrame || errorCode === -3 || page.navigationOutcome === 'succeeded') return
      if (page.navigationUrl && validatedURL !== page.navigationUrl) return
      page.navigationOutcome = 'failed'
      this.emitFor(page, {
        type: 'failed',
        tabId: page.tabId,
        url: validatedURL,
        errorCode,
        errorDescription,
        navigationId: page.navigationId,
      })
    })
    webContents.on('render-process-gone', () => {
      this.cdp.handleTabClosed(page.tabId, 'crashed')
      this.notifyPageClosed(page.tabId, 'crashed')
      this.emitFor(page, { type: 'destroyed', tabId: page.tabId, reason: 'crashed' })
    })
    webContents.on('found-in-page', (_event, result) => {
      this.emitFor(page, {
        type: 'found',
        tabId: page.tabId,
        activeMatchOrdinal: result.activeMatchOrdinal,
        matches: result.matches,
      })
    })
  }

  private hookSession(session: WorkspaceBrowserSessionLike | undefined): void {
    if (!session || this.hookedSessions.has(session)) return
    this.hookedSessions.add(session)
    // Downloads belong to the shared session, so the main process owns their
    // lifetime. Keep the source id for attribution after its page is closed.
    session.on('will-download', (_event, item, webContents) => {
      const page = this.findPageByWebContents(webContents)
      if (!page) return
      const id = this.nextDownloadId()
      const report = () => {
        this.emit({
          type: 'download',
          tabId: page.tabId,
          download: {
            id,
            filename: item.getFilename(),
            savePath: item.getSavePath() || null,
            receivedBytes: item.getReceivedBytes(),
            totalBytes: item.getTotalBytes(),
            state: normalizeDownloadState(item.getState()),
          },
        })
      }
      let downloadSettled = false
      page.activeDownloads += 1
      const onDone = () => {
        if (!downloadSettled) {
          downloadSettled = true
          page.activeDownloads = Math.max(0, page.activeDownloads - 1)
        }
        report()
      }
      item.on('updated', report)
      item.on('done', onDone)
      report()
    })
  }

  private async deliverAgentMessage(page: WorkspaceBrowserPage, raw: string): Promise<void> {
    const navigationId = page.navigationId
    const pickerGeneration = page.pickerGeneration
    const persistentPicker = page.persistentPicker
    const message = parsePreviewAgentMessage(raw)
    if (!message) return
    if (message.type === 'ready' && message.supportsPickerGeneration === true) page.supportsPickerGeneration = true
    if (message.type === 'selection' || message.type === 'picker-exited') {
      if (message.generation !== undefined
        ? message.generation !== page.pickerGeneration
        : page.supportsPickerGeneration || page.persistentPicker !== null) return
    }
    if (message.type === 'browser-zoom') {
      // Only the attached page can act as browser chrome. Background pages
      // cannot modify another tab, and no zoom event enters the chat pipeline.
      if (page.presented && page.controls) {
        const current = page.webContents.getZoomFactor?.() ?? page.zoomFactor
        this.setZoom(page.tabId, message.action === 'reset' ? 1 : Math.round((current + (message.action === 'in' ? 0.1 : -0.1)) * 10) / 10)
      }
      return
    }
    if (message.type === 'selection') {
      // Consume before the asynchronous native capture so a page cannot replay
      // selection events while the first capture is in flight.
      if (!page.pickerArmed) return
      page.pickerArmed = false
    } else if (message.type === 'picker-exited') {
      page.pickerArmed = false
      page.persistentPicker = null
      page.pickerGeneration += 1
      this.emitState(page)
    }
    const payload = message.type === 'selection'
      ? await this.withNativeSelectionScreenshot(page, message)
      : message
    if (navigationId !== page.navigationId) return
    this.emitFor(page, { type: 'agent', tabId: page.tabId, message: message.type === 'selection' && persistentPicker
      ? { ...payload, persistent: true } : payload })
    // A selection still consumes exactly one authorization. Continue only once
    // its native screenshot has finished, and never revive an exited/replaced
    // mode from a late capture callback. Legacy enter-picker remains one-shot.
    if (message.type === 'selection' && persistentPicker && !page.closed &&
        pickerGeneration === page.pickerGeneration && page.persistentPicker) {
      const nextLabel = message.payload.delivery === 'queue' ? (persistentPicker.label ?? 1) + 1 : persistentPicker.label ?? 1
      await this.message(page.tabId, { v: 1, ...persistentPicker,
        mode: message.payload.delivery === 'queue' ? 'batch' : persistentPicker.mode,
        label: Math.min(99, nextLabel),
      }).catch(error => {
        if (!page.closed) console.error('Failed to continue browser annotation', error)
      })
    }
  }

  private async withNativeSelectionScreenshot(
    page: WorkspaceBrowserPage,
    message: Extract<PreviewAgentMessage, { type: 'selection' }>,
  ): Promise<PreviewAgentMessage> {
    const navigationId = page.navigationId
    const screenshot = isPlainRecord(message.payload.screenshot) ? message.payload.screenshot : {}
    const captureId = typeof screenshot.captureId === 'number' ? screenshot.captureId : undefined
    try {
      return {
        ...message,
        payload: {
          ...message.payload,
          screenshot: {
            ...screenshot,
            kind: screenshot.kind ?? 'region',
            dataUrl: await this.captureDataUrl(page, 'viewport'),
          },
        },
      }
    } catch {
      return message
    } finally {
      if (navigationId === page.navigationId) await this.clearSelectionOverlay(page, captureId)
    }
  }

  private async clearSelectionOverlay(page: WorkspaceBrowserPage, captureId?: number): Promise<void> {
    const webContents = page.webContents
    if (page.closed || webContents.isDestroyed?.()) return
    try {
      await webContents.executeJavaScript(`globalThis.__PREVIEW_AGENT_CLEAR_SELECTION_OVERLAY__?.(${captureId === undefined ? '' : JSON.stringify(captureId)})`)
    } catch {
      // The page may navigate while the native capture is in flight.
    }
  }

  private async injectPreviewAgent(page: WorkspaceBrowserPage): Promise<void> {
    const webContents = page.webContents
    if (page.closed || webContents.isDestroyed?.()) return
    page.pickerArmed = false
    page.persistentPicker = null
    page.pickerGeneration += 1
    const navigationId = page.navigationId
    const script = readFileSync(resolvePreviewScriptPath(this.previewScriptPath), 'utf8')
    await webContents.executeJavaScript(script)
    if (navigationId !== page.navigationId) return
    page.controlsSignature = null
    await this.syncBrowserControls(page)
    if (page.agentControlActive) {
      await this.syncAgentControlState(page)
    }
  }

  private async syncAgentControlState(page: WorkspaceBrowserPage): Promise<void> {
    if (page.closed || page.webContents.isDestroyed?.()) return
    const raw = JSON.stringify({ v: 1, type: 'agent-control-state', active: page.agentControlActive })
    try {
      await page.webContents.executeJavaScript(`globalThis.__PREVIEW_BRIDGE__?.handleHostRaw(${JSON.stringify(raw)})`)
    } catch {
      // The page may navigate while agent control state is synced.
    }
  }

  private async syncBrowserControls(page: WorkspaceBrowserPage): Promise<void> {
    if (!page.controls || page.closed || page.webContents.isDestroyed?.()) return
    const raw = JSON.stringify({ ...page.controls, zoomFactor: page.zoomFactor })
    if (page.controlsSignature === raw) return
    page.controlsSignature = raw
    try {
      await page.webContents.executeJavaScript(`globalThis.__PREVIEW_BRIDGE__?.handleHostRaw(${JSON.stringify(raw)})`)
    } catch (error) {
      if (page.controlsSignature === raw) page.controlsSignature = null
      throw error
    }
  }

  private async captureDataUrl(
    page: WorkspaceBrowserPage,
    kind: WorkspaceBrowserCaptureKind,
  ): Promise<string> {
    const webContents = page.webContents
    const hideChrome = async (hidden: boolean) => {
      if (page.closed || webContents.isDestroyed?.()) return
      await webContents.executeJavaScript(`globalThis.__PREVIEW_AGENT_SET_CHROME_HIDDEN__?.(${hidden})`)
    }
    page.captureCount += 1
    try {
      await hideChrome(true)
      if (kind === 'full') return await this.captureFullPageDataUrl(page)
      if (!webContents.capturePage) throw new Error('native browser capture unavailable')
      const image = await withTimeout(
        webContents.capturePage(),
        this.captureTimeoutMs,
        'browser capture timed out',
      )
      return image.toDataURL()
    } finally {
      page.captureCount -= 1
      if (page.captureCount === 0) {
        try { await hideChrome(false) } catch { /* A navigation may replace the captured document. */ }
      }
    }
  }

  private async captureFullPageDataUrl(page: WorkspaceBrowserPage): Promise<string> {
    if (page.fullCapture) return await page.fullCapture
    const promise = this.captureFullPageDataUrlOnce(page)
    page.fullCapture = promise
    try {
      return await promise
    } finally {
      if (page.fullCapture === promise) page.fullCapture = null
    }
  }

  private async captureFullPageDataUrlOnce(page: WorkspaceBrowserPage): Promise<string> {
    if (!page.webContents.debugger) throw new Error('full browser capture unavailable')

    return await this.cdp.withLease(page.tabId, async send => {
      const metrics = await send('Page.getLayoutMetrics')
      if (!isPlainRecord(metrics)) throw new Error('invalid full capture layout metrics')
      const contentSize = isPlainRecord(metrics.cssContentSize)
        ? metrics.cssContentSize
        : metrics.contentSize
      if (!isPlainRecord(contentSize)) throw new Error('invalid full capture layout metrics')

      const width = Math.ceil(Number(contentSize.width))
      const height = Math.ceil(Number(contentSize.height))
      if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
        throw new Error('invalid full capture dimensions')
      }
      if (
        width > FULL_CAPTURE_MAX_EDGE ||
        height > FULL_CAPTURE_MAX_EDGE ||
        width * height > FULL_CAPTURE_MAX_PIXELS
      ) {
        throw new Error(`full capture exceeds safety limit: ${width}x${height}`)
      }

      const screenshot = await send('Page.captureScreenshot', {
        format: 'png',
        fromSurface: true,
        captureBeyondViewport: true,
        clip: { x: 0, y: 0, width, height, scale: 1 },
      })
      if (!isPlainRecord(screenshot) || typeof screenshot.data !== 'string' || !screenshot.data) {
        throw new Error('invalid full capture screenshot data')
      }
      return `data:image/png;base64,${screenshot.data}`
    })
  }

  /**
   * Put a page back at the zoom Chromium would have given it as a native
   * page: whatever its host was last zoomed to, otherwise 100%. Electron
   * instead resets a guest to its embedder's zoom, i.e. the app zoom.
   */
  private restoreNavigationZoom(page: WorkspaceBrowserPage): void {
    const webContents = page.webContents
    if (page.closed || webContents.isDestroyed?.() || !webContents.setZoomFactor) return
    const wanted = this.zoomByHost.get(zoomHostKey(webContents.getURL())) ?? 1
    const actual = webContents.getZoomFactor?.()
    // Factors round-trip through zoom levels, so compare with a tolerance.
    if (actual !== undefined && Math.abs(actual - wanted) < 0.001) return
    webContents.setZoomFactor(wanted)
    this.emitState(page)
  }

  private recordVisit(page: WorkspaceBrowserPage, url: string): void {
    // A visit log, not a back/forward stack: Electron's navigation entries carry
    // no timestamps, and the native history stays the source of truth for
    // `goBack`/`goForward` and for the `canGo*` flags on every state event.
    if (!isHttpUrl(url)) return
    const last = page.history[page.history.length - 1]
    if (last?.url === url) return
    page.history.push({ url, title: page.webContents.getTitle(), visitedAt: Date.now() })
    if (page.history.length > MAX_HISTORY_ENTRIES) page.history.shift()
    this.emitFor(page, { type: 'history', tabId: page.tabId, entries: [...page.history] })
  }

  private emitState(page: WorkspaceBrowserPage): void {
    const webContents = page.webContents
    if (webContents.isDestroyed?.()) return
    const actualZoom = webContents.getZoomFactor?.()
    if (actualZoom !== undefined && Number.isFinite(actualZoom) && actualZoom > 0) page.zoomFactor = actualZoom
    void this.syncBrowserControls(page).catch(error => {
      if (!page.closed) console.error('Failed to update workspace browser controls', error)
    })
    // Until its first real navigation the guest shows the blank document it
    // attached with. A tab without a page has no address and no title.
    const blank = webContents.getURL() === WORKSPACE_BROWSER_INITIAL_SRC
    this.emitFor(page, {
      type: 'state',
      tabId: page.tabId,
      url: blank ? '' : webContents.getURL(),
      title: blank ? '' : webContents.getTitle(),
      canGoBack: readCanGoBack(webContents),
      canGoForward: readCanGoForward(webContents),
      loading: webContents.isLoading(),
      navigationId: page.navigationId,
      navigationOutcome: page.navigationOutcome,
      zoomFactor: page.zoomFactor,
      annotationActive: page.persistentPicker !== null,
    })
  }

  /**
   * Exit for page-scoped events. A native callback that fires after `close` —
   * a queued `did-stop-loading` or a crash notice — is
   * dropped here instead of being applied to whatever took the tab's slot.
   */
  private emitFor(page: WorkspaceBrowserPage, event: WorkspaceBrowserEvent): void {
    if (page.closed) return
    this.emit(event)
  }

  private findPageByWebContents(webContents: unknown): WorkspaceBrowserPage | null {
    if (!webContents) return null
    for (const page of this.pages.values()) {
      if (page.webContents === webContents) return page
    }
    return null
  }

  private nextDownloadId(): string {
    this.downloadSequence += 1
    return `wbd-${this.downloadSequence}`
  }

  private isNavigationUrlAllowed(url: string): boolean {
    return isAllowedWorkspaceBrowserNavigationUrl(url, this.readInternalPorts?.())
  }

  private toPageInfo(page: WorkspaceBrowserPage, appZoomFactor: number): WorkspaceBrowserPageInfo {
    const webContents = page.webContents
    const blank = webContents.getURL() === WORKSPACE_BROWSER_INITIAL_SRC
    return {
      tabId: page.tabId,
      ...(page.sessionId ? { sessionId: page.sessionId } : {}),
      url: blank ? '' : webContents.getURL(),
      title: blank ? '' : webContents.getTitle(),
      visible: page.presented,
      zoomFactor: this.getPageZoomFactor(page.tabId),
      appZoomFactor,
    }
  }

  private notifyPageClosed(tabId: string, reason: 'closed' | 'crashed'): void {
    for (const listener of [...this.pageClosedListeners]) {
      try {
        listener({ tabId, reason })
      } catch {
        // Isolate subscriber errors from tab cleanup.
      }
    }
  }

  private ensureHealthMonitor(): void {
    if (this.healthMonitorTimer !== null || this.healthCheckIntervalMs <= 0) return
    this.healthMonitorTimer = setInterval(() => {
      this.runHealthCheck()
    }, this.healthCheckIntervalMs)
    this.healthMonitorTimer.unref?.()
  }

  private stopHealthMonitor(): void {
    if (this.healthMonitorTimer !== null) {
      clearInterval(this.healthMonitorTimer)
      this.healthMonitorTimer = null
    }
  }

  private isEligibleForBackgroundEviction(page: WorkspaceBrowserPage): boolean {
    return (
      !page.closed &&
      !page.presented &&
      !page.agentControlActive &&
      page.activeDownloads === 0 &&
      this.cdp.getLeaseCount(page.tabId) === 0
    )
  }

  private evictIdleBackgroundPages(): void {
    if (this.backgroundIdleEvictMs <= 0) return
    const now = this.now()
    for (const page of [...this.pages.values()]) {
      if (!this.isEligibleForBackgroundEviction(page)) continue
      if (page.hiddenSince === null) continue
      if (now - page.hiddenSince >= this.backgroundIdleEvictMs) {
        this.suspendBackgroundPage(page)
      }
    }
  }

  private evictExcessBackgroundPages(protectedTabId?: string): void {
    if (this.maxBackgroundPages <= 0) return
    const hiddenPages = [...this.pages.values()].filter(page => !page.closed && !page.presented)
    const excessCount = hiddenPages.length - this.maxBackgroundPages
    if (excessCount <= 0) return
    const eligible = hiddenPages
      .filter(page => page.tabId !== protectedTabId && this.isEligibleForBackgroundEviction(page))
      .sort((a, b) => a.lastActiveAt - b.lastActiveAt)
    for (let i = 0; i < excessCount && i < eligible.length; i += 1) {
      const victim = eligible[i]
      if (victim) this.suspendBackgroundPage(victim)
    }
  }

  private suspendBackgroundPage(page: WorkspaceBrowserPage): void {
    if (page.closed || this.pages.get(page.tabId) !== page) return
    this.pages.delete(page.tabId)
    page.closed = true
    this.menu?.cancel(page.tabId)
    this.cdp.handleTabClosed(page.tabId, 'closed')
    this.notifyPageClosed(page.tabId, 'closed')
    this.emit({ type: 'destroyed', tabId: page.tabId, reason: 'suspended' })
    try {
      if (!page.webContents.isDestroyed?.()) page.webContents.close?.()
    } catch {
      // Best-effort teardown
    }
  }

  private terminateRunawayPage(
    page: WorkspaceBrowserPage,
    detail: { pid: number, memoryKb: number, cpuPercent: number, cause: 'memory' | 'hard-memory' | 'cpu' },
  ): void {
    if (page.closed || this.pages.get(page.tabId) !== page) return
    let urlOrigin = ''
    try {
      const rawUrl = page.webContents.getURL()
      urlOrigin = rawUrl ? new URL(rawUrl).origin : ''
    } catch {
      urlOrigin = ''
    }
    this.pages.delete(page.tabId)
    page.closed = true
    this.menu?.cancel(page.tabId)
    this.cdp.handleTabClosed(page.tabId, 'crashed')
    this.notifyPageClosed(page.tabId, 'crashed')
    this.emit({ type: 'destroyed', tabId: page.tabId, reason: 'resource-limit' })
    const memoryMiB = Math.round(detail.memoryKb / 1024)
    const cpuRounded = Math.round(detail.cpuPercent * 10) / 10
    this.onDiagnostic?.(
      `[workspace-browser] Terminated runaway guest tab=${page.tabId} pid=${detail.pid} cause=${detail.cause} memoryMiB=${memoryMiB} cpu=${cpuRounded}% origin=${urlOrigin || 'unknown'}`,
    )
    try {
      if (!page.webContents.isDestroyed?.()) {
        page.webContents.forcefullyCrashRenderer?.()
        page.webContents.close?.()
      }
    } catch {
      // Best-effort termination
    }
  }

  private requirePage(tabId: string): WorkspaceBrowserPage {
    const page = this.pages.get(tabId)
    if (!page) throw new Error(`workspace browser tab not open: ${tabId}`)
    return page
  }
}

/**
 * Chromium keys page zoom by host name alone — port and scheme do not count —
 * or by the whole URL when there is no host (`net::GetHostOrSpecFromURL`).
 */
function zoomHostKey(url: string): string {
  try {
    const { hostname } = new URL(url)
    return hostname ? hostname.replace(/\.$/, '') : url
  } catch {
    return url
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms)
    }),
  ]).finally(() => clearTimeout(timer))
}

function readCanGoBack(webContents: WorkspaceBrowserWebContentsLike): boolean {
  return webContents.navigationHistory?.canGoBack() ?? webContents.canGoBack?.() ?? false
}

function readCanGoForward(webContents: WorkspaceBrowserWebContentsLike): boolean {
  return webContents.navigationHistory?.canGoForward() ?? webContents.canGoForward?.() ?? false
}

function normalizeDownloadState(state: string): 'progressing' | 'completed' | 'cancelled' | 'interrupted' {
  if (state === 'completed' || state === 'cancelled' || state === 'interrupted') return state
  return 'progressing'
}
