import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MenuItemConstructorOptions } from 'electron'
import type { WorkspaceBrowserMenuFactory } from './workspaceBrowserMenu'
import type { WorkspaceBrowserEvent, WorkspaceBrowserMenuOptions } from '../../src/lib/desktopHost/types'
import {
  ElectronWorkspaceBrowserService,
  WORKSPACE_BROWSER_PARTITION,
  workspaceBrowserPdfFilename,
  type WorkspaceBrowserDownloadItemLike,
  type WorkspaceBrowserSessionLike,
  type WorkspaceBrowserWebContentsLike,
} from './workspaceBrowser'

type AnyHandler = (...args: never[]) => void

class FakeSession implements WorkspaceBrowserSessionLike {
  downloadHandlers: Array<
    (event: unknown, item: WorkspaceBrowserDownloadItemLike, webContents: unknown) => void
  > = []

  on(
    _event: 'will-download',
    handler: (event: unknown, item: WorkspaceBrowserDownloadItemLike, webContents: unknown) => void,
  ) {
    this.downloadHandlers.push(handler)
    return this
  }

  startDownload(item: WorkspaceBrowserDownloadItemLike, webContents: unknown) {
    for (const handler of this.downloadHandlers) handler({}, item, webContents)
  }
}

class FakeDownloadItem implements WorkspaceBrowserDownloadItemLike {
  received = 0
  state = 'progressing'
  private handlers = new Map<string, Array<(event: unknown, state: string) => void>>()

  constructor(private readonly filename: string, private readonly total: number) {}

  getFilename() {
    return this.filename
  }

  getSavePath() {
    return `/tmp/${this.filename}`
  }

  getReceivedBytes() {
    return this.received
  }

  getTotalBytes() {
    return this.total
  }

  getState() {
    return this.state
  }

  on(event: 'updated' | 'done', handler: (event: unknown, state: string) => void) {
    const existing = this.handlers.get(event) ?? []
    existing.push(handler)
    this.handlers.set(event, existing)
    return this
  }

  advance(received: number, state: string) {
    this.received = received
    this.state = state
    for (const handler of this.handlers.get(state === 'progressing' ? 'updated' : 'done') ?? []) {
      handler({}, state)
    }
  }
}

class FakeWebContents implements WorkspaceBrowserWebContentsLike {
  id = 0
  loadedUrls: string[] = []
  scripts: string[] = []
  zoomFactors: number[] = []
  zoomFactor = 1
  finds: Array<{ text: string, options?: unknown }> = []
  stopFinds: string[] = []
  reloads: string[] = []
  stops = 0
  destroyed = false
  focused = false
  closed = 0
  title = 'Page'
  // A `<webview>` guest attaches on the blank document the renderer starts it on.
  url = 'about:blank'
  loading = false
  loadResult?: Promise<unknown>
  history = {
    canGoBack: vi.fn(() => this.backEntries > 0),
    canGoForward: vi.fn(() => this.forwardEntries > 0),
    goBack: vi.fn(() => {
      this.backEntries -= 1
      this.forwardEntries += 1
    }),
    goForward: vi.fn(() => {
      this.forwardEntries -= 1
      this.backEntries += 1
    }),
    clear: vi.fn(() => {
      this.backEntries = 0
      this.forwardEntries = 0
    }),
  }
  backEntries = 0
  forwardEntries = 0
  session = new FakeSession()
  windowOpenHandler: ((details: { url: string }) => { action: 'deny' }) | null = null
  capturePage = vi.fn(async () => ({ toDataURL: () => 'data:image/png;base64,VIEWPORT' }))
  debugger: {
    isAttached(): boolean
    attach(protocolVersion?: string): void
    detach(): void
    sendCommand(method: string, commandParams?: Record<string, unknown>): Promise<unknown>
  } | undefined = undefined
  printToPDF = vi.fn(async () => new Uint8Array([1, 2, 3, 4]))
  private handlers = new Map<string, AnyHandler[]>()

  get navigationHistory() {
    return this.history
  }

  async loadURL(url: string) {
    this.loadedUrls.push(url)
    this.url = url
    return await this.loadResult
  }

  getURL() {
    return this.url
  }

  getTitle() {
    return this.title
  }

  isLoading() {
    return this.loading
  }

  reload() {
    this.reloads.push('reload')
  }

  reloadIgnoringCache() {
    this.reloads.push('reload-ignoring-cache')
  }

  stop() {
    this.stops += 1
  }

  findInPage(text: string, options?: unknown) {
    this.finds.push({ text, options })
    return this.finds.length
  }

  stopFindInPage(action: 'clearSelection') {
    this.stopFinds.push(action)
  }

  async executeJavaScript(script: string) {
    this.scripts.push(script)
    return 'ok'
  }

  setWindowOpenHandler(handler: (details: { url: string }) => { action: 'deny' }) {
    this.windowOpenHandler = handler
  }

  on(event: string, handler: AnyHandler) {
    const existing = this.handlers.get(event) ?? []
    existing.push(handler)
    this.handlers.set(event, existing)
    return this
  }

  setZoomFactor(factor: number) {
    this.zoomFactors.push(factor)
    this.zoomFactor = factor
  }

  getZoomFactor() {
    return this.zoomFactor
  }

  close() {
    this.closed += 1
    this.destroy()
  }

  /** What removing the guest's element does: the guest is gone, and says so. */
  destroy() {
    if (this.destroyed) return
    this.destroyed = true
    this.emit('destroyed')
  }

  isDestroyed() {
    return this.destroyed
  }

  isFocused() {
    return this.focused
  }

  emit(event: string, ...args: unknown[]) {
    for (const handler of this.handlers.get(event) ?? []) {
      (handler as (...input: unknown[]) => void)(...args)
    }
  }
}

function fakeParent() {
  return {
    webContents: { isDestroyed: vi.fn(() => false) },
    isDestroyed: vi.fn(() => false),
  }
}

const tempDirs: string[] = []

function previewScript() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-haha-workspace-browser-'))
  tempDirs.push(dir)
  const file = path.join(dir, 'preview-agent.js')
  fs.writeFileSync(file, 'window.__previewInjected = true')
  return file
}

const browserControls = {
  v: 1, type: 'browser-controls', zoomFactor: 1, appZoom: 1,
  copy: { zoom: 'Page zoom', zoomOut: 'Zoom out', zoomIn: 'Zoom in', zoomReset: 'Reset zoom' },
  colors: { background: 'white', foreground: 'black', muted: 'gray', border: 'gray', hover: 'white', focus: 'blue', shadow: 'none' },
}

type OpenOptions = { storageId?: string, url?: string }

type Harness = {
  service: ElectronWorkspaceBrowserService
  parent: ReturnType<typeof fakeParent>
  /** Every guest the "renderer" created, in creation order. */
  guests: FakeWebContents[]
  events: WorkspaceBrowserEvent[]
  sharedSession: FakeSession
  pdfWrites: Array<{ data: Uint8Array, filename: string }>
  /** Work the service scheduled for after the current native dispatch. */
  deferred: Array<() => void>
  /** Stands in for the renderer creating a `<webview>` and registering it. */
  open(tabId: string, options?: OpenOptions): Promise<FakeWebContents>
  newGuest(): FakeWebContents
  flushDeferred(): void
}

