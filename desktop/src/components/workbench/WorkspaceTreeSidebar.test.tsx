import { act, fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useState } from 'react'
import { WorkspaceTreeSidebar } from './WorkspaceTreeSidebar'

function Fixture() {
  const [open, setOpen] = useState(true)
  return <div><button onClick={() => setOpen(!open)}>Tree</button><WorkspaceTreeSidebar open={open} onOpenChange={setOpen}><div>file rows</div></WorkspaceTreeSidebar></div>
}

afterEach(() => vi.unstubAllGlobals())

describe('WorkspaceTreeSidebar', () => {
  it('collapses at narrow content widths and can explicitly reopen as an overlay', () => {
    let resize: ResizeObserverCallback = () => {}
    const disconnect = vi.fn()
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: ResizeObserverCallback) { resize = callback }
      observe() {}
      disconnect = disconnect
    })
    const view = render(<Fixture />)
    act(() => resize([{ contentRect: { width: 500 } } as ResizeObserverEntry], {} as ResizeObserver))
    expect(screen.getByText('file rows')).not.toBeVisible()
    fireEvent.click(screen.getByText('Tree'))
    expect(screen.getByText('file rows')).toBeVisible()
    expect(screen.getByTestId('workspace-tree-sidebar')).toHaveAttribute('data-overlay', 'true')
    view.unmount()
    expect(disconnect).toHaveBeenCalled()
  })

  it('resizes with keyboard controls and restores the default width', () => {
    render(<Fixture />)
    const handle = screen.getByRole('separator')
    fireEvent.keyDown(handle, { key: 'ArrowLeft' })
    expect(handle).toHaveAttribute('aria-valuenow', '320')
    fireEvent.keyDown(handle, { key: 'ArrowRight' })
    expect(handle).toHaveAttribute('aria-valuenow', '300')
    fireEvent.keyDown(handle, { key: 'ArrowLeft' })
    fireEvent.doubleClick(handle)
    expect(handle).toHaveAttribute('aria-valuenow', '300')
  })
})
