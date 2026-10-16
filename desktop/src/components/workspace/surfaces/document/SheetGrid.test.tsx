import '@testing-library/jest-dom/vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useSettingsStore } from '@/stores/settingsStore'
import { gridOf } from '@/test/fakeSpreadsheetEngine'
import { SheetGrid, columnLabel, mergeCoverage } from './SheetGrid'

beforeEach(() => {
  useSettingsStore.setState({ locale: 'en' })
})

const table = () => screen.getByRole('table')
const cells = () => within(table()).queryAllByRole('cell')
const rowHeaders = () => within(table()).queryAllByRole('rowheader').map((node) => node.textContent)
const columnHeaders = () => within(table()).queryAllByRole('columnheader').map((node) => node.textContent)
const cellsText = () => cells().map((node) => node.textContent)

describe('columnLabel', () => {
  it.each([
    [0, 'A'],
    [1, 'B'],
    [25, 'Z'],
    [26, 'AA'],
    [27, 'AB'],
    [51, 'AZ'],
    [52, 'BA'],
    [701, 'ZZ'],
    [702, 'AAA'],
  ])('names column %i as %s, as a spreadsheet does', (index, label) => {
    expect(columnLabel(index)).toBe(label)
  })
})

describe('SheetGrid', () => {
  describe('the grid', () => {
    it('is a table named for the sheet, with its full size for a screen reader', () => {
      render(<SheetGrid grid={gridOf([['a', 'b'], ['c', 'd'], ['e', 'f']])} label="Budget" />)

      expect(screen.getByRole('table', { name: 'Budget' })).toHaveAttribute('aria-rowcount', '3')
      expect(table()).toHaveAttribute('aria-colcount', '2')
    })

    it('numbers the rows and letters the columns', () => {
      render(<SheetGrid grid={gridOf([['a', 'b', 'c'], ['d', 'e', 'f']])} label="Budget" />)

      expect(rowHeaders()).toEqual(['1', '2'])
      expect(columnHeaders()).toEqual(['A', 'B', 'C'])
    })

    it('draws every cell, the empty ones included, so the grid lines run all the way across', () => {
      render(<SheetGrid grid={gridOf([['a', undefined, 'c'], [undefined, 'e', undefined]])} label="Budget" />)

      expect(cellsText()).toEqual(['a', '', 'c', '', 'e', ''])
    })

    it('puts numbers to the right, as a spreadsheet does, and text to the left', () => {
      render(<SheetGrid grid={gridOf([['Rent', 1200]])} label="Budget" />)

      expect(screen.getByRole('cell', { name: 'Rent' })).toHaveClass('text-left')
      expect(screen.getByRole('cell', { name: '1200' })).toHaveClass('text-right')
    })

    it('draws what a cell holds as text, and never as markup', () => {
      const hostile = '<img src=x onerror="window.__sheetPwned = 1">'
      const link = '=HYPERLINK("https://evil.example","click")'
      render(<SheetGrid grid={gridOf([[hostile, link, '<script>window.__sheetPwned = 1</script>']])} label="Budget" />)

      expect(screen.getByText(hostile)).toBeInTheDocument()
      expect(screen.getByText(link)).toBeInTheDocument()
      expect(table().querySelector('img, script, a, iframe, style, object, embed')).toBeNull()
      expect((window as unknown as { __sheetPwned?: number }).__sheetPwned).toBeUndefined()
    })

    it('shows a long cell in full as a tooltip, and leaves a short one without', () => {
      const long = 'A sentence long enough that the cell has to cut it short'
      render(<SheetGrid grid={gridOf([[long, 'short']])} label="Budget" />)

      expect(screen.getByRole('cell', { name: long })).toHaveAttribute('title', long)
      expect(screen.getByRole('cell', { name: 'short' })).not.toHaveAttribute('title')
    })
  })

  describe('sizes', () => {
    it('gives the row headings a track of their own, then a track of the sheet\'s width per column', () => {
      render(<SheetGrid grid={gridOf([['a', 'b']], { columnWidths: [100, 150] })} label="Budget" />)

      expect(table().style.gridTemplateColumns).toBe('44px 100px 150px')
    })

    it('sets a row to the height the sheet gives it, and lets the rest fit their text', () => {
      render(<SheetGrid grid={gridOf([['a'], ['b']], { rowHeights: [40, undefined] })} label="Budget" />)

      expect(table().style.gridTemplateRows).toBe('24px 40px minmax(22px, auto)')
    })

    it('draws a hidden column and a hidden row as tracks of no size with nothing in them', () => {
      render(
        <SheetGrid
          grid={gridOf([['a', 'b', 'c'], ['d', 'e', 'f']], { columnWidths: [72, 0, 72], rowHeights: [undefined, 0] })}
          label="Budget"
        />,
      )

      expect(columnHeaders()).toEqual(['A', 'C'])
      expect(rowHeaders()).toEqual(['1'])
      expect(cellsText()).toEqual(['a', 'c'])
      expect(table().style.gridTemplateColumns).toBe('44px 72px 0px 72px')
      expect(table().style.gridTemplateRows).toBe('24px minmax(22px, auto) 0px')
    })

    it('places every cell by its own row and column, so a hidden neighbour does not shift it', () => {
      render(
        <SheetGrid
          grid={gridOf([['a', 'b', 'c']], { columnWidths: [72, 0, 72] })}
          label="Budget"
        />,
      )

      // Row 1 is grid row 2 (the headings are row 1); column C is grid column 4 (the row headings are column 1).
      expect(screen.getByRole('cell', { name: 'c' }).style.gridColumn).toBe('4')
      expect(screen.getByRole('cell', { name: 'c' }).style.gridRow).toBe('2')
    })
  })

  describe('merged cells', () => {
    it('lets the first cell span, and draws none of the cells it covers', () => {
      render(
        <SheetGrid
          grid={gridOf([['Title', 'x', undefined], ['a', 'b', 'c']], {
            merges: [{ row: 0, column: 0, rowSpan: 1, columnSpan: 2 }],
          })}
          label="Budget"
        />,
      )

      expect(cellsText()).toEqual(['Title', '', 'a', 'b', 'c'])
      const title = screen.getByRole('cell', { name: 'Title' })
      expect(title.style.gridColumn).toBe('2 / span 2')
      expect(title.style.gridRow).toBe('2 / span 1')
    })

    it('spans rows as well as columns', () => {
      render(
        <SheetGrid
          grid={gridOf([['Tall', 'x'], [undefined, 'y'], [undefined, 'z']], {
            merges: [{ row: 0, column: 0, rowSpan: 3, columnSpan: 1 }],
          })}
          label="Budget"
        />,
      )

      expect(screen.getByRole('cell', { name: 'Tall' }).style.gridRow).toBe('2 / span 3')
      expect(cellsText()).toEqual(['Tall', 'x', 'y', 'z'])
    })
  })

  describe('a sheet longer than one draw', () => {
    // Three columns and a budget of nine cells: three rows at a time.
    const tall = gridOf(Array.from({ length: 10 }, (_, row) => [`r${row}a`, `r${row}b`, `r${row}c`]))

    it('draws as many rows as fit the budget and offers the rest', () => {
      render(<SheetGrid grid={tall} label="Budget" cellBudget={9} />)

      expect(rowHeaders()).toEqual(['1', '2', '3'])
      expect(cells()).toHaveLength(9)
      expect(screen.getByRole('button', { name: 'Show more rows' })).toBeInTheDocument()
    })

    it('draws the next rows when asked, until the sheet runs out, then stops offering', () => {
      render(<SheetGrid grid={tall} label="Budget" cellBudget={9} />)

      fireEvent.click(screen.getByRole('button', { name: 'Show more rows' }))
      expect(rowHeaders()).toEqual(['1', '2', '3', '4', '5', '6'])
      fireEvent.click(screen.getByRole('button', { name: 'Show more rows' }))
      expect(rowHeaders()).toHaveLength(9)
      fireEvent.click(screen.getByRole('button', { name: 'Show more rows' }))

      expect(rowHeaders()).toHaveLength(10)
      expect(cells()).toHaveLength(30)
      expect(screen.queryByRole('button', { name: 'Show more rows' })).not.toBeInTheDocument()
    })

    it('still says how many rows the sheet has, the ones not drawn included', () => {
      render(<SheetGrid grid={tall} label="Budget" cellBudget={9} />)

      expect(table()).toHaveAttribute('aria-rowcount', '10')
    })

    it('budgets by cells, not rows: a wide sheet gets fewer rows a draw', () => {
      const wide = gridOf(Array.from({ length: 10 }, (_, row) => Array.from({ length: 6 }, (_, column) => `${row}:${column}`)))
      render(<SheetGrid grid={wide} label="Budget" cellBudget={12} />)

      expect(rowHeaders()).toEqual(['1', '2'])
    })

    it('always draws at least one row, however wide the sheet', () => {
      const wide = gridOf([Array.from({ length: 6 }, (_, column) => `c${column}`), ['x']])
      render(<SheetGrid grid={wide} label="Budget" cellBudget={2} />)

      expect(rowHeaders()).toEqual(['1'])
    })

    it('keeps the rows the reader asked for when a newer version of the sheet arrives', () => {
      const { rerender } = render(<SheetGrid grid={tall} label="Budget" cellBudget={9} />)
      fireEvent.click(screen.getByRole('button', { name: 'Show more rows' }))
      expect(rowHeaders()).toHaveLength(6)

      rerender(<SheetGrid grid={gridOf(Array.from({ length: 10 }, (_, row) => [`new${row}`, 'b', 'c']))} label="Budget" cellBudget={9} />)

      expect(rowHeaders()).toHaveLength(6)
      expect(screen.getByRole('cell', { name: 'new5' })).toBeInTheDocument()
    })

    it('cuts a merge at the last row drawn, and lets it out again when the rest is', () => {
      const merged = gridOf(Array.from({ length: 6 }, (_, row) => [`r${row}`, 'b', 'c']), {
        merges: [{ row: 1, column: 0, rowSpan: 4, columnSpan: 1 }],
      })
      render(<SheetGrid grid={merged} label="Budget" cellBudget={6} />)

      // Two rows drawn: the merge starts on the second and can take only that one.
      expect(screen.getByRole('cell', { name: 'r1' }).style.gridRow).toBe('3 / span 1')

      fireEvent.click(screen.getByRole('button', { name: 'Show more rows' }))
      expect(rowHeaders()).toHaveLength(4)
      expect(screen.getByRole('cell', { name: 'r1' }).style.gridRow).toBe('3 / span 3')

      fireEvent.click(screen.getByRole('button', { name: 'Show more rows' }))
      expect(rowHeaders()).toHaveLength(6)
      expect(screen.getByRole('cell', { name: 'r1' }).style.gridRow).toBe('3 / span 4')
    })
  })

  describe('a sheet that was cut short', () => {
    it('says how much of it is here', () => {
      render(<SheetGrid grid={gridOf([['a', 'b'], ['c', 'd']], { truncatedRows: true })} label="Budget" />)

      expect(screen.getByText('Showing the first 2 rows and 2 columns.')).toBeInTheDocument()
    })

    it('says so for columns cut as well', () => {
      render(<SheetGrid grid={gridOf([['a', 'b']], { truncatedColumns: true })} label="Budget" />)

      expect(screen.getByText('Showing the first 1 rows and 2 columns.')).toBeInTheDocument()
    })

    it('says nothing about a sheet that is all here', () => {
      render(<SheetGrid grid={gridOf([['a', 'b']])} label="Budget" />)

      expect(screen.queryByText(/Showing the first/)).not.toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'Show more rows' })).not.toBeInTheDocument()
    })
  })
})

