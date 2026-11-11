import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DesktopUiPreferences, DesktopWallpaperPreferences } from '@/api/desktopUiPreferences'

const api = vi.hoisted(() => ({
  getWallpaperImage: vi.fn(),
  updateWallpaperPreferences: vi.fn(),
  uploadWallpaper: vi.fn(),
  deleteWallpaperImage: vi.fn(),
}))

const compressWallpaper = vi.hoisted(() => vi.fn())

vi.mock('@/api/desktopUiPreferences', () => ({ desktopUiPreferencesApi: api }))
vi.mock('@/lib/wallpaper', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/wallpaper')>()
  return { ...original, compressWallpaper }
})

import { DEFAULT_DESKTOP_WALLPAPER, useWallpaperStore } from './wallpaperStore'

const preferences = {} as DesktopUiPreferences

function wallpaper(patch: Partial<DesktopWallpaperPreferences> = {}): DesktopWallpaperPreferences {
  return { ...DEFAULT_DESKTOP_WALLPAPER, ...patch }
}

function createObjectUrlSpy() {
  let counter = 0
  const create = vi.fn(() => `blob:wallpaper-${++counter}`)
  const revoke = vi.fn()
  vi.stubGlobal('URL', { ...URL, createObjectURL: create, revokeObjectURL: revoke })
  return { create, revoke }
}

