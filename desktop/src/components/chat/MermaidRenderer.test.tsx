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
import { useUIStore } from '../../stores/uiStore'
import { useSettingsStore } from '../../stores/settingsStore'

describe('MermaidRenderer', () => {
  beforeEach(() => {
    useUIStore.setState({ theme: 'white' })
    // The zoom controls are translated; assertions below spell the English strings.
    useSettingsStore.setState({ locale: 'en' })
    initializeMock.mockReset()
    renderMock.mockReset()
    renderMock.mockResolvedValue({
      svg: '<svg viewBox="0 0 200 100"><rect width="200" height="100"></rect></svg>',
    })
  })

  it('normalizes large SVGs so edges stay visible when the diagram is scaled', async () => {
    renderMock.mockResolvedValue({
      svg: [
        '<svg viewBox="0 0 1200 300" width="100%" height="100%" style="max-width: 1200px;">',
        '<path data-edge="true" class="flowchart-link" d="M0 0L1200 300"></path>',
        '<marker id="arrow"><path class="arrowMarkerPath" d="M0 0L10 5L0 10z"></path></marker>',
        '</svg>',
      ].join(''),
    })

    render(<MermaidRenderer code={'graph LR\nA-->B'} />)

    const surface = await screen.findByTestId('mermaid-diagram-surface')
    const renderedSvg = surface.querySelector('svg')
    const edge = surface.querySelector('[data-edge="true"]')
    const arrow = surface.querySelector('.arrowMarkerPath')

    expect(renderedSvg).toHaveAttribute('width', '1200')
    expect(renderedSvg).toHaveAttribute('height', '300')
    expect(renderedSvg).toHaveStyle({ maxWidth: 'none' })
    expect(edge).toHaveStyle({ fill: 'none' })
    expect(edge?.getAttribute('style')).toContain('vector-effect: non-scaling-stroke')
    expect(arrow?.getAttribute('style')).toContain('stroke:')
  })

  it('preserves explicit Mermaid edge and marker paint while adding visibility safeguards', async () => {
    renderMock.mockResolvedValue({
      svg: [
        '<svg viewBox="0 0 300 120" width="100%" height="100%">',
        '<path data-edge="true" class="flowchart-link" stroke="#ff0000" stroke-width="4" fill="none" d="M0 0L300 120"></path>',
        '<marker id="arrow"><path class="arrowMarkerPath" fill="#ff0000" stroke="#ff0000" d="M0 0L10 5L0 10z"></path></marker>',
        '</svg>',
      ].join(''),
    })

    render(<MermaidRenderer code={'graph LR\nA-->B\nlinkStyle 0 stroke:#ff0000,stroke-width:4px'} />)

    const surface = await screen.findByTestId('mermaid-diagram-surface')
    const edge = surface.querySelector('[data-edge="true"]')
    const arrow = surface.querySelector('.arrowMarkerPath')

    expect(edge).toHaveAttribute('stroke', '#ff0000')
    expect(edge).toHaveAttribute('stroke-width', '4')
    expect(edge).toHaveAttribute('fill', 'none')
    expect(edge?.getAttribute('style')).toContain('vector-effect: non-scaling-stroke')
    expect(arrow).toHaveAttribute('fill', '#ff0000')
    expect(arrow).toHaveAttribute('stroke', '#ff0000')
    expect(arrow?.getAttribute('style') ?? '').not.toContain('fill:')
    expect(arrow?.getAttribute('style') ?? '').not.toContain('stroke:')
  })

  it('quotes generated slash labels that Mermaid would parse as invalid shape syntax', async () => {
    render(
      <MermaidRenderer
        code={[
          'flowchart TD',
          '  D1[/api/dcl] --> D2[Call dclService directly]',
        ].join('\n')}
      />,
    )

    await waitFor(() => {
      expect(renderMock).toHaveBeenCalledWith(
        expect.any(String),
        [
          'flowchart TD',
          '  D1["/api/dcl"] --> D2[Call dclService directly]',
        ].join('\n'),
      )
    })
  })

  it('preserves slash-delimited Mermaid flowchart shapes', async () => {
    const code = [
      'flowchart TD',
      '  A[/Manual input/] --> B[OK]',
    ].join('\n')

    render(<MermaidRenderer code={code} />)

    await waitFor(() => {
      expect(renderMock).toHaveBeenCalledWith(expect.any(String), code)
    })
  })

  it('fits oversized diagrams inside the chat message surface', async () => {
    const originalClientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth')
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
      configurable: true,
      get() {
        return this instanceof HTMLElement && this.dataset.testid === 'mermaid-diagram-surface' ? 800 : 0
      },
    })
    renderMock.mockResolvedValue({
      svg: '<svg viewBox="0 0 1200 300"><path data-edge="true" d="M0 0L1200 300"></path></svg>',
    })

    try {
      render(<MermaidRenderer code={'graph LR\nA-->B'} />)

      const canvas = await screen.findByLabelText('Mermaid inline canvas')

      await waitFor(() => {
        expect(canvas).toHaveStyle({
          width: '1200px',
          height: '300px',
          transform: 'scale(0.64)',
        })
      })
    } finally {
      if (originalClientWidth) {
        Object.defineProperty(HTMLElement.prototype, 'clientWidth', originalClientWidth)
      }
    }
  })

  it('opens preview with zoom controls and updates the zoom label', async () => {
    render(<MermaidRenderer code={'graph TB\nA-->B'} />)

    const previewButton = await screen.findByRole('button', { name: /preview/i })
    expect(previewButton).toBeInTheDocument()
    expect(initializeMock).toHaveBeenCalledWith(expect.objectContaining({
      theme: 'base',
      flowchart: expect.objectContaining({ htmlLabels: false }),
      themeVariables: expect.objectContaining({ darkMode: false }),
      suppressErrorRendering: true,
    }))
    expect(screen.getByTestId('mermaid-diagram-surface').className).toContain('bg-[var(--color-surface-container-lowest)]')

    fireEvent.click(previewButton)

    await screen.findByText('Mermaid Diagram')
    expect(screen.getByRole('button', { name: 'Zoom in' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Zoom out' })).toBeInTheDocument()

    const zoomButton = screen.getByRole('button', { name: '100%' })
    expect(zoomButton).toBeInTheDocument()

    const canvas = screen.getByLabelText('Mermaid preview canvas')

    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }))

    await waitFor(() => {
      expect(screen.getByRole('button', { name: '125%' })).toBeInTheDocument()
    })
    expect(canvas).toHaveStyle({
      position: 'absolute',
      width: '200px',
      height: '100px',
      transform: 'scale(1.25)',
    })

    fireEvent.click(screen.getByRole('button', { name: '125%' }))

    await waitFor(() => {
      expect(screen.getByRole('button', { name: '100%' })).toBeInTheDocument()
    })
  })

  it('fits oversized diagrams to the preview viewport by default', async () => {
    const originalClientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth')
    const originalClientHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight')
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
      configurable: true,
      get() {
        return this instanceof HTMLElement && this.dataset.testid === 'mermaid-preview-viewport' ? 800 : 0
      },
    })
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
      configurable: true,
      get() {
        return this instanceof HTMLElement && this.dataset.testid === 'mermaid-preview-viewport' ? 500 : 0
      },
    })
    renderMock.mockResolvedValue({
      svg: '<svg viewBox="0 0 1200 300"><path data-edge="true" d="M0 0L1200 300"></path></svg>',
    })

    try {
      render(<MermaidRenderer code={'graph LR\nA-->B'} />)

      fireEvent.click(await screen.findByRole('button', { name: /preview/i }))

      await waitFor(() => {
        expect(screen.getByRole('button', { name: '63%' })).toBeInTheDocument()
      })

      fireEvent.click(screen.getByRole('button', { name: '63%' }))
      expect(screen.getByRole('button', { name: '100%' })).toBeInTheDocument()

      fireEvent.click(screen.getByRole('button', { name: 'Fit diagram' }))
      await waitFor(() => {
        expect(screen.getByRole('button', { name: '63%' })).toBeInTheDocument()
      })
    } finally {
      if (originalClientWidth) {
        Object.defineProperty(HTMLElement.prototype, 'clientWidth', originalClientWidth)
      }
      if (originalClientHeight) {
        Object.defineProperty(HTMLElement.prototype, 'clientHeight', originalClientHeight)
      }
    }
  })

  it('uses dark Mermaid theme variables when the app is in dark mode', async () => {
    useUIStore.setState({ theme: 'dark' })

    render(<MermaidRenderer code={'graph TB\nA-->B'} />)

    await screen.findByRole('button', { name: /preview/i })

    expect(initializeMock).toHaveBeenCalledWith(expect.objectContaining({
      theme: 'base',
      themeVariables: expect.objectContaining({ darkMode: true }),
    }))
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
