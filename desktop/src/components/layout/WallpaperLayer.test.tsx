import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DesktopDynamicWallpaperStatus } from '@/lib/desktopHost/types'
import {
  DEFAULT_DYNAMIC_WALLPAPER_PREFERENCES,
  DEFAULT_DYNAMIC_WALLPAPER_STATUS,
} from '@/lib/dynamicWallpaper'
import { DEFAULT_DESKTOP_WALLPAPER, useWallpaperStore } from '@/stores/wallpaperStore'
import { useDynamicWallpaperStore } from '@/stores/dynamicWallpaperStore'
import { WallpaperLayer } from './WallpaperLayer'

function status(
  patch: Partial<DesktopDynamicWallpaperStatus['preferences']> = {},
  unavailable: DesktopDynamicWallpaperStatus['unavailable'] = null,
): DesktopDynamicWallpaperStatus {
  return {
    preferences: { ...DEFAULT_DYNAMIC_WALLPAPER_PREFERENCES, ...patch },
    unavailable,
  }
}

function setDynamic(next: DesktopDynamicWallpaperStatus) {
  useDynamicWallpaperStore.setState({ status: next })
}

describe('WallpaperLayer', () => {
  beforeEach(() => {
    useDynamicWallpaperStore.setState({ status: DEFAULT_DYNAMIC_WALLPAPER_STATUS })
    useWallpaperStore.setState({ preferences: DEFAULT_DESKTOP_WALLPAPER, objectUrl: null })
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined)
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined)
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    const root = document.documentElement
    for (const name of ['data-wallpaper', 'data-wallpaper-source', 'data-theme']) {
      root.removeAttribute(name)
    }
    for (const name of [
      '--wallpaper-focus-x',
      '--wallpaper-focus-y',
      '--wallpaper-zoom',
      '--wallpaper-blur',
      '--wallpaper-panel-alpha',
      '--wallpaper-image',
    ]) {
      root.style.removeProperty(name)
    }
  })

  it('renders nothing for the static image wallpaper', () => {
    setDynamic(status({ kind: 'image', enabled: true }))

    render(<WallpaperLayer />)

    expect(screen.queryByTestId('wallpaper-media-layer')).not.toBeInTheDocument()
    expect(document.documentElement.hasAttribute('data-wallpaper-source')).toBe(false)
  })

  it('hosts the configured video on a protocol URL and publishes the shared options', async () => {
    setDynamic(status({
      kind: 'video',
      enabled: true,
      videoPath: '/clips/loop.mp4',
      revision: 4,
      focusX: 25,
      focusY: 75,
      zoom: 150,
    }))

    render(<WallpaperLayer />)

    const video = await screen.findByTestId('wallpaper-video')
    expect(video).toHaveAttribute('src', 'cc-wallpaper://video/stream?rev=4')
    expect(video).toHaveAttribute('loop')
    expect(video).toHaveStyle({ objectPosition: '25% 75%' })
    expect(video).toHaveProperty('muted', true)

    const root = document.documentElement
    expect(root.getAttribute('data-wallpaper')).toBe('on')
    expect(root.getAttribute('data-wallpaper-source')).toBe('video')
    expect(root.style.getPropertyValue('--wallpaper-zoom')).toBe('1.5')
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalled()
  })

  it('pauses on blur and resumes on focus', async () => {
    setDynamic(status({ kind: 'video', enabled: true, videoPath: '/clips/loop.mp4' }))
    render(<WallpaperLayer />)
    await screen.findByTestId('wallpaper-video')

    vi.mocked(document.hasFocus).mockReturnValue(false)
    fireEvent.blur(window)
    expect(HTMLMediaElement.prototype.pause).toHaveBeenCalled()

    vi.mocked(document.hasFocus).mockReturnValue(true)
    fireEvent.focus(window)
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(2)
  })

  it('sandboxes the web pack and forwards playback state to it', async () => {
    setDynamic(status({
      kind: 'web',
      enabled: true,
      webDir: '/packs/aurora',
      revision: 2,
    }))

    render(<WallpaperLayer />)

    const frame = await screen.findByTestId<HTMLIFrameElement>('wallpaper-web-pack')
    expect(frame).toHaveAttribute('src', 'cc-wallpaper://pack/index.html?rev=2')
    expect(frame).toHaveAttribute('sandbox', 'allow-scripts')

    const postMessage = vi.spyOn(frame.contentWindow as Window, 'postMessage')
    fireEvent.load(frame)

    expect(postMessage).toHaveBeenCalledWith(
      { type: 'cc-wallpaper:state', playing: true },
      '*',
    )
    expect(document.documentElement.getAttribute('data-wallpaper-source')).toBe('web')
  })

  it('does not paint a source that is enabled but unavailable', async () => {
    setDynamic(
      status({ kind: 'video', enabled: true, videoPath: '/clips/loop.mp4' }, 'video-missing'),
    )

    render(<WallpaperLayer />)

    await waitFor(() =>
      expect(screen.queryByTestId('wallpaper-media-layer')).not.toBeInTheDocument(),
    )
    expect(document.documentElement.hasAttribute('data-wallpaper')).toBe(false)
    expect(document.documentElement.hasAttribute('data-wallpaper-source')).toBe(false)
  })

  it('tears the dynamic layer down when the selection returns to an image', async () => {
    setDynamic(status({ kind: 'video', enabled: true, videoPath: '/clips/loop.mp4' }))
    render(<WallpaperLayer />)
    await screen.findByTestId('wallpaper-video')

    act(() => {
      setDynamic(status({ kind: 'image' }))
    })

    await waitFor(() =>
      expect(screen.queryByTestId('wallpaper-video')).not.toBeInTheDocument(),
    )
    expect(document.documentElement.hasAttribute('data-wallpaper-source')).toBe(false)
  })
})