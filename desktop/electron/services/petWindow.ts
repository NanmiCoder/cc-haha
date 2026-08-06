import type {
  BrowserWindow,
  BrowserWindowConstructorOptions,
  Menu,
  MenuItemConstructorOptions,
  Point,
  Rectangle,
} from 'electron'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const PET_WINDOW_WIDTH = 384
export const PET_WINDOW_HEIGHT = 400
export const PET_WINDOW_MARGIN = 24
export const PET_WINDOW_PARTITION = 'cc-haha-pet'
export const PET_WINDOW_STATE_FILE = 'pet-window.json'

const MAX_ABSOLUTE_SCREEN_COORDINATE = 1_000_000
const PET_WINDOW_DRAG_INTERVAL_MS = 16
const PET_WINDOW_SHAPE_PADDING = 12
const failedPetWindowStateWritePaths = new Set<string>()

type PetWindow = BrowserWindow

export type PetContextMenuFactory = {
  buildFromTemplate(template: MenuItemConstructorOptions[]): Pick<Menu, 'popup'>
}

export type PetWindowPosition = Pick<Point, 'x' | 'y'>

/**
 * A saved position deliberately leaves the transparent padding around the
 * mascot off-screen, so it only means anything next to the mascot box it was
 * clamped against. Persisting that box too lets the window reopen where the
 * drag left it; clamping the bare position against the whole window instead
 * lands it a padding-height away, and the renderer then visibly corrects it as
 * soon as it reports the live region.
 */
export type PetWindowState = PetWindowPosition & {
  region?: Rectangle
}

export type PetWindowDragPayload = PetWindowPosition & {
  phase: 'start' | 'move' | 'end'
}

/**
 * Which side of the mascot the renderer should hang the activity panel on.
 *
 * Dragging clamps against the mascot alone so it can reach every display edge
 * through the window's transparent padding, which by construction pushes the
 * rest of the window off-screen. At the top edge that padding is where the
 * panel lives, so it ends up behind the menu bar. Only this process knows the
 * window position and the work area, so it picks the side and the renderer
 * follows.
 *
 * Horizontally the renderer moves the mascot, rather than the wider panel, to
 * the outside of the fixed window. This process then moves the window in the
 * opposite direction to keep the mascot still and bring the panel on-screen.
 */
export type PetPanelPlacement = {
  vertical: 'above' | 'below'
  horizontal: 'center' | 'left' | 'right'
}

export const PET_PANEL_DEFAULT_PLACEMENT: PetPanelPlacement = Object.freeze({
  vertical: 'above',
  horizontal: 'center',
})

/** Gap the renderer keeps between the panel and the mascot. */
const PET_PANEL_GAP = 12

/**
 * Flipping is sticky, because the flip itself moves the window: the panel
 * leaves the space above the mascot, the mascot moves up inside the window, and
 * the window drops by that much to hold the mascot still. A bare "does it fit"
 * test would then find room again and flip straight back, once per frame.
 */
const PET_PANEL_FLIP_HYSTERESIS = 24
const PET_PANEL_HORIZONTAL_HYSTERESIS = 24

function isFiniteScreenCoordinate(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isFinite(value)
    && Math.abs(value) <= MAX_ABSOLUTE_SCREEN_COORDINATE
}

function isPetWindowPosition(value: unknown): value is PetWindowPosition {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return isFiniteScreenCoordinate(record.x) && isFiniteScreenCoordinate(record.y)
}

function isPetWindowRegion(value: unknown): value is Rectangle {
  if (!isPetWindowPosition(value)) return false
  const record = value as Record<string, unknown>
  return isFiniteScreenCoordinate(record.width)
    && isFiniteScreenCoordinate(record.height)
    && record.width > 0
    && record.height > 0
}

function roundPetWindowRegion(region: Rectangle): Rectangle {
  return {
    x: Math.round(region.x),
    y: Math.round(region.y),
    width: Math.round(region.width),
    height: Math.round(region.height),
  }
}

