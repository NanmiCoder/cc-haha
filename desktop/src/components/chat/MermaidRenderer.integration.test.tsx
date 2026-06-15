import { beforeEach, describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'

import { MermaidRenderer } from './MermaidRenderer'
import { useUIStore } from '../../stores/uiStore'

type SvgMeasurementPrototype = SVGElement & {
  getBBox?: () => { x: number; y: number; width: number; height: number }
  getComputedTextLength?: () => number
}

describe('MermaidRenderer Mermaid integration', () => {
  beforeEach(() => {
    useUIStore.setState({ theme: 'white' })

    const svgPrototype = SVGElement.prototype as SvgMeasurementPrototype

    if (!svgPrototype.getBBox) {
      Object.defineProperty(svgPrototype, 'getBBox', {
        configurable: true,
        value: () => ({
          x: 0,
          y: 0,
          width: 120,
          height: 24,
        }),
      })
    }

    if (!svgPrototype.getComputedTextLength) {
      Object.defineProperty(svgPrototype, 'getComputedTextLength', {
        configurable: true,
        value: () => 96,
      })
    }
  })

  it('keeps labels from real Mermaid flowchart SVG output', async () => {
    render(
      <MermaidRenderer
        code={[
          'flowchart TB',
          '  A["企业建站"] --> B["主旨系统"]',
          '  B --> C["Codex 初期"]',
        ].join('\n')}
      />,
    )

    const surface = await screen.findByTestId('mermaid-diagram-surface')

    expect(surface).toHaveTextContent('企业建站')
    expect(surface).toHaveTextContent('主旨系统')
    expect(surface).toHaveTextContent('Codex 初期')
    expect(surface.querySelector('svg')).not.toHaveAttribute('width', '100%')
    expect(surface.querySelector('[data-edge="true"]')?.getAttribute('style')).toContain('vector-effect: non-scaling-stroke')
    expect(surface.innerHTML).not.toContain('<script')
    expect(surface.innerHTML).not.toContain('onerror')
  })

  it('renders generated flowchart labels with HTML breaks and structural characters', async () => {
    render(
      <MermaidRenderer
        code={[
          'graph LR',
          '    subgraph "Yjs CRDT 核心"',
          '        Y[Yjs Document]',
          '        A[嵌入类型<br/>Text / Map / Array]',
          '        I[插入操作<br/>{content, position, clock, clientID}]',
          '        D[删除操作<br/>{position, length, clock, clientID}]',
          '        RM[Room Manager<br/>map[string]*Room]',
          '    end',
          '    I --> Y',
          '    D --> Y',
          '    RM --> Y',
        ].join('\n')}
      />,
    )

    const surface = await screen.findByTestId('mermaid-diagram-surface')

    expect(surface).toHaveTextContent('插入操作')
    expect(surface).toHaveTextContent('{content, position, clock, clientID}')
    expect(surface).toHaveTextContent('map[string]*Room')
    expect(screen.queryByText('Mermaid Error')).not.toBeInTheDocument()
  })
})
