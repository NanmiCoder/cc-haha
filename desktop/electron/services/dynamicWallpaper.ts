import fs from 'node:fs'
import path from 'node:path'
import type {
  DesktopDynamicWallpaperPickResult,
  DesktopDynamicWallpaperPreferences,
  DesktopDynamicWallpaperStatus,
  DesktopDynamicWallpaperUpdate,
  DesktopWallpaperKind,
} from '../../src/lib/desktopHost/types'

/**
 * Dynamic wallpapers never leave this computer and never touch the sidecar
 * server. The Electron main process remembers the user's source paths in
 * `userData/wallpaper.json` and serves the bytes through `cc-wallpaper://`.
 */
export const DYNAMIC_WALLPAPER_CONFIG_FILE = 'wallpaper.json'
export const WEB_WALLPAPER_ENTRY = 'index.html'

export const VIDEO_WALLPAPER_EXTENSIONS = [
  '.mp4',
  '.m4v',
  '.webm',
  '.mov',
  '.ogv',
  '.ogg',
] as const

export const DEFAULT_DYNAMIC_WALLPAPER: DesktopDynamicWallpaperPreferences = {
  kind: 'image',
  enabled: false,
  focusX: 50,
  focusY: 50,
  zoom: 100,
  blur: 8,
  panelOpacity: 88,
  videoPath: null,
  videoName: null,
  webDir: null,
  webName: null,
  revision: 0,
  updatedAt: null,
}

export type DynamicWallpaperAppLike = {
  getPath(name: 'userData'): string
}

function clampInteger(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.round(value)))
}

function normalizeKind(value: unknown): DesktopWallpaperKind {
  return value === 'video' || value === 'web' || value === 'image' ? value : 'image'
}

function normalizePath(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0) return null
  if (value.includes('\0') || value.length > 32_768) return null
  return path.isAbsolute(value) ? value : null
}

function normalizeRevision(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0
}

function normalizeUpdatedAt(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= 64 ? value : null
}

export function normalizeDynamicWallpaperPreferences(
  value: unknown,
): DesktopDynamicWallpaperPreferences {
  const record = typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
  const videoPath = normalizePath(record.videoPath)
  const webDir = normalizePath(record.webDir)
  return {
    kind: normalizeKind(record.kind),
    enabled: record.enabled === true,
    focusX: clampInteger(record.focusX, 0, 100, DEFAULT_DYNAMIC_WALLPAPER.focusX),
    focusY: clampInteger(record.focusY, 0, 100, DEFAULT_DYNAMIC_WALLPAPER.focusY),
    zoom: clampInteger(record.zoom, 100, 300, DEFAULT_DYNAMIC_WALLPAPER.zoom),
    blur: clampInteger(record.blur, 0, 40, DEFAULT_DYNAMIC_WALLPAPER.blur),
    panelOpacity: clampInteger(record.panelOpacity, 60, 100, DEFAULT_DYNAMIC_WALLPAPER.panelOpacity),
    videoPath,
    videoName: videoPath ? path.basename(videoPath) : null,
    webDir,
    webName: webDir ? path.basename(webDir) : null,
    revision: normalizeRevision(record.revision),
    updatedAt: normalizeUpdatedAt(record.updatedAt),
  }
}

export function wallpaperConfigPath(app: DynamicWallpaperAppLike): string {
  return path.join(app.getPath('userData'), DYNAMIC_WALLPAPER_CONFIG_FILE)
}

export function readDynamicWallpaperPreferences(
  app: DynamicWallpaperAppLike,
): DesktopDynamicWallpaperPreferences {
  try {
    const raw = fs.readFileSync(wallpaperConfigPath(app), 'utf8')
    return normalizeDynamicWallpaperPreferences(JSON.parse(raw))
  } catch {
    return { ...DEFAULT_DYNAMIC_WALLPAPER }
  }
}

export function writeDynamicWallpaperPreferences(
  app: DynamicWallpaperAppLike,
  preferences: DesktopDynamicWallpaperPreferences,
): DesktopDynamicWallpaperPreferences {
  const normalized = normalizeDynamicWallpaperPreferences(preferences)
  const target = wallpaperConfigPath(app)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  const temporary = `${target}.tmp`
  fs.writeFileSync(temporary, JSON.stringify(normalized, null, 2), 'utf8')
  fs.renameSync(temporary, target)
  return normalized
}

