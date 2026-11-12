import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DesktopUiPreferences, DesktopWallpaperPreferences } from '@/api/desktopUiPreferences'
import { useSettingsStore } from '@/stores/settingsStore'

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

import { DEFAULT_DESKTOP_WALLPAPER, useWallpaperStore } from '@/stores/wallpaperStore'
import {
  DEFAULT_DYNAMIC_WALLPAPER_PREFERENCES,
  DEFAULT_DYNAMIC_WALLPAPER_STATUS,
} from '@/lib/dynamicWallpaper'
import { useDynamicWallpaperStore } from '@/stores/dynamicWallpaperStore'
import type { DesktopDynamicWallpaperStatus } from '@/lib/desktopHost/types'
import { WallpaperSettings } from './WallpaperSettings'

const preferences = {} as DesktopUiPreferences

function wallpaper(patch: Partial<DesktopWallpaperPreferences> = {}): DesktopWallpaperPreferences {
  return { ...DEFAULT_DESKTOP_WALLPAPER, ...patch }
}

function dynamicStatus(
  patch: Partial<DesktopDynamicWallpaperStatus['preferences']> = {},
  unavailable: DesktopDynamicWallpaperStatus['unavailable'] = null,
): DesktopDynamicWallpaperStatus {
  return {
    preferences: { ...DEFAULT_DYNAMIC_WALLPAPER_PREFERENCES, ...patch },
    unavailable,
  }
}

function installDynamicHost(
  initial: DesktopDynamicWallpaperStatus = DEFAULT_DYNAMIC_WALLPAPER_STATUS,
) {
  const methods = {
    get: vi.fn(),
    update: vi.fn(),
    pickVideo: vi.fn(),
    pickWeb: vi.fn(),
    clear: vi.fn(),
    reload: vi.fn(),
  }
  vi.stubGlobal('desktopHost', {
    capabilities: { dynamicWallpaper: true },
    dynamicWallpaper: methods,
  })
  useDynamicWallpaperStore.setState({
    status: initial,
    loaded: true,
    loading: false,
    error: null,
  })
  return methods
}

