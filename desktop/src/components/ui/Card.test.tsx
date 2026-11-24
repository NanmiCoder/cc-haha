import { render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import { describe, expect, it } from 'vitest'

import { Card } from './Card'

describe('Card', () => {
  it('renders its children', () => {
    render(<Card>Body</Card>)
    expect(screen.getByText('Body')).toBeInTheDocument()
  })

  it('always uses the radius scale, never a Tailwind radius', () => {
    // `rounded-lg` is 8px and `rounded-[var(--radius-lg)]` is 12px — the same
    // name for two values is how 21 corner radii shipped.
    for (const radius of ['sm', 'md', 'lg', 'xl', '2xl'] as const) {
      const { container, unmount } = render(<Card radius={radius}>x</Card>)
      expect(container.firstElementChild?.className).toContain(`rounded-[var(--radius-${radius})]`)
      unmount()
    }
  })

  it('draws elevation from the shadow scale', () => {
    const { container: flat } = render(<Card>x</Card>)
    expect(flat.firstElementChild?.className).not.toContain('shadow-[')

    const { container: raised } = render(<Card shadow="card">x</Card>)
    expect(raised.firstElementChild?.className).toContain('shadow-[var(--shadow-card)]')

    const { container: composer } = render(<Card shadow="composer">x</Card>)
    expect(composer.firstElementChild?.className).toContain('shadow-[var(--shadow-composer)]')
  })

  it('emits exactly one resting shadow when lifting', () => {
    // Regression anchor: `lift` animates from --shadow-card to --shadow-composer.
    // Emitting a `shadow` prop alongside it puts two `shadow-[…]` values on one
    // element, and Tailwind picks the winner by sorting the arbitrary values —
    // not by the order they were passed, so the resting shadow is a coin flip.
    const { container } = render(<Card shadow="composer" lift>x</Card>)
    const className = container.firstElementChild!.className
    const resting = className.split(/\s+/).filter((token) => token.startsWith('shadow-['))
    expect(resting).toEqual(['shadow-[var(--shadow-card)]'])
    expect(className).toContain('hover:shadow-[var(--shadow-composer)]')
    expect(className).toContain('hover:-translate-y-0.5')
  })

  it('supports the surface layers without hardcoding a color', () => {
    for (const surface of ['base', 'low', 'lowest', 'high'] as const) {
      const { container, unmount } = render(<Card surface={surface}>x</Card>)
      expect(container.firstElementChild?.className).toMatch(/bg-\[var\(--color-surface[\w-]*\)\]/)
      unmount()
    }
  })

  it('can drop its surface and border', () => {
    const { container } = render(<Card surface="none" border="none">x</Card>)
    const className = container.firstElementChild!.className
    expect(className).not.toMatch(/\bbg-\[/)
    expect(className).not.toContain('border')
  })

  it('supports a dashed border for placeholders', () => {
    const { container } = render(<Card border="dashed">x</Card>)
    expect(container.firstElementChild?.className).toContain('border-dashed')
  })

  it('adds hover and focus affordances only when interactive', () => {
    const { container: plain } = render(<Card>x</Card>)
    expect(plain.firstElementChild?.className).not.toContain('focus-visible:ring-2')

    const { container: clickable } = render(<Card interactive>x</Card>)
    expect(clickable.firstElementChild?.className).toContain('focus-visible:ring-2')
    expect(clickable.firstElementChild?.className).toContain('cursor-pointer')
  })

  it('renders as the requested element', () => {
    const { container } = render(<Card as="article">x</Card>)
    expect(container.firstElementChild?.tagName).toBe('ARTICLE')
  })
})
