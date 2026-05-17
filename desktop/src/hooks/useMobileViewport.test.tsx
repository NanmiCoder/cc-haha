import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import { useMobileViewport } from './useMobileViewport'

function Probe() {
  const isMobile = useMobileViewport()
  return <div data-testid="viewport-state">{isMobile ? 'mobile' : 'desktop'}</div>
}

function createMatchMediaController(initialMatches = false, legacy = false) {
  let matches = initialMatches
  const listeners = new Set<(event: MediaQueryListEvent) => void>()
  const addListener = vi.fn((listener: (event: MediaQueryListEvent) => void) => {
    listeners.add(listener)
  })
  const removeListener = vi.fn((listener: (event: MediaQueryListEvent) => void) => {
    listeners.delete(listener)
  })

  const matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches,
    media: query,
    onchange: null,
    addEventListener: legacy ? undefined : vi.fn((type: string, listener: (event: MediaQueryListEvent) => void) => {
      if (type === 'change') listeners.add(listener)
    }),
    removeEventListener: legacy ? undefined : vi.fn((type: string, listener: (event: MediaQueryListEvent) => void) => {
      if (type === 'change') listeners.delete(listener)
    }),
    addListener,
    removeListener,
    dispatchEvent: vi.fn(),
  }))

  return {
    matchMedia,
    addListener,
    removeListener,
    emit(nextMatches: boolean) {
      matches = nextMatches
      const event = { matches: nextMatches, media: '(max-width: 767px)' } as MediaQueryListEvent
      listeners.forEach((listener) => listener(event))
    },
    getListenerCount() {
      return listeners.size
    },
  }
}

describe('useMobileViewport', () => {
  const originalMatchMedia = window.matchMedia

  afterEach(() => {
    cleanup()
    if (originalMatchMedia) {
      window.matchMedia = originalMatchMedia
    } else {
      Reflect.deleteProperty(window, 'matchMedia')
    }
  })

  it('defaults to desktop when matchMedia is unavailable', () => {
    Reflect.deleteProperty(window, 'matchMedia')

    render(<Probe />)

    expect(screen.getByTestId('viewport-state')).toHaveTextContent('desktop')
  })

  it('tracks viewport changes and removes the listener on cleanup', () => {
    const controller = createMatchMediaController(false)
    window.matchMedia = controller.matchMedia as typeof window.matchMedia

    const { unmount } = render(<Probe />)

    expect(screen.getByTestId('viewport-state')).toHaveTextContent('desktop')
    expect(controller.matchMedia).toHaveBeenCalledWith('(max-width: 767px)')
    expect(controller.getListenerCount()).toBe(1)

    act(() => {
      controller.emit(true)
    })

    expect(screen.getByTestId('viewport-state')).toHaveTextContent('mobile')

    unmount()

    expect(controller.getListenerCount()).toBe(0)
  })

  it('reads the initial media query before first paint', () => {
    const controller = createMatchMediaController(true)
    window.matchMedia = controller.matchMedia as typeof window.matchMedia

    render(<Probe />)

    expect(screen.getByTestId('viewport-state')).toHaveTextContent('mobile')
  })

  it('falls back to legacy media query listeners', () => {
    const controller = createMatchMediaController(false, true)
    window.matchMedia = controller.matchMedia as typeof window.matchMedia

    const { unmount } = render(<Probe />)

    expect(controller.addListener).toHaveBeenCalledTimes(1)

    act(() => {
      controller.emit(true)
    })

    expect(screen.getByTestId('viewport-state')).toHaveTextContent('mobile')

    unmount()

    expect(controller.removeListener).toHaveBeenCalledTimes(1)
    expect(controller.getListenerCount()).toBe(0)
  })
})