/**
 * Centre of the mascot for the given saved state, used to pick the display the
 * window belongs to. Without a region the window centre is the best guess.
 */
function petWindowAnchor(state: PetWindowState): Point {
  const region = state.region ?? {
    x: 0,
    y: 0,
    width: PET_WINDOW_WIDTH,
    height: PET_WINDOW_HEIGHT,
  }
  return {
    x: state.x + region.x + Math.floor(region.width / 2),
    y: state.y + region.y + Math.floor(region.height / 2),
  }
}

function resolveHomePath(input: string, homeDir: string): string {
  if (input === '~') return homeDir
  if (input.startsWith(`~${path.sep}`) || input.startsWith('~/') || input.startsWith('~\\')) {
    return path.join(homeDir, input.slice(2))
  }
  return input
}

export function petWindowStatePath(
  env: NodeJS.ProcessEnv = process.env,
  homeDir: string = os.homedir(),
): string {
  const normalizedHome = path.resolve(homeDir)
  const configuredRoot = env.CLAUDE_CONFIG_DIR?.trim()
  const configRoot = configuredRoot
    ? path.resolve(resolveHomePath(configuredRoot, normalizedHome))
    : path.join(normalizedHome, '.claude')
  return path.join(configRoot, 'cc-haha', PET_WINDOW_STATE_FILE)
}

export function readPetWindowPosition(
  env: NodeJS.ProcessEnv = process.env,
  homeDir: string = os.homedir(),
): PetWindowState | null {
  const statePath = petWindowStatePath(env, homeDir)
  if (!existsSync(statePath)) return null

  try {
    const parsed = JSON.parse(readFileSync(statePath, 'utf8')) as unknown
    if (!isPetWindowPosition(parsed)) return null
    // State written before the region was persisted still restores, just
    // against the whole window the way it always did.
    const region = (parsed as { region?: unknown }).region
    return {
      x: Math.round(parsed.x),
      y: Math.round(parsed.y),
      ...(isPetWindowRegion(region) ? { region: roundPetWindowRegion(region) } : {}),
    }
  } catch (error) {
    console.error(`[desktop] failed to read pet window state ${statePath}:`, error)
    return null
  }
}

export function writePetWindowPosition(
  state: PetWindowState,
  env: NodeJS.ProcessEnv = process.env,
  homeDir: string = os.homedir(),
): void {
  if (!isPetWindowPosition(state)) return
  const statePath = petWindowStatePath(env, homeDir)
  const temporaryPath = `${statePath}.${process.pid}.tmp`
  try {
    mkdirSync(path.dirname(statePath), { recursive: true, mode: 0o700 })
    writeFileSync(temporaryPath, `${JSON.stringify({
      x: Math.round(state.x),
      y: Math.round(state.y),
      ...(isPetWindowRegion(state.region)
        ? { region: roundPetWindowRegion(state.region) }
        : {}),
    }, null, 2)}\n`, { mode: 0o600 })
    renameSync(temporaryPath, statePath)
    failedPetWindowStateWritePaths.delete(statePath)
  } catch (error) {
    rmSync(temporaryPath, { force: true })
    if (!failedPetWindowStateWritePaths.has(statePath)) {
      failedPetWindowStateWritePaths.add(statePath)
      console.error(`[desktop] failed to write pet window state ${statePath}:`, error)
    }
  }
}

export function clampPetWindowPosition(
  position: PetWindowPosition,
  workArea: Rectangle,
  visibleRegion: Rectangle = {
    x: 0,
    y: 0,
    width: PET_WINDOW_WIDTH,
    height: PET_WINDOW_HEIGHT,
  },
): PetWindowPosition {
  const minX = workArea.x - visibleRegion.x
  const minY = workArea.y - visibleRegion.y
  const maxX = minX + Math.max(0, workArea.width - visibleRegion.width)
  const maxY = minY + Math.max(0, workArea.height - visibleRegion.height)
  return {
    x: Math.min(Math.max(Math.round(position.x), minX), maxX),
    y: Math.min(Math.max(Math.round(position.y), minY), maxY),
  }
}