function createHarness(options?: { platform?: NodeJS.Platform, cancelPdf?: boolean, loadResult?: Promise<unknown>, menuFactory?: WorkspaceBrowserMenuFactory, captureTimeoutMs?: number }): Harness {
  const guests: FakeWebContents[] = []
  const events: WorkspaceBrowserEvent[] = []
  const pdfWrites: Array<{ data: Uint8Array, filename: string }> = []
  const deferred: Array<() => void> = []
  // One shared session object stands in for `session.fromPartition(...)`, which
  // hands back the same session for the same partition string.
  const sharedSession = new FakeSession()
  let nextId = 100
  const service = new ElectronWorkspaceBrowserService({
    previewScriptPath: previewScript(),
    emit: event => events.push(event),
    platform: options?.platform,
    menuFactory: options?.menuFactory,
    defer: task => { deferred.push(task) },
    captureTimeoutMs: options?.captureTimeoutMs,
    writePdf: async input => {
      if (options?.cancelPdf) return null
      pdfWrites.push(input)
      return `/downloads/${input.filename}`
    },
    // The real resolver also checks the guest's type, host and session; here a
    // guest is valid exactly when the harness created it.
    resolveGuest: id => {
      const guest = guests.find(candidate => candidate.id === id && !candidate.destroyed)
      if (!guest) throw new Error('not a workspace browser guest of the main window')
      return guest
    },
  })
  const parent = fakeParent()
  const newGuest = () => {
    const guest = new FakeWebContents()
    guest.id = nextId++
    guest.session = sharedSession
    guest.loadResult = options?.loadResult
    guests.push(guest)
    return guest
  }
  return {
    service,
    parent,
    guests,
    events,
    sharedSession,
    pdfWrites,
    deferred,
    newGuest,
    open: async (tabId, open = {}) => {
      const guest = newGuest()
      await service.create(parent, tabId, {
        storageId: open.storageId ?? `store-${tabId}`,
        webContentsId: guest.id,
        ...(open.url === undefined ? {} : { url: open.url }),
      })
      return guest
    },
    flushDeferred: () => {
      for (const task of deferred.splice(0)) task()
    },
  }
}

