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

export type PetWindowDragPayload = PetWindowPosition & {
  phase: 'start' | 'move' | 'end'
}

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
): PetWindowPosition | null {
  const statePath = petWindowStatePath(env, homeDir)
  if (!existsSync(statePath)) return null

  try {
    const parsed = JSON.parse(readFileSync(statePath, 'utf8')) as unknown
    return isPetWindowPosition(parsed)
      ? { x: Math.round(parsed.x), y: Math.round(parsed.y) }
      : null
  } catch (error) {
    console.error(`[desktop] failed to read pet window state ${statePath}:`, error)
    return null
  }
}

export function writePetWindowPosition(
  position: PetWindowPosition,
  env: NodeJS.ProcessEnv = process.env,
  homeDir: string = os.homedir(),
): void {
  if (!isPetWindowPosition(position)) return
  const statePath = petWindowStatePath(env, homeDir)
  const temporaryPath = `${statePath}.${process.pid}.tmp`
  try {
    mkdirSync(path.dirname(statePath), { recursive: true, mode: 0o700 })
    writeFileSync(temporaryPath, `${JSON.stringify({
      x: Math.round(position.x),
      y: Math.round(position.y),
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
): PetWindowPosition {
  const maxX = workArea.x + Math.max(0, workArea.width - PET_WINDOW_WIDTH)
  const maxY = workArea.y + Math.max(0, workArea.height - PET_WINDOW_HEIGHT)
  return {
    x: Math.min(Math.max(Math.round(position.x), workArea.x), maxX),
    y: Math.min(Math.max(Math.round(position.y), workArea.y), maxY),
  }
}

export function getPetWindowBounds(
  workArea: Rectangle,
  restoredPosition?: PetWindowPosition | null,
): Rectangle {
  if (restoredPosition) {
    return {
      ...clampPetWindowPosition(restoredPosition, workArea),
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
    ...(platform === 'darwin' ? {} : { skipTaskbar: true }),
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
  platform?: NodeJS.Platform
  preloadPath: string
  readPosition?(): PetWindowPosition | null
  writePosition?(position: PetWindowPosition): void
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
  private readonly options: PetWindowControllerOptions

  constructor(options: PetWindowControllerOptions) {
    this.options = options
  }

  private async create(): Promise<PetWindow> {
    const restoredPosition = this.options.readPosition?.() ?? null
    const currentWorkArea = restoredPosition && this.options.getWorkAreaForPoint
      ? this.options.getWorkAreaForPoint({
          x: restoredPosition.x + Math.floor(PET_WINDOW_WIDTH / 2),
          y: restoredPosition.y + Math.floor(PET_WINDOW_HEIGHT / 2),
        })
      : this.options.getCurrentWorkArea()
    const window = this.options.createWindow(petWindowOptions(
      getPetWindowBounds(currentWorkArea, restoredPosition),
      this.options.preloadPath,
      this.options.platform,
    ))
    this.window = window
    window.on('closed', () => {
      this.finishDrag(window)
      if (this.window === window) this.window = null
    })

    try {
      configurePetWindow(window, this.options.platform ?? process.platform)
      this.options.onCreated?.(window)
      await this.options.load(window)
      return window
    } catch (error) {
      if (!window.isDestroyed()) window.destroy()
      if (this.window === window) this.window = null
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

  setInteractiveRegions(window: PetWindow, regions: Rectangle[]): void {
    if (!this.owns(window)) {
      throw new Error('Pet window IPC sender does not own the companion window')
    }
    if ((this.options.platform ?? process.platform) === 'darwin') return

    const shape = regions.flatMap((region) => {
      const requestedLeft = Math.round(region.x) - PET_WINDOW_SHAPE_PADDING
      const requestedTop = Math.round(region.y) - PET_WINDOW_SHAPE_PADDING
      const requestedRight = Math.round(region.x + region.width) + PET_WINDOW_SHAPE_PADDING
      const requestedBottom = Math.round(region.y + region.height) + PET_WINDOW_SHAPE_PADDING
      const x = Math.max(0, Math.min(PET_WINDOW_WIDTH - 1, requestedLeft))
      const y = Math.max(0, Math.min(PET_WINDOW_HEIGHT - 1, requestedTop))
      const right = Math.max(x + 1, Math.min(PET_WINDOW_WIDTH, requestedRight))
      const bottom = Math.max(y + 1, Math.min(PET_WINDOW_HEIGHT, requestedBottom))
      return [{ x, y, width: right - x, height: bottom - y }]
    })
    if (shape.length > 0) window.setShape(shape)
  }

  dragWindow(window: PetWindow, payload: PetWindowDragPayload): void {
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
      return
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
    const nextPosition = clampPetWindowPosition(requestedPosition, workArea)
    if (
      nextPosition.x === drag.lastPosition.x
      && nextPosition.y === drag.lastPosition.y
    ) return

    drag.window.setPosition(nextPosition.x, nextPosition.y, false)
    drag.lastPosition = nextPosition
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
    this.options.writePosition?.(drag.lastPosition)
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
