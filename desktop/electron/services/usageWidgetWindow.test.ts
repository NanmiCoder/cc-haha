import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  USAGE_WIDGET_CARD_HEIGHT,
  USAGE_WIDGET_CARD_WIDTH,
  USAGE_WIDGET_COMPACT_HEIGHT,
  USAGE_WIDGET_COMPACT_WIDTH,
  USAGE_WIDGET_WINDOW_PARTITION,
  UsageWidgetWindowController,
  clampUsageWidgetPosition,
  readUsageWidgetWindowState,
  usageWidgetWindowOptions,
  writeUsageWidgetWindowState,
} from './usageWidgetWindow'

function createFakeBrowserWindow(initial = { x: 100, y: 80, width: USAGE_WIDGET_CARD_WIDTH, height: USAGE_WIDGET_CARD_HEIGHT }) {
  let bounds = { ...initial }
  let visible = false
  let destroyed = false
  const listeners = new Map<string, Array<() => void>>()
  return {
    getBounds: vi.fn(() => ({ ...bounds })),
    setBounds: vi.fn((next: typeof bounds) => { bounds = { ...next } }),
    setPosition: vi.fn((x: number, y: number) => { bounds = { ...bounds, x, y } }),
    setAlwaysOnTop: vi.fn(),
    setVisibleOnAllWorkspaces: vi.fn(),
    isVisible: vi.fn(() => visible),
    isDestroyed: vi.fn(() => destroyed),
    show: vi.fn(() => { visible = true }),
    hide: vi.fn(() => { visible = false }),
    focus: vi.fn(),
    on: vi.fn((event: string, fn: () => void) => {
      const list = listeners.get(event) ?? []
      list.push(fn)
      listeners.set(event, list)
    }),
    destroy: vi.fn(() => {
      destroyed = true
      visible = false
      for (const fn of listeners.get('closed') ?? []) fn()
    }),
  }
}

describe('UsageWidgetWindowController', () => {
  it('clamps coordinates inside the display workArea', () => {
    const workArea = { x: 0, y: 24, width: 1440, height: 876 }
    expect(clampUsageWidgetPosition({ x: -100, y: 0 }, workArea, { width: 356, height: 480 })).toEqual({
      x: 0,
      y: 24,
    })
    expect(clampUsageWidgetPosition({ x: 2000, y: 2000 }, workArea, { width: 356, height: 480 })).toEqual({
      x: 1084,
      y: 420,
    })
  })

  it('persists and reloads window position and compact/alwaysOnTop preferences', () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'cc-haha-usage-widget-'))
    try {
      const env = { CLAUDE_CONFIG_DIR: tmp }
      writeUsageWidgetWindowState({ x: 320, y: 40, compact: true, alwaysOnTop: true, snappedTop: true }, env, tmp)
      expect(readUsageWidgetWindowState(env, tmp)).toEqual({
        x: 320,
        y: 40,
        compact: true,
        alwaysOnTop: true,
        snappedTop: true,
      })
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('creates, drags with top-edge snap, resizes compact mode, and disposes cleanly', async () => {
    const fakeWin = createFakeBrowserWindow()
    const workArea = { x: 0, y: 28, width: 1440, height: 872 }
    const visibilityEvents: boolean[] = []
    const writeState = vi.fn()

    const controller = new UsageWidgetWindowController({
      createWindow: vi.fn(() => fakeWin as never),
      getCursorScreenPoint: () => ({ x: 500, y: 200 }),
      getCurrentWorkArea: () => workArea,
      getWorkAreaForPoint: () => workArea,
      preloadPath: '/tmp/preload.cjs',
      platform: 'darwin',
      now: () => 10_000,
      readState: () => null,
      writeState,
      load: vi.fn(async () => {}),
      onVisibilityChanged: (visible) => visibilityEvents.push(visible),
    })

    await controller.show()
    expect(controller.isVisible()).toBe(true)
    expect(fakeWin.setAlwaysOnTop).toHaveBeenCalledWith(true, 'floating')
    expect(visibilityEvents).toEqual([true])

    // Snap to top switches to compact pill centered along workArea.y.
    const snapped = await controller.snapToTop()
    expect(snapped).toEqual({ compact: true, alwaysOnTop: true, snappedTop: true })
    expect(fakeWin.setBounds).toHaveBeenLastCalledWith({
      x: Math.round((1440 - USAGE_WIDGET_COMPACT_WIDTH) / 2),
      y: 28,
      width: USAGE_WIDGET_COMPACT_WIDTH,
      height: USAGE_WIDGET_COMPACT_HEIGHT,
    })

    // Dragging near top edge snaps cleanly to workArea.y.
    controller.dragWindow({ phase: 'start', x: 600, y: 50 })
    const moved = controller.dragWindow({ phase: 'end', x: 650, y: 55 })
    expect(moved.snappedTop).toBe(true)
    expect(writeState).toHaveBeenCalled()

    // Expand back to card dimensions.
    controller.setCompact(false)
    expect(fakeWin.getBounds().width).toBe(USAGE_WIDGET_CARD_WIDTH)
    expect(fakeWin.getBounds().height).toBe(USAGE_WIDGET_CARD_HEIGHT)

    controller.dispose()
    expect(fakeWin.destroy).toHaveBeenCalledTimes(1)
  })

  it('uses an isolated session partition and preserves snappedTop when snapToTop opens a hidden window', async () => {
    const options = usageWidgetWindowOptions({
      preloadPath: '/tmp/usage-widget-preload.cjs',
      position: { x: 100, y: 80 },
      compact: false,
      alwaysOnTop: true,
    })
    expect(options.webPreferences?.partition).toBe(USAGE_WIDGET_WINDOW_PARTITION)

    const fakeWin = createFakeBrowserWindow()
    const workArea = { x: 0, y: 28, width: 1440, height: 872 }
    const writeState = vi.fn()
    const controller = new UsageWidgetWindowController({
      createWindow: vi.fn(() => fakeWin as never),
      getCursorScreenPoint: () => ({ x: 500, y: 200 }),
      getCurrentWorkArea: () => workArea,
      getWorkAreaForPoint: () => workArea,
      preloadPath: '/tmp/usage-widget-preload.cjs',
      platform: 'darwin',
      readState: () => ({ x: 100, y: 200, compact: false, alwaysOnTop: false, snappedTop: false }),
      writeState,
      load: vi.fn(async () => {}),
    })

    // Calling snapToTop while hidden must not let show() overwrite snappedTop=true with saved snappedTop=false.
    const state = await controller.snapToTop()
    expect(state).toEqual({ compact: true, alwaysOnTop: true, snappedTop: true })
    expect(writeState).toHaveBeenLastCalledWith(expect.objectContaining({
      compact: true,
      alwaysOnTop: true,
      snappedTop: true,
    }))
    controller.dispose()
  })
})
