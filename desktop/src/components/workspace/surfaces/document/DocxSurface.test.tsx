import '@testing-library/jest-dom/vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { browserHost } from '@/lib/desktopHost/browserHost'
import { anchoredScroll } from '@/lib/zoomPan'
import { useSettingsStore } from '@/stores/settingsStore'
import { useUIStore } from '@/stores/uiStore'
import type { WorkspaceFileView } from '@/stores/workspaceContentStore'
import { blobWithBytes } from '@/test/blobs'
import { A4_PAGE, createFakeDocxEngine } from '@/test/fakeDocxEngine'
import { expectSameNodes } from '@/test/nodes'
import { DocxError, type DocxEngine } from './docxEngine'
import { FRAME_SANDBOX, INNER_CSP } from './docxFrame'
import DocxSurface from './DocxSurface'

vi.mock('@/lib/systemFileOpen', () => ({
  openLocalFileWithSystem: vi.fn().mockResolvedValue(undefined),
  reportOpenFailure: vi.fn(),
}))

// ---- the panel: jsdom lays nothing out, so its size is whatever a test says ----

let viewport = { width: 700, height: 800 }
const resizeCallbacks = new Set<() => void>()
const originalClientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth')
const originalClientHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight')

class StubResizeObserver {
  constructor(private readonly callback: () => void) {}
  observe() {
    resizeCallbacks.add(this.callback)
  }
  unobserve() {}
  disconnect() {
    resizeCallbacks.delete(this.callback)
  }
}

function resizePanel(width: number, height: number) {
  viewport = { width, height }
  act(() => resizeCallbacks.forEach((callback) => callback()))
}

beforeEach(() => {
  useSettingsStore.setState({ locale: 'en' })
  viewport = { width: 700, height: 800 }
  resizeCallbacks.clear()
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => viewport.width })
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => viewport.height })
  vi.stubGlobal('ResizeObserver', StubResizeObserver)
})

afterEach(() => {
  vi.unstubAllGlobals()
  Reflect.deleteProperty(window, 'desktopHost')
  document.documentElement.style.removeProperty('color-scheme')
  if (originalClientWidth) Object.defineProperty(HTMLElement.prototype, 'clientWidth', originalClientWidth)
  if (originalClientHeight) Object.defineProperty(HTMLElement.prototype, 'clientHeight', originalClientHeight)
})

// ---- the surface under test ----