function requireGuest(harness: Harness, index: number): FakeWebContents {
  const guest = harness.guests[index]
  if (!guest) throw new Error(`no fake guest at index ${index}`)
  return guest
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

const desktopRoot = fs.existsSync(path.resolve(process.cwd(), 'electron', 'main.ts'))
  ? process.cwd()
  : path.resolve(process.cwd(), 'desktop')
const mainSource = fs.readFileSync(path.join(desktopRoot, 'electron', 'main.ts'), 'utf8')
const workspaceBrowserHostSource = mainSource
  .slice(
    mainSource.indexOf('function getWorkspaceBrowserService()'),
    mainSource.indexOf('async function listCustomPets()'),
  )
  // Comments explain what is deliberately absent, so they must not count as
  // the code being present.
  .replace(/^\s*\/\/.*$/gm, '')
const mainWindowSource = mainSource.slice(
  mainSource.indexOf('async function createMainWindow()'),
  mainSource.indexOf('if (!acquireSingleInstanceLock'),
)

describe('Electron workspace browser host wiring', () => {
  it('shares one persistent partition and denies OS permissions on it', () => {
    expect(workspaceBrowserHostSource).toContain('session.fromPartition(WORKSPACE_BROWSER_PARTITION)')
    expect(workspaceBrowserHostSource).toContain('configurePreviewSessionPermissions(browserSession)')
  })

  it('adopts only guests that pass the main-window attach policy', () => {
    // Sandboxing is pinned by the policy (see workspaceBrowserGuest.test.ts);
    // here the wiring must install it before any page can exist.
    expect(workspaceBrowserHostSource).toContain('resolveWorkspaceBrowserGuest')
    expect(mainWindowSource).toContain('webviewTag: true')
    const policy = mainWindowSource.indexOf('installWorkspaceBrowserGuestPolicy(mainWindow.webContents')
    const session = mainWindowSource.indexOf('workspaceBrowserSession()')
    const load = mainWindowSource.indexOf('loadRendererEntry(mainWindow!)')
    expect(policy).toBeGreaterThan(-1)
    expect(session).toBeGreaterThan(-1)
    expect(policy).toBeLessThan(load)
    expect(session).toBeLessThan(load)
  })

  it('keeps app zoom from changing the pages\' own zoom', () => {
    const zoomHandler = mainSource.slice(
      mainSource.indexOf('ELECTRON_IPC_CHANNELS.zoomSet'),
      mainSource.indexOf('ELECTRON_IPC_CHANNELS.appearanceSetApplied'),
    )
    expect(zoomHandler.indexOf('setZoomFactor')).toBeLessThan(zoomHandler.indexOf('restorePageZoom()'))
  })

  it('never authenticates loopback requests made by a visited page', () => {
    // These pages render arbitrary remote sites. Attaching the desktop's local
    // access token to their loopback requests would give any visited site the
    // local API, which is exactly why the singleton preview refuses it too.
    expect(workspaceBrowserHostSource).not.toContain('configureLocalServerRequestAuth')
    expect(workspaceBrowserHostSource).not.toContain('resolveMainRendererServerAccess')
  })
})

describe('Electron workspace browser service', () => {
  it('keeps two pages alive at once and navigates only the addressed one', async () => {
    const harness = createHarness()

    await harness.open('tab-a', {
      storageId: 'store-a',
      url: 'https://a.example',
    })
    await harness.open('tab-b', {
      storageId: 'store-b',
      url: 'https://b.example',
    })
    await harness.service.navigate('tab-a', 'https://a.example/second')

    expect(harness.guests).toHaveLength(2)
    expect(requireGuest(harness, 0).loadedUrls).toEqual([
      'https://a.example',
      'https://a.example/second',
    ])
    expect(requireGuest(harness, 1).loadedUrls).toEqual(['https://b.example'])
    expect(requireGuest(harness, 1).destroyed).toBe(false)
  })

  it('names the one shared persistent partition every guest must use', () => {
    // The attach policy admits only this partition; a per-tab partition would
    // be the bug: `storageId` restores a page, it never forks the cookie jar.
    expect(WORKSPACE_BROWSER_PARTITION).toBe('persist:cc-haha-browser-app')
  })

  it('hides a page without ever destroying it', async () => {
    const harness = createHarness()

    await harness.open('tab-a')
    harness.service.setVisible('tab-a', true)
    harness.service.setVisible('tab-a', false)
    harness.service.setVisible('tab-a', true)

    expect(requireGuest(harness, 0).closed).toBe(0)
    expect(requireGuest(harness, 0).destroyed).toBe(false)
    await expect(harness.service.navigate('tab-a', 'https://a.example/next')).resolves.toBeUndefined()
  })

  it('accepts a redundant post-close hide but still rejects showing an absent page', async () => {
    const h = createHarness()
    await h.open('closed', { storageId: 'closed' })
    h.service.close('closed')
    expect(() => h.service.setVisible('closed', false)).not.toThrow()
    expect(() => h.service.setVisible('closed', true)).toThrow('workspace browser tab not open')
  })

  it('registers a page as soon as its guest is adopted and reports the blank document as no page', async () => {
    const h = createHarness()
    await h.open('pending', { storageId: 'pending' })
    // Until the first real navigation a tab has no address and no title; the
    // attach document must not become a URL the tab would then "load".
    expect(h.events).toContainEqual(expect.objectContaining({ type: 'state', tabId: 'pending', url: '', title: '' }))
    expect(requireGuest(h, 0).loadedUrls).toEqual([])
  })

  it.each(['resolve', 'reject'] as const)('never resurrects a closed page when its initial load later %ss', async (outcome) => {
    let resolve!: () => void
    let reject!: (error: Error) => void
    const loadResult = new Promise<void>((done, fail) => { resolve = done; reject = fail })
    const h = createHarness({ loadResult })
    // Registration does not wait for the first load; Stop already works.
    await h.open('pending', { storageId: 'pending', url: 'https://slow.test/' })
    expect(h.events).toContainEqual(expect.objectContaining({ type: 'state', tabId: 'pending' }))
    h.service.stop('pending')
    h.service.close('pending')
    const eventCount = h.events.length
    if (outcome === 'resolve') resolve()
    else reject(new Error('initial navigation failed'))
    await new Promise(done => setImmediate(done))
    expect(h.events).toHaveLength(eventCount)
    expect(requireGuest(h, 0).closed).toBe(1)
    expect(() => h.service.setVisible('pending', false)).not.toThrow()
    expect(() => h.service.setVisible('pending', true)).toThrow('workspace browser tab not open')
  })

  it('adopts nothing when the reported guest is not one it may adopt', async () => {
    const h = createHarness()
    await expect(h.service.create(h.parent, 'foreign', { storageId: 'foreign', webContentsId: 9_999 }))
      .rejects.toThrow('not a workspace browser guest')
    expect(h.events).toEqual([])
    expect(() => h.service.stop('foreign')).toThrow('workspace browser tab not open')
  })

  it('refuses to give one guest to two tabs or a second guest to a live tab', async () => {
    const h = createHarness()
    const guest = await h.open('tab-a')
    await expect(h.service.create(h.parent, 'tab-b', { storageId: 'b', webContentsId: guest.id }))
      .rejects.toThrow('already belongs to tab-a')
    const other = h.newGuest()
    await expect(h.service.create(h.parent, 'tab-a', { storageId: 'a', webContentsId: other.id }))
      .rejects.toThrow('already has a live page')
    expect(() => h.service.stop('tab-b')).toThrow('workspace browser tab not open')
  })

  it('keeps an adopted page retryable when its initial navigation fails', async () => {
    const h = createHarness({ loadResult: Promise.reject(new Error('initial navigation denied')) })
    // The failure reaches the tab as a `failed` event, like any navigation;
    // `create` answers only whether the page was adopted.
    await expect(h.open('retry', { storageId: 'retry', url: 'https://retry.test/' })).resolves.toBeDefined()
    expect(h.events).toContainEqual(expect.objectContaining({ type: 'state', tabId: 'retry' }))
    expect(() => h.service.reload('retry', { ignoreCache: true })).not.toThrow()
    expect(requireGuest(h, 0).reloads).toEqual(['reload-ignoring-cache'])
    expect(requireGuest(h, 0).destroyed).toBe(false)
  })

  it('treats a guest destroyed behind its back as a closed page with a retry', async () => {
    const h = createHarness()
    const guest = await h.open('lost', { url: 'https://lost.test/' })
    await h.open('kept')
    h.events.length = 0
    // The renderer lost the element (e.g. its layer was unmounted).
    guest.destroy()
    expect(h.events).toEqual([{ type: 'destroyed', tabId: 'lost', reason: 'closed' }])
    expect(() => h.service.stop('lost')).toThrow('workspace browser tab not open')
    // A retry builds a new page for the same tab.
    await h.open('lost', { url: 'https://lost.test/' })
    expect(requireGuest(h, 2).loadedUrls).toEqual(['https://lost.test/'])
    expect(() => h.service.stop('kept')).not.toThrow()
  })

  it('destroys only the closed page and leaves its neighbour intact', async () => {
    const harness = createHarness()

    await harness.open('tab-a', { storageId: 'store-a' })
    await harness.open('tab-b', { storageId: 'store-b' })
    harness.service.close('tab-a')

    expect(requireGuest(harness, 0).closed).toBe(1)
    expect(requireGuest(harness, 1).closed).toBe(0)
    expect(requireGuest(harness, 1).destroyed).toBe(false)
    await expect(harness.service.navigate('tab-b', 'https://b.example/next')).resolves.toBeUndefined()
    expect(() => harness.service.stop('tab-a')).toThrow('workspace browser tab not open')
  })

  it('drops native events that arrive after the tab was closed', async () => {
    const harness = createHarness()

    await harness.open('tab-a', { storageId: 'store-a' })
    await harness.open('tab-b', { storageId: 'store-b' })
    const closedContents = requireGuest(harness, 0)
    harness.service.close('tab-a')
    harness.events.length = 0

    closedContents.emit('did-stop-loading')
    closedContents.emit('did-fail-load', {}, -105, 'NAME_NOT_RESOLVED', 'https://a.example', true)
    closedContents.emit('render-process-gone', {}, { reason: 'crashed' })
    closedContents.windowOpenHandler?.({ url: 'https://popup.example' })

    expect(harness.events).toEqual([])

    requireGuest(harness, 1).emit('did-stop-loading')
    expect(harness.events.map(event => event.tabId)).toEqual(['tab-b'])
  })

  it('denies native popups and reports them as new-window events instead', async () => {
    const harness = createHarness()

    await harness.open('tab-a', { storageId: 'store-a' })
    const result = requireGuest(harness, 0).windowOpenHandler?.({
      url: 'https://popup.example/page',
    })

    expect(result).toEqual({ action: 'deny' })
    expect(harness.events).toContainEqual({
      type: 'new-window',
      tabId: 'tab-a',
      url: 'https://popup.example/page',
    })
  })

  it('blocks non-http navigation and rejects non-http loads outright', async () => {
    const harness = createHarness()

    await harness.open('tab-a', { storageId: 'store-a' })
    const preventDefault = vi.fn()
    requireGuest(harness, 0).emit('will-navigate', { preventDefault }, 'file:///etc/passwd')
    requireGuest(harness, 0).emit('will-navigate', { preventDefault }, 'https://ok.example')

    expect(preventDefault).toHaveBeenCalledTimes(1)
    await expect(harness.service.navigate('tab-a', 'javascript:alert(1)')).rejects.toThrow(
      'unsupported url scheme',
    )
    expect(requireGuest(harness, 0).windowOpenHandler?.({ url: 'file:///etc/passwd' }))
      .toEqual({ action: 'deny' })
    expect(harness.events.some(event => event.type === 'new-window')).toBe(false)
  })

  it('reads back and forward from the native navigation history', async () => {
    const harness = createHarness()

    await harness.open('tab-a', {
      storageId: 'store-a',
      url: 'https://a.example',
    })
    const webContents = requireGuest(harness, 0)
    webContents.emit('did-navigate', {}, 'https://a.example') // first commit
    webContents.backEntries = 1
    harness.events.length = 0
    webContents.emit('did-navigate', {}, 'https://a.example/second')

    expect(harness.events).toContainEqual(expect.objectContaining({
      type: 'state',
      tabId: 'tab-a',
      canGoBack: true,
      canGoForward: false,
    }))

    harness.service.goBack('tab-a')
    harness.service.goForward('tab-a')
    expect(webContents.history.goBack).toHaveBeenCalledTimes(1)
    expect(webContents.history.goForward).toHaveBeenCalledTimes(1)
  })

  it('reports main-frame load failures and crashes on the owning tab', async () => {
    const harness = createHarness()

    await harness.open('tab-a', { storageId: 'store-a' })
    const webContents = requireGuest(harness, 0)
    harness.events.length = 0

    webContents.emit('did-fail-load', {}, -6, 'FILE_NOT_FOUND', 'https://a.example/missing', false)
    expect(harness.events).toEqual([])

    webContents.emit('did-fail-load', {}, -6, 'FILE_NOT_FOUND', 'https://a.example/missing', true)
    webContents.emit('render-process-gone', {}, { reason: 'crashed' })

    expect(harness.events).toEqual([
      {
        type: 'failed',
        tabId: 'tab-a',
        url: 'https://a.example/missing',
        errorCode: -6,
        errorDescription: 'FILE_NOT_FOUND',
        navigationId: 0,
      },
      { type: 'destroyed', tabId: 'tab-a', reason: 'crashed' },
    ])
  })

  it('maps find and stop-find onto the native page search', async () => {
    const harness = createHarness()

    await harness.open('tab-a', { storageId: 'store-a' })
    harness.service.find('tab-a', ' invoice ', { matchCase: true, findNext: true })
    harness.service.stopFind('tab-a')
    harness.events.length = 0
    requireGuest(harness, 0).emit('found-in-page', {}, {
      activeMatchOrdinal: 2,
      matches: 7,
    })

    expect(requireGuest(harness, 0).finds).toEqual([
      { text: 'invoice', options: { matchCase: true, findNext: true } },
    ])
    expect(requireGuest(harness, 0).stopFinds).toEqual(['clearSelection'])
    expect(harness.events).toEqual([
      { type: 'found', tabId: 'tab-a', activeMatchOrdinal: 2, matches: 7 },
    ])
  })

  it('captures the viewport natively and the full page over CDP', async () => {
    const harness = createHarness()

    await harness.open('tab-a', { storageId: 'store-a' })
    const webContents = requireGuest(harness, 0)
    webContents.debugger = {
      isAttached: vi.fn(() => false),
      attach: vi.fn(),
      detach: vi.fn(),
      sendCommand: vi.fn(async (method: string) => {
        if (method === 'Page.getLayoutMetrics') {
          return { cssContentSize: { x: 0, y: 0, width: 1280, height: 3200 } }
        }
        return { data: 'FULL' }
      }),
    }
    harness.events.length = 0

    await harness.service.capture('tab-a', 'viewport')
    await harness.service.capture('tab-a', 'full')

    expect(harness.events).toEqual([
      {
        type: 'screenshot',
        tabId: 'tab-a',
        dataUrl: 'data:image/png;base64,VIEWPORT',
        kind: 'viewport',
      },
      {
        type: 'screenshot',
        tabId: 'tab-a',
        dataUrl: 'data:image/png;base64,FULL',
        kind: 'full',
      },
    ])
  })

  it('reports shared-session downloads on the tab that started them', async () => {
    const harness = createHarness()

    await harness.open('tab-a', { storageId: 'store-a' })
    await harness.open('tab-b', { storageId: 'store-b' })
    harness.events.length = 0

    const item = new FakeDownloadItem('report.pdf', 2_048)
    harness.sharedSession.startDownload(item, requireGuest(harness, 1))
    item.advance(2_048, 'completed')

    expect(harness.events).toEqual([
      {
        type: 'download',
        tabId: 'tab-b',
        download: {
          id: 'wbd-1',
          filename: 'report.pdf',
          savePath: '/tmp/report.pdf',
          receivedBytes: 0,
          totalBytes: 2_048,
          state: 'progressing',
        },
      },
      {
        type: 'download',
        tabId: 'tab-b',
        download: {
          id: 'wbd-1',
          filename: 'report.pdf',
          savePath: '/tmp/report.pdf',
          receivedBytes: 2_048,
          totalBytes: 2_048,
          state: 'completed',
        },
      },
    ])
  })

  it('exports a PDF through the host and reports it as a finished download', async () => {
    const harness = createHarness()

    await harness.open('tab-a', {
      storageId: 'store-a',
      url: 'https://a.example/report',
    })
    requireGuest(harness, 0).title = 'Quarterly Report'
    harness.events.length = 0

    await harness.service.printToPdf('tab-a')

    expect(harness.pdfWrites.map(write => write.filename)).toEqual(['Quarterly-Report.pdf'])
    expect(harness.events).toEqual([
      {
        type: 'download',
        tabId: 'tab-a',
        download: {
          id: 'wbd-1',
          filename: 'Quarterly-Report.pdf',
          savePath: '/downloads/Quarterly-Report.pdf',
          receivedBytes: 4,
          totalBytes: 4,
          state: 'completed',
        },
      },
    ])
    expect(workspaceBrowserPdfFilename('https://a.example/x', '  ')).toBe('a.example.pdf')
  })

  it('routes agent messages to the page that sent them and injects the agent after load', async () => {
    const harness = createHarness()

    await harness.open('tab-a', { storageId: 'store-a' })
    await harness.open('tab-b', { storageId: 'store-b' })
    requireGuest(harness, 1).emit('did-finish-load')
    await Promise.resolve()
    harness.events.length = 0

    const owned = harness.service.handleMessageFromView(
      requireGuest(harness, 1),
      JSON.stringify({ v: 1, type: 'ready' }),
    )
    const foreign = harness.service.handleMessageFromView({}, JSON.stringify({ v: 1, type: 'ready' }))
    await Promise.resolve()

    expect(owned).toBe(true)
    expect(foreign).toBe(false)
    expect(harness.events).toEqual([
      { type: 'agent', tabId: 'tab-b', message: { v: 1, type: 'ready' } },
    ])
    expect(requireGuest(harness, 1).scripts.some(script =>
      script.includes('window.__previewInjected = true'))).toBe(true)
  })

  it('forwards host messages only to the addressed page', async () => {
    const harness = createHarness()

    await harness.open('tab-a', { storageId: 'store-a' })
    await harness.open('tab-b', { storageId: 'store-b' })

    await harness.service.message('tab-a', { v: 1, type: 'enter-picker' })

    expect(requireGuest(harness, 0).scripts.some(script =>
      script.includes('enter-picker'))).toBe(true)
    expect(requireGuest(harness, 1).scripts).toEqual([])
  })

  it('keeps native floating zoom controls synchronized through menus, page changes and tab activation', async () => {
    const harness = createHarness()
    await harness.open('a', { storageId: 'a' })
    await harness.open('b', { storageId: 'b' })
    await harness.service.message('a', browserControls)
    await harness.service.message('b', browserControls)
    // Only the page on screen may act as browser chrome.
    harness.service.setVisible('b', true)
    const a = requireGuest(harness, 0)
    const b = requireGuest(harness, 1)
    const readConfig = (script: string) => JSON.parse(JSON.parse(script.slice(script.indexOf('(') + 1, -1))) as { type: string, zoomFactor: number }
    a.scripts.length = 0
    b.scripts.length = 0
    harness.service.handleMessageFromView(a, JSON.stringify({ v: 1, type: 'browser-zoom', action: 'out' }))
    await Promise.resolve()
    expect(a.zoomFactors).toEqual([])
    harness.service.handleMessageFromView(b, JSON.stringify({ v: 1, type: 'browser-zoom', action: 'out' }))
    await Promise.resolve()
    expect(b.zoomFactors).toEqual([0.9])
    expect(readConfig(b.scripts.at(-1)!)).toMatchObject({ type: 'browser-controls', zoomFactor: 0.9 })
    expect(a.scripts).toEqual([])
    harness.service.setZoom('b', 0.7)
    expect(readConfig(b.scripts.at(-1)!)).toMatchObject({ zoomFactor: 0.7 })
    b.scripts.length = 0
    b.emit('did-start-navigation', {}, 'https://b.example/next', false, true)
    b.emit('did-finish-load')
    await Promise.resolve()
    await Promise.resolve()
    expect(readConfig(b.scripts.at(-1)!)).toMatchObject({ zoomFactor: 0.7 })
    expect(b.scripts.some(script => script.includes('window.__previewInjected'))).toBe(true)
    harness.service.setVisible('a', true)
    expect(harness.events.filter(event => event.type === 'agent' && (event.message as { type: string }).type === 'browser-zoom')).toEqual([])
  })

  it('hides the native zoom capsule for a capture and restores it after a capture failure', async () => {
    const harness = createHarness()
    await harness.open('a', { storageId: 'a' })
    const page = requireGuest(harness, 0)
    page.capturePage.mockRejectedValueOnce(new Error('capture failed'))
    await expect(harness.service.capture('a', 'viewport')).rejects.toThrow('capture failed')
    expect(page.scripts).toEqual([
      'globalThis.__PREVIEW_AGENT_SET_CHROME_HIDDEN__?.(true)',
      'globalThis.__PREVIEW_AGENT_SET_CHROME_HIDDEN__?.(false)',
    ])
  })

  it('gives up on a viewport capture the compositor never answers', async () => {
    // A guest that is not on screen has no frame; Chromium then takes ~30s to
    // fail, and the page's zoom chrome would stay hidden all that time.
    const harness = createHarness({ captureTimeoutMs: 5 })
    await harness.open('a')
    const page = requireGuest(harness, 0)
    page.capturePage.mockReturnValueOnce(new Promise(() => {}))
    await expect(harness.service.capture('a', 'viewport')).rejects.toThrow('timed out')
    expect(page.scripts.at(-1)).toBe('globalThis.__PREVIEW_AGENT_SET_CHROME_HIDDEN__?.(false)')
    expect(harness.events.some(event => event.type === 'screenshot')).toBe(false)
  })

  it('keeps zoom chrome hidden until all overlapping native captures finish', async () => {
    const harness = createHarness()
    await harness.open('a', { storageId: 'a' })
    const page = requireGuest(harness, 0)
    let resolveFirst!: (image: Awaited<ReturnType<typeof page.capturePage>>) => void
    page.capturePage.mockReturnValueOnce(new Promise(resolve => { resolveFirst = resolve }))
    const first = harness.service.capture('a', 'viewport')
    await Promise.resolve()
    await harness.service.capture('a', 'viewport')
    expect(page.scripts.some(script => script.includes('CHROME_HIDDEN__?.(false)'))).toBe(false)
    resolveFirst({ toDataURL: () => 'data:image/png;base64,VIEWPORT' })
    await first
    expect(page.scripts.at(-1)).toBe('globalThis.__PREVIEW_AGENT_SET_CHROME_HIDDEN__?.(false)')
  })

  const pickerCommandGeneration = (page: FakeWebContents): number => {
    const script = page.scripts.filter(script => script.includes('enter-picker') || script.includes('exit-picker')).at(-1)!
    return JSON.parse(JSON.parse(script.match(/handleHostRaw\((.*)\)$/)![1]!)).generation as number
  }

  it.each([false, true])('exits the live page picker on same-document navigation (capture pending: %s)', async (capturing) => {
    const harness = createHarness()
    await harness.open('a', { storageId: 'a' })
    const page = requireGuest(harness, 0)
    let finish!: (image: Awaited<ReturnType<typeof page.capturePage>>) => void
    await harness.service.message('a', { v: 1, type: 'enter-picker', persistent: true })
    if (capturing) {
      page.capturePage.mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
      harness.service.handleMessageFromView(page, JSON.stringify({ v: 1, type: 'selection', generation: pickerCommandGeneration(page), payload: { element: { tag: 'h1' }, screenshot: { kind: 'region', captureId: 1 } } }))
      await new Promise(resolve => setImmediate(resolve))
    }
    page.emit('did-start-navigation', {}, 'https://example.test/#next', true, true)
    page.emit('did-navigate-in-page', {}, 'https://example.test/#next', true)
    expect(page.scripts.some(script => script.includes('exit-picker'))).toBe(true)
    expect(harness.events.filter(event => event.type === 'state').at(-1)).toMatchObject({ annotationActive: false })
    const count = page.scripts.filter(script => script.includes('enter-picker')).length
    if (capturing) finish({ toDataURL: () => 'data:image/png;base64,VIEWPORT' })
    await new Promise(resolve => setImmediate(resolve))
    expect(page.scripts.filter(script => script.includes('enter-picker'))).toHaveLength(count)
  })

  it('rejects delayed exits and selections after a newer generation, including missing identity after negotiation', async () => {
    const harness = createHarness()
    await harness.open('a', { storageId: 'a' })
    const page = requireGuest(harness, 0)
    const commandGeneration = () => {
      const script = page.scripts.filter(script => script.includes('enter-picker') || script.includes('exit-picker')).at(-1)!
      return JSON.parse(JSON.parse(script.match(/handleHostRaw\((.*)\)$/)![1]!)).generation as number
    }
    harness.service.handleMessageFromView(page, '{"v":1,"type":"ready","supportsPickerGeneration":true}')
    await harness.service.message('a', { v: 1, type: 'enter-picker', persistent: true })
    await harness.service.message('a', { v: 1, type: 'exit-picker' })
    const oldGeneration = commandGeneration()
    await harness.service.message('a', { v: 1, type: 'enter-picker', persistent: true })
    const newGeneration = commandGeneration()
    expect(newGeneration).toBeGreaterThan(oldGeneration)
    for (const generation of [oldGeneration, undefined]) {
      harness.service.handleMessageFromView(page, JSON.stringify({ v: 1, type: 'picker-exited', reason: 'host', generation }))
      harness.service.handleMessageFromView(page, JSON.stringify({ v: 1, type: 'selection', generation, payload: { element: { tag: 'old' } } }))
    }
    expect(harness.events.filter(event => event.type === 'state').at(-1)).toMatchObject({ annotationActive: true })
    harness.service.handleMessageFromView(page, JSON.stringify({ v: 1, type: 'selection', generation: newGeneration, payload: { element: { tag: 'h1' } } }))
    await new Promise(resolve => setImmediate(resolve))
    expect(harness.events.filter(event => event.type === 'agent' && (event.message as { type?: string }).type === 'selection')).toHaveLength(1)
  })

  it('preserves legacy v1 single selection and cancellation without a generation handshake', async () => {
    const harness = createHarness()
    await harness.open('a', { storageId: 'a' })
    const page = requireGuest(harness, 0)
    const select = () => harness.service.handleMessageFromView(page, '{"v":1,"type":"selection","payload":{"element":{"tag":"h1"}}}')
    await harness.service.message('a', { v: 1, type: 'enter-picker' })
    select()
    await new Promise(resolve => setImmediate(resolve))
    const selections = () => harness.events.filter(event => event.type === 'agent' && (event.message as { type?: string }).type === 'selection')
    expect(selections()).toHaveLength(1)
    await harness.service.message('a', { v: 1, type: 'enter-picker' })
    harness.service.handleMessageFromView(page, '{"v":1,"type":"picker-exited","reason":"cancel-current"}')
    select()
    await new Promise(resolve => setImmediate(resolve))
    expect(selections()).toHaveLength(1)
  })

  it('does not let a delayed failed exit or its old event clear a newer mode', async () => {
    const harness = createHarness()
    await harness.open('a', { storageId: 'a' })
    const page = requireGuest(harness, 0)
    await harness.service.message('a', { v: 1, type: 'enter-picker', persistent: true })
    const oldGeneration = pickerCommandGeneration(page)
    let rejectExit!: (error: Error) => void
    vi.spyOn(page, 'executeJavaScript').mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectExit = reject }))
    const exiting = harness.service.message('a', { v: 1, type: 'exit-picker' })
    await harness.service.message('a', { v: 1, type: 'enter-picker', persistent: true })
    rejectExit(new Error('old page command failed'))
    await expect(exiting).rejects.toThrow('old page command failed')
    harness.service.handleMessageFromView(page, JSON.stringify({ v: 1, type: 'picker-exited', generation: oldGeneration, reason: 'host' }))
    expect(harness.events.filter(event => event.type === 'state').at(-1)).toMatchObject({ annotationActive: true })
  })

  it('clears annotation mode if the page rejects a picker command', async () => {
    const harness = createHarness()
    await harness.open('a', { storageId: 'a' })
    const page = requireGuest(harness, 0)
    vi.spyOn(page, 'executeJavaScript').mockRejectedValueOnce(new Error('page unavailable'))
    await expect(harness.service.message('a', { v: 1, type: 'enter-picker', persistent: true })).rejects.toThrow('page unavailable')
    expect(harness.events.filter(event => event.type === 'state').at(-1)).toMatchObject({ annotationActive: false })
    harness.service.handleMessageFromView(page, JSON.stringify({ v: 1, type: 'selection', payload: { element: { tag: 'h1' } } }))
    await new Promise(resolve => setImmediate(resolve))
    expect(harness.events.filter(event => event.type === 'agent')).toHaveLength(0)
  })

  it('rearms persistent annotations after capture but keeps legacy picking one-shot', async () => {
    const harness = createHarness()
    await harness.open('a', { storageId: 'a' })
    const page = requireGuest(harness, 0)
    await harness.service.message('a', { v: 1, type: 'enter-picker', persistent: true, label: 1 })
    const select = () => harness.service.handleMessageFromView(page, JSON.stringify({ v: 1, type: 'selection', generation: pickerCommandGeneration(page), payload: { element: { tag: 'h1' }, screenshot: { kind: 'region', captureId: 1 } } }))
    select()
    select() // a replay during capture must still be rejected
    await new Promise(resolve => setImmediate(resolve))
    expect(harness.events.filter(event => event.type === 'agent')).toHaveLength(1)
    expect(page.scripts.filter(script => script.includes('enter-picker'))).toHaveLength(2)
    select()
    await new Promise(resolve => setImmediate(resolve))
    expect(harness.events.filter(event => event.type === 'agent')).toHaveLength(2)
    await harness.service.message('a', { v: 1, type: 'enter-picker' })
    const count = page.scripts.filter(script => script.includes('enter-picker')).length
    select()
    await new Promise(resolve => setImmediate(resolve))
    expect(page.scripts.filter(script => script.includes('enter-picker'))).toHaveLength(count)
    select()
    await new Promise(resolve => setImmediate(resolve))
    expect(harness.events.filter(event => event.type === 'agent')).toHaveLength(3)
  })

  it.each(['exit', 'navigate', 'new-picker'] as const)('does not rearm an old annotation after %s during capture', async (action) => {
    const harness = createHarness()
    await harness.open('a', { storageId: 'a' })
    const page = requireGuest(harness, 0)
    let finish!: (image: Awaited<ReturnType<typeof page.capturePage>>) => void
    page.capturePage.mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
    await harness.service.message('a', { v: 1, type: 'enter-picker', persistent: true })
    harness.service.handleMessageFromView(page, JSON.stringify({ v: 1, type: 'selection', generation: pickerCommandGeneration(page), payload: { element: { tag: 'h1' }, screenshot: { kind: 'region', captureId: 1 } } }))
    await new Promise(resolve => setImmediate(resolve))
    if (action === 'exit') await harness.service.message('a', { v: 1, type: 'exit-picker' })
    else if (action === 'navigate') page.emit('did-start-navigation', {}, 'https://next.test/', false, true)
    else await harness.service.message('a', { v: 1, type: 'enter-picker' })
    const count = page.scripts.filter(script => script.includes('enter-picker')).length
    finish({ toDataURL: () => 'data:image/png;base64,VIEWPORT' })
    await new Promise(resolve => setImmediate(resolve))
    expect(page.scripts.filter(script => script.includes('enter-picker'))).toHaveLength(count)
    expect(harness.events.filter(event => event.type === 'state').at(-1)).toMatchObject({ annotationActive: false })
  })

  it('returns the selection capture id to its own cleanup even when captures finish out of order', async () => {
    const harness = createHarness()
    await harness.open('a', { storageId: 'a' })
    const page = requireGuest(harness, 0)
    let resolveFirst!: (image: Awaited<ReturnType<typeof page.capturePage>>) => void
    page.capturePage.mockReturnValueOnce(new Promise(resolve => { resolveFirst = resolve }))
    const select = async (captureId: number) => {
      await harness.service.message('a', { v: 1, type: 'enter-picker' })
      harness.service.handleMessageFromView(page, JSON.stringify({ v: 1, type: 'selection',
        payload: { element: { tag: 'h1' }, screenshot: { kind: 'region', captureId } },
      }))
      await new Promise(resolve => setImmediate(resolve))
    }
    await select(14)
    await select(15)
    expect(page.scripts.filter(script => script.includes('CLEAR_SELECTION_OVERLAY'))).toEqual([
      'globalThis.__PREVIEW_AGENT_CLEAR_SELECTION_OVERLAY__?.(15)',
    ])
    resolveFirst({ toDataURL: () => 'data:image/png;base64,VIEWPORT' })
    await new Promise(resolve => setImmediate(resolve))
    expect(page.scripts.filter(script => script.includes('CLEAR_SELECTION_OVERLAY'))).toEqual([
      'globalThis.__PREVIEW_AGENT_CLEAR_SELECTION_OVERLAY__?.(15)',
      'globalThis.__PREVIEW_AGENT_CLEAR_SELECTION_OVERLAY__?.(14)',
    ])
  })

  it('does not clean a new document when an old selection capture finishes after navigation', async () => {
    const harness = createHarness()
    await harness.open('a', { storageId: 'a' })
    const page = requireGuest(harness, 0)
    let finishCapture!: (image: Awaited<ReturnType<typeof page.capturePage>>) => void
    page.capturePage.mockReturnValueOnce(new Promise(resolve => { finishCapture = resolve }))
    await harness.service.message('a', { v: 1, type: 'enter-picker' })
    harness.service.handleMessageFromView(page, JSON.stringify({ v: 1, type: 'selection',
      payload: { element: { tag: 'h1' }, screenshot: { kind: 'region', captureId: 1 } },
    }))
    await new Promise(resolve => setImmediate(resolve))
    page.emit('did-start-navigation', {}, 'https://a.example/new', false, true)
    finishCapture({ toDataURL: () => 'data:image/png;base64,VIEWPORT' })
    await new Promise(resolve => setImmediate(resolve))
    expect(page.scripts.some(script => script.includes('CLEAR_SELECTION_OVERLAY'))).toBe(false)
    expect(harness.events.filter(event => event.type === 'agent')).toEqual([])
  })

  it('records a visit log without standing in for the native back stack', async () => {
    const harness = createHarness()

    await harness.open('tab-a', { storageId: 'store-a' })
    const webContents = requireGuest(harness, 0)
    harness.events.length = 0
    webContents.emit('did-navigate', {}, 'https://a.example/one')
    webContents.emit('did-navigate', {}, 'https://a.example/one')
    webContents.emit('did-navigate', {}, 'https://a.example/two')

    const historyEvents = harness.events.filter(event => event.type === 'history')
    expect(historyEvents).toHaveLength(2)
    const last = historyEvents.at(-1)
    expect(last?.type === 'history' && last.entries.map(entry => entry.url)).toEqual([
      'https://a.example/one',
      'https://a.example/two',
    ])
    // Back/forward never consults that list.
    expect(webContents.history.canGoBack).toHaveBeenCalled()
  })

  it('releases every page when the host tears the workspace down', async () => {
    const harness = createHarness()

    await harness.open('tab-a', { storageId: 'store-a' })
    await harness.open('tab-b', { storageId: 'store-b' })
    harness.service.closeAll()

    expect(requireGuest(harness, 0).closed).toBe(1)
    expect(requireGuest(harness, 1).closed).toBe(1)
    expect(() => harness.service.stop('tab-b')).toThrow('workspace browser tab not open')
  })

  it('never re-navigates a live page when its tab is registered again', async () => {
    const harness = createHarness()

    const guest = await harness.open('tab-a', {
      storageId: 'store-a',
      url: 'https://a.example',
    })
    await harness.service.navigate('tab-a', 'https://a.example/checkout')

    // The renderer registers a page again whenever it re-establishes it, with
    // the tab's last known URL. Honouring that would be a hard navigation: the
    // half-filled form, the scroll position and the real back stack would all
    // be lost — which is the one thing keeping the page alive is supposed to
    // prevent.
    await harness.service.create(harness.parent, 'tab-a', {
      storageId: 'store-a',
      url: 'https://a.example/checkout',
      webContentsId: guest.id,
    })

    expect(harness.guests).toHaveLength(1)
    expect(requireGuest(harness, 0).loadedUrls).toEqual([
      'https://a.example',
      'https://a.example/checkout',
    ])
  })

  it('registers nothing when create is given arguments it cannot use', async () => {
    const harness = createHarness()
    const guest = harness.newGuest()

    await expect(harness.service.create(harness.parent, 'tab-bad', {
      storageId: 'store-bad',
      url: 'file:///etc/passwd',
      webContentsId: guest.id,
    })).rejects.toThrow()

    // A page registered before validation would have no owner that could
    // address it for closing.
    expect(guest.loadedUrls).toEqual([])
    expect(() => harness.service.stop('tab-bad')).toThrow('workspace browser tab not open')
  })

  it('applies zoom and reload modes to the addressed page only', async () => {
    const harness = createHarness()

    await harness.open('tab-a', { storageId: 'store-a' })
    await harness.open('tab-b', { storageId: 'store-b' })
    harness.service.setZoom('tab-a', 1.25)
    harness.service.reload('tab-a', { ignoreCache: true })
    harness.service.reload('tab-b')
    harness.service.stop('tab-b')

    expect(requireGuest(harness, 0).zoomFactors).toEqual([1.25])
    expect(requireGuest(harness, 1).zoomFactors).toEqual([])
    expect(requireGuest(harness, 0).reloads).toEqual(['reload-ignoring-cache'])
    expect(requireGuest(harness, 1).reloads).toEqual(['reload'])
    expect(requireGuest(harness, 1).stops).toBe(1)
  })
})


