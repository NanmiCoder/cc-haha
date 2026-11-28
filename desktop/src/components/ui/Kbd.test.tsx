import { createRef } from 'react'
import { render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import { describe, expect, it } from 'vitest'

import { Kbd, KbdGroup, type KbdAppearance, type KbdSize } from './Kbd'

const SIZES: KbdSize[] = ['xs', 'sm', 'md']
const APPEARANCES: KbdAppearance[] = ['surface', 'subtle', 'inverse']

describe('Kbd', () => {
  it('renders a semantic <kbd> element with monospace tabular figures', () => {
    render(<Kbd>⌘K</Kbd>)
    const cap = screen.getByText('⌘K')
    expect(cap.tagName).toBe('KBD')
    expect(cap.className).toContain('font-mono')
    expect(cap.className).toContain('tabular-nums')
    expect(cap.className).toContain('rounded-[var(--radius-xs)]')
  })

  it.each(SIZES)('pins a consistent height for size=%s', (size) => {
    const { container } = render(<Kbd size={size}>Esc</Kbd>)
    expect(container.firstElementChild?.className).toMatch(/(?:^|\s)h-(?:\[\d+px\]|\d+)(?=\s|$)/)
  })

  it.each(APPEARANCES)('uses theme tokens for appearance=%s', (appearance) => {
    const { container } = render(<Kbd appearance={appearance}>↵</Kbd>)
    const className = container.firstElementChild!.className
    expect(className).toMatch(/bg-\[var\(--color-[\w-]+\)\]/)
    expect(className).toMatch(/text-\[var\(--color-[\w-]+\)\]/)
  })

  it('draws a tactile physical keycap bottom bevel on surface appearance', () => {
    const { container } = render(<Kbd>⌘</Kbd>)
    expect(container.firstElementChild?.className).toContain('border-b-2')
    expect(container.firstElementChild?.className).toContain('shadow-[var(--bevel-surface-rest)]')
  })

  it('forwards ref and arbitrary HTML attributes', () => {
    const ref = createRef<HTMLElement>()
    render(<Kbd ref={ref} data-testid="shortcut-cap" title="Command">⌘</Kbd>)
    expect(ref.current).toBe(screen.getByTestId('shortcut-cap'))
    expect(screen.getByTestId('shortcut-cap')).toHaveAttribute('title', 'Command')
  })
})

describe('KbdGroup', () => {
  it('joins adjacent keycaps into a single inline cluster', () => {
    render(
      <KbdGroup data-testid="combo">
        <Kbd>⌘</Kbd>
        <Kbd>⇧</Kbd>
        <Kbd>P</Kbd>
      </KbdGroup>,
    )
    const combo = screen.getByTestId('combo')
    expect(combo.querySelectorAll('kbd')).toHaveLength(3)
    expect(combo.className).toContain('inline-flex')
  })
})
