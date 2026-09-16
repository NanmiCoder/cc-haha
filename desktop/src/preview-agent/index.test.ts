import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// 宿主两侧（主进程 pickerArmed、渲染进程 pickerActive）都把 picker-exited 当作
// 「解除本次拾取授权」，并在其后丢弃 selection。这里跑的是真实注入脚本，用来锁住
// 「确认时只发 selection、取消时才发 picker-exited」这条跨进程契约。
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
  // IIFE 在 import 时立即执行，post 钩子必须先于它挂上（静态 import 会被提升，故用动态 import）
  agentWindow.__DESKTOP_PREVIEW_POST__ = (raw: string) => { posted.push(JSON.parse(raw) as PostedMessage) }
  await import('./index')
})

beforeEach(() => {
  document.body.innerHTML = '<h1 id="t" style="color:rgb(0,0,0)">Old</h1>'
  for (const host of [...document.documentElement.querySelectorAll('div')]) {
    if (host.shadowRoot || host.dataset.previewSelectionAnnotationRoot) host.remove()
  }
  sendFromHost('exit-picker')   // 复位上一个用例可能残留的 picker 态
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
  it('confirm 发出 selection，且此前不发 picker-exited（否则宿主会丢弃选区）', () => {
    sendFromHost('enter-picker')
    pick(document.getElementById('t')!)

    bubbleButton('confirm').click()

    expect(types()).toContain('selection')
    const beforeSelection = types().slice(0, types().indexOf('selection'))
    expect(beforeSelection).not.toContain('picker-exited')
  })

  it('confirm 带上编辑内容一起送出选区', () => {
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

  it('cancel 发 picker-exited 解除宿主授权，且不发 selection', () => {
    sendFromHost('enter-picker')
    pick(document.getElementById('t')!)

    bubbleButton('cancel').click()

    expect(types()).toContain('picker-exited')
    expect(types()).not.toContain('selection')
  })

  it('确认后 picker 停止工作，页面无法再自行送出第二个选区', () => {
    sendFromHost('enter-picker')
    pick(document.getElementById('t')!)
    bubbleButton('confirm').click()
    posted.length = 0

    pick(document.getElementById('t')!)

    expect(types()).not.toContain('selection')
  })

  it('批量添加携带稳定编号，并能按 itemId 撤销页面上的实时预览', () => {
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
