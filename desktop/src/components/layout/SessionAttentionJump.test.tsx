import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom'
import { SessionAttentionJump } from './SessionAttentionJump'

afterEach(cleanup)

describe('SessionAttentionJump', () => {
  it('is named by what it does, not by the number on it', () => {
    render(<SessionAttentionJump count={3} label="Jump to the next waiting session (3 waiting)" onJump={vi.fn()} />)

    expect(screen.getByRole('button', { name: 'Jump to the next waiting session (3 waiting)' })).toBeInTheDocument()
  })

  it('shows how many sessions a press can reach', () => {
    render(<SessionAttentionJump count={3} label="Jump" onJump={vi.fn()} />)

    expect(screen.getByTestId('session-attention-jump')).toHaveTextContent('3')
  })

  it.each([
    [9, '9'],
    [10, '9+'],
    [42, '9+'],
  ])('shows %i as %s so the pill never outgrows the toolbar', (count, shown) => {
    render(<SessionAttentionJump count={count} label="Jump" onJump={vi.fn()} />)

    expect(screen.getByTestId('session-attention-jump')).toHaveTextContent(new RegExp(`^${shown.replace('+', '\\+')}$`))
  })

  it('formats the shown number, so a past-nine count still reads as 9+', () => {
    render(<SessionAttentionJump count={12} label="Jump" format={(shown) => `${shown} waiting`} onJump={vi.fn()} />)

    expect(screen.getByTestId('session-attention-jump')).toHaveTextContent(/^9\+ waiting$/)
  })

  it('jumps when pressed', () => {
    const onJump = vi.fn()
    render(<SessionAttentionJump count={2} label="Jump" onJump={onJump} />)

    fireEvent.click(screen.getByRole('button', { name: 'Jump' }))

    expect(onJump).toHaveBeenCalledTimes(1)
  })

  it('repeats the label as a native tooltip', () => {
    render(<SessionAttentionJump count={2} label="Jump to the next waiting session" onJump={vi.fn()} />)

    expect(screen.getByRole('button')).toHaveAttribute('title', 'Jump to the next waiting session')
  })

  it('hides the glyph from a screen reader', () => {
    const { container } = render(<SessionAttentionJump count={2} label="Jump" onJump={vi.fn()} />)

    expect(container.querySelector('svg')).toHaveAttribute('aria-hidden', 'true')
  })

  it('does not submit a surrounding form', () => {
    render(<SessionAttentionJump count={2} label="Jump" onJump={vi.fn()} />)

    expect(screen.getByRole('button')).toHaveAttribute('type', 'button')
  })

  it('is marked interactive so the window drag region never swallows the press', () => {
    render(<SessionAttentionJump count={2} label="Jump" onJump={vi.fn()} />)

    expect(screen.getByRole('button')).toHaveClass('tab-bar-interactive')
  })

  it('wears the warning container pair and hard-codes no colour', () => {
    const { container } = render(<SessionAttentionJump count={2} label="Jump" onJump={vi.fn()} />)

    expect(container.innerHTML).toContain('var(--color-warning-container)')
    expect(container.innerHTML).toContain('var(--color-on-warning-container)')
    expect(container.innerHTML).not.toMatch(/#[0-9a-f]{3,8}\b/i)
  })
})
