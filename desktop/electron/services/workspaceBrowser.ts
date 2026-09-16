import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
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
import { isHttpUrl } from './navigationGuards'
import {
  normalizePreviewBounds,
  normalizePreviewUrl,
  resolvePreviewScriptPath,
  snapPreviewBoundsToScaleFactor,
  type PreviewBounds,
} from './preview'
import { normalizeZoomFactor } from './zoom'
import { WorkspaceBrowserMenuController, type WorkspaceBrowserMenuFactory } from './workspaceBrowserMenu'

export type { WorkspaceBrowserCaptureKind, WorkspaceBrowserEvent, WorkspaceBrowserFindOptions }

/**
 * One persistent partition for every workspace browser page of this user.
 *
 * Codex does the same with `persist:codex-browser-app`: a login performed in
 * one tab has to be there in the next one. The per-tab `storageId` is a *page
 * restore identity* — which page to reopen after a restart — and must never be
 * turned into a partition name, or every tab would get its own cookie jar.
 */
export const WORKSPACE_BROWSER_PARTITION = 'persist:cc-haha-browser-app'

/** Mirrors the preview capture guard rails; a page controls these dimensions. */
const FULL_CAPTURE_MAX_EDGE = 16_384
const FULL_CAPTURE_MAX_PIXELS = 32_000_000

/** Visit log bound. The native back/forward stack is unaffected by this cap. */
const MAX_HISTORY_ENTRIES = 200

export type WorkspaceBrowserBounds = PreviewBounds

type WorkspaceBrowserDebuggerLike = {
  isAttached(): boolean
  attach(protocolVersion?: string): void
  detach(): void
  sendCommand(method: string, commandParams?: Record<string, unknown>): Promise<unknown>
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
    event: 'will-navigate',
    handler: (event: { preventDefault: () => void }, url: string) => void,
  ): unknown
  navigationHistory?: WorkspaceBrowserNavigationHistoryLike
  canGoBack?(): boolean
  canGoForward?(): boolean
  goBack?(): void
  goForward?(): void
  setZoomFactor?(factor: number): void
  getZoomFactor?(): number
  capturePage?(): Promise<{ toDataURL(): string }>
  printToPDF?(options: Record<string, unknown>): Promise<Uint8Array>
  debugger?: WorkspaceBrowserDebuggerLike
  session?: WorkspaceBrowserSessionLike
  close?(): void
  isDestroyed?(): boolean
  isFocused?(): boolean
}

export type WorkspaceBrowserViewLike = {
  webContents: WorkspaceBrowserWebContentsLike
  setBounds(bounds: PreviewBounds): void
  setVisible?(visible: boolean): void
}

export type WorkspaceBrowserParentWindowLike = {
  webContents?: {
    focus(): void
    isDestroyed?(): boolean
  }
  isDestroyed?(): boolean
  contentView: {
    addChildView(view: unknown): void
    removeChildView(view: unknown): void
  }
  getBounds?(): PreviewBounds
}

export type WorkspaceBrowserCreateOptions = {
  storageId: string
  url?: string
  bounds?: WorkspaceBrowserBounds
  visible?: boolean
}

export type ElectronWorkspaceBrowserServiceOptions = {
  createView: () => WorkspaceBrowserViewLike
  previewScriptPath: string
  emit: (event: WorkspaceBrowserEvent) => void
  resolveScaleFactor?: (parent: WorkspaceBrowserParentWindowLike) => number
  /** Writes an exported PDF and resolves with the path it landed on. */
  writePdf?: (input: { data: Uint8Array, filename: string }) => Promise<string | null>
  platform?: NodeJS.Platform
  menuFactory?: WorkspaceBrowserMenuFactory
}

