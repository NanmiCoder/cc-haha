import '@testing-library/jest-dom/vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useSettingsStore } from '@/stores/settingsStore'
import type { WorkspaceFileView } from '@/stores/workspaceContentStore'
import { blobWithBytes } from '@/test/blobs'
import { createFakeSpreadsheetEngine, gridOf, type FakeSheet } from '@/test/fakeSpreadsheetEngine'
import { SpreadsheetError, type SpreadsheetEngine } from './spreadsheetEngine'
import SpreadsheetSurface from './SpreadsheetSurface'

vi.mock('@/lib/systemFileOpen', () => ({
  openLocalFileWithSystem: vi.fn().mockResolvedValue(undefined),
  reportOpenFailure: vi.fn(),
}))

// The code view has its own suite; here it is the text it was handed and its one action.
vi.mock('../CodeSurface', () => ({
  CodeSurface: ({ value, onAddSelection }: {
    value: string
    onAddSelection: (selection: { startLine: number; endLine: number; text: string }) => void
  }) => (
    <div data-testid="code-surface">
      {value}
      <button type="button" onClick={() => onAddSelection({ startLine: 1, endLine: 1, text: 'Item,Cost' })}>
        add selection
      </button>
    </div>
  ),
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
  if (originalClientWidth) Object.defineProperty(HTMLElement.prototype, 'clientWidth', originalClientWidth)
  if (originalClientHeight) Object.defineProperty(HTMLElement.prototype, 'clientHeight', originalClientHeight)
})

// ---- the surface under test ----

const xlsxBlob = blobWithBytes([80, 75, 3, 4], 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')

const BUDGET: FakeSheet = { name: 'Budget', grid: gridOf([['Item', 'Cost'], ['Rent', 1200], ['Food', 340]]) }
const NOTES: FakeSheet = { name: 'Notes', grid: gridOf([['Remember'], ['the milk']]) }
const SCRATCH: FakeSheet = { name: 'Scratch', grid: gridOf([['x']]), hidden: true }
const WORKBOOK = [BUDGET, NOTES, SCRATCH]

type SurfaceProps = {
  engine: SpreadsheetEngine
  blob?: Blob
  sheet?: string
  onSheetChange?: (sheet: string) => void
  initialView?: WorkspaceFileView
  absolutePath?: string
}

/** Holds the worksheet the way the workspace store does: chosen here, handed back down. */
function Surface({ engine, blob = xlsxBlob, sheet: initialSheet, onSheetChange, initialView, absolutePath = '/work/data/budget.xlsx' }: SurfaceProps) {
  const [sheet, setSheet] = useState(initialSheet)
  return (
    <SpreadsheetSurface
      engine={engine}
      blob={blob}
      path="data/budget.xlsx"
      absolutePath={absolutePath}
      version="1"
      refreshing={false}
      zoom={undefined}
      onZoomChange={() => undefined}
      sheet={sheet}
      onSheetChange={(next) => {
        setSheet(next)
        onSheetChange?.(next)
      }}
      initialView={initialView}
    />
  )
}

/** The scroll area, whatever it is called or covered by at the moment. */
const scroller = () => document.querySelector<HTMLElement>('[data-workspace-scroll-surface]')!
const tab = (name: string) => screen.getByRole('tab', { name })
const tabNames = () => screen.queryAllByRole('tab').map((node) => node.textContent)

/** The surface with a workbook that opens and reads at once, once it has drawn what it opened. */
async function shown(props: Partial<Omit<SurfaceProps, 'engine'>> & { sheets?: FakeSheet[] } = {}) {
  const { sheets = WORKBOOK, ...surfaceProps } = props
  const fake = createFakeSpreadsheetEngine({ sheets, autoFinish: true })
  const view = render(<Surface {...surfaceProps} engine={fake.engine} />)
  await waitFor(() => expect(screen.queryByText('Loading document...')).not.toBeInTheDocument())
  return { ...view, ...fake }
}

function scrollTo(top: number, left = 0) {
  scroller().scrollTop = top
  scroller().scrollLeft = left
  fireEvent.scroll(scroller())
}

describe('SpreadsheetSurface', () => {
  describe('opening a workbook', () => {
    it('says it is loading until the workbook is open and its first sheet read', async () => {
      const { engine, opens, reads } = createFakeSpreadsheetEngine({ sheets: WORKBOOK })
      render(<Surface engine={engine} />)
      await waitFor(() => expect(opens).toHaveLength(1))

      expect(screen.getByRole('status')).toHaveTextContent('Loading document...')
      expect(screen.queryByRole('tablist')).not.toBeInTheDocument()

      await act(async () => opens[0]!.finish())
      await waitFor(() => expect(reads).toHaveLength(1))
      // The tabs are there as soon as the workbook is open; the sheet under them is still on its way.
      expect(screen.getByRole('tablist', { name: 'Worksheets' })).toBeInTheDocument()
      expect(screen.getByRole('status')).toHaveTextContent('Loading document...')

      await act(async () => reads[0]!.finish())
      await screen.findByRole('cell', { name: 'Rent' })
      expect(screen.queryByText('Loading document...')).not.toBeInTheDocument()
    })

    it('hands the engine the bytes of the file', async () => {
      const { opens } = await shown()

      expect(Array.from(opens[0]!.bytes)).toEqual([80, 75, 3, 4])
    })

    it('opens a workbook once, and reads only the sheet on screen', async () => {
      const { engine, reads } = await shown()

      expect(engine.open).toHaveBeenCalledTimes(1)
      expect(reads.map((read) => read.index)).toEqual([0])
    })

    it('shows a tab for each sheet the workbook shows, and none for a hidden one', async () => {
      await shown()

      expect(tabNames()).toEqual(['Budget', 'Notes'])
      expect(tab('Budget')).toHaveAttribute('aria-selected', 'true')
      expect(tab('Notes')).toHaveAttribute('aria-selected', 'false')
    })

    it('names the sheet panel after its sheet', async () => {
      await shown()

      expect(screen.getByRole('tabpanel', { name: 'Budget' })).toBe(scroller())
    })

    it('leaves the scroll position to the sheet, which is not there when the panel mounts', async () => {
      await shown()

      expect(scroller()).toHaveAttribute('data-workspace-scroll-surface', 'deferred')
    })

    it('says what the preview leaves out', async () => {
      await shown()

      expect(screen.getByText("Shows each cell as formatted text. Charts, images and formulas aren't shown.")).toBeInTheDocument()
    })

    it('offers the system app for a file that has a place on disk, and only for that', async () => {
      const { unmount } = await shown()
      expect(screen.getByRole('button', { name: 'Open in system app' })).toBeInTheDocument()
      unmount()

      await shown({ absolutePath: 'budget.xlsx' })
      expect(screen.queryByRole('button', { name: 'Open in system app' })).not.toBeInTheDocument()
    })
  })

  describe('what a cell holds', () => {
    it('is drawn as text, however much it looks like markup or a formula', async () => {
      const hostile = '<img src=x onerror="window.__surfacePwned = 1">'
      await shown({ sheets: [{ name: 'Data', grid: gridOf([[hostile], ['=HYPERLINK("https://evil.example","x")'], ['<script>window.__surfacePwned = 1</script>']]) }] })

      expect(screen.getByText(hostile)).toBeInTheDocument()
      expect(scroller().querySelector('img, script, a, iframe')).toBeNull()
      expect((window as unknown as { __surfacePwned?: number }).__surfacePwned).toBeUndefined()
    })

    it('is drawn under the name of its sheet, even when that is markup too', async () => {
      const name = '<b>Q1</b>'
      await shown({ sheets: [{ name, grid: gridOf([['x']]) }] })

      expect(screen.getByRole('tab', { name })).toBeInTheDocument()
      expect(document.querySelector('[role="tablist"] b')).toBeNull()
    })
  })

  describe('worksheets', () => {
    it('opens on the sheet the reader was on last time', async () => {
      const { reads } = await shown({ sheet: 'Notes' })

      expect(tab('Notes')).toHaveAttribute('aria-selected', 'true')
      expect(screen.getByRole('cell', { name: 'the milk' })).toBeInTheDocument()
      expect(reads.map((read) => read.index)).toEqual([1])
    })

    it.each([
      ['one that is hidden', 'Scratch'],
      ['one the workbook no longer has', 'Gone'],
    ])('opens on the first sheet when the remembered one is %s', async (_, remembered) => {
      await shown({ sheet: remembered })

      expect(tab('Budget')).toHaveAttribute('aria-selected', 'true')
      expect(screen.getByRole('cell', { name: 'Rent' })).toBeInTheDocument()
    })

    it('reports the tab the reader picks, and shows that sheet', async () => {
      const onSheetChange = vi.fn()
      await shown({ onSheetChange })

      fireEvent.click(tab('Notes'))

      expect(onSheetChange).toHaveBeenCalledExactlyOnceWith('Notes')
      expect(await screen.findByRole('cell', { name: 'the milk' })).toBeInTheDocument()
      expect(screen.queryByRole('cell', { name: 'Rent' })).not.toBeInTheDocument()
      expect(tab('Notes')).toHaveAttribute('aria-selected', 'true')
    })

    it('keeps the sheet on show until the next one is read, and says the panel is busy', async () => {
      const { engine, opens, reads } = createFakeSpreadsheetEngine({ sheets: WORKBOOK })
      render(<Surface engine={engine} />)
      await waitFor(() => expect(opens).toHaveLength(1))
      await act(async () => opens[0]!.finish())
      await waitFor(() => expect(reads).toHaveLength(1))
      await act(async () => reads[0]!.finish())
      await screen.findByRole('cell', { name: 'Rent' })

      fireEvent.click(tab('Notes'))
      await waitFor(() => expect(reads).toHaveLength(2))

      // The reader is not shown a blank page while a sheet of any size is read.
      expect(screen.getByRole('cell', { name: 'Rent' })).toBeInTheDocument()
      expect(scroller()).toHaveAttribute('aria-busy', 'true')
      expect(screen.queryByText('Loading document...')).not.toBeInTheDocument()

      await act(async () => reads[1]!.finish())
      await screen.findByRole('cell', { name: 'the milk' })
      expect(screen.queryByRole('cell', { name: 'Rent' })).not.toBeInTheDocument()
      expect(scroller()).toHaveAttribute('aria-busy', 'false')
    })

    it('goes back to a sheet it has read without reading it again', async () => {
      const { reads } = await shown()

      fireEvent.click(tab('Notes'))
      await screen.findByRole('cell', { name: 'the milk' })
      fireEvent.click(tab('Budget'))
      await screen.findByRole('cell', { name: 'Rent' })

      expect(reads.map((read) => read.index)).toEqual([0, 1])
    })

    it('moves between tabs with the arrow keys', async () => {
      const onSheetChange = vi.fn()
      await shown({ onSheetChange })

      tab('Budget').focus()
      fireEvent.keyDown(tab('Budget'), { key: 'ArrowRight' })

      expect(onSheetChange).toHaveBeenCalledWith('Notes')
      expect(await screen.findByRole('cell', { name: 'the milk' })).toBeInTheDocument()
    })

    it('shows the one tab of a one-sheet workbook, which is how the reader learns the sheet\'s name', async () => {
      await shown({ sheets: [BUDGET] })

      expect(tabNames()).toEqual(['Budget'])
    })

    it('says so when the workbook has a sheet, but nothing in it', async () => {
      await shown({ sheets: [{ name: 'Blank', grid: gridOf([]) }] })

      expect(screen.getByText('This worksheet is empty.')).toBeInTheDocument()
      expect(tab('Blank')).toBeInTheDocument()
    })

    it('says so when the workbook has no sheet to show', async () => {
      await shown({ sheets: [SCRATCH] })

      expect(screen.getByText('This worksheet is empty.')).toBeInTheDocument()
      expect(screen.queryByRole('tablist')).not.toBeInTheDocument()
    })
  })

  describe('when the workbook cannot be shown', () => {
    async function failing(error: unknown) {
      const fake = createFakeSpreadsheetEngine({ sheets: WORKBOOK })
      render(<Surface engine={fake.engine} />)
      await waitFor(() => expect(fake.opens).toHaveLength(1))
      await act(async () => fake.opens[0]!.fail(error))
      return fake
    }

    it.each([
      ['a file that is not a workbook', new SpreadsheetError('invalid', 'Not a spreadsheet file'), 'This document could not be displayed.'],
      ['an archive too large to inflate safely', new SpreadsheetError('tooComplex', 'too big'), 'This file is too large or too complex to preview safely.'],
      ['the engine failing to load', new SpreadsheetError('unavailable', 'chunk failed'), "The document viewer can't start in this environment."],
      ['anything else that goes wrong', new Error('boom'), 'This document could not be displayed.'],
    ])('explains %s', async (_, error, message) => {
      await failing(error)

      expect(await screen.findByRole('alert')).toHaveTextContent(message)
      expect(screen.queryByRole('tablist')).not.toBeInTheDocument()
    })

    it('offers the system app as the way out', async () => {
      await failing(new SpreadsheetError('invalid', 'bad'))

      expect(await screen.findByRole('button', { name: 'Open in system app' })).toBeInTheDocument()
    })

    it.each(['invalid', 'tooComplex'] as const)('offers no retry for %s, which the same bytes would fail again', async (kind) => {
      await failing(new SpreadsheetError(kind, 'bad'))

      await screen.findByRole('alert')
      expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument()
    })

    it('offers a retry when the engine could not load, and opens the workbook again when it is used', async () => {
      const fake = await failing(new SpreadsheetError('unavailable', 'chunk failed'))

      fireEvent.click(await screen.findByRole('button', { name: 'Try again' }))
      await waitFor(() => expect(fake.opens).toHaveLength(2))
      await act(async () => fake.opens[1]!.finish())
      await waitFor(() => expect(fake.reads).toHaveLength(1))
      await act(async () => fake.reads[0]!.finish())

      expect(await screen.findByRole('cell', { name: 'Rent' })).toBeInTheDocument()
      expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    })
  })

  describe('when one sheet cannot be read', () => {
    async function opened() {
      const fake = createFakeSpreadsheetEngine({ sheets: WORKBOOK })
      render(<Surface engine={fake.engine} />)
      await waitFor(() => expect(fake.opens).toHaveLength(1))
      await act(async () => fake.opens[0]!.finish())
      await waitFor(() => expect(fake.reads).toHaveLength(1))
      return fake
    }

    it('says so under tabs that still work, and another sheet can still be opened', async () => {
      const fake = await opened()
      await act(async () => fake.reads[0]!.fail(new SpreadsheetError('invalid', 'bad sheet')))

      expect(await screen.findByRole('alert')).toHaveTextContent('This document could not be displayed.')
      expect(tabNames()).toEqual(['Budget', 'Notes'])

      fireEvent.click(tab('Notes'))
      await waitFor(() => expect(fake.reads).toHaveLength(2))
      await act(async () => fake.reads[1]!.finish())

      expect(await screen.findByRole('cell', { name: 'the milk' })).toBeInTheDocument()
      expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    })

    it('covers the sheet that was on show with the failure, and uncovers it on going back', async () => {
      const fake = await opened()
      await act(async () => fake.reads[0]!.finish())
      await screen.findByRole('cell', { name: 'Rent' })

      fireEvent.click(tab('Notes'))
      await waitFor(() => expect(fake.reads).toHaveLength(2))
      await act(async () => fake.reads[1]!.fail(new SpreadsheetError('invalid', 'bad sheet')))

      expect(await screen.findByRole('alert')).toBeInTheDocument()
      // Behind the message, out of reach of a screen reader and the keyboard.
      expect(scroller()).toHaveAttribute('aria-hidden', 'true')
      expect(scroller()).toHaveAttribute('tabindex', '-1')

      fireEvent.click(tab('Budget'))

      await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument())
      expect(scroller()).not.toHaveAttribute('aria-hidden')
      expect(screen.getByRole('cell', { name: 'Rent' })).toBeInTheDocument()
    })
  })

  describe('when the file is rewritten', () => {
    const blobA = blobWithBytes([1], 'application/octet-stream')
    const blobB = blobWithBytes([2], 'application/octet-stream')

    async function firstVersion(sheets = WORKBOOK) {
      const fake = createFakeSpreadsheetEngine({ sheets })
      const view = render(<Surface engine={fake.engine} blob={blobA} />)
      await waitFor(() => expect(fake.opens).toHaveLength(1))
      await act(async () => fake.opens[0]!.finish())
      await waitFor(() => expect(fake.reads).toHaveLength(1))
      await act(async () => fake.reads[0]!.finish())
      await screen.findByRole('cell', { name: 'Rent' })
      return { ...view, ...fake }
    }

    it('keeps the version on show while the next one opens, without a word about loading', async () => {
      const { rerender, engine, opens } = await firstVersion()

      rerender(<Surface engine={engine} blob={blobB} />)
      await waitFor(() => expect(opens).toHaveLength(2))

      expect(screen.getByRole('cell', { name: 'Rent' })).toBeInTheDocument()
      expect(screen.queryByText('Loading document...')).not.toBeInTheDocument()
      expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    })

    it('swaps in the new version when its sheet is read', async () => {
      const { rerender, engine, opens, reads, setSheets } = await firstVersion()
      setSheets([{ name: 'Budget', grid: gridOf([['Item', 'Cost'], ['Rent', 1300]]) }, NOTES])

      rerender(<Surface engine={engine} blob={blobB} />)
      await waitFor(() => expect(opens).toHaveLength(2))
      await act(async () => opens[1]!.finish())
      await waitFor(() => expect(reads).toHaveLength(2))
      // Read, but not yet arrived: still the old one.
      expect(screen.getByRole('cell', { name: '1200' })).toBeInTheDocument()
      await act(async () => reads[1]!.finish())

      expect(await screen.findByRole('cell', { name: '1300' })).toBeInTheDocument()
      expect(screen.queryByRole('cell', { name: '1200' })).not.toBeInTheDocument()
    })

    it('leaves the reader where they were on the sheet', async () => {
      const { rerender, engine, opens, reads, setSheets } = await firstVersion()
      scrollTo(250, 20)
      setSheets([{ name: 'Budget', grid: gridOf([['Item', 'Cost'], ['Rent', 1300]]) }, NOTES])

      rerender(<Surface engine={engine} blob={blobB} />)
      await waitFor(() => expect(opens).toHaveLength(2))
      await act(async () => opens[1]!.finish())
      await waitFor(() => expect(reads).toHaveLength(2))
      await act(async () => reads[1]!.finish())
      // Only once the new version is what is on screen does the position mean anything.
      await screen.findByRole('cell', { name: '1300' })

      expect(scroller().scrollTop).toBe(250)
      expect(scroller().scrollLeft).toBe(20)
    })

    it.each([
      ['the reader has not picked a tab', undefined],
      ['the reader picked it', 'Budget'],
    ])('stays on the same sheet when one is added in front of it, and %s', async (_, picked) => {
      const fake = createFakeSpreadsheetEngine({ sheets: WORKBOOK })
      const { rerender } = render(<Surface engine={fake.engine} blob={blobA} sheet={picked} />)
      await waitFor(() => expect(fake.opens).toHaveLength(1))
      await act(async () => fake.opens[0]!.finish())
      await waitFor(() => expect(fake.reads).toHaveLength(1))
      await act(async () => fake.reads[0]!.finish())
      await screen.findByRole('cell', { name: 'Rent' })
      fake.setSheets([{ name: 'New', grid: gridOf([['brand new']]) }, BUDGET, NOTES])

      rerender(<Surface engine={fake.engine} blob={blobB} sheet={picked} />)
      await waitFor(() => expect(fake.opens).toHaveLength(2))
      await act(async () => fake.opens[1]!.finish())
      await waitFor(() => expect(fake.reads).toHaveLength(2))
      // It is the sheet called Budget that is read, now the second in the workbook.
      expect(fake.reads[1]!.index).toBe(1)
      await act(async () => fake.reads[1]!.finish())

      await waitFor(() => expect(tabNames()).toEqual(['New', 'Budget', 'Notes']))
      expect(tab('Budget')).toHaveAttribute('aria-selected', 'true')
      expect(screen.getByRole('cell', { name: 'Rent' })).toBeInTheDocument()
      expect(screen.queryByRole('cell', { name: 'brand new' })).not.toBeInTheDocument()
    })

    it('goes to the first sheet when the one on show was taken out', async () => {
      const { rerender, engine, opens, reads, setSheets } = await firstVersion()
      setSheets([NOTES])

      rerender(<Surface engine={engine} blob={blobB} />)
      await waitFor(() => expect(opens).toHaveLength(2))
      await act(async () => opens[1]!.finish())
      await waitFor(() => expect(reads).toHaveLength(2))
      await act(async () => reads[1]!.finish())

      expect(await screen.findByRole('cell', { name: 'the milk' })).toBeInTheDocument()
      expect(tabNames()).toEqual(['Notes'])
    })

    it('keeps the last good version, and says why, when the new one will not open', async () => {
      const { rerender, engine, opens } = await firstVersion()

      rerender(<Surface engine={engine} blob={blobB} />)
      await waitFor(() => expect(opens).toHaveLength(2))
      await act(async () => opens[1]!.fail(new SpreadsheetError('invalid', 'unzip failed: incomplete file')))

      // The agent was mid-write. The reader's page survives it.
      expect(screen.getByRole('cell', { name: 'Rent' })).toBeInTheDocument()
      expect(await screen.findByRole('status')).toHaveTextContent('Showing the last loaded version — refresh failed: This document could not be displayed.')
      expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    })

    it('keeps the last good version when the new one opens but its sheet will not read', async () => {
      const { rerender, engine, opens, reads } = await firstVersion()

      rerender(<Surface engine={engine} blob={blobB} />)
      await waitFor(() => expect(opens).toHaveLength(2))
      await act(async () => opens[1]!.finish())
      await waitFor(() => expect(reads).toHaveLength(2))
      await act(async () => reads[1]!.fail(new SpreadsheetError('invalid', 'half a sheet')))

      expect(screen.getByRole('cell', { name: 'Rent' })).toBeInTheDocument()
      expect(await screen.findByRole('status')).toHaveTextContent('refresh failed')
      expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    })

    it('forgets the failure once a version opens', async () => {
      const { rerender, engine, opens, reads } = await firstVersion()
      rerender(<Surface engine={engine} blob={blobB} />)
      await waitFor(() => expect(opens).toHaveLength(2))
      await act(async () => opens[1]!.fail(new SpreadsheetError('invalid', 'half a file')))
      await screen.findByRole('status')

      rerender(<Surface engine={engine} blob={xlsxBlob} />)
      await waitFor(() => expect(opens).toHaveLength(3))
      await act(async () => opens[2]!.finish())
      await waitFor(() => expect(reads).toHaveLength(2))
      await act(async () => reads[1]!.finish())

      await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument())
    })
  })

  describe('scroll position', () => {
    it('restores where the reader left the file', async () => {
      await shown({ initialView: { scrollTop: 400, scrollLeft: 30 } })

      expect(scroller().scrollTop).toBe(400)
      expect(scroller().scrollLeft).toBe(30)
    })

    it('remembers where the reader was on each sheet, while the file stays open', async () => {
      await shown()
      scrollTo(300, 10)

      fireEvent.click(tab('Notes'))
      await screen.findByRole('cell', { name: 'the milk' })
      // A sheet not visited before starts at its corner.
      expect(scroller().scrollTop).toBe(0)
      expect(scroller().scrollLeft).toBe(0)
      scrollTo(50, 0)

      fireEvent.click(tab('Budget'))
      await screen.findByRole('cell', { name: 'Rent' })
      expect(scroller().scrollTop).toBe(300)
      expect(scroller().scrollLeft).toBe(10)

      fireEvent.click(tab('Notes'))
      await screen.findByRole('cell', { name: 'the milk' })
      expect(scroller().scrollTop).toBe(50)
    })

    it('puts the reader back after the panel was hidden and shown again', async () => {
      await shown()
      scrollTo(123, 45)

      resizePanel(0, 0) // a hidden panel has no size
      scroller().scrollTop = 0 // and the browser forgets where it was scrolled to
      scroller().scrollLeft = 0
      resizePanel(700, 800)

      expect(scroller().scrollTop).toBe(123)
      expect(scroller().scrollLeft).toBe(45)
    })

    it('does not move the reader for a resize', async () => {
      await shown()
      scrollTo(123)

      resizePanel(500, 600)

      expect(scroller().scrollTop).toBe(123)
    })
  })
})

