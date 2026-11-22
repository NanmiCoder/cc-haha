import { createRef } from 'react'
import { render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import { describe, expect, it } from 'vitest'

import { ScrollArea, type ScrollAreaOrientation } from './ScrollArea'

const ORIENTATIONS: Array<[ScrollAreaOrientation, string]> = [
  ['vertical', 'overflow-y-auto overflow-x-hidden'],
  ['horizontal', 'overflow-x-auto overflow-y-hidden'],
  ['both', 'overflow-auto'],
]

describe('ScrollArea', () => {
  it('renders a single scrollable element with auto-hiding scrollbars by default', () => {
    const { container } = render(
      <ScrollArea data-testid="scroller">
        <p>Item 1</p>
      </ScrollArea>,
    )
    const el = screen.getByTestId('scroller')
    expect(container.firstElementChild).toBe(el)
    expect(el.className).toContain('scrollbar-autohide')
    expect(el.className).toContain('overflow-y-auto')
    expect(el.className).not.toContain('scroll-edge-fade')
    expect(el).not.toHaveAttribute('data-fade-top')
    expect(el).not.toHaveAttribute('data-fade-bottom')
  })

  it.each(ORIENTATIONS)('configures overflow for orientation=%s', (orientation, expected) => {
    const { container } = render(
      <ScrollArea orientation={orientation}>Content</ScrollArea>,
    )
    for (const token of expected.split(' ')) {
      expect(container.firstElementChild?.className).toContain(token)
    }
  })

  it('can opt out of auto-hiding scrollbars', () => {
    const { container } = render(<ScrollArea autohide={false}>Content</ScrollArea>)
    expect(container.firstElementChild?.className).not.toContain('scrollbar-autohide')
  })

  it('applies edge fade mask and data attributes when fadeTop or fadeBottom is enabled', () => {
    const { rerender, container } = render(
      <ScrollArea fadeTop>Content</ScrollArea>,
    )
    const el = container.firstElementChild!
    expect(el.className).toContain('scroll-edge-fade')
    expect(el).toHaveAttribute('data-fade-top', 'true')
    expect(el).toHaveAttribute('data-fade-bottom', 'false')

    rerender(<ScrollArea fadeBottom>Content</ScrollArea>)
    expect(el.className).toContain('scroll-edge-fade')
    expect(el).toHaveAttribute('data-fade-top', 'false')
    expect(el).toHaveAttribute('data-fade-bottom', 'true')

    rerender(<ScrollArea fadeTop fadeBottom>Content</ScrollArea>)
    expect(el).toHaveAttribute('data-fade-top', 'true')
    expect(el).toHaveAttribute('data-fade-bottom', 'true')
  })

  it('uses the 7-stop topbar fade when topbarFade is enabled', () => {
    const { container } = render(
      <ScrollArea topbarFade fadeTop fadeBottom>Content</ScrollArea>,
    )
    const el = container.firstElementChild!
    expect(el.className).toContain('topbar-scroll-fade')
    expect(el.className).not.toContain('scroll-edge-fade')
    expect(el).not.toHaveAttribute('data-fade-top')
  })

  it('forwards its ref directly to the scroll container for virtualizers', () => {
    const ref = createRef<HTMLDivElement>()
    render(<ScrollArea ref={ref} data-testid="virt">Rows</ScrollArea>)
    expect(ref.current).toBe(screen.getByTestId('virt'))
  })
})
