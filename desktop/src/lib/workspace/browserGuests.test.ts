import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type Registry = typeof import('./browserGuests')

// The registry is module state on purpose (pages outlive every component), so
// each test gets a fresh copy.
let registry: Registry
let layer: HTMLDivElement
let nextId = 40

beforeEach(async () => {
  vi.resetModules()
  registry = await import('./browserGuests')
  layer = document.createElement('div')
  document.body.appendChild(layer)
  rect(layer, { left: 100, top: 50, width: 1000, height: 800 })
})

afterEach(() => {
  registry.setWorkspaceBrowserGuestLayer(null)
  document.body.innerHTML = ''
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

function rect(element: HTMLElement, box: { left: number, top: number, width: number, height: number }) {
  element.getBoundingClientRect = () => ({
    ...box, x: box.left, y: box.top, right: box.left + box.width, bottom: box.top + box.height, toJSON: () => box,
  }) as DOMRect
}

function webviews(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('webview'))
}

/** What Electron does once a guest exists: it becomes addressable, then ready. */
function attach(webview: HTMLElement, id = nextId++): number {
  Object.assign(webview, { getWebContentsId: () => id })
  webview.dispatchEvent(new Event('dom-ready'))
  return id
}

async function settle() {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

describe('workspace browser guests', () => {
  it('creates one blank, partitioned webview per page and registers the guest it got', async () => {
    registry.setWorkspaceBrowserGuestLayer(layer)
    const register = vi.fn(async (_id: number) => {})
    const ready = registry.ensureWorkspaceBrowserGuest('tab-a', register)
    await settle()

    const [webview] = webviews()
    expect(webview).toBeDefined()
    // Exactly what the host's attach policy admits; anything else is denied.
    expect(webview!.getAttribute('partition')).toBe('persist:cc-haha-browser-app')
    expect(webview!.getAttribute('src')).toBe('about:blank')
    // Without it Chromium drops popups before the host can turn them into tabs.
    expect(webview!.hasAttribute('allowpopups')).toBe(true)
    expect(register).not.toHaveBeenCalled()

    const id = attach(webview!)
    await ready
    expect(register).toHaveBeenCalledWith(id)
    expect(registry.isWorkspaceBrowserGuestRegistered('tab-a')).toBe(true)

    // A remounted tab asks again: same page, no second element, no second registration.
    await registry.ensureWorkspaceBrowserGuest('tab-a', register)
    expect(webviews()).toEqual([webview])
    expect(register).toHaveBeenCalledTimes(1)
  })

  it('reads the guest id only once the page is ready, and only the first time', async () => {
    registry.setWorkspaceBrowserGuestLayer(layer)
    const register = vi.fn(async (_id: number) => {})
    const ready = registry.ensureWorkspaceBrowserGuest('tab-a', register)
    await settle()
    const [webview] = webviews()
    attach(webview!, 7)
    await ready
    // `dom-ready` repeats on every navigation of the page.
    attach(webview!, 8)
    await settle()
    expect(register.mock.calls).toEqual([[7]])
  })

  it('creates nothing until the layer exists', async () => {
    const ready = registry.ensureWorkspaceBrowserGuest('tab-a', async () => {})
    await settle()
    expect(webviews()).toHaveLength(0)
    registry.setWorkspaceBrowserGuestLayer(layer)
    await settle()
    expect(webviews()).toHaveLength(1)
    expect(layer.contains(webviews()[0]!)).toBe(true)
    attach(webviews()[0]!)
    await ready
  })

  it('drops a page the host refused, so a retry starts from a fresh element', async () => {
    registry.setWorkspaceBrowserGuestLayer(layer)
    const first = registry.ensureWorkspaceBrowserGuest('tab-a', async () => { throw new Error('not adopted') })
    await settle()
    const refused = webviews()[0]!
    attach(refused)
    await expect(first).rejects.toThrow('not adopted')
    expect(refused.isConnected).toBe(false)
    expect(registry.isWorkspaceBrowserGuestRegistered('tab-a')).toBe(false)

    const register = vi.fn(async (_id: number) => {})
    const retry = registry.ensureWorkspaceBrowserGuest('tab-a', register)
    await settle()
    const fresh = webviews()[0]!
    expect(fresh).not.toBe(refused)
    attach(fresh)
    await retry
    expect(registry.isWorkspaceBrowserGuestRegistered('tab-a')).toBe(true)
  })

  it('gives up on a guest that never attaches', async () => {
    vi.useFakeTimers()
    registry.setWorkspaceBrowserGuestLayer(layer)
    const ready = registry.ensureWorkspaceBrowserGuest('tab-a', async () => {})
    const outcome = expect(ready).rejects.toThrow('failed to attach')
    await vi.advanceTimersByTimeAsync(10_000)
    await outcome
    expect(webviews()).toHaveLength(0)
  })

  it('draws the page over its placeholder on whole device pixels, and parks it at the same size', async () => {
    vi.stubGlobal('devicePixelRatio', 2)
    registry.setWorkspaceBrowserGuestLayer(layer)
    const stage = document.createElement('div')
    document.body.appendChild(stage)
    rect(stage, { left: 600.3, top: 152.2, width: 480.26, height: 640.74 })
    const ready = registry.ensureWorkspaceBrowserGuest('tab-a', async () => {})
    await settle()
    attach(webviews()[0]!)
    await ready

    const release = registry.placeWorkspaceBrowserGuest('tab-a', stage, true)
    const slot = webviews()[0]!.parentElement!
    expect(slot.style).toMatchObject({ left: '500.5px', top: '102px', width: '480.5px', height: '640.5px' })
    expect(slot.style.visibility).toBe('visible')
    expect(slot.style.pointerEvents).toBe('auto')

    release()
    expect(slot.style.visibility).toBe('hidden')
    expect(slot.style.pointerEvents).toBe('none')
    // Parking never resizes the page, so hiding it does not reflow it.
    expect(slot.style.width).toBe('480.5px')
    expect(webviews()[0]!.isConnected).toBe(true)
  })

  it('applies a placement made before the page existed, and never moves the element', async () => {
    registry.setWorkspaceBrowserGuestLayer(layer)
    const first = document.createElement('div')
    const second = document.createElement('div')
    document.body.append(first, second)
    rect(first, { left: 100, top: 50, width: 300, height: 200 })
    rect(second, { left: 400, top: 60, width: 500, height: 400 })
    registry.placeWorkspaceBrowserGuest('tab-a', first, true)
    const ready = registry.ensureWorkspaceBrowserGuest('tab-a', async () => {})
    await settle()
    const webview = webviews()[0]!
    const slot = webview.parentElement!
    expect(slot.style).toMatchObject({ left: '0px', top: '0px', width: '300px', height: '200px', visibility: 'visible' })
    attach(webview)
    await ready

    // A webview that changes parents reloads its page; only the slot moves.
    registry.placeWorkspaceBrowserGuest('tab-a', second, true)
    expect(webview.parentElement).toBe(slot)
    expect(slot.parentElement).toBe(layer)
    expect(slot.style).toMatchObject({ left: '300px', top: '10px', width: '500px', height: '400px' })
  })

  it('lets a stale release leave a newer placement alone', async () => {
    registry.setWorkspaceBrowserGuestLayer(layer)
    const stage = document.createElement('div')
    document.body.appendChild(stage)
    rect(stage, { left: 100, top: 50, width: 300, height: 200 })
    const ready = registry.ensureWorkspaceBrowserGuest('tab-a', async () => {})
    await settle()
    attach(webviews()[0]!)
    await ready
    const releaseOld = registry.placeWorkspaceBrowserGuest('tab-a', stage, true)
    registry.placeWorkspaceBrowserGuest('tab-a', stage, true)
    releaseOld()
    expect(webviews()[0]!.parentElement!.style.visibility).toBe('visible')
  })

  it('follows its placeholder when the placeholder resizes', async () => {
    const observers: Array<{ callback: () => void, targets: Element[] }> = []
    vi.stubGlobal('ResizeObserver', class {
      targets: Element[] = []
      constructor(public callback: () => void) { observers.push(this) }
      observe(target: Element) { this.targets.push(target) }
      disconnect() {}
      unobserve() {}
    })
    registry.setWorkspaceBrowserGuestLayer(layer)
    const stage = document.createElement('div')
    document.body.appendChild(stage)
    rect(stage, { left: 100, top: 50, width: 300, height: 200 })
    const ready = registry.ensureWorkspaceBrowserGuest('tab-a', async () => {})
    await settle()
    attach(webviews()[0]!)
    await ready
    registry.placeWorkspaceBrowserGuest('tab-a', stage, true)
    rect(stage, { left: 100, top: 86, width: 300, height: 164 })
    observers.find(observer => observer.targets.includes(stage))!.callback()
    expect(webviews()[0]!.parentElement!.style).toMatchObject({ top: '36px', height: '164px' })
  })

  it('ends a page by removing its element, and forgets a page the host lost', async () => {
    registry.setWorkspaceBrowserGuestLayer(layer)
    for (const tabId of ['closed', 'lost']) {
      const ready = registry.ensureWorkspaceBrowserGuest(tabId, async () => {})
      await settle()
      attach(webviews().at(-1)!)
      await ready
    }
    const [closed, lost] = webviews()
    registry.disposeWorkspaceBrowserGuest('closed')
    registry.forgetLostWorkspaceBrowserGuest('lost')
    expect(closed!.isConnected).toBe(false)
    expect(lost!.isConnected).toBe(false)
    expect(registry.isWorkspaceBrowserGuestRegistered('closed')).toBe(false)
    expect(registry.isWorkspaceBrowserGuestRegistered('lost')).toBe(false)
  })

  it('rebuilds a page whose element went away with an old layer instead of moving it', async () => {
    registry.setWorkspaceBrowserGuestLayer(layer)
    const ready = registry.ensureWorkspaceBrowserGuest('tab-a', async () => {})
    await settle()
    const old = webviews()[0]!
    attach(old)
    await ready
    layer.remove()
    const next = document.createElement('div')
    document.body.appendChild(next)
    registry.setWorkspaceBrowserGuestLayer(next)
    expect(registry.isWorkspaceBrowserGuestRegistered('tab-a')).toBe(false)
    const again = registry.ensureWorkspaceBrowserGuest('tab-a', async () => {})
    await settle()
    const rebuilt = Array.from(next.querySelectorAll('webview'))[0]!
    expect(rebuilt).not.toBe(old)
    attach(rebuilt as HTMLElement)
    await again
    expect(registry.isWorkspaceBrowserGuestRegistered('tab-a')).toBe(true)
  })

  it('keeps an app pointer gesture from being taken by a page it crosses', async () => {
    registry.setWorkspaceBrowserGuestLayer(layer)
    const stage = document.createElement('div')
    document.body.appendChild(stage)
    rect(stage, { left: 100, top: 50, width: 300, height: 200 })
    const ready = registry.ensureWorkspaceBrowserGuest('tab-a', async () => {})
    await settle()
    attach(webviews()[0]!)
    await ready
    registry.placeWorkspaceBrowserGuest('tab-a', stage, true)
    const slot = webviews()[0]!.parentElement!

    // A drag that starts in the app (e.g. the panel resize handle).
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    expect(slot.style.pointerEvents).toBe('none')
    expect(slot.style.visibility).toBe('visible')
    window.dispatchEvent(new Event('pointerup'))
    expect(slot.style.pointerEvents).toBe('auto')

    // A release outside the window never arrives; a plain move ends it.
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    const move = new Event('pointermove', { bubbles: true })
    Object.defineProperty(move, 'buttons', { value: 0 })
    document.body.dispatchEvent(move)
    expect(slot.style.pointerEvents).toBe('auto')
  })
})
