import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Both host sides (main-process pickerArmed, renderer pickerActive) treat picker-exited as
// "revoke this pick's grant" and drop any selection after it. This runs the real injected script to lock
// the cross-process contract: confirm sends only selection, and only cancel sends picker-exited.
type PostedMessage = {
  v: number
  type: string
  generation?: number
  payload?: {
    element?: { tag?: string }
    change?: Record<string, unknown>
    delivery?: 'send' | 'queue'
    draftItemId?: string
    selectionNumber?: number
    screenshot?: { captureId?: number }
  }
}

const posted: PostedMessage[] = []

type AgentWindow = typeof window & {
  __DESKTOP_PREVIEW_POST__?: (raw: string) => void
  __PREVIEW_BRIDGE__?: { handleHostRaw: (raw: string) => void }
}

const agentWindow = window as AgentWindow

function sendFromHost(message: string | Record<string, unknown>): void {
  const payload = typeof message === 'string' ? { type: message } : message
  agentWindow.__PREVIEW_BRIDGE__!.handleHostRaw(JSON.stringify({ v: 1, ...payload }))
}

function bubbleButton(action: 'confirm' | 'queue' | 'cancel'): HTMLButtonElement {
  for (const host of document.documentElement.querySelectorAll('div')) {
    const button = host.shadowRoot?.querySelector<HTMLButtonElement>(`[data-action="${action}"]`)
    if (button) return button
  }
  throw new Error(`edit bubble button not found: ${action}`)
}

function pick(el: Element): void {
  el.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }))
  el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
}

const types = () => posted.map((m) => m.type)

function showZoomControls() {
  sendFromHost({ type: 'browser-controls', zoomFactor: 1, appZoom: 1,
    copy: { zoom: 'Zoom', zoomOut: 'Out', zoomIn: 'In', zoomReset: 'Reset' },
    colors: { background: 'white', foreground: 'black', muted: 'gray', border: 'gray', hover: 'white', focus: 'blue', shadow: 'none' },
  })
  return document.querySelector<HTMLElement>('[data-workspace-browser-zoom]')!
}

function confirmSelection() {
  sendFromHost('enter-picker')
  pick(document.getElementById('t')!)
  bubbleButton('confirm').click()
  return posted.filter(message => message.type === 'selection').at(-1)?.payload?.screenshot?.captureId
}

function finishNativeCapture(captureId?: number) {
  ;(window as unknown as { __PREVIEW_AGENT_CLEAR_SELECTION_OVERLAY__: (id?: number) => void }).__PREVIEW_AGENT_CLEAR_SELECTION_OVERLAY__(captureId)
}

afterEach(() => { vi.useRealTimers() })

beforeAll(async () => {
  // The IIFE runs on import, so the post hook must be installed first (static imports are hoisted, hence a dynamic import)
  agentWindow.__DESKTOP_PREVIEW_POST__ = (raw: string) => { posted.push(JSON.parse(raw) as PostedMessage) }
  await import('./index')
})

beforeEach(() => {
  document.body.innerHTML = '<h1 id="t" style="color:rgb(0,0,0)">Old</h1>'
  for (const host of [...document.documentElement.querySelectorAll('div')]) {
    if (host.shadowRoot || host.dataset.previewSelectionAnnotationRoot) host.remove()
  }
  sendFromHost('exit-picker')   // reset any picker state left by the previous case
  sendFromHost('clear-selection-draft')
  posted.length = 0
})

