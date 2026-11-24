import { fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import { describe, expect, it, vi } from 'vitest'

import { Button } from './Button'
import { Dropdown } from './Dropdown'

const ITEMS = [
  { value: 'sonnet', label: 'Sonnet' },
  { value: 'opus', label: 'Opus' },
  { value: 'haiku', label: 'Haiku', disabled: true },
]

function open() {
  fireEvent.click(screen.getByRole('button', { name: 'Model' }))
}

describe('Dropdown', () => {
  it('puts the expanded state on the caller\'s own trigger', () => {
    // The state goes onto the caller's button rather than a wrapper. Wrapping
    // it in a `role="combobox" tabIndex=0` div would nest one interactive
    // control inside another: two tab stops for one control.
    render(<Dropdown items={ITEMS} value="sonnet" onChange={() => {}} trigger={<button type="button">Model</button>} label="Model" />)
    const trigger = screen.getByRole('button', { name: 'Model' })

    expect(trigger.tagName).toBe('BUTTON')
    expect(trigger).toHaveAttribute('aria-haspopup', 'listbox')
    expect(trigger).toHaveAttribute('aria-expanded', 'false')

    fireEvent.click(trigger)
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    expect(trigger).toHaveAttribute('aria-controls', screen.getByRole('listbox').id)
  })

  it('adds no second tab stop around the trigger', () => {
    const { container } = render(
      <Dropdown items={ITEMS} value="sonnet" onChange={() => {}} trigger={<button type="button">Model</button>} label="Model" />,
    )
    expect(container.querySelectorAll('[tabindex="0"]')).toHaveLength(0)
  })

  it('renders a listbox with selectable options', () => {
    render(<Dropdown items={ITEMS} value="opus" onChange={() => {}} trigger={<button type="button">Model</button>} label="Model" />)
    open()

    expect(screen.getByRole('listbox')).toBeInTheDocument()
    expect(screen.getAllByRole('option')).toHaveLength(3)
    expect(screen.getByRole('option', { name: /Opus/ })).toHaveAttribute('aria-selected', 'true')
  })

  it('opens from the keyboard', () => {
    render(<Dropdown items={ITEMS} value="sonnet" onChange={() => {}} trigger={<button type="button">Model</button>} label="Model" />)

    fireEvent.keyDown(screen.getByRole('button', { name: 'Model' }), { key: 'Enter' })
    expect(screen.getByRole('listbox')).toBeInTheDocument()
  })

  it('moves focus into the list so arrow keys reach it', () => {
    render(<Dropdown items={ITEMS} value="sonnet" onChange={() => {}} trigger={<button type="button">Model</button>} label="Model" />)
    open()

    expect(document.activeElement).toBe(screen.getByRole('listbox'))
  })

  it('walks options with the arrow keys, skipping disabled ones', () => {
    render(<Dropdown items={ITEMS} value="sonnet" onChange={() => {}} trigger={<button type="button">Model</button>} label="Model" />)
    open()
    const list = screen.getByRole('listbox')

    // Starts on the selected option (index 0).
    fireEvent.keyDown(list, { key: 'ArrowDown' })
    expect(list.getAttribute('aria-activedescendant')).toContain('-1')

    // Index 2 is disabled, so the next step wraps back to 0.
    fireEvent.keyDown(list, { key: 'ArrowDown' })
    expect(list.getAttribute('aria-activedescendant')).toContain('-0')
  })

  it('picks the highlighted option with Enter', () => {
    const onChange = vi.fn()
    render(<Dropdown items={ITEMS} value="sonnet" onChange={onChange} trigger={<button type="button">Model</button>} label="Model" />)
    open()
    const list = screen.getByRole('listbox')

    fireEvent.keyDown(list, { key: 'ArrowDown' })
    fireEvent.keyDown(list, { key: 'Enter' })

    expect(onChange).toHaveBeenCalledWith('opus')
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  })

  it('jumps to the ends with Home and End', () => {
    render(<Dropdown items={ITEMS} value="sonnet" onChange={() => {}} trigger={<button type="button">Model</button>} label="Model" />)
    open()
    const list = screen.getByRole('listbox')

    fireEvent.keyDown(list, { key: 'End' })
    expect(list.getAttribute('aria-activedescendant')).toContain('-2')

    fireEvent.keyDown(list, { key: 'Home' })
    expect(list.getAttribute('aria-activedescendant')).toContain('-0')
  })

  it('ignores clicks on a disabled option', () => {
    const onChange = vi.fn()
    render(<Dropdown items={ITEMS} value="sonnet" onChange={onChange} trigger={<button type="button">Model</button>} label="Model" />)
    open()

    fireEvent.click(screen.getByRole('option', { name: /Haiku/ }))
    expect(onChange).not.toHaveBeenCalled()
    expect(screen.getByRole('listbox')).toBeInTheDocument()
  })

  it('closes on Escape and returns focus to the trigger', () => {
    // Exactly one of the 28 hand-rolled dropdowns returned focus on close.
    render(<Dropdown items={ITEMS} value="sonnet" onChange={() => {}} trigger={<button type="button">Model</button>} label="Model" />)
    open()

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Model' }))
  })

  it('closes on an outside press', () => {
    render(
      <div>
        <Dropdown items={ITEMS} value="sonnet" onChange={() => {}} trigger={<button type="button">Model</button>} label="Model" />
        <div data-testid="elsewhere">Elsewhere</div>
      </div>,
    )
    open()

    fireEvent.pointerDown(screen.getByTestId('elsewhere'))
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  })

  it('returns focus to a component trigger too', () => {
    // Same gap as in Tooltip: with a non-forwarding component the trigger ref
    // is null and focus lands nowhere on close.
    render(<Dropdown items={ITEMS} value="sonnet" onChange={() => {}} trigger={<Button>Model</Button>} label="Model" />)

    fireEvent.click(screen.getByRole('button', { name: 'Model' }))
    fireEvent.keyDown(document, { key: 'Escape' })

    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Model' }))
  })

  it('warns in development when a trigger swallows the cloned props', () => {
    // `market/FilterBar`'s chips broke exactly this way: a plain function
    // component as trigger, so the injected onClick landed nowhere and the
    // chips became inert. Nothing failed — it just stopped opening.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    function SwallowingTrigger() {
      return <button type="button">Inert</button>
    }

    render(
      <Dropdown items={ITEMS} value="sonnet" onChange={() => {}} trigger={<SwallowingTrigger />} label="Model" />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Inert' }))

    // The click cannot reach the component, so nothing opens...
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    warn.mockRestore()
  })

  it('does not warn for a trigger that forwards correctly', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    render(<Dropdown items={ITEMS} value="sonnet" onChange={() => {}} trigger={<Button>Model</Button>} label="Model" />)

    fireEvent.click(screen.getByRole('button', { name: 'Model' }))
    expect(screen.getByRole('listbox')).toBeInTheDocument()
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it('sits on the shared dropdown layer', () => {
    render(<Dropdown items={ITEMS} value="sonnet" onChange={() => {}} trigger={<button type="button">Model</button>} label="Model" />)
    open()

    expect(screen.getByRole('listbox').className).toContain('z-[var(--z-dropdown)]')
  })
})

it('portals a viewport-clamped menu while preserving selection and outside dismissal', () => {
  const originalWidth = window.innerWidth
  const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    return (this.getAttribute('role') === 'listbox'
      ? { width: 300, height: 120, top: 0, bottom: 120, left: 0, right: 300 }
      : { width: 60, height: 28, top: 400, bottom: 428, left: 80, right: 140 }) as DOMRect
  })
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 375 })
  try {
    const change = vi.fn()
    const { container, unmount } = render(<Dropdown portal placement="top" align="right" width={300}
      items={ITEMS} value="sonnet" onChange={change} label="Model" trigger={<Button>Model</Button>} />)
    open()
    const menu = screen.getByRole('listbox')
    expect(container).not.toContainElement(menu)
    expect(menu).toHaveStyle({ position: 'fixed', left: '8px', visibility: 'visible' })
    fireEvent.pointerDown(screen.getByRole('option', { name: /Opus/ }))
    expect(screen.getByRole('listbox')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('option', { name: /Opus/ }))
    expect(change).toHaveBeenCalledWith('opus')
    expect(screen.getByRole('button', { name: 'Model' })).toHaveFocus()
    open()
    fireEvent.pointerDown(document.body)
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    open()
    fireEvent.scroll(screen.getByRole('listbox'))
    expect(screen.getByRole('listbox')).toBeInTheDocument()
    fireEvent.scroll(window)
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    open()
    fireEvent(window, new Event('resize'))
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    unmount()
  } finally {
    rect.mockRestore()
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: originalWidth })
  }
})

it.each([
  [false, 'listbox'], [true, 'listbox'], [false, 'button'], [true, 'button'],
] as const)('closes a portal on Tab (shift=%s, target=%s) without preventing native focus navigation', (shiftKey, target) => {
  render(<Dropdown portal items={ITEMS} value="sonnet" onChange={() => {}} label="Model" trigger={<Button>Model</Button>} />)
  open()
  const allowed = fireEvent.keyDown(screen.getByRole(target), { key: 'Tab', shiftKey })
  expect(allowed).toBe(true)
  expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Model' })).toHaveFocus()
 })
