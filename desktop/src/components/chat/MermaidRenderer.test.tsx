import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'

const { initializeMock, renderMock } = vi.hoisted(() => ({
  initializeMock: vi.fn(),
  renderMock: vi.fn(),
}))

vi.mock('mermaid', () => ({
  default: {
    initialize: initializeMock,
    render: renderMock,
  },
}))

import { MermaidRenderer } from './MermaidRenderer'

describe('MermaidRenderer', () => {
  beforeEach(() => {
    initializeMock.mockReset()
    renderMock.mockReset()
    renderMock.mockResolvedValue({
      svg: '<svg viewBox="0 0 200 100"><rect width="200" height="100"></rect></svg>',
    })
  })

  it('opens preview with zoom controls and updates the zoom label', async () => {
    render(<MermaidRenderer code={'graph TB\nA-->B'} />)

    const previewButton = await screen.findByRole('button', { name: /preview/i })
    expect(previewButton).toBeInTheDocument()

    fireEvent.click(previewButton)

    await screen.findByText('Mermaid Diagram')
    expect(screen.getByRole('button', { name: 'Zoom in' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Zoom out' })).toBeInTheDocument()

    const zoomButton = screen.getByRole('button', { name: '100%' })
    expect(zoomButton).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }))

    await waitFor(() => {
      expect(screen.getByRole('button', { name: '125%' })).toBeInTheDocument()
    })

    fireEvent.click(screen.getByRole('button', { name: '125%' }))

    await waitFor(() => {
      expect(screen.getByRole('button', { name: '100%' })).toBeInTheDocument()
    })
  })

  it('enters and exits dragging state while panning the preview viewport', async () => {
    render(<MermaidRenderer code={'graph TB\nA-->B'} />)

    fireEvent.click(await screen.findByRole('button', { name: /preview/i }))
    const viewport = await screen.findByTestId('mermaid-preview-viewport')
    const canvas = screen.getByLabelText('Mermaid preview canvas')

    Object.defineProperty(viewport, 'setPointerCapture', {
      value: vi.fn(),
      configurable: true,
    })
    Object.defineProperty(viewport, 'releasePointerCapture', {
      value: vi.fn(),
      configurable: true,
    })
    Object.defineProperty(viewport, 'scrollLeft', {
      value: 0,
      writable: true,
      configurable: true,
    })
    Object.defineProperty(viewport, 'scrollTop', {
      value: 0,
      writable: true,
      configurable: true,
    })

    fireEvent.pointerDown(viewport, {
      pointerId: 7,
      clientX: 180,
      clientY: 120,
      pageX: 180,
      pageY: 120,
      button: 0,
      pointerType: 'mouse',
    })
    expect(canvas).toHaveAttribute('data-dragging', 'true')
    expect(viewport).toHaveStyle({ cursor: 'grabbing' })

    fireEvent.pointerUp(viewport, { pointerId: 7, pointerType: 'mouse' })
    expect(canvas).toHaveAttribute('data-dragging', 'false')
    expect(viewport).toHaveStyle({ cursor: 'grab' })
  })
})