describe('browser recovery boundaries', () => {
  it.each(['completed', 'cancelled', 'interrupted'])('reports %s after closing the source page or session', async (state) => {
    for (const closeAll of [false, true]) {
      const h = createHarness()
      await h.open('source', { storageId: 'source' })
      const contents = requireGuest(h, 0)
      const item = new FakeDownloadItem('large.zip', 2000)
      h.sharedSession.startDownload(item, contents)
      item.advance(100, 'progressing')
      if (closeAll) h.service.closeAll()
      else h.service.close('source')
      const before = h.events.length
      contents.emit('did-fail-load', {}, -105, 'late failure', 'https://old.test/', true)
      expect(h.events).toHaveLength(before)
      item.advance(state === 'completed' ? 2000 : 100, state)
      const reports = h.events.filter(event => event.type === 'download')
      expect(new Set(reports.map(event => event.download.id)).size).toBe(1)
      expect(reports.at(-1)?.download.state).toBe(state)
      expect(contents.closed).toBe(1)
    }
  })

  it('does not report a completed PDF when the Save dialog is cancelled', async () => {
    const h = createHarness({ cancelPdf: true })
    await h.open('source', { storageId: 'source' })
    await h.service.printToPdf('source')
    expect(h.pdfWrites).toHaveLength(0)
    expect(h.events.filter(event => event.type === 'download')).toHaveLength(0)
  })

  it.each(['goBack', 'goForward', 'reload', 'navigate'] as const)('marks successful %s after an error with a new generation', async (operation) => {
    const h = createHarness()
    await h.open('source', { storageId: 'source' })
    const contents = requireGuest(h, 0)
    contents.emit('did-start-navigation', {}, 'https://bad.test/', false, true)
    contents.emit('did-fail-load', {}, -105, 'NAME_NOT_RESOLVED', 'https://bad.test/', true)
    contents.emit('did-stop-loading')
    contents.emit('did-finish-load') // Chromium also finishes its error document.
    expect(h.events.at(-1)).toMatchObject({ type: 'state', navigationId: 1, navigationOutcome: 'failed' })
    if (operation === 'navigate') await h.service.navigate('source', 'https://ok.test/')
    else h.service[operation]('source')
    contents.emit('did-start-navigation', {}, 'https://ok.test/', false, true)
    contents.emit('did-fail-load', {}, -105, 'LATE_FAILURE', 'https://bad.test/', true)
    contents.url = 'https://ok.test/'
    contents.emit('did-navigate', {}, contents.url)
    contents.emit('did-finish-load')
    expect(h.events.at(-1)).toMatchObject({ type: 'state', navigationId: 2, navigationOutcome: 'succeeded' })
    const count = h.events.length
    contents.emit('did-fail-load', {}, -105, 'LATE_FAILURE', contents.url, true)
    expect(h.events).toHaveLength(count)
  })

  it('ignores cancelled/subframe loads and tracks redirected navigation failure', async () => {
    const h = createHarness()
    await h.open('source', { storageId: 'source' })
    const contents = requireGuest(h, 0)
    contents.emit('did-start-navigation', {}, 'https://old.test/', false, true)
    contents.emit('did-start-navigation', {}, 'https://frame.test/', false, false)
    contents.emit('did-redirect-navigation', {}, 'https://new.test/', false, true)
    contents.emit('did-fail-load', {}, -3, 'ERR_ABORTED', 'https://old.test/', true)
    expect(h.events.filter(event => event.type === 'failed')).toHaveLength(0)
    contents.emit('did-fail-load', {}, -105, 'NAME_NOT_RESOLVED', 'https://new.test/', true)
    expect(h.events.at(-1)).toMatchObject({ type: 'failed', navigationId: 1, url: 'https://new.test/' })
  })

  it.each(['darwin', 'win32', 'linux'] as const)('routes focused native shortcuts on %s without consuming page editing', async (platform) => {
    const h = createHarness({ platform })
    await h.open('source', { storageId: 'source' })
    const contents = requireGuest(h, 0)
    const unshown = vi.fn()
    contents.emit('before-input-event', { preventDefault: unshown }, { type: 'keyDown', key: 'w', meta: platform === 'darwin', control: platform !== 'darwin', shift: false, alt: false })
    expect(unshown).not.toHaveBeenCalled()
    h.service.setVisible('source', true)
    const input = { type: 'keyDown', key: 'w', meta: platform === 'darwin', control: platform !== 'darwin', shift: false, alt: false }
    for (const [key, action] of [['w', 'close-tab'], ['t', 'new-browser-tab'], ['j', 'toggle-bottom-panel']]) {
      const preventDefault = vi.fn()
      contents.emit('before-input-event', { preventDefault }, { ...input, key })
      expect(preventDefault).toHaveBeenCalledTimes(1)
      expect(h.events.at(-1)).toMatchObject({ type: 'shortcut', tabId: 'source', action })
    }
    const cycle = vi.fn()
    contents.emit('before-input-event', { preventDefault: cycle }, { ...input, key: 'Tab', meta: false, control: true })
    expect(h.events.at(-1)).toMatchObject({ type: 'shortcut', action: 'next-tab' })
    for (const key of ['f', 'c', 'v', 'a', 'z']) {
      const preventDefault = vi.fn()
      contents.emit('before-input-event', { preventDefault }, { ...input, key })
      expect(preventDefault).not.toHaveBeenCalled()
    }
    h.service.setVisible('source', false)
    const hidden = vi.fn()
    contents.emit('before-input-event', { preventDefault: hidden }, input)
    expect(hidden).not.toHaveBeenCalled()
  })

  it('reports actual zoom after reattachment and across same-origin pages', async () => {
    const h = createHarness()
    await h.open('a', { storageId: 'a', url: 'https://same.test/a' })
    await h.open('b', { storageId: 'b', url: 'https://same.test/b' })
    const a = requireGuest(h, 0)
    const b = requireGuest(h, 1)
    // Emulate Chromium applying shared-origin zoom outside this service.
    a.zoomFactor = 1.5
    b.zoomFactor = 1.5
    h.service.setVisible('a', true)
    expect(h.events.at(-1)).toMatchObject({ type: 'state', tabId: 'a', zoomFactor: 1.5 })
    h.service.setZoom('b', 1.8)
    expect(h.events.filter(event => event.type === 'state' && event.tabId === 'b').at(-1)).toMatchObject({ zoomFactor: 1.8 })
    a.zoomFactor = 2
    a.emit('zoom-changed', {}, 'in')
    expect(h.events.filter(event => event.type === 'state' && event.tabId === 'a').at(-1)).toMatchObject({ zoomFactor: 2 })
  })
})


