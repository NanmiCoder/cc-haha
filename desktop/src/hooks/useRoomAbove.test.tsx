import { StrictMode, type ReactNode } from 'react'
import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom'

import { useRoomAbove } from './useRoomAbove'

/**
 * jsdom lays nothing out: every rect is zero, `offsetParent` is null and there
 * is no ResizeObserver or IntersectionObserver. The tests stub all four from
 * `data-testid` / `data-positioned`, which is the whole input the hook measures.
 */
const rects = new Map<string, Partial<DOMRect>>()
const originalRect = HTMLElement.prototype.getBoundingClientRect
const originalOffsetParent = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetParent')

function setRect(testId: string, rect: Partial<DOMRect>) {
  rects.set(testId, rect)
}

const observers = new Set<() => void>()

function notifyResizeObservers() {
  act(() => {
    observers.forEach((notify) => notify())
  })
}

type Intersection = {
  callback: IntersectionObserverCallback
  options?: IntersectionObserverInit
  target?: Element
  disconnected: boolean
}
const intersections: Intersection[] = []

/** The one IntersectionObserver currently armed; the hook re-arms by replacing it. */
function liveIntersection(): Intersection {
  const live = intersections.filter((entry) => !entry.disconnected)
  expect(live).toHaveLength(1)
  return live[0]!
}

function reportIntersection(intersectionRatio: number) {
  const live = liveIntersection()
  act(() => {
    live.callback([{ intersectionRatio } as IntersectionObserverEntry], {} as IntersectionObserver)
  })
}

beforeEach(() => {
  HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect(this: HTMLElement) {
    const rect = rects.get(this.dataset.testid ?? '') ?? {}
    return {
      top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0,
      toJSON: () => ({}),
      ...rect,
      x: rect.left ?? 0,
      y: rect.top ?? 0,
    } as DOMRect
  }
  Object.defineProperty(HTMLElement.prototype, 'offsetParent', {
    configurable: true,
    get(this: HTMLElement) {
      return this.parentElement?.closest('[data-positioned]') ?? null
    },
  })
  class StubResizeObserver {
    constructor(private readonly callback: () => void) {}
    observe() { observers.add(this.callback) }
    unobserve() { observers.delete(this.callback) }
    disconnect() { observers.delete(this.callback) }
  }
  vi.stubGlobal('ResizeObserver', StubResizeObserver)
  class StubIntersectionObserver {
    private readonly record: Intersection
    constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
      this.record = { callback, options, disconnected: false }
      intersections.push(this.record)
    }
    observe(target: Element) { this.record.target = target }
    unobserve() {}
    disconnect() { this.record.disconnected = true }
    takeRecords() { return [] }
  }
  vi.stubGlobal('IntersectionObserver', StubIntersectionObserver)
})

afterEach(() => {
  rects.clear()
  observers.clear()
  intersections.length = 0
  vi.restoreAllMocks()
  HTMLElement.prototype.getBoundingClientRect = originalRect
  if (originalOffsetParent) Object.defineProperty(HTMLElement.prototype, 'offsetParent', originalOffsetParent)
  else delete (HTMLElement.prototype as { offsetParent?: unknown }).offsetParent
  vi.unstubAllGlobals()
})

function Overlay() {
  const [roomRef, room] = useRoomAbove<HTMLDivElement>()
  return <div ref={roomRef} data-testid="overlay" data-room={room ?? 'unmeasured'} />
}

/** A page that clips its overflow, holding a positioned composer the overlay opens above. */
function Page({ clips = true, children }: { clips?: boolean; children: ReactNode }) {
  return (
    <div data-testid="page" style={clips ? { overflowY: 'hidden' } : undefined}>
      <div data-testid="composer" data-positioned="">
        {children}
      </div>
    </div>
  )
}

const room = () => screen.getByTestId('overlay').dataset.room

