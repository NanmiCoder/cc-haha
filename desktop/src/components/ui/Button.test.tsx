import { createRef } from 'react'
import { render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import { describe, expect, it, vi } from 'vitest'

import { Button, type ButtonSize, type ButtonVariant } from './Button'

const VARIANTS: ButtonVariant[] = ['primary', 'secondary', 'tonal', 'ghost', 'danger', 'danger-outline', 'danger-ghost', 'link', 'inverse']
const SIZES: ButtonSize[] = ['xs', 'sm', 'base', 'md', 'lg']

describe('Button', () => {
  it('defaults to type="button" so it cannot submit a surrounding form', () => {
    // The native default is "submit". A button placed inside a form to run an
    // unrelated action would submit that form on click.
    render(<Button>Run</Button>)
    expect(screen.getByRole('button', { name: 'Run' })).toHaveAttribute('type', 'button')
  })

  it('still honors an explicit type', () => {
    render(<Button type="submit">Send</Button>)
    expect(screen.getByRole('button', { name: 'Send' })).toHaveAttribute('type', 'submit')
  })

  it.each(SIZES)('pins an explicit height for size=%s', (size) => {
    // Sizes that set only padding are why the app accumulated 18 button
    // heights: callers who needed a specific height had to bypass the variant.
    const { container } = render(<Button size={size}>Label</Button>)
    expect(container.firstElementChild?.className).toMatch(/\bh-\d/)
  })

  it.each(VARIANTS)('renders variant=%s with a focus ring', (variant) => {
    const { container } = render(<Button variant={variant}>Label</Button>)
    expect(container.firstElementChild?.className).toContain('focus-visible:ring-2')
  })

  describe('shape="circle"', () => {
    it.each(SIZES)('matches width to the size=%s height so it is round, not a pill', (size) => {
      const { container } = render(
        <Button shape="circle" size={size} aria-label="Send" icon={<span>i</span>} />,
      )
      const className = container.firstElementChild?.className ?? ''
      const height = className.match(/\bh-(\d+)\b/)?.[1]
      const width = className.match(/\bw-(\d+)\b/)?.[1]
      expect(height).toBeDefined()
      expect(width).toBe(height)
    })

    it('emits exactly one radius', () => {
      // The component does no Tailwind conflict resolution, so a stray
      // `rounded-[var(--radius-md)]` alongside `rounded-full` would leave the
      // shape to stylesheet order rather than to the prop (AGENTS.md §3.6).
      const { container } = render(<Button shape="circle" aria-label="Send" icon={<span>i</span>} />)
      const className = container.firstElementChild?.className ?? ''
      expect(className.match(/\brounded-\S+/g)).toEqual(['rounded-full'])
    })

    it('drops the horizontal padding a label would need', () => {
      const { container } = render(<Button shape="circle" aria-label="Send" icon={<span>i</span>} />)
      expect(container.firstElementChild?.className).not.toMatch(/\bpx-/)
    })

    it('leaves the default shape square-cornered and padded', () => {
      const { container } = render(<Button>Label</Button>)
      const className = container.firstElementChild?.className ?? ''
      expect(className.match(/\brounded-\S+/g)).toEqual(['rounded-[var(--radius-md)]'])
      expect(className).toMatch(/\bpx-/)
    })
  })

  it('disables itself and announces busy while loading', () => {
    render(<Button loading>Saving</Button>)
    const button = screen.getByRole('button', { name: 'Saving' })
    expect(button).toBeDisabled()
    expect(button).toHaveAttribute('aria-busy', 'true')
  })

  it('does not set aria-busy when idle', () => {
    render(<Button>Idle</Button>)
    expect(screen.getByRole('button', { name: 'Idle' })).not.toHaveAttribute('aria-busy')
  })

  it('swaps the icon for a spinner while loading', () => {
    const { rerender, container } = render(<Button icon={<span data-testid="icon" />}>Go</Button>)
    expect(screen.getByTestId('icon')).toBeInTheDocument()

    rerender(<Button icon={<span data-testid="icon" />} loading>Go</Button>)
    expect(screen.queryByTestId('icon')).not.toBeInTheDocument()
    expect(container.querySelector('svg.animate-spin')).toBeInTheDocument()
  })

  it('places the icon after the label when iconPosition is end', () => {
    const { container } = render(
      <Button icon={<span data-testid="icon" />} iconPosition="end">Next</Button>,
    )
    const children = Array.from(container.firstElementChild!.childNodes)
    expect(children[children.length - 1]).toHaveAttribute('data-testid', 'icon')
  })

  it('stretches with block instead of a className override', () => {
    const { container } = render(<Button block>Wide</Button>)
    expect(container.firstElementChild?.className).toContain('w-full')
  })

  it('does not fire onClick while loading', async () => {
    const onClick = vi.fn()
    render(<Button loading onClick={onClick}>Saving</Button>)
    screen.getByRole('button', { name: 'Saving' }).click()
    expect(onClick).not.toHaveBeenCalled()
  })

  it('forwards arbitrary button attributes', () => {
    render(<Button data-testid="probe" aria-pressed>Toggle</Button>)
    expect(screen.getByTestId('probe')).toHaveAttribute('aria-pressed', 'true')
  })

  it('forwards a ref to the underlying button', () => {
    // Caught by opening the gallery, not by a test: `Tooltip` and `Dropdown`
    // attach a ref to their trigger. A component that swallows the ref makes
    // the tooltip unpositionable and stops the dropdown returning focus — and
    // both fail silently, with only a console warning.
    const ref = createRef<HTMLButtonElement>()
    render(<Button ref={ref}>Anchor</Button>)

    expect(ref.current).toBeInstanceOf(HTMLButtonElement)
    expect(ref.current).toBe(screen.getByRole('button', { name: 'Anchor' }))
  })
})