describe('mergeCoverage', () => {
  const merge = (row: number, column: number, rowSpan: number, columnSpan: number) => ({ row, column, rowSpan, columnSpan })
  const keys = (values: Iterable<number>) => [...values].sort((a, b) => a - b)

  it('marks the cells a merged range covers, but not the one it starts at', () => {
    const { origins, covered } = mergeCoverage([merge(1, 1, 2, 2)], 5, 10)

    expect(keys(origins.keys())).toEqual([6])
    expect(keys(covered)).toEqual([7, 11, 12])
  })

  it('marks only the rows that are drawn, however far the range runs on', () => {
    const { covered } = mergeCoverage([merge(0, 0, 5000, 3)], 3, 4)

    expect(covered.size).toBe(4 * 3 - 1)
  })

  it('leaves a range that starts below the drawn rows for when they are drawn', () => {
    const { origins, covered } = mergeCoverage([merge(8, 0, 2, 2)], 4, 5)

    expect(origins.size).toBe(0)
    expect(covered.size).toBe(0)
    expect(mergeCoverage([merge(8, 0, 2, 2)], 4, 9).origins.size).toBe(1)
  })

  it('skips a range that starts inside another, which no workbook Excel wrote has', () => {
    const { origins } = mergeCoverage([merge(0, 0, 3, 3), merge(1, 1, 2, 2)], 5, 10)

    expect(keys(origins.keys())).toEqual([0])
  })

  it('takes the same range listed again as one range, not as another to mark', () => {
    // 4 positions a time against a budget of 5: were each listing marked, the two
    // repeats would use it up and the distinct range after them would be lost.
    const { origins } = mergeCoverage(
      [merge(0, 0, 2, 2), merge(0, 0, 2, 2), merge(0, 0, 2, 2), merge(5, 0, 1, 2)],
      10,
      20,
      5,
    )

    expect(keys(origins.keys())).toEqual([0, 50])
  })

  it('stops marking once the budget is spent, and draws the rest unmerged', () => {
    const { origins } = mergeCoverage([merge(0, 0, 2, 2), merge(5, 0, 2, 2), merge(9, 0, 2, 2)], 10, 20, 8)

    expect(keys(origins.keys())).toEqual([0, 50])
  })

  it('costs one range when a small workbook lists the same sweeping one hundreds of times', () => {
    const sweeping = Array.from({ length: 500 }, () => merge(0, 0, 5000, 100))

    const { origins, covered } = mergeCoverage(sweeping, 100, 5000)

    expect(origins.size).toBe(1)
    expect(covered.size).toBe(5000 * 100 - 1)
  })
})