const menuOptions: WorkspaceBrowserMenuOptions = {
  x: 20, y: 44, zoomFactor: 1, hasPage: true, canOpenExternal: true,
  labels: { find: 'Find', print: 'Print', zoom: 'Zoom', zoomIn: 'Larger', zoomOut: 'Smaller', zoomReset: 'Reset', capture: 'Capture', pickElement: 'Pick', downloads: 'Downloads', history: 'History', openExternal: 'External' },
}

function menuHarness() {
  const menus: Array<{ template: MenuItemConstructorOptions[]; popup: ReturnType<typeof vi.fn>; closePopup: ReturnType<typeof vi.fn> }> = []
  const h = createHarness({ menuFactory: (template) => {
    const menu = { template, popup: vi.fn(), closePopup: vi.fn() }
    menus.push(menu)
    return menu
  } })
  return { ...h, menus }
}

function chooseMenu(h: ReturnType<typeof menuHarness>, index: number, action: string) {
  const item = h.menus[index]!.template.find(item => item.id === action)
  const click = item?.click as (() => void) | undefined
  click?.()
}

describe('native browser popup lifetime', () => {
  it('opens a native menu without hiding, navigating or replacing its live page', async () => {
    const h = menuHarness()
    await h.open('wb-menu', { storageId: 'menu', url: 'https://example.test/' })
    h.service.setVisible('wb-menu', true)
    const guest = requireGuest(h, 0)
    const pending = h.service.showMenu(h.parent, 'wb-menu', menuOptions)
    expect(h.menus).toHaveLength(1)
    expect(guest.loadedUrls).toEqual(['https://example.test/'])
    expect(guest.destroyed).toBe(false)
    expect(h.guests).toHaveLength(1)
    chooseMenu(h, 0, 'find')
    await expect(pending).resolves.toBe('find')
  })

  it.each(['hide', 'close', 'closeAll'] as const)('cancels a pending popup on %s and ignores late selection', async action => {
    const h = menuHarness()
    await h.open('wb-menu', { storageId: 'menu' })
    const pending = h.service.showMenu(h.parent, 'wb-menu', menuOptions)
    if (action === 'hide') h.service.setVisible('wb-menu', false)
    else if (action === 'close') h.service.close('wb-menu')
    else h.service.closeAll()
    await expect(pending).resolves.toBeNull()
    expect(h.menus[0]!.closePopup).toHaveBeenCalledTimes(1)
    chooseMenu(h, 0, 'print')
    await expect(pending).resolves.toBeNull()
  })

  it('cancels the previous popup before opening another without letting its callback cancel the new popup', async () => {
    const h = menuHarness()
    await h.open('wb-menu', { storageId: 'menu' })
    const first = h.service.showMenu(h.parent, 'wb-menu', menuOptions)
    const second = h.service.showMenu(h.parent, 'wb-menu', menuOptions)
    await expect(first).resolves.toBeNull()
    h.menus[0]!.popup.mock.calls[0]![0].callback()
    chooseMenu(h, 0, 'capture')
    chooseMenu(h, 1, 'history')
    await expect(second).resolves.toBe('history')
  })

  it('allows a registered page that is not shown yet to open its menu', async () => {
    const h = menuHarness()
    await h.open('wb-menu', { storageId: 'menu' })
    const pending = h.service.showMenu(h.parent, 'wb-menu', menuOptions)
    chooseMenu(h, 0, 'downloads')
    await expect(pending).resolves.toBe('downloads')
  })

  it('uses the current native zoom for menu bounds and percentage instead of stale renderer state', async () => {
    const h = menuHarness()
    await h.open('wb-menu', { storageId: 'menu' })
    requireGuest(h, 0).zoomFactor = 2
    h.events.length = 0
    const pending = h.service.showMenu(h.parent, 'wb-menu', menuOptions)
    expect(h.events).toEqual([expect.objectContaining({ type: 'state', tabId: 'wb-menu', zoomFactor: 2 })])
    expect(h.menus[0]!.template.find(item => item.id === 'zoomIn')?.enabled).toBe(false)
    expect(h.menus[0]!.template.find(item => item.id === 'zoom')?.label).toContain('200%')
    h.menus[0]!.popup.mock.calls[0]![0].callback()
    await expect(pending).resolves.toBeNull()
  })

  it('rejects missing pages, foreign owners and destroyed parents without constructing a menu', async () => {
    const h = menuHarness()
    await expect(h.service.showMenu(h.parent, 'missing', menuOptions)).rejects.toThrow('tab not open')
    await h.open('wb-menu', { storageId: 'menu' })
    await expect(h.service.showMenu(fakeParent(), 'wb-menu', menuOptions)).rejects.toThrow('window')
    h.parent.isDestroyed.mockReturnValue(true)
    await expect(h.service.showMenu(h.parent, 'wb-menu', menuOptions)).rejects.toThrow('window')
    expect(h.menus).toHaveLength(0)
  })
})

