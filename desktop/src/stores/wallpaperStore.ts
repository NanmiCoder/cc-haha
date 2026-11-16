import { create } from 'zustand'
import {
  desktopUiPreferencesApi,
  type DesktopWallpaperPreferences,
} from '@/api/desktopUiPreferences'
import {
  applyWallpaper,
  clearWallpaper,
  compressWallpaper,
} from '@/lib/wallpaper'

export const DEFAULT_DESKTOP_WALLPAPER: DesktopWallpaperPreferences = {
  enabled: false,
  focusX: 50,
  focusY: 50,
  zoom: 100,
  blur: 8,
  panelOpacity: 88,
  file: null,
  updatedAt: null,
}

type WallpaperOptions = Pick<
  DesktopWallpaperPreferences,
  'enabled' | 'focusX' | 'focusY' | 'zoom' | 'blur' | 'panelOpacity'
>

type WallpaperState = {
  preferences: DesktopWallpaperPreferences
  objectUrl: string | null
  loading: boolean
  error: string | null
  hydrate: (preferences: DesktopWallpaperPreferences | undefined) => Promise<void>
  setOption: (patch: Partial<WallpaperOptions>) => Promise<void>
  upload: (file: File) => Promise<void>
  remove: () => Promise<void>
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export const useWallpaperStore = create<WallpaperState>((set, get) => {
  function revoke(url: string | null) {
    if (url) URL.revokeObjectURL(url)
  }

  function publish(
    preferences: DesktopWallpaperPreferences,
    objectUrl: string | null,
  ) {
    set({ preferences, objectUrl })
    applyWallpaper(preferences, objectUrl)
  }

  async function loadImage(preferences: DesktopWallpaperPreferences): Promise<string | null> {
    if (!preferences.file) return null
    const blob = await desktopUiPreferencesApi.getWallpaperImage()
    return URL.createObjectURL(blob)
  }

  return {
    preferences: DEFAULT_DESKTOP_WALLPAPER,
    objectUrl: null,
    loading: false,
    error: null,

    async hydrate(preferences) {
      const next = preferences ?? DEFAULT_DESKTOP_WALLPAPER
      if (!next.file) {
        revoke(get().objectUrl)
        publish(next, null)
        return
      }

      set({ loading: true, error: null })
      try {
        const objectUrl = await loadImage(next)
        revoke(get().objectUrl)
        publish(next, objectUrl)
      } catch (error) {
        revoke(get().objectUrl)
        publish(next, null)
        set({ error: messageOf(error) })
      } finally {
        set({ loading: false })
      }
    },

    async setOption(patch) {
      set({ loading: true, error: null })
      try {
        const response = await desktopUiPreferencesApi.updateWallpaperPreferences(patch)
        const next = response.wallpaper
        const previousUrl = get().objectUrl
        let objectUrl = previousUrl
        if (next.file && !objectUrl) {
          objectUrl = await loadImage(next)
        }
        publish(next, objectUrl)
      } catch (error) {
        set({ error: messageOf(error) })
      } finally {
        set({ loading: false })
      }
    },

    async upload(file) {
      set({ loading: true, error: null })
      try {
        const compressed = await compressWallpaper(file)
        const uploaded = await desktopUiPreferencesApi.uploadWallpaper(compressed)
        let preferences = uploaded.preferences.wallpaper ?? get().preferences
        if (!preferences.enabled) {
          const enabled = await desktopUiPreferencesApi.updateWallpaperPreferences({ enabled: true })
          preferences = enabled.wallpaper
        }
        const objectUrl = await loadImage(preferences)
        revoke(get().objectUrl)
        publish(preferences, objectUrl)
      } catch (error) {
        set({ error: messageOf(error) })
      } finally {
        set({ loading: false })
      }
    },

    async remove() {
      set({ loading: true, error: null })
      try {
        const response = await desktopUiPreferencesApi.deleteWallpaperImage()
        revoke(get().objectUrl)
        set({
          preferences: response.preferences.wallpaper ?? DEFAULT_DESKTOP_WALLPAPER,
          objectUrl: null,
        })
        clearWallpaper()
      } catch (error) {
        set({ error: messageOf(error) })
      } finally {
        set({ loading: false })
      }
    },
  }
})