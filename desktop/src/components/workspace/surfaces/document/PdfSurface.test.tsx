import '@testing-library/jest-dom/vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { browserHost } from '@/lib/desktopHost/browserHost'
import { useSettingsStore } from '@/stores/settingsStore'
import type { WorkspaceFileView } from '@/stores/workspaceContentStore'
import { blobWithBytes } from '@/test/blobs'
import {
  LETTER,
  createControllablePdfEngine,
  createFakePdfDocument,
  createFakePdfEngine,
  type FakePdfDocument,
} from '@/test/fakePdfEngine'
import { PdfError, type PdfEngine } from './pdfEngine'
import {
  PDF_CSS_UNITS,
  PDF_PAGE_GAP,
  PDF_PAGE_PADDING,
  anchoredScrollTop,
  layoutPdfColumn,
  type PageSize,
} from './pdfLayout'
import PdfSurface from './PdfSurface'

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
  vi.useRealTimers()
  vi.unstubAllGlobals()
  Reflect.deleteProperty(window, 'desktopHost')
  if (originalClientWidth) Object.defineProperty(HTMLElement.prototype, 'clientWidth', originalClientWidth)
  if (originalClientHeight) Object.defineProperty(HTMLElement.prototype, 'clientHeight', originalClientHeight)
})

// ---- geometry the assertions are worked out from, independently of the component ----

const PANEL = 700
/** What "fit to width" is for a Letter page in the 700px panel above. */
const FIT = (PANEL - 2 * PDF_PAGE_PADDING) / LETTER.width
const pagesOf = (count: number, size: PageSize = LETTER) => Array.from({ length: count }, () => size)
const boxesAt = (scale: number, sizes: PageSize[] = pagesOf(30)) =>
  layoutPdfColumn(sizes, scale, { gap: PDF_PAGE_GAP, padding: PDF_PAGE_PADDING }).boxes

// ---- the surface under test ----

const pdfBlob = blobWithBytes([37, 80, 68, 70], 'application/pdf')

type SurfaceProps = {
  engine: PdfEngine
  onAnnotate?: (selection: { text: string; location: string }) => void
  blob?: Blob
  zoom?: number
  onZoomChange?: (zoom: number | undefined) => void
  initialView?: WorkspaceFileView
  absolutePath?: string
}

/** Holds the zoom the way the workspace store does: chosen here, handed back down. */
function Surface({ onAnnotate, engine, blob = pdfBlob, zoom: initialZoom, onZoomChange, initialView, absolutePath = '/work/docs/thesis.pdf' }: SurfaceProps) {
  const [zoom, setZoom] = useState(initialZoom)
  return (
    <PdfSurface
      engine={engine}
      onAnnotate={onAnnotate}
      blob={blob}
      path="docs/thesis.pdf"
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

async function show(props: Partial<Omit<SurfaceProps, 'engine'>> & { doc?: FakePdfDocument } = {}) {
  const { doc = createFakePdfDocument({ pages: 30, autoFinish: true }), ...surfaceProps } = props
  const engine = createFakePdfEngine(doc)
  const view = render(<Surface {...surfaceProps} engine={engine} />)
  await screen.findByRole('group', { name: 'thesis.pdf' })
  return { ...view, doc, engine }
}

const scroller = () => screen.getByRole('group', { name: 'thesis.pdf' })
const sheets = () => screen.queryAllByRole('group', { name: /^Page \d+ of \d+$/ })
const sheetNumbers = () => sheets().map((sheet) => Number(/^Page (\d+) of/.exec(sheet.getAttribute('aria-label')!)![1]))
/** The box a page is placed in; the sheet itself just fills it. */
const placed = (sheet: HTMLElement) => sheet.parentElement as HTMLElement
const pageInput = () => screen.getByRole('textbox', { name: 'Page number' })
const zoomIn = () => screen.getByRole('button', { name: 'Zoom in' })
const zoomOut = () => screen.getByRole('button', { name: 'Zoom out' })
const fitButton = () => screen.getByRole('button', { name: 'Fit to width' })

/** The reader scrolls: the browser moves the offset and then tells us. */
function scrollTo(top: number, left = 0) {
  const node = scroller()
  node.scrollTop = top
  node.scrollLeft = left
  fireEvent.scroll(node)
}

/** Let the pages that were mounted finish drawing. */
const flush = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })

