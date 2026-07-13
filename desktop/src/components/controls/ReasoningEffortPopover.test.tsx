import { createRef } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ReasoningEffortPopover } from './ReasoningEffortPopover'

const options = ['low', 'medium', 'high', 'xhigh', 'max'] as const
const labels = {
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '极高',
  max: '最大',
}

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
  it('keeps the effort visual compact without non-functional icon controls', () => {
    renderPopover()

    const popover = screen.getByTestId('reasoning-effort-popover')
    expect(popover).toHaveStyle({ width: '240px' })
    expect(popover).toHaveClass('px-3.5', 'pb-3.5', 'pt-3')
    expect(popover.querySelectorAll('svg')).toHaveLength(0)
    expect(screen.getByTestId('reasoning-effort-header')).toHaveClass('mb-2.5', 'justify-between')
    expect(screen.getByTestId('reasoning-effort-label')).toHaveClass('text-sm')
    expect(screen.getByTestId('reasoning-effort-context-label')).toHaveClass('text-[10px]')
    expect(screen.getByTestId('reasoning-effort-context-label')).toHaveTextContent('推理强度')
    expect(screen.getByRole('slider', { name: '推理强度' })).toHaveClass('h-9')
    expect(screen.getByTestId('reasoning-effort-track')).toHaveClass('h-6')
    expect(screen.getByTestId('reasoning-effort-thumb')).toHaveClass('h-8', 'w-8')
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
    expect(screen.getByTestId('reasoning-effort-fill')).toHaveClass('bg-[var(--color-brand)]')
    expect(slider).toHaveClass('focus-visible:ring-[var(--color-brand)]')
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
