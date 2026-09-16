import { act, fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { Button } from './Button'
import { Tooltip } from './Tooltip'

describe('Tooltip', () => {
  it('offers a surface hint without stacking inverse colors over it', () => {
    render(<Tooltip appearance="surface" content={<span>Toggle panel <kbd>⌘J</kbd></span>} delay={0}><Button>Toggle</Button></Tooltip>)
    fireEvent.focus(screen.getByRole('button'))
    const tooltip = screen.getByRole('tooltip')
    expect(tooltip).toHaveTextContent('⌘J')
    expect(tooltip.className).toContain('bg-[var(--color-surface-container-lowest)]')
    expect(tooltip.className).not.toContain('bg-[var(--color-inverse-surface)]')
  })
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  function showAfterDelay() {
    act(() => { vi.advanceTimersByTime(400) })
  }

  it('stays hidden until the delay elapses', () => {
    render(<Tooltip content="Copy path"><button>Copy</button></Tooltip>)

    fireEvent.mouseEnter(screen.getByRole('button'))
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()

    showAfterDelay()
    expect(screen.getByRole('tooltip')).toHaveTextContent('Copy path')
  })

  it('opens on keyboard focus, not only hover', () => {
    // A keyboard user never generates a mouseenter; several of the five
    // hand-rolled tooltips were unreachable this way.
    render(<Tooltip content="Copy path"><button>Copy</button></Tooltip>)

    fireEvent.focus(screen.getByRole('button'))
    showAfterDelay()
    expect(screen.getByRole('tooltip')).toBeInTheDocument()
  })

  it('describes the trigger rather than renaming it', () => {
    // aria-label would replace the button's name; an icon button would then be
    // announced as its tooltip text instead of its action.
    render(<Tooltip content="Copy path"><button>Copy</button></Tooltip>)
    const button = screen.getByRole('button', { name: 'Copy' })

    fireEvent.mouseEnter(button)
    showAfterDelay()

    expect(button).toHaveAttribute('aria-describedby', screen.getByRole('tooltip').id)
    expect(screen.getByRole('button', { name: 'Copy' })).toBeInTheDocument()
  })

  it('closes on mouse leave and on blur', () => {
    render(<Tooltip content="Copy path"><button>Copy</button></Tooltip>)
    const button = screen.getByRole('button')

    fireEvent.mouseEnter(button)
    showAfterDelay()
    fireEvent.mouseLeave(button)
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()

    fireEvent.focus(button)
    showAfterDelay()
    fireEvent.blur(button)
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
  })

  it('closes on Escape without moving focus', () => {
    render(<Tooltip content="Copy path"><button>Copy</button></Tooltip>)
    const button = screen.getByRole('button')

    fireEvent.focus(button)
    showAfterDelay()
    fireEvent.keyDown(button, { key: 'Escape' })

    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
  })

  it('cancels a pending open when the cursor leaves first', () => {
    render(<Tooltip content="Copy path"><button>Copy</button></Tooltip>)
    const button = screen.getByRole('button')

    fireEvent.mouseEnter(button)
    fireEvent.mouseLeave(button)
    showAfterDelay()

    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
  })

  it('never opens while disabled', () => {
    render(<Tooltip content="Copy path" disabled><button>Copy</button></Tooltip>)

    fireEvent.mouseEnter(screen.getByRole('button'))
    showAfterDelay()
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
  })

  it('opens immediately with delay 0', () => {
    render(<Tooltip content="Copy path" delay={0}><button>Copy</button></Tooltip>)

    fireEvent.mouseEnter(screen.getByRole('button'))
    expect(screen.getByRole('tooltip')).toBeInTheDocument()
  })

  it('sits on the tooltip layer of the shared z scale', () => {
    render(<Tooltip content="Copy path" delay={0}><button>Copy</button></Tooltip>)
    fireEvent.mouseEnter(screen.getByRole('button'))

    expect(screen.getByRole('tooltip').style.zIndex).toBe('var(--z-tooltip)')
  })

  it('anchors to a component trigger, not just a DOM element', () => {
    // The gallery caught this: every test here passed a raw `<button>`, which
    // accepts a ref natively. A function component that does not forward its
    // ref swallows it, and the tooltip has nothing to measure against — no
    // error, just a tooltip parked at 0,0.
    render(
      <Tooltip content="Copy path" delay={0}>
        <Button>Copy</Button>
      </Tooltip>,
    )

    fireEvent.mouseEnter(screen.getByRole('button', { name: 'Copy' }))
    expect(screen.getByRole('tooltip')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Copy' }))
      .toHaveAttribute('aria-describedby', screen.getByRole('tooltip').id)
  })

  it('still calls the trigger\'s own handlers', () => {
    const onKeyDown = vi.fn()
    render(
      <Tooltip content="Copy path">
        <button onKeyDown={onKeyDown}>Copy</button>
      </Tooltip>,
    )

    fireEvent.keyDown(screen.getByRole('button'), { key: 'a' })
    expect(onKeyDown).toHaveBeenCalled()
  })
})
