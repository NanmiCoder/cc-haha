import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  DesktopDynamicWallpaperPickResult,
  DesktopDynamicWallpaperStatus,
} from '@/lib/desktopHost/types'
import {
  DEFAULT_DYNAMIC_WALLPAPER_PREFERENCES,
  DEFAULT_DYNAMIC_WALLPAPER_STATUS,
} from '@/lib/dynamicWallpaper'

const host = vi.hoisted(() => ({
  capabilities: { dynamicWallpaper: true },
  dynamicWallpaper: {
    get: vi.fn(),
    update: vi.fn(),
    pickVideo: vi.fn(),
    pickWeb: vi.fn(),
    clear: vi.fn(),
    reload: vi.fn(),
  },
}))

vi.mock('@/lib/desktopHost', () => ({ getDesktopHost: () => host }))

import { useDynamicWallpaperStore } from './dynamicWallpaperStore'

function status(
  patch: Partial<DesktopDynamicWallpaperStatus['preferences']> = {},
  unavailable: DesktopDynamicWallpaperStatus['unavailable'] = null,
): DesktopDynamicWallpaperStatus {
  return {
    preferences: { ...DEFAULT_DYNAMIC_WALLPAPER_PREFERENCES, ...patch },
    unavailable,
  }
}

function picked(
  next: DesktopDynamicWallpaperStatus,
  error: DesktopDynamicWallpaperPickResult['error'] = null,
): DesktopDynamicWallpaperPickResult {
  return { canceled: false, status: next, error }
}

describe('dynamicWallpaperStore', () => {
  beforeEach(() => {
    host.capabilities.dynamicWallpaper = true
    vi.clearAllMocks()
    useDynamicWallpaperStore.setState({
      status: DEFAULT_DYNAMIC_WALLPAPER_STATUS,
      loaded: false,
      loading: false,
      error: null,
    })
  })

  it('hydrates the status from the host', async () => {
    host.dynamicWallpaper.get.mockResolvedValue(
      status({ kind: 'video', enabled: true, videoPath: '/clips/loop.mp4', videoName: 'loop.mp4' }),
    )

    await useDynamicWallpaperStore.getState().hydrate()

    const state = useDynamicWallpaperStore.getState()
    expect(state.status.preferences.videoName).toBe('loop.mp4')
    expect(state.loaded).toBe(true)
    expect(state.loading).toBe(false)
  })

  it('stays on defaults when the host has no dynamic wallpaper support', async () => {
    host.capabilities.dynamicWallpaper = false

    await useDynamicWallpaperStore.getState().hydrate()
    await useDynamicWallpaperStore.getState().update({ enabled: true })
    await useDynamicWallpaperStore.getState().pickVideo()
    await useDynamicWallpaperStore.getState().clearSource()

    expect(host.dynamicWallpaper.get).not.toHaveBeenCalled()
    expect(host.dynamicWallpaper.update).not.toHaveBeenCalled()
    expect(host.dynamicWallpaper.pickVideo).not.toHaveBeenCalled()
    expect(host.dynamicWallpaper.clear).not.toHaveBeenCalled()
    expect(useDynamicWallpaperStore.getState().status).toEqual(DEFAULT_DYNAMIC_WALLPAPER_STATUS)
    expect(useDynamicWallpaperStore.getState().loaded).toBe(true)
  })

  it('reports hydrate failures without dropping the borrowed defaults', async () => {
    host.dynamicWallpaper.get.mockRejectedValue(new Error('ipc unavailable'))

    await useDynamicWallpaperStore.getState().hydrate()

    expect(useDynamicWallpaperStore.getState().error).toBe('ipc unavailable')
    expect(useDynamicWallpaperStore.getState().status).toEqual(DEFAULT_DYNAMIC_WALLPAPER_STATUS)
    expect(useDynamicWallpaperStore.getState().loaded).toBe(true)
  })

  it('applies an update result and clears the previous error', async () => {
    useDynamicWallpaperStore.setState({ error: 'stale' })
    host.dynamicWallpaper.update.mockResolvedValue(status({ enabled: true, zoom: 150 }))

    await useDynamicWallpaperStore.getState().update({ enabled: true, zoom: 150 })

    expect(host.dynamicWallpaper.update).toHaveBeenCalledWith({ enabled: true, zoom: 150 })
    expect(useDynamicWallpaperStore.getState().status.preferences.zoom).toBe(150)
    expect(useDynamicWallpaperStore.getState().error).toBeNull()
  })

  it('records pick results and surfaces a missing web entry', async () => {
    host.dynamicWallpaper.pickWeb.mockResolvedValue(
      picked(status({ kind: 'web' }), 'web-index-missing'),
    )

    await useDynamicWallpaperStore.getState().pickWeb({ dialogTitle: 'Choose folder' })

    expect(host.dynamicWallpaper.pickWeb).toHaveBeenCalledWith({ dialogTitle: 'Choose folder' })
    expect(useDynamicWallpaperStore.getState().status.preferences.kind).toBe('web')
    expect(useDynamicWallpaperStore.getState().error).toBe('web-index-missing')
  })

  it('keeps the current status when a pick is canceled', async () => {
    const current = status({ kind: 'video', enabled: true, videoPath: '/clips/loop.mp4' })
    useDynamicWallpaperStore.setState({ status: current })
    host.dynamicWallpaper.pickVideo.mockResolvedValue({ canceled: true, status: current, error: null })

    await useDynamicWallpaperStore.getState().pickVideo()

    expect(useDynamicWallpaperStore.getState().status).toEqual(current)
    expect(useDynamicWallpaperStore.getState().error).toBeNull()
  })

  it('clears and reloads the source through the host', async () => {
    host.dynamicWallpaper.clear.mockResolvedValue(status())
    host.dynamicWallpaper.reload.mockResolvedValue(status({ kind: 'web', revision: 3 }))

    await useDynamicWallpaperStore.getState().clearSource()
    await useDynamicWallpaperStore.getState().reload()

    expect(host.dynamicWallpaper.clear).toHaveBeenCalledTimes(1)
    expect(host.dynamicWallpaper.reload).toHaveBeenCalledTimes(1)
    expect(useDynamicWallpaperStore.getState().status.preferences.revision).toBe(3)
  })

  it('captures host failures as text and stops the spinner', async () => {
    host.dynamicWallpaper.update.mockRejectedValue(new Error('dialog failed'))

    await useDynamicWallpaperStore.getState().update({ kind: 'video' })

    expect(useDynamicWallpaperStore.getState().error).toBe('dialog failed')
    expect(useDynamicWallpaperStore.getState().loading).toBe(false)
  })
})