import { createRef } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ReasoningEffortPopover } from './ReasoningEffortPopover'
import { useSettingsStore } from '../../stores/settingsStore'

const options = ['low', 'medium', 'high', 'xhigh', 'max'] as const
const labels = {
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '极高',
  max: '最大',
}

beforeEach(() => {
  useSettingsStore.setState({ locale: 'zh' })
})

afterEach(cleanup)

function renderPopover(overrides: Partial<React.ComponentProps<typeof ReasoningEffortPopover>> = {}) {
  const anchorRef = createRef<HTMLButtonElement>()
  const onChange = vi.fn()
  const onClose = vi.fn()
  const view = render(
    <>
      <button ref={anchorRef}>5.6 Sol 极高</button>
      <ReasoningEffortPopover
        open
        anchorRef={anchorRef}
        options={[...options]}
        value="xhigh"
        labels={labels}
        onChange={onChange}
        onClose={onClose}
        {...overrides}
      />
      <button>外部区域</button>
    </>,
  )
  return { ...view, anchorRef, onChange, onClose }
}

describe('ReasoningEffortPopover', () => {
  // 「素」: the effort control is a five-way segmented track inside a menu
  // sheet (white, hairline, `--radius-lg`, dropdown shadow), headed by the
  // section label — the old serif level name over a slider knob is gone.
  it('renders the effort as a segmented track inside the shared menu sheet', () => {
    renderPopover()

    const popover = screen.getByTestId('reasoning-effort-popover')
    expect(popover).toHaveStyle({ width: '320px' })
    expect(popover).toHaveClass('rounded-[var(--radius-lg)]', 'border-[var(--color-border)]', 'shadow-[var(--shadow-dropdown)]', 'p-1')
    expect(popover.querySelectorAll('svg')).toHaveLength(0)
    expect(screen.getByTestId('reasoning-effort-context-label')).toHaveTextContent('推理强度')
    expect(screen.getByTestId('reasoning-effort-header')).toHaveClass('text-[11px]', 'font-semibold')
    const slider = screen.getByRole('slider', { name: '推理强度' })
    expect(slider).toHaveClass('h-[30px]', 'bg-[var(--color-surface-container)]')
    expect(slider).toHaveStyle({ gridTemplateColumns: 'repeat(5, minmax(0, 1fr))' })
    expect(screen.getAllByTestId('reasoning-effort-stop').map((stop) => stop.textContent))
      .toEqual(['低', '中', '高', '极高', '最大'])
  })

  it('lifts only the selected segment, from tokens that survive the ink themes', () => {
    renderPopover()

    const stops = screen.getAllByTestId('reasoning-effort-stop')
    const selected = stops.filter((stop) => stop.hasAttribute('data-selected'))
    expect(selected).toHaveLength(1)
    expect(selected[0]).toHaveTextContent('极高')
    // The lifted segment of SegmentedControl, not a terracotta fill: brand is
    // reserved for the send key and selection checks.
    expect(selected[0]).toHaveClass('bg-[var(--color-surface-container-lowest)]', 'shadow-[var(--shadow-segment)]')
    for (const stop of stops) {
      expect(stop.className).not.toMatch(/white/)
      expect(stop.className).not.toMatch(/\/\d+/)
      expect(stop.className).not.toContain('--color-brand')
    }
  })

  it('renders every model-supported stop and exposes the selected localized value', () => {
    renderPopover()

    const slider = screen.getByRole('slider', { name: '推理强度' })
    expect(slider).toHaveAttribute('aria-valuemin', '0')
    expect(slider).toHaveAttribute('aria-valuemax', '4')
    expect(slider).toHaveAttribute('aria-valuenow', '3')
    expect(slider).toHaveAttribute('aria-valuetext', '极高')
    expect(screen.getAllByTestId('reasoning-effort-stop')).toHaveLength(5)
    expect(screen.getByText('极高')).toBeInTheDocument()
    // `--color-border-focus` is the app-wide focus token; the raw brand color
    // here predated it.
    expect(slider).toHaveClass('focus-visible:ring-[var(--color-border-focus)]')
  })

  it('selects a discrete stop from the track', () => {
    const { onChange } = renderPopover()
    const slider = screen.getByRole('slider', { name: '推理强度' })
    vi.spyOn(slider, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      width: 400,
      height: 48,
      top: 0,
      right: 400,
      bottom: 48,
      left: 0,
      toJSON: () => ({}),
    })

    fireEvent.click(slider, { clientX: 200 })

    expect(onChange).toHaveBeenCalledWith('high')
  })

  it('supports keyboard navigation and clamps at supported endpoints', () => {
    const { onChange, rerender, anchorRef } = renderPopover({ value: 'low' })
    const slider = screen.getByRole('slider', { name: '推理强度' })

    fireEvent.keyDown(slider, { key: 'ArrowLeft' })
    fireEvent.keyDown(slider, { key: 'ArrowRight' })
    fireEvent.keyDown(slider, { key: 'End' })

    expect(onChange.mock.calls).toEqual([['medium'], ['max']])

    rerender(
      <ReasoningEffortPopover
        open
        anchorRef={anchorRef}
        options={[...options]}
        value="max"
        labels={labels}
        onChange={onChange}
        onClose={vi.fn()}
      />,
    )
    fireEvent.keyDown(screen.getByRole('slider', { name: '推理强度' }), { key: 'ArrowRight' })
    expect(onChange.mock.calls).toEqual([['medium'], ['max']])
  })

  it('closes on Escape and outside pointer interaction', () => {
    const { onClose } = renderPopover()
    const slider = screen.getByRole('slider', { name: '推理强度' })

    fireEvent.keyDown(slider, { key: 'Escape' })
    fireEvent.pointerDown(screen.getByRole('button', { name: '外部区域' }))

    expect(onClose).toHaveBeenCalledTimes(2)
  })
})
