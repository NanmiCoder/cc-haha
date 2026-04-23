import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'

const minimize = vi.fn().mockResolvedValue(undefined)
const toggleMaximize = vi.fn().mockResolvedValue(undefined)
const close = vi.fn().mockResolvedValue(undefined)
const isMaximized = vi.fn().mockResolvedValue(false)
const onResized = vi.fn().mockResolvedValue(() => {})

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    minimize,
    toggleMaximize,
    close,
    isMaximized,
    onResized,
  }),
}))

describe('WindowControls', () => {
  const originalPlatform = navigator.platform

  beforeEach(async () => {
    minimize.mockClear()
    toggleMaximize.mockClear()
    close.mockClear()
    isMaximized.mockClear()
    onResized.mockClear()

    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: {},
    })
    Object.defineProperty(navigator, 'platform', {
      configurable: true,
      value: 'Win32',
    })
    vi.resetModules()
  })

  afterEach(() => {
    Reflect.deleteProperty(window, '__TAURI_INTERNALS__')
    Object.defineProperty(navigator, 'platform', {
      configurable: true,
      value: originalPlatform,
    })
  })

  it('invokes Tauri window APIs for custom controls on Windows', async () => {
    const { WindowControls } = await import('./WindowControls')

    render(<WindowControls />)

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Minimize window' })).toBeInTheDocument()
    })

    fireEvent.click(screen.getByRole('button', { name: 'Minimize window' }))
    fireEvent.click(screen.getByRole('button', { name: 'Maximize window' }))
    fireEvent.click(screen.getByRole('button', { name: 'Close window' }))

    await waitFor(() => {
      expect(minimize).toHaveBeenCalledTimes(1)
      expect(toggleMaximize).toHaveBeenCalledTimes(1)
      expect(close).toHaveBeenCalledTimes(1)
    })
  })
})
