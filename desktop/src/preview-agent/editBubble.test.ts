import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { snapshotEditableStyles, computeChange, createEditBubble, type EditableSnapshot } from './editBubble'

beforeEach(() => { document.body.innerHTML = `<h1 id="t" style="color:rgb(0,0,0)">Old</h1>` })
afterEach(() => { document.documentElement.querySelectorAll('div').forEach((d) => { if (d.shadowRoot) d.remove() }) })

const $ = (b: { host: HTMLElement }, sel: string) => b.host.shadowRoot!.querySelector(sel) as HTMLInputElement & HTMLButtonElement

describe('computeChange', () => {
  it('returns only changed fields with from/to', () => {
    const orig: EditableSnapshot = { text: 'A', color: 'c', background: 'b', opacity: '1', fontFamily: 'f' }
    const cur: EditableSnapshot = { ...orig, text: 'B' }
    expect(computeChange(orig, cur)).toEqual({ text: { from: 'A', to: 'B' } })
  })
})

describe('snapshotEditableStyles', () => {
  it('captures text + relevant computed styles', () => {
    const el = document.getElementById('t')!
    vi.spyOn(window, 'getComputedStyle').mockReturnValue({ color: 'rgb(0,0,0)', backgroundColor: 'rgba(0,0,0,0)', opacity: '1', fontFamily: 'serif' } as unknown as CSSStyleDeclaration)
    const s = snapshotEditableStyles(el)
    expect(s.text).toBe('Old')
    expect(s.color).toBe('rgb(0,0,0)')
    expect(s.fontFamily).toBe('serif')
  })
})

/** vitest uses desktop/ as root (see vitest.config.ts). */
const SOURCE_PATH = join(process.cwd(), 'src/preview-agent/editBubble.ts')

