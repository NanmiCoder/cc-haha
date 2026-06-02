import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it, vi } from 'vitest'
import {
  captureWindowState,
  hideWindowSafely,
  hasMeaningfulIntersection,
  installWindowLifecycle,
  isPersistableWindowState,
  isWindowStateVisibleOnAnyDisplay,
  readWindowState,
  restoreWindowMaximized,
  showMainWindow,
  toggleWindowFullScreen,
  windowOptionsFromState,
  windowStatePath,
  writeWindowState,
} from './windows'

const fakeApp = (userData: string) => ({
  getPath: vi.fn(() => userData),
})

describe('Electron window service', () => {
  it('persists window state in CLAUDE_CONFIG_DIR when portable config is active', () => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'electron-window-state-'))
    try {
      const app = fakeApp(path.join(tmp, 'user-data'))
      const state = { x: 10, y: 20, width: 1280, height: 820, maximized: false }

      writeWindowState(app as never, state, { CLAUDE_CONFIG_DIR: tmp })

      const statePath = windowStatePath(app as never, { CLAUDE_CONFIG_DIR: tmp })
      expect(JSON.parse(readFileSync(statePath, 'utf-8'))).toEqual(state)
      expect(app.getPath).not.toHaveBeenCalled()
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('rejects undersized or off-screen state before restore', () => {
    expect(isPersistableWindowState({ x: 0, y: 0, width: 100, height: 100, maximized: false })).toBe(false)
    expect(hasMeaningfulIntersection(
      { x: 5000, y: 5000, width: 1280, height: 820 },
      { x: 0, y: 0, width: 1440, height: 900 },
    )).toBe(false)
    expect(isWindowStateVisibleOnAnyDisplay(
      { x: 100, y: 100, width: 1280, height: 820, maximized: false },
      [{ bounds: { x: 0, y: 0, width: 1440, height: 900 }, workArea: { x: 0, y: 0, width: 1440, height: 860 } }],
    )).toBe(true)
  })

  it('reads only valid visible window state', () => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'electron-window-state-read-'))
    try {
      const app = fakeApp(tmp)
      const state = { x: 50, y: 60, width: 1280, height: 820, maximized: true }
      writeWindowState(app as never, state, {})

      expect(readWindowState(
        app as never,
        [{ bounds: { x: 0, y: 0, width: 1440, height: 900 }, workArea: { x: 0, y: 0, width: 1440, height: 860 } }],
        {},
      )).toEqual(state)
      expect(readWindowState(
        app as never,
        [{ bounds: { x: 3000, y: 3000, width: 1440, height: 900 }, workArea: { x: 3000, y: 3000, width: 1440, height: 860 } }],
        {},
      )).toBeNull()
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('does not capture minimized windows', () => {
    const window = {
      isMinimized: () => true,
      isMaximized: () => false,
      getBounds: () => ({ x: 0, y: 0, width: 1280, height: 820 }),
    }

    expect(captureWindowState(window as never)).toBeNull()
  })

  it('restores persisted bounds and maximized state when reopening the window', () => {
    const state = { x: 12, y: 34, width: 1400, height: 900, maximized: true }
    const maximize = vi.fn()

    expect(windowOptionsFromState(state)).toEqual({
      x: 12,
      y: 34,
      width: 1400,
      height: 900,
    })

    restoreWindowMaximized({ maximize } as never, state)
    expect(maximize).toHaveBeenCalledTimes(1)
  })

  it('shows, restores, and focuses the hidden main window when a tray or notification action reopens it', () => {
    const window = {
      isVisible: () => false,
      isMinimized: () => true,
      show: vi.fn(),
      restore: vi.fn(),
      focus: vi.fn(),
    }

    showMainWindow(window as never)

    expect(window.show).toHaveBeenCalledTimes(1)
    expect(window.restore).toHaveBeenCalledTimes(1)
    expect(window.focus).toHaveBeenCalledTimes(1)
  })

  it('hides instead of closing until the app is explicitly quitting', () => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'electron-window-close-'))
    try {
      const handlers = new Map<string, (...args: never[]) => void>()
      const preventDefault = vi.fn()
      const window = {
        on: vi.fn((event: string, handler: (...args: never[]) => void) => {
          handlers.set(event, handler)
        }),
        hide: vi.fn(),
        isSimpleFullScreen: () => false,
        isFullScreen: () => false,
        isMinimized: () => false,
        isMaximized: () => false,
        getBounds: () => ({ x: 0, y: 0, width: 1280, height: 820 }),
      }

      installWindowLifecycle({
        app: fakeApp(tmp) as never,
        window: window as never,
        shouldQuit: () => false,
      })

      handlers.get('close')?.({ preventDefault } as never)
      expect(preventDefault).toHaveBeenCalledTimes(1)
      expect(window.hide).toHaveBeenCalledTimes(1)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('exits fullscreen before hiding on close to avoid a black macOS fullscreen Space', () => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'electron-window-fullscreen-close-'))
    try {
      const handlers = new Map<string, (...args: never[]) => void>()
      const onceHandlers = new Map<string, (...args: never[]) => void>()
      const preventDefault = vi.fn()
      const window = {
        on: vi.fn((event: string, handler: (...args: never[]) => void) => {
          handlers.set(event, handler)
        }),
        once: vi.fn((event: string, handler: (...args: never[]) => void) => {
          onceHandlers.set(event, handler)
        }),
        hide: vi.fn(),
        setFullScreen: vi.fn(),
        isDestroyed: () => false,
        isSimpleFullScreen: () => false,
        isFullScreen: () => true,
        isMinimized: () => false,
        isMaximized: () => false,
        getBounds: () => ({ x: 0, y: 0, width: 1280, height: 820 }),
      }

      installWindowLifecycle({
        app: fakeApp(tmp) as never,
        window: window as never,
        shouldQuit: () => false,
      })

      handlers.get('close')?.({ preventDefault } as never)
      expect(preventDefault).toHaveBeenCalledTimes(1)
      expect(window.setFullScreen).toHaveBeenCalledWith(false)
      expect(window.hide).not.toHaveBeenCalled()

      onceHandlers.get('leave-full-screen')?.()
      expect(window.hide).toHaveBeenCalledTimes(1)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('runs follow-up hide actions only after fullscreen has been left', () => {
    const onceHandlers = new Map<string, (...args: never[]) => void>()
    const afterHide = vi.fn()
    const window = {
      once: vi.fn((event: string, handler: (...args: never[]) => void) => {
        onceHandlers.set(event, handler)
      }),
      hide: vi.fn(),
      setFullScreen: vi.fn(),
      isDestroyed: () => false,
      isSimpleFullScreen: () => false,
      isFullScreen: () => true,
    }

    hideWindowSafely(window as never, afterHide)

    expect(window.setFullScreen).toHaveBeenCalledWith(false)
    expect(window.hide).not.toHaveBeenCalled()
    expect(afterHide).not.toHaveBeenCalled()

    onceHandlers.get('leave-full-screen')?.()
    expect(window.hide).toHaveBeenCalledTimes(1)
    expect(afterHide).toHaveBeenCalledTimes(1)
  })

  it('hides immediately after leaving simple fullscreen because it does not create a macOS Space', () => {
    const afterHide = vi.fn()
    const window = {
      isSimpleFullScreen: () => true,
      setSimpleFullScreen: vi.fn(),
      hide: vi.fn(),
    }

    hideWindowSafely(window as never, afterHide)

    expect(window.setSimpleFullScreen).toHaveBeenCalledWith(false)
    expect(window.hide).toHaveBeenCalledTimes(1)
    expect(afterHide).toHaveBeenCalledTimes(1)
  })

  it('toggles simple fullscreen on macOS instead of native fullscreen Spaces', () => {
    const window = {
      isSimpleFullScreen: () => false,
      setSimpleFullScreen: vi.fn(),
      isFullScreen: vi.fn(),
      setFullScreen: vi.fn(),
    }

    toggleWindowFullScreen(window as never, 'darwin')

    expect(window.setSimpleFullScreen).toHaveBeenCalledWith(true)
    expect(window.setFullScreen).not.toHaveBeenCalled()
  })

  it('toggles native fullscreen on non-macOS platforms', () => {
    const window = {
      isSimpleFullScreen: vi.fn(),
      setSimpleFullScreen: vi.fn(),
      isFullScreen: () => false,
      setFullScreen: vi.fn(),
    }

    toggleWindowFullScreen(window as never, 'linux')

    expect(window.setFullScreen).toHaveBeenCalledWith(true)
    expect(window.setSimpleFullScreen).not.toHaveBeenCalled()
  })

  it('allows the window to close normally once the app is explicitly quitting', () => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'electron-window-quit-'))
    try {
      const handlers = new Map<string, (...args: never[]) => void>()
      const preventDefault = vi.fn()
      const window = {
        on: vi.fn((event: string, handler: (...args: never[]) => void) => {
          handlers.set(event, handler)
        }),
        hide: vi.fn(),
        isMinimized: () => false,
        isMaximized: () => false,
        getBounds: () => ({ x: 0, y: 0, width: 1280, height: 820 }),
      }

      installWindowLifecycle({
        app: fakeApp(tmp) as never,
        window: window as never,
        shouldQuit: () => true,
      })

      handlers.get('close')?.({ preventDefault } as never)
      expect(preventDefault).not.toHaveBeenCalled()
      expect(window.hide).not.toHaveBeenCalled()
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})
