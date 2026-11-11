import { fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { createPortal } from 'react-dom'
import { MobileSessionDrawer } from './MobileSessionDrawer'

vi.mock('@/i18n', () => ({ useTranslation: () => (key: string) => key }))
class TestPointerEvent extends MouseEvent {
  isPrimary = true
  pointerId = 1
}

describe('MobileSessionDrawer', () => {
  beforeAll(() => {
    if (!('PointerEvent' in window)) Object.defineProperty(window, 'PointerEvent', { configurable: true, value: TestPointerEvent })
  })
  const setup = () => {
    const close = vi.fn()
    render(<MobileSessionDrawer onClose={close}><button>First chat</button><button>Last chat</button></MobileSessionDrawer>)
    return { close, panel: screen.getByTestId('mobile-session-drawer-panel') }
  }

  it('left swipe dismisses navigation without requiring an edge/system gesture', () => {
    const { close, panel } = setup()
    fireEvent.pointerDown(panel, { clientX: 220, clientY: 200 })
    fireEvent.pointerMove(panel, { clientX: 130, clientY: 205 })
    fireEvent.pointerUp(panel, { clientX: 120, clientY: 205 })
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('vertical scrolling cannot accidentally close the session list', () => {
    const { close, panel } = setup()
    fireEvent.pointerDown(panel, { clientX: 220, clientY: 200 })
    fireEvent.pointerMove(panel, { clientX: 215, clientY: 260 })
    fireEvent.pointerMove(panel, { clientX: 120, clientY: 280 })
    fireEvent.pointerUp(panel, { clientX: 120, clientY: 280 })
    expect(close).not.toHaveBeenCalled()
  })

  it.each(['pointercancel', 'pointerup'])('ignores a cancelled drag or a small nudge (%s)', event => {
    const { close, panel } = setup()
    const endX = event === 'pointercancel' ? 100 : 205
    fireEvent.pointerDown(panel, { clientX: 220, clientY: 200 })
    fireEvent.pointerMove(panel, { clientX: endX, clientY: 200 })
    fireEvent(panel, new TestPointerEvent(event, { bubbles: true, clientX: endX, clientY: 200 }))
    expect(close).not.toHaveBeenCalled()
  })

  it('closes on the exposed conversation scrim and on Escape', () => {
    const { close } = setup()
    fireEvent.pointerDown(screen.getByTestId('mobile-session-drawer'))
    expect(close).toHaveBeenCalledTimes(1)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(close).toHaveBeenCalledTimes(2)
  })

  it('keeps keyboard focus inside navigation', () => {
    const { panel } = setup()
    expect(panel).toHaveFocus()
    fireEvent.keyDown(panel, { key: 'Tab', shiftKey: true })
    expect(screen.getByRole('button', { name: 'Last chat' })).toHaveFocus()
    fireEvent.keyDown(screen.getByRole('button', { name: 'Last chat' }), { key: 'Tab' })
    expect(screen.getByRole('button', { name: 'First chat' })).toHaveFocus()
  })

  it('does not swipe away or steal focus from a portalled rename dialog', () => {
    const close = vi.fn()
    render(<MobileSessionDrawer onClose={close}>
      <button>Background chat</button>
      {createPortal(<div role="dialog" aria-modal="true"><input aria-label="Rename" /><button>Save name</button></div>, document.body)}
    </MobileSessionDrawer>)
    const input = screen.getByRole('textbox', { name: 'Rename' })
    fireEvent.pointerDown(input, { clientX: 220, clientY: 200 })
    fireEvent.pointerMove(input, { clientX: 100, clientY: 200 })
    fireEvent.pointerUp(input, { clientX: 100, clientY: 200 })
    expect(close).not.toHaveBeenCalled()
    input.focus()
    fireEvent.keyDown(input, { key: 'Tab', shiftKey: true })
    expect(screen.getByRole('button', { name: 'Save name' })).toHaveFocus()
  })
})
