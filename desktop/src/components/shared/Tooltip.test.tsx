import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import '@testing-library/jest-dom'
import { Tooltip, formatShortcut } from './Tooltip'

describe('Tooltip', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('shows tooltip on hover after delay', async () => {
    render(
      <Tooltip content="Test tooltip">
        <button>Hover me</button>
      </Tooltip>
    )

    const trigger = screen.getByText('Hover me')
    fireEvent.mouseEnter(trigger)

    // Should not be visible immediately
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()

    // Advance timer past delay
    act(() => {
      vi.advanceTimersByTime(300)
    })

    // Should now be visible
    expect(screen.getByRole('tooltip')).toBeInTheDocument()
    expect(screen.getByText('Test tooltip')).toBeInTheDocument()
  })

  it('hides tooltip on mouse leave', async () => {
    render(
      <Tooltip content="Test tooltip">
        <button>Hover me</button>
      </Tooltip>
    )

    const trigger = screen.getByText('Hover me')
    fireEvent.mouseEnter(trigger)

    act(() => {
      vi.advanceTimersByTime(300)
    })

    expect(screen.getByRole('tooltip')).toBeInTheDocument()

    fireEvent.mouseLeave(trigger)

    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
  })

  it('renders shortcut hint when provided', async () => {
    const isMac = /Mac/.test(navigator.platform)
    const expectedShortcut = isMac ? '⌘N' : 'Ctrl+N'

    render(
      <Tooltip content="New session" shortcut="⌘N">
        <button>New</button>
      </Tooltip>
    )

    const trigger = screen.getByText('New')
    fireEvent.mouseEnter(trigger)

    act(() => {
      vi.advanceTimersByTime(300)
    })

    expect(screen.getByText(expectedShortcut)).toBeInTheDocument()
  })

  it('has correct role attribute', async () => {
    render(
      <Tooltip content="Test">
        <button>Hover</button>
      </Tooltip>
    )

    fireEvent.mouseEnter(screen.getByText('Hover'))

    act(() => {
      vi.advanceTimersByTime(300)
    })

    expect(screen.getByRole('tooltip')).toBeInTheDocument()
  })

  it('shows on focus and hides on blur', async () => {
    render(
      <Tooltip content="Focus tooltip">
        <button>Focus me</button>
      </Tooltip>
    )

    const trigger = screen.getByText('Focus me')
    fireEvent.focus(trigger)

    act(() => {
      vi.advanceTimersByTime(300)
    })

    expect(screen.getByRole('tooltip')).toBeInTheDocument()

    fireEvent.blur(trigger)

    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
  })
})

describe('formatShortcut', () => {
  const isMac = /Mac/.test(navigator.platform)

  if (isMac) {
    it('returns original shortcut on Mac', () => {
      expect(formatShortcut('⌘N')).toBe('⌘N')
      expect(formatShortcut('⌥A')).toBe('⌥A')
      expect(formatShortcut('⇧S')).toBe('⇧S')
    })
  } else {
    it('converts Mac shortcuts to Ctrl+ format on non-Mac', () => {
      expect(formatShortcut('⌘N')).toBe('Ctrl+N')
      expect(formatShortcut('⌥A')).toBe('Alt+A')
      expect(formatShortcut('⇧S')).toBe('Shift+S')
    })

    it('leaves plain shortcuts unchanged on non-Mac', () => {
      expect(formatShortcut('Ctrl+N')).toBe('Ctrl+N')
      expect(formatShortcut('Escape')).toBe('Escape')
    })
  }
})
