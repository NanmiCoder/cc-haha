import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom'
import { act, StrictMode } from 'react'
import { useElementWidth } from './useElementWidth'

const originalOffsetWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth')

function Probe() {
  const [measuredRef, width] = useElementWidth<HTMLDivElement>()
  return (
    <div ref={measuredRef} data-testid="measured">
      <span data-testid="width">{width === null ? 'unmeasured' : String(width)}</span>
    </div>
  )
}

describe('useElementWidth', () => {
  const observers = new Set<() => void>()
  let width = 0

  function stubLayout(initialWidth: number) {
    width = initialWidth
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
      configurable: true,
      get: () => width,
    })
  }

  function stubResizeObserver() {
    class StubResizeObserver {
      constructor(private readonly callback: () => void) {}
      observe() { observers.add(this.callback) }
      unobserve() { observers.delete(this.callback) }
      disconnect() { observers.delete(this.callback) }
    }
    vi.stubGlobal('ResizeObserver', StubResizeObserver)
  }

  function resizeTo(next: number) {
    width = next
    act(() => {
      observers.forEach((notify) => notify())
    })
  }

  afterEach(() => {
    observers.clear()
    width = 0
    vi.unstubAllGlobals()
    if (originalOffsetWidth) {
      Object.defineProperty(HTMLElement.prototype, 'offsetWidth', originalOffsetWidth)
    } else {
      Reflect.deleteProperty(HTMLElement.prototype, 'offsetWidth')
    }
  })

  it('measures the node as soon as it mounts', () => {
    stubLayout(640)
    stubResizeObserver()

    render(<Probe />)

    expect(screen.getByTestId('width')).toHaveTextContent('640')
  })

  // A caller that cannot tell "no layout yet" from "laid out at zero" has to
  // treat an unlaid-out first frame as the narrowest possible column, which is
  // exactly the frame users would see flash before the real measurement lands.
  it('reports null rather than zero while the environment lays nothing out', () => {
    render(<Probe />)

    expect(screen.getByTestId('width')).toHaveTextContent('unmeasured')
  })

  it('tracks later resizes', () => {
    stubLayout(640)
    stubResizeObserver()

    render(<Probe />)
    resizeTo(320)

    expect(screen.getByTestId('width')).toHaveTextContent('320')
  })

  it('keeps observing after StrictMode replays effects and cleans up on unmount', () => {
    stubLayout(400)
    stubResizeObserver()

    const view = render(<StrictMode><Probe /></StrictMode>)
    expect(screen.getByTestId('width')).toHaveTextContent('400')

    // The desktop bootstrap uses StrictMode. Its effect replay disconnects
    // the first observer while retaining the DOM node and its callback ref.
    resizeTo(560)
    expect(screen.getByTestId('width')).toHaveTextContent('560')
    resizeTo(320)
    expect(screen.getByTestId('width')).toHaveTextContent('320')
    expect(observers.size).toBe(1)

    view.unmount()
    expect(observers.size).toBe(0)
  })

  it('still measures once when the environment has no ResizeObserver', () => {
    stubLayout(500)

    render(<Probe />)

    expect(screen.getByTestId('width')).toHaveTextContent('500')
  })

  it('stops observing when the node unmounts', () => {
    stubLayout(640)
    stubResizeObserver()

    const view = render(<Probe />)
    expect(observers.size).toBe(1)

    view.unmount()

    expect(observers.size).toBe(0)
  })
})
