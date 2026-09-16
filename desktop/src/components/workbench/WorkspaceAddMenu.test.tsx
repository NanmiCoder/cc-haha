import { StrictMode, useRef, useState } from 'react'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import '@testing-library/jest-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useOverlayStore } from '@/stores/overlayStore'
import { WorkspaceAddMenu } from './WorkspaceAddMenu'

const selected = vi.fn()

function Harness({ last = false, disabled = false }: { last?: boolean; disabled?: boolean }) {
  const triggerRef = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  return <>
    <button ref={triggerRef} onClick={() => setOpen(value => !value)}>Add</button>
    <input aria-label="Outside" />
    {open && <WorkspaceAddMenu id="add-menu" anchorRef={triggerRef} dock="side"
      initialFocus={last ? 'last' : 'first'} reviewUnavailableReason={disabled ? 'Not a Git repository' : null}
      onSelect={kind => { selected(kind); setOpen(false) }} onClose={() => setOpen(false)} />}
  </>
}

beforeEach(() => {
  selected.mockClear()
  useOverlayStore.setState({ count: 0, snapshotCount: 0 })
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('WorkspaceAddMenu', () => {
  it('waits for the measured menu to be visible before focusing an action', () => {
    const originalFocus = HTMLElement.prototype.focus
    const hiddenAttempts: HTMLElement[] = []
    vi.spyOn(HTMLElement.prototype, 'focus').mockImplementation(function (this: HTMLElement, options) {
      if (this.closest<HTMLElement>('[role="menu"]')?.style.visibility === 'hidden') {
        hiddenAttempts.push(this)
        return // Chromium refuses this focus; jsdom normally accepts it.
      }
      originalFocus.call(this, options)
    })
    render(<Harness />)
    fireEvent.click(screen.getByText('Add'))
    expect(hiddenAttempts).toHaveLength(0)
    expect(screen.getByTestId('workspace-menu-review')).toHaveFocus()
  })

  it('portals next to the actual trigger, shifting away from the viewport edge', () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const box = this.textContent === 'Add'
        ? { left: 990, right: 1018, top: 20, bottom: 48, width: 28, height: 28 }
        : { left: 0, right: 280, top: 0, bottom: 146, width: 280, height: 146 }
      return { ...box, x: box.left, y: box.top, toJSON() { return box } } as DOMRect
    })
    const { container } = render(<Harness />)
    fireEvent.click(screen.getByText('Add'))
    const menu = screen.getByRole('menu')
    expect(container).not.toContainElement(menu)
    expect(menu).toHaveStyle({ position: 'fixed', top: '49px', left: `${window.innerWidth - 286}px` })
    expect(within(menu).getAllByRole('menuitem').map(item => item.getAttribute('data-testid')))
      .toEqual(['workspace-menu-review', 'workspace-menu-terminal', 'workspace-menu-browser', 'workspace-menu-file'])
  })

  it('navigates enabled actions without wrapping at the ends and supports Home/End', () => {
    render(<Harness disabled />)
    fireEvent.click(screen.getByText('Add'))
    const menu = screen.getByRole('menu')
    const terminal = screen.getByTestId('workspace-menu-terminal')
    const browser = screen.getByTestId('workspace-menu-browser')
    const file = screen.getByTestId('workspace-menu-file')
    expect(screen.getByTestId('workspace-menu-review')).toBeDisabled()
    expect(terminal).toHaveFocus()
    fireEvent.keyDown(menu, { key: 'ArrowUp' })
    expect(terminal).toHaveFocus()
    fireEvent.keyDown(menu, { key: 'ArrowDown' })
    expect(browser).toHaveFocus()
    fireEvent.keyDown(menu, { key: 'End' })
    expect(file).toHaveFocus()
    fireEvent.keyDown(menu, { key: 'ArrowDown' })
    expect(file).toHaveFocus()
    fireEvent.keyDown(menu, { key: 'Home' })
    expect(terminal).toHaveFocus()
  })

  it('opens on the last action when requested and returns focus on Escape', () => {
    render(<Harness last />)
    const trigger = screen.getByText('Add')
    fireEvent.click(trigger)
    expect(screen.getByTestId('workspace-menu-file')).toHaveFocus()
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
    expect(trigger).toHaveFocus()
    expect(selected).not.toHaveBeenCalled()
  })

  it('keeps outside focus, ignores clicks inside and toggles off on the trigger', () => {
    render(<Harness />)
    fireEvent.click(screen.getByText('Add'))
    fireEvent.pointerDown(screen.getByRole('menu'))
    expect(screen.getByRole('menu')).toBeInTheDocument()
    const outside = screen.getByRole('textbox')
    outside.focus()
    fireEvent.pointerDown(outside)
    expect(screen.queryByRole('menu')).toBeNull()
    expect(outside).toHaveFocus()
    fireEvent.click(screen.getByText('Add'))
    fireEvent.pointerDown(screen.getByText('Add'))
    expect(screen.getByRole('menu')).toBeInTheDocument()
    fireEvent.click(screen.getByText('Add'))
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it.each(['blur', 'resize', 'scroll'])('dismisses on window %s without creating anything', event => {
    render(<Harness />)
    fireEvent.click(screen.getByText('Add'))
    fireEvent.scroll(screen.getByRole('menu'))
    expect(screen.getByRole('menu')).toBeInTheDocument()
    fireEvent(window, new Event(event))
    expect(screen.queryByRole('menu')).toBeNull()
    expect(selected).not.toHaveBeenCalled()
  })

  it('selects one resource and balances native snapshot suppression in StrictMode', () => {
    const { unmount } = render(<StrictMode><Harness /></StrictMode>)
    fireEvent.click(screen.getByText('Add'))
    expect(useOverlayStore.getState()).toMatchObject({ count: 1, snapshotCount: 1 })
    fireEvent.click(screen.getByTestId('workspace-menu-browser'))
    expect(selected).toHaveBeenCalledExactlyOnceWith('browser')
    expect(screen.queryByRole('menu')).toBeNull()
    expect(useOverlayStore.getState()).toMatchObject({ count: 0, snapshotCount: 0 })
    fireEvent.click(screen.getByText('Add'))
    unmount()
    expect(useOverlayStore.getState()).toMatchObject({ count: 0, snapshotCount: 0 })
  })
})
