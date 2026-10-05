import { afterEach, describe, expect, it } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'

import {
  CATALOG_CARD_MIN_HEIGHT,
  CATALOG_COLUMN_FLOOR,
  CATALOG_GAP,
  catalogColumnsForWidth,
  useMarketGridFill,
} from './useMarketGridFill'

const ROW_HEIGHT = CATALOG_CARD_MIN_HEIGHT + CATALOG_GAP
const originalGetBoundingClientRect = Element.prototype.getBoundingClientRect
const originalHeight = window.innerHeight

function setViewportHeight(height: number) {
  Object.defineProperty(window, 'innerHeight', { value: height, configurable: true, writable: true })
}

/** jsdom lays nothing out, so the grid's box is stubbed. */
function stubGridBox({ top, width }: { top: number; width: number }) {
  Element.prototype.getBoundingClientRect = function getBoundingClientRect() {
    return { ...new DOMRect(0, top, width, 0), top, width } as DOMRect
  }
}

function Probe({ mounted = true }: { mounted?: boolean }) {
  const { measureRef, columns, count } = useMarketGridFill()
  return (
    <div>
      <span data-testid="columns">{columns}</span>
      <span data-testid="count">{count}</span>
      {mounted && <div ref={measureRef} data-testid="grid" />}
    </div>
  )
}

afterEach(() => {
  Element.prototype.getBoundingClientRect = originalGetBoundingClientRect
  setViewportHeight(originalHeight)
})

describe('catalogColumnsForWidth', () => {
  it.each([
    // A track plus the gap that precedes it; the first track pays no gap.
    [CATALOG_COLUMN_FLOOR, 1],
    [CATALOG_COLUMN_FLOOR * 2 + CATALOG_GAP - 1, 1],
    [CATALOG_COLUMN_FLOOR * 2 + CATALOG_GAP, 2],
    [CATALOG_COLUMN_FLOOR * 3 + CATALOG_GAP * 2, 3],
    [1200, 3],
  ])('resolves %ipx to %i columns, matching auto-fill', (width, expected) => {
    expect(catalogColumnsForWidth(width)).toBe(expected)
  })

  it('never drops below a single column on a phone-width shell', () => {
    // Same bundle serves the touch H5 shell; `min(100%, floor)` keeps one
    // track there, so the arithmetic has to agree rather than return zero.
    expect(catalogColumnsForWidth(320)).toBe(1)
    expect(catalogColumnsForWidth(0)).toBe(1)
  })
})

describe('useMarketGridFill', () => {
  it('takes its column count from the container, not the viewport', () => {
    // The catalogue is inset beside a sidebar, so viewport width says nothing
    // useful — this is the case a breakpoint table gets wrong.
    setViewportHeight(900)
    stubGridBox({ top: 0, width: 940 })

    render(<Probe />)

    expect(screen.getByTestId('columns')).toHaveTextContent('2')
  })

  it('fills the space below the grid rather than stopping at a fixed two rows', () => {
    // A tall desktop shell: 1400px of window with the grid starting at 300px
    // leaves room for five rows, so a fixed six cards left three rows of dead
    // whitespace under the placeholder.
    setViewportHeight(1400)
    stubGridBox({ top: 300, width: 1200 })

    render(<Probe />)

    const rows = Math.ceil((1400 - 300 - 24) / ROW_HEIGHT)
    expect(rows).toBe(5)
    expect(screen.getByTestId('count')).toHaveTextContent(String(rows * 3))
  })

  it('never promises more placeholders than a page can deliver', () => {
    setViewportHeight(6000)
    stubGridBox({ top: 0, width: 1200 })

    render(<Probe />)

    expect(screen.getByTestId('count')).toHaveTextContent('24')
  })

  it('keeps at least one row on a short window', () => {
    setViewportHeight(320)
    stubGridBox({ top: 300, width: 1200 })

    render(<Probe />)

    expect(screen.getByTestId('count')).toHaveTextContent('3')
  })

  it('remeasures when the window resizes', () => {
    setViewportHeight(800)
    stubGridBox({ top: 0, width: 1200 })

    render(<Probe />)
    // (800 - 24) / 216 rounds up to 4 rows across 3 columns.
    expect(screen.getByTestId('count')).toHaveTextContent('12')

    act(() => {
      setViewportHeight(1100)
      stubGridBox({ top: 0, width: 700 })
      window.dispatchEvent(new Event('resize'))
    })

    // (1100 - 24) / 216 rounds up to 5 rows, now across 2 columns.
    expect(screen.getByTestId('columns')).toHaveTextContent('2')
    expect(screen.getByTestId('count')).toHaveTextContent('10')
  })

  it('holds its last measurement when no grid is mounted', () => {
    setViewportHeight(900)
    stubGridBox({ top: 0, width: 1200 })

    const { rerender } = render(<Probe />)
    expect(screen.getByTestId('columns')).toHaveTextContent('3')

    // The catalogue swaps the placeholder for the real grid and back; neither
    // gap should reset the count to a default the reader would see flash.
    rerender(<Probe mounted={false} />)
    expect(screen.getByTestId('columns')).toHaveTextContent('3')
  })
})
