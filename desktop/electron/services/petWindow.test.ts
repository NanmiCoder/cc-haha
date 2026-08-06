import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  PET_WINDOW_HEIGHT,
  PET_WINDOW_WIDTH,
  PetWindowController,
  type PetWindowPosition,
  clampPetWindowPosition,
  getPetWindowBounds,
  petPanelBounds,
  petWindowStatePath,
  petWindowOptions,
  readPetWindowPosition,
  resolvePetPanelPlacement,
  writePetWindowPosition,
} from './petWindow'

const desktopRoot = existsSync(path.resolve(process.cwd(), 'electron', 'main.ts'))
  ? process.cwd()
  : path.resolve(process.cwd(), 'desktop')
const mainSource = readFileSync(path.join(desktopRoot, 'electron', 'main.ts'), 'utf8')
  .replace(/\r\n/g, '\n')

type FakeWindowOptions = {
  /**
   * Display scale factor. Chromium converts window rects between physical
   * pixels and DIP with ceil in *both* directions (ScreenWin::ScreenToDIPRect
   * and DIPToScreenRect), so on a fractional scale every getBounds ->
   * setBounds round trip grows the window by a pixel. Modelling that is what
   * makes the size-neutrality assertions mean anything; the default of 1 keeps
   * the arithmetic exact for every test that does not care.
   */
  scaleFactor?: number
  /**
   * Client area, when it differs from the window box. Renderer regions are
   * measured against this, not against getBounds().
   */
  contentSize?: { width: number; height: number }
  /** Drop getContentBounds entirely, to exercise the fallback. */
  withoutContentBounds?: boolean
  /**
   * Work area top edge, when the platform constrains the window to it.
   *
   * macOS runs a *visible* window's frame through
   * -[NSWindow constrainFrameRect:toScreen:], which rewrites any y above the
   * work area back down to that edge — so the negative y the mascot clamp asks
   * for is silently refused and the mascot strands a padding-height below the
   * menu bar. A fake window that accepts every y proves nothing about the top
   * edge, which is why the bug survived a green suite. Left undefined the fake
   * behaves like Windows and Linux, which impose no such limit.
   */
  constrainTopTo?: number
}

