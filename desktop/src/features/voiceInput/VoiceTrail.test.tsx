import { act, cleanup, render } from '@testing-library/react'
import '@testing-library/jest-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { VoiceTrail } from './VoiceTrail'

const WIDTH = 300
const HEIGHT = 32
const DOT = 2.5

type Mark = { x: number; height: number; alpha: number; color: string }

type FakeContext = {
  setTransform: ReturnType<typeof vi.fn>
  clearRect: ReturnType<typeof vi.fn>
  beginPath: ReturnType<typeof vi.fn>
  roundRect?: ReturnType<typeof vi.fn>
  fill: ReturnType<typeof vi.fn>
  fillRect: ReturnType<typeof vi.fn>
  globalAlpha: number
  fillStyle: string
}

let context: FakeContext
let marks: Mark[]
let frames: Map<number, FrameRequestCallback>
let nextFrameId: number
let clock: number
let disconnect: ReturnType<typeof vi.fn>
let reducedMotion: boolean
let hidden: boolean

function makeContext(): FakeContext {
  const record = (x: number, _y: number, width: number, height: number) => {
    marks.push({ x: x + width / 2, height, alpha: ctx.globalAlpha, color: ctx.fillStyle })
  }
  const ctx: FakeContext = {
    setTransform: vi.fn(),
    clearRect: vi.fn(() => { marks = [] }),
    beginPath: vi.fn(),
    roundRect: vi.fn(record),
    fill: vi.fn(),
    fillRect: vi.fn(record),
    globalAlpha: 1,
    fillStyle: '',
  }
  return ctx
}

/** Runs queued frames for `ms` of animation time, one frame every 16 ms. */
function play(ms: number) {
  const end = clock + ms
  while (clock < end) {
    clock += 16
    const batch = [...frames.values()]
    frames.clear()
    act(() => { for (const callback of batch) callback(clock) })
  }
}

const bars = () => marks.filter((mark) => mark.height > DOT)
const newest = () => marks.reduce((right, mark) => (mark.x > right.x ? mark : right))

beforeEach(() => {
  marks = []
  context = makeContext()
  frames = new Map()
  nextFrameId = 1
  clock = 1_000
  disconnect = vi.fn()
  reducedMotion = false
  hidden = false

  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => context as never)
  Object.defineProperty(HTMLCanvasElement.prototype, 'clientWidth', { configurable: true, get: () => WIDTH })
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    const id = nextFrameId++
    frames.set(id, callback)
    return id
  })
  vi.stubGlobal('cancelAnimationFrame', vi.fn((id: number) => { frames.delete(id) }))
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    unobserve() {}
    disconnect = disconnect
  })
  vi.stubGlobal('matchMedia', (query: string) => ({
    get matches() { return query.includes('prefers-reduced-motion') && reducedMotion },
  }))
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden })
  vi.stubGlobal('devicePixelRatio', 2)
})

