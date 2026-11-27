import type {
  BrowserWindow,
  BrowserWindowConstructorOptions,
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
import { areStorageWritesFrozen } from './storageMaintenance'

export const USAGE_WIDGET_CARD_WIDTH = 356
export const USAGE_WIDGET_CARD_HEIGHT = 480
export const USAGE_WIDGET_COMPACT_WIDTH = 376
export const USAGE_WIDGET_COMPACT_HEIGHT = 44
export const USAGE_WIDGET_MARGIN = 18
export const USAGE_WIDGET_TOP_SNAP_THRESHOLD = 12
export const USAGE_WIDGET_WINDOW_PARTITION = 'cc-haha-usage-widget'
export const USAGE_WIDGET_STATE_FILE = 'usage-widget-window.json'

const MAX_ABSOLUTE_SCREEN_COORDINATE = 1_000_000
const DRAG_THROTTLE_MS = 16

export type UsageWidgetWindowPosition = Pick<Point, 'x' | 'y'>

export type UsageWidgetWindowState = UsageWidgetWindowPosition & {
  compact?: boolean
  alwaysOnTop?: boolean
  snappedTop?: boolean
}

export type UsageWidgetWindowDragPayload = UsageWidgetWindowPosition & {
  phase: 'start' | 'move' | 'end'
}

export type UsageWidgetBoundsState = {
  compact: boolean
  alwaysOnTop: boolean
  snappedTop: boolean
}

function isFiniteCoordinate(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isFinite(value)
    && Math.abs(value) <= MAX_ABSOLUTE_SCREEN_COORDINATE
}

function resolveHomePath(input: string, homeDir: string): string {
  if (input === '~') return homeDir
  if (input.startsWith(`~${path.sep}`) || input.startsWith('~/') || input.startsWith('~\\')) {
    return path.join(homeDir, input.slice(2))
  }
  return input
}

export function usageWidgetStatePath(
  env: NodeJS.ProcessEnv = process.env,
  homeDir: string = os.homedir(),
): string {
  const normalizedHome = path.resolve(homeDir)
  const configuredRoot = env.CLAUDE_CONFIG_DIR?.trim()
  const configRoot = configuredRoot
    ? path.resolve(resolveHomePath(configuredRoot, normalizedHome))
    : path.join(normalizedHome, '.claude')
  return path.join(configRoot, 'cc-haha', USAGE_WIDGET_STATE_FILE)
}

export function readUsageWidgetWindowState(
  env: NodeJS.ProcessEnv = process.env,
  homeDir: string = os.homedir(),
): UsageWidgetWindowState | null {
  const filePath = usageWidgetStatePath(env, homeDir)
  if (!existsSync(filePath)) return null
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, unknown>
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    if (!isFiniteCoordinate(parsed.x) || !isFiniteCoordinate(parsed.y)) return null
    return {
      x: Math.round(parsed.x),
      y: Math.round(parsed.y),
      ...(typeof parsed.compact === 'boolean' ? { compact: parsed.compact } : {}),
      ...(typeof parsed.alwaysOnTop === 'boolean' ? { alwaysOnTop: parsed.alwaysOnTop } : {}),
      ...(typeof parsed.snappedTop === 'boolean' ? { snappedTop: parsed.snappedTop } : {}),
    }
  } catch {
    return null
  }
}

export function writeUsageWidgetWindowState(
  state: UsageWidgetWindowState,
  env: NodeJS.ProcessEnv = process.env,
  homeDir: string = os.homedir(),
): void {
  if (areStorageWritesFrozen() || !isFiniteCoordinate(state.x) || !isFiniteCoordinate(state.y)) {
    return
  }
  const filePath = usageWidgetStatePath(env, homeDir)
  const tempPath = `${filePath}.${process.pid}.tmp`
  try {
    mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 })
    writeFileSync(tempPath, `${JSON.stringify({
      x: Math.round(state.x),
      y: Math.round(state.y),
      compact: state.compact ?? false,
      alwaysOnTop: state.alwaysOnTop ?? true,
      snappedTop: state.snappedTop ?? false,
    }, null, 2)}\n`, { mode: 0o600 })
    renameSync(tempPath, filePath)
  } catch {
    rmSync(tempPath, { force: true })
  }
}

