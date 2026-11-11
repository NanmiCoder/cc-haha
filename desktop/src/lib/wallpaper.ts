import type { DesktopWallpaperPreferences } from '../api/desktopUiPreferences'

export const MAX_WALLPAPER_EDGE = 2560
export const WALLPAPER_JPEG_QUALITY = 0.85
export const WALLPAPER_ACCEPT = 'image/png,image/jpeg,image/webp'
const SUPPORTED_WALLPAPER_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp'])
const WALLPAPER_ATTRIBUTE = 'data-wallpaper'
const WALLPAPER_VARIABLES = [
  '--wallpaper-image',
  '--wallpaper-focus-x',
  '--wallpaper-focus-y',
  '--wallpaper-zoom',
  '--wallpaper-blur',
  '--wallpaper-panel-alpha',
] as const

export function isSupportedWallpaperFile(file: Pick<File, 'type'>): boolean {
  return SUPPORTED_WALLPAPER_TYPES.has(file.type)
}

/** Scale to the longest edge without ever upscaling a smaller source. */
export function computeWallpaperDimensions(
  width: number,
  height: number,
  maxEdge = MAX_WALLPAPER_EDGE,
): { width: number; height: number } {
  if (width <= 0 || height <= 0) return { width: 0, height: 0 }
  const scale = Math.min(1, maxEdge / Math.max(width, height))
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  }
}

export async function compressWallpaper(file: File): Promise<File> {
  if (!isSupportedWallpaperFile(file)) {
    throw new Error('Unsupported wallpaper image type')
  }

  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
  try {
    const { width, height } = computeWallpaperDimensions(bitmap.width, bitmap.height)
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d')
    if (!context) throw new Error('Unable to prepare wallpaper canvas')
    context.drawImage(bitmap, 0, 0, width, height)

    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob(resolve, 'image/jpeg', WALLPAPER_JPEG_QUALITY)
    })
    if (!blob) throw new Error('Unable to encode wallpaper image')
    return new File([blob], 'wallpaper.jpg', { type: 'image/jpeg' })
  } finally {
    bitmap.close()
  }
}

/**
 * Publish wallpaper settings to the document root. The CSS only paints while
 * `data-wallpaper="on"`; clearing the attribute returns the plain theme.
 * The active theme stays in charge of every foreground colour.
 */
export type AppliedWallpaperPreferences = Pick<
  DesktopWallpaperPreferences,
  'enabled' | 'focusX' | 'focusY' | 'zoom' | 'blur' | 'panelOpacity'
>

export function applyWallpaper(
  preferences: AppliedWallpaperPreferences | null,
  objectUrl: string | null,
): void {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  if (!preferences?.enabled || !objectUrl) {
    clearWallpaper()
    return
  }

  root.setAttribute(WALLPAPER_ATTRIBUTE, 'on')
  root.style.setProperty('--wallpaper-image', `url("${objectUrl}")`)
  root.style.setProperty('--wallpaper-focus-x', `${preferences.focusX}%`)
  root.style.setProperty('--wallpaper-focus-y', `${preferences.focusY}%`)
  root.style.setProperty('--wallpaper-zoom', String(preferences.zoom / 100))
  root.style.setProperty('--wallpaper-blur', `${preferences.blur}px`)
  root.style.setProperty(
    '--wallpaper-panel-alpha',
    String(preferences.panelOpacity / 100),
  )
}

export function clearWallpaper(): void {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  root.removeAttribute(WALLPAPER_ATTRIBUTE)
  for (const name of WALLPAPER_VARIABLES) {
    root.style.removeProperty(name)
  }
}

