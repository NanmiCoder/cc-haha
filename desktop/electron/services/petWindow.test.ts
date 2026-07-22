import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  PET_WINDOW_HEIGHT,
  PET_WINDOW_WIDTH,
  PetWindowController,
  clampPetWindowPosition,
  getPetWindowBounds,
  petWindowStatePath,
  petWindowOptions,
  readPetWindowPosition,
  writePetWindowPosition,
} from './petWindow'

const desktopRoot = existsSync(path.resolve(process.cwd(), 'electron', 'main.ts'))
  ? process.cwd()
  : path.resolve(process.cwd(), 'desktop')
const mainSource = readFileSync(path.join(desktopRoot, 'electron', 'main.ts'), 'utf8')
  .replace(/\r\n/g, '\n')

function createFakeWindow(initialBounds = {
  x: 100,
  y: 100,
  width: PET_WINDOW_WIDTH,
  height: PET_WINDOW_HEIGHT,
}) {
  const handlers = new Map<string, () => void>()
  let visible = false
  let destroyed = false
  let bounds = { ...initialBounds }

  return {
    handlers,
    isDestroyed: vi.fn(() => destroyed),
    isVisible: vi.fn(() => visible),
    showInactive: vi.fn(() => {
      visible = true
    }),
    hide: vi.fn(() => {
      visible = false
    }),
    destroy: vi.fn(() => {
      destroyed = true
    }),
    setAlwaysOnTop: vi.fn(),
    setVisibleOnAllWorkspaces: vi.fn(),
    setIgnoreMouseEvents: vi.fn(),
    setShape: vi.fn(),
    getBounds: vi.fn(() => ({ ...bounds })),
    setPosition: vi.fn((x: number, y: number) => {
      bounds = { ...bounds, x, y }
    }),
    on: vi.fn((event: string, handler: () => void) => {
      handlers.set(event, handler)
    }),
  }
}