export function sizeForUsageWidget(compact: boolean): { width: number; height: number } {
  return compact
    ? { width: USAGE_WIDGET_COMPACT_WIDTH, height: USAGE_WIDGET_COMPACT_HEIGHT }
    : { width: USAGE_WIDGET_CARD_WIDTH, height: USAGE_WIDGET_CARD_HEIGHT }
}

export function clampUsageWidgetPosition(
  position: UsageWidgetWindowPosition,
  workArea: Rectangle,
  size: { width: number; height: number },
): UsageWidgetWindowPosition {
  const minX = workArea.x
  const minY = workArea.y
  const maxX = Math.max(minX, workArea.x + workArea.width - size.width)
  const maxY = Math.max(minY, workArea.y + workArea.height - size.height)
  return {
    x: Math.min(Math.max(Math.round(position.x), minX), maxX),
    y: Math.min(Math.max(Math.round(position.y), minY), maxY),
  }
}

export function defaultUsageWidgetPosition(
  workArea: Rectangle,
  size: { width: number; height: number },
): UsageWidgetWindowPosition {
  return clampUsageWidgetPosition(
    {
      x: workArea.x + workArea.width - size.width - USAGE_WIDGET_MARGIN,
      y: workArea.y + USAGE_WIDGET_MARGIN,
    },
    workArea,
    size,
  )
}

export function topCenteredUsageWidgetPosition(
  workArea: Rectangle,
  size: { width: number; height: number },
): UsageWidgetWindowPosition {
  return clampUsageWidgetPosition(
    {
      x: Math.round(workArea.x + (workArea.width - size.width) / 2),
      y: workArea.y,
    },
    workArea,
    size,
  )
}