export function isVideoWallpaperFile(filePath: string): boolean {
  return VIDEO_WALLPAPER_EXTENSIONS.includes(
    path.extname(filePath).toLowerCase() as typeof VIDEO_WALLPAPER_EXTENSIONS[number],
  )
}

export function hasWebWallpaperEntry(dir: string): boolean {
  try {
    return fs.statSync(path.join(dir, WEB_WALLPAPER_ENTRY)).isFile()
  } catch {
    return false
  }
}

export function resolveDynamicWallpaperStatus(
  app: DynamicWallpaperAppLike,
  preferences = readDynamicWallpaperPreferences(app),
): DesktopDynamicWallpaperStatus {
  let unavailable: DesktopDynamicWallpaperStatus['unavailable'] = null
  if (preferences.kind === 'video' && preferences.videoPath) {
    try {
      if (!fs.statSync(preferences.videoPath).isFile() || !isVideoWallpaperFile(preferences.videoPath)) {
        unavailable = 'video-missing'
      }
    } catch {
      unavailable = 'video-missing'
    }
  } else if (preferences.kind === 'web' && preferences.webDir) {
    if (!hasWebWallpaperEntry(preferences.webDir)) unavailable = 'web-missing'
  }
  return { preferences, unavailable }
}

function save(
  app: DynamicWallpaperAppLike,
  preferences: DesktopDynamicWallpaperPreferences,
): DesktopDynamicWallpaperStatus {
  const saved = writeDynamicWallpaperPreferences(app, preferences)
  return resolveDynamicWallpaperStatus(app, saved)
}

export function updateDynamicWallpaperPreferences(
  app: DynamicWallpaperAppLike,
  patch: DesktopDynamicWallpaperUpdate,
): DesktopDynamicWallpaperStatus {
  const current = readDynamicWallpaperPreferences(app)
  const next: DesktopDynamicWallpaperPreferences = {
    ...current,
    ...patch,
    updatedAt: new Date().toISOString(),
  }
  return save(app, next)
}

export function pickVideoWallpaper(
  app: DynamicWallpaperAppLike,
  filePath: string,
): DesktopDynamicWallpaperStatus | null {
  if (!isVideoWallpaperFile(filePath)) return null
  try {
    if (!fs.statSync(filePath).isFile()) return null
  } catch {
    return null
  }
  const current = readDynamicWallpaperPreferences(app)
  return save(app, {
    ...current,
    kind: 'video',
    enabled: true,
    videoPath: filePath,
    videoName: path.basename(filePath),
    revision: current.revision + 1,
    updatedAt: new Date().toISOString(),
  })
}

export function pickWebWallpaper(
  app: DynamicWallpaperAppLike,
  dir: string,
): Pick<DesktopDynamicWallpaperPickResult, 'status' | 'error'> {
  if (!hasWebWallpaperEntry(dir)) {
    return {
      status: resolveDynamicWallpaperStatus(app),
      error: 'web-index-missing',
    }
  }
  const current = readDynamicWallpaperPreferences(app)
  return {
    status: save(app, {
      ...current,
      kind: 'web',
      enabled: true,
      webDir: dir,
      webName: path.basename(dir),
      revision: current.revision + 1,
      updatedAt: new Date().toISOString(),
    }),
    error: null,
  }
}

export function clearDynamicWallpaperSource(
  app: DynamicWallpaperAppLike,
): DesktopDynamicWallpaperStatus {
  const current = readDynamicWallpaperPreferences(app)
  return save(app, {
    ...current,
    enabled: false,
    videoPath: current.kind === 'video' ? null : current.videoPath,
    videoName: current.kind === 'video' ? null : current.videoName,
    webDir: current.kind === 'web' ? null : current.webDir,
    webName: current.kind === 'web' ? null : current.webName,
    revision: current.revision + 1,
    updatedAt: new Date().toISOString(),
  })
}

export function reloadDynamicWallpaper(
  app: DynamicWallpaperAppLike,
): DesktopDynamicWallpaperStatus {
  const current = readDynamicWallpaperPreferences(app)
  return save(app, {
    ...current,
    revision: current.revision + 1,
    updatedAt: new Date().toISOString(),
  })
}