describe('injected style tokens are self-consistent', () => {
  // The bubble lives in a third-party page's Shadow DOM where globals.css cannot reach, so every var(--x)
  // must be defined by this stylesheet itself; a misspelled name fails silently (transparent background, currentColor border).
  it('defines every var(--token) in the same stylesheet', () => {
    const source = readFileSync(SOURCE_PATH, 'utf8')
    const defined = new Set([...source.matchAll(/^\s*(--[a-zA-Z0-9-]+)\s*:/gm)].map((m) => m[1]))
    const referenced = [...source.matchAll(/var\(\s*(--[a-zA-Z0-9-]+)/g)].map((m) => m[1]!)

    expect([...new Set(referenced)].filter((token) => !defined.has(token))).toEqual([])
    expect(referenced.length).toBeGreaterThan(0)
  })

  it('defines the same tokens for light and dark, so dark misses none', () => {
    const source = readFileSync(SOURCE_PATH, 'utf8')
    const darkBlock = /@media \(prefers-color-scheme: dark\) \{([\s\S]*?)\n\}/.exec(source)?.[1] ?? ''
    const darkTokens = new Set([...darkBlock.matchAll(/(--[a-zA-Z0-9-]+)\s*:/g)].map((m) => m[1]))

    // Dark only overrides tokens that depend on light/dark; structural tokens (such as --mono) must not appear in the dark block
    expect(darkTokens.has('--bg')).toBe(true)
    expect(darkTokens.has('--fg')).toBe(true)
    expect(darkTokens.has('--swatch-border')).toBe(true)
    expect(darkTokens.has('--mono')).toBe(false)
  })
})

describe('createEditBubble', () => {
  it('positions controls inside the viewport when selecting a low element', () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 })
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 720 })
    const el = document.getElementById('t')!
    vi.spyOn(el, 'getBoundingClientRect').mockReturnValue({
      x: 420,
      y: 650,
      top: 650,
      right: 500,
      bottom: 670,
      left: 420,
      width: 80,
      height: 20,
      toJSON: () => ({}),
    })

    const bubble = createEditBubble(el, { onConfirm: vi.fn(), onCancel: vi.fn() })

    expect(bubble.host.style.top).toBe('262px')
    bubble.destroy()
  })

  it('opens at full height beside the click when the picked element fills the view', () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 })
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 720 })
    const el = document.getElementById('t')!
    // A picked <body>: taller than the viewport, no room above or below.
    vi.spyOn(el, 'getBoundingClientRect').mockReturnValue({
      x: 0, y: 0, top: 0, right: 1024, bottom: 1400, left: 0, width: 1024, height: 1400, toJSON: () => ({}),
    })

    const atClick = createEditBubble(el, { onConfirm: vi.fn(), onCancel: vi.fn(), pointer: { x: 300, y: 200 } })
    expect(atClick.host.style.top).toBe('208px')
    expect(atClick.host.style.left).toBe('308px')
    // Full estimated height (380), not squeezed to the 160px minimum.
    expect((atClick.host.shadowRoot!.querySelector('.bubble') as HTMLElement).style.maxHeight).toBe('504px')
    atClick.destroy()

    // A click near the bottom right lifts and shifts it just enough to fit.
    const nearEdge = createEditBubble(el, { onConfirm: vi.fn(), onCancel: vi.fn(), pointer: { x: 1000, y: 700 } })
    expect(nearEdge.host.style.top).toBe('332px')
    expect(nearEdge.host.style.left).toBe('676px')
    nearEdge.destroy()
  })

  it('prefills the text field and live-applies edits to the element', () => {
    const el = document.getElementById('t')!
    const bubble = createEditBubble(el, { onConfirm: vi.fn(), onCancel: vi.fn() })
    const textInput = $(bubble, '[data-field="text"]')
    expect(textInput.value).toBe('Old')
    textInput.value = 'New'
    textInput.dispatchEvent(new Event('input'))
    expect(el.textContent).toBe('New')
    bubble.destroy()
  })

  it('confirm bundles the diff + description', () => {
    const el = document.getElementById('t')!
    const onConfirm = vi.fn()
    const bubble = createEditBubble(el, { onConfirm, onCancel: vi.fn() })
    const textInput = $(bubble, '[data-field="text"]'); textInput.value = 'New'; textInput.dispatchEvent(new Event('input'))
    const descInput = $(bubble, '[data-field="description"]'); descInput.value = 'Make it more upbeat'; descInput.dispatchEvent(new Event('input'))
    $(bubble, '[data-action="confirm"]').click()
    expect(onConfirm).toHaveBeenCalledWith(expect.objectContaining({ text: { from: 'Old', to: 'New' }, description: 'Make it more upbeat' }))
    bubble.destroy()
  })

  it('offers add-and-continue in single mode, then a single add action in batch mode', () => {
    const el = document.getElementById('t')!
    const onQueue = vi.fn()
    const single = createEditBubble(el, { onConfirm: vi.fn(), onQueue, onCancel: vi.fn() })
    expect($(single, '[data-action="queue"]').textContent).toBe('Add & continue')
    expect(single.host.shadowRoot!.querySelector('[data-action="confirm"]')).not.toBeNull()
    $(single, '[data-action="queue"]').click()
    expect(onQueue).toHaveBeenCalled()
    single.destroy()

    const batch = createEditBubble(el, { onConfirm: vi.fn(), onQueue, onCancel: vi.fn(), mode: 'batch' })
    expect($(batch, '[data-action="queue"]').textContent).toBe('Add')
    expect(batch.host.shadowRoot!.querySelector('[data-action="confirm"]')).toBeNull()
    batch.destroy()
  })

  it('exposes a revert handle for queued live edits', () => {
    const el = document.getElementById('t')!
    const bubble = createEditBubble(el, { onConfirm: vi.fn(), onCancel: vi.fn() })
    const textInput = $(bubble, '[data-field="text"]')
    textInput.value = 'Queued preview'
    textInput.dispatchEvent(new Event('input'))
    expect(el.textContent).toBe('Queued preview')
    bubble.revert()
    expect(el.textContent).toBe('Old')
    bubble.destroy()
  })

  it('color rows offer a picker swatch with the initial value shown as hex', () => {
    const el = document.getElementById('t')!
    vi.spyOn(window, 'getComputedStyle').mockReturnValue({ color: 'rgb(26, 29, 41)', backgroundColor: 'rgba(0, 0, 0, 0)', opacity: '1', fontFamily: 'Arial' } as unknown as CSSStyleDeclaration)
    const bubble = createEditBubble(el, { onConfirm: vi.fn(), onCancel: vi.fn() })

    expect($(bubble, '[data-field="color"]').value).toBe('#1a1d29')
    expect($(bubble, '[data-field="background"]').value).toBe('transparent')
    const swatches = bubble.host.shadowRoot!.querySelectorAll<HTMLInputElement>('input[type="color"]')
    expect(swatches).toHaveLength(2)
    expect(swatches[0]!.value).toBe('#1a1d29')
    // A transparent background shows a checkerboard rather than black
    expect(swatches[1]!.parentElement!.dataset.transparent).toBe('true')
    bubble.destroy()
  })

  it('writes a picked color back to the element and records it in the diff', () => {
    const el = document.getElementById('t')!
    const onConfirm = vi.fn()
    const bubble = createEditBubble(el, { onConfirm, onCancel: vi.fn() })

    const swatch = bubble.host.shadowRoot!.querySelector<HTMLInputElement>('input[type="color"]')!
    swatch.value = '#ff0000'
    swatch.dispatchEvent(new Event('input'))

    expect(el.style.color).toBe('rgb(255, 0, 0)')
    expect($(bubble, '[data-field="color"]').value).toBe('#ff0000')
    $(bubble, '[data-action="confirm"]').click()
    expect(onConfirm).toHaveBeenCalledWith(expect.objectContaining({ color: expect.objectContaining({ to: '#ff0000' }) }))
    bubble.destroy()
  })

  it('picking the same color as the original produces no fake diff', () => {
    const el = document.getElementById('t')!
    vi.spyOn(window, 'getComputedStyle').mockReturnValue({ color: 'rgb(26, 29, 41)', backgroundColor: 'rgba(0, 0, 0, 0)', opacity: '1', fontFamily: 'Arial' } as unknown as CSSStyleDeclaration)
    const onConfirm = vi.fn()
    const bubble = createEditBubble(el, { onConfirm, onCancel: vi.fn() })

    const swatch = bubble.host.shadowRoot!.querySelector<HTMLInputElement>('input[type="color"]')!
    swatch.value = '#1a1d29'                 // same color as rgb(26, 29, 41)
    swatch.dispatchEvent(new Event('input'))

    $(bubble, '[data-action="confirm"]').click()
    expect(onConfirm).toHaveBeenCalledWith({ description: undefined })
    bubble.destroy()
  })

  it('opacity uses a slider read and written as a percentage', () => {
    const el = document.getElementById('t')!
    vi.spyOn(window, 'getComputedStyle').mockReturnValue({ color: 'rgb(0,0,0)', backgroundColor: 'rgba(0,0,0,0)', opacity: '0.5', fontFamily: 'Arial' } as unknown as CSSStyleDeclaration)
    const onConfirm = vi.fn()
    const bubble = createEditBubble(el, { onConfirm, onCancel: vi.fn() })

    const slider = $(bubble, '[data-field="opacity"]')
    expect(slider.type).toBe('range')
    expect(slider.value).toBe('50')

    slider.value = '20'
    slider.dispatchEvent(new Event('input'))
    expect(el.style.opacity).toBe('0.2')
    $(bubble, '[data-action="confirm"]').click()
    expect(onConfirm).toHaveBeenCalledWith(expect.objectContaining({ opacity: { from: '0.5', to: '0.2' } }))
    bubble.destroy()
  })

  it('font uses a dropdown whose first item is the element\'s current font', () => {
    const el = document.getElementById('t')!
    vi.spyOn(window, 'getComputedStyle').mockReturnValue({ color: 'rgb(0,0,0)', backgroundColor: 'rgba(0,0,0,0)', opacity: '1', fontFamily: 'Georgia, serif' } as unknown as CSSStyleDeclaration)
    const bubble = createEditBubble(el, { onConfirm: vi.fn(), onCancel: vi.fn() })

    const select = bubble.host.shadowRoot!.querySelector<HTMLSelectElement>('[data-field="fontFamily"]')!
    expect(select.tagName).toBe('SELECT')
    expect(select.value).toBe('Georgia, serif')
    expect(select.options[0]!.textContent).toContain('Georgia')

    select.value = select.options[1]!.value
    select.dispatchEvent(new Event('change'))
    expect(el.style.fontFamily).toBeTruthy()
    bubble.destroy()
  })

  it('reads value into the text field when an input is selected', () => {
    document.body.innerHTML = '<input id="f" value="Todo content">'
    const field = document.getElementById('f')!
    const bubble = createEditBubble(field, { onConfirm: vi.fn(), onCancel: vi.fn() })
    expect($(bubble, '[data-field="text"]').value).toBe('Todo content')
    bubble.destroy()
  })

  it('offers no text field for a container with element children (editing would flatten the subtree)', () => {
    document.body.innerHTML = '<div id="d"><span>a</span><span>b</span></div>'
    const container = document.getElementById('d')!
    const bubble = createEditBubble(container, { onConfirm: vi.fn(), onCancel: vi.fn() })
    expect(bubble.host.shadowRoot!.querySelector('[data-field="text"]')).toBeNull()
    expect(bubble.host.shadowRoot!.querySelector('[data-field="color"]')).not.toBeNull()
    bubble.destroy()
  })

  it('Escape cancels and Cmd/Ctrl+Enter confirms', () => {
    const el = document.getElementById('t')!
    const onCancel = vi.fn()
    const escBubble = createEditBubble(el, { onConfirm: vi.fn(), onCancel })
    escBubble.host.shadowRoot!.querySelector('.bubble')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(onCancel).toHaveBeenCalled()
    escBubble.destroy()

    const onConfirm = vi.fn()
    const enterBubble = createEditBubble(el, { onConfirm, onCancel: vi.fn() })
    enterBubble.host.shadowRoot!.querySelector('.bubble')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true }))
    expect(onConfirm).toHaveBeenCalled()
    enterBubble.destroy()
  })

  it('cancel reverts live edits and fires onCancel', () => {
    const el = document.getElementById('t')!
    const onCancel = vi.fn(); const onConfirm = vi.fn()
    const bubble = createEditBubble(el, { onConfirm, onCancel })
    const textInput = $(bubble, '[data-field="text"]'); textInput.value = 'New'; textInput.dispatchEvent(new Event('input'))
    expect(el.textContent).toBe('New')
    $(bubble, '[data-action="cancel"]').click()
    expect(el.textContent).toBe('Old')   // reverted
    expect(onCancel).toHaveBeenCalled()
    expect(onConfirm).not.toHaveBeenCalled()
    bubble.destroy()
  })
})
