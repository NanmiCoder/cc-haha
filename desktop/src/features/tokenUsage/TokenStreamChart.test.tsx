import { beforeEach, describe, expect, it } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import '@testing-library/jest-dom'

import { useSettingsStore } from '../../stores/settingsStore'
import { TokenStreamChart } from './TokenStreamChart'
import type { DailyModelSeries, DayActivity, RankedModel } from './usageModel'

const models: RankedModel[] = [
  { id: 'a', label: 'Alpha', series: 1, total: 1, fresh: 0, cached: 0, costUSD: 0, unpriced: false },
  { id: 'b', label: 'Beta', series: 2, total: 1, fresh: 0, cached: 0, costUSD: 0, unpriced: false },
]

// Five days: the second is the busiest and the third is idle.
const days: DailyModelSeries[] = [
  { date: '2026-10-13', total: 1_000_000, byModel: [600_000, 400_000] },
  { date: '2026-10-14', total: 4_000_000, byModel: [4_000_000, 0] },
  { date: '2026-10-15', total: 0, byModel: [0, 0] },
  { date: '2026-10-16', total: 2_000_000, byModel: [500_000, 1_500_000] },
  { date: '2026-10-17', total: 1_000_000, byModel: [1_000_000, 0] },
]
const activity = new Map<string, DayActivity>([
  ['2026-10-14', { sessionCount: 7, messageCount: 120, toolCallCount: 340 }],
  ['2026-10-16', { sessionCount: 3, messageCount: 45, toolCallCount: 90 }],
])

function renderChart() {
  return render(<TokenStreamChart days={days} models={models} activity={activity} locale="en" />)
}

const dayButton = (label: RegExp) => screen.getByRole('button', { name: label })
const OCT_13 = /^Oct 13, 2026/
const OCT_14 = /^Oct 14, 2026/
const OCT_15 = /^Oct 15, 2026/
const OCT_16 = /^Oct 16, 2026/
const OCT_17 = /^Oct 17, 2026/