describe('wallpaperStore', () => {
  beforeEach(() => {
    useWallpaperStore.setState({
      preferences: DEFAULT_DESKTOP_WALLPAPER,
      objectUrl: null,
      loading: false,
      error: null,
    })
    vi.clearAllMocks()
    document.documentElement.removeAttribute('data-wallpaper')
    document.documentElement.removeAttribute('data-wallpaper-tone')
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('hydrates an enabled wallpaper through an authenticated blob URL', async () => {
    const { create } = createObjectUrlSpy()
    api.getWallpaperImage.mockResolvedValue(new Blob(['image'], { type: 'image/png' }))

    await useWallpaperStore.getState().hydrate(wallpaper({ enabled: true, file: 'wallpaper.png' }))

    expect(create).toHaveBeenCalledTimes(1)
    expect(useWallpaperStore.getState().objectUrl).toBe('blob:wallpaper-1')
    expect(document.documentElement.getAttribute('data-wallpaper')).toBe('on')
    expect(document.documentElement.style.getPropertyValue('--wallpaper-image')).toBe('url("blob:wallpaper-1")')
  })

  it('leaves the theme palette alone when painting the wallpaper', async () => {
    createObjectUrlSpy()
    api.getWallpaperImage.mockResolvedValue(new Blob(['image'], { type: 'image/png' }))

    await useWallpaperStore.getState().hydrate(wallpaper({ enabled: true, file: 'wallpaper.png' }))

    expect(document.documentElement.hasAttribute('data-wallpaper-tone')).toBe(false)
  })

  it('still loads a disabled image so settings can preview it without painting the layer', async () => {
    const { create } = createObjectUrlSpy()
    api.getWallpaperImage.mockResolvedValue(new Blob(['image'], { type: 'image/png' }))

    await useWallpaperStore.getState().hydrate(wallpaper({ enabled: false, file: 'wallpaper.png' }))

    expect(create).toHaveBeenCalledTimes(1)
    expect(useWallpaperStore.getState().objectUrl).toBe('blob:wallpaper-1')
    expect(document.documentElement.hasAttribute('data-wallpaper')).toBe(false)
  })

  it('keeps preferences and reports an error when the image cannot be loaded', async () => {
    createObjectUrlSpy()
    api.getWallpaperImage.mockRejectedValue(new Error('Wallpaper image is not configured'))

    await useWallpaperStore.getState().hydrate(wallpaper({ enabled: true, file: 'wallpaper.png' }))

    expect(useWallpaperStore.getState().preferences.file).toBe('wallpaper.png')
    expect(useWallpaperStore.getState().error).toBe('Wallpaper image is not configured')
    expect(useWallpaperStore.getState().objectUrl).toBeNull()
    expect(document.documentElement.hasAttribute('data-wallpaper')).toBe(false)
  })

  it('applies a patched option immediately', async () => {
    createObjectUrlSpy()
    api.getWallpaperImage.mockResolvedValue(new Blob(['image'], { type: 'image/png' }))
    await useWallpaperStore.getState().hydrate(wallpaper({ enabled: true, file: 'wallpaper.png' }))
    api.updateWallpaperPreferences.mockResolvedValue({
      ok: true,
      preferences,
      wallpaper: wallpaper({
        enabled: true,
        file: 'wallpaper.png',
        focusX: 35,
        focusY: 65,
        zoom: 175,
        blur: 4,
        panelOpacity: 70,
      }),
    })

    await useWallpaperStore.getState().setOption({ focusX: 35, focusY: 65, zoom: 175, blur: 4, panelOpacity: 70 })

    expect(api.updateWallpaperPreferences).toHaveBeenCalledWith({
      focusX: 35,
      focusY: 65,
      zoom: 175,
      blur: 4,
      panelOpacity: 70,
    })
    expect(document.documentElement.style.getPropertyValue('--wallpaper-focus-x')).toBe('35%')
    expect(document.documentElement.style.getPropertyValue('--wallpaper-focus-y')).toBe('65%')
    expect(document.documentElement.style.getPropertyValue('--wallpaper-zoom')).toBe('1.75')
    expect(document.documentElement.style.getPropertyValue('--wallpaper-blur')).toBe('4px')
    expect(document.documentElement.style.getPropertyValue('--wallpaper-panel-alpha')).toBe('0.7')
  })

  it('compresses, uploads, enables, and swaps in the new image', async () => {
    const { revoke } = createObjectUrlSpy()
    const compressed = new File(['jpeg'], 'wallpaper.jpg', { type: 'image/jpeg' })
    compressWallpaper.mockResolvedValue(compressed)
    api.uploadWallpaper.mockResolvedValue({
      ok: true,
      preferences: { ...preferences, wallpaper: wallpaper({ enabled: false, file: 'wallpaper.jpg' }) },
    })
    api.updateWallpaperPreferences.mockResolvedValue({
      ok: true,
      preferences,
      wallpaper: wallpaper({ enabled: true, file: 'wallpaper.jpg' }),
    })
    api.getWallpaperImage.mockResolvedValue(new Blob(['image'], { type: 'image/jpeg' }))

    useWallpaperStore.setState({ objectUrl: 'blob:old' })
    await useWallpaperStore.getState().upload(new File(['source'], 'source.png', { type: 'image/png' }))

    expect(compressWallpaper).toHaveBeenCalledTimes(1)
    expect(api.uploadWallpaper).toHaveBeenCalledWith(compressed)
    expect(api.updateWallpaperPreferences).toHaveBeenCalledWith({ enabled: true })
    expect(revoke).toHaveBeenCalledWith('blob:old')
    expect(useWallpaperStore.getState().preferences.enabled).toBe(true)
    expect(useWallpaperStore.getState().objectUrl).toBe('blob:wallpaper-1')
    expect(document.documentElement.getAttribute('data-wallpaper')).toBe('on')
  })

  it('removes the image, revokes the object URL, and clears the layer', async () => {
    const { revoke } = createObjectUrlSpy()
    useWallpaperStore.setState({
      preferences: wallpaper({ enabled: true, file: 'wallpaper.png' }),
      objectUrl: 'blob:old',
    })
    api.deleteWallpaperImage.mockResolvedValue({ ok: true, preferences: { ...preferences, wallpaper: wallpaper() } })

    await useWallpaperStore.getState().remove()

    expect(revoke).toHaveBeenCalledWith('blob:old')
    expect(useWallpaperStore.getState().objectUrl).toBeNull()
    expect(useWallpaperStore.getState().preferences).toEqual(wallpaper())
    expect(document.documentElement.hasAttribute('data-wallpaper')).toBe(false)
  })
})