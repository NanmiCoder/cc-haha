import { beforeEach, describe, expect, it, vi } from 'vitest'

const check = vi.fn()
const relaunch = vi.fn()

vi.mock('@tauri-apps/plugin-updater', () => ({
  check,
}))

vi.mock('@tauri-apps/plugin-process', () => ({
  relaunch,
}))

describe('updateStore', () => {
  beforeEach(() => {
    check.mockReset()
    relaunch.mockReset()
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: {},
    })
  })

  it('stores available update metadata after a successful check', async () => {
    const update = {
      version: '0.2.0',
      body: 'Bug fixes and performance improvements',
      close: vi.fn().mockResolvedValue(undefined),
    }
    check.mockResolvedValue(update)

    vi.resetModules()
    const { useUpdateStore } = await import('./updateStore')

    const result = await useUpdateStore.getState().checkForUpdates()

    expect(result).toBe(update)
    expect(useUpdateStore.getState().status).toBe('available')
    expect(useUpdateStore.getState().availableVersion).toBe('0.2.0')
    expect(useUpdateStore.getState().releaseNotes).toBe('Bug fixes and performance improvements')
    expect(useUpdateStore.getState().shouldPrompt).toBe(true)
  })

  it('computes download progress from content length and relaunches after install', async () => {
    const downloadAndInstall = vi.fn(async (onEvent?: (event: unknown) => void) => {
      onEvent?.({ event: 'Started', data: { contentLength: 200 } })
      onEvent?.({ event: 'Progress', data: { chunkLength: 50 } })
      onEvent?.({ event: 'Progress', data: { chunkLength: 150 } })
      onEvent?.({ event: 'Finished' })
    })

    check.mockResolvedValue({
      version: '0.2.0',
      body: 'Notes',
      downloadAndInstall,
      close: vi.fn().mockResolvedValue(undefined),
    })
    relaunch.mockResolvedValue(undefined)

    vi.resetModules()
    const { useUpdateStore } = await import('./updateStore')

    await useUpdateStore.getState().checkForUpdates()
    await useUpdateStore.getState().installUpdate()

    expect(downloadAndInstall).toHaveBeenCalledTimes(1)
    expect(useUpdateStore.getState().progressPercent).toBe(100)
    expect(useUpdateStore.getState().status).toBe('restarting')
    expect(relaunch).toHaveBeenCalledTimes(1)
  })
})
