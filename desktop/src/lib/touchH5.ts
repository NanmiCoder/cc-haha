/**
 * Touch-H5 runtime marker.
 *
 * The same bundle serves three runtimes: the Electron desktop shell, desktop
 * browsers, and phone browsers reaching the H5 server (WeChat scan, Safari,
 * etc.). Phone WebKit needs a handful of behavior fixes (focus auto-zoom,
 * text-selection vs content-visibility, rubber-band scrolling) that must NOT
 * leak into the desktop runtimes, so instead of scattering UA checks through
 * components we mark `<html data-touch-h5>` once before first paint and scope
 * every mobile-only CSS rule under that attribute (see globals.css).
 *
 * Runs synchronously at module-load time in main.tsx — before React mounts —
 * so it must stay dependency-free (no api client, no stores).
 */

export const TOUCH_H5_ATTRIBUTE = 'data-touch-h5'
export const TOUCH_H5_KEYBOARD_ATTRIBUTE = 'data-touch-h5-keyboard'
export const TOUCH_H5_VIEWPORT_HEIGHT_VAR = '--touch-h5-viewport-height'

/** True when initializeTouchH5 marked this document as a touch-H5 runtime. */
export function isTouchH5Document(
  doc: Document | undefined = typeof document === 'undefined' ? undefined : document,
): boolean {
  return !!doc?.documentElement.hasAttribute(TOUCH_H5_ATTRIBUTE)
}

export type TouchH5Environment = {
  /** Electron preload injects `window.desktopHost`; its absence means browser. */
  hasDesktopHost: boolean
  /** Primary pointer is coarse (touch) — phones/tablets, not touch laptops. */
  coarsePointer: boolean
  maxTouchPoints: number
  userAgent: string
  platform: string
}

type WindowLike = Window & typeof globalThis

export function detectTouchH5Environment(win: WindowLike = window): TouchH5Environment {
  const nav = win.navigator
  let coarsePointer = false
  try {
    coarsePointer = typeof win.matchMedia === 'function' && win.matchMedia('(pointer: coarse)').matches
  } catch {
    coarsePointer = false
  }

  return {
    hasDesktopHost: !!win.desktopHost,
    coarsePointer,
    maxTouchPoints: typeof nav?.maxTouchPoints === 'number' ? nav.maxTouchPoints : 0,
    userAgent: nav?.userAgent ?? '',
    platform: nav?.platform ?? '',
  }
}

export function isTouchH5Environment(env: TouchH5Environment): boolean {
  if (env.hasDesktopHost) return false
  return env.coarsePointer || env.maxTouchPoints > 0
}

/** iPadOS 13+ masquerades as macOS; the touch-point count gives it away. */
export function isIOSEnvironment(env: TouchH5Environment): boolean {
  if (/iPad|iPhone|iPod/.test(env.userAgent)) return true
  return env.platform === 'MacIntel' && env.maxTouchPoints > 1
}

const IOS_VIEWPORT_CONTENT =
  'width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover'

/**
 * iOS WKWebView (Safari and the WeChat in-app browser) zooms the whole page
 * when a focused form control renders below 16px, and never zooms back out.
 * Raising control font sizes (globals.css) fixes the trigger; capping the
 * viewport scale also stops double-tap/pinch zoom from leaving the chat shell
 * in a half-zoomed state. Applied only on iOS — Android has no focus-zoom
 * behavior, so it keeps pinch-zoom accessibility.
 */
function lockIOSViewport(doc: Document) {
  const viewport = doc.querySelector('meta[name="viewport"]')
  if (viewport) {
    viewport.setAttribute('content', IOS_VIEWPORT_CONTENT)
    return
  }

  const meta = doc.createElement('meta')
  meta.setAttribute('name', 'viewport')
  meta.setAttribute('content', IOS_VIEWPORT_CONTENT)
  doc.head.appendChild(meta)
}

/**
 * iOS WKWebView (notoriously the WeChat one) leaves the page scrolled up
 * after the soft keyboard collapses, so the fixed app shell sits half off
 * screen. The body never legitimately scrolls (the shell is 100dvh with
 * inner scroll areas), so snapping back to 0 after an input blurs is safe.
 */
function installIOSKeyboardCollapseFix(win: WindowLike) {
  win.addEventListener('focusout', (event) => {
    const target = event.target
    if (!(target instanceof win.HTMLElement)) return
    if (!/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) && !target.isContentEditable) return

    win.requestAnimationFrame(() => {
      const active = win.document.activeElement
      const refocusedInput =
        active instanceof win.HTMLElement &&
        (/^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName) || active.isContentEditable)
      if (refocusedInput) return
      if (win.scrollX !== 0 || win.scrollY !== 0) {
        win.scrollTo(0, 0)
      }
    })
  })
}

/**
 * Keep the app shell sized to the *visual* viewport.
 *
 * 100dvh tracks browser chrome but NOT the soft keyboard: when the keyboard
 * opens, iOS WebKit leaves the layout viewport tall and pans it upward so the
 * focused field is visible — pushing the header (and part of the transcript)
 * off screen. Publishing visualViewport.height as a CSS variable lets the
 * shell shrink to the visible area instead (globals.css), so the composer sits
 * right above the keyboard with the transcript still readable. The pan is then
 * redundant and gets snapped back. On browsers that already resize layout for
 * the keyboard (Android Chrome default) the variable simply equals 100dvh.
 */
const KEYBOARD_VISIBLE_MIN_GAP_PX = 80

function installVisualViewportFit(win: WindowLike) {
  const viewport = win.visualViewport
  if (!viewport) return
  const root = win.document.documentElement

  const sync = () => {
    const height = viewport.height
    if (!Number.isFinite(height) || height <= 0) return
    root.style.setProperty(TOUCH_H5_VIEWPORT_HEIGHT_VAR, `${Math.round(height)}px`)

    const keyboardVisible = win.innerHeight - height > KEYBOARD_VISIBLE_MIN_GAP_PX
    root.toggleAttribute(TOUCH_H5_KEYBOARD_ATTRIBUTE, keyboardVisible)

    if (keyboardVisible && (win.scrollX !== 0 || win.scrollY !== 0)) {
      win.scrollTo(0, 0)
    }
  }

  viewport.addEventListener('resize', sync)
  viewport.addEventListener('scroll', sync)
  sync()
}

const windowListenersInstalled = new WeakSet<object>()

/**
 * Mark the document for touch-H5 styling and apply iOS-specific fixes.
 * No-op (and returns false) in the Electron shell and desktop browsers.
 */
export function initializeTouchH5(win: WindowLike | undefined = typeof window === 'undefined' ? undefined : window): boolean {
  if (!win) return false

  const env = detectTouchH5Environment(win)
  if (!isTouchH5Environment(env)) return false

  win.document.documentElement.setAttribute(TOUCH_H5_ATTRIBUTE, 'true')

  const ios = isIOSEnvironment(env)
  if (ios) {
    lockIOSViewport(win.document)
  }

  if (!windowListenersInstalled.has(win)) {
    windowListenersInstalled.add(win)
    installVisualViewportFit(win)
    if (ios) {
      installIOSKeyboardCollapseFix(win)
    }
  }

  return true
}