export function usageWidgetWindowOptions(input: {
  preloadPath: string
  position: UsageWidgetWindowPosition
  compact: boolean
  alwaysOnTop: boolean
  platform?: NodeJS.Platform
}): BrowserWindowConstructorOptions {
  const platform = input.platform ?? process.platform
  const size = sizeForUsageWidget(input.compact)
  return {
    width: size.width,
    height: size.height,
    x: Math.round(input.position.x),
    y: Math.round(input.position.y),
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: true,
    alwaysOnTop: input.alwaysOnTop,
    ...(platform === 'darwin' ? { type: 'panel' as const } : {}),
    webPreferences: {
      preload: input.preloadPath,
      partition: USAGE_WIDGET_WINDOW_PARTITION,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  }
}

type UsageWidgetDragState = {
  startCursor: Point
  startWindow: UsageWidgetWindowPosition
  lastMoveAt: number
}

export class UsageWidgetWindowController {
  private window: BrowserWindow | null = null
  private compact = false
  private alwaysOnTop = true
  private snappedTop = false
  private dragState: UsageWidgetDragState | null = null
  private disposed = false

  constructor(private readonly deps: {
    createWindow: (options: BrowserWindowConstructorOptions) => BrowserWindow
    getCursorScreenPoint: () => Point
    getCurrentWorkArea: () => Rectangle
    getWorkAreaForPoint: (point: Point) => Rectangle
    preloadPath: string
    platform?: NodeJS.Platform
    now?: () => number
    readState?: () => UsageWidgetWindowState | null
    writeState?: (state: UsageWidgetWindowState) => void
    onCreated?: (window: BrowserWindow) => void
    load: (window: BrowserWindow) => Promise<void>
    onVisibilityChanged?: (visible: boolean) => void
  }) {}

  owns(window: BrowserWindow | null | undefined): boolean {
    return Boolean(window && this.window && window === this.window)
  }

  isVisible(): boolean {
    return Boolean(this.window && !this.window.isDestroyed() && this.window.isVisible())
  }

  getWindow(): BrowserWindow | null {
    return this.window && !this.window.isDestroyed() ? this.window : null
  }

  async show(options?: { compact?: boolean; alwaysOnTop?: boolean; snappedTop?: boolean }): Promise<void> {
    if (this.disposed) return
    const saved = this.deps.readState?.() ?? null
    if (typeof options?.compact === 'boolean') {
      this.compact = options.compact
    } else if (saved && typeof saved.compact === 'boolean') {
      this.compact = saved.compact
    }
    if (typeof options?.alwaysOnTop === 'boolean') {
      this.alwaysOnTop = options.alwaysOnTop
    } else if (saved && typeof saved.alwaysOnTop === 'boolean') {
      this.alwaysOnTop = saved.alwaysOnTop
    }
    if (typeof options?.snappedTop === 'boolean') {
      this.snappedTop = options.snappedTop
    } else {
      this.snappedTop = saved?.snappedTop ?? false
    }

    const existing = this.getWindow()
    if (existing) {
      this.applyAlwaysOnTop(existing, this.alwaysOnTop)
      this.applyBoundsForMode(existing, this.compact, this.snappedTop)
      if (!existing.isVisible()) {
        existing.show()
        this.deps.onVisibilityChanged?.(true)
      }
      existing.focus()
      return
    }

    const size = sizeForUsageWidget(this.compact)
    const workArea = saved
      ? this.deps.getWorkAreaForPoint({ x: saved.x, y: saved.y })
      : this.deps.getCurrentWorkArea()
    const position = saved
      ? clampUsageWidgetPosition({ x: saved.x, y: saved.y }, workArea, size)
      : defaultUsageWidgetPosition(workArea, size)

    const win = this.deps.createWindow(usageWidgetWindowOptions({
      preloadPath: this.deps.preloadPath,
      position,
      compact: this.compact,
      alwaysOnTop: this.alwaysOnTop,
      platform: this.deps.platform,
    }))
    this.window = win
    this.applyAlwaysOnTop(win, this.alwaysOnTop)
    this.deps.onCreated?.(win)
    win.on('closed', () => {
      if (this.window === win) {
        this.window = null
        this.dragState = null
        this.deps.onVisibilityChanged?.(false)
      }
    })

    await this.deps.load(win)
    if (this.disposed || win.isDestroyed()) return
    win.show()
    this.deps.onVisibilityChanged?.(true)
  }

  hide(): void {
    const win = this.getWindow()
    if (!win) return
    this.persistCurrentBounds(win)
    if (win.isVisible()) {
      win.hide()
      this.deps.onVisibilityChanged?.(false)
    }
  }

  async toggle(options?: { compact?: boolean; alwaysOnTop?: boolean }): Promise<boolean> {
    if (this.isVisible()) {
      this.hide()
      return false
    }
    await this.show(options)
    return true
  }

  setCompact(compact: boolean): UsageWidgetBoundsState {
    this.compact = compact
    if (!compact) this.snappedTop = false
    const win = this.getWindow()
    if (win) {
      this.applyBoundsForMode(win, this.compact, this.snappedTop)
      this.persistCurrentBounds(win)
    }
    return this.currentBoundsState()
  }

  setAlwaysOnTop(alwaysOnTop: boolean): UsageWidgetBoundsState {
    this.alwaysOnTop = alwaysOnTop
    const win = this.getWindow()
    if (win) {
      this.applyAlwaysOnTop(win, alwaysOnTop)
      this.persistCurrentBounds(win)
    }
    return this.currentBoundsState()
  }

  async snapToTop(): Promise<UsageWidgetBoundsState> {
    if (!this.isVisible()) {
      await this.show({ compact: true, alwaysOnTop: true, snappedTop: true })
    }
    this.compact = true
    this.snappedTop = true
    this.alwaysOnTop = true
    const win = this.getWindow()
    if (win) {
      const workArea = this.deps.getCurrentWorkArea()
      const size = sizeForUsageWidget(true)
      const pos = topCenteredUsageWidgetPosition(workArea, size)
      win.setBounds({ x: pos.x, y: pos.y, width: size.width, height: size.height })
      this.applyAlwaysOnTop(win, true)
      this.persistCurrentBounds(win)
    }
    return this.currentBoundsState()
  }

  dragWindow(payload: UsageWidgetWindowDragPayload): UsageWidgetBoundsState {
    const win = this.getWindow()
    if (!win) return this.currentBoundsState()
    const now = this.deps.now ?? Date.now

    if (payload.phase === 'start') {
      const bounds = win.getBounds()
      this.dragState = {
        startCursor: { x: payload.x, y: payload.y },
        startWindow: { x: bounds.x, y: bounds.y },
        lastMoveAt: 0,
      }
      return this.currentBoundsState()
    }

    if (!this.dragState) return this.currentBoundsState()

    if (payload.phase === 'move') {
      const currentMs = now()
      if (currentMs - this.dragState.lastMoveAt < DRAG_THROTTLE_MS) {
        return this.currentBoundsState()
      }
      this.dragState.lastMoveAt = currentMs
    }

    const dx = payload.x - this.dragState.startCursor.x
    const dy = payload.y - this.dragState.startCursor.y
    const target = {
      x: this.dragState.startWindow.x + dx,
      y: this.dragState.startWindow.y + dy,
    }
    const size = sizeForUsageWidget(this.compact)
    const workArea = this.deps.getWorkAreaForPoint({
      x: target.x + Math.floor(size.width / 2),
      y: target.y + Math.floor(size.height / 2),
    })
    const clamped = clampUsageWidgetPosition(target, workArea, size)
    const snapped = clamped.y - workArea.y <= USAGE_WIDGET_TOP_SNAP_THRESHOLD
    const finalY = snapped ? workArea.y : clamped.y
    this.snappedTop = snapped
    win.setPosition(clamped.x, finalY)

    if (payload.phase === 'end') {
      this.dragState = null
      this.persistCurrentBounds(win)
    }

    return this.currentBoundsState()
  }

  dispose(): void {
    this.disposed = true
    const win = this.getWindow()
    this.window = null
    this.dragState = null
    if (win) {
      this.persistCurrentBounds(win)
      win.destroy()
    }
  }

  private currentBoundsState(): UsageWidgetBoundsState {
    return {
      compact: this.compact,
      alwaysOnTop: this.alwaysOnTop,
      snappedTop: this.snappedTop,
    }
  }

  private applyAlwaysOnTop(win: BrowserWindow, enabled: boolean): void {
    const platform = this.deps.platform ?? process.platform
    win.setAlwaysOnTop(enabled, 'floating')
    if (platform === 'darwin' && typeof win.setVisibleOnAllWorkspaces === 'function') {
      win.setVisibleOnAllWorkspaces(enabled, { visibleOnFullScreen: true })
    }
  }

  private applyBoundsForMode(win: BrowserWindow, compact: boolean, snappedTop: boolean): void {
    const current = win.getBounds()
    const size = sizeForUsageWidget(compact)
    const workArea = this.deps.getWorkAreaForPoint({
      x: current.x + Math.floor(current.width / 2),
      y: current.y + Math.floor(current.height / 2),
    })
    const nextPos = snappedTop
      ? topCenteredUsageWidgetPosition(workArea, size)
      : clampUsageWidgetPosition({ x: current.x, y: current.y }, workArea, size)
    win.setBounds({
      x: nextPos.x,
      y: nextPos.y,
      width: size.width,
      height: size.height,
    })
  }

  private persistCurrentBounds(win: BrowserWindow): void {
    if (win.isDestroyed()) return
    const bounds = win.getBounds()
    this.deps.writeState?.({
      x: bounds.x,
      y: bounds.y,
      compact: this.compact,
      alwaysOnTop: this.alwaysOnTop,
      snappedTop: this.snappedTop,
    })
  }
}