const docxBlob = blobWithBytes([80, 75, 3, 4], 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')

type SurfaceProps = {
  engine: DocxEngine
  onAnnotate?: (selection: { text: string; location: string }) => void
  blob?: Blob
  zoom?: number
  onZoomChange?: (zoom: number | undefined) => void
  initialView?: WorkspaceFileView
  absolutePath?: string
}

/** Holds the zoom the way the workspace store does: chosen here, handed back down. */
function Surface({ onAnnotate, engine, blob = docxBlob, zoom: initialZoom, onZoomChange, initialView, absolutePath = '/work/docs/thesis.docx' }: SurfaceProps) {
  const [zoom, setZoom] = useState(initialZoom)
  return (
    <DocxSurface
      engine={engine}
      onAnnotate={onAnnotate}
      blob={blob}
      path="docs/thesis.docx"
      absolutePath={absolutePath}
      version="1"
      refreshing={false}
      zoom={zoom}
      onZoomChange={(next) => {
        setZoom(next)
        onZoomChange?.(next)
      }}
      initialView={initialView}
    />
  )
}

const scroller = () => screen.getByRole('group', { name: 'thesis.docx' })
const frames = () => [...scroller().querySelectorAll('iframe')]
const visibleFrames = () => frames().filter((frame) => frame.style.visibility !== 'hidden')
const wrapperOf = (frame: HTMLIFrameElement) => frame.contentDocument!.querySelector<HTMLElement>('.docx-wrapper')!
const zoomOf = (frame: HTMLIFrameElement) => wrapperOf(frame).style.getPropertyValue('--docx-zoom')
const zoomIn = () => screen.getByRole('button', { name: 'Zoom in' })
const zoomOut = () => screen.getByRole('button', { name: 'Zoom out' })
const fitButton = () => screen.getByRole('button', { name: 'Fit to width' })

/** A page 600px wide is 632px with its padding: it fits a 700px panel at 100% and a 400px one at 63%. */
const PAGE_WITH_PADDING = 600 + 32

async function shown(props: Partial<Omit<SurfaceProps, 'engine'>> & { engine?: DocxEngine } = {}) {
  const { engine = createFakeDocxEngine({ autoFinish: true }).engine, ...surfaceProps } = props
  const view = render(<Surface {...surfaceProps} engine={engine} />)
  await screen.findByRole('button', { name: 'Zoom in' })
  return { ...view, engine }
}

function scrollTo(top: number, left = 0) {
  scroller().scrollTop = top
  scroller().scrollLeft = left
  fireEvent.scroll(scroller())
}

describe('DocxSurface', () => {
  it('offers a page annotation for keyboard selections and clears it on Escape', async () => {
    const onAnnotate = vi.fn()
    await shown({ onAnnotate })
    const root = visibleFrames()[0]!.contentDocument!.body
    const page = root.querySelector('section.docx')!
    const range = root.ownerDocument.createRange()
    range.selectNodeContents(page)
    const selection = root.ownerDocument.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    fireEvent.keyUp(page, { key: 'ArrowRight', shiftKey: true })
    fireEvent.click(screen.getByRole('button', { name: 'Add to chat' }))
    expect(onAnnotate).toHaveBeenCalledWith({ text: page.textContent!.trim(), location: 'Page 1' })
    selection.addRange(range)
    fireEvent.keyUp(page, { key: 'ArrowRight', shiftKey: true })
    fireEvent.keyDown(page, { key: 'Escape' })
    fireEvent.keyUp(page, { key: 'Escape' })
    expect(screen.queryByRole('button', { name: 'Add to chat' })).not.toBeInTheDocument()
  })

  it('reserves room for the scrollbar always, so fitting to the width does not depend on whether the page overflows', async () => {
    // A classic scrollbar that comes and goes narrows the panel, which changes the fit,
    // which changes whether the page overflows: measured in Chromium, a one-page document
    // then flipped between two widths without end. jsdom has no scrollbars to measure;
    // this pins the reason.
    await shown()

    expect(scroller().className).toContain('overflow-y-scroll')
  })

  describe('drawing', () => {
    it('says it is loading until the first version is drawn', async () => {
      const { engine, renders } = createFakeDocxEngine()
      render(<Surface engine={engine} />)
      await waitFor(() => expect(renders).toHaveLength(1))

      expect(screen.getByText('Loading document...')).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'Zoom in' })).not.toBeInTheDocument()

      await act(async () => renders[0]!.finish())
      await screen.findByRole('button', { name: 'Zoom in' })
      expect(screen.queryByText('Loading document...')).not.toBeInTheDocument()
    })

    it('hands the engine the bytes of the file, and a place to draw in the frame', async () => {
      const { engine, renders } = createFakeDocxEngine({ autoFinish: true })
      await shown({ engine })

      expect(Array.from(renders[0]!.bytes)).toEqual([80, 75, 3, 4])
      expect(renders[0]!.target.body.ownerDocument).toBe(frames()[0]!.contentDocument)
      expect(renders[0]!.target.styles.ownerDocument).toBe(frames()[0]!.contentDocument)
    })

    it('draws the pages into the frame', async () => {
      await shown()

      expect(frames()[0]!.contentDocument!.body.textContent).toContain('A page of the document')
    })

    it('says, under the bar, what a preview of a Word file leaves out', async () => {
      await shown()

      expect(screen.getByText(/Approximate preview: equations and some shapes may not appear/)).toBeInTheDocument()
    })

    it('offers the file to the system app from the bar above the pages', async () => {
      await shown()

      expect(screen.getByRole('button', { name: 'Open in system app' })).toBeInTheDocument()
    })

    it('leaves restoring the scroll position to the viewer, as the panel expects of an async surface', async () => {
      await shown()

      expect(scroller()).toHaveAttribute('data-workspace-scroll-surface', 'deferred')
    })
  })

  describe('what the document brought with it', () => {
    const links = '<a href="https://example.com">web</a><a href="javascript:alert(1)">script</a><a href="file:///etc/hosts">file</a><a href="#bm1">bookmark</a>'

    it('goes nowhere it should not: a link that leads nowhere has no href left to follow', async () => {
      const { engine } = createFakeDocxEngine({ autoFinish: true, pages: [{ ...A4_PAGE, html: links }] })
      await shown({ engine })

      const anchors = [...frames()[0]!.contentDocument!.querySelectorAll('a')]
      expect(anchors.map((anchor) => anchor.getAttribute('href'))).toEqual(['https://example.com', null, null, '#bm1'])
    })

    it('puts the page’s stylesheet after the document’s own, so that where they differ the page’s wins', async () => {
      await shown()

      const children = [...frames()[0]!.contentDocument!.body.children]
      const styles = children.findIndex((child) => child.querySelector('style'))
      const pages = children.findIndex((child) => child.querySelector('.docx-wrapper'))
      const ours = children.findIndex((child) => child.tagName === 'STYLE')
      expect(styles).toBeGreaterThanOrEqual(0)
      expect(styles).toBeLessThan(pages)
      expect(pages).toBeLessThan(ours)
      expect(children[ours]!.textContent).toContain('.docx-wrapper')
    })

    it('paints the paper with the theme’s colour, not a colour of its own', async () => {
      document.documentElement.style.setProperty('--color-document-paper', 'rgb(1, 2, 3)')
      try {
        await shown()

        const ours = [...frames()[0]!.contentDocument!.body.children].find((child) => child.tagName === 'STYLE')
        expect(ours?.textContent).toContain('background:rgb(1, 2, 3)')
      } finally {
        document.documentElement.style.removeProperty('--color-document-paper')
      }
    })
  })

  describe('the frame', () => {
    it('cannot run script: sandboxed with exactly the one permission the page needs', async () => {
      await shown()

      const sandbox = frames()[0]!.getAttribute('sandbox')
      expect(sandbox).toBe(FRAME_SANDBOX)
      expect(sandbox).not.toContain('allow-scripts')
    })

    it('starts from a document whose first word is its policy', async () => {
      await shown()

      const srcdoc = new DOMParser().parseFromString(frames()[0]!.srcdoc, 'text/html')
      expect(srcdoc.head.firstElementChild?.getAttribute('content')).toBe(INNER_CSP)
    })

    it('is named for the file, for anyone who cannot see it', async () => {
      await shown()

      expect(frames()[0]!.title).toBe('thesis.docx')
    })

    it('is a single frame for a single version', async () => {
      await shown()

      expect(frames()).toHaveLength(1)
    })
  })

  describe('zoom', () => {
    it('fits a page that fits the panel at 100%, and never enlarges it past that', async () => {
      await shown()

      expect(screen.getByText('100%')).toBeInTheDocument()
      expect(zoomOf(frames()[0]!)).toBe('1')
      expect(fitButton()).toBeDisabled()
    })

    it('shrinks a page that does not fit a narrow panel to fit it', async () => {
      viewport = { width: 400, height: 800 }
      await shown()

      const scale = 400 / PAGE_WITH_PADDING
      expect(Number(zoomOf(frames()[0]!))).toBeCloseTo(scale, 6)
      expect(screen.getByText('63%')).toBeInTheDocument()
      // The frame is no wider than the panel, so nothing scrolls sideways.
      expect(frames()[0]!.style.width).toBe('400px')
    })

    it('fits the widest page when they differ', async () => {
      viewport = { width: 400, height: 800 }
      const { engine } = createFakeDocxEngine({ autoFinish: true, pages: [A4_PAGE, { width: '900px', text: 'landscape' }] })
      await shown({ engine })

      expect(Number(zoomOf(frames()[0]!))).toBeCloseTo(400 / (900 + 32), 6)
    })

    it('starts at the zoom the reader chose before', async () => {
      await shown({ zoom: 1.5 })

      expect(zoomOf(frames()[0]!)).toBe('1.5')
      expect(screen.getByText('150%')).toBeInTheDocument()
      expect(fitButton()).toBeEnabled()
    })

    it('makes the frame as wide as the pages need when they are wider than the panel, so that this area scrolls', async () => {
      await shown({ zoom: 1.5 })

      expect(frames()[0]!.style.width).toBe(`${PAGE_WITH_PADDING * 1.5}px`)
    })

    it('steps to the next rung and reports it, so it is remembered', async () => {
      viewport = { width: 400, height: 800 }
      const onZoomChange = vi.fn()
      await shown({ onZoomChange })

      fireEvent.click(zoomIn())

      expect(onZoomChange).toHaveBeenCalledWith(0.67) // the first rung above 63%
      expect(zoomOf(frames()[0]!)).toBe('0.67')
    })

    it('leaves fit mode when the reader chooses a zoom, and returns to it on request', async () => {
      const onZoomChange = vi.fn()
      await shown({ onZoomChange })

      fireEvent.click(zoomOut())
      expect(fitButton()).toBeEnabled()

      fireEvent.click(fitButton())
      expect(onZoomChange).toHaveBeenLastCalledWith(undefined)
      expect(fitButton()).toBeDisabled()
    })

    it('cannot go past either end of the ladder', async () => {
      const { unmount } = await shown({ zoom: 0.1 })
      expect(zoomOut()).toBeDisabled()
      unmount()
      await shown({ zoom: 8 })
      expect(zoomIn()).toBeDisabled()
    })

    it('keeps the reader’s place: what was under the middle of the panel stays there', async () => {
      viewport = { width: 400, height: 800 }
      await shown()
      scrollTo(1000)

      fireEvent.click(zoomIn())

      const expected = anchoredScroll({
        scrollLeft: 0,
        scrollTop: 1000,
        anchorX: 200,
        anchorY: 400,
        oldScale: 400 / PAGE_WITH_PADDING,
        newScale: 0.67,
      }).scrollTop
      expect(Math.abs(expected - 1000)).toBeGreaterThan(20) // the test can tell a kept place from a lost one
      expect(scroller().scrollTop).toBeCloseTo(expected, 3)
    })

    describe('with the wheel and keyboard', () => {
      it('zooms from a Ctrl+wheel over the surround, and stops the browser zooming the whole app', async () => {
        const onZoomChange = vi.fn()
        await shown({ onZoomChange })

        const allowed = fireEvent.wheel(scroller(), { ctrlKey: true, deltaY: -100 })

        expect(allowed).toBe(false)
        expect(onZoomChange).toHaveBeenCalledTimes(1)
        expect(onZoomChange.mock.calls[0]![0]).toBeGreaterThan(1)
      })

      it('leaves an ordinary wheel to scroll', async () => {
        const onZoomChange = vi.fn()
        await shown({ onZoomChange })

        const allowed = fireEvent.wheel(scroller(), { deltaY: 100 })

        expect(allowed).toBe(true)
        expect(onZoomChange).not.toHaveBeenCalled()
      })

      it('zooms from a Ctrl+wheel over the document itself, which the page hears of only through the frame', async () => {
        const onZoomChange = vi.fn()
        await shown({ onZoomChange, zoom: 1 })
        const doc = frames()[0]!.contentDocument!

        const event = new WheelEvent('wheel', { ctrlKey: true, deltaY: 100, bubbles: true, cancelable: true })
        act(() => {
          doc.body.dispatchEvent(event)
        })

        expect(event.defaultPrevented).toBe(true)
        expect(onZoomChange).toHaveBeenCalledTimes(1)
        expect(onZoomChange.mock.calls[0]![0]).toBeLessThan(1)
      })

      it.each([
        ['+', 1.5], // the rung above 125%
        ['-', 1.1], // the rung below it
        ['1', 1],
        ['0', undefined],
      ])('zooms from the keyboard: %s', async (key, expected) => {
        const onZoomChange = vi.fn()
        await shown({ onZoomChange, zoom: 1.25 })

        fireEvent.keyDown(scroller(), { key })

        expect(onZoomChange).toHaveBeenCalledWith(expected)
      })

      it('zooms from the keyboard while the frame has it, too', async () => {
        const onZoomChange = vi.fn()
        await shown({ onZoomChange, zoom: 1 })

        act(() => {
          frames()[0]!.contentDocument!.body.dispatchEvent(new KeyboardEvent('keydown', { key: '+', bubbles: true, cancelable: true }))
        })

        expect(onZoomChange).toHaveBeenCalledWith(1.1)
      })

      it('leaves browser shortcuts alone', async () => {
        const onZoomChange = vi.fn()
        await shown({ onZoomChange })

        fireEvent.keyDown(scroller(), { key: '+', ctrlKey: true })
        fireEvent.keyDown(scroller(), { key: '-', metaKey: true })

        expect(onZoomChange).not.toHaveBeenCalled()
      })
    })
  })

  describe('the panel', () => {
    it('refits the pages when the panel is resized', async () => {
      viewport = { width: 400, height: 800 }
      await shown()
      expect(Number(zoomOf(frames()[0]!))).toBeCloseTo(400 / PAGE_WITH_PADDING, 6)

      resizePanel(500, 800)

      expect(Number(zoomOf(frames()[0]!))).toBeCloseTo(500 / PAGE_WITH_PADDING, 6)
      expect(frames()[0]!.style.width).toBe('500px')
    })

    it('leaves a zoom the reader chose alone', async () => {
      await shown({ zoom: 1.5 })

      resizePanel(500, 800)

      expect(zoomOf(frames()[0]!)).toBe('1.5')
    })

    it('puts the reader back after the panel was hidden and shown again', async () => {
      await shown()
      scrollTo(1234)

      resizePanel(0, 0) // a hidden panel has no size
      scroller().scrollTop = 0 // and the browser forgets where it was scrolled to
      resizePanel(700, 800)

      expect(scroller().scrollTop).toBe(1234)
    })
  })

  describe('coming back to a file', () => {
    it('restores where the reader left it', async () => {
      await shown({ initialView: { scrollTop: 2500, scrollLeft: 0 } })

      expect(scroller().scrollTop).toBe(2500)
    })

    it('restores the sideways position too', async () => {
      await shown({ zoom: 2, initialView: { scrollTop: 0, scrollLeft: 300 } })

      expect(scroller().scrollLeft).toBe(300)
    })
  })

  describe('when the file is rewritten', () => {
    const blobA = blobWithBytes([1], 'application/octet-stream')
    const blobB = blobWithBytes([2], 'application/octet-stream')
    const blobC = blobWithBytes([3], 'application/octet-stream')

    async function firstVersion() {
      const { engine, renders } = createFakeDocxEngine()
      const view = render(<Surface engine={engine} blob={blobA} />)
      await waitFor(() => expect(renders).toHaveLength(1))
      await act(async () => renders[0]!.finish())
      await screen.findByRole('button', { name: 'Zoom in' })
      return { ...view, engine, renders }
    }

    it('keeps the version on show until the next one is drawn, drawing that one out of sight', async () => {
      const { rerender, engine, renders } = await firstVersion()
      const first = frames()[0]!

      rerender(<Surface engine={engine} blob={blobB} />)
      await waitFor(() => expect(renders).toHaveLength(2))

      expect(frames()).toHaveLength(2)
      expectSameNodes(visibleFrames(), [first])
      const next = frames()[1]!
      expect(next.style.visibility).toBe('hidden')
      expect(next.style.pointerEvents).toBe('none')
    })

    it('swaps in the new version when it is drawn: one frame left, on show, and already sized', async () => {
      const { rerender, engine, renders } = await firstVersion()
      const first = frames()[0]!
      scrollTo(100)

      rerender(<Surface engine={engine} blob={blobB} />)
      await waitFor(() => expect(renders).toHaveLength(2))
      await act(async () => renders[1]!.finish())

      await waitFor(() => expect(frames()).toHaveLength(1))
      const second = frames()[0]!
      expect(second).not.toBe(first)
      expect(second.style.visibility).toBe('')
      expect(second.style.position).toBe('')
      expect(second.style.width).toBe('700px')
      expect(zoomOf(second)).toBe('1')
      // The reader is where they were.
      expect(scroller().scrollTop).toBe(100)
    })

    it('sizes the new frame before it puts it on show, so that the swap never passes through an empty one', async () => {
      const { rerender, engine, renders } = await firstVersion()
      rerender(<Surface engine={engine} blob={blobB} />)
      await waitFor(() => expect(renders).toHaveLength(2))
      const next = frames()[1]!
      // The frame's style attribute as it changes: what it was before each change, then what it is now.
      const before: string[] = []
      const observer = new MutationObserver((records) => before.push(...records.map((record) => record.oldValue ?? '')))
      observer.observe(next, { attributes: true, attributeFilter: ['style'], attributeOldValue: true })

      await act(async () => renders[1]!.finish())
      await waitFor(() => expect(frames()).toHaveLength(1))
      before.push(...observer.takeRecords().map((record) => record.oldValue ?? ''))
      observer.disconnect()
      const history = [...before, next.getAttribute('style') ?? '']

      const sized = history.findIndex((style) => style.includes('width: 700px'))
      const shown = history.findIndex((style) => !style.includes('visibility: hidden'))
      expect(sized).toBeGreaterThanOrEqual(0)
      expect(shown).toBeGreaterThan(0)
      expect(sized).toBeLessThan(shown)
    })

    it('keeps the zoom the reader chose across the swap', async () => {
      const { engine, renders, rerender } = await firstVersion()
      fireEvent.click(zoomIn())
      const chosen = zoomOf(frames()[0]!)

      rerender(<Surface engine={engine} blob={blobB} />)
      await waitFor(() => expect(renders).toHaveLength(2))
      await act(async () => renders[1]!.finish())

      await waitFor(() => expect(frames()).toHaveLength(1))
      expect(zoomOf(frames()[0]!)).toBe(chosen)
    })

    it('keeps the old version, and says why, when the new one will not draw', async () => {
      const { rerender, engine, renders } = await firstVersion()
      const first = frames()[0]!

      rerender(<Surface engine={engine} blob={blobB} />) // a half-written document
      await waitFor(() => expect(renders).toHaveLength(2))
      await act(async () => renders[1]!.fail(new DocxError('invalid', 'not a document')))

      expect(await screen.findByRole('status')).toHaveTextContent(
        'Showing the last loaded version — refresh failed: This document could not be displayed.',
      )
      expectSameNodes(frames(), [first])
      expectSameNodes(visibleFrames(), [first])
    })

    it('takes the note away once a good version arrives', async () => {
      const { rerender, engine, renders } = await firstVersion()
      rerender(<Surface engine={engine} blob={blobB} />)
      await waitFor(() => expect(renders).toHaveLength(2))
      await act(async () => renders[1]!.fail(new DocxError('invalid', 'x')))
      await screen.findByRole('status')

      rerender(<Surface engine={engine} blob={blobC} />)
      await waitFor(() => expect(renders).toHaveLength(3))
      await act(async () => renders[2]!.finish())

      await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument())
    })

    it('never shows a version that was overtaken while it was still being drawn', async () => {
      const { rerender, engine, renders } = await firstVersion()
      const first = frames()[0]!

      rerender(<Surface engine={engine} blob={blobB} />)
      await waitFor(() => expect(renders).toHaveLength(2))
      rerender(<Surface engine={engine} blob={blobC} />)
      await waitFor(() => expect(renders).toHaveLength(3))
      await act(async () => renders[2]!.finish()) // the newer version is drawn first…
      await waitFor(() => expect(frames()).toHaveLength(2)) // (B's frame is still being drawn, out of sight)
      await waitFor(() => expect(visibleFrames()).not.toContain(first))
      const shownNow = visibleFrames()[0]!
      await act(async () => renders[1]!.finish()) // …and the older one limps in afterwards

      // Only the newer one is left, and it is the one on show.
      await waitFor(() => expectSameNodes(frames(), [shownNow]))
      expectSameNodes(visibleFrames(), [shownNow])
    })

    it('does not report the failure of a version that was overtaken', async () => {
      const { rerender, engine, renders } = await firstVersion()
      rerender(<Surface engine={engine} blob={blobB} />)
      await waitFor(() => expect(renders).toHaveLength(2))
      rerender(<Surface engine={engine} blob={blobC} />)
      await waitFor(() => expect(renders).toHaveLength(3))

      await act(async () => renders[1]!.fail(new DocxError('invalid', 'stale')))

      expect(screen.queryByRole('status')).not.toBeInTheDocument()
    })
  })

  describe('when the document cannot be shown', () => {
    async function failing(error: DocxError, props: Partial<SurfaceProps> = {}) {
      const { engine, renders } = createFakeDocxEngine()
      render(<Surface engine={engine} {...props} />)
      await waitFor(() => expect(renders).toHaveLength(1))
      await act(async () => renders[0]!.fail(error))
      return { engine, renders }
    }

    it.each([
      ['invalid', 'This document could not be displayed.'],
      ['tooComplex', 'This file is too large or too complex to preview safely.'],
      ['unavailable', "The document viewer can't start in this environment."],
    ] as const)('explains a %s failure in words', async (kind, message) => {
      await failing(new DocxError(kind, 'x'))

      expect(await screen.findByText(message)).toBeInTheDocument()
    })

    it('leaves no frame behind for a document that would not draw', async () => {
      await failing(new DocxError('invalid', 'x'))
      await screen.findByText('This document could not be displayed.')

      expect(frames()).toHaveLength(0)
    })

    it.each(['invalid', 'tooComplex'] as const)('does not offer to try a %s document again: the same bytes fail the same way', async (kind) => {
      await failing(new DocxError(kind, 'x'))
      await screen.findByRole('button', { name: 'Open in system app' })

      expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument()
    })

    it('offers the system app for every failure', async () => {
      await failing(new DocxError('invalid', 'x'))

      expect(await screen.findByRole('button', { name: 'Open in system app' })).toBeInTheDocument()
    })

    it('lets the reader try again when the engine itself failed to load', async () => {
      const { renders } = await failing(new DocxError('unavailable', 'x'))
      fireEvent.click(await screen.findByRole('button', { name: 'Try again' }))

      await waitFor(() => expect(renders).toHaveLength(2))
      await act(async () => renders[1]!.finish())
      await screen.findByRole('button', { name: 'Zoom in' })
    })

    it('has nothing to open in a browser: a browser cannot show a Word document', async () => {
      await failing(new DocxError('unavailable', 'x'))
      await screen.findByRole('button', { name: 'Try again' })

      expect(screen.queryByRole('button', { name: 'Open in browser' })).not.toBeInTheDocument()
    })
  })

  describe('links in the document', () => {
    function clickLink(href: string | null) {
      const doc = frames()[0]!.contentDocument!
      const anchor = doc.createElement('a')
      if (href !== null) anchor.setAttribute('href', href)
      doc.body.append(anchor)
      const event = new MouseEvent('click', { bubbles: true, cancelable: true })
      act(() => {
        anchor.dispatchEvent(event)
      })
      return event
    }

    function hostWithShell(open: (url: string) => Promise<void>) {
      window.desktopHost = { ...browserHost, shell: { ...browserHost.shell, open } }
    }

    it('opens a web link through the application, never in the frame', async () => {
      const open = vi.fn().mockResolvedValue(undefined)
      hostWithShell(open)
      await shown()

      const event = clickLink('https://example.com/docs')

      expect(event.defaultPrevented).toBe(true)
      expect(open).toHaveBeenCalledWith('https://example.com/docs')
    })

    it('falls back to a window of its own, without a way back into the app, when the host cannot open it', async () => {
      hostWithShell(vi.fn().mockRejectedValue(new Error('no shell')))
      const openWindow = vi.spyOn(window, 'open').mockReturnValue(null)
      await shown()

      clickLink('https://example.com/docs')

      await waitFor(() => expect(openWindow).toHaveBeenCalledWith('https://example.com/docs', '_blank', 'noopener'))
    })

    it.each(['javascript:alert(1)', 'file:///etc/hosts', 'data:text/html,x', '/relative', null])('does nothing with %j', async (href) => {
      const open = vi.fn().mockResolvedValue(undefined)
      hostWithShell(open)
      const openWindow = vi.spyOn(window, 'open').mockReturnValue(null)
      await shown()

      const event = clickLink(href)

      expect(event.defaultPrevented).toBe(true)
      expect(open).not.toHaveBeenCalled()
      expect(openWindow).not.toHaveBeenCalled()
    })
  })

  describe('the theme', () => {
    it('keeps the frame’s colour scheme in step with the page’s, or its canvas turns opaque over the surround', async () => {
      document.documentElement.style.colorScheme = 'light'
      await shown()
      // jsdom does not apply a frame's srcdoc; put in the meta that a browser would have.
      const doc = frames()[0]!.contentDocument!
      const meta = doc.createElement('meta')
      meta.setAttribute('name', 'color-scheme')
      meta.setAttribute('content', 'light')
      doc.head.append(meta)

      act(() => {
        document.documentElement.style.colorScheme = 'dark'
        useUIStore.setState({ theme: 'dark' })
      })

      await waitFor(() => expect(meta.getAttribute('content')).toBe('dark'))
    })
  })

  it('takes its frames with it when it goes', async () => {
    const { unmount } = await shown()
    expect(document.querySelectorAll('iframe')).toHaveLength(1)

    unmount()

    expect(document.querySelectorAll('iframe')).toHaveLength(0)
  })

  it('takes a frame still being drawn with it, too', async () => {
    const { engine, renders } = createFakeDocxEngine()
    const { unmount } = render(<Surface engine={engine} />)
    await waitFor(() => expect(renders).toHaveLength(1))

    unmount()
    await act(async () => renders[0]!.finish())

    expect(document.querySelectorAll('iframe')).toHaveLength(0)
  })
})
