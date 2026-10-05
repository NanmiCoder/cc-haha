import { useState } from 'react'
import { createPortal } from 'react-dom'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { LONG_PRESS_DELAY_MS, useLongPress } from './useLongPress'

// jsdom has no PointerEvent, so fireEvent falls back to a bare Event and drops
// the coordinates the move tolerance reads. A MouseEvent subclass carries them.
class TestPointerEvent extends MouseEvent {
  pointerType: string
  isPrimary: boolean
  constructor(type: string, init: MouseEventInit & { pointerType?: string; isPrimary?: boolean } = {}) {
    super(type, init)
    this.pointerType = init.pointerType ?? 'touch'
    this.isPrimary = init.isPrimary ?? true
  }
}

beforeAll(() => {
  if (!('PointerEvent' in window)) {
    Object.defineProperty(window, 'PointerEvent', { configurable: true, value: TestPointerEvent })
  }
})

function Row({ onLongPress, onClick }: { onLongPress: () => void; onClick: () => void }) {
  const handlers = useLongPress({ onLongPress })
  return <button type="button" onClick={onClick} {...handlers}>row</button>
}

function touchDown(element: HTMLElement, x = 10, y = 10) {
  fireEvent.pointerDown(element, { pointerType: 'touch', isPrimary: true, clientX: x, clientY: y })
}

describe('useLongPress', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('fires after holding a touch and swallows the click that ends the press', () => {
    const onLongPress = vi.fn()
    const onClick = vi.fn()
    render(<Row onLongPress={onLongPress} onClick={onClick} />)
    const row = screen.getByRole('button', { name: 'row' })

    touchDown(row)
    act(() => { vi.advanceTimersByTime(LONG_PRESS_DELAY_MS) })
    fireEvent.pointerUp(row)
    fireEvent.click(row)

    expect(onLongPress).toHaveBeenCalledTimes(1)
    expect(onClick).not.toHaveBeenCalled()
  })

  it('treats a short tap as a tap', () => {
    const onLongPress = vi.fn()
    const onClick = vi.fn()
    render(<Row onLongPress={onLongPress} onClick={onClick} />)
    const row = screen.getByRole('button', { name: 'row' })

    touchDown(row)
    act(() => { vi.advanceTimersByTime(LONG_PRESS_DELAY_MS - 100) })
    fireEvent.pointerUp(row)
    fireEvent.click(row)
    act(() => { vi.advanceTimersByTime(LONG_PRESS_DELAY_MS) })

    expect(onLongPress).not.toHaveBeenCalled()
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it('cancels when the finger moves, because that is a scroll', () => {
    const onLongPress = vi.fn()
    render(<Row onLongPress={onLongPress} onClick={vi.fn()} />)
    const row = screen.getByRole('button', { name: 'row' })

    touchDown(row, 10, 10)
    fireEvent.pointerMove(row, { pointerType: 'touch', clientX: 10, clientY: 40 })
    act(() => { vi.advanceTimersByTime(LONG_PRESS_DELAY_MS * 2) })

    expect(onLongPress).not.toHaveBeenCalled()
  })

  it('opens once when Android also fires contextmenu during the hold', () => {
    const onLongPress = vi.fn()
    render(<Row onLongPress={onLongPress} onClick={vi.fn()} />)
    const row = screen.getByRole('button', { name: 'row' })

    touchDown(row)
    act(() => { vi.advanceTimersByTime(LONG_PRESS_DELAY_MS) })
    fireEvent.contextMenu(row)

    expect(onLongPress).toHaveBeenCalledTimes(1)
  })

  it('lets a tap in the menu the press opened through, though React bubbles it back', () => {
    const onPick = vi.fn()
    function RowWithMenu() {
      const [open, setOpen] = useState(false)
      const handlers = useLongPress({ onLongPress: () => setOpen(true) })
      return (
        <div data-testid="row" {...handlers}>
          row
          {open ? createPortal(<button type="button" onClick={onPick}>pick</button>, document.body) : null}
        </div>
      )
    }
    render(<RowWithMenu />)
    const row = screen.getByTestId('row')

    touchDown(row)
    act(() => { vi.advanceTimersByTime(LONG_PRESS_DELAY_MS) })
    fireEvent.pointerUp(row)
    fireEvent.click(screen.getByRole('button', { name: 'pick' }))

    expect(onPick).toHaveBeenCalledTimes(1)
  })

  it('answers a right click on its own, without the native menu', () => {
    const onLongPress = vi.fn()
    render(<Row onLongPress={onLongPress} onClick={vi.fn()} />)
    const row = screen.getByRole('button', { name: 'row' })

    fireEvent.pointerDown(row, { pointerType: 'mouse', isPrimary: true, button: 2 })
    const notPrevented = fireEvent.contextMenu(row)

    expect(onLongPress).toHaveBeenCalledTimes(1)
    expect(notPrevented).toBe(false)
  })
})
