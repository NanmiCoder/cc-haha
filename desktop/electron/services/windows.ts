import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { App, BrowserWindow, BrowserWindowConstructorOptions, Display } from 'electron'

export const WINDOW_STATE_FILE = 'window-state.json'
export const DEFAULT_WINDOW_WIDTH = 1280
export const DEFAULT_WINDOW_HEIGHT = 820
export const MIN_WINDOW_WIDTH = 960
export const MIN_WINDOW_HEIGHT = 640
const MIN_VISIBLE_PIXELS = 80
const failedWindowStateWritePaths = new Set<string>()

export type StoredWindowState = {
  x: number
  y: number
  width: number
  height: number
  maximized: boolean
}

export type WindowStateBounds = Pick<StoredWindowState, 'x' | 'y' | 'width' | 'height'>
export type WindowCreateBounds =
  & Partial<Pick<StoredWindowState, 'x' | 'y'>>
  & Pick<StoredWindowState, 'width' | 'height'>
export type WindowChromeOptions = Pick<
  BrowserWindowConstructorOptions,
  'autoHideMenuBar' | 'frame' | 'fullscreenable' | 'titleBarStyle'
>

export function windowStatePath(app: App, env: NodeJS.ProcessEnv = process.env): string {
  return path.join(env.CLAUDE_CONFIG_DIR || path.join(app.getPath('home'), '.claude'), WINDOW_STATE_FILE)
}

export function isPersistableWindowState(state: StoredWindowState): boolean {
  return Number.isFinite(state.x)
    && Number.isFinite(state.y)
    && state.width >= MIN_WINDOW_WIDTH
    && state.height >= MIN_WINDOW_HEIGHT
}

export function hasMeaningfulIntersection(
  state: WindowStateBounds,
  displayBounds: WindowStateBounds,
): boolean {
  const stateRight = state.x + state.width
  const stateBottom = state.y + state.height
  const displayRight = displayBounds.x + displayBounds.width
  const displayBottom = displayBounds.y + displayBounds.height

  return stateRight > displayBounds.x + MIN_VISIBLE_PIXELS
    && stateBottom > displayBounds.y + MIN_VISIBLE_PIXELS
    && state.x < displayRight - MIN_VISIBLE_PIXELS
    && state.y < displayBottom - MIN_VISIBLE_PIXELS
}