describe('sheet annotations', () => {
  const add = () => screen.getByRole('button', { name: 'Add comment' })

  it('quotes a shift-click range with sheet and coordinates, including blank cells', () => {
    const onAnnotate = vi.fn()
    render(<SheetGrid grid={gridOf([['Name', 'Value'], ['Rent', undefined]])} label="Budget" onAnnotate={onAnnotate} />)
    expect(add()).toBeDisabled()
    fireEvent.click(screen.getByRole('gridcell', { name: 'B2' }))
    fireEvent.click(add())
    expect(onAnnotate).toHaveBeenLastCalledWith({ text: '', location: 'Budget!B2' })
    fireEvent.click(screen.getByRole('gridcell', { name: 'A1: Name' }), { shiftKey: true })
    expect(screen.getAllByRole('gridcell').every((cell) => cell.getAttribute('aria-selected') === 'true')).toBe(true)
    fireEvent.click(add())
    expect(onAnnotate).toHaveBeenLastCalledWith({ text: 'Name\tValue\nRent\t', location: 'Budget!A1:B2' })
  })

  it('supports keyboard selection and range extension, skips hidden cells and clears with Escape', () => {
    const onAnnotate = vi.fn()
    render(<SheetGrid grid={gridOf([['a', 'hidden', 'c']], { columnWidths: [72, 0, 72] })} label="Sheet" onAnnotate={onAnnotate} />)
    const first = screen.getByRole('gridcell', { name: 'A1: a' })
    expect(screen.getAllByRole('gridcell').filter((cell) => cell.tabIndex === 0)).toEqual([first])
    fireEvent.keyDown(first, { key: 'ArrowRight', shiftKey: true })
    expect(screen.getByRole('gridcell', { name: 'C1: c' })).toHaveFocus()
    fireEvent.click(add())
    expect(onAnnotate).toHaveBeenCalledWith({ text: 'a\thidden\tc', location: 'Sheet!A1:C1' })
    fireEvent.keyDown(screen.getByRole('gridcell', { name: 'C1: c' }), { key: 'Escape' })
    expect(add()).toBeDisabled()
    fireEvent.keyDown(first, { key: 'Enter' })
    fireEvent.click(add())
    expect(onAnnotate).toHaveBeenLastCalledWith({ text: 'a', location: 'Sheet!A1' })
  })

  it('uses the full rendered merged address and quotes the origin once', () => {
    const onAnnotate = vi.fn()
    render(<SheetGrid grid={gridOf([['Title', 'covered'], ['covered', 'covered']], { merges: [{ row: 0, column: 0, rowSpan: 2, columnSpan: 2 }] })} label="Merged" onAnnotate={onAnnotate} />)
    fireEvent.click(screen.getByRole('gridcell', { name: 'A1: Title' }))
    fireEvent.click(add())
    expect(onAnnotate).toHaveBeenCalledWith({ text: 'Title\t\n\t', location: 'Merged!A1:B2' })
  })

  it('includes a merged origin crossed by the middle of a range', () => {
    const onAnnotate = vi.fn()
    render(<SheetGrid grid={gridOf([['a', 'start', 'c'], ['title', 'covered', 'covered'], ['d', 'end', 'f']], {
      merges: [{ row: 1, column: 0, rowSpan: 1, columnSpan: 3 }],
    })} label="Crossed" onAnnotate={onAnnotate} />)
    fireEvent.click(screen.getByRole('gridcell', { name: 'B1: start' }))
    fireEvent.click(screen.getByRole('gridcell', { name: 'B3: end' }), { shiftKey: true })
    fireEvent.click(add())
    expect(onAnnotate).toHaveBeenCalledWith({ text: 'a\tstart\tc\ntitle\t\t\nd\tend\tf', location: 'Crossed!A1:C3' })
    expect(screen.getAllByRole('gridcell').every((cell) => cell.getAttribute('aria-selected') === 'true')).toBe(true)
  })

  it('closes cascading merge intersections regardless of merge order', () => {
    const onAnnotate = vi.fn()
    const grid = gridOf(Array.from({ length: 5 }, (_, row) => Array.from({ length: 5 }, (_, column) => `${columnLabel(column)}${row + 1}`)), {
      merges: [
        { row: 3, column: 1, rowSpan: 1, columnSpan: 4 },
        { row: 2, column: 0, rowSpan: 3, columnSpan: 1 },
        { row: 1, column: 0, rowSpan: 1, columnSpan: 3 },
      ],
    })
    render(<SheetGrid grid={grid} label="Cascade" onAnnotate={onAnnotate} />)
    fireEvent.click(screen.getByRole('gridcell', { name: 'B1: B1' }))
    fireEvent.click(screen.getByRole('gridcell', { name: 'B3: B3' }), { shiftKey: true })
    fireEvent.click(add())
    expect(onAnnotate).toHaveBeenCalledWith({ location: 'Cascade!A1:E5', text: 'A1\tB1\tC1\tD1\tE1\nA2\t\t\tD2\tE2\nA3\tB3\tC3\tD3\tE3\n\tB4\t\t\t\n\tB5\tC5\tD5\tE5' })
    expect(screen.getAllByRole('gridcell').every((cell) => cell.getAttribute('aria-selected') === 'true')).toBe(true)
  })

  it('clips crossed merges to rendered rows and ignores merges below the draw budget', () => {
    const onAnnotate = vi.fn()
    const grid = gridOf(Array.from({ length: 6 }, (_, row) => [`a${row}`, `b${row}`, `c${row}`]), {
      merges: [
        { row: 0, column: 1, rowSpan: 6, columnSpan: 1 },
        { row: 4, column: 0, rowSpan: 2, columnSpan: 1 },
      ],
    })
    render(<SheetGrid grid={grid} label="Clipped" cellBudget={9} onAnnotate={onAnnotate} />)
    fireEvent.click(screen.getByRole('gridcell', { name: 'A1: a0' }))
    fireEvent.click(screen.getByRole('gridcell', { name: 'C1: c0' }), { shiftKey: true })
    fireEvent.click(add())
    expect(onAnnotate).toHaveBeenCalledWith({ location: 'Clipped!A1:C3', text: 'a0\tb0\tc0\na1\t\tc1\na2\t\tc2' })
  })

  it('invalidates a selection immediately when bytes or parsed grid changes', () => {
    const onAnnotate = vi.fn()
    const grid = gridOf([['old']])
    const props = { grid, label: 'Sheet', onAnnotate }
    const { rerender } = render(<SheetGrid {...props} selectionResetKey="old bytes" />)
    fireEvent.click(screen.getByRole('gridcell'))
    expect(add()).toBeEnabled()
    rerender(<SheetGrid {...props} selectionResetKey="new bytes" />)
    expect(add()).toBeDisabled()
    fireEvent.click(screen.getByRole('gridcell'))
    rerender(<SheetGrid {...props} grid={gridOf([['new']])} selectionResetKey="new bytes" />)
    expect(add()).toBeDisabled()
    expect(onAnnotate).not.toHaveBeenCalled()
  })
})