describe('SpreadsheetSurface with a delimited text file', () => {
  const csvBlob = blobWithBytes(new TextEncoder().encode('Item,Cost\nRent,1200\n'), 'text/csv')
  const sourceActions = () => ({
    onAddLineComment: vi.fn(),
    onAddSelection: vi.fn(),
  })

  function renderCsv({ path = 'data/budget.csv', reveal }: { path?: string; reveal?: { line: number; nonce: number } } = {}) {
    const fake = createFakeSpreadsheetEngine({ sheets: [BUDGET], autoFinish: true })
    const actions = sourceActions()
    render(
      <SpreadsheetSurface
        engine={fake.engine}
        blob={csvBlob}
        path={path}
        absolutePath={`/work/${path}`}
        version="1"
        refreshing={false}
        zoom={undefined}
        onZoomChange={() => undefined}
        initialView={undefined}
        source={{ ...actions, reveal }}
      />,
    )
    return { ...fake, ...actions }
  }

  it('opens the bytes as delimited text, named by the extension and nothing else', async () => {
    const { engine } = renderCsv({ path: 'data/budget.tsv' })

    await waitFor(() => expect(engine.open).toHaveBeenCalled())
    expect(engine.open.mock.calls[0]![1]).toEqual({ delimited: 'tsv' })
  })

  it('does not name a workbook as delimited text', async () => {
    const fake = createFakeSpreadsheetEngine({ sheets: WORKBOOK, autoFinish: true })
    render(<Surface engine={fake.engine} />)

    await waitFor(() => expect(fake.engine.open).toHaveBeenCalled())
    expect(fake.engine.open.mock.calls[0]![1]).toBeUndefined()
  })

  it('shows the table with no sheet tabs, and a note that says what it is', async () => {
    renderCsv()

    expect(await screen.findByRole('cell', { name: 'Rent' })).toBeInTheDocument()
    expect(screen.queryAllByRole('tab')).toEqual([])
    expect(screen.getByText(/every value as written/)).toBeInTheDocument()
  })

  it('goes to the source and back, and the table is still there', async () => {
    renderCsv()
    await screen.findByRole('cell', { name: 'Rent' })

    fireEvent.click(screen.getByRole('radio', { name: 'Source' }))

    expect(await screen.findByTestId('code-surface')).toHaveTextContent('Item,Cost')
    expect(screen.queryByText(/every value as written/)).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('radio', { name: 'Table' }))

    expect(screen.queryByTestId('code-surface')).not.toBeInTheDocument()
    expect(screen.getByRole('cell', { name: 'Rent' })).toBeInTheDocument()
  })

  it('hands the source view the actions the panel gave it', async () => {
    const { onAddSelection } = renderCsv()
    await screen.findByRole('cell', { name: 'Rent' })
    fireEvent.click(screen.getByRole('radio', { name: 'Source' }))
    await screen.findByTestId('code-surface')

    fireEvent.click(screen.getByRole('button', { name: 'add selection' }))

    expect(onAddSelection).toHaveBeenCalledWith({ startLine: 1, endLine: 1, text: 'Item,Cost' })
  })

  it('opens on the source when a line of the file was asked for', async () => {
    renderCsv({ reveal: { line: 2, nonce: 1 } })

    expect(await screen.findByTestId('code-surface')).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: 'Source' })).toBeChecked()
  })

  it('offers no way to the source for a workbook, which has none', async () => {
    const fake = createFakeSpreadsheetEngine({ sheets: WORKBOOK, autoFinish: true })
    render(<Surface engine={fake.engine} />)
    await screen.findByRole('cell', { name: 'Rent' })

    expect(screen.queryByRole('radio', { name: 'Source' })).not.toBeInTheDocument()
  })
})
