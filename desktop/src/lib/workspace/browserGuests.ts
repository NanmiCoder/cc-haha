import {
  WORKSPACE_BROWSER_INITIAL_SRC,
  WORKSPACE_BROWSER_PARTITION,
} from './browserGuestContract'

/**
 * Renderer side of the workspace browser: one `<webview>` per page.
 *
 * Why a `<webview>` and not a native view: a native view always paints above
 * the DOM, so every menu, dialog and page that should cover it had to hide it
 * or swap in a screenshot — which flickered, and was missed by every overlay
 * that did not opt in. A webview is composited with the page like any element.
 *
 * Why this module and not React: a webview that leaves the DOM destroys its
 * page, and one that is *moved* reloads it. React unmounts a tab's surface
 * whenever the tab, the task or the panel changes, so the element can never
 * live inside that surface. It lives in a layer that is mounted once, is never
 * re-parented, and is only positioned over whatever placeholder currently
 * shows the page. The page's lifetime is `dispose`, nothing else.
 */

const ATTACH_TIMEOUT_MS = 10_000

type WebviewElement = HTMLElement & { getWebContentsId(): number }

type GuestRecord = {
  tabId: string
  slot: HTMLDivElement
  webview: WebviewElement
  webContentsId: number | null
  attach: Promise<number> | null
  registration: Promise<void> | null
  registered: boolean
}

type Placement = {
  token: object
  stage: HTMLElement
  visible: boolean
  observer: ResizeObserver | null
}

let layer: HTMLElement | null = null
let layerObserver: ResizeObserver | null = null
let layerWaiters: Array<(element: HTMLElement) => void> = []
const guests = new Map<string, GuestRecord>()
const placements = new Map<string, Placement>()
let gesture = false
let gestureListenersInstalled = false

/**
 * The layer is rendered once, inside the session panel's stacking context, so
 * a page paints above the workspace like the placeholder it covers and below
 * every dropdown, dialog and toast — and fades with the panel when another page
 * replaces it.
 */
export function setWorkspaceBrowserGuestLayer(element: HTMLElement | null): void {
  if (element === layer) return
  layerObserver?.disconnect()
  layerObserver = null
  layer = element
  // Guests are never moved here: a webview that changes parents reloads.
  // Pages whose element went away with an old layer are disconnected, which
  // is how `ensureWorkspaceBrowserGuest` knows to rebuild them; pages still
  // waiting for a layer attach to this one.
  if (!element) return
  installGestureListeners()
  if (typeof ResizeObserver !== 'undefined') {
    layerObserver = new ResizeObserver(() => applyAllPlacements())
    layerObserver.observe(element)
  }
  const waiters = layerWaiters
  layerWaiters = []
  for (const resolve of waiters) resolve(element)
}

/**
 * Creates the page's webview if it has none and registers it with the host.
 * Repeated calls for a live page resolve without touching it.
 */
export function ensureWorkspaceBrowserGuest(
  tabId: string,
  register: (webContentsId: number) => Promise<void>,
): Promise<void> {
  let record = guests.get(tabId)
  if (record && !record.slot.isConnected) {
    forget(record)
    record = undefined
  }
  if (record?.registration) return record.registration
  const current = record ?? createGuest(tabId)
  const registration = attachGuest(current).then(webContentsId => register(webContentsId)).then(
    () => {
      if (guests.get(tabId) === current) current.registered = true
    },
    (error: unknown) => {
      // The host adopted nothing, so nothing addresses this guest. Drop it and
      // let the next attempt start from a fresh element.
      if (guests.get(tabId) === current) dispose(current)
      throw error
    },
  )
  current.registration = registration
  return registration
}

export function isWorkspaceBrowserGuestRegistered(tabId: string): boolean {
  const record = guests.get(tabId)
  return Boolean(record?.registered && record.slot.isConnected)
}

/**
 * Draws the page over `stage` while `visible`, otherwise parks it. Returns a
 * release that parks the page only if no later placement replaced this one.
 * A placement may precede the page's creation; it applies once the page exists.
 */
export function placeWorkspaceBrowserGuest(
  tabId: string,
  stage: HTMLElement,
  visible: boolean,
): () => void {
  placements.get(tabId)?.observer?.disconnect()
  const token = {}
  const observer = typeof ResizeObserver === 'undefined'
    ? null
    : new ResizeObserver(() => applyPlacement(tabId))
  observer?.observe(stage)
  placements.set(tabId, { token, stage, visible, observer })
  applyPlacement(tabId)
  return () => {
    const placement = placements.get(tabId)
    if (placement?.token !== token) return
    placement.observer?.disconnect()
    placements.delete(tabId)
    applyPlacement(tabId)
  }
}

/** Ends the page: removing its element destroys the guest. */
export function disposeWorkspaceBrowserGuest(tabId: string): void {
  const record = guests.get(tabId)
  if (record) dispose(record)
  placements.get(tabId)?.observer?.disconnect()
  placements.delete(tabId)
}

/** The host reported the guest gone; forget it so a retry builds a new one. */
export function forgetLostWorkspaceBrowserGuest(tabId: string): void {
  const record = guests.get(tabId)
  if (record) dispose(record)
}