afterEach(() => {
  cleanup()
  Reflect.deleteProperty(HTMLCanvasElement.prototype, 'clientWidth')
  Reflect.deleteProperty(document, 'hidden')
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('VoiceTrail', () => {
  it('marks the canvas decorative and sizes it at the device pixel ratio', () => {
    const { container } = render(<VoiceTrail getLevel={() => 0} frozen={false} height={HEIGHT} />)
    const canvas = container.querySelector('canvas')!

    expect(canvas).toHaveAttribute('aria-hidden', 'true')
    expect(canvas.style.height).toBe(`${HEIGHT}px`)
    expect(canvas.width).toBe(WIDTH * 2)
    expect(canvas.height).toBe(HEIGHT * 2)
    expect(context.setTransform).toHaveBeenLastCalledWith(2, 0, 0, 2, 0, 0)
  })

  it('fills the strip with faint dots before anything has been heard', () => {
    render(<VoiceTrail getLevel={() => 0} frozen={false} height={HEIGHT} />)

    expect(marks.length).toBeGreaterThan(50)
    expect(bars()).toEqual([])
    // Only the newest slot has been listened to; the rest is not recorded yet.
    const unrecorded = marks.filter((mark) => mark !== newest())
    expect(Math.max(...unrecorded.map((mark) => mark.alpha))).toBeLessThanOrEqual(0.26)
  })

  it('turns speech into bars at the newest end, and keeps quiet as dots', () => {
    let level = 0.8
    render(<VoiceTrail getLevel={() => level} frozen={false} height={HEIGHT} />)
    play(300)

    expect(bars().length).toBeGreaterThanOrEqual(3)
    expect(newest().height).toBeGreaterThan(20)
    expect(Math.max(...marks.map((mark) => mark.height))).toBeLessThanOrEqual(HEIGHT)

    level = 0
    play(600)
    // The pause shows up as dots at the right end; the speech moved left.
    expect(newest().height).toBe(DOT)
    expect(bars().length).toBeGreaterThanOrEqual(3)
  })

  it('scrolls older marks to the left and fades them', () => {
    let level = 0.8
    render(<VoiceTrail getLevel={() => level} frozen={false} height={HEIGHT} />)
    play(150)
    level = 0
    // Long enough for the level to fall back and its last window to close.
    play(500)
    const before = bars()
    const rightmost = Math.max(...before.map((mark) => mark.x))
    const brightest = Math.max(...before.map((mark) => mark.alpha))

    play(1_500)
    const after = bars()
    expect(after.length).toBe(before.length)
    // 1.5 s at one mark per 75 ms is 20 marks of 5 px.
    expect(rightmost - Math.max(...after.map((mark) => mark.x))).toBeCloseTo(100, 0)
    expect(Math.max(...after.map((mark) => mark.alpha))).toBeLessThan(brightest)
  })

  it('stops listening when frozen, but keeps the trace where it was', () => {
    const getLevel = vi.fn(() => 0.8)
    const { rerender } = render(<VoiceTrail getLevel={getLevel} frozen={false} height={HEIGHT} />)
    play(300)
    const recorded = bars().map((mark) => mark.x)

    rerender(<VoiceTrail getLevel={getLevel} frozen height={HEIGHT} />)
    getLevel.mockClear()
    play(500)

    expect(getLevel).not.toHaveBeenCalled()
    expect(bars().map((mark) => mark.x)).toEqual(recorded)
  })

  it('sweeps a highlight across the frozen trace', () => {
    const { rerender } = render(<VoiceTrail getLevel={() => 0.8} frozen={false} height={HEIGHT} />)
    play(1_000)
    rerender(<VoiceTrail getLevel={() => 0.8} frozen height={HEIGHT} />)

    const alphaOverTime = new Set<number>()
    for (let step = 0; step < 10; step += 1) {
      play(100)
      alphaOverTime.add(Number(newest().alpha.toFixed(3)))
    }
    expect(alphaOverTime.size).toBeGreaterThan(3)
  })

  it('paints a frozen trace once and schedules nothing under reduced motion', () => {
    reducedMotion = true
    const { rerender } = render(<VoiceTrail getLevel={() => 0.8} frozen={false} height={HEIGHT} />)
    play(300)
    expect(frames.size).toBe(1)

    rerender(<VoiceTrail getLevel={() => 0.8} frozen height={HEIGHT} />)

    expect(frames.size).toBe(0)
    expect(bars().length).toBeGreaterThanOrEqual(3)
  })

  it('draws square marks where roundRect is missing (Safari before 16)', () => {
    delete context.roundRect
    render(<VoiceTrail getLevel={() => 0.8} frozen={false} height={HEIGHT} />)
    play(200)

    expect(context.fillRect).toHaveBeenCalled()
    expect(bars().length).toBeGreaterThan(0)
  })

  it('cancels the frame and disconnects the observer on unmount', () => {
    const getLevel = vi.fn(() => 0.5)
    const { unmount } = render(<VoiceTrail getLevel={getLevel} frozen={false} height={HEIGHT} />)
    unmount()
    getLevel.mockClear()
    play(100)

    expect(frames.size).toBe(0)
    expect(disconnect).toHaveBeenCalled()
    expect(getLevel).not.toHaveBeenCalled()
  })

  it('does not spin while the window is hidden, and resumes when it returns', () => {
    render(<VoiceTrail getLevel={() => 0.5} frozen={false} height={HEIGHT} />)
    hidden = true
    act(() => { document.dispatchEvent(new Event('visibilitychange')) })
    expect(frames.size).toBe(0)

    hidden = false
    act(() => { document.dispatchEvent(new Event('visibilitychange')) })
    expect(frames.size).toBe(1)
  })

  it('does not throw or animate when the canvas has no 2D context', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
    render(<VoiceTrail getLevel={() => 0.5} frozen={false} height={HEIGHT} />)

    expect(frames.size).toBe(0)
  })
})
