import { useRef, useState } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import { describe, expect, it, vi } from 'vitest'

import { useDismissable, type DismissReason, type UseDismissableOptions } from './useDismissable'

type HarnessProps = Partial<Omit<UseDismissableOptions, 'refs' | 'onDismiss' | 'open'>> & {
  open?: boolean
  onDismiss: (reason: DismissReason) => void
  /** Also register the trigger so clicks on it are not treated as outside. */
  excludeTrigger?: boolean
}

function Harness({ open = true, onDismiss, excludeTrigger = false, ...options }: HarnessProps) {
  const panelRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)

  useDismissable({
    open,
    refs: [panelRef],
    triggerRef: excludeTrigger ? triggerRef : undefined,
    onDismiss,
    ...options,
  })

  return (
    <div>
      <button ref={triggerRef} type="button">Trigger</button>
      <div ref={panelRef} data-testid="panel">Panel body</div>
      <div data-testid="outside">Outside</div>
    </div>
  )
}

describe('useDismissable', () => {
  it('dismisses on a pointer press outside', () => {
    const onDismiss = vi.fn()
    render(<Harness onDismiss={onDismiss} />)

    fireEvent.pointerDown(screen.getByTestId('outside'))
    expect(onDismiss).toHaveBeenCalledWith('outside')
  })

  it('ignores presses inside the panel', () => {
    const onDismiss = vi.fn()
    render(<Harness onDismiss={onDismiss} />)

    fireEvent.pointerDown(screen.getByTestId('panel'))
    expect(onDismiss).not.toHaveBeenCalled()
  })

  it('ignores presses on the registered trigger', () => {
    // Without this the overlay closes here and the trigger's own handler
    // immediately reopens it, which reads as the menu refusing to close.
    const onDismiss = vi.fn()
    render(<Harness onDismiss={onDismiss} excludeTrigger />)

    fireEvent.pointerDown(screen.getByRole('button', { name: 'Trigger' }))
    expect(onDismiss).not.toHaveBeenCalled()
  })

  it('treats the trigger as outside when it is not registered', () => {
    const onDismiss = vi.fn()
    render(<Harness onDismiss={onDismiss} />)

    fireEvent.pointerDown(screen.getByRole('button', { name: 'Trigger' }))
    expect(onDismiss).toHaveBeenCalledWith('outside')
  })

  it('dismisses on Escape', () => {
    const onDismiss = vi.fn()
    render(<Harness onDismiss={onDismiss} />)

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onDismiss).toHaveBeenCalledWith('escape')
  })

  it('lets Escape reach an outer dialog by default', () => {
    const outer = vi.fn()
    document.addEventListener('keydown', outer)

    render(<Harness onDismiss={() => {}} />)
    fireEvent.keyDown(document, { key: 'Escape' })

    expect(outer).toHaveBeenCalled()
    document.removeEventListener('keydown', outer)
  })

  it('can swallow Escape so a nested overlay does not also close its dialog', () => {
    const outer = vi.fn()
    const onDismiss = vi.fn()
    document.addEventListener('keydown', outer)

    render(<Harness onDismiss={onDismiss} stopEscapePropagation />)
    fireEvent.keyDown(document, { key: 'Escape' })

    expect(onDismiss).toHaveBeenCalledWith('escape')
    expect(outer).not.toHaveBeenCalled()
    document.removeEventListener('keydown', outer)
  })

  it('can opt out of Escape', () => {
    const onDismiss = vi.fn()
    render(<Harness onDismiss={onDismiss} closeOnEscape={false} />)

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onDismiss).not.toHaveBeenCalled()
  })

  it('stays put while closed', () => {
    const onDismiss = vi.fn()
    render(<Harness open={false} onDismiss={onDismiss} />)

    fireEvent.pointerDown(screen.getByTestId('outside'))
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onDismiss).not.toHaveBeenCalled()
  })

  it('defaults to pointerdown rather than mousedown', () => {
    // mousedown does not fire reliably for touch input, which is why tapping
    // outside failed to close menus on the H5 build.
    const onDismiss = vi.fn()
    render(<Harness onDismiss={onDismiss} />)

    fireEvent.mouseDown(screen.getByTestId('outside'))
    expect(onDismiss).not.toHaveBeenCalled()

    fireEvent.pointerDown(screen.getByTestId('outside'))
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })

  it('honors an explicit event type', () => {
    const onDismiss = vi.fn()
    render(<Harness onDismiss={onDismiss} event="mousedown" />)

    fireEvent.mouseDown(screen.getByTestId('outside'))
    expect(onDismiss).toHaveBeenCalledWith('outside')
  })

  it('reports scroll and resize when watching the viewport', () => {
    const onDismiss = vi.fn()
    render(<Harness onDismiss={onDismiss} closeOnViewportChange />)

    fireEvent.scroll(window)
    expect(onDismiss).toHaveBeenCalledWith('scroll')

    fireEvent.resize(window)
    expect(onDismiss).toHaveBeenCalledWith('resize')
  })

  it('does not treat scrolling inside the overlay as a viewport change', () => {
    // The scroll listener is on capture, so a scroll container *inside* the
    // overlay reaches it too. Closing there makes an overlay that has its own
    // scrollbar impossible to scroll.
    const onDismiss = vi.fn()
    render(<Harness onDismiss={onDismiss} closeOnViewportChange />)

    fireEvent.scroll(screen.getByTestId('panel'))
    expect(onDismiss).not.toHaveBeenCalled()

    // ...while a scroll anywhere else still closes it, which is the whole point
    // of watching for viewport changes: the anchor has moved.
    fireEvent.scroll(screen.getByTestId('outside'))
    expect(onDismiss).toHaveBeenCalledWith('scroll')
  })

  it('ignores viewport changes by default', () => {
    const onDismiss = vi.fn()
    render(<Harness onDismiss={onDismiss} />)

    fireEvent.scroll(window)
    fireEvent.resize(window)
    expect(onDismiss).not.toHaveBeenCalled()
  })

  it('honors an exemption predicate for portalled children', () => {
    const onDismiss = vi.fn()
    render(
      <Harness
        onDismiss={onDismiss}
        isExempt={(target) => target instanceof HTMLElement && target.dataset.testid === 'outside'}
      />,
    )

    fireEvent.pointerDown(screen.getByTestId('outside'))
    expect(onDismiss).not.toHaveBeenCalled()
  })

  it('detaches its listeners on unmount', () => {
    const onDismiss = vi.fn()
    const { unmount } = render(<Harness onDismiss={onDismiss} />)
    unmount()

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onDismiss).not.toHaveBeenCalled()
  })

  it('stops listening once open flips to false', () => {
    function Toggle() {
      const [open, setOpen] = useState(true)
      return (
        <>
          <button type="button" onClick={() => setOpen(false)}>Close</button>
          <Harness open={open} onDismiss={onDismiss} />
        </>
      )
    }
    const onDismiss = vi.fn()
    render(<Toggle />)

    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onDismiss).not.toHaveBeenCalled()
  })
})

describe('useDismissable with embedded pages', () => {
  // A page in a `<webview>` never reports its pointer events to the app's
  // document; clicking into it only blurs the window and moves focus onto the
  // element. That is the outside click a menu over the workspace browser sees.
  function focusEmbedded(element: HTMLElement) {
    element.tabIndex = -1
    element.focus()
    window.dispatchEvent(new Event('blur'))
  }

  it('dismisses when focus moves into an embedded page outside the overlay', async () => {
    const onDismiss = vi.fn()
    render(<Harness onDismiss={onDismiss} />)
    const page = document.createElement('webview')
    document.body.appendChild(page)
    focusEmbedded(page)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(onDismiss).toHaveBeenCalledWith('outside')
    page.remove()
  })

  it('stays open when the window blurs for another app or for a frame inside the overlay', async () => {
    const onDismiss = vi.fn()
    render(<Harness onDismiss={onDismiss} />)
    window.dispatchEvent(new Event('blur'))
    const frame = document.createElement('iframe')
    screen.getByTestId('panel').appendChild(frame)
    focusEmbedded(frame)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(onDismiss).not.toHaveBeenCalled()
  })
})
