import type {
  DesktopDynamicWallpaperPreferences,
  DesktopDynamicWallpaperStatus,
} from './desktopHost/types'

export const VIDEO_WALLPAPER_URL = 'cc-wallpaper://video/stream'
export const WEB_WALLPAPER_URL = 'cc-wallpaper://pack/index.html'
export const WALLPAPER_SOURCE_ATTRIBUTE = 'data-wallpaper-source'
const WALLPAPER_ATTRIBUTE = 'data-wallpaper'
const WALLPAPER_VARIABLES = [
  '--wallpaper-image',
  '--wallpaper-focus-x',
  '--wallpaper-focus-y',
  '--wallpaper-zoom',
  '--wallpaper-blur',
  '--wallpaper-panel-alpha',
] as const

export const DEFAULT_DYNAMIC_WALLPAPER_PREFERENCES: DesktopDynamicWallpaperPreferences = {
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

export const DEFAULT_DYNAMIC_WALLPAPER_STATUS: DesktopDynamicWallpaperStatus = {
  preferences: DEFAULT_DYNAMIC_WALLPAPER_PREFERENCES,
  unavailable: null,
}

export function videoWallpaperUrl(revision: number): string {
  return `${VIDEO_WALLPAPER_URL}?rev=${revision}`
}

export function webWallpaperUrl(revision: number): string {
  return `${WEB_WALLPAPER_URL}?rev=${revision}`
}

export function hasDynamicWallpaperSource(
  preferences: DesktopDynamicWallpaperPreferences,
): boolean {
  if (preferences.kind === 'video') return preferences.videoPath !== null
  if (preferences.kind === 'web') return preferences.webDir !== null
  return false
}

export function isDynamicWallpaperActive(
  status: DesktopDynamicWallpaperStatus | null,
): status is DesktopDynamicWallpaperStatus {
  if (!status) return false
  return status.preferences.enabled
    && status.unavailable === null
    && hasDynamicWallpaperSource(status.preferences)
}

/**
 * Paints the dynamic wallpaper on the document root. Panels opt into the same
 * translucent treatment as the image wallpaper; only the source attribute
 * differs, which suppresses the image pseudo-element.
 */
export function applyDynamicWallpaper(
  preferences: DesktopDynamicWallpaperPreferences,
): void {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  root.setAttribute(WALLPAPER_ATTRIBUTE, 'on')
  root.setAttribute(WALLPAPER_SOURCE_ATTRIBUTE, preferences.kind)
  root.style.setProperty('--wallpaper-focus-x', `${preferences.focusX}%`)
  root.style.setProperty('--wallpaper-focus-y', `${preferences.focusY}%`)
  root.style.setProperty('--wallpaper-zoom', String(preferences.zoom / 100))
  root.style.setProperty('--wallpaper-blur', `${preferences.blur}px`)
  root.style.setProperty(
    '--wallpaper-panel-alpha',
    String(preferences.panelOpacity / 100),
  )
}

export function clearDynamicWallpaper(): void {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  const source = root.getAttribute(WALLPAPER_SOURCE_ATTRIBUTE)
  if (source !== 'video' && source !== 'web') return
  root.removeAttribute(WALLPAPER_SOURCE_ATTRIBUTE)
  root.removeAttribute(WALLPAPER_ATTRIBUTE)
  for (const name of WALLPAPER_VARIABLES) {
    root.style.removeProperty(name)
  }
}