import { afterEach, describe, expect, it } from 'vitest'
import {
  applyWallpaper,
  clearWallpaper,
  compressWallpaper,
  computeWallpaperDimensions,
  isSupportedWallpaperFile,
  MAX_WALLPAPER_EDGE,
} from './wallpaper'

describe('computeWallpaperDimensions', () => {
  it('scales the longest edge down to the maximum without upscaling', () => {
    expect(computeWallpaperDimensions(5120, 2880)).toEqual({ width: 2560, height: 1440 })
    expect(computeWallpaperDimensions(2880, 5120)).toEqual({ width: 1440, height: 2560 })
    expect(computeWallpaperDimensions(1920, 1080)).toEqual({ width: 1920, height: 1080 })
    expect(computeWallpaperDimensions(800, 600)).toEqual({ width: 800, height: 600 })
    expect(computeWallpaperDimensions(5000, 5000)).toEqual({ width: MAX_WALLPAPER_EDGE, height: MAX_WALLPAPER_EDGE })
  })

  it('returns zero for invalid sources', () => {
    expect(computeWallpaperDimensions(0, 1080)).toEqual({ width: 0, height: 0 })
    expect(computeWallpaperDimensions(-1, 10)).toEqual({ width: 0, height: 0 })
  })
})

describe('isSupportedWallpaperFile', () => {
  it('accepts the three managed image types only', () => {
    expect(isSupportedWallpaperFile({ type: 'image/png' })).toBe(true)
    expect(isSupportedWallpaperFile({ type: 'image/jpeg' })).toBe(true)
    expect(isSupportedWallpaperFile({ type: 'image/webp' })).toBe(true)
    expect(isSupportedWallpaperFile({ type: 'image/gif' })).toBe(false)
    expect(isSupportedWallpaperFile({ type: '' })).toBe(false)
  })
})

describe('compressWallpaper', () => {
  it('rejects unsupported files before decoding them', async () => {
    const file = new File([new Uint8Array([1, 2, 3])], 'wallpaper.gif', { type: 'image/gif' })
    await expect(compressWallpaper(file)).rejects.toThrow('Unsupported wallpaper image type')
  })
})

describe('applyWallpaper', () => {
  afterEach(clearWallpaper)

  it('publishes the image, focal point, and controls on the document root', () => {
    applyWallpaper(
      { enabled: true, focusX: 30, focusY: 70, zoom: 150, blur: 12, panelOpacity: 77 },
      'blob:wallpaper-1',
    )

    const root = document.documentElement
    expect(root.getAttribute('data-wallpaper')).toBe('on')
    expect(root.style.getPropertyValue('--wallpaper-image')).toBe('url("blob:wallpaper-1")')
    expect(root.style.getPropertyValue('--wallpaper-fit')).toBe('')
    expect(root.style.getPropertyValue('--wallpaper-focus-x')).toBe('30%')
    expect(root.style.getPropertyValue('--wallpaper-focus-y')).toBe('70%')
    expect(root.style.getPropertyValue('--wallpaper-zoom')).toBe('1.5')
    expect(root.style.getPropertyValue('--wallpaper-blur')).toBe('12px')
    expect(root.style.getPropertyValue('--wallpaper-panel-alpha')).toBe('0.77')
  })

  it('never overrides the active theme with a wallpaper-derived tone', () => {
    applyWallpaper(
      { enabled: true, focusX: 50, focusY: 50, zoom: 100, blur: 8, panelOpacity: 88 },
      'blob:wallpaper-1',
    )
    expect(document.documentElement.hasAttribute('data-wallpaper-tone')).toBe(false)
  })

  it('clears the layer when wallpaper is disabled or the image is missing', () => {
    const settings = { enabled: true, focusX: 50, focusY: 50, zoom: 100, blur: 12, panelOpacity: 77 } as const
    applyWallpaper(settings, 'blob:wallpaper-1')
    applyWallpaper({ ...settings, enabled: false }, 'blob:wallpaper-1')

    const root = document.documentElement
    expect(root.hasAttribute('data-wallpaper')).toBe(false)
    expect(root.style.getPropertyValue('--wallpaper-image')).toBe('')
    expect(root.style.getPropertyValue('--wallpaper-focus-x')).toBe('')
    expect(root.style.getPropertyValue('--wallpaper-zoom')).toBe('')
  })

  it('clears the layer when no object URL is available', () => {
    applyWallpaper(
      { enabled: true, focusX: 50, focusY: 50, zoom: 100, blur: 12, panelOpacity: 77 },
      null,
    )
    expect(document.documentElement.hasAttribute('data-wallpaper')).toBe(false)
  })

  it('never paints over an active video or web pack', () => {
    const root = document.documentElement
    root.setAttribute('data-wallpaper', 'on')
    root.setAttribute('data-wallpaper-source', 'video')
    root.style.setProperty('--wallpaper-zoom', '1.3')

    applyWallpaper(
      { enabled: true, focusX: 30, focusY: 70, zoom: 150, blur: 12, panelOpacity: 77 },
      'blob:wallpaper-1',
    )
    clearWallpaper()

    expect(root.getAttribute('data-wallpaper')).toBe('on')
    expect(root.style.getPropertyValue('--wallpaper-image')).toBe('')
    expect(root.style.getPropertyValue('--wallpaper-zoom')).toBe('1.3')
    root.removeAttribute('data-wallpaper')
    root.removeAttribute('data-wallpaper-source')
    root.style.removeProperty('--wallpaper-zoom')
  })
})