function createFakeWindow(
  initialBounds = {
    x: 100,
    y: 100,
    width: PET_WINDOW_WIDTH,
    height: PET_WINDOW_HEIGHT,
  },
  {
    scaleFactor = 1,
    contentSize,
    withoutContentBounds = false,
    constrainTopTo,
  }: FakeWindowOptions = {},
) {
  const handlers = new Map<string, () => void>()
  let visible = false
  let destroyed = false
  let escapesConstraint = false
  const toPhysical = (value: number) => Math.ceil(value * scaleFactor)
  const toDip = (value: number) => Math.ceil(value / scaleFactor)
  let physical = {
    x: initialBounds.x,
    y: initialBounds.y,
    width: toPhysical(initialBounds.width),
    height: toPhysical(initialBounds.height),
  }
  const readBounds = () => ({
    x: physical.x,
    y: physical.y,
    width: toDip(physical.width),
    height: toDip(physical.height),
  })
  // enableLargerThanScreen is the one flag that skips constrainFrameRect, so
  // the constraint has to read it off the constructor options the controller
  // actually passed — otherwise the fake proves the platform's behaviour
  // rather than the fix for it.
  const constrainTop = (y: number) =>
    constrainTopTo !== undefined && visible && !escapesConstraint
      ? Math.max(y, constrainTopTo)
      : y
  const setBounds = vi.fn((next: Partial<typeof physical>) => {
    const merged = { ...readBounds(), ...next }
    physical = {
      x: merged.x,
      y: constrainTop(merged.y),
      width: toPhysical(merged.width),
      height: toPhysical(merged.height),
    }
  })

  return {
    handlers,
    applyConstructorOptions(options: { enableLargerThanScreen?: boolean }) {
      escapesConstraint = options.enableLargerThanScreen === true
    },
    isDestroyed: vi.fn(() => destroyed),
    isVisible: vi.fn(() => visible),
    // Showing re-runs the constraint, so parking a hidden window above the
    // work area does not survive the reveal.
    showInactive: vi.fn(() => {
      visible = true
      physical = { ...physical, y: constrainTop(physical.y) }
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
    getBounds: vi.fn(readBounds),
    ...(withoutContentBounds ? {} : {
      getContentBounds: vi.fn(() => ({ ...readBounds(), ...contentSize })),
    }),
    setBounds,
    // Electron implements NativeWindow::SetPosition as
    // SetBounds(gfx::Rect(position, GetSize())) — the size makes a lossy round
    // trip through DIP on every call.
    setPosition: vi.fn((x: number, y: number) => {
      const { width, height } = readBounds()
      setBounds({ x, y, width, height })
    }),
    on: vi.fn((event: string, handler: () => void) => {
      handlers.set(event, handler)
    }),
  }
}

// Dragging moves the window with setBounds so the size is restated every tick.
function lastDragBounds(window: ReturnType<typeof createFakeWindow>) {
  return window.setBounds.mock.calls.at(-1)?.[0]
}

function draggedTo(position: PetWindowPosition) {
  return { ...position, width: PET_WINDOW_WIDTH, height: PET_WINDOW_HEIGHT }
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

  it('persists the mascot box with the position and tolerates state without one', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'cc-haha-pet-region-'))
    const env = { CLAUDE_CONFIG_DIR: path.join(root, 'portable') }
    try {
      writePetWindowPosition(
        { x: 100, y: -215, region: { x: 136.4, y: 240.2, width: 112, height: 128 } },
        env,
        root,
      )
      expect(readPetWindowPosition(env, root)).toEqual({
        x: 100,
        y: -215,
        region: { x: 136, y: 240, width: 112, height: 128 },
      })

      // State written before the region was persisted still restores.
      writePetWindowPosition({ x: 12, y: 34 }, env, root)
      expect(readPetWindowPosition(env, root)).toEqual({ x: 12, y: 34 })

      // An empty box would clamp as if the mascot filled nothing, so it is
      // dropped rather than trusted.
      writePetWindowPosition(
        { x: 12, y: 34, region: { x: 0, y: 0, width: 0, height: 10 } },
        env,
        root,
      )
      expect(readPetWindowPosition(env, root)).toEqual({ x: 12, y: 34 })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('reopens a saved edge position where the drag actually left it', () => {
    const workArea = { x: 0, y: 25, width: 800, height: 575 }
    const region = { x: 136, y: 240, width: 112, height: 128 }
    const saved = { x: 100, y: workArea.y - region.y, region }

    expect(getPetWindowBounds(workArea, saved).y).toBe(saved.y)
    // The same position without the box clamps against the whole window and
    // opens a padding-height lower — the jump the renderer used to correct
    // once it reported the live region.
    expect(getPetWindowBounds(workArea, { x: saved.x, y: saved.y }).y).toBe(workArea.y)
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
      // Without this macOS refuses every y above the work area, so the mascot
      // can never be dragged up to the menu bar: the transparent padding above
      // it has to be allowed off-screen.
      enableLargerThanScreen: true,
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
    // Documented macOS-only; Windows and Linux never constrain the frame.
    expect(windowsOptions).not.toHaveProperty('enableLargerThanScreen')
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

  it('lets only the owned pet window focus the main desktop window', () => {
    expect(mainSource).toContain(
      'registerHandler(ELECTRON_IPC_CHANNELS.petsFocusMainWindow, (event)',
    )
    expect(mainSource).toContain(
      'if (!getPetWindowController().owns(currentWindow(event)))',
    )
    expect(mainSource).toContain('showMainWindow(mainWindow, app)')
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
    expect(lastDragBounds(petWindow)).toEqual(draggedTo({ x: 140, y: 160 }))

    controller.dragWindow(petWindow as never, { phase: 'end', x: 1_000, y: 900 })
    expect(getWorkAreaForPoint).toHaveBeenLastCalledWith({ x: 1_000, y: 900 })
    expect(lastDragBounds(petWindow)).toEqual(draggedTo({
      x: 800 - PET_WINDOW_WIDTH,
      y: 25 + 575 - PET_WINDOW_HEIGHT,
    }))
    expect(writePosition).toHaveBeenCalledOnce()
    expect(writePosition).toHaveBeenCalledWith({
      x: 800 - PET_WINDOW_WIDTH,
      y: 25 + 575 - PET_WINDOW_HEIGHT,
    })
  })

  it.each([
    ['darwin', 'left', { x: -100, y: 220 }, { x: -136, y: 160 }],
    ['darwin', 'right', { x: 1_000, y: 220 }, { x: 552, y: 160 }],
    ['darwin', 'top', { x: 150, y: -200 }, { x: 100, y: -215 }],
    ['darwin', 'bottom', { x: 150, y: 900 }, { x: 100, y: 232 }],
    ['win32', 'left', { x: -100, y: 220 }, { x: -136, y: 160 }],
    ['win32', 'right', { x: 1_000, y: 220 }, { x: 552, y: 160 }],
    ['win32', 'top', { x: 150, y: -200 }, { x: 100, y: -215 }],
    ['win32', 'bottom', { x: 150, y: 900 }, { x: 100, y: 232 }],
  ] as const)(
    'lets the %s mascot reach the %s display edge through transparent window padding',
    async (platform, _edge, pointerEnd, expectedPosition) => {
      const petWindow = createFakeWindow({
        x: 100,
        y: 120,
        width: PET_WINDOW_WIDTH,
        height: PET_WINDOW_HEIGHT,
      })
      const controller = new PetWindowController({
        createWindow: vi.fn(() => petWindow) as never,
        getCurrentWorkArea: () => ({ x: 0, y: 25, width: 800, height: 575 }),
        getWorkAreaForPoint: () => ({ x: 0, y: 25, width: 800, height: 575 }),
        load: vi.fn().mockResolvedValue(undefined),
        platform,
        preloadPath: '/app/electron-dist/preload.cjs',
      })
      await controller.show()
      controller.setInteractiveRegions(petWindow as never, [
        { x: 136, y: 240, width: 112, height: 128 },
      ])

      controller.dragWindow(petWindow as never, { phase: 'start', x: 150, y: 180 })
      controller.dragWindow(petWindow as never, { phase: 'end', ...pointerEnd })

      expect(lastDragBounds(petWindow)).toEqual(draggedTo(expectedPosition))
    },
  )

  // The mascot sits at the bottom of a mostly transparent window, so reaching
  // the menu bar means the window's own top edge has to go *above* the work
  // area. macOS refuses that for a visible window unless it opted out, and the
  // refusal is silent — the controller reads back a position it never got.
  const menuBarDrag = {
    workArea: { x: 0, y: 25, width: 800, height: 575 },
    region: { x: 136, y: 240, width: 112, height: 128 },
  }

  async function dragToTopEdge(
    createWindow: (
      window: ReturnType<typeof createFakeWindow>,
      options: { enableLargerThanScreen?: boolean },
    ) => unknown,
  ) {
    const petWindow = createFakeWindow(
      { x: 100, y: 120, width: PET_WINDOW_WIDTH, height: PET_WINDOW_HEIGHT },
      { constrainTopTo: menuBarDrag.workArea.y },
    )
    const writePosition = vi.fn()
    const controller = new PetWindowController({
      createWindow: vi.fn((options: { enableLargerThanScreen?: boolean }) =>
        createWindow(petWindow, options)) as never,
      getCurrentWorkArea: () => menuBarDrag.workArea,
      getWorkAreaForPoint: () => menuBarDrag.workArea,
      load: vi.fn().mockResolvedValue(undefined),
      platform: 'darwin',
      preloadPath: '/app/electron-dist/preload.cjs',
      writePosition,
    })
    await controller.show()
    controller.setInteractiveRegions(petWindow as never, [menuBarDrag.region])
    controller.dragWindow(petWindow as never, { phase: 'start', x: 150, y: 180 })
    controller.dragWindow(petWindow as never, { phase: 'end', x: 150, y: -400 })
    return { petWindow, writePosition }
  }

  it('drags the darwin mascot up to the menu bar through the frame constraint', async () => {
    // The opt-out has to come from the options the controller really built.
    const { petWindow, writePosition } = await dragToTopEdge((window, options) => {
      window.applyConstructorOptions(options)
      return window
    })
    const { region, workArea } = menuBarDrag

    // The window really sits above the work area, so the mascot's own top edge
    // lands on it rather than a padding-height below.
    expect(petWindow.getBounds().y).toBe(workArea.y - region.y)
    expect(petWindow.getBounds().y + region.y).toBe(workArea.y)
    // And what lands on disk is a position the window actually reached, next
    // to the box that makes it mean anything.
    expect(writePosition).toHaveBeenCalledWith({
      x: 100,
      y: workArea.y - region.y,
      region,
    })
  })

  it('strands the mascot below the menu bar when the window keeps the constraint', async () => {
    // Guards the guard: a fake that accepted every y would pass the test above
    // whether or not the window opts out, which is exactly how the real bug
    // survived a green suite.
    const { petWindow } = await dragToTopEdge((window) => {
      window.applyConstructorOptions({ enableLargerThanScreen: false })
      return window
    })
    const { region, workArea } = menuBarDrag

    expect(petWindow.getBounds().y).toBe(workArea.y)
    expect(petWindow.getBounds().y + region.y).toBe(workArea.y + region.y)
  })

  it('clamps dragging against the mascot measured in the real content box', async () => {
    // The renderer measures the mascot against the live viewport, so a content
    // area taller than the nominal height puts the mascot below the constant.
    // Clamping the drag region to the constant would trim the mascot's bottom
    // and stop it short of the work area floor.
    const contentHeight = PET_WINDOW_HEIGHT + 40
    const petWindow = createFakeWindow(
      { x: 100, y: 120, width: PET_WINDOW_WIDTH, height: PET_WINDOW_HEIGHT },
      { contentSize: { width: PET_WINDOW_WIDTH, height: contentHeight } },
    )
    const controller = new PetWindowController({
      createWindow: vi.fn(() => petWindow) as never,
      getCurrentWorkArea: () => ({ x: 0, y: 25, width: 800, height: 575 }),
      getWorkAreaForPoint: () => ({ x: 0, y: 25, width: 800, height: 575 }),
      load: vi.fn().mockResolvedValue(undefined),
      platform: 'win32',
      preloadPath: '/app/electron-dist/preload.cjs',
    })
    await controller.show()
    controller.setInteractiveRegions(petWindow as never, [
      { x: 136, y: contentHeight - 160, width: 112, height: 128 },
    ])

    controller.dragWindow(petWindow as never, { phase: 'start', x: 150, y: 180 })
    controller.dragWindow(petWindow as never, { phase: 'end', x: 150, y: 2_000 })

    expect(lastDragBounds(petWindow)).toEqual({
      x: 100,
      // Mascot bottom (y + 128) lands exactly on the work area floor. Clamping
      // the region to the window box instead of the content box would place it
      // 40px short of the floor.
      y: 25 + 575 - (contentHeight - 160) - 128,
      width: PET_WINDOW_WIDTH,
      height: PET_WINDOW_HEIGHT,
    })
  })

  it.each(['darwin', 'win32', 'linux'] as const)(
    'restores a %s edge position once the renderer reports the mascot region',
    async (platform) => {
      // Dragging clamps against the mascot, so a saved edge position puts the
      // window's transparent padding off-screen. Recreating the window (every
      // hide/show, and every restart) re-clamps that position against the whole
      // window, which walks the mascot inwards by the padding width unless the
      // reported region moves it back.
      let petWindow: ReturnType<typeof createFakeWindow> | undefined
      const createWindow = vi.fn((bounds) => {
        petWindow = createFakeWindow(bounds as {
          x: number
          y: number
          width: number
          height: number
        })
        return petWindow
      })
      const controller = new PetWindowController({
        createWindow: createWindow as never,
        getCurrentWorkArea: () => ({ x: 0, y: 25, width: 800, height: 575 }),
        getWorkAreaForPoint: () => ({ x: 0, y: 25, width: 800, height: 575 }),
        load: vi.fn().mockResolvedValue(undefined),
        platform,
        preloadPath: '/app/electron-dist/preload.cjs',
        readPosition: () => ({ x: -136, y: 160 }),
      })

      await controller.show()
      expect(createWindow).toHaveBeenCalledWith(expect.objectContaining({ x: 0, y: 160 }))
      controller.setInteractiveRegions(petWindow as never, [
        { x: 136, y: 240, width: 112, height: 128 },
      ])

      expect(petWindow?.getBounds()).toEqual({
        x: -136,
        y: 160,
        width: PET_WINDOW_WIDTH,
        height: PET_WINDOW_HEIGHT,
      })
    },
  )

  // Reaching the menu bar puts the window's own top edge above the work area,
  // and the activity panel lives in exactly that strip of the window. The
  // mascot arriving at the edge is the fix working; the panel arriving behind
  // the menu bar with it is the bug (#1140).
  //
  // These boxes are the real layout: the stack is bottom-aligned with 12px of
  // padding, the card sits 12px above the mascot, and the collapse control
  // hangs 31px below the card's own bottom edge.
  const panelDrag = {
    workArea: { x: 0, y: 25, width: 800, height: 575 },
    above: {
      mascot: { x: 136, y: 240, width: 112, height: 128 },
      card: { x: 16, y: 88, width: 352, height: 140 },
      toggle: { x: 172, y: 234, width: 25, height: 25 },
    },
    // What the renderer reports once it has flipped: mascot at the top of the
    // stack, card below it, control on the card's mascot-facing edge.
    below: {
      mascot: { x: 136, y: 12, width: 112, height: 128 },
      card: { x: 16, y: 152, width: 352, height: 140 },
      toggle: { x: 172, y: 121, width: 25, height: 25 },
    },
  }

  function panelController(
    petWindow: ReturnType<typeof createFakeWindow>,
    platform: NodeJS.Platform = 'darwin',
  ) {
    const onPanelPlacementChanged = vi.fn()
    // No cursor sampler, so the drag follows the payload coordinates the way
    // the other edge tests drive it.
    const controller = new PetWindowController({
      createWindow: vi.fn(() => petWindow) as never,
      getCurrentWorkArea: () => panelDrag.workArea,
      getWorkAreaForPoint: () => panelDrag.workArea,
      load: vi.fn().mockResolvedValue(undefined),
      onPanelPlacementChanged,
      platform,
      preloadPath: '/app/electron-dist/preload.cjs',
    })
    return { controller, onPanelPlacementChanged }
  }

  it('flips the activity panel below the mascot at the menu bar and holds the mascot there', async () => {
    const petWindow = createFakeWindow(
      { x: 100, y: 120, width: PET_WINDOW_WIDTH, height: PET_WINDOW_HEIGHT },
      { constrainTopTo: panelDrag.workArea.y },
    )
    const { controller, onPanelPlacementChanged } = panelController(petWindow)
    await controller.show()
    petWindow.applyConstructorOptions({ enableLargerThanScreen: true })

    const { above, below, workArea } = panelDrag
    // Away from the top edge the panel keeps its usual place above the mascot.
    expect(controller.setInteractiveRegions(petWindow as never, [
      above.mascot,
      above.card,
      above.toggle,
    ])).toEqual({ vertical: 'above', horizontal: 'center' })

    controller.dragWindow(petWindow as never, { phase: 'start', x: 150, y: 180 })
    const dragged = controller.dragWindow(petWindow as never, { phase: 'end', x: 150, y: -400 })

    // The mascot still reaches the menu bar, which is the behaviour this must
    // not regress: the window top is above the work area.
    expect(petWindow.getBounds().y).toBe(workArea.y - above.mascot.y)
    // The panel would be behind the menu bar there, so it has to change sides.
    expect(petWindow.getBounds().y + above.card.y).toBeLessThan(workArea.y)
    expect(dragged).toEqual({ vertical: 'below', horizontal: 'center' })
    expect(onPanelPlacementChanged).toHaveBeenCalledWith(petWindow, {
      vertical: 'below',
      horizontal: 'center',
    })

    // The renderer re-lays out and reports the flipped boxes.
    expect(controller.setInteractiveRegions(petWindow as never, [
      below.mascot,
      below.card,
      below.toggle,
    ])).toEqual({ vertical: 'below', horizontal: 'center' })

    // Flipping moved the mascot up inside the window, so the window has to drop
    // by the same amount: the mascot stays on the menu bar rather than jumping
    // a panel-height down the screen.
    expect(petWindow.getBounds().y + below.mascot.y).toBe(workArea.y)
    // And the whole panel is now inside the work area.
    expect(petWindow.getBounds().y + below.toggle.y).toBeGreaterThanOrEqual(workArea.y)
  })

  it.each([
    {
      edge: 'right',
      pointerEndX: 2_000,
      horizontal: 'left' as const,
      shiftedMascotX: 260,
    },
    {
      edge: 'left',
      pointerEndX: -2_000,
      horizontal: 'right' as const,
      shiftedMascotX: 12,
    },
  ])('keeps the Windows task panel visible at the $edge edge without moving the mascot', async ({
    pointerEndX,
    horizontal,
    shiftedMascotX,
  }) => {
    const petWindow = createFakeWindow({
      x: 100,
      y: 120,
      width: PET_WINDOW_WIDTH,
      height: PET_WINDOW_HEIGHT,
    })
    const { controller, onPanelPlacementChanged } = panelController(petWindow, 'win32')
    await controller.show()

    const { above, workArea } = panelDrag
    controller.setInteractiveRegions(petWindow as never, [
      above.mascot,
      above.card,
      above.toggle,
    ])
    controller.dragWindow(petWindow as never, { phase: 'start', x: 150, y: 180 })
    const dragged = controller.dragWindow(petWindow as never, {
      phase: 'end',
      x: pointerEndX,
      y: 180,
    })
    const mascotScreenX = petWindow.getBounds().x + above.mascot.x

    expect(dragged).toEqual({ vertical: 'above', horizontal })
    expect(onPanelPlacementChanged).toHaveBeenCalledWith(petWindow, {
      vertical: 'above',
      horizontal,
    })

    // The renderer keeps the card centred in the fixed window and moves the
    // mascot to the outside. The host absorbs that internal shift by moving
    // the whole window in the opposite direction.
    const shiftedMascot = { ...above.mascot, x: shiftedMascotX }
    expect(controller.setInteractiveRegions(petWindow as never, [
      shiftedMascot,
      above.card,
      above.toggle,
    ])).toEqual({ vertical: 'above', horizontal })

    const shiftedBounds = petWindow.getBounds()
    expect(shiftedBounds.x + shiftedMascot.x).toBe(mascotScreenX)
    expect(shiftedBounds.x + above.card.x).toBeGreaterThanOrEqual(workArea.x)
    expect(shiftedBounds.x + above.card.x + above.card.width)
      .toBeLessThanOrEqual(workArea.x + workArea.width)

    onPanelPlacementChanged.mockClear()
    controller.setInteractiveRegions(petWindow as never, [
      shiftedMascot,
      above.card,
      above.toggle,
    ])
    expect(onPanelPlacementChanged).not.toHaveBeenCalled()
  })

  it('holds the mascot still through a flip that happens short of the menu bar', async () => {
    // The panel runs out of room before the mascot reaches the edge, so most
    // flips happen mid-screen where the clamp has nothing to say. Without the
    // window absorbing the flip, the mascot snaps up to the work area top —
    // the whole panel height away from where the pointer left it.
    const petWindow = createFakeWindow(
      { x: 100, y: 120, width: PET_WINDOW_WIDTH, height: PET_WINDOW_HEIGHT },
      { constrainTopTo: panelDrag.workArea.y },
    )
    const { controller } = panelController(petWindow)
    await controller.show()
    petWindow.applyConstructorOptions({ enableLargerThanScreen: true })

    const { above, below, workArea } = panelDrag
    controller.setInteractiveRegions(petWindow as never, [above.mascot, above.card, above.toggle])

    // Land the mascot 100px under the menu bar: clear of every clamp, but short
    // of the ~183px the panel needs above it.
    controller.dragWindow(petWindow as never, { phase: 'start', x: 150, y: 180 })
    const dragged = controller.dragWindow(petWindow as never, { phase: 'end', x: 150, y: -55 })
    const mascotScreenY = petWindow.getBounds().y + above.mascot.y
    expect(mascotScreenY).toBe(workArea.y + 100)
    expect(dragged).toEqual({ vertical: 'below', horizontal: 'center' })

    controller.setInteractiveRegions(petWindow as never, [below.mascot, below.card, below.toggle])

    expect(petWindow.getBounds().y + below.mascot.y).toBe(mascotScreenY)
    expect(petWindow.getBounds().y + below.toggle.y).toBeGreaterThanOrEqual(workArea.y)
  })

  it('keeps a drag tracking the pointer after the panel flips mid-drag', async () => {
    vi.useFakeTimers()
    try {
      const petWindow = createFakeWindow(
        { x: 100, y: 120, width: PET_WINDOW_WIDTH, height: PET_WINDOW_HEIGHT },
        { constrainTopTo: panelDrag.workArea.y },
      )
      let cursor = { x: 150, y: 180 }
      const onPanelPlacementChanged = vi.fn()
      const controller = new PetWindowController({
        createWindow: vi.fn(() => petWindow) as never,
        getCursorScreenPoint: () => cursor,
        getCurrentWorkArea: () => panelDrag.workArea,
        getWorkAreaForPoint: () => panelDrag.workArea,
        load: vi.fn().mockResolvedValue(undefined),
        onPanelPlacementChanged,
        platform: 'darwin',
        preloadPath: '/app/electron-dist/preload.cjs',
      })
      await controller.show()
      petWindow.applyConstructorOptions({ enableLargerThanScreen: true })

      const { above, below, workArea } = panelDrag
      controller.setInteractiveRegions(petWindow as never, [above.mascot, above.card, above.toggle])
      controller.dragWindow(petWindow as never, { phase: 'start', x: 150, y: 180 })

      // The renderer sends no move payloads — this process samples the cursor —
      // so a flip decided mid-drag has no reply to ride back on and goes out as
      // an event instead.
      cursor = { x: 150, y: -55 }
      vi.advanceTimersByTime(16)
      expect(onPanelPlacementChanged).toHaveBeenCalledWith(petWindow, {
        vertical: 'below',
        horizontal: 'center',
      })

      controller.setInteractiveRegions(petWindow as never, [below.mascot, below.card, below.toggle])
      expect(petWindow.getBounds().y + below.mascot.y).toBe(workArea.y + 100)

      // Dragging 20px further has to move the mascot 20px further. The drag maps
      // pointer travel from a window origin captured before the flip, so unless
      // that origin absorbed the flip too this snaps back.
      cursor = { x: 150, y: -75 }
      vi.advanceTimersByTime(16)
      expect(petWindow.getBounds().y + below.mascot.y).toBe(workArea.y + 80)
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps the flipped panel flipped instead of oscillating on the threshold', async () => {
    const petWindow = createFakeWindow(
      { x: 100, y: 120, width: PET_WINDOW_WIDTH, height: PET_WINDOW_HEIGHT },
      { constrainTopTo: panelDrag.workArea.y },
    )
    const { controller } = panelController(petWindow)
    await controller.show()
    petWindow.applyConstructorOptions({ enableLargerThanScreen: true })

    const { above, below } = panelDrag
    controller.setInteractiveRegions(petWindow as never, [above.mascot, above.card, above.toggle])
    controller.dragWindow(petWindow as never, { phase: 'start', x: 150, y: 180 })
    controller.dragWindow(petWindow as never, { phase: 'end', x: 150, y: -400 })
    controller.setInteractiveRegions(petWindow as never, [below.mascot, below.card, below.toggle])

    // The flip itself frees the space it was testing for: the panel left the
    // strip above the mascot. Re-reporting the flipped layout must not read
    // that as room to flip back, or the panel changes sides every frame.
    expect(controller.setInteractiveRegions(petWindow as never, [
      below.mascot,
      below.card,
      below.toggle,
    ])).toEqual({ vertical: 'below', horizontal: 'center' })
    expect(petWindow.getBounds().y + below.mascot.y).toBe(panelDrag.workArea.y)
  })

  it('reopens a flipped pet where the mascot was, not where the window was', async () => {
    // The saved y belongs to the mascot offset it was saved with, and the panel
    // being below the mascot puts that offset at the top of the window. The
    // renderer always starts the panel above, so restoring the bare window
    // position would drop the mascot by the whole panel height.
    const { above, below, workArea } = panelDrag
    const saved = { x: 100, y: workArea.y - below.mascot.y, region: below.mascot }
    let petWindow: ReturnType<typeof createFakeWindow> | undefined
    const controller = new PetWindowController({
      createWindow: vi.fn((bounds) => {
        petWindow = createFakeWindow(
          bounds as { x: number, y: number, width: number, height: number },
          { constrainTopTo: workArea.y },
        )
        petWindow.applyConstructorOptions({ enableLargerThanScreen: true })
        return petWindow
      }) as never,
      getCurrentWorkArea: () => workArea,
      getWorkAreaForPoint: () => workArea,
      load: vi.fn().mockResolvedValue(undefined),
      platform: 'darwin',
      preloadPath: '/app/electron-dist/preload.cjs',
      readPosition: () => saved,
    })

    await controller.show()
    // First paint is the renderer's default layout, panel above the mascot.
    const placement = controller.setInteractiveRegions(petWindow as never, [
      above.mascot,
      above.card,
      above.toggle,
    ])

    expect(petWindow?.getBounds().y).toBe(workArea.y - above.mascot.y)
    expect((petWindow?.getBounds().y ?? 0) + above.mascot.y).toBe(workArea.y)
    // And it is still out of room up there, so it flips straight back.
    expect(placement).toEqual({ vertical: 'below', horizontal: 'center' })
  })

  it('reopens a side-shifted pet where the mascot was, not where the window was', async () => {
    const { above, workArea } = panelDrag
    const shiftedMascot = { ...above.mascot, x: 260 }
    const saved = {
      x: workArea.x + workArea.width - shiftedMascot.x - shiftedMascot.width,
      y: 120,
      region: shiftedMascot,
    }
    let petWindow: ReturnType<typeof createFakeWindow> | undefined
    const controller = new PetWindowController({
      createWindow: vi.fn((bounds) => {
        petWindow = createFakeWindow(
          bounds as { x: number, y: number, width: number, height: number },
        )
        return petWindow
      }) as never,
      getCurrentWorkArea: () => workArea,
      getWorkAreaForPoint: () => workArea,
      load: vi.fn().mockResolvedValue(undefined),
      platform: 'win32',
      preloadPath: '/app/electron-dist/preload.cjs',
      readPosition: () => saved,
    })

    await controller.show()
    const placement = controller.setInteractiveRegions(petWindow as never, [
      above.mascot,
      above.card,
      above.toggle,
    ])

    const bounds = petWindow?.getBounds()
    expect((bounds?.x ?? 0) + above.mascot.x)
      .toBe(saved.x + shiftedMascot.x)
    expect(placement).toEqual({ vertical: 'above', horizontal: 'left' })
  })

  it('leaves the panel above the mascot when only the mascot is reported', async () => {
    // No panel on screen means nothing to protect, and the mascot has to keep
    // its full reach.
    const petWindow = createFakeWindow(
      { x: 100, y: 120, width: PET_WINDOW_WIDTH, height: PET_WINDOW_HEIGHT },
      { constrainTopTo: panelDrag.workArea.y },
    )
    const { controller, onPanelPlacementChanged } = panelController(petWindow)
    await controller.show()
    petWindow.applyConstructorOptions({ enableLargerThanScreen: true })

    controller.setInteractiveRegions(petWindow as never, [panelDrag.above.mascot])
    controller.dragWindow(petWindow as never, { phase: 'start', x: 150, y: 180 })
    const dragged = controller.dragWindow(petWindow as never, { phase: 'end', x: 150, y: -400 })

    expect(dragged).toEqual({ vertical: 'above', horizontal: 'center' })
    expect(onPanelPlacementChanged).not.toHaveBeenCalled()
    expect(petWindow.getBounds().y).toBe(panelDrag.workArea.y - panelDrag.above.mascot.y)
  })

  it('measures the panel against the room above the mascot, not the window', () => {
    const mascot = { x: 136, y: 240, width: 112, height: 128 }
    const panel = { x: 16, y: 88, width: 352, height: 171 }
    const workArea = { x: 0, y: 25, width: 800, height: 575 }
    const above = { vertical: 'above', horizontal: 'center' } as const

    // 335px of room, 183px needed.
    expect(resolvePetPanelPlacement({
      windowPosition: { x: 100, y: 120 },
      workArea,
      mascot,
      panel,
      previous: above,
    })).toEqual({ vertical: 'above', horizontal: 'center' })

    // Mascot on the menu bar: no room at all.
    expect(resolvePetPanelPlacement({
      windowPosition: { x: 100, y: workArea.y - mascot.y },
      workArea,
      mascot,
      panel,
      previous: above,
    })).toEqual({ vertical: 'below', horizontal: 'center' })

    // One pixel short still flips; exactly enough does not.
    expect(resolvePetPanelPlacement({
      windowPosition: { x: 100, y: workArea.y - mascot.y + panel.height + 11 },
      workArea,
      mascot,
      panel,
      previous: above,
    })).toEqual({ vertical: 'below', horizontal: 'center' })
    expect(resolvePetPanelPlacement({
      windowPosition: { x: 100, y: workArea.y - mascot.y + panel.height + 12 },
      workArea,
      mascot,
      panel,
      previous: above,
    })).toEqual({ vertical: 'above', horizontal: 'center' })

    // Coming back the other way costs extra, so a mascot parked on the boundary
    // does not flutter.
    expect(resolvePetPanelPlacement({
      windowPosition: { x: 100, y: workArea.y - mascot.y + panel.height + 12 },
      workArea,
      mascot,
      panel,
      previous: { vertical: 'below', horizontal: 'center' },
    })).toEqual({ vertical: 'below', horizontal: 'center' })
    expect(resolvePetPanelPlacement({
      windowPosition: { x: 100, y: workArea.y - mascot.y + panel.height + 36 },
      workArea,
      mascot,
      panel,
      previous: { vertical: 'below', horizontal: 'center' },
    })).toEqual({ vertical: 'above', horizontal: 'center' })
  })

  it('bounds the panel by everything hanging off the mascot, not just the card', () => {
    // The collapse control overhangs the card, and the badge replaces the card
    // entirely. Taking regions[1] alone would under-measure both.
    expect(petPanelBounds([
      panelDrag.above.mascot,
      panelDrag.above.card,
      panelDrag.above.toggle,
    ])).toEqual({ x: 16, y: 88, width: 352, height: 171 })
    expect(petPanelBounds([panelDrag.above.mascot])).toBeNull()
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

      expect(lastDragBounds(petWindow)).toEqual(draggedTo({ x: 153, y: 167 }))
      expect(writePosition).not.toHaveBeenCalled()

      controller.dragWindow(petWindow as never, { phase: 'end', x: 203, y: 227 })
      expect(writePosition).toHaveBeenCalledOnce()
      expect(writePosition).toHaveBeenCalledWith({ x: 153, y: 167 })
      expect(vi.getTimerCount()).toBe(0)

      const setBoundsCalls = petWindow.setBounds.mock.calls.length
      cursor = { x: 260, y: 280 }
      vi.advanceTimersByTime(32)
      expect(petWindow.setBounds).toHaveBeenCalledTimes(setBoundsCalls)
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
        expect(lastDragBounds(petWindow)).toEqual(draggedTo({ x: 130, y: 140 }))

        if (action === 'hide') controller.hide()
        if (action === 'closed') petWindow.handlers.get('closed')?.()
        if (action === 'dispose') controller.dispose()

        expect(vi.getTimerCount()).toBe(0)
        expect(writePosition).toHaveBeenCalledOnce()
        expect(writePosition).toHaveBeenCalledWith({ x: 130, y: 140 })
        const setBoundsCalls = petWindow.setBounds.mock.calls.length
        cursor = { x: 260, y: 280 }
        vi.advanceTimersByTime(32)
        expect(petWindow.setBounds).toHaveBeenCalledTimes(setBoundsCalls)
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

  it('shapes the Windows pet against the real content size, not the nominal height', async () => {
    // A Windows content area can end up taller than the nominal height (DPI
    // rounding, invisible frame). The mascot sits flush with the viewport
    // bottom, so clamping the shape to the constant would slice its legs off.
    const contentHeight = PET_WINDOW_HEIGHT + 40
    const petWindow = createFakeWindow(
      { x: 100, y: 120, width: PET_WINDOW_WIDTH, height: PET_WINDOW_HEIGHT },
      { contentSize: { width: PET_WINDOW_WIDTH, height: contentHeight } },
    )
    const controller = new PetWindowController({
      createWindow: vi.fn(() => petWindow) as never,
      getCurrentWorkArea: () => ({ x: 0, y: 0, width: 1440, height: 900 }),
      load: vi.fn().mockResolvedValue(undefined),
      platform: 'win32',
      preloadPath: '/app/electron-dist/preload.cjs',
    })

    await controller.show()
    controller.setInteractiveRegions(petWindow as never, [
      { x: 144, y: contentHeight - 114, width: 96, height: 104 },
    ])

    expect(petWindow.setShape).toHaveBeenLastCalledWith([
      { x: 132, y: contentHeight - 126, width: 120, height: 126 },
    ])
  })

  it('shapes every reported region, not just the mascot', async () => {
    // The task badge sits above the mascot and carries its own rect; dropping
    // the tail of the list would make it unclickable.
    const petWindow = createFakeWindow()
    const controller = new PetWindowController({
      createWindow: vi.fn(() => petWindow) as never,
      getCurrentWorkArea: () => ({ x: 0, y: 0, width: 1440, height: 900 }),
      load: vi.fn().mockResolvedValue(undefined),
      platform: 'win32',
      preloadPath: '/app/electron-dist/preload.cjs',
    })

    await controller.show()
    controller.setInteractiveRegions(petWindow as never, [
      { x: 144, y: 280, width: 96, height: 104 },
      { x: 250, y: 40, width: 24, height: 24 },
    ])

    expect(petWindow.setShape).toHaveBeenLastCalledWith([
      { x: 132, y: 268, width: 120, height: 128 },
      { x: 238, y: 28, width: 48, height: 48 },
    ])
  })

  it.each([
    [
      'clamps a region reported past the content box',
      { x: PET_WINDOW_WIDTH + 50, y: PET_WINDOW_HEIGHT + 50, width: 40, height: 40 },
      {
        x: PET_WINDOW_WIDTH - 1,
        y: PET_WINDOW_HEIGHT - 1,
        width: 1,
        height: 1,
      },
    ],
    [
      'keeps a degenerate region at least one pixel wide',
      { x: 100, y: 100, width: 0, height: 0 },
      { x: 88, y: 88, width: 24, height: 24 },
    ],
    [
      'clamps a negative region back into the content box',
      { x: -100, y: -100, width: 40, height: 40 },
      { x: 0, y: 0, width: 1, height: 1 },
    ],
  ] as const)('%s', async (_name, region, expected) => {
    // setShape rejects rectangles outside the window or without positive
    // extent, so normalization has to hold that invariant for any input the
    // renderer can produce.
    const petWindow = createFakeWindow()
    const controller = new PetWindowController({
      createWindow: vi.fn(() => petWindow) as never,
      getCurrentWorkArea: () => ({ x: 0, y: 0, width: 1440, height: 900 }),
      load: vi.fn().mockResolvedValue(undefined),
      platform: 'win32',
      preloadPath: '/app/electron-dist/preload.cjs',
    })

    await controller.show()
    controller.setInteractiveRegions(petWindow as never, [region])

    expect(petWindow.setShape).toHaveBeenLastCalledWith([expected])
  })

  it.each([
    ['getContentBounds is unavailable', { withoutContentBounds: true }],
    ['the content view has no extent yet', {
      contentSize: { width: 0, height: 0 },
    }],
  ] as const)('falls back to the window box when %s', async (_name, options) => {
    // Falling back to the nominal constants would silently reinstate the very
    // clamp this code exists to avoid, so the live window box is the fallback.
    const windowHeight = PET_WINDOW_HEIGHT + 40
    const petWindow = createFakeWindow(
      { x: 100, y: 120, width: PET_WINDOW_WIDTH, height: windowHeight },
      options,
    )
    const controller = new PetWindowController({
      createWindow: vi.fn(() => petWindow) as never,
      getCurrentWorkArea: () => ({ x: 0, y: 0, width: 1440, height: 900 }),
      load: vi.fn().mockResolvedValue(undefined),
      platform: 'win32',
      preloadPath: '/app/electron-dist/preload.cjs',
    })

    await controller.show()
    controller.setInteractiveRegions(petWindow as never, [
      { x: 144, y: windowHeight - 114, width: 96, height: 104 },
    ])

    expect(petWindow.setShape).toHaveBeenLastCalledWith([
      { x: 132, y: windowHeight - 126, width: 120, height: 126 },
    ])
  })

  it('keeps the window size fixed across drag ticks so DIP rounding cannot grow it', async () => {
    vi.useFakeTimers()
    try {
      const petWindow = createFakeWindow(
        { x: 100, y: 120, width: PET_WINDOW_WIDTH, height: PET_WINDOW_HEIGHT },
        { scaleFactor: 1.15 },
      )
      let cursor = { x: 150, y: 180 }
      const controller = new PetWindowController({
        createWindow: vi.fn(() => petWindow) as never,
        getCursorScreenPoint: () => cursor,
        getCurrentWorkArea: () => ({ x: 0, y: 0, width: 1_600, height: 1_000 }),
        getWorkAreaForPoint: () => ({ x: 0, y: 0, width: 1_600, height: 1_000 }),
        load: vi.fn().mockResolvedValue(undefined),
        platform: 'win32',
        preloadPath: '/app/electron-dist/preload.cjs',
      })
      await controller.show()
      // Chromium reports a fractionally scaled window back a pixel larger than
      // it was created; that rounding is the engine's, not ours. What has to
      // hold is that dragging never adds to it.
      const { width, height } = petWindow.getBounds()

      controller.dragWindow(petWindow as never, { phase: 'start', x: 150, y: 180 })
      for (let tick = 0; tick < 60; tick += 1) {
        cursor = { x: cursor.x + 2, y: cursor.y + 2 }
        vi.advanceTimersByTime(16)
      }
      controller.dragWindow(petWindow as never, { phase: 'end', ...cursor })

      // Without a position assertion this test would also pass for a drag tick
      // that moves nothing at all.
      expect(petWindow.getBounds()).toEqual({ x: 220, y: 240, width, height })
    } finally {
      vi.useRealTimers()
    }
  })

  it('stays size-neutral across repeated drags on a fractionally scaled display', async () => {
    // Restating a size that was itself read back through the DIP round trip
    // re-applies the ceil, so the window grows a pixel per drag even though any
    // single drag looks stable. The recorded size has to come from the nominal
    // constants the window was created with.
    vi.useFakeTimers()
    try {
      const petWindow = createFakeWindow(
        { x: 100, y: 120, width: PET_WINDOW_WIDTH, height: PET_WINDOW_HEIGHT },
        { scaleFactor: 1.15 },
      )
      let cursor = { x: 150, y: 180 }
      const controller = new PetWindowController({
        createWindow: vi.fn(() => petWindow) as never,
        getCursorScreenPoint: () => cursor,
        getCurrentWorkArea: () => ({ x: 0, y: 0, width: 1_600, height: 1_000 }),
        getWorkAreaForPoint: () => ({ x: 0, y: 0, width: 1_600, height: 1_000 }),
        load: vi.fn().mockResolvedValue(undefined),
        platform: 'win32',
        preloadPath: '/app/electron-dist/preload.cjs',
      })
      await controller.show()
      const { width, height } = petWindow.getBounds()

      for (let drag = 0; drag < 40; drag += 1) {
        controller.dragWindow(petWindow as never, { phase: 'start', ...cursor })
        cursor = { x: cursor.x + 4, y: cursor.y + 4 }
        vi.advanceTimersByTime(16)
        controller.dragWindow(petWindow as never, { phase: 'end', ...cursor })
      }

      expect(petWindow.getBounds()).toMatchObject({ width, height })
    } finally {
      vi.useRealTimers()
    }
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