describe('PdfSurface', () => {
  it('offers a page annotation for keyboard selections and clears it on Escape', async () => {
    const onAnnotate = vi.fn()
    await show({ onAnnotate })
    const root = scroller()
    await waitFor(() => expect(root.querySelector('.textLayer span')).not.toBeNull())
    const page = root.querySelector('.textLayer span')!
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

  describe('opening', () => {
    it('says it is loading until the document is open', () => {
      render(<Surface engine={{ open: () => new Promise(() => undefined) }} />)

      expect(screen.getByText('Loading document...')).toBeInTheDocument()
    })

    it('opens the bytes of the file', async () => {
      const { engine } = await show()

      expect(engine.open).toHaveBeenCalledTimes(1)
      expect(Array.from(engine.open.mock.calls[0]![0] as Uint8Array)).toEqual([37, 80, 68, 70])
    })

    it('leaves restoring the scroll position to the viewer, as the panel expects of an async surface', async () => {
      await show()

      expect(scroller()).toHaveAttribute('data-workspace-scroll-surface', 'deferred')
    })

    it('offers the file to the system app from the bar above the pages', async () => {
      await show()

      expect(screen.getByRole('button', { name: 'Open in system app' })).toBeInTheDocument()
    })
  })

  describe('layout', () => {
    it('fits the pages to the width of the panel', async () => {
      await show()

      expect(parseFloat(placed(sheets()[0]!).style.width)).toBeCloseTo(LETTER.width * FIT, 3)
      expect(screen.getByText('82%')).toBeInTheDocument()
    })

    it('centres a page that is narrower than the panel', async () => {
      await show()

      expect(parseFloat(placed(sheets()[0]!).style.left)).toBeCloseTo(PDF_PAGE_PADDING, 3)
    })

    it('does not blow a page up past its natural size to fill a wide panel', async () => {
      viewport = { width: 2000, height: 800 }
      await show()

      const first = placed(sheets()[0]!)
      expect(parseFloat(first.style.width)).toBeCloseTo(LETTER.width, 3)
      expect(parseFloat(first.style.left)).toBeCloseTo((2000 - LETTER.width) / 2, 3)
      expect(screen.getByText('100%')).toBeInTheDocument()
    })

    it('scrolls sideways only once the zoom makes the pages wider than the panel', async () => {
      await show()
      const column = () => scroller().firstElementChild as HTMLElement
      expect(parseFloat(column().style.width)).toBe(PANEL)

      fireEvent.click(zoomIn())
      fireEvent.click(zoomIn()) // 0.9 → 1
      fireEvent.click(zoomIn()) // → 1.1

      expect(parseFloat(column().style.width)).toBeCloseTo(LETTER.width * 1.1 + 2 * PDF_PAGE_PADDING, 3)
    })

    it('makes the column as tall as all of its pages, gaps and padding', async () => {
      await show()
      const boxes = boxesAt(FIT)
      const last = boxes[boxes.length - 1]!

      const column = scroller().firstElementChild as HTMLElement

      expect(parseFloat(column.style.height)).toBeCloseTo(last.top + last.height + PDF_PAGE_PADDING, 3)
    })

    it('gives each page the size its own dimensions call for', async () => {
      const wide: PageSize = { width: 1056, height: 816 } // a landscape page among portrait ones
      await show({ doc: createFakePdfDocument({ sizes: [LETTER, wide, LETTER], autoFinish: true }) })

      const [first, second] = sheets().map((sheet) => placed(sheet))
      const fitWide = (PANEL - 2 * PDF_PAGE_PADDING) / 1056 // the widest page sets the fit

      expect(parseFloat(second!.style.width)).toBeCloseTo(1056 * fitWide, 3)
      expect(parseFloat(second!.style.height)).toBeCloseTo(816 * fitWide, 3)
      // Narrower pages are centred under it, not stretched to it.
      expect(parseFloat(first!.style.width)).toBeCloseTo(816 * fitWide, 3)
      expect(parseFloat(first!.style.left)).toBeGreaterThan(parseFloat(second!.style.left))
    })
  })

  describe('virtualisation', () => {
    it('mounts only the pages near the viewport', async () => {
      await show()

      expect(sheetNumbers()).toEqual([1, 2])
      expect(screen.queryByRole('group', { name: 'Page 30 of 30' })).not.toBeInTheDocument()
    })

    it('draws the pages it mounted, at the fitted zoom', async () => {
      const { doc } = await show()
      await flush()

      expect(doc.renderPage).toHaveBeenCalledWith(1, expect.objectContaining({ scale: expect.closeTo(FIT, 6) }))
      expect(doc.renderPage).toHaveBeenCalledWith(2, expect.anything())
      expect(doc.renderPage).not.toHaveBeenCalledWith(3, expect.anything())
    })

    it('brings pages in as the reader scrolls, and lets the ones left behind go', async () => {
      const { doc } = await show()
      await flush()

      scrollTo(boxesAt(FIT)[19]!.top) // page 20 at the top of the panel

      // One panel-height of margin either side: page 19 ends inside it, page 22 starts beyond it.
      expect(sheetNumbers()).toEqual([19, 20, 21])
      // Pages 1 and 2 had been drawn: their bitmaps are returned to pdf.js.
      expect(doc.releasePage).toHaveBeenCalledWith(1)
      expect(doc.releasePage).toHaveBeenCalledWith(2)
    })

    it('does not re-render the pages for a scroll that stays within the same window', async () => {
      const { doc } = await show()
      await flush()
      const drawn = vi.mocked(doc.renderPage).mock.calls.length

      scrollTo(40)
      scrollTo(80)
      await flush()

      expect(vi.mocked(doc.renderPage).mock.calls.length).toBe(drawn)
    })
  })

  describe('zoom', () => {
    it('steps to the next rung, and reports it so it is remembered', async () => {
      const onZoomChange = vi.fn()
      await show({ onZoomChange })

      fireEvent.click(zoomIn())

      expect(onZoomChange).toHaveBeenCalledWith(0.9) // the first rung above 82%
      expect(screen.getByText('90%')).toBeInTheDocument()
      expect(parseFloat(placed(sheets()[0]!).style.width)).toBeCloseTo(LETTER.width * 0.9, 3)
    })

    it('leaves fit mode when the reader chooses a zoom, and returns to it on request', async () => {
      const onZoomChange = vi.fn()
      await show({ onZoomChange })
      expect(fitButton()).toBeDisabled()

      fireEvent.click(zoomIn())
      expect(fitButton()).toBeEnabled()

      fireEvent.click(fitButton())
      expect(onZoomChange).toHaveBeenLastCalledWith(undefined)
      expect(fitButton()).toBeDisabled()
      expect(screen.getByText('82%')).toBeInTheDocument()
    })

    it('starts at the zoom the reader had chosen before', async () => {
      await show({ zoom: 1.5 })

      expect(parseFloat(placed(sheets()[0]!).style.width)).toBeCloseTo(LETTER.width * 1.5, 3)
      expect(screen.getByText('150%')).toBeInTheDocument()
      expect(fitButton()).toBeEnabled()
    })

    it('cannot go past either end of the ladder', async () => {
      const { unmount } = await show({ zoom: 0.1 })
      expect(zoomOut()).toBeDisabled()
      unmount()
      await show({ zoom: 8 })
      expect(zoomIn()).toBeDisabled()
    })

    it('keeps the reader’s place: the same page, the same distance down it', async () => {
      await show()
      const top = boxesAt(FIT)[2]!.top + boxesAt(FIT)[2]!.height / 2 // the middle of page 3
      scrollTo(top)

      fireEvent.click(zoomIn())

      // A button zooms about the middle of the panel.
      const expected = anchoredScrollTop({ before: boxesAt(FIT), after: boxesAt(0.9), scrollTop: top, anchorY: viewport.height / 2 })
      expect(Math.abs(expected - top)).toBeGreaterThan(100) // the test can tell a kept place from a lost one
      expect(scroller().scrollTop).toBeCloseTo(expected, 3)
    })

    describe('with the wheel and keyboard', () => {
      it('zooms about the pointer on Ctrl+wheel, and keeps the browser from zooming the whole app', async () => {
        const onZoomChange = vi.fn()
        await show({ onZoomChange })
        const top = boxesAt(FIT)[3]!.top + 120
        scrollTo(top)

        const allowed = fireEvent.wheel(scroller(), { ctrlKey: true, deltaY: -100, clientY: 100 })

        expect(allowed).toBe(false) // preventDefault was called
        expect(onZoomChange).toHaveBeenCalledTimes(1)
        const zoom = onZoomChange.mock.calls[0]![0] as number
        expect(zoom).toBeGreaterThan(FIT)
        const expected = anchoredScrollTop({ before: boxesAt(FIT), after: boxesAt(zoom), scrollTop: top, anchorY: 100 })
        expect(scroller().scrollTop).toBeCloseTo(expected, 3)
      })

      it('also zooms on ⌘+wheel', async () => {
        const onZoomChange = vi.fn()
        await show({ onZoomChange })

        fireEvent.wheel(scroller(), { metaKey: true, deltaY: -100 })

        expect(onZoomChange).toHaveBeenCalledTimes(1)
      })

      it('leaves an ordinary wheel to scroll', async () => {
        const onZoomChange = vi.fn()
        await show({ onZoomChange })

        const allowed = fireEvent.wheel(scroller(), { deltaY: 100 })

        expect(allowed).toBe(true)
        expect(onZoomChange).not.toHaveBeenCalled()
      })

      it.each([
        ['+', 0.9],
        ['=', 0.9],
        ['-', 0.75],
        ['1', 1],
        ['0', undefined],
      ])('zooms from the keyboard: %s', async (key, expected) => {
        const onZoomChange = vi.fn()
        await show({ onZoomChange })

        fireEvent.keyDown(scroller(), { key })

        expect(onZoomChange).toHaveBeenCalledWith(expected)
      })

      it('leaves browser shortcuts alone', async () => {
        const onZoomChange = vi.fn()
        await show({ onZoomChange })

        fireEvent.keyDown(scroller(), { key: '+', ctrlKey: true })
        fireEvent.keyDown(scroller(), { key: '-', metaKey: true })

        expect(onZoomChange).not.toHaveBeenCalled()
      })
    })

    it('draws at the new zoom only once the reader has stopped changing it, while the sheet follows at once', async () => {
      const { doc } = await show()
      // Let the drawing that came with opening settle first, on the real clock: React
      // only applies the updates queued inside `act` when it exits, so a fake clock
      // advanced within it would never see the timer that opening schedules.
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 150)) })
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      vi.mocked(doc.renderPage).mockClear()

      fireEvent.click(zoomIn())

      // The sheet, and the text laid over it, are at 90% already…
      expect(sheets()[0]!.style.getPropertyValue('--scale-factor')).toBe(String(0.9 * PDF_CSS_UNITS))
      // …the bitmap is not redrawn for every step of a gesture.
      await act(async () => { await vi.advanceTimersByTimeAsync(119) })
      expect(doc.renderPage).not.toHaveBeenCalled()
      await act(async () => { await vi.advanceTimersByTimeAsync(1) })
      expect(doc.renderPage).toHaveBeenCalledWith(1, expect.objectContaining({ scale: 0.9 }))
    })
  })

  describe('moving through the document', () => {
    it('shows which page the reader is on, and how many there are', async () => {
      await show()
      expect(pageInput()).toHaveValue('1')
      expect(screen.getByText('/ 30')).toBeInTheDocument()

      scrollTo(boxesAt(FIT)[6]!.top)

      expect(pageInput()).toHaveValue('7')
    })

    it('jumps to a page typed into the box', async () => {
      await show()

      fireEvent.focus(pageInput())
      fireEvent.change(pageInput(), { target: { value: '12' } })
      fireEvent.keyDown(pageInput(), { key: 'Enter' })

      expect(scroller().scrollTop).toBeCloseTo(boxesAt(FIT)[11]!.top - PDF_PAGE_GAP, 3)
      fireEvent.scroll(scroller()) // the browser reports the move
      expect(pageInput()).toHaveValue('12')
      expect(sheetNumbers()).toContain(12)
    })

    it('takes only digits', async () => {
      await show()

      fireEvent.focus(pageInput())
      fireEvent.change(pageInput(), { target: { value: '1a2b' } })

      expect(pageInput()).toHaveValue('12')
    })

    it('goes to the last page for a number past the end', async () => {
      await show()

      fireEvent.focus(pageInput())
      fireEvent.change(pageInput(), { target: { value: '999' } })
      fireEvent.keyDown(pageInput(), { key: 'Enter' })

      expect(scroller().scrollTop).toBeCloseTo(boxesAt(FIT)[29]!.top - PDF_PAGE_GAP, 3)
    })

    it('hands the keyboard back to the pages, so the arrow keys keep scrolling', async () => {
      await show()
      fireEvent.focus(pageInput())
      fireEvent.change(pageInput(), { target: { value: '5' } })

      fireEvent.keyDown(pageInput(), { key: 'Enter' })

      expect(scroller()).toHaveFocus()
    })

    it.each([
      ['Escape', { key: 'Escape' }],
      ['leaving the box', null],
    ])('goes nowhere when the entry is abandoned with %s', async (_label, key) => {
      await show()
      scrollTo(boxesAt(FIT)[3]!.top)
      const before = scroller().scrollTop
      fireEvent.focus(pageInput())
      fireEvent.change(pageInput(), { target: { value: '25' } })

      if (key) fireEvent.keyDown(pageInput(), key)
      else fireEvent.blur(pageInput())

      expect(scroller().scrollTop).toBe(before)
      expect(pageInput()).toHaveValue('4') // back to the page the reader is on
    })

    it('does not jump for an empty box', async () => {
      await show()
      scrollTo(boxesAt(FIT)[3]!.top)
      const before = scroller().scrollTop
      fireEvent.focus(pageInput())
      fireEvent.change(pageInput(), { target: { value: '' } })

      fireEvent.keyDown(pageInput(), { key: 'Enter' })

      expect(scroller().scrollTop).toBe(before)
    })
  })

  describe('coming back to a file', () => {
    it('restores where the reader left it, and draws what is there rather than the top', async () => {
      await show({ initialView: { scrollTop: 5000, scrollLeft: 0 } })

      expect(scroller().scrollTop).toBe(5000)
      expect(sheetNumbers()).toContain(6) // page 6 spans 4398–5263
      expect(sheetNumbers()).not.toContain(1)
    })

    it('restores the sideways position too', async () => {
      await show({ zoom: 2, initialView: { scrollTop: 0, scrollLeft: 300 } })

      expect(scroller().scrollLeft).toBe(300)
    })

    it('puts the reader back after the panel was hidden and shown again', async () => {
      const { doc } = await show()
      await flush()
      const top = boxesAt(FIT)[8]!.top + 50
      scrollTo(top)
      await flush()

      resizePanel(0, 0) // a hidden panel has no size…
      expect(sheets()).toHaveLength(0) // …so no page holds a bitmap
      expect(doc.releasePage).toHaveBeenCalled()
      scroller().scrollTop = 0 // and the browser forgets where it was scrolled to
      resizePanel(700, 800)

      expect(scroller().scrollTop).toBe(top)
      expect(sheetNumbers()).toContain(9)
    })
  })

  describe('when the panel is resized', () => {
    it('refits the pages and keeps the reader’s place', async () => {
      await show()
      const top = boxesAt(FIT)[4]!.top + 200
      scrollTo(top)

      resizePanel(760, 800) // wider, but still narrower than a page at 100%

      const wider = (760 - 2 * PDF_PAGE_PADDING) / LETTER.width
      expect(wider).toBeGreaterThan(FIT)
      expect(parseFloat(placed(sheets()[0]!).style.width)).toBeCloseTo(LETTER.width * wider, 3)
      const expected = anchoredScrollTop({ before: boxesAt(FIT), after: boxesAt(wider), scrollTop: top, anchorY: 0 })
      expect(scroller().scrollTop).toBeCloseTo(expected, 3)
    })

    it('mounts more pages when the panel grows taller', async () => {
      await show()
      expect(sheetNumbers()).toEqual([1, 2])

      resizePanel(700, 2000)

      expect(sheetNumbers().length).toBeGreaterThan(2)
    })

    it('leaves a zoom the reader chose alone', async () => {
      await show({ zoom: 1.5 })

      resizePanel(1000, 800)

      expect(parseFloat(placed(sheets()[0]!).style.width)).toBeCloseTo(LETTER.width * 1.5, 3)
    })

    it('does not carry the anchor of a zoom that changed nothing into the next resize', async () => {
      await show()
      const top = boxesAt(FIT)[4]!.top + 200
      scrollTo(top)

      // The fit button is disabled while fitted, but the keyboard still asks for fit:
      // no layout change, so no anchor should be left behind.
      fireEvent.keyDown(scroller(), { key: '0' })
      resizePanel(760, 800)

      const wider = (760 - 2 * PDF_PAGE_PADDING) / LETTER.width
      // A resize holds the top of the panel still, not the middle a button zooms about.
      const expected = anchoredScrollTop({ before: boxesAt(FIT), after: boxesAt(wider), scrollTop: top, anchorY: 0 })
      expect(scroller().scrollTop).toBeCloseTo(expected, 3)
    })

    it('reserves room for the scrollbar always, so fitting to the width does not depend on whether the pages overflow', async () => {
      // A scrollbar that comes and goes with the content narrows the panel, which changes
      // the fit, which changes whether the content overflows: a one-page document would
      // flicker between the two. jsdom has no scrollbars to measure; this pins the reason.
      await show()

      expect(scroller().className).toContain('overflow-y-scroll')
    })
  })

  describe('when the file is rewritten', () => {
    const blobA = blobWithBytes([1], 'application/pdf')
    const blobB = blobWithBytes([2], 'application/pdf')

    async function shownFirstVersion() {
      const { engine, opens } = createControllablePdfEngine()
      const first = createFakePdfDocument({ pages: 30, autoFinish: true })
      const view = render(<Surface engine={engine} blob={blobA} />)
      await waitFor(() => expect(opens).toHaveLength(1))
      await act(async () => opens[0]!.resolve(first))
      await screen.findByRole('group', { name: 'thesis.pdf' })
      return { ...view, engine, opens, first }
    }

    it('keeps the pages on screen until the new version is open, then swaps them and keeps the place', async () => {
      const { rerender, engine, opens, first } = await shownFirstVersion()
      await flush()
      const top = boxesAt(FIT)[9]!.top + 300
      scrollTo(top)

      rerender(<Surface engine={engine} blob={blobB} />)
      await waitFor(() => expect(opens).toHaveLength(2))
      expect(sheetNumbers()).toContain(10) // still the version they were reading
      expect(first.destroy).not.toHaveBeenCalled()

      const taller = pagesOf(30, { width: LETTER.width, height: 1500 })
      const second = createFakePdfDocument({ sizes: taller, autoFinish: true })
      await act(async () => opens[1]!.resolve(second))

      await waitFor(() => expect(first.destroy).toHaveBeenCalledTimes(1))
      const expected = anchoredScrollTop({ before: boxesAt(FIT), after: boxesAt(FIT, taller), scrollTop: top, anchorY: 0 })
      expect(Math.abs(expected - top)).toBeGreaterThan(100)
      expect(scroller().scrollTop).toBeCloseTo(expected, 3)
      await waitFor(() => expect(second.renderPage).toHaveBeenCalled())
    })

    it('copes with a new version that has fewer pages than the reader had scrolled to', async () => {
      const { rerender, engine, opens } = await shownFirstVersion()
      await flush()
      scrollTo(boxesAt(FIT)[24]!.top + 100) // deep in page 25 of 30

      rerender(<Surface engine={engine} blob={blobB} />)
      await waitFor(() => expect(opens).toHaveLength(2))
      await act(async () => opens[1]!.resolve(createFakePdfDocument({ pages: 5, autoFinish: true })))

      await waitFor(() => expect(screen.getByText('/ 5')).toBeInTheDocument())
      // The reader lands on the end of the shorter document, with only its pages mounted.
      expect(sheetNumbers().length).toBeGreaterThan(0)
      expect(Math.max(...sheetNumbers())).toBeLessThanOrEqual(5)
      expect(sheetNumbers()).toContain(5)
    })

    it('keeps the old version and says why when the new one will not open', async () => {
      const { rerender, engine, opens, first } = await shownFirstVersion()

      rerender(<Surface engine={engine} blob={blobB} />) // a half-written PDF
      await waitFor(() => expect(opens).toHaveLength(2))
      await act(async () => opens[1]!.reject(new PdfError('invalid', 'Invalid PDF structure.')))

      expect(await screen.findByRole('status')).toHaveTextContent(
        'Showing the last loaded version — refresh failed: This document could not be displayed.',
      )
      expect(sheets().length).toBeGreaterThan(0)
      expect(first.destroy).not.toHaveBeenCalled()
    })

    it('takes the note away once a good version arrives', async () => {
      const { rerender, engine, opens } = await shownFirstVersion()
      rerender(<Surface engine={engine} blob={blobB} />)
      await waitFor(() => expect(opens).toHaveLength(2))
      await act(async () => opens[1]!.reject(new PdfError('invalid', 'Invalid PDF structure.')))
      await screen.findByRole('status')

      rerender(<Surface engine={engine} blob={blobWithBytes([3], 'application/pdf')} />)
      await waitFor(() => expect(opens).toHaveLength(3))
      await act(async () => opens[2]!.resolve(createFakePdfDocument({ pages: 30, autoFinish: true })))

      await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument())
    })
  })

  describe('when the document cannot be shown', () => {
    const failing = (kind: 'password' | 'invalid' | 'unavailable') =>
      createFakePdfEngine(createFakePdfDocument(), new PdfError(kind, 'nope'))

    it.each([
      ['password', "This PDF is password protected and can't be previewed here."],
      ['invalid', 'This document could not be displayed.'],
      ['unavailable', "The document viewer can't start in this environment."],
    ] as const)('explains a %s failure in words', async (kind, message) => {
      render(<Surface engine={failing(kind)} />)

      expect(await screen.findByText(message)).toBeInTheDocument()
    })

    it.each(['password', 'invalid'] as const)('does not offer to try a %s document again: the same bytes fail the same way', async (kind) => {
      render(<Surface engine={failing(kind)} />)
      await screen.findByRole('button', { name: 'Open in system app' })

      expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument()
    })

    it('offers the system app for every failure', async () => {
      render(<Surface engine={failing('invalid')} />)

      expect(await screen.findByRole('button', { name: 'Open in system app' })).toBeInTheDocument()
    })

    it('has no system app to offer for a path the OS could not resolve', async () => {
      render(<Surface engine={failing('invalid')} absolutePath="docs/thesis.pdf" />)
      await screen.findByText('This document could not be displayed.')

      expect(screen.queryByRole('button', { name: 'Open in system app' })).not.toBeInTheDocument()
    })

    it('lets the reader try again when the engine itself failed to start', async () => {
      const engine = failing('unavailable')
      render(<Surface engine={engine} />)
      fireEvent.click(await screen.findByRole('button', { name: 'Try again' }))

      await waitFor(() => expect(engine.open).toHaveBeenCalledTimes(2))
    })

    describe('a browser that cannot run pdf.js', () => {
      beforeEach(() => {
        vi.stubGlobal('URL', Object.assign(URL, {
          createObjectURL: vi.fn(() => 'blob:thesis'),
          revokeObjectURL: vi.fn(),
        }))
      })

      it('hands the bytes to the browser’s own viewer, and lets go of them later', async () => {
        const open = vi.spyOn(window, 'open').mockReturnValue(null)
        render(<Surface engine={failing('unavailable')} />)
        const button = await screen.findByRole('button', { name: 'Open in browser' })
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })

        fireEvent.click(button)

        expect(URL.createObjectURL).toHaveBeenCalledWith(pdfBlob)
        expect(open).toHaveBeenCalledWith('blob:thesis', '_blank', 'noopener')
        expect(URL.revokeObjectURL).not.toHaveBeenCalled()
        vi.advanceTimersByTime(60_000)
        expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:thesis')
      })

      it('does not offer it in the desktop app, which has no such viewer to hand off to', async () => {
        window.desktopHost = { ...browserHost, isDesktop: true }
        render(<Surface engine={failing('unavailable')} />)
        await screen.findByRole('button', { name: 'Try again' })

        expect(screen.queryByRole('button', { name: 'Open in browser' })).not.toBeInTheDocument()
      })

      it('does not offer it for a document that is simply damaged', async () => {
        render(<Surface engine={failing('invalid')} />)
        await screen.findByText('This document could not be displayed.')

        expect(screen.queryByRole('button', { name: 'Open in browser' })).not.toBeInTheDocument()
      })
    })
  })
})
