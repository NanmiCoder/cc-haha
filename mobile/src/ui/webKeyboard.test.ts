import { describe, expect, test } from 'bun:test'
import { isWebKeyboardOpen, VIEWPORT_HEIGHT_VAR, watchWebViewport, type ViewportWindow } from './webKeyboard'

class FakeViewport extends EventTarget {
  scale = 1
  constructor(public height: number) {
    super()
  }
}

/** The composer lives in the app's #root; a react-native-web Modal is mounted on body. */
const composer = { name: 'composer textarea' } as unknown as Element
const sheetInput = { name: 'rename sheet input' } as unknown as Element
const appRoot = { contains: (node: Element | null) => node === composer }

function page(height: number) {
  const viewport = new FakeViewport(height)
  const style = new Map<string, string>()
  const scrolls: [number, number][] = []
  const events = new EventTarget()
  const document = {
    documentElement: { clientHeight: height, style: { setProperty: (name: string, value: string) => style.set(name, value) } },
    activeElement: composer as Element | null,
    getElementById: (id: string) => (id === 'root' ? appRoot : null),
  }
  const win = {
    addEventListener: (type: 'scroll', listener: () => void) => events.addEventListener(type, listener),
    removeEventListener: (type: 'scroll', listener: () => void) => events.removeEventListener(type, listener),
    visualViewport: viewport,
    document,
    innerHeight: height,
    scrollX: 0,
    scrollY: 0,
    scrollTo(x: number, y: number) {
      scrolls.push([x, y])
      win.scrollX = x
      win.scrollY = y
    },
  }
  const fire = (type: 'resize' | 'scroll') => viewport.dispatchEvent(new Event(type))
  const fireWindowScroll = () => events.dispatchEvent(new Event('scroll'))
  return { win: win as ViewportWindow & typeof win, viewport, style, scrolls, fire, fireWindowScroll }
}

describe('web viewport', () => {
  test('follows the iOS 26 Safari keyboard even after it shrinks innerHeight and pushes the page up', () => {
    // Recorded in iOS 26.5 Safari: focusing the composer shrinks the visible
    // area to 376, then Safari scrolls the page up by 338 and reports
    // innerHeight as 376 too. The layout height stays 714.
    const { win, viewport, style, scrolls, fire } = page(714)
    const seen: boolean[] = []
    watchWebViewport(win).subscribe((open) => seen.push(open))

    viewport.height = 376
    fire('resize')
    expect(style.get(VIEWPORT_HEIGHT_VAR)).toBe('376px')
    win.innerHeight = 376
    win.scrollY = 338
    fire('scroll')

    expect(seen).toEqual([false, true])
    expect(scrolls).toEqual([[0, 0]])
    expect(win.scrollY).toBe(0)

    viewport.height = 714
    win.innerHeight = 714
    fire('resize')
    expect(seen).toEqual([false, true, false])
    expect(style.get(VIEWPORT_HEIGHT_VAR)).toBe('714px')
  })

  test('snaps back the pan iOS makes at the end of the keyboard animation, which only scrolls the window', () => {
    // Recorded in iOS 26.5 Safari with the keyboard rising under a focused
    // composer: after the first snap back Safari pans the page by 20 again and
    // fires only the window's scroll event.
    const { win, viewport, scrolls, fire, fireWindowScroll } = page(714)
    watchWebViewport(win)
    viewport.height = 376
    fire('resize')
    win.scrollY = 20
    fireWindowScroll()

    expect(scrolls).toEqual([[0, 0]])
    expect(win.scrollY).toBe(0)
  })

  test('leaves the pan alone for an input in a sheet mounted outside the app', () => {
    // Recorded in iOS 26.5 Safari: the rename sheet's input sits at 578 of a
    // 714 layout. Safari pans by 337 so it shows above a 377 tall keyboard
    // gap; pulling the page back hid the sheet behind the keyboard.
    const { win, viewport, style, scrolls, fire, fireWindowScroll } = page(714)
    const seen: boolean[] = []
    watchWebViewport(win).subscribe((open) => seen.push(open))
    win.document.activeElement = sheetInput

    viewport.height = 377
    win.scrollY = 337
    fire('resize')
    fireWindowScroll()

    expect(seen).toEqual([false, true])
    expect(style.get(VIEWPORT_HEIGHT_VAR)).toBe('377px')
    expect(scrolls).toEqual([])
    expect(win.scrollY).toBe(337)

    // Back in the composer, the app's own input is pulled back again.
    win.document.activeElement = composer
    fireWindowScroll()
    expect(scrolls).toEqual([[0, 0]])
  })

  test('pinch zoom is not a keyboard: the app keeps its height and the zoomed page is not pulled back', () => {
    // Measured in Chromium at 2x: the visual viewport is half as tall while
    // the screen shows the same area.
    const { win, viewport, style, scrolls, fire, fireWindowScroll } = page(844)
    const seen: boolean[] = []
    watchWebViewport(win).subscribe((open) => seen.push(open))

    viewport.scale = 2
    viewport.height = 422
    fire('resize')
    win.scrollX = 120
    win.scrollY = 200
    fireWindowScroll()

    expect(seen).toEqual([false])
    expect(style.get(VIEWPORT_HEIGHT_VAR)).toBe('844px')
    expect(scrolls).toEqual([])

    // The keyboard opening while zoomed in still counts: 500 of 844 shows.
    viewport.height = 250
    fire('resize')
    expect(seen).toEqual([false, true])
    expect(style.get(VIEWPORT_HEIGHT_VAR)).toBe('500px')
  })

  test('browser chrome resizing the visible area is not a keyboard and keeps the scroll position', () => {
    const { win, viewport, scrolls, fire } = page(714)
    const seen: boolean[] = []
    watchWebViewport(win).subscribe((open) => seen.push(open))

    viewport.height = 660
    win.scrollY = 10
    fire('resize')

    expect(seen).toEqual([false])
    expect(scrolls).toEqual([])
    expect(isWebKeyboardOpen(714, 634)).toBe(false)
    expect(isWebKeyboardOpen(714, 633)).toBe(true)
  })

  test('stops listening when disposed and tolerates browsers without visualViewport', () => {
    const { win, viewport, fire, fireWindowScroll } = page(714)
    const watcher = watchWebViewport(win)
    const seen: boolean[] = []
    const unsubscribe = watcher.subscribe((open) => seen.push(open))
    unsubscribe()
    viewport.height = 300
    fire('resize')
    watcher.dispose()
    viewport.height = 714
    fire('resize')
    expect(seen).toEqual([false])
    win.scrollY = 30
    fireWindowScroll()
    expect(win.scrollY).toBe(30)

    const bare = watchWebViewport({ ...win, visualViewport: null })
    const states: boolean[] = []
    bare.subscribe((open) => states.push(open))
    expect(states).toEqual([false])
  })
})