function createGuest(tabId: string): GuestRecord {
  const slot = document.createElement('div')
  slot.dataset.workspaceBrowserSlot = tabId
  Object.assign(slot.style, {
    position: 'absolute',
    left: '0px',
    top: '0px',
    width: '0px',
    height: '0px',
    overflow: 'hidden',
    visibility: 'hidden',
    pointerEvents: 'none',
  })
  const webview = document.createElement('webview') as WebviewElement
  // Attributes the host's attach policy requires; it denies anything else.
  webview.setAttribute('partition', WORKSPACE_BROWSER_PARTITION)
  // Without it Chromium blocks `window.open` and `target=_blank` before the
  // host's popup handler can turn them into tabs. The host still denies them.
  webview.setAttribute('allowpopups', '')
  webview.setAttribute('src', WORKSPACE_BROWSER_INITIAL_SRC)
  Object.assign(webview.style, { display: 'flex', width: '100%', height: '100%', border: '0' })
  slot.appendChild(webview)
  const record: GuestRecord = {
    tabId,
    slot,
    webview,
    webContentsId: null,
    attach: null,
    registration: null,
    registered: false,
  }
  guests.set(tabId, record)
  return record
}

function attachGuest(record: GuestRecord): Promise<number> {
  if (record.webContentsId !== null) return Promise.resolve(record.webContentsId)
  if (record.attach) return record.attach
  record.attach = waitForLayer().then(target => new Promise<number>((resolve, reject) => {
    if (guests.get(record.tabId) !== record) {
      reject(new Error('Browser page was closed before it attached'))
      return
    }
    const timer = setTimeout(() => {
      record.webview.removeEventListener('dom-ready', onReady)
      reject(new Error('Browser page failed to attach'))
    }, ATTACH_TIMEOUT_MS)
    // Only now is a guest id readable; `did-attach` fires too early for it.
    // `dom-ready` repeats on every navigation, so take the first one only.
    function onReady() {
      clearTimeout(timer)
      record.webview.removeEventListener('dom-ready', onReady)
      try {
        const id = record.webview.getWebContentsId()
        record.webContentsId = id
        resolve(id)
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    }
    record.webview.addEventListener('dom-ready', onReady)
    target.appendChild(record.slot)
    applyPlacement(record.tabId)
  }))
  return record.attach
}

function waitForLayer(): Promise<HTMLElement> {
  if (layer) return Promise.resolve(layer)
  return new Promise(resolve => { layerWaiters.push(resolve) })
}

function dispose(record: GuestRecord): void {
  record.slot.remove()
  forget(record)
}

function forget(record: GuestRecord): void {
  if (guests.get(record.tabId) === record) guests.delete(record.tabId)
}

function applyAllPlacements(): void {
  for (const tabId of guests.keys()) applyPlacement(tabId)
}

function applyPlacement(tabId: string): void {
  const record = guests.get(tabId)
  if (!record) return
  const placement = placements.get(tabId)
  if (!placement || !layer || !placement.stage.isConnected) {
    // Parked pages keep their last size, so hiding never reflows the page.
    setShown(record, false)
    return
  }
  const stage = placement.stage.getBoundingClientRect()
  const origin = layer.getBoundingClientRect()
  const ratio = window.devicePixelRatio || 1
  // Whole device pixels keep text crisp, as the native view's bounds did.
  const snap = (value: number) => Math.round(value * ratio) / ratio
  Object.assign(record.slot.style, {
    left: `${snap(stage.left - origin.left)}px`,
    top: `${snap(stage.top - origin.top)}px`,
    width: `${snap(stage.width)}px`,
    height: `${snap(stage.height)}px`,
  })
  setShown(record, placement.visible && stage.width > 0 && stage.height > 0)
}

function setShown(record: GuestRecord, shown: boolean): void {
  record.slot.style.visibility = shown ? 'visible' : 'hidden'
  record.slot.dataset.shown = shown ? 'true' : 'false'
  record.slot.style.pointerEvents = shown && !gesture ? 'auto' : 'none'
}

/**
 * A pointer gesture that starts in the app (dragging a resize handle, a tab,
 * a text selection) must keep receiving its moves and its release when the
 * pointer crosses a page: a guest otherwise takes them, and the drag stalls
 * with its button still "held". Pages ignore the pointer until it ends.
 * A gesture that starts inside a page is never seen here, so pages keep it.
 */
function installGestureListeners(): void {
  if (gestureListenersInstalled) return
  gestureListenersInstalled = true
  document.addEventListener('pointerdown', () => setGesture(true), true)
  window.addEventListener('pointerup', () => setGesture(false), true)
  window.addEventListener('pointercancel', () => setGesture(false), true)
  window.addEventListener('blur', () => setGesture(false))
  // A release outside the window never arrives; the next plain move ends it.
  document.addEventListener('pointermove', (event) => {
    if (gesture && event.buttons === 0) setGesture(false)
  }, true)
}

function setGesture(active: boolean): void {
  if (gesture === active) return
  gesture = active
  for (const record of guests.values()) {
    setShown(record, record.slot.dataset.shown === 'true')
  }
}
