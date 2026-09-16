import { beforeEach, expect, it, vi } from 'vitest'
import type { WorkspaceBrowserMenuOptions } from '../desktopHost/types'

const mock = vi.hoisted(() => ({ available: true, showMenu: vi.fn() }))
vi.mock('../desktopHost', () => ({
  getDesktopHost: () => ({ capabilities: { workspaceBrowser: mock.available }, browser: { showMenu: mock.showMenu } }),
}))

import { workspaceBrowserHost } from './browserHost'

const options: WorkspaceBrowserMenuOptions = {
  x: 20, y: 44, zoomFactor: 1, hasPage: true, canOpenExternal: true,
  labels: { find: 'Find', print: 'Print', zoom: 'Zoom', zoomIn: 'Larger', zoomOut: 'Smaller', zoomReset: 'Reset', capture: 'Capture', pickElement: 'Pick', downloads: 'Downloads', history: 'History', openExternal: 'External' },
}

beforeEach(() => {
  mock.available = true
  mock.showMenu.mockReset()
})

it('preserves selected actions and cancellation instead of discarding the host result', async () => {
  mock.showMenu.mockResolvedValueOnce('history').mockResolvedValueOnce(null)
  await expect(workspaceBrowserHost.showMenu('wb-a', options)).resolves.toBe('history')
  expect(mock.showMenu).toHaveBeenCalledWith('wb-a', options)
  await expect(workspaceBrowserHost.showMenu('wb-a', options)).resolves.toBeNull()
})

it('returns null only for an unavailable host and still propagates genuine popup failure', async () => {
  mock.available = false
  await expect(workspaceBrowserHost.showMenu('wb-a', options)).resolves.toBeNull()
  expect(mock.showMenu).not.toHaveBeenCalled()
  mock.available = true
  mock.showMenu.mockRejectedValue(new Error('native menu failed'))
  await expect(workspaceBrowserHost.showMenu('wb-a', options)).rejects.toThrow('native menu failed')
})
