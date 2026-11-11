import { create } from 'zustand'
import { getDesktopHost } from '@/lib/desktopHost'
import {
  DEFAULT_DYNAMIC_WALLPAPER_STATUS,
} from '@/lib/dynamicWallpaper'
import type {
  DesktopDynamicWallpaperPickOptions,
  DesktopDynamicWallpaperPickResult,
  DesktopDynamicWallpaperStatus,
  DesktopDynamicWallpaperUpdate,
} from '@/lib/desktopHost/types'

type DynamicWallpaperState = {
  status: DesktopDynamicWallpaperStatus
  loaded: boolean
  loading: boolean
  error: string | null
  hydrate: () => Promise<void>
  update: (patch: DesktopDynamicWallpaperUpdate) => Promise<void>
  pickVideo: (options?: DesktopDynamicWallpaperPickOptions) => Promise<void>
  pickWeb: (options?: DesktopDynamicWallpaperPickOptions) => Promise<void>
  clearSource: () => Promise<void>
  reload: () => Promise<void>
  clearError: () => void
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function supportsDynamicWallpaper(): boolean {
  return getDesktopHost().capabilities.dynamicWallpaper === true
}

export const useDynamicWallpaperStore = create<DynamicWallpaperState>((set) => {
  async function run(operation: () => Promise<DesktopDynamicWallpaperStatus>) {
    set({ loading: true, error: null })
    try {
      set({ status: await operation() })
    } catch (error) {
      set({ error: messageOf(error) })
    } finally {
      set({ loading: false })
    }
  }

  async function pick(
    operation: () => Promise<DesktopDynamicWallpaperPickResult>,
  ) {
    set({ loading: true, error: null })
    try {
      const result = await operation()
      set({ status: result.status })
      if (result.error) set({ error: result.error })
    } catch (error) {
      set({ error: messageOf(error) })
    } finally {
      set({ loading: false })
    }
  }

  return {
    status: DEFAULT_DYNAMIC_WALLPAPER_STATUS,
    loaded: false,
    loading: false,
    error: null,

    async hydrate() {
      if (!supportsDynamicWallpaper()) {
        set({ status: DEFAULT_DYNAMIC_WALLPAPER_STATUS, loaded: true })
        return
      }
      set({ loading: true, error: null })
      try {
        const status = await getDesktopHost().dynamicWallpaper.get()
        set({ status, loaded: true })
      } catch (error) {
        set({ error: messageOf(error), loaded: true })
      } finally {
        set({ loading: false })
      }
    },

    async update(patch) {
      if (!supportsDynamicWallpaper()) return
      await run(() => getDesktopHost().dynamicWallpaper.update(patch))
    },

    async pickVideo(options) {
      if (!supportsDynamicWallpaper()) return
      await pick(() => getDesktopHost().dynamicWallpaper.pickVideo(options))
    },

    async pickWeb(options) {
      if (!supportsDynamicWallpaper()) return
      await pick(() => getDesktopHost().dynamicWallpaper.pickWeb(options))
    },

    async clearSource() {
      if (!supportsDynamicWallpaper()) return
      await run(() => getDesktopHost().dynamicWallpaper.clear())
    },

    async reload() {
      if (!supportsDynamicWallpaper()) return
      await run(() => getDesktopHost().dynamicWallpaper.reload())
    },

    clearError() {
      set({ error: null })
    },
  }
})