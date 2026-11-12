/** Only when the visible area is this much shorter than the page layout does it count as the soft keyboard being up (the address bar collapsing is only a few dozen pixels). */
const KEYBOARD_MIN_GAP = 80
/** index.html height of #root in it. */
export const VIEWPORT_HEIGHT_VAR = '--cc-viewport-height'

/**
 * Whether the soft keyboard is up in a mobile browser. Browsers fire no keyboard events, so only look at how much shorter the visible area (visualViewport)
 * is than the page layout. Layout height comes from documentElement.clientHeight, which does not change with the keyboard; 
 * iOS 26 Safari when the keyboard pushes the page up window.innerHeight shrinks to the visible height, 
 * comparing against it would conclude "keyboard closed". Visible height must be computed in layout pixels (see visibleHeight).
 */
export function isWebKeyboardOpen(layoutHeight: number, visibleHeight: number) {
  return layoutHeight - visibleHeight > KEYBOARD_MIN_GAP
}

/**
 * How much is visible on screen, in layout pixels. When pinch-zoomed visualViewport.height shrinks by the zoom factor, 
 * but the visible extent on screen does not change, so multiplying back by scale avoids treating zoom as the keyboard opening.
 */
function visibleHeight(viewport: ViewportEvents) {
  return viewport.height * (viewport.scale || 1)
}

type Listener = (open: boolean) => void
type ViewportEvents = {
  height: number
  scale?: number
  addEventListener(type: 'resize' | 'scroll', listener: () => void): void
  removeEventListener(type: 'resize' | 'scroll', listener: () => void): void
}
export type ViewportWindow = {
  visualViewport?: ViewportEvents | null
  document: {
    documentElement: { clientHeight: number; style: { setProperty(name: string, value: string): void } }
    activeElement: Element | null
    getElementById(id: string): Pick<Element, 'contains'> | null
  }
  scrollX: number
  scrollY: number
  scrollTo(x: number, y: number): void
  addEventListener(type: 'scroll', listener: () => void): void
  removeEventListener(type: 'scroll', listener: () => void): void
}

/** Focus is inside the app itself (#root in index.html), not inside a sheet mounted on body. */
function focusedInApp(doc: ViewportWindow['document']) {
  const active = doc.activeElement
  return !!active && !!doc.getElementById('root')?.contains(active)
}

/**
 * Make the app follow the visible area: write the visible height into --cc-viewport-height, and when the soft keyboard opens the whole app
 * shrinks above it. iOS does not shrink the layout viewport but pushes the whole page up to reveal the input — the app is already
 * above the keyboard, so this push only pushes the top and input off screen, so pull back to 0. When the keyboard animation ends
 * iOS it pushes once more, firing only window scroll and no visualViewport event, so both must be listened to.
 * Sheets (react-native-web Modal) mount on body and lay out at full page height without shrinking; 
 * inputs inside them can only be revealed by this iOS push, so do not pull back while focus is there.
 */
export function watchWebViewport(win: ViewportWindow) {
  const viewport = win.visualViewport
  const listeners = new Set<Listener>()
  let open = false
  const sync = () => {
    const height = viewport ? visibleHeight(viewport) : 0
    if (!(height > 0)) return
    const doc = win.document
    // Read the layout height before writing the variable: the other way round forces a relayout on every scroll event.
    const next = isWebKeyboardOpen(doc.documentElement.clientHeight, height)
    doc.documentElement.style.setProperty(VIEWPORT_HEIGHT_VAR, `${Math.round(height)}px`)
    if (next && (win.scrollX !== 0 || win.scrollY !== 0) && focusedInApp(doc)) win.scrollTo(0, 0)
    if (next === open) return
    open = next
    listeners.forEach((listener) => listener(open))
  }
  viewport?.addEventListener('resize', sync)
  viewport?.addEventListener('scroll', sync)
  win.addEventListener('scroll', sync)
  sync()
  return {
    subscribe(listener: Listener) {
      listeners.add(listener)
      listener(open)
      return () => {
        listeners.delete(listener)
      }
    },
    dispose() {
      viewport?.removeEventListener('resize', sync)
      viewport?.removeEventListener('scroll', sync)
      win.removeEventListener('scroll', sync)
      listeners.clear()
    },
  }
}

let page: ReturnType<typeof watchWebViewport> | null = null

/** installed once at web startup (_layout.tsx); later subscriptions share the same one. */
export function installWebViewport() {
  if (!page && typeof window !== 'undefined') page = watchWebViewport(window)
  return page
}

export function subscribeWebKeyboard(onChange: Listener): () => void {
  return installWebViewport()?.subscribe(onChange) ?? (() => {})
}