describe('Electron pet window service', () => {
  it('places fixed companion bounds inside the current display work area', () => {
    expect(getPetWindowBounds({ x: 1440, y: 25, width: 1920, height: 1055 })).toEqual({
      x: 1440 + 1920 - PET_WINDOW_WIDTH - 24,
      y: 25 + 1055 - PET_WINDOW_HEIGHT - 24,
      width: PET_WINDOW_WIDTH,
      height: PET_WINDOW_HEIGHT,
    })
  })

  it('restores and clamps a saved position into its visible display work area', () => {
    const workArea = { x: -900, y: 25, width: 900, height: 700 }
    expect(clampPetWindowPosition({ x: -1_200, y: 900 }, workArea)).toEqual({
      x: -900,
      y: 325,
    })
    expect(getPetWindowBounds(workArea, { x: -1_200, y: 900 })).toEqual({
      x: -900,
      y: 325,
      width: PET_WINDOW_WIDTH,
      height: PET_WINDOW_HEIGHT,
    })
  })

  it('persists position only in the app-owned cc-haha config root', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'cc-haha-pet-position-'))
    const configDir = path.join(root, 'portable')
    const env = {
      CLAUDE_CONFIG_DIR: configDir,
      CODEX_HOME: path.join(root, 'codex-must-not-be-used'),
    }
    try {
      expect(petWindowStatePath(env, root)).toBe(path.join(
        configDir,
        'cc-haha',
        'pet-window.json',
      ))
      writePetWindowPosition({ x: -420.4, y: 85.7 }, env, root)
      expect(readPetWindowPosition(env, root)).toEqual({ x: -420, y: 86 })
      expect(existsSync(path.join(root, 'codex-must-not-be-used'))).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('creates a transparent frameless sandboxed always-on-top window', () => {
    const macOptions = petWindowOptions(
      { x: 20, y: 30, width: PET_WINDOW_WIDTH, height: PET_WINDOW_HEIGHT },
      '/app/electron-dist/preload.cjs',
      'darwin',
    )
    expect(macOptions).toMatchObject({
      x: 20,
      y: 30,
      width: PET_WINDOW_WIDTH,
      height: PET_WINDOW_HEIGHT,
      alwaysOnTop: true,
      backgroundColor: '#00000000',
      frame: false,
      fullscreenable: false,
      hasShadow: false,
      resizable: false,
      show: false,
      transparent: true,
      type: 'panel',
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        partition: 'cc-haha-pet',
        preload: '/app/electron-dist/preload.cjs',
        sandbox: true,
      },
    })
    expect(macOptions).not.toHaveProperty('skipTaskbar')

    const windowsOptions = petWindowOptions(
      { x: 20, y: 30, width: PET_WINDOW_WIDTH, height: PET_WINDOW_HEIGHT },
      '/app/electron-dist/preload.cjs',
      'win32',
    )
    expect(windowsOptions.type).toBeUndefined()
    expect(windowsOptions.skipTaskbar).toBe(true)
  })

  it('loads the dedicated renderer mode with pet-scoped server auth configured', () => {
    expect(mainSource).toContain("loadRendererEntry(window, { petWindow: '1' })")
    expect(mainSource).toContain('window.webContents.session.webRequest')
    expect(mainSource).toContain('resolvePetServerAccess')
    expect(mainSource).toContain('token: runtime.getPetAccessToken()')
  })

  it('validates the exact bounded spritesheet bytes without reopening a path', () => {
    expect(mainSource).toContain('nativeImage.createFromBuffer(data).getSize()')
    expect(mainSource).not.toContain('nativeImage.createFromPath')
  })

  it('focuses the main app before emitting the named session navigation event', () => {
    expect(mainSource).toContain('showMainWindow(mainWindow, app)')
    expect(mainSource).toContain(
      'mainWindow?.webContents.send(ELECTRON_EVENT_CHANNELS.petNavigateSession, sessionId)',
    )
  })

  it('routes the native context menu through the sender-owned pet controller', () => {
    expect(mainSource).toContain(
      'registerHandler(ELECTRON_IPC_CHANNELS.petsShowContextMenu, (event, payload)',
    )
    expect(mainSource).toContain(
      'getPetWindowController().showContextMenu(\n      currentWindow(event),',
    )
    expect(mainSource).toContain('closeLabel.trim(),\n      Menu,')
  })

  it('routes drag coordinates through the sender-owned pet controller', () => {
    expect(mainSource).toContain(
      'getCursorScreenPoint: () => screen.getCursorScreenPoint()',
    )
    expect(mainSource).toContain(
      'registerHandler(ELECTRON_IPC_CHANNELS.petsDragWindow, (event, payload)',
    )
    expect(mainSource).toContain(
      'getPetWindowController().dragWindow(\n      currentWindow(event),',
    )
  })

  it('notifies the main renderer whenever native pet visibility changes', () => {
    expect(mainSource).toContain(
      'mainWindow?.webContents.send(ELECTRON_EVENT_CHANNELS.petVisibilityChanged, true)',
    )
    expect(mainSource).toContain(
      'mainWindow?.webContents.send(ELECTRON_EVENT_CHANNELS.petVisibilityChanged, false)',
    )
  })

  it('creates and loads only one window across concurrent show calls', async () => {
    const window = createFakeWindow()
    const createWindow = vi.fn(() => window)
    let finishLoad: (() => void) | undefined
    const load = vi.fn(() => new Promise<void>((resolve) => {
      finishLoad = resolve
    }))
    const controller = new PetWindowController({
      createWindow: createWindow as never,
      getCurrentWorkArea: () => ({ x: 0, y: 0, width: 1440, height: 900 }),
      load,
      platform: 'darwin',
      preloadPath: '/app/electron-dist/preload.cjs',
    })

    const firstShow = controller.show()
    const secondShow = controller.show()
    finishLoad?.()
    await Promise.all([firstShow, secondShow])

    expect(createWindow).toHaveBeenCalledTimes(1)
    expect(load).toHaveBeenCalledTimes(1)
    expect(window.showInactive).toHaveBeenCalledTimes(1)
    expect(window.setAlwaysOnTop).toHaveBeenCalledWith(true, 'floating')
    expect(window.setVisibleOnAllWorkspaces).toHaveBeenCalledWith(true, {
      skipTransformProcessType: true,
      visibleOnFullScreen: true,
    })
    expect(window.setIgnoreMouseEvents).toHaveBeenCalledWith(true, { forward: true })
  })

  it('restores the saved companion position before creating the window', async () => {
    const window = createFakeWindow()
    const createWindow = vi.fn(() => window)
    const getWorkAreaForPoint = vi.fn(() => ({ x: -900, y: 25, width: 900, height: 700 }))
    const controller = new PetWindowController({
      createWindow: createWindow as never,
      getCurrentWorkArea: () => ({ x: 0, y: 25, width: 1440, height: 875 }),
      getWorkAreaForPoint,
      load: vi.fn().mockResolvedValue(undefined),
      platform: 'darwin',
      preloadPath: '/app/electron-dist/preload.cjs',
      readPosition: () => ({ x: -600, y: 80 }),
    })

    await controller.show()

    expect(getWorkAreaForPoint).toHaveBeenCalledWith({
      x: -600 + Math.floor(PET_WINDOW_WIDTH / 2),
      y: 80 + Math.floor(PET_WINDOW_HEIGHT / 2),
    })
    expect(createWindow).toHaveBeenCalledWith(expect.objectContaining({
      x: -600,
      y: 80,
      width: PET_WINDOW_WIDTH,
      height: PET_WINDOW_HEIGHT,
    }))
  })

  it('keeps the pointer anchor, clamps dragging to the pointer display, and saves on release', async () => {
    const petWindow = createFakeWindow({
      x: 100,
      y: 120,
      width: PET_WINDOW_WIDTH,
      height: PET_WINDOW_HEIGHT,
    })
    const writePosition = vi.fn()
    const getWorkAreaForPoint = vi.fn(() => ({ x: 0, y: 25, width: 800, height: 575 }))
    const controller = new PetWindowController({
      createWindow: vi.fn(() => petWindow) as never,
      getCurrentWorkArea: () => ({ x: 0, y: 25, width: 800, height: 575 }),
      getWorkAreaForPoint,
      load: vi.fn().mockResolvedValue(undefined),
      platform: 'darwin',
      preloadPath: '/app/electron-dist/preload.cjs',
      writePosition,
    })
    await controller.show()

    controller.dragWindow(petWindow as never, { phase: 'start', x: 150, y: 180 })
    controller.dragWindow(petWindow as never, { phase: 'move', x: 190, y: 220 })
    expect(petWindow.setPosition).toHaveBeenLastCalledWith(140, 160, false)

    controller.dragWindow(petWindow as never, { phase: 'end', x: 1_000, y: 900 })
    expect(getWorkAreaForPoint).toHaveBeenLastCalledWith({ x: 1_000, y: 900 })
    expect(petWindow.setPosition).toHaveBeenLastCalledWith(
      800 - PET_WINDOW_WIDTH,
      25 + 575 - PET_WINDOW_HEIGHT,
      false,
    )
    expect(writePosition).toHaveBeenCalledOnce()
    expect(writePosition).toHaveBeenCalledWith({
      x: 800 - PET_WINDOW_WIDTH,
      y: 25 + 575 - PET_WINDOW_HEIGHT,
    })
  })

  it('tracks the native cursor at 60 Hz without renderer move payloads', async () => {
    vi.useFakeTimers()
    try {
      const petWindow = createFakeWindow({
        x: 100,
        y: 120,
        width: PET_WINDOW_WIDTH,
        height: PET_WINDOW_HEIGHT,
      })
      let cursor = { x: 150, y: 180 }
      const writePosition = vi.fn()
      const controller = new PetWindowController({
        createWindow: vi.fn(() => petWindow) as never,
        getCursorScreenPoint: () => cursor,
        getCurrentWorkArea: () => ({ x: 0, y: 25, width: 1_200, height: 775 }),
        getWorkAreaForPoint: () => ({ x: 0, y: 25, width: 1_200, height: 775 }),
        load: vi.fn().mockResolvedValue(undefined),
        platform: 'darwin',
        preloadPath: '/app/electron-dist/preload.cjs',
        writePosition,
      })
      await controller.show()

      controller.dragWindow(petWindow as never, { phase: 'start', x: 150, y: 180 })
      cursor = { x: 203, y: 227 }
      vi.advanceTimersByTime(16)

      expect(petWindow.setPosition).toHaveBeenLastCalledWith(153, 167, false)
      expect(writePosition).not.toHaveBeenCalled()

      controller.dragWindow(petWindow as never, { phase: 'end', x: 203, y: 227 })
      expect(writePosition).toHaveBeenCalledOnce()
      expect(writePosition).toHaveBeenCalledWith({ x: 153, y: 167 })
      expect(vi.getTimerCount()).toBe(0)

      const setPositionCalls = petWindow.setPosition.mock.calls.length
      cursor = { x: 260, y: 280 }
      vi.advanceTimersByTime(32)
      expect(petWindow.setPosition).toHaveBeenCalledTimes(setPositionCalls)
    } finally {
      vi.useRealTimers()
    }
  })

  it.each(['hide', 'closed', 'dispose'] as const)(
    'stops native cursor tracking and persists the final position on %s',
    async (action) => {
      vi.useFakeTimers()
      try {
        const petWindow = createFakeWindow({
          x: 100,
          y: 120,
          width: PET_WINDOW_WIDTH,
          height: PET_WINDOW_HEIGHT,
        })
        let cursor = { x: 150, y: 180 }
        const writePosition = vi.fn()
        const controller = new PetWindowController({
          createWindow: vi.fn(() => petWindow) as never,
          getCursorScreenPoint: () => cursor,
          getCurrentWorkArea: () => ({ x: 0, y: 25, width: 1_200, height: 775 }),
          load: vi.fn().mockResolvedValue(undefined),
          platform: 'darwin',
          preloadPath: '/app/electron-dist/preload.cjs',
          writePosition,
        })
        await controller.show()

        controller.dragWindow(petWindow as never, { phase: 'start', x: 150, y: 180 })
        expect(vi.getTimerCount()).toBe(1)
        cursor = { x: 180, y: 200 }
        vi.advanceTimersByTime(16)
        expect(petWindow.setPosition).toHaveBeenLastCalledWith(130, 140, false)

        if (action === 'hide') controller.hide()
        if (action === 'closed') petWindow.handlers.get('closed')?.()
        if (action === 'dispose') controller.dispose()

        expect(vi.getTimerCount()).toBe(0)
        expect(writePosition).toHaveBeenCalledOnce()
        expect(writePosition).toHaveBeenCalledWith({ x: 130, y: 140 })
        const setPositionCalls = petWindow.setPosition.mock.calls.length
        cursor = { x: 260, y: 280 }
        vi.advanceTimersByTime(32)
        expect(petWindow.setPosition).toHaveBeenCalledTimes(setPositionCalls)
      } finally {
        vi.useRealTimers()
      }
    },
  )

  it('rejects drag coordinates and drag senders outside the owned pet window', async () => {
    const petWindow = createFakeWindow()
    const otherWindow = createFakeWindow()
    const controller = new PetWindowController({
      createWindow: vi.fn(() => petWindow) as never,
      getCurrentWorkArea: () => ({ x: 0, y: 0, width: 1440, height: 900 }),
      load: vi.fn().mockResolvedValue(undefined),
      platform: 'darwin',
      preloadPath: '/app/electron-dist/preload.cjs',
    })
    await controller.show()

    expect(() => controller.dragWindow(otherWindow as never, {
      phase: 'start',
      x: 10,
      y: 10,
    })).toThrow('does not own')
    expect(() => controller.dragWindow(petWindow as never, {
      phase: 'start',
      x: Number.POSITIVE_INFINITY,
      y: 10,
    })).toThrow('finite screen coordinates')
    expect(() => controller.dragWindow(petWindow as never, {
      phase: 'move',
      x: 10,
      y: 10,
    })).toThrow('has not started')
  })

  it('destroys a hidden companion so its renderer releases observers', async () => {
    const firstWindow = createFakeWindow()
    const secondWindow = createFakeWindow()
    const createWindow = vi.fn()
      .mockReturnValueOnce(firstWindow)
      .mockReturnValueOnce(secondWindow)
    const controller = new PetWindowController({
      createWindow: createWindow as never,
      getCurrentWorkArea: () => ({ x: 0, y: 0, width: 1440, height: 900 }),
      load: vi.fn().mockResolvedValue(undefined),
      platform: 'linux',
      preloadPath: '/app/electron-dist/preload.cjs',
    })

    await controller.show()
    controller.hide()
    await controller.show()
    expect(createWindow).toHaveBeenCalledTimes(2)
    expect(firstWindow.destroy).toHaveBeenCalledTimes(1)
    expect(secondWindow.showInactive).toHaveBeenCalledTimes(1)
  })

  it('keeps the shaped Windows pet topmost and rejects IPC from another window', async () => {
    const petWindow = createFakeWindow()
    const otherWindow = createFakeWindow()
    const controller = new PetWindowController({
      createWindow: vi.fn(() => petWindow) as never,
      getCurrentWorkArea: () => ({ x: 0, y: 0, width: 1440, height: 900 }),
      load: vi.fn().mockResolvedValue(undefined),
      platform: 'win32',
      preloadPath: '/app/electron-dist/preload.cjs',
    })

    await controller.show()
    controller.setInteractiveRegions(petWindow as never, [
      { x: 100, y: 220, width: 144, height: 170 },
    ])
    controller.setIgnoreMouseEvents(petWindow as never, true)

    expect(petWindow.setShape).toHaveBeenLastCalledWith([
      { x: 88, y: 208, width: 168, height: 192 },
    ])
    expect(petWindow.setAlwaysOnTop).toHaveBeenCalledWith(true)
    expect(petWindow.setAlwaysOnTop).toHaveBeenLastCalledWith(true)
    expect(petWindow.setIgnoreMouseEvents).toHaveBeenCalledTimes(1)
    expect(() => controller.setInteractiveRegions(otherWindow as never, [
      { x: 0, y: 0, width: 10, height: 10 },
    ])).toThrow('does not own')
  })

  it('returns whether the native pet context menu close item was selected', async () => {
    const petWindow = createFakeWindow()
    const controller = new PetWindowController({
      createWindow: vi.fn(() => petWindow) as never,
      getCurrentWorkArea: () => ({ x: 0, y: 0, width: 1440, height: 900 }),
      load: vi.fn().mockResolvedValue(undefined),
      platform: 'darwin',
      preloadPath: '/app/electron-dist/preload.cjs',
    })
    await controller.show()

    let clickClose: (() => void) | undefined
    let dismissMenu: (() => void) | undefined
    const popup = vi.fn((options: { callback: () => void }) => {
      dismissMenu = options.callback
    })
    const menuFactory = {
      buildFromTemplate: vi.fn((template: Array<{ click?: () => void }>) => {
        clickClose = template[0]?.click
        return { popup }
      }),
    }

    const selection = controller.showContextMenu(
      petWindow as never,
      '关闭宠物',
      menuFactory as never,
    )
    clickClose?.()
    dismissMenu?.()

    await expect(selection).resolves.toBe(true)
    expect(menuFactory.buildFromTemplate).toHaveBeenCalledWith([{
      label: '关闭宠物',
      click: expect.any(Function),
    }])
    expect(popup).toHaveBeenCalledWith({
      window: petWindow,
      callback: expect.any(Function),
    })
  })

  it('returns false when the native pet context menu is dismissed', async () => {
    const petWindow = createFakeWindow()
    const controller = new PetWindowController({
      createWindow: vi.fn(() => petWindow) as never,
      getCurrentWorkArea: () => ({ x: 0, y: 0, width: 1440, height: 900 }),
      load: vi.fn().mockResolvedValue(undefined),
      platform: 'darwin',
      preloadPath: '/app/electron-dist/preload.cjs',
    })
    await controller.show()

    const menuFactory = {
      buildFromTemplate: vi.fn(() => ({
        popup: ({ callback }: { callback: () => void }) => callback(),
      })),
    }

    await expect(controller.showContextMenu(
      petWindow as never,
      'Close pet',
      menuFactory as never,
    )).resolves.toBe(false)
  })

  it('rejects native context menu requests from any non-pet window', async () => {
    const petWindow = createFakeWindow()
    const otherWindow = createFakeWindow()
    const controller = new PetWindowController({
      createWindow: vi.fn(() => petWindow) as never,
      getCurrentWorkArea: () => ({ x: 0, y: 0, width: 1440, height: 900 }),
      load: vi.fn().mockResolvedValue(undefined),
      platform: 'darwin',
      preloadPath: '/app/electron-dist/preload.cjs',
    })
    await controller.show()

    await expect(controller.showContextMenu(
      otherWindow as never,
      'Close pet',
      { buildFromTemplate: vi.fn() } as never,
    )).rejects.toThrow('does not own')
  })

  it('destroys a partially created window when renderer loading fails', async () => {
    const window = createFakeWindow()
    const controller = new PetWindowController({
      createWindow: vi.fn(() => window) as never,
      getCurrentWorkArea: () => ({ x: 0, y: 0, width: 1440, height: 900 }),
      load: vi.fn().mockRejectedValue(new Error('load failed')),
      platform: 'win32',
      preloadPath: '/app/electron-dist/preload.cjs',
    })

    await expect(controller.show()).rejects.toThrow('load failed')
    expect(window.destroy).toHaveBeenCalledTimes(1)
  })
})