/**
 * Bounding box of everything the renderer hangs off the mascot — the activity
 * card, its collapse control, the task badge.
 *
 * The first region is the mascot itself: it is the drag anchor, so it is the
 * one box that is *meant* to sit flush against a display edge. Everything after
 * it has to stay on-screen to be readable, which is what this box represents.
 */
export function petPanelBounds(regions: Rectangle[]): Rectangle | null {
  const attachments = regions.slice(1)
  if (attachments.length === 0) return null
  const left = Math.min(...attachments.map((region) => region.x))
  const top = Math.min(...attachments.map((region) => region.y))
  const right = Math.max(...attachments.map((region) => region.x + region.width))
  const bottom = Math.max(...attachments.map((region) => region.y + region.height))
  return { x: left, y: top, width: right - left, height: bottom - top }
}

/**
 * The measurement is deliberately placement-independent: the panel's *height*
 * is the same on either side of the mascot, and the mascot's screen position is
 * held across a flip, so both sides of the comparison survive the flip they
 * decide. Comparing against how much room the panel currently occupies above
 * the mascot would instead be self-referential and oscillate.
 */
export function resolvePetPanelPlacement({
  windowPosition,
  workArea,
  mascot,
  panel,
  previous,
}: {
  windowPosition: PetWindowPosition
  workArea: Rectangle
  mascot: Rectangle
  panel: Rectangle | null
  previous: PetPanelPlacement
}): PetPanelPlacement {
  if (!panel) return PET_PANEL_DEFAULT_PLACEMENT

  const required = panel.height + PET_PANEL_GAP
  const spaceAbove = windowPosition.y + mascot.y - workArea.y
  const threshold = previous.vertical === 'above'
    ? required
    : required + PET_PANEL_FLIP_HYSTERESIS
  const vertical = spaceAbove >= threshold ? 'above' : 'below'

  const workAreaRight = workArea.x + workArea.width
  const mascotScreenLeft = windowPosition.x + mascot.x
  const mascotScreenRight = mascotScreenLeft + mascot.width
  const mascotScreenCenter = mascotScreenLeft + mascot.width / 2
  const centeredPanelLeft = mascotScreenCenter - panel.width / 2
  const centeredPanelRight = mascotScreenCenter + panel.width / 2
  const centeredFits = centeredPanelLeft >= workArea.x
    && centeredPanelRight <= workAreaRight
  let horizontal = previous.horizontal

  if (previous.horizontal === 'center') {
    if (centeredPanelLeft < workArea.x) horizontal = 'right'
    else if (centeredPanelRight > workAreaRight) horizontal = 'left'
  } else if (previous.horizontal === 'left') {
    const leftAlignedFits = mascotScreenRight - panel.width >= workArea.x
    const rightAlignedFits = mascotScreenLeft + panel.width <= workAreaRight
    if (!leftAlignedFits && rightAlignedFits) horizontal = 'right'
    else if (
      centeredFits
      && centeredPanelRight <= workAreaRight - PET_PANEL_HORIZONTAL_HYSTERESIS
    ) horizontal = 'center'
  } else {
    const rightAlignedFits = mascotScreenLeft + panel.width <= workAreaRight
    const leftAlignedFits = mascotScreenRight - panel.width >= workArea.x
    if (!rightAlignedFits && leftAlignedFits) horizontal = 'left'
    else if (
      centeredFits
      && centeredPanelLeft >= workArea.x + PET_PANEL_HORIZONTAL_HYSTERESIS
    ) horizontal = 'center'
  }

  return { vertical, horizontal }
}

type PetWindowExtent = { width: number; height: number }