// A `<webview>` guest differs from the old native page in three ways Electron
// imposes; each would be a visible regression if left alone.
describe('webview guest parity with the native page', () => {
  it('does not let the first page go back to the blank document it attached with', async () => {
    const h = createHarness()
    const guest = await h.open('tab-a', { url: 'https://a.example/' })
    guest.backEntries = 1 // the attach document is a real history entry
    guest.url = 'https://a.example/'
    guest.emit('did-navigate', {}, guest.url)
    expect(guest.history.clear).toHaveBeenCalledTimes(1)
    expect(h.events.filter(event => event.type === 'state').at(-1)).toMatchObject({ canGoBack: false })

    // Later navigations keep their real back stack.
    guest.backEntries = 1
    guest.url = 'https://a.example/next'
    guest.emit('did-navigate', {}, guest.url)
    expect(guest.history.clear).toHaveBeenCalledTimes(1)
    expect(h.events.filter(event => event.type === 'state').at(-1)).toMatchObject({ canGoBack: true })
  })

  it('starts a page at 100% even though Electron attached it at the app zoom', async () => {
    const h = createHarness()
    const guest = h.newGuest()
    guest.zoomFactor = 1.25
    await h.service.create(h.parent, 'tab-a', { storageId: 'a', webContentsId: guest.id })
    expect(guest.zoomFactor).toBe(1)
  })

  it('puts every page back at its own zoom when app zoom changes', async () => {
    const h = createHarness()
    const a = await h.open('a', { url: 'https://a.test/' })
    const b = await h.open('b', { url: 'https://b.test/' })
    a.url = 'https://a.test/'
    b.url = 'https://b.test/'
    h.service.setZoom('a', 1.5)
    // Electron copies the embedder's zoom into every guest.
    a.zoomFactor = 1.1
    b.zoomFactor = 1.1
    h.service.restorePageZoom()
    expect(a.zoomFactor).toBe(1.5)
    expect(b.zoomFactor).toBe(1)
  })

  it('restores the zoom Chromium would give a host after Electron resets it on navigation', async () => {
    const h = createHarness()
    const guest = await h.open('tab-a', { url: 'https://zoomed.test/' })
    guest.url = 'https://zoomed.test/'
    h.service.setZoom('tab-a', 1.5)

    const navigate = (url: string, electronZoom: number) => {
      guest.url = url
      guest.emit('did-navigate', {}, url)
      // Electron applies the embedder's zoom after `did-navigate` listeners
      // return, which is why the service defers its correction.
      guest.zoomFactor = electronZoom
      h.flushDeferred()
    }
    navigate('https://other.test/', 1.1)
    expect(guest.zoomFactor).toBe(1)
    // Per host, not per page: a host's zoom survives leaving and returning,
    // and does not depend on port or scheme.
    navigate('http://zoomed.test:8080/again', 1.1)
    expect(guest.zoomFactor).toBe(1.5)
    expect(h.events.filter(event => event.type === 'state').at(-1)).toMatchObject({ zoomFactor: 1.5 })
  })

  it('does not correct the zoom of a page closed before the deferred correction ran', async () => {
    const h = createHarness()
    const guest = await h.open('tab-a')
    guest.url = 'https://late.test/'
    guest.emit('did-navigate', {}, guest.url)
    guest.zoomFactor = 1.1
    h.service.close('tab-a')
    const before = guest.zoomFactors.length
    h.flushDeferred()
    expect(guest.zoomFactors).toHaveLength(before)
  })
})