describe('TokenStreamChart day detail', () => {
  beforeEach(() => {
    useSettingsStore.setState({ locale: 'en' })
  })

  it('marks the day under the pointer with its date and figure, before anything is clicked', () => {
    renderChart()
    expect(screen.queryByTestId('stream-hover-chip')).not.toBeInTheDocument()

    fireEvent.mouseEnter(dayButton(OCT_16))
    expect(screen.getByTestId('stream-hover-chip')).toHaveTextContent('10/16 · 2M')
    expect(screen.getByTestId('stream-hover-band')).toBeInTheDocument()
    expect(screen.queryByTestId('stream-day-card')).not.toBeInTheDocument()

    fireEvent.mouseLeave(dayButton(OCT_16).parentElement!)
    expect(screen.queryByTestId('stream-hover-chip')).not.toBeInTheDocument()
  })

  it('previews a day for keyboard focus the same way', () => {
    renderChart()
    fireEvent.focus(dayButton(OCT_14))
    expect(screen.getByTestId('stream-hover-chip')).toHaveTextContent('10/14 · 4M')
    fireEvent.blur(dayButton(OCT_14))
    expect(screen.queryByTestId('stream-hover-chip')).not.toBeInTheDocument()
  })

  it('does not preview an idle day, and drops the marker when the pointer moves onto one', () => {
    renderChart()
    fireEvent.mouseEnter(dayButton(OCT_14))
    expect(screen.getByTestId('stream-hover-chip')).toBeInTheDocument()

    fireEvent.mouseEnter(dayButton(OCT_15))
    expect(screen.queryByTestId('stream-hover-chip')).not.toBeInTheDocument()
    expect(screen.queryByTestId('stream-hover-band')).not.toBeInTheDocument()
  })

  it('pins a card for the clicked day and puts it away on a second click', () => {
    renderChart()
    fireEvent.click(dayButton(OCT_14))

    const card = screen.getByTestId('stream-day-card')
    expect(within(card).getByText('Wed, October 14')).toBeInTheDocument()
    expect(within(card).getByTestId('stream-day-total')).toHaveTextContent('4')
    // The busiest day: first of four active days, and the full peak.
    expect(card).toHaveTextContent('No. 1 · 100% of peak')
    // (1M + 4M + 2M + 1M) / 4 active days; the idle day is not in the average.
    expect(card).toHaveTextContent('Avg 2M')
    expect(within(card).getByText('Sessions').nextElementSibling).toHaveTextContent('7')
    expect(within(card).getByText('Messages').nextElementSibling).toHaveTextContent('120')
    expect(within(card).getByText('Tool calls').nextElementSibling).toHaveTextContent('340')
    expect(within(card).getByText('Alpha')).toBeInTheDocument()
    expect(within(card).queryByText('Beta')).not.toBeInTheDocument()
    expect(dayButton(OCT_14)).toHaveAttribute('aria-pressed', 'true')
    expect(dayButton(OCT_13)).toHaveAttribute('aria-pressed', 'false')

    fireEvent.click(dayButton(OCT_14))
    expect(screen.queryByTestId('stream-day-card')).not.toBeInTheDocument()
    expect(dayButton(OCT_14)).toHaveAttribute('aria-pressed', 'false')
  })

  it('moves the card to another day without closing it, and shows that day\'s own mix', () => {
    renderChart()
    fireEvent.click(dayButton(OCT_14))
    fireEvent.click(dayButton(OCT_16))

    const card = screen.getByTestId('stream-day-card')
    expect(within(card).getByText('Fri, October 16')).toBeInTheDocument()
    expect(card).toHaveTextContent('No. 2 · 50% of peak')
    // Beta carried three quarters of this day, Alpha a quarter.
    const rows = within(card).getAllByRole('listitem').map((row) => row.textContent)
    expect(rows).toEqual(['Beta1.5M75%', 'Alpha500k25%'])
    expect(within(card).getByText('Sessions').nextElementSibling).toHaveTextContent('3')
  })

  it('has nothing to open for an idle day', () => {
    renderChart()
    const idle = dayButton(OCT_15)
    expect(idle).toHaveAttribute('aria-disabled', 'true')
    expect(idle).toHaveAttribute('tabindex', '-1')

    fireEvent.click(idle)
    expect(screen.queryByTestId('stream-day-card')).not.toBeInTheDocument()
  })

  it('closes with Esc or the close button and hands focus back to the day', () => {
    renderChart()
    fireEvent.click(dayButton(OCT_14))
    fireEvent.keyDown(dayButton(OCT_14), { key: 'Escape' })
    expect(screen.queryByTestId('stream-day-card')).not.toBeInTheDocument()
    expect(dayButton(OCT_14)).toHaveFocus()

    fireEvent.click(dayButton(OCT_16))
    fireEvent.click(screen.getByRole('button', { name: 'Close day details' }))
    expect(screen.queryByTestId('stream-day-card')).not.toBeInTheDocument()
    expect(dayButton(OCT_16)).toHaveFocus()
  })

  it('leaves no preview of the closed day behind when the x button put the card away', () => {
    renderChart()
    const day = dayButton(OCT_14)
    fireEvent.mouseEnter(day)
    fireEvent.click(day)
    // The pointer travels from the day to the card's x; nothing is under it once the card is gone.
    fireEvent.mouseLeave(day.parentElement!)
    fireEvent.click(screen.getByRole('button', { name: 'Close day details' }))

    expect(screen.queryByTestId('stream-day-card')).not.toBeInTheDocument()
    expect(day).toHaveFocus()
    expect(screen.queryByTestId('stream-hover-chip')).not.toBeInTheDocument()
    expect(screen.queryByTestId('stream-hover-band')).not.toBeInTheDocument()

    // The pointer arriving on a day afterwards still previews it.
    fireEvent.mouseEnter(dayButton(OCT_16))
    expect(screen.getByTestId('stream-hover-chip')).toHaveTextContent('10/16 · 2M')
  })

  it('keeps previewing other days while one is pinned, but not the pinned one', () => {
    renderChart()
    fireEvent.click(dayButton(OCT_14))
    fireEvent.mouseEnter(dayButton(OCT_14))
    expect(screen.queryByTestId('stream-hover-chip')).not.toBeInTheDocument()

    fireEvent.mouseEnter(dayButton(OCT_16))
    expect(screen.getByTestId('stream-hover-chip')).toHaveTextContent('10/16 · 2M')
  })

  it('marks the pinned day with a dot on its column and fades the days around it', () => {
    renderChart()
    fireEvent.click(dayButton(OCT_14))

    const selection = screen.getByTestId('stream-selection')
    // Five days across a 928-wide box: slots are 185.6 wide and the second runs 185.6 to 371.2.
    const [before, after] = Array.from(selection.querySelectorAll('rect'))
    expect(before).toHaveAttribute('width', '185.6')
    expect(after).toHaveAttribute('x', '371.2')
    expect(after).toHaveAttribute('width', String(928 - 371.2))
    // The dot sits over the middle of that slot.
    expect(selection.querySelector('circle')).toHaveAttribute('cx', String(1.5 * 185.6))

    fireEvent.click(dayButton(OCT_14))
    expect(screen.queryByTestId('stream-selection')).not.toBeInTheDocument()
  })

  it('opens beside the day, on whichever side has room, and never off the chart', () => {
    renderChart()
    // The first day has the whole width to its right…
    fireEvent.click(dayButton(OCT_13))
    expect(screen.getByTestId('stream-day-card')).toHaveStyle({ left: `${0.1 * 928 + 14}px`, width: '296px' })

    // …and the last has none, so the card sits to its left.
    fireEvent.click(dayButton(OCT_17))
    expect(screen.getByTestId('stream-day-card')).toHaveStyle({ left: `${0.9 * 928 - 14 - 296}px`, width: '296px' })
  })

  it('reads against round grid values from zero, labelled in the reader\'s units', () => {
    renderChart()
    // Peak is 4M, so the grid steps by 1M.
    expect(screen.getAllByTestId('stream-grid-label').map((label) => label.textContent)).toEqual(['1M', '2M', '3M', '4M'])
  })

  it('lists the legend in color-slot order, not in order of use', () => {
    const swapped: RankedModel[] = [
      { ...models[0]!, series: 2 },
      { ...models[1]!, series: 1 },
    ]
    render(<TokenStreamChart days={days} models={swapped} activity={activity} locale="en" />)
    const legend = screen.getAllByRole('listitem').map((item) => item.textContent)
    expect(legend).toEqual(['Beta', 'Alpha'])
  })

  it('gives the peak day\'s figure to the pointer chip while it is on that day, then takes it back', () => {
    renderChart()
    const peak = screen.getByTestId('stream-peak')
    expect(peak).toHaveStyle({ opacity: '1' })

    fireEvent.mouseEnter(dayButton(OCT_14))
    expect(peak).toHaveStyle({ opacity: '0' })
    expect(screen.getByTestId('stream-hover-chip')).toHaveTextContent('10/14 · 4M')

    fireEvent.mouseEnter(dayButton(OCT_16))
    expect(peak).toHaveStyle({ opacity: '1' })
  })
})