function isPositiveExtent(extent: Partial<PetWindowExtent> | undefined): boolean {
  return typeof extent?.width === 'number' && extent.width > 0
    && typeof extent?.height === 'number' && extent.height > 0
}

// Renderer regions are measured against the live viewport, so they have to be
// clamped to the real content box. Clamping to the nominal constants slices off
// whatever sits below it once the content area is taller than expected.
//
// getContentBounds returns an empty rect while the content view is detached, so
// fall through to the live window box rather than to the constants — falling
// back to those would silently reinstate the very clamp this exists to avoid.
function petWindowContentExtent(window: PetWindow): PetWindowExtent {
  const candidates = [window.getContentBounds?.(), window.getBounds()]
  const measured = candidates.find(isPositiveExtent)
  return {
    width: measured ? Math.round(measured.width) : PET_WINDOW_WIDTH,
    height: measured ? Math.round(measured.height) : PET_WINDOW_HEIGHT,
  }
}

/**
 * Moves the window without touching its size.
 *
 * Electron implements setPosition as `SetBounds(Rect(position, GetSize()))`, and
 * on Windows both halves of that DIP round trip round up — so on a fractional
 * display scale every call grows the window by a pixel. Restating the nominal
 * size is idempotent instead: the window is created non-resizable at exactly
 * these dimensions, so re-applying them also heals a window that already drifted.
 */
function movePetWindow(window: PetWindow, position: PetWindowPosition): void {
  window.setBounds({
    x: position.x,
    y: position.y,
    width: PET_WINDOW_WIDTH,
    height: PET_WINDOW_HEIGHT,
  })
}

function normalizePetWindowRegion(region: Rectangle, extent: PetWindowExtent): Rectangle {
  const x = Math.max(0, Math.min(extent.width - 1, Math.round(region.x)))
  const y = Math.max(0, Math.min(extent.height - 1, Math.round(region.y)))
  const right = Math.max(x + 1, Math.min(extent.width, Math.round(region.x + region.width)))
  const bottom = Math.max(y + 1, Math.min(extent.height, Math.round(region.y + region.height)))
  return { x, y, width: right - x, height: bottom - y }
}

export function getPetWindowBounds(
  workArea: Rectangle,
  restoredPosition?: PetWindowState | null,
): Rectangle {
  if (restoredPosition) {
    return {
      ...clampPetWindowPosition(restoredPosition, workArea, restoredPosition.region),
      width: PET_WINDOW_WIDTH,
      height: PET_WINDOW_HEIGHT,
    }
  }
  return {
    x: Math.max(
      workArea.x,
      workArea.x + workArea.width - PET_WINDOW_WIDTH - PET_WINDOW_MARGIN,
    ),
    y: Math.max(
      workArea.y,
      workArea.y + workArea.height - PET_WINDOW_HEIGHT - PET_WINDOW_MARGIN,
    ),
    width: PET_WINDOW_WIDTH,
    height: PET_WINDOW_HEIGHT,
  }
}

