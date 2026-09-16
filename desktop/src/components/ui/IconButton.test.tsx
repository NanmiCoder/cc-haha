import { createRef } from 'react'
import { render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import { describe, expect, it } from 'vitest'

import { IconButton, type IconButtonSize, type IconButtonTone } from './IconButton'

const SIZES: IconButtonSize[] = ['2xs', 'xs', 'sm', 'md', 'lg', 'xl', '2xl']
const TONES: IconButtonTone[] = ['default', 'secondary', 'muted', 'brand', 'danger']

describe('IconButton', () => {
  it('names the button for screen readers from label', () => {
    // Ten icon-only buttons shipped with no accessible name at all, including
    // the settings entry point in the title bar.
    render(<IconButton icon={<span />} label="Open settings" />)
    expect(screen.getByRole('button', { name: 'Open settings' })).toBeInTheDocument()
  })

  it('mirrors the label into a native tooltip by default', () => {
    render(<IconButton icon={<span />} label="Close tab" />)
    expect(screen.getByRole('button', { name: 'Close tab' })).toHaveAttribute('title', 'Close tab')
  })

  it('keeps the accessible name when the tooltip is suppressed', () => {
    render(<IconButton icon={<span />} label="Close tab" showTooltip={false} />)
    const button = screen.getByRole('button', { name: 'Close tab' })
    expect(button).not.toHaveAttribute('title')
    expect(button).toHaveAttribute('aria-label', 'Close tab')
  })

  it('defaults to type="button"', () => {
    render(<IconButton icon={<span />} label="Delete" />)
    expect(screen.getByRole('button', { name: 'Delete' })).toHaveAttribute('type', 'button')
  })

  it.each(SIZES)('renders size=%s as an equal-sided box', (size) => {
    const { container } = render(<IconButton icon={<span />} label="Act" size={size} />)
    const className = container.firstElementChild!.className
    const height = className.match(/\bh-(\d+)\b/)?.[1]
    const width = className.match(/\bw-(\d+)\b/)?.[1]
    expect(height).toBeDefined()
    expect(width).toBe(height)
  })

  it.each(TONES)('gives tone=%s a focus ring', (tone) => {
    const { container } = render(<IconButton icon={<span />} label="Act" tone={tone} />)
    expect(container.firstElementChild?.className).toContain('focus-visible:ring-2')
  })

  it('renders a string icon as a material symbol hidden from assistive tech', () => {
    const { container } = render(<IconButton icon="settings" label="Settings" />)
    const glyph = container.querySelector('.material-symbols-outlined')
    expect(glyph).toHaveTextContent('settings')
    expect(glyph).toHaveAttribute('aria-hidden', 'true')
  })

  it('shows a spinner and disables itself while loading', () => {
    const { container } = render(<IconButton icon={<span data-testid="icon" />} label="Refresh" loading />)
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeDisabled()
    expect(screen.queryByTestId('icon')).not.toBeInTheDocument()
    expect(container.querySelector('svg.animate-spin')).toBeInTheDocument()
  })

  it.each(['default', 'secondary', 'muted', 'brand', 'danger'] as const)(
    'emits exactly one hover text color for tone=%s with hoverTone',
    (tone) => {
      // The first version of this test only checked that the red class was
      // present, and passed while the feature did nothing: `muted` and
      // `secondary` also emitted `hover:text-[var(--color-text-primary)]`, and
      // Tailwind sorts same-utility arbitrary values alphabetically by value —
      // the neutral one wins no matter what order they are passed in.
      const { container } = render(
        <IconButton icon={<span />} label="Delete" tone={tone} hoverTone="danger" />,
      )
      const hoverTextClasses = container.firstElementChild!.className
        .split(/\s+/)
        .filter((c) => c.startsWith('hover:text-'))

      expect(hoverTextClasses).toEqual(['hover:text-[var(--color-error)]'])
    },
  )

  it('rests in its tone and only turns red on hover with hoverTone', () => {
    // A delete icon sitting red at rest reads as an error state.
    const { container } = render(
      <IconButton icon={<span />} label="Delete" tone="muted" hoverTone="danger" />,
    )
    const className = container.firstElementChild!.className
    expect(className).toContain('text-[var(--color-text-tertiary)]')
    expect(className).not.toMatch(/(?<!hover:)text-\[var\(--color-error\)\]/)
  })

  it('keeps the tone hover text when hoverTone is not set', () => {
    const { container } = render(<IconButton icon={<span />} label="Act" tone="muted" />)
    expect(container.firstElementChild?.className).toContain('hover:text-[var(--color-text-primary)]')
  })

  it('reports toggle state through aria-pressed', () => {
    const { rerender } = render(<IconButton icon={<span />} label="Filter" pressed={false} />)
    expect(screen.getByRole('button', { name: 'Filter' })).toHaveAttribute('aria-pressed', 'false')

    rerender(<IconButton icon={<span />} label="Filter" pressed />)
    expect(screen.getByRole('button', { name: 'Filter' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('omits aria-pressed entirely when it is not a toggle', () => {
    render(<IconButton icon={<span />} label="Refresh" />)
    expect(screen.getByRole('button', { name: 'Refresh' })).not.toHaveAttribute('aria-pressed')
  })

  it('drops the tone hover while pressed so two fills cannot compete', () => {
    const { container } = render(<IconButton icon={<span />} label="Filter" pressed />)
    const className = container.firstElementChild!.className
    expect(className).toContain('bg-[var(--color-surface-selected)]')
    expect(className).not.toContain('hover:bg-[var(--color-surface-hover)]')
  })

  it('uses the sidebar hover token on the sidebar surface', () => {
    // The sidebar's hover differs from --color-surface-hover in all three
    // themes; without this, sidebar buttons could not adopt the component.
    const { container } = render(<IconButton icon={<span />} label="Act" surface="sidebar" />)
    expect(container.firstElementChild?.className).toContain('hover:bg-[var(--color-sidebar-item-hover)]')
  })

  it('draws the terminal surface from the terminal palette, not the page one', () => {
    // Keep terminal controls on the same palette as xterm, including hover.
    const { container } = render(
      <IconButton icon={<span />} label="Clear" tone="muted" surface="terminal" />,
    )
    const className = container.firstElementChild!.className
    expect(className).toContain('text-[var(--color-terminal-muted)]')
    expect(className).toContain('hover:bg-[var(--color-terminal-selection)]')
    expect(className).toContain('hover:text-[var(--color-terminal-fg)]')
    expect(className).not.toContain('text-[var(--color-text-tertiary)]')
    expect(className).not.toContain('hover:bg-[var(--color-surface-hover)]')
  })

  it('draws the media surface from the media palette, not the page one', () => {
    // Media remains dark even when the terminal follows a light theme. The page
    // tokens are inverted against it: --color-text-tertiary is a dark grey and
    // --color-surface-hover a light cream, so a `muted` button on the default
    // surface renders as an invisible glyph that flashes a pale square.
    const { container } = render(
      <IconButton icon={<span />} label="Clear" tone="muted" surface="media" />,
    )
    const className = container.firstElementChild!.className
    expect(className).toContain('text-[var(--color-media-muted)]')
    expect(className).toContain('hover:bg-[var(--color-media-selection)]')
    expect(className).toContain('hover:text-[var(--color-media-fg)]')
    expect(className).not.toContain('text-[var(--color-text-tertiary)]')
    expect(className).not.toContain('hover:bg-[var(--color-surface-hover)]')
  })

  it('leaves the default and sidebar surfaces untouched by the terminal maps', () => {
    const { container } = render(<IconButton icon={<span />} label="Act" tone="muted" />)
    const className = container.firstElementChild!.className
    expect(className).toContain('text-[var(--color-text-tertiary)]')
    expect(className).toContain('hover:text-[var(--color-text-primary)]')
  })

  it('emits exactly one hover text color on the terminal surface', () => {
    // Tailwind resolves competing arbitrary values of the same utility by
    // sorting them, not by argument order, so a second hover:text-[…] would
    // win or lose unpredictably.
    const { container } = render(
      <IconButton icon={<span />} label="Close" tone="muted" surface="terminal" hoverTone="danger" />,
    )
    const hovers = container.firstElementChild!.className.match(/hover:text-\[/g) ?? []
    expect(hovers).toHaveLength(1)
    expect(container.firstElementChild!.className).toContain('hover:text-[var(--color-error)]')
  })

  it('presses on the terminal surface with the terminal selection ground', () => {
    const { container } = render(
      <IconButton icon={<span />} label="Act" surface="terminal" pressed />,
    )
    expect(container.firstElementChild?.className).toContain('bg-[var(--color-terminal-selection)]')
  })

  it('draws a border without a fill when bordered', () => {
    const { container } = render(<IconButton icon={<span />} label="Act" bordered />)
    const className = container.firstElementChild!.className
    expect(className).toContain('border')
    expect(className).not.toMatch(/\sbg-\[/)
  })

  it('spans 20px to 44px so both dense rows and touch targets fit', () => {
    // 44px is the platform minimum for a primary touch target; ChatInput's
    // composer buttons are pinned to it by test and cannot shrink to 40.
    const { container: smallest } = render(<IconButton icon={<span />} label="A" size="2xs" />)
    const { container: largest } = render(<IconButton icon={<span />} label="B" size="2xl" />)
    expect(smallest.firstElementChild?.className).toContain('h-5')
    expect(largest.firstElementChild?.className).toContain('h-11')
  })

  it('solid fills at full strength with a contrasting foreground', () => {
    // `filled` only tints, which washes out over a photo — this is for a remove
    // badge pinned to user-supplied image content.
    const { container } = render(<IconButton icon={<span />} label="Remove" tone="danger" solid />)
    const className = container.firstElementChild!.className
    expect(className).toContain('bg-[var(--color-error)]')
    expect(className).toContain('text-[var(--color-on-error)]')
  })

  it('solid suppresses the tone hover so two fills cannot compete', () => {
    const { container } = render(<IconButton icon={<span />} label="Remove" tone="danger" solid />)
    expect(container.firstElementChild?.className).not.toContain('hover:bg-[var(--color-error-soft)]')
  })

  it('emits exactly one disabled opacity', () => {
    // Same trap as the hover text: a caller passing `disabled:opacity-0` via
    // className loses to the component's own `disabled:opacity-50`, because
    // Tailwind sorts the values rather than honoring the order.
    for (const [style, expected] of [['dim', 'disabled:opacity-50'], ['hide', 'disabled:opacity-0']] as const) {
      const { container, unmount } = render(
        <IconButton icon={<span />} label="Edit" disabledStyle={style} />,
      )
      const opacities = container.firstElementChild!.className
        .split(/\s+/)
        .filter((c) => c.startsWith('disabled:opacity-'))

      expect(opacities).toEqual([expected])
      unmount()
    }
  })

  it('forwards a ref so overlays can anchor to it', () => {
    const ref = createRef<HTMLButtonElement>()
    render(<IconButton icon={<span />} label="Anchor" ref={ref} />)
    expect(ref.current).toBe(screen.getByRole('button', { name: 'Anchor' }))
  })

  it('rounds fully when shape is circle', () => {
    const { container } = render(<IconButton icon={<span />} label="Avatar" shape="circle" />)
    expect(container.firstElementChild?.className).toContain('rounded-full')
  })
})