describe('Wallpaper settings', () => {
  beforeEach(() => {
    useSettingsStore.setState({ locale: 'en' })
    useWallpaperStore.setState({
      preferences: wallpaper(),
      objectUrl: null,
      loading: false,
      error: null,
    })
    useDynamicWallpaperStore.setState({
      status: DEFAULT_DYNAMIC_WALLPAPER_STATUS,
      loaded: false,
      loading: false,
      error: null,
    })
    vi.clearAllMocks()
    vi.stubGlobal('URL', { ...URL, createObjectURL: vi.fn(() => 'blob:wallpaper'), revokeObjectURL: vi.fn() })
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    vi.useRealTimers()
    document.documentElement.removeAttribute('data-wallpaper')
  })

  it('disables the controls until an image exists', () => {
    render(<WallpaperSettings />)

    expect(screen.getByRole('heading', { name: 'Wallpaper' })).toBeInTheDocument()
    expect(screen.getByRole('switch', { name: 'Enable wallpaper' })).toBeDisabled()
    expect(screen.getByRole('slider', { name: 'Zoom' })).toBeDisabled()
    expect(screen.getByRole('slider', { name: 'Blur' })).toBeDisabled()
    expect(screen.getByRole('slider', { name: 'Panel opacity' })).toBeDisabled()
    expect(screen.queryByRole('button', { name: 'Cover' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Contain' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Stretch' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Choose image' })).toBeInTheDocument()
    expect(screen.queryByTestId('wallpaper-preview')).not.toBeInTheDocument()
    expect(screen.queryByRole('slider', { name: 'Dim' })).not.toBeInTheDocument()
  })

  it('previews an existing image and reflects stored values', () => {
    useWallpaperStore.setState({
      preferences: wallpaper({
        file: 'wallpaper.png',
        enabled: true,
        focusX: 30,
        focusY: 70,
        zoom: 175,
        blur: 12,
        panelOpacity: 74,
      }),
      objectUrl: 'blob:preview',
    })
    render(<WallpaperSettings />)

    expect(screen.getByTestId('wallpaper-preview-image')).toHaveStyle({
      backgroundImage: 'url("blob:preview")',
      backgroundPosition: '30% 70%',
      backgroundSize: 'cover',
      transform: 'scale(1.75)',
      transformOrigin: '30% 70%',
    })
    expect(screen.getByTestId('wallpaper-focus-marker')).toHaveStyle({ left: '30%', top: '70%' })
    expect(screen.getByRole('slider', { name: 'Zoom' })).toHaveValue('175')
    expect(screen.getByRole('switch', { name: 'Enable wallpaper' })).toBeChecked()
    expect(screen.getByRole('slider', { name: 'Blur' })).toHaveValue('12')
    expect(screen.getByRole('slider', { name: 'Panel opacity' })).toHaveValue('74')
    expect(screen.getByRole('button', { name: 'Change image' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Remove' })).toBeInTheDocument()
  })

  
  it('frames the wallpaper by dragging the preview and saves once on release', async () => {
    useWallpaperStore.setState({
      preferences: wallpaper({ file: 'wallpaper.png', enabled: true, focusX: 50, focusY: 50 }),
      objectUrl: 'blob:preview',
    })
    api.updateWallpaperPreferences.mockImplementation(async (patch) => ({
      ok: true,
      preferences,
      wallpaper: wallpaper({ file: 'wallpaper.png', enabled: true, focusX: 50, focusY: 50, ...patch }),
    }))
    render(<WallpaperSettings />)

    const preview = screen.getByTestId('wallpaper-preview')
    // The preview follows the window's shape instead of a fixed short strip.
    const ratio = window.innerWidth / window.innerHeight
    expect(Number(preview.style.aspectRatio)).toBeCloseTo(ratio, 5)
    expect(parseFloat(preview.style.maxWidth)).toBeCloseTo(400 * ratio, 5)
    vi.spyOn(preview, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      top: 0,
      width: 200,
      height: 100,
      right: 200,
      bottom: 100,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    })

    // jsdom has no PointerEvent, so build pointer events from MouseEvent
    // (which carries the coordinates React reads) and give them an id.
    const pointer = (type: string, clientX: number, clientY: number) => {
      const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX, clientY })
      Object.defineProperty(event, 'pointerId', { value: 1 })
      return event
    }
    fireEvent(preview, pointer('pointerdown', 100, 50))
    fireEvent(preview, pointer('pointermove', 80, 40))

    // The image follows the pointer while dragging; nothing is saved mid-drag.
    expect(screen.getByTestId('wallpaper-preview-image')).toHaveStyle({ backgroundPosition: '60% 60%' })
    expect(screen.getByTestId('wallpaper-focus-marker')).toHaveStyle({ left: '60%', top: '60%' })
    expect(api.updateWallpaperPreferences).not.toHaveBeenCalled()

    fireEvent(preview, pointer('pointerup', 80, 40))

    await vi.waitFor(() =>
      expect(api.updateWallpaperPreferences).toHaveBeenCalledTimes(1),
    )
    expect(api.updateWallpaperPreferences).toHaveBeenCalledWith({ focusX: 60, focusY: 60 })
  })

  it('nudges the focal point with the arrow keys', async () => {
    useWallpaperStore.setState({
      preferences: wallpaper({ file: 'wallpaper.png', enabled: true, focusX: 50, focusY: 50 }),
      objectUrl: 'blob:preview',
    })
    api.updateWallpaperPreferences.mockImplementation(async (patch) => ({
      ok: true,
      preferences,
      wallpaper: wallpaper({ file: 'wallpaper.png', enabled: true, ...patch }),
    }))
    render(<WallpaperSettings />)

    fireEvent.keyDown(screen.getByTestId('wallpaper-preview'), { key: 'ArrowRight', shiftKey: true })
    await vi.waitFor(() =>
      expect(api.updateWallpaperPreferences).toHaveBeenCalledWith({ focusX: 60, focusY: 50 }),
    )
    await vi.waitFor(() => expect(useWallpaperStore.getState().preferences.focusX).toBe(60))

    fireEvent.keyDown(screen.getByTestId('wallpaper-preview'), { key: 'ArrowUp' })
    await vi.waitFor(() =>
      expect(api.updateWallpaperPreferences).toHaveBeenCalledWith({ focusX: 60, focusY: 45 }),
    )
  })

  it('saves the enable switch immediately', async () => {
    useWallpaperStore.setState({
      preferences: wallpaper({ file: 'wallpaper.png' }),
      objectUrl: 'blob:preview',
    })
    api.updateWallpaperPreferences.mockResolvedValue({
      ok: true,
      preferences,
      wallpaper: wallpaper({ file: 'wallpaper.png', enabled: true }),
    })
    render(<WallpaperSettings />)

    fireEvent.click(screen.getByRole('switch', { name: 'Enable wallpaper' }))

    await vi.waitFor(() => expect(api.updateWallpaperPreferences).toHaveBeenCalledWith({ enabled: true }))
  })

  it('debounces slider patches and sends both values', async () => {
    vi.useFakeTimers()
    useWallpaperStore.setState({
      preferences: wallpaper({ file: 'wallpaper.png', enabled: true }),
      objectUrl: 'blob:preview',
    })
    api.updateWallpaperPreferences.mockResolvedValue({
      ok: true,
      preferences,
      wallpaper: wallpaper({ file: 'wallpaper.png', enabled: true, zoom: 150, blur: 20, panelOpacity: 90 }),
    })
    render(<WallpaperSettings />)

    fireEvent.change(screen.getByRole('slider', { name: 'Zoom' }), { target: { value: '150' } })
    fireEvent.change(screen.getByRole('slider', { name: 'Blur' }), { target: { value: '20' } })
    fireEvent.change(screen.getByRole('slider', { name: 'Panel opacity' }), { target: { value: '90' } })

    expect(api.updateWallpaperPreferences).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(250)

    expect(api.updateWallpaperPreferences).toHaveBeenCalledTimes(1)
    expect(api.updateWallpaperPreferences).toHaveBeenCalledWith({ zoom: 150, blur: 20, panelOpacity: 90 })
  })

  it('uploads a picked image', async () => {
    const compressed = new File(['jpeg'], 'wallpaper.jpg', { type: 'image/jpeg' })
    compressWallpaper.mockResolvedValue(compressed)
    api.uploadWallpaper.mockResolvedValue({
      ok: true,
      preferences: { ...preferences, wallpaper: wallpaper({ file: 'wallpaper.jpg' }) },
    })
    api.updateWallpaperPreferences.mockResolvedValue({
      ok: true,
      preferences,
      wallpaper: wallpaper({ file: 'wallpaper.jpg', enabled: true }),
    })
    api.getWallpaperImage.mockResolvedValue(new Blob(['image'], { type: 'image/jpeg' }))
    render(<WallpaperSettings />)

    const file = new File(['source'], 'source.png', { type: 'image/png' })
    fireEvent.change(screen.getByTestId('wallpaper-file-input'), { target: { files: [file] } })

    await vi.waitFor(() => expect(api.uploadWallpaper).toHaveBeenCalledWith(compressed))
    await vi.waitFor(() => expect(api.getWallpaperImage).toHaveBeenCalled())
    expect(useWallpaperStore.getState().preferences.enabled).toBe(true)
  })

  it('removes the image and shows store errors', async () => {
    useWallpaperStore.setState({
      preferences: wallpaper({ file: 'wallpaper.png', enabled: true }),
      objectUrl: 'blob:preview',
    })
    api.deleteWallpaperImage.mockRejectedValue(new Error('Failed to clear wallpaper'))
    render(<WallpaperSettings />)

    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))

    await vi.waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Failed to clear wallpaper'))
  })

  it('offers the dynamic kinds only when the desktop host supports them', () => {
    installDynamicHost()
    render(<WallpaperSettings />)

    expect(screen.getByRole('radiogroup', { name: 'Wallpaper type' })).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: 'Video' })).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: 'Web pack' })).toBeInTheDocument()
  })

  it('switches to the video kind through the dynamic host', async () => {
    const methods = installDynamicHost()
    methods.update.mockResolvedValue(dynamicStatus({ kind: 'video' }))
    render(<WallpaperSettings />)

    fireEvent.click(screen.getByRole('radio', { name: 'Video' }))

    await vi.waitFor(() => expect(methods.update).toHaveBeenCalledWith({ kind: 'video' }))
    expect(await screen.findByText('Video source')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Choose video' })).toBeInTheDocument()
    // An unselected source is not a broken one; only a disappeared file warns.
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('picks a video with localized dialog labels', async () => {
    const methods = installDynamicHost(dynamicStatus({ kind: 'video' }))
    methods.pickVideo.mockResolvedValue({
      canceled: false,
      status: dynamicStatus({
        kind: 'video',
        enabled: true,
        videoPath: '/clips/loop.mp4',
        videoName: 'loop.mp4',
      }),
      error: null,
    })
    render(<WallpaperSettings />)

    fireEvent.click(screen.getByRole('button', { name: 'Choose video' }))

    await vi.waitFor(() =>
      expect(methods.pickVideo).toHaveBeenCalledWith({
        dialogTitle: 'Choose video',
        dialogFilterName: 'Video',
      }),
    )
    expect(await screen.findByText('loop.mp4')).toBeInTheDocument()
    expect(screen.getByTestId('wallpaper-dynamic-preview-media')).toHaveAttribute(
      'src',
      'cc-wallpaper://video/stream?rev=0',
    )
  })

  it('routes the sliders to the dynamic source instead of the image API', async () => {
    vi.useFakeTimers()
    const methods = installDynamicHost(dynamicStatus({
      kind: 'video',
      enabled: true,
      videoPath: '/clips/loop.mp4',
      videoName: 'loop.mp4',
    }))
    methods.update.mockResolvedValue(dynamicStatus({ kind: 'video', enabled: true, zoom: 150 }))
    render(<WallpaperSettings />)

    fireEvent.change(screen.getByRole('slider', { name: 'Zoom' }), { target: { value: '150' } })
    await vi.advanceTimersByTimeAsync(250)

    expect(methods.update).toHaveBeenCalledWith({ zoom: 150, blur: 8, panelOpacity: 88 })
    expect(api.updateWallpaperPreferences).not.toHaveBeenCalled()
  })

  it('explains a folder without index.html', async () => {
    const methods = installDynamicHost(dynamicStatus({ kind: 'web' }))
    methods.pickWeb.mockResolvedValue({
      canceled: false,
      status: dynamicStatus({ kind: 'web' }),
      error: 'web-index-missing',
    })
    render(<WallpaperSettings />)

    fireEvent.click(screen.getByRole('button', { name: 'Choose folder' }))

    await vi.waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(
        'That folder does not contain an index.html.',
      ),
    )
  })

  it('warns when the selected source disappeared', () => {
    installDynamicHost(
      dynamicStatus(
        { kind: 'video', enabled: true, videoPath: '/clips/loop.mp4', videoName: 'loop.mp4' },
        'video-missing',
      ),
    )
    render(<WallpaperSettings />)

    expect(screen.getByRole('status')).toHaveTextContent(
      'The selected video is missing. Choose it again.',
    )
    expect(screen.queryByTestId('wallpaper-dynamic-preview')).not.toBeInTheDocument()
    expect(screen.getByRole('switch', { name: 'Enable wallpaper' })).toBeDisabled()
  })
})