export function petWindowOptions(
  bounds: Rectangle,
  preload: string,
  platform: NodeJS.Platform = process.platform,
): BrowserWindowConstructorOptions {
  return {
    ...bounds,
    alwaysOnTop: true,
    autoHideMenuBar: true,
    backgroundColor: '#00000000',
    frame: false,
    fullscreenable: false,
    hasShadow: false,
    maximizable: false,
    minimizable: false,
    resizable: false,
    show: false,
    // macOS runs a visible window's frame through
    // -[NSWindow constrainFrameRect:toScreen:], which rewrites any y above the
    // work area back down to its top edge. The mascot sits at the bottom of a
    // mostly transparent window, so clamping against it deliberately asks for a
    // negative y to push that padding off-screen — and AppKit silently refused,
    // stranding the mascot a padding-height below the menu bar. This is the one
    // switch that skips that method; clampPetWindowPosition stays the
    // authoritative bound on every platform and every edge.
    ...(platform === 'darwin'
      ? { enableLargerThanScreen: true }
      : { skipTaskbar: true }),
    transparent: true,
    type: platform === 'darwin' ? 'panel' : undefined,
    webPreferences: {
      preload,
      partition: PET_WINDOW_PARTITION,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  }
}

function configurePetWindow(window: PetWindow, platform: NodeJS.Platform): void {
  if (platform === 'darwin') {
    window.setIgnoreMouseEvents(true, { forward: true })
  } else {
    window.setIgnoreMouseEvents(false)
    window.setShape([{ x: 0, y: 0, width: PET_WINDOW_WIDTH, height: PET_WINDOW_HEIGHT }])
  }
  if (platform !== 'darwin') return

  window.setAlwaysOnTop(true, 'floating')
  window.setVisibleOnAllWorkspaces(true, {
    skipTransformProcessType: true,
    visibleOnFullScreen: true,
  })
}

export type PetWindowControllerOptions = {
  createWindow(options: BrowserWindowConstructorOptions): PetWindow
  getCursorScreenPoint?(): Point
  getCurrentWorkArea(): Rectangle
  getWorkAreaForPoint?(point: Point): Rectangle
  load(window: PetWindow): Promise<void>
  onCreated?(window: PetWindow): void
  /**
   * Dragging is driven by a cursor sampler in this process, not by renderer
   * calls, so a placement that changes mid-drag has no reply to ride back on.
   */
  onPanelPlacementChanged?(window: PetWindow, placement: PetPanelPlacement): void
  platform?: NodeJS.Platform
  preloadPath: string
  readPosition?(): PetWindowState | null
  writePosition?(state: PetWindowState): void
}

export class PetWindowController {
  private window: PetWindow | null = null
  private creating: Promise<PetWindow> | null = null
  private drag: {
    window: PetWindow
    pointerStart: PetWindowPosition
    windowStart: PetWindowPosition
    lastPosition: PetWindowPosition
  } | null = null
  private dragTimer: ReturnType<typeof setInterval> | null = null
  private visibleDragRegion: Rectangle | null = null
  private panelBounds: Rectangle | null = null
  private panelPlacement: PetPanelPlacement = PET_PANEL_DEFAULT_PLACEMENT
  /**
   * Screen position the mascot has to keep once the renderer reports its next
   * layout.
   *
   * Set whenever the mascot is about to move inside the window while the user
   * expects it to stay put on screen: a flip moves it by the panel's height, and
   * a restart hands the renderer a saved position whose mascot offset belongs to
   * whichever side the panel was on when it was saved. Horizontal placement
   * moves the mascot inside the window too. Every case needs the window to move
   * the opposite way by the same amount.
   */
  private pendingMascotAnchorScreen: Point | null = null
  private pendingRestoredPosition: PetWindowState | null = null
  private readonly options: PetWindowControllerOptions

  constructor(options: PetWindowControllerOptions) {
    this.options = options
  }

  private async create(): Promise<PetWindow> {
    const restoredPosition = this.options.readPosition?.() ?? null
    this.resetPanelState()
    this.pendingRestoredPosition = restoredPosition
    // A saved position is only meaningful next to the mascot box it was saved
    // with, and that box moves when the panel changes sides. The renderer always
    // starts the panel above the mascot, so a position saved with it below would
    // otherwise drop the mascot by the panel's height on the next launch.
    // Restoring where the *mascot* was survives that, and a resized mascot too.
    if (restoredPosition?.region) {
      this.pendingMascotAnchorScreen = {
        x: restoredPosition.x + restoredPosition.region.x,
        y: restoredPosition.y + restoredPosition.region.y,
      }
    }
    const currentWorkArea = restoredPosition && this.options.getWorkAreaForPoint
      ? this.options.getWorkAreaForPoint(petWindowAnchor(restoredPosition))
      : this.options.getCurrentWorkArea()
    const window = this.options.createWindow(petWindowOptions(
      getPetWindowBounds(currentWorkArea, restoredPosition),
      this.options.preloadPath,
      this.options.platform,
    ))
    this.window = window
    window.on('closed', () => {
      this.finishDrag(window)
      if (this.window === window) {
        this.window = null
        this.resetPanelState()
        this.pendingRestoredPosition = null
      }
    })

    try {
      configurePetWindow(window, this.options.platform ?? process.platform)
      this.options.onCreated?.(window)
      await this.options.load(window)
      return window
    } catch (error) {
      if (!window.isDestroyed()) window.destroy()
      if (this.window === window) {
        this.window = null
        this.resetPanelState()
        this.pendingRestoredPosition = null
      }
      throw error
    }
  }

  private ensureWindow(): Promise<PetWindow> {
    if (this.window && !this.window.isDestroyed()) {
      return Promise.resolve(this.window)
    }
    if (this.creating) return this.creating

    const creating = this.create()
    this.creating = creating
    void creating.finally(() => {
      if (this.creating === creating) this.creating = null
    }).catch(() => undefined)
    return creating
  }

  async show(): Promise<void> {
    const window = await this.ensureWindow()
    if (!window.isVisible()) {
      if ((this.options.platform ?? process.platform) === 'darwin') {
        window.setIgnoreMouseEvents(true, { forward: true })
      }
      window.showInactive()
      if ((this.options.platform ?? process.platform) === 'darwin') {
        window.setAlwaysOnTop(true, 'floating')
      } else {
        window.setAlwaysOnTop(true)
      }
    }
  }

  hide(): void {
    const window = this.window
    this.finishDrag(window ?? undefined)
    if (!window || window.isDestroyed()) {
      this.window = null
      return
    }
    window.destroy()
    this.window = null
    this.resetPanelState()
    this.pendingRestoredPosition = null
  }

  private resetPanelState(): void {
    this.visibleDragRegion = null
    this.panelBounds = null
    this.panelPlacement = PET_PANEL_DEFAULT_PLACEMENT
    this.pendingMascotAnchorScreen = null
  }

  owns(window: PetWindow | null): boolean {
    return window !== null && this.window === window && !window.isDestroyed()
  }

  setIgnoreMouseEvents(window: PetWindow, ignore: boolean): void {
    if (!this.owns(window)) {
      throw new Error('Pet window IPC sender does not own the companion window')
    }
    if ((this.options.platform ?? process.platform) !== 'darwin') return
    window.setIgnoreMouseEvents(ignore, ignore ? { forward: true } : undefined)
  }

  setInteractiveRegions(window: PetWindow, regions: Rectangle[]): PetPanelPlacement {
    if (!this.owns(window)) {
      throw new Error('Pet window IPC sender does not own the companion window')
    }
    const platform = this.options.platform ?? process.platform
    const extent = petWindowContentExtent(window)
    const primaryRegion = regions[0]
    // The window is mostly transparent padding around the mascot, so dragging
    // has to clamp against the mascot on every platform. Clamping against the
    // whole window stops the mascot short of the display edges.
    const dragRegion = primaryRegion
      ? normalizePetWindowRegion(primaryRegion, extent)
      : null
    if (dragRegion) this.visibleDragRegion = dragRegion
    const panel = petPanelBounds(regions)
    this.panelBounds = panel ? normalizePetWindowRegion(panel, extent) : null

    // A saved edge position leaves the transparent padding off-screen, so
    // creating the window re-clamps it against the whole window and walks the
    // mascot inwards by the padding width. Restoring it needs the reported
    // region, which only arrives here — and it arrives on every platform, so
    // this runs on every platform too.
    if (dragRegion) {
      const bounds = window.getBounds()
      const restoredPosition = this.pendingRestoredPosition
      this.pendingRestoredPosition = null
      const requestedPosition = this.holdMascotAnchor(dragRegion, restoredPosition ?? bounds)
      // The live region beats whatever was saved: the mascot may have been
      // resized since, and this is the first measurement of the real one.
      const anchor = petWindowAnchor({ ...requestedPosition, region: dragRegion })
      const workArea = this.options.getWorkAreaForPoint?.(anchor)
        ?? this.options.getCurrentWorkArea()
      const nextPosition = clampPetWindowPosition(requestedPosition, workArea, dragRegion)
      if (nextPosition.x !== bounds.x || nextPosition.y !== bounds.y) {
        movePetWindow(window, nextPosition)
      }
      this.updatePanelPlacement(window, nextPosition, workArea, dragRegion)
    }

    if (platform === 'darwin') return this.panelPlacement

    const shape = regions.map((region) => normalizePetWindowRegion({
      x: region.x - PET_WINDOW_SHAPE_PADDING,
      y: region.y - PET_WINDOW_SHAPE_PADDING,
      width: region.width + PET_WINDOW_SHAPE_PADDING * 2,
      height: region.height + PET_WINDOW_SHAPE_PADDING * 2,
    }, extent))
    if (shape.length > 0) window.setShape(shape)
    return this.panelPlacement
  }

  /**
   * Rebases the window on the screen position the mascot has to keep.
   *
   * The reported region is the first news of where the mascot actually sits
   * inside the window, so this is the point where a placement change or restore
   * becomes a window move that leaves the mascot where the user last saw it.
   */
  private holdMascotAnchor(
    mascot: Rectangle,
    requestedPosition: PetWindowPosition,
  ): PetWindowPosition {
    const anchorScreen = this.pendingMascotAnchorScreen
    if (anchorScreen === null) return requestedPosition
    this.pendingMascotAnchorScreen = null

    const compensated = {
      x: anchorScreen.x - mascot.x,
      y: anchorScreen.y - mascot.y,
    }
    const drag = this.drag
    if (drag) {
      // A drag maps pointer travel from a fixed window origin, so the origin has
      // to absorb the flip too — otherwise the next tick recomputes the pre-flip
      // position and drags the mascot straight back.
      drag.windowStart = {
        x: drag.windowStart.x + compensated.x - requestedPosition.x,
        y: drag.windowStart.y + compensated.y - requestedPosition.y,
      }
    }
    return compensated
  }

  private updatePanelPlacement(
    window: PetWindow,
    windowPosition: PetWindowPosition,
    workArea: Rectangle,
    mascot: Rectangle,
  ): void {
    const previous = this.panelPlacement
    const next = resolvePetPanelPlacement({
      windowPosition,
      workArea,
      mascot,
      panel: this.panelBounds,
      previous,
    })
    if (
      next.vertical === previous.vertical
      && next.horizontal === previous.horizontal
    ) return

    this.pendingMascotAnchorScreen = {
      x: windowPosition.x + mascot.x,
      y: windowPosition.y + mascot.y,
    }
    this.panelPlacement = next
    this.options.onPanelPlacementChanged?.(window, next)
  }

  dragWindow(window: PetWindow, payload: PetWindowDragPayload): PetPanelPlacement {
    if (!this.owns(window)) {
      throw new Error('Pet window IPC sender does not own the companion window')
    }
    if (!isFiniteScreenCoordinate(payload.x) || !isFiniteScreenCoordinate(payload.y)) {
      throw new Error('Pet window drag coordinates must be finite screen coordinates')
    }

    if (payload.phase === 'start') {
      this.finishDrag()
      const bounds = window.getBounds()
      const sampledPointer = this.options.getCursorScreenPoint?.()
      const pointerStart = sampledPointer && isPetWindowPosition(sampledPointer)
        ? sampledPointer
        : payload
      this.drag = {
        window,
        pointerStart: { x: pointerStart.x, y: pointerStart.y },
        windowStart: { x: bounds.x, y: bounds.y },
        lastPosition: { x: bounds.x, y: bounds.y },
      }
      if (this.options.getCursorScreenPoint) {
        this.dragTimer = setInterval(() => this.sampleDragPosition(), PET_WINDOW_DRAG_INTERVAL_MS)
      }
      return this.panelPlacement
    }

    const drag = this.drag
    if (!drag || drag.window !== window) {
      throw new Error('Pet window drag has not started')
    }

    const payloadPosition = { x: payload.x, y: payload.y }
    const cursorPosition = payload.phase === 'end'
      ? this.readCursorScreenPoint() ?? payloadPosition
      : payloadPosition
    this.updateDragPosition(drag, cursorPosition)

    if (payload.phase === 'end') {
      this.finishDrag(window)
    }
    return this.panelPlacement
  }

  private readCursorScreenPoint(): PetWindowPosition | null {
    const point = this.options.getCursorScreenPoint?.()
    return point && isPetWindowPosition(point)
      ? { x: point.x, y: point.y }
      : null
  }

  private sampleDragPosition(): void {
    const drag = this.drag
    if (!drag || drag.window.isDestroyed()) {
      this.finishDrag(drag?.window)
      return
    }
    const point = this.readCursorScreenPoint()
    if (point) this.updateDragPosition(drag, point)
  }

  private updateDragPosition(
    drag: NonNullable<PetWindowController['drag']>,
    pointer: PetWindowPosition,
  ): void {
    const requestedPosition = {
      x: drag.windowStart.x + pointer.x - drag.pointerStart.x,
      y: drag.windowStart.y + pointer.y - drag.pointerStart.y,
    }
    const workArea = this.options.getWorkAreaForPoint?.(pointer)
      ?? this.options.getCurrentWorkArea()
    const nextPosition = clampPetWindowPosition(
      requestedPosition,
      workArea,
      this.visibleDragRegion ?? undefined,
    )
    if (
      nextPosition.x === drag.lastPosition.x
      && nextPosition.y === drag.lastPosition.y
    ) return

    movePetWindow(drag.window, nextPosition)
    drag.lastPosition = nextPosition
    // Dragging is the only way the mascot reaches an edge, so it is also where
    // the panel runs out of room. Most ticks here come from the cursor sampler
    // rather than a renderer call, so this reaches the renderer as an event.
    if (this.visibleDragRegion) {
      this.updatePanelPlacement(drag.window, nextPosition, workArea, this.visibleDragRegion)
    }
  }

  private finishDrag(window?: PetWindow): void {
    const drag = this.drag
    if (window && drag && drag.window !== window) return
    if (this.dragTimer) {
      clearInterval(this.dragTimer)
      this.dragTimer = null
    }
    if (!drag) return

    this.drag = null
    // The saved position only reconstructs where the mascot was if the box it
    // was clamped against travels with it.
    this.options.writePosition?.({
      ...drag.lastPosition,
      ...(this.visibleDragRegion ? { region: this.visibleDragRegion } : {}),
    })
  }

  showContextMenu(
    window: PetWindow,
    closeLabel: string,
    menuFactory: PetContextMenuFactory,
  ): Promise<boolean> {
    if (!this.owns(window)) {
      return Promise.reject(new Error('Pet window IPC sender does not own the companion window'))
    }

    return new Promise<boolean>((resolve) => {
      let settled = false
      const settle = (selected: boolean) => {
        if (settled) return
        settled = true
        resolve(selected)
      }
      const menu = menuFactory.buildFromTemplate([{
        label: closeLabel,
        click: () => settle(true),
      }])
      menu.popup({
        window,
        callback: () => settle(false),
      })
    })
  }

  dispose(): void {
    this.finishDrag()
    if (this.window && !this.window.isDestroyed()) this.window.destroy()
    this.window = null
  }
}