export function isWindowStateVisibleOnAnyDisplay(
  state: StoredWindowState,
  displays: Array<Pick<Display, 'bounds' | 'workArea'>>,
): boolean {
  if (displays.length === 0) return true
  return displays.some(display =>
    hasMeaningfulIntersection(state, display.workArea ?? display.bounds),
  )
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

export function clampWindowStateToVisibleWorkArea(
  state: StoredWindowState,
  displays: Array<Pick<Display, 'bounds' | 'workArea'>>,
): StoredWindowState {
  const display = displays.find(candidate =>
    hasMeaningfulIntersection(state, candidate.workArea ?? candidate.bounds),
  )
  if (!display) return state

  const workArea = display.workArea ?? display.bounds
  const maxX = workArea.x + Math.max(0, workArea.width - state.width)
  const maxY = workArea.y + Math.max(0, workArea.height - state.height)

  return {
    ...state,
    x: clamp(state.x, workArea.x, maxX),
    y: clamp(state.y, workArea.y, maxY),
  }
}

export function readWindowState(
  app: App,
  displays: Array<Pick<Display, 'bounds' | 'workArea'>>,
  env: NodeJS.ProcessEnv = process.env,
  platform = process.platform,
): StoredWindowState | null {
  let statePath = windowStatePath(app, env)
  if (!existsSync(statePath) && !env.CLAUDE_CONFIG_DIR) {
    const legacyStatePath = path.join(app.getPath('userData'), WINDOW_STATE_FILE)
    if (existsSync(legacyStatePath)) statePath = legacyStatePath
  }
  if (!existsSync(statePath)) return null

  try {
    const parsed = JSON.parse(readFileSync(statePath, 'utf-8')) as StoredWindowState
    if (!isPersistableWindowState(parsed)) return null
    if (!isWindowStateVisibleOnAnyDisplay(parsed, displays)) return null
    return platform === 'darwin'
      ? clampWindowStateToVisibleWorkArea(parsed, displays)
      : parsed
  } catch (error) {
    console.error(`[desktop] failed to read Electron window state ${statePath}:`, error)
    return null
  }
}

export function writeWindowState(
  app: App,
  state: StoredWindowState,
  env: NodeJS.ProcessEnv = process.env,
) {
  if (!isPersistableWindowState(state)) return
  const statePath = windowStatePath(app, env)
  try {
    mkdirSync(path.dirname(statePath), { recursive: true })
    writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`)
    failedWindowStateWritePaths.delete(statePath)
  } catch (error) {
    if (!failedWindowStateWritePaths.has(statePath)) {
      failedWindowStateWritePaths.add(statePath)
      console.error(`[desktop] failed to write Electron window state ${statePath}:`, error)
    }
  }
}

export function captureWindowState(window: BrowserWindow): StoredWindowState | null {
  // quitAndInstall/quit can emit late move/resize/close events on an already
  // torn-down native window; touching it then throws "Object has been destroyed".
  if (window.isDestroyed()) return null
  if (window.isMinimized()) return null
  const bounds = window.getBounds()
  const state = {
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    maximized: window.isMaximized(),
  }
  return isPersistableWindowState(state) ? state : null
}

export function windowOptionsFromState(state: StoredWindowState | null): WindowCreateBounds {
  return state
    ? { x: state.x, y: state.y, width: state.width, height: state.height }
    : { width: DEFAULT_WINDOW_WIDTH, height: DEFAULT_WINDOW_HEIGHT }
}

export function windowChromeOptionsForPlatform(
  platform: NodeJS.Platform = process.platform,
): WindowChromeOptions {
  if (platform === 'darwin') {
    return {
      titleBarStyle: 'hiddenInset',
      fullscreenable: false,
    }
  }

  if (platform === 'win32') {
    return {
      frame: false,
      autoHideMenuBar: true,
      fullscreenable: true,
    }
  }

  return {
    titleBarStyle: 'default',
    fullscreenable: true,
  }
}

export function restoreWindowMaximized(window: BrowserWindow, state: StoredWindowState | null) {
  if (state?.maximized) window.maximize()
}

export function saveWindowState(app: App, window: BrowserWindow) {
  const state = captureWindowState(window)
  if (state) writeWindowState(app, state)
}

export function hideWindowSafely(window: BrowserWindow, afterHide?: () => void) {
  if (window.isSimpleFullScreen()) {
    window.setSimpleFullScreen(false)
    window.hide()
    afterHide?.()
    return
  }

  if (!window.isFullScreen()) {
    window.hide()
    afterHide?.()
    return
  }

  window.once('leave-full-screen', () => {
    if (!window.isDestroyed()) {
      window.hide()
      afterHide?.()
    }
  })
  window.setFullScreen(false)
}

export function toggleWindowFullScreen(window: BrowserWindow, platform = process.platform) {
  if (platform === 'darwin') {
    window.setSimpleFullScreen(!window.isSimpleFullScreen())
    return
  }
  window.setFullScreen(!window.isFullScreen())
}

type MacOsWindowVisibilityApp = {
  show?: () => void
}

export function showMainWindow(window: BrowserWindow | null, app?: MacOsWindowVisibilityApp) {
  if (!window) return
  app?.show?.()
  if (!window.isVisible()) window.show()
  if (window.isMinimized()) window.restore()
  window.focus()
}

export function refreshWindowsDragHitTest(
  window: BrowserWindow,
  platform: NodeJS.Platform = process.platform,
  delayMs = 100,
): (() => void) | undefined {
  if (platform !== 'win32') return undefined

  const timer = setTimeout(() => {
    if (
      window.isDestroyed()
      || window.isMinimized()
      || window.isMaximized()
      || window.isFullScreen()
    ) {
      return
    }

    const bounds = window.getBounds()
    window.setBounds({ ...bounds, height: bounds.height + 1 })
    window.setBounds(bounds)
  }, delayMs)

  return () => clearTimeout(timer)
}

export function installWindowLifecycle({
  app,
  window,
  shouldQuit,
}: {
  app: App
  window: BrowserWindow
  shouldQuit: () => boolean
}) {
  window.on('close', (event) => {
    saveWindowState(app, window)
    if (shouldQuit()) return
    event.preventDefault()
    hideWindowSafely(window)
  })

  window.on('move', () => saveWindowState(app, window))
  window.on('resize', () => saveWindowState(app, window))
}