describe('preview agent picker flow', () => {
  it.each(['picker', 'bubble'])('keeps zoom hidden when an old capture finishes during a newer %s', mode => {
    const chrome = showZoomControls()
    const oldCapture = confirmSelection()
    sendFromHost('enter-picker')
    if (mode === 'bubble') pick(document.getElementById('t')!)
    finishNativeCapture(oldCapture)
    expect(chrome.style.visibility).toBe('hidden')
    if (mode === 'bubble') expect(bubbleButton('confirm').isConnected).toBe(true)
  })

  it('holds the native capture until the page has painted without the bubble', async () => {
    const frames: FrameRequestCallback[] = []
    const raf = vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => frames.push(callback))
    try {
      const captureId = confirmSelection()
      // By the time the host captures, the bubble is gone and the annotation is up…
      expect(document.querySelector('[data-preview-selection-annotation]')).not.toBeNull()
      expect(() => bubbleButton('confirm')).toThrow()

      // …but the frame showing that only exists after the page paints again.
      const hide = (window as unknown as { __PREVIEW_AGENT_SET_CHROME_HIDDEN__: (hidden: boolean) => Promise<void> | undefined })
        .__PREVIEW_AGENT_SET_CHROME_HIDDEN__
      let painted = false
      const ready = hide(true)!.then(() => { painted = true })
      await Promise.resolve()
      expect(painted).toBe(false)
      frames.shift()!(0)
      frames.shift()!(16)
      await ready
      expect(painted).toBe(true)
      expect(hide(false)).toBeUndefined()
      finishNativeCapture(captureId)
    } finally {
      raf.mockRestore()
    }
  })

  it('does not let an older capture remove the newest annotation overlay', () => {
    const chrome = showZoomControls()
    const oldCapture = confirmSelection()
    const newCapture = confirmSelection()
    const newOverlay = document.querySelector('[data-preview-selection-annotation="true"]')!
    finishNativeCapture(oldCapture)
    expect(newOverlay.isConnected).toBe(true)
    expect(chrome.style.visibility).toBe('hidden')
    finishNativeCapture(newCapture)
    expect(newOverlay.isConnected).toBe(false)
    expect(chrome.style.visibility).toBe('visible')
  })

  it('ignores a timed-out capture cleanup after another annotation has started', () => {
    vi.useFakeTimers()
    const chrome = showZoomControls()
    const oldCapture = confirmSelection()
    vi.advanceTimersByTime(5000)
    const newCapture = confirmSelection()
    const newOverlay = document.querySelector('[data-preview-selection-annotation="true"]')!
    finishNativeCapture(oldCapture)
    expect(newOverlay.isConnected).toBe(true)
    expect(chrome.style.visibility).toBe('hidden')
    finishNativeCapture(newCapture)
    expect(newOverlay.isConnected).toBe(false)
  })

  it('ignores out-of-order completion of a capture that already lost its overlay', () => {
    showZoomControls()
    const first = confirmSelection()
    const second = confirmSelection()
    finishNativeCapture(second)
    const third = confirmSelection()
    const thirdOverlay = document.querySelector('[data-preview-selection-annotation="true"]')!
    finishNativeCapture(first)
    expect(thirdOverlay.isConnected).toBe(true)
    finishNativeCapture(third)
    expect(thirdOverlay.isConnected).toBe(false)
  })
  it('keeps native zoom chrome out of picking and sends zoom over the page bridge', () => {
    sendFromHost({ type: 'browser-controls', zoomFactor: 1, appZoom: 1,
      copy: { zoom: 'Zoom', zoomOut: 'Out', zoomIn: 'In', zoomReset: 'Reset' },
      colors: { background: 'white', foreground: 'black', muted: 'gray', border: 'gray', hover: 'white', focus: 'blue', shadow: 'none' },
    })
    const host = document.querySelector<HTMLElement>('[data-workspace-browser-zoom]')!
    host.shadowRoot!.querySelector<HTMLButtonElement>('[data-action="out"]')!.click()
    expect(posted.at(-1)).toMatchObject({ type: 'browser-zoom', action: 'out' })
    sendFromHost('enter-picker')
    expect(host.style.visibility).toBe('hidden')
    pick(host)
    expect(document.querySelector('[data-preview-selection-annotation-root]')).toBeNull()
    pick(document.getElementById('t')!)
    bubbleButton('confirm').click()
    expect(posted.find(message => message.type === 'selection')?.payload?.element?.tag).toBe('h1')
    expect(host.style.visibility).toBe('hidden')
    ;(window as unknown as { __PREVIEW_AGENT_CLEAR_SELECTION_OVERLAY__: () => void }).__PREVIEW_AGENT_CLEAR_SELECTION_OVERLAY__()
    expect(host.style.visibility).toBe('visible')
  })
  it('confirm sends selection without a prior picker-exited (or the host would drop it)', () => {
    sendFromHost('enter-picker')
    pick(document.getElementById('t')!)

    bubbleButton('confirm').click()

    expect(types()).toContain('selection')
    const beforeSelection = types().slice(0, types().indexOf('selection'))
    expect(beforeSelection).not.toContain('picker-exited')
  })

  it('confirm sends the selection together with the edits', () => {
    sendFromHost('enter-picker')
    pick(document.getElementById('t')!)

    const text = bubbleButton('confirm').getRootNode() as ShadowRoot
    const textInput = text.querySelector<HTMLInputElement>('[data-field="text"]')!
    textInput.value = 'New'
    textInput.dispatchEvent(new Event('input'))
    bubbleButton('confirm').click()

    const selection = posted.find((m) => m.type === 'selection')!
    expect(selection.payload?.element?.tag).toBe('h1')
    expect(selection.payload?.change).toMatchObject({ text: { from: 'Old', to: 'New' } })
  })

  it('cancel sends picker-exited to revoke the host grant and no selection', () => {
    sendFromHost('enter-picker')
    pick(document.getElementById('t')!)

    bubbleButton('cancel').click()

    expect(types()).toContain('picker-exited')
    expect(types()).not.toContain('selection')
  })

  it('stops the picker after confirm so the page cannot send a second selection', () => {
    sendFromHost('enter-picker')
    pick(document.getElementById('t')!)
    bubbleButton('confirm').click()
    posted.length = 0

    pick(document.getElementById('t')!)

    expect(types()).not.toContain('selection')
  })

  it('batch adds carry stable numbers and can undo the live page preview by itemId', () => {
    sendFromHost({ type: 'enter-picker', mode: 'batch', label: 3 })
    const target = document.getElementById('t')!
    pick(target)
    const root = bubbleButton('queue').getRootNode() as ShadowRoot
    const textInput = root.querySelector<HTMLInputElement>('[data-field="text"]')!
    textInput.value = 'Queued'
    textInput.dispatchEvent(new Event('input'))
    bubbleButton('queue').click()

    const selection = posted.find((message) => message.type === 'selection')!
    expect(selection.payload).toMatchObject({
      delivery: 'queue',
      selectionNumber: 3,
      change: { text: { from: 'Old', to: 'Queued' } },
    })
    expect(types()).not.toContain('picker-exited')
    expect(target.textContent).toBe('Queued')

    sendFromHost({ type: 'undo-selection', itemId: selection.payload!.draftItemId! })
    expect(target.textContent).toBe('Old')
  })
})


