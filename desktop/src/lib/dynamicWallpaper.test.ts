import { afterEach, describe, expect, it } from 'vitest'
import type { DesktopDynamicWallpaperStatus } from './desktopHost/types'
import {
  DEFAULT_DYNAMIC_WALLPAPER_PREFERENCES,
  applyDynamicWallpaper,
  clearDynamicWallpaper,
  hasDynamicWallpaperSource,
  isDynamicWallpaperActive,
  videoWallpaperUrl,
  webWallpaperUrl,
} from './dynamicWallpaper'

function status(patch: Partial<DesktopDynamicWallpaperStatus['preferences']> = {}, unavailable: DesktopDynamicWallpaperStatus['unavailable'] = null): DesktopDynamicWallpaperStatus {
  return {
    preferences: { ...DEFAULT_DYNAMIC_WALLPAPER_PREFERENCES, ...patch },
    unavailable,
  }
}

afterEach(clearDynamicWallpaper)

describe('dynamic wallpaper helpers', () => {
  it('builds protocol URLs that carry the revision', () => {
    expect(videoWallpaperUrl(3)).toBe('cc-wallpaper://video/stream?rev=3')
    expect(webWallpaperUrl(7)).toBe('cc-wallpaper://pack/index.html?rev=7')
  })

  it('requires an enabled source that is still readable', () => {
    expect(isDynamicWallpaperActive(status())).toBe(false)
    expect(isDynamicWallpaperActive(status({ kind: 'video', enabled: true, videoPath: '/v.mp4' }))).toBe(true)
    expect(isDynamicWallpaperActive(status({
      kind: 'video',
      enabled: true,
      videoPath: '/v.mp4',
    }, 'video-missing'))).toBe(false)
    expect(isDynamicWallpaperActive(status({ kind: 'web', enabled: true, webDir: '/pack' }))).toBe(true)
    expect(hasDynamicWallpaperSource(DEFAULT_DYNAMIC_WALLPAPER_PREFERENCES)).toBe(false)
  })

  it('publishes focus, zoom, blur, and panel alpha on the document root', () => {
    applyDynamicWallpaper({
      ...DEFAULT_DYNAMIC_WALLPAPER_PREFERENCES,
      kind: 'web',
      enabled: true,
      webDir: '/pack',
      focusX: 25,
      focusY: 75,
      zoom: 180,
      blur: 6,
      panelOpacity: 70,
    })

    const root = document.documentElement
    expect(root.getAttribute('data-wallpaper')).toBe('on')
    expect(root.getAttribute('data-wallpaper-source')).toBe('web')
    expect(root.style.getPropertyValue('--wallpaper-focus-x')).toBe('25%')
    expect(root.style.getPropertyValue('--wallpaper-focus-y')).toBe('75%')
    expect(root.style.getPropertyValue('--wallpaper-zoom')).toBe('1.8')
    expect(root.style.getPropertyValue('--wallpaper-blur')).toBe('6px')
    expect(root.style.getPropertyValue('--wallpaper-panel-alpha')).toBe('0.7')
  })

  it('clears only the dynamic layer', () => {
    applyDynamicWallpaper({
      ...DEFAULT_DYNAMIC_WALLPAPER_PREFERENCES,
      kind: 'video',
      enabled: true,
      videoPath: '/v.mp4',
    })
    const root = document.documentElement
    root.setAttribute('data-theme', 'white')

    clearDynamicWallpaper()

    expect(root.hasAttribute('data-wallpaper')).toBe(false)
    expect(root.hasAttribute('data-wallpaper-source')).toBe(false)
    expect(root.style.getPropertyValue('--wallpaper-zoom')).toBe('')
    expect(root.getAttribute('data-theme')).toBe('white')
  })

  it('does nothing when the image wallpaper owns the background', () => {
    const root = document.documentElement
    root.setAttribute('data-wallpaper', 'on')
    root.style.setProperty('--wallpaper-zoom', '1.2')

    clearDynamicWallpaper()

    expect(root.getAttribute('data-wallpaper')).toBe('on')
    expect(root.style.getPropertyValue('--wallpaper-zoom')).toBe('1.2')
    root.removeAttribute('data-wallpaper')
    root.style.removeProperty('--wallpaper-zoom')
  })
})