import { render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import { describe, expect, it } from 'vitest'

import { Badge, StatusDot, type Tone } from './Badge'

const TONES: Tone[] = ['neutral', 'brand', 'success', 'warning', 'danger', 'info']

describe('Badge', () => {
  it.each(TONES)('renders tone=%s with a themed fill and text color', (tone) => {
    const { container } = render(<Badge tone={tone}>Ready</Badge>)
    const className = container.firstElementChild!.className
    expect(className).toMatch(/bg-\[var\(--color-[\w-]+\)\]/)
    expect(className).toMatch(/text-\[var\(--color-[\w-]+\)\]/)
  })

  it.each(TONES)('renders outline tone=%s with a border instead of a fill', (tone) => {
    const { container } = render(<Badge tone={tone} variant="outline">Ready</Badge>)
    const className = container.firstElementChild!.className
    expect(className).toContain('border')
    expect(className).not.toMatch(/\bbg-\[/)
  })

  it('is a pill by default and squares off for counters', () => {
    const { container: pill } = render(<Badge>3</Badge>)
    expect(pill.firstElementChild?.className).toContain('rounded-full')

    const { container: square } = render(<Badge pill={false}>3</Badge>)
    expect(square.firstElementChild?.className).not.toContain('rounded-full')
  })

  it('switches to tabular figures when mono', () => {
    const { container } = render(<Badge mono>v0.4.2</Badge>)
    expect(container.firstElementChild?.className).toContain('tabular-nums')
  })

  it('is single-line by default and can be told to wrap', () => {
    // A `mono` badge usually holds a path or a matcher; without this those
    // overflow their container instead of wrapping.
    const { container: nowrap } = render(<Badge mono>src/very/long/path.ts</Badge>)
    expect(nowrap.firstElementChild?.className).toContain('whitespace-nowrap')

    const { container: wrapped } = render(<Badge mono wrap>src/very/long/path.ts</Badge>)
    expect(wrapped.firstElementChild?.className).toContain('break-all')
    expect(wrapped.firstElementChild?.className).not.toContain('whitespace-nowrap')
  })

  it('forwards arbitrary span attributes', () => {
    // Without this a caller needing `data-testid` has to abandon the component
    // and hand-roll the span again — which is how the duplication started.
    render(<Badge data-testid="probe" id="status-chip">Ready</Badge>)
    const badge = screen.getByTestId('probe')
    expect(badge).toHaveAttribute('id', 'status-chip')
    expect(badge).toHaveTextContent('Ready')
  })

  it('accepts a native tooltip for truncated text', () => {
    render(<Badge title="Full description">Short</Badge>)
    expect(screen.getByText('Short')).toHaveAttribute('title', 'Full description')
  })

  it('renders its content and icon', () => {
    render(<Badge icon={<span data-testid="icon" />}>Connected</Badge>)
    expect(screen.getByText('Connected')).toBeInTheDocument()
    expect(screen.getByTestId('icon')).toBeInTheDocument()
  })
})

describe('StatusDot', () => {
  it.each(TONES)('colors tone=%s from a token', (tone) => {
    const { container } = render(<StatusDot tone={tone} />)
    expect(container.firstElementChild?.className).toMatch(/bg-\[var\(--color-[\w-]+\)\]/)
  })

  it('is hidden from assistive tech unless labeled', () => {
    const { container } = render(<StatusDot tone="success" />)
    expect(container.firstElementChild).toHaveAttribute('aria-hidden', 'true')
  })

  it('becomes a status when labeled', () => {
    render(<StatusDot tone="danger" label="Disconnected" />)
    expect(screen.getByRole('status', { name: 'Disconnected' })).toBeInTheDocument()
  })

  it('uses the 1.5s dot rhythm rather than the generic 2s pulse', () => {
    // Two call sites used `animate-pulse`, visibly breathing out of step with
    // the thirteen that used `animate-pulse-dot`.
    const { container } = render(<StatusDot tone="warning" pulse />)
    const className = container.firstElementChild!.className
    expect(className).toContain('animate-pulse-dot')
    expect(className).not.toMatch(/animate-pulse(?!-dot)/)
  })

  it('does not animate unless asked', () => {
    const { container } = render(<StatusDot tone="neutral" />)
    expect(container.firstElementChild?.className).not.toContain('animate-')
  })
})
