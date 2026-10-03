import { vi } from 'vitest'
import { setWorkspaceBrowserGuestLayer } from '../lib/workspace/browserGuests'

/**
 * The real workspace browser page registry and layer, with only Electron's part
 * simulated: every `<webview>` the registry inserts becomes a guest with an id
 * that reports ready, and the page placeholder gets a size (jsdom lays nothing
 * out, and a page is only drawn over a placeholder that has one).
 *
 * Call in `beforeEach`; call the returned function in `afterEach`.
 */
export function installFakeBrowserGuests(): () => void {
  const layer = document.createElement('div')
  layer.dataset.testid = 'fake-browser-guest-layer'
  document.body.appendChild(layer)
  setWorkspaceBrowserGuestLayer(layer)
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        const webview = node instanceof HTMLElement ? node.querySelector('webview') : null
        if (!webview) continue
        const id = nextGuestId++
        Object.assign(webview, { getWebContentsId: () => id })
        webview.dispatchEvent(new Event('dom-ready'))
      }
    }
  })
  observer.observe(layer, { childList: true })
  const original = HTMLElement.prototype.getBoundingClientRect
  const measure = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (this.dataset.testid !== 'workspace-browser-placeholder') return original.call(this)
    const box = { left: 0, top: 52, width: 800, height: 600 }
    return { ...box, x: box.left, y: box.top, right: box.left + box.width, bottom: box.top + box.height, toJSON: () => box } as DOMRect
  })
  return () => {
    observer.disconnect()
    measure.mockRestore()
    setWorkspaceBrowserGuestLayer(null)
    layer.remove()
  }
}

let nextGuestId = 1

/** Whether the page's `<webview>` is drawn over its placeholder right now. */
export function isBrowserPageShown(browserTabId: string): boolean {
  const slot = document.querySelector<HTMLElement>(`[data-workspace-browser-slot="${browserTabId}"]`)
  return slot?.dataset.shown === 'true'
}
