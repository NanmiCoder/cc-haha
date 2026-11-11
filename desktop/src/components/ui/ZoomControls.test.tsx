import '@testing-library/jest-dom/vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ZoomControls, type ZoomControlsProps } from './ZoomControls'

const LABELS = { group: 'Zoom controls', zoomIn: 'Zoom in', zoomOut: 'Zoom out', fit: 'Fit to window' }

function renderControls(overrides: Partial<ZoomControlsProps> = {}) {
  const handlers = { onZoomIn: vi.fn(), onZoomOut: vi.fn(), onFit: vi.fn() }
  const view = render(
    <ZoomControls
      percent={110}
      fitActive={false}
      canZoomIn
      canZoomOut
      labels={LABELS}
      {...handlers}
      {...overrides}
    />,
  )
  return { ...view, ...handlers }
}

describe('ZoomControls', () => {
  it('keeps lightbox zoom controls readable on a dark scrim with touch-sized buttons', () => {
    const { onZoomIn } = renderControls({ surface: 'lightbox' })
    expect(screen.getByRole('group')).toHaveClass('rounded-[var(--radius-full)]', 'bg-[var(--color-lightbox-control-bg)]')
    const zoomIn = screen.getByRole('button', { name: 'Zoom in' })
    expect(zoomIn).toHaveClass('h-11', 'w-11', 'text-[var(--color-lightbox-control-fg)]')
    fireEvent.click(zoomIn)
    expect(onZoomIn).toHaveBeenCalledOnce()
  })
  it('names the cluster and each control from the labels the caller supplies', () => {
    renderControls()

    expect(screen.getByRole('group', { name: 'Zoom controls' })).toBeInTheDocument()
    for (const name of ['Zoom in', 'Zoom out', 'Fit to window']) {
      expect(screen.getByRole('button', { name })).toBeInTheDocument()
    }
  })

  it('shows the current zoom as a readout', () => {
    renderControls({ percent: 87 })

    expect(screen.getByText('87%')).toBeInTheDocument()
    // A readout, not a control: it does not compete for tab stops.
    expect(screen.queryByRole('button', { name: /87/ })).not.toBeInTheDocument()
  })

  it('reports each control through its own handler', () => {
    const { onZoomIn, onZoomOut, onFit } = renderControls()

    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }))
    fireEvent.click(screen.getByRole('button', { name: 'Zoom out' }))
    fireEvent.click(screen.getByRole('button', { name: 'Fit to window' }))

    expect(onZoomIn).toHaveBeenCalledTimes(1)
    expect(onZoomOut).toHaveBeenCalledTimes(1)
    expect(onFit).toHaveBeenCalledTimes(1)
  })

  it('disables a step that has nowhere left to go', () => {
    renderControls({ canZoomIn: false, canZoomOut: false })

    expect(screen.getByRole('button', { name: 'Zoom in' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Zoom out' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Fit to window' })).toBeEnabled()
  })

  it('offers fit only once the viewer has left it, as an action rather than a toggle', () => {
    const { rerender, onFit } = renderControls({ fitActive: true })
    const fit = () => screen.getByRole('button', { name: 'Fit to window' })
    // Already fitted: clicking would change nothing, so it cannot be clicked.
    expect(fit()).toBeDisabled()
    expect(fit()).not.toHaveAttribute('aria-pressed')
    fireEvent.click(fit())
    expect(onFit).not.toHaveBeenCalled()

    rerender(
      <ZoomControls percent={100} fitActive={false} canZoomIn canZoomOut labels={LABELS} onZoomIn={vi.fn()} onZoomOut={vi.fn()} onFit={onFit} />,
    )
    expect(fit()).toBeEnabled()
    expect(fit()).not.toHaveAttribute('aria-pressed')
  })

  it('draws fit with an icon of its own, never the maximize arrows of the panel control', () => {
    const { container, rerender } = renderControls()
    const fitIcon = () => screen.getByRole('button', { name: 'Fit to window' }).querySelector('svg')
    expect(fitIcon()).toHaveClass('lucide-scan')

    rerender(
      <ZoomControls percent={100} fitActive={false} fitMode="width" canZoomIn canZoomOut labels={LABELS} onZoomIn={vi.fn()} onZoomOut={vi.fn()} onFit={vi.fn()} />,
    )
    expect(fitIcon()).toHaveClass('lucide-move-horizontal')
    expect(container.querySelector('.lucide-maximize2, .lucide-maximize-2')).toBeNull()
  })

  it('floats with a shadow by default and sits flat in a toolbar on request', () => {
    const { container, rerender } = renderControls()
    expect(container.firstElementChild?.className).toContain('--shadow-card')

    rerender(
      <ZoomControls percent={100} fitActive canZoomIn canZoomOut labels={LABELS} onZoomIn={vi.fn()} onZoomOut={vi.fn()} onFit={vi.fn()} flat />,
    )
    expect(container.firstElementChild?.className).not.toContain('--shadow-card')
  })

  it('uses the fixed dark palette on the media surface and theme tokens on a panel', () => {
    const { container, rerender } = renderControls({ surface: 'media' })
    expect(container.firstElementChild?.className).toContain('--color-media-header')

    rerender(
      <ZoomControls percent={100} fitActive canZoomIn canZoomOut labels={LABELS} onZoomIn={vi.fn()} onZoomOut={vi.fn()} onFit={vi.fn()} />,
    )
    expect(container.firstElementChild?.className).toContain('--color-surface-container-lowest')
    expect(container.firstElementChild?.className).not.toContain('--color-media')
  })
})