type WorkspaceBrowserPage = {
  tabId: string
  storageId: string
  view: WorkspaceBrowserViewLike
  attached: boolean
  requestedBounds: PreviewBounds | null
  zoomFactor: number
  controls: PreviewBrowserControlsMessage | null
  controlsSignature: string | null
  pickerArmed: boolean
  persistentPicker: Extract<HostMessage, { type: 'enter-picker' }> | null
  pickerGeneration: number
  supportsPickerGeneration: boolean
  closed: boolean
  history: WorkspaceBrowserHistoryEntry[]
  fullCapture: Promise<string> | null
  captureCount: number
  navigationId: number
  navigationUrl: string
  navigationOutcome: 'idle' | 'pending' | 'succeeded' | 'failed'
  navigationCommitted: boolean
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
 * The whole point of this service is that a page's lifetime is decided by
 * `close(tabId)` and nothing else. Hiding a tab, re-bounding it, moving the
 * panel or unmounting the React surface only change where — or whether — a page
 * is drawn; the `webContents` behind it keeps its form state, scroll position
 * and navigation history the entire time.
 */
export class ElectronWorkspaceBrowserService {
  private readonly createView: () => WorkspaceBrowserViewLike
  private readonly previewScriptPath: string
  private readonly emit: (event: WorkspaceBrowserEvent) => void
  private readonly resolveScaleFactor?: (parent: WorkspaceBrowserParentWindowLike) => number
  private readonly writePdf?: (input: { data: Uint8Array, filename: string }) => Promise<string | null>
  private readonly platform: NodeJS.Platform
  private readonly pages = new Map<string, WorkspaceBrowserPage>()
  private readonly hookedSessions = new Set<WorkspaceBrowserSessionLike>()
  private parent: WorkspaceBrowserParentWindowLike | null = null
  private downloadSequence = 0
  private readonly menu?: WorkspaceBrowserMenuController

  constructor(options: ElectronWorkspaceBrowserServiceOptions) {
    this.createView = options.createView
    this.previewScriptPath = options.previewScriptPath
    this.emit = options.emit
    this.resolveScaleFactor = options.resolveScaleFactor
    this.writePdf = options.writePdf
    this.platform = options.platform ?? process.platform
    if (options.menuFactory) this.menu = new WorkspaceBrowserMenuController(options.menuFactory)
  }

  async create(
    parent: WorkspaceBrowserParentWindowLike,
    tabId: string,
    options: WorkspaceBrowserCreateOptions,
  ): Promise<void> {
    // Validate before anything is constructed or registered: `openPage` inserts
    // a live view into `this.pages`, and a throw after that point strands a
    // `webContents` that was never attached and can never be addressed again.
    const bounds = options.bounds ? normalizePreviewBounds(options.bounds) : null
    const url = options.url ? normalizePreviewUrl(options.url) : null
    if (options.visible !== undefined && typeof options.visible !== 'boolean') throw new Error('visible must be a boolean')

    this.parent = parent
    const existing = this.pages.get(tabId)
    // Re-creating a live id would strand its `webContents` with no way to close
    // it, so an already-known tab keeps its page.
    const page = existing ?? this.openPage(tabId, options)
    if (bounds) page.requestedBounds = bounds
    if (options.visible === false) {
      this.detach(page)
      // Registration is complete even while the first navigation is pending.
      // The renderer may now safely send geometry, visibility and Stop.
      this.emitState(page)
    } else this.showExclusively(page)
    // A live page is NEVER re-navigated from `create`. The renderer re-mounts
    // this component every time its tab is re-activated, and `loadURL` on an
    // existing `webContents` is a hard navigation: it would wipe the form the
    // user had filled in, reset the scroll position and push a duplicate entry
    // onto the native back stack — destroying exactly the state that keeping
    // the page alive exists to preserve. Navigation is `navigate()`'s job.
    if (url && !existing) {
      await page.view.webContents.loadURL(url)
    }
    this.emitState(page)
  }

  async navigate(tabId: string, url: string): Promise<void> {
    const page = this.requirePage(tabId)
    page.pickerArmed = false
    page.persistentPicker = null
    page.pickerGeneration += 1
    await page.view.webContents.loadURL(normalizePreviewUrl(url))
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
    const nativeZoom = page.view.webContents.getZoomFactor?.()
    if (nativeZoom !== undefined && Number.isFinite(nativeZoom) && nativeZoom > 0 && nativeZoom !== page.zoomFactor) {
      page.zoomFactor = nativeZoom
      // Menu actions return to the renderer. Its next zoom step must start
      // from the same current native value that the menu displays.
      this.emitState(page)
    }
    return this.menu.show(tabId, { ...options, zoomFactor: page.zoomFactor })
  }

  goBack(tabId: string): void {
    const webContents = this.requirePage(tabId).view.webContents
    if (webContents.navigationHistory) {
      webContents.navigationHistory.goBack()
      return
    }
    webContents.goBack?.()
  }

  goForward(tabId: string): void {
    const webContents = this.requirePage(tabId).view.webContents
    if (webContents.navigationHistory) {
      webContents.navigationHistory.goForward()
      return
    }
    webContents.goForward?.()
  }

  reload(tabId: string, options?: { ignoreCache?: boolean }): void {
    const webContents = this.requirePage(tabId).view.webContents
    if (options?.ignoreCache) webContents.reloadIgnoringCache()
    else webContents.reload()
  }

  stop(tabId: string): void {
    this.requirePage(tabId).view.webContents.stop()
  }

  setBounds(tabId: string, bounds: WorkspaceBrowserBounds): void {
    const page = this.requirePage(tabId)
    page.requestedBounds = normalizePreviewBounds(bounds)
    this.applyBounds(page)
  }

  /**
   * Hiding detaches the native view from the window so it cannot cover a modal
   * or steal clicks — it never destroys the page.
   */
  setVisible(tabId: string, visible: boolean): void {
    // Controller close may precede the component's passive unmount cleanup.
    // Only hide is an idempotent teardown; showing a missing page is still an error.
    if (!visible && !this.pages.has(tabId)) return
    const page = this.requirePage(tabId)
    if (visible) this.showExclusively(page)
    else this.detach(page)
  }

  setZoom(tabId: string, factor: unknown): void {
    const page = this.requirePage(tabId)
    page.zoomFactor = normalizeZoomFactor(factor)
    page.view.webContents.setZoomFactor?.(page.zoomFactor)
    // Chromium may apply zoom to another live page on the same origin.
    // Read every native value so controls never report an invented factor.
    for (const current of this.pages.values()) this.emitState(current)
  }

  find(tabId: string, text: string, options?: WorkspaceBrowserFindOptions): void {
    const trimmed = text.trim()
    const page = this.requirePage(tabId)
    if (!trimmed) {
      page.view.webContents.stopFindInPage('clearSelection')
      return
    }
    page.view.webContents.findInPage(trimmed, options)
  }

  stopFind(tabId: string): void {
    this.requirePage(tabId).view.webContents.stopFindInPage('clearSelection')
  }

  async capture(tabId: string, kind: WorkspaceBrowserCaptureKind): Promise<void> {
    const page = this.requirePage(tabId)
    const dataUrl = await this.captureDataUrl(page, kind)
    this.emitFor(page, { type: 'screenshot', tabId: page.tabId, dataUrl, kind })
  }

  /** Presentation-only image: never enters the screenshot/chat event stream. */
  async snapshot(tabId: string): Promise<string> {
    const page = this.requirePage(tabId)
    const navigationId = page.navigationId
    const dataUrl = await this.captureDataUrl(page, 'viewport')
    if (page.closed || navigationId !== page.navigationId) {
      throw new Error('Browser page changed during snapshot')
    }
    return dataUrl
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
      page.pickerGeneration += 1
      page.pickerArmed = controls.type === 'enter-picker'
      page.persistentPicker = controls.type === 'enter-picker' && controls.persistent ? controls : null
      this.emitState(page)
    }
    const raw = JSON.stringify(isHostPickerMessage(payload) ? { ...payload, generation: page.pickerGeneration } : payload)
    const generation = page.pickerGeneration
    try {
      await page.view.webContents.executeJavaScript(
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
    const webContents = page.view.webContents
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

  /** The only call that ends a page's life. */
  close(tabId: string): void {
    const page = this.pages.get(tabId)
    if (!page) return
    this.pages.delete(tabId)
    page.closed = true
    this.detach(page)
    if (!page.view.webContents.isDestroyed?.()) {
      page.view.webContents.close?.()
    }
  }

  closeAll(): void {
    this.menu?.cancel()
    for (const tabId of [...this.pages.keys()]) this.close(tabId)
    this.parent = null
  }

  /** Re-snaps every live page after a display scale-factor or bounds change. */
  refreshBounds(): void {
    for (const page of this.pages.values()) this.applyBounds(page)
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

  private openPage(tabId: string, options: WorkspaceBrowserCreateOptions): WorkspaceBrowserPage {
    const view = this.createView()
    const page: WorkspaceBrowserPage = {
      tabId,
      storageId: options.storageId,
      view,
      attached: false,
      requestedBounds: null,
      zoomFactor: 1,
      controls: null,
      controlsSignature: null,
      pickerArmed: false,
      persistentPicker: null,
      pickerGeneration: 0,
      supportsPickerGeneration: false,
      closed: false,
      history: [],
      fullCapture: null,
      captureCount: 0,
      navigationId: 0,
      navigationUrl: '',
      navigationOutcome: 'idle',
      navigationCommitted: false,
    }
    this.pages.set(tabId, page)
    this.installPageListeners(page)
    this.hookSession(view.webContents.session)
    return page
  }

  private installPageListeners(page: WorkspaceBrowserPage): void {
    const webContents = page.view.webContents

    // Popups become tabs in this window instead of native child windows, which
    // would escape the workspace and the preload/permission boundary with it.
    webContents.setWindowOpenHandler(({ url }) => {
      if (isHttpUrl(url)) this.emitFor(page, { type: 'new-window', tabId: page.tabId, url })
      return { action: 'deny' }
    })
    webContents.on('will-navigate', (event, url) => {
      if (!isHttpUrl(url)) event.preventDefault()
    })

    webContents.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown' || !page.attached || page.closed) return
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
      this.recordVisit(page, url)
      this.emitState(page)
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
      item.on('updated', report)
      item.on('done', report)
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
      if (page.attached && page.controls) {
        const current = page.view.webContents.getZoomFactor?.() ?? page.zoomFactor
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
    const webContents = page.view.webContents
    if (page.closed || webContents.isDestroyed?.()) return
    try {
      await webContents.executeJavaScript(`globalThis.__PREVIEW_AGENT_CLEAR_SELECTION_OVERLAY__?.(${captureId === undefined ? '' : JSON.stringify(captureId)})`)
    } catch {
      // The page may navigate while the native capture is in flight.
    }
  }

  private async injectPreviewAgent(page: WorkspaceBrowserPage): Promise<void> {
    const webContents = page.view.webContents
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
  }

  private async syncBrowserControls(page: WorkspaceBrowserPage): Promise<void> {
    if (!page.controls || page.closed || page.view.webContents.isDestroyed?.()) return
    const raw = JSON.stringify({ ...page.controls, zoomFactor: page.zoomFactor })
    if (page.controlsSignature === raw) return
    page.controlsSignature = raw
    try {
      await page.view.webContents.executeJavaScript(`globalThis.__PREVIEW_BRIDGE__?.handleHostRaw(${JSON.stringify(raw)})`)
    } catch (error) {
      if (page.controlsSignature === raw) page.controlsSignature = null
      throw error
    }
  }

  private async captureDataUrl(
    page: WorkspaceBrowserPage,
    kind: WorkspaceBrowserCaptureKind,
  ): Promise<string> {
    const webContents = page.view.webContents
    const hideChrome = async (hidden: boolean) => {
      if (page.closed || webContents.isDestroyed?.()) return
      await webContents.executeJavaScript(`globalThis.__PREVIEW_AGENT_SET_CHROME_HIDDEN__?.(${hidden})`)
    }
    page.captureCount += 1
    try {
      await hideChrome(true)
      if (kind === 'full') return await this.captureFullPageDataUrl(page)
      if (!webContents.capturePage) throw new Error('native browser capture unavailable')
      const image = await webContents.capturePage()
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
    const debuggerApi = page.view.webContents.debugger
    if (!debuggerApi) throw new Error('full browser capture unavailable')

    let attachedHere = false
    try {
      if (!debuggerApi.isAttached()) {
        debuggerApi.attach('1.3')
        attachedHere = true
      }

      const metrics = await debuggerApi.sendCommand('Page.getLayoutMetrics')
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

      const screenshot = await debuggerApi.sendCommand('Page.captureScreenshot', {
        format: 'png',
        fromSurface: true,
        captureBeyondViewport: true,
        clip: { x: 0, y: 0, width, height, scale: 1 },
      })
      if (!isPlainRecord(screenshot) || typeof screenshot.data !== 'string' || !screenshot.data) {
        throw new Error('invalid full capture screenshot data')
      }
      return `data:image/png;base64,${screenshot.data}`
    } finally {
      if (attachedHere) {
        try {
          if (debuggerApi.isAttached()) debuggerApi.detach()
        } catch {
          // The page may close while a full-page capture is in flight.
        }
      }
    }
  }

  private showExclusively(page: WorkspaceBrowserPage): void {
    // A second attached view would sit on top of the first and swallow its
    // input, so exactly one page occupies the window's single browser slot.
    for (const other of this.pages.values()) {
      if (other !== page) this.detach(other)
    }
    if (this.parent && !page.attached) {
      this.parent.contentView.addChildView(page.view)
      page.attached = true
    }
    page.view.setVisible?.(true)
    this.applyBounds(page)
    this.emitState(page)
  }

  private detach(page: WorkspaceBrowserPage): void {
    this.menu?.cancel(page.tabId)
    // A DOM focus request cannot move macOS's native responder out of a
    // WebContentsView. Capture ownership before hiding/removing the view drops
    // it, and do not steal focus when a newer page or a host input already owns it.
    const returnFocus = page.attached && !page.view.webContents.isDestroyed?.() && page.view.webContents.isFocused?.()
    page.view.setVisible?.(false)
    if (!page.attached) return
    this.parent?.contentView.removeChildView(page.view)
    page.attached = false
    if (returnFocus && !this.parent?.isDestroyed?.() && !this.parent?.webContents?.isDestroyed?.()) {
      this.parent?.webContents?.focus()
    }
  }

  private applyBounds(page: WorkspaceBrowserPage): void {
    if (!page.requestedBounds || !this.parent) return
    const scaleFactor = this.resolveScaleFactor?.(this.parent) ?? 1
    page.view.setBounds(snapPreviewBoundsToScaleFactor(page.requestedBounds, scaleFactor))
  }

  private recordVisit(page: WorkspaceBrowserPage, url: string): void {
    // A visit log, not a back/forward stack: Electron's navigation entries carry
    // no timestamps, and the native history stays the source of truth for
    // `goBack`/`goForward` and for the `canGo*` flags on every state event.
    if (!isHttpUrl(url)) return
    const last = page.history[page.history.length - 1]
    if (last?.url === url) return
    page.history.push({ url, title: page.view.webContents.getTitle(), visitedAt: Date.now() })
    if (page.history.length > MAX_HISTORY_ENTRIES) page.history.shift()
    this.emitFor(page, { type: 'history', tabId: page.tabId, entries: [...page.history] })
  }

  private emitState(page: WorkspaceBrowserPage): void {
    const webContents = page.view.webContents
    if (webContents.isDestroyed?.()) return
    const actualZoom = webContents.getZoomFactor?.()
    if (actualZoom !== undefined && Number.isFinite(actualZoom) && actualZoom > 0) page.zoomFactor = actualZoom
    void this.syncBrowserControls(page).catch(error => {
      if (!page.closed) console.error('Failed to update workspace browser controls', error)
    })
    this.emitFor(page, {
      type: 'state',
      tabId: page.tabId,
      url: webContents.getURL(),
      title: webContents.getTitle(),
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
      if (page.view.webContents === webContents) return page
    }
    return null
  }

  private nextDownloadId(): string {
    this.downloadSequence += 1
    return `wbd-${this.downloadSequence}`
  }

  private requirePage(tabId: string): WorkspaceBrowserPage {
    const page = this.pages.get(tabId)
    if (!page) throw new Error(`workspace browser tab not open: ${tabId}`)
    return page
  }
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