describe('useRoomAbove', () => {
  it('leaves the room from the overlay bottom edge to the top of the clipping page, less an 8px gap', () => {
    // The #1587 layout: the page starts under the 52px tab bar and the slash
    // menu's bottom edge sits 8px above a composer centred on the page.
    setRect('page', { top: 52, bottom: 751 })
    setRect('overlay', { bottom: 306 })

    render(<Page><Overlay /></Page>)

    expect(room()).toBe('246')
  })

  it('ignores overflow between the overlay and the composer it is positioned against', () => {
    setRect('page', { top: 52 })
    setRect('wrapper', { top: 280 })
    setRect('overlay', { bottom: 306 })

    render(
      <Page>
        <div data-testid="wrapper" style={{ overflowY: 'hidden' }}>
          <Overlay />
        </div>
      </Page>,
    )

    expect(room()).toBe('246')
  })

  it('measures to the top of the window when nothing clips the overlay', () => {
    setRect('page', { top: 52 })
    setRect('overlay', { bottom: 306 })

    render(<Page clips={false}><Overlay /></Page>)

    expect(room()).toBe('298')
  })

  it('reports no room instead of a negative height', () => {
    setRect('page', { top: 52 })
    setRect('overlay', { bottom: 40 })

    render(<Page><Overlay /></Page>)

    expect(room()).toBe('0')
  })

  it('re-measures when the window resizes and when the composer grows', () => {
    setRect('page', { top: 52 })
    setRect('overlay', { bottom: 306 })
    render(<Page><Overlay /></Page>)
    expect(room()).toBe('246')

    setRect('overlay', { bottom: 200 })
    act(() => { window.dispatchEvent(new Event('resize')) })
    expect(room()).toBe('140')

    setRect('overlay', { bottom: 260 })
    notifyResizeObservers()
    expect(room()).toBe('200')
  })

  it('re-measures when the composer moves without resizing, as when the bottom terminal opens under it', () => {
    setRect('page', { top: 52 })
    setRect('composer', { top: 314, bottom: 441, left: 300, right: 1068, width: 768, height: 127 })
    setRect('overlay', { bottom: 306 })
    render(<Page><Overlay /></Page>)
    expect(room()).toBe('246')
    // Movement is watched on the composer the overlay is positioned against.
    expect(liveIntersection().target).toBe(screen.getByTestId('composer'))
    expect(liveIntersection().options?.rootMargin).toMatch(/^-314px /)

    // Same size, 122px higher: nothing a ResizeObserver or a window resize
    // would report.
    setRect('composer', { top: 192, bottom: 319, left: 300, right: 1068, width: 768, height: 127 })
    setRect('overlay', { bottom: 184 })
    reportIntersection(0.4)

    expect(room()).toBe('124')
    // Re-armed around the new rect, so the next movement is caught too.
    expect(liveIntersection().options?.rootMargin).toMatch(/^-192px /)
  })

  it('does not re-arm while the composer stays where it is', () => {
    setRect('page', { top: 52 })
    setRect('composer', { top: 314, bottom: 441, left: 300, right: 1068, width: 768, height: 127 })
    setRect('overlay', { bottom: 306 })
    render(<Page><Overlay /></Page>)
    const armed = intersections.length

    // The first report of a full intersection is the observer confirming the rect.
    reportIntersection(1)

    expect(intersections).toHaveLength(armed)
    expect(room()).toBe('246')
  })

  it('keeps re-measuring under StrictMode', () => {
    setRect('page', { top: 52 })
    setRect('overlay', { bottom: 306 })
    render(<StrictMode><Page><Overlay /></Page></StrictMode>)

    setRect('overlay', { bottom: 200 })
    act(() => { window.dispatchEvent(new Event('resize')) })

    expect(room()).toBe('140')
  })

  it('stops listening once the overlay is gone', () => {
    setRect('page', { top: 52 })
    setRect('composer', { top: 314, bottom: 441, left: 300, right: 1068, width: 768, height: 127 })
    setRect('overlay', { bottom: 306 })
    const removeListener = vi.spyOn(window, 'removeEventListener')
    const view = render(<Page><Overlay /></Page>)

    view.unmount()

    expect(removeListener).toHaveBeenCalledWith('resize', expect.any(Function))
    expect(observers.size).toBe(0)
    expect(intersections.every((entry) => entry.disconnected)).toBe(true)
  })
})