describe('persistent annotation mode', () => {
  it('keeps zoom chrome suppressed while a persistent capture waits for the host to continue', () => {
    const chrome = showZoomControls()
    sendFromHost({ type: 'enter-picker', persistent: true })
    pick(document.getElementById('t')!)
    bubbleButton('confirm').click()
    const captureId = posted.find(message => message.type === 'selection')?.payload?.screenshot?.captureId
    finishNativeCapture(captureId)
    expect(chrome.style.visibility).toBe('hidden')
    sendFromHost('exit-picker')
    expect(chrome.style.visibility).toBe('visible')
  })

  it('temporarily browses with Space and resumes picking on release', () => {
    sendFromHost({ type: 'enter-picker', persistent: true })
    document.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', code: 'Space', bubbles: true }))
    pick(document.getElementById('t')!)
    expect(() => bubbleButton('confirm')).toThrow()
    document.dispatchEvent(new KeyboardEvent('keyup', { key: ' ', code: 'Space', bubbles: true }))
    pick(document.getElementById('t')!)
    expect(bubbleButton('confirm').isConnected).toBe(true)
  })

  it('cancels the current edit while retaining the annotation mode, then Escape exits it', () => {
    sendFromHost({ type: 'enter-picker', persistent: true })
    pick(document.getElementById('t')!)
    bubbleButton('cancel').click()
    expect(types()).not.toContain('picker-exited')
    pick(document.getElementById('t')!)
    expect(bubbleButton('confirm').isConnected).toBe(true)
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(types()).toContain('picker-exited')
    expect(() => bubbleButton('confirm')).toThrow()
    pick(document.getElementById('t')!)
    expect(() => bubbleButton('confirm')).toThrow()
  })

  it('does not capture Space while typing a comment and still obeys explicit single-shot commands', () => {
    sendFromHost({ type: 'enter-picker', persistent: true })
    pick(document.getElementById('t')!)
    const root = bubbleButton('confirm').getRootNode() as ShadowRoot
    const textarea = root.querySelector('textarea')!
    expect(textarea.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', code: 'Space', bubbles: true, composed: true, cancelable: true }))).toBe(true)
    sendFromHost('enter-picker')
    pick(document.getElementById('t')!)
    bubbleButton('confirm').click()
    pick(document.getElementById('t')!)
    expect(() => bubbleButton('confirm')).toThrow()
  })
})


describe('picker command ownership', () => {
  it('ignores a delayed old exit command after a newer picker has entered', () => {
    sendFromHost({ type: 'enter-picker', persistent: true, generation: 10 })
    sendFromHost({ type: 'enter-picker', persistent: true, generation: 12 })
    sendFromHost({ type: 'exit-picker', generation: 11 })
    pick(document.getElementById('t')!)
    expect(bubbleButton('confirm').isConnected).toBe(true)
    bubbleButton('confirm').click()
    expect(posted.find(message => message.type === 'selection')?.generation).toBe(12)
  })

  it('echoes the current exit identity and does not resume Space after navigation exits the mode', () => {
    sendFromHost({ type: 'enter-picker', persistent: true, generation: 20 })
    document.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', code: 'Space', bubbles: true }))
    sendFromHost({ type: 'exit-picker', generation: 21 })
    document.dispatchEvent(new KeyboardEvent('keyup', { key: ' ', code: 'Space', bubbles: true }))
    pick(document.getElementById('t')!)
    expect(() => bubbleButton('confirm')).toThrow()
    expect(posted.find(message => message.type === 'picker-exited')?.generation).toBe(21)
  })
})
