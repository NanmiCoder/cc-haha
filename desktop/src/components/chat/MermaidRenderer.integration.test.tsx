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
          '  A["Company website"] --> B["Theme system"]',
          '  B --> C["Codex early stage"]',
        ].join('\n')}
      />,
    )

    const surface = await screen.findByTestId('mermaid-diagram-surface')

    expect(surface).toHaveTextContent('Company website')
    expect(surface).toHaveTextContent('Theme system')
    expect(surface).toHaveTextContent('Codex early stage')
    expect(surface.querySelector('svg')).not.toHaveAttribute('width', '100%')
    expect(surface.querySelector('[data-edge="true"]')?.getAttribute('style')).toContain('vector-effect: non-scaling-stroke')
    expect(surface.innerHTML).not.toContain('<script')
    expect(surface.innerHTML).not.toContain('onerror')
  })

  it('auto-quotes flowchart labels containing forward slashes to avoid lexical errors', async () => {
    render(
      <MermaidRenderer
        code={[
          'flowchart TD',
          '  D1[/api/dcl] --> D2[Call dclService directly]',
          '  D2 --> R[Return result]',
        ].join('\n')}
      />,
    )

    const surface = await screen.findByTestId('mermaid-diagram-surface')

    expect(surface).toHaveTextContent('/api/dcl')
    expect(surface).toHaveTextContent('Call dclService directly')
    expect(screen.queryByText('Mermaid Error')).not.toBeInTheDocument()
  })

  it('preserves cylinder shapes whose quoted labels contain forward slashes', async () => {
    render(
      <MermaidRenderer
        code={[
          'flowchart LR',
          '    A["Client / Web"] --> B{"Logged in / authorized?"}',
          '',
          '    subgraph S["Server / API subgraph"]',
          '        B -- "Yes" --> C[("User database / MySQL")]',
          '        B -- "No" --> D["Sign in / OAuth"]',
          '        D --> C',
          '    end',
          '',
          '    C --> E["Return result / JSON"]',
        ].join('\n')}
      />,
    )

    const surface = await screen.findByTestId('mermaid-diagram-surface')
    const databaseNode = Array.from(surface.querySelectorAll('.node'))
      .find((node) => node.textContent?.includes('User database / MySQL'))

    expect(surface).toHaveTextContent('User database / MySQL')
    expect(databaseNode?.querySelector('path')).toBeInTheDocument()
    expect(screen.queryByText('Mermaid Error')).not.toBeInTheDocument()
  })

  it('renders generated flowchart labels with HTML breaks and structural characters', async () => {
    render(
      <MermaidRenderer
        code={[
          'graph LR',
          '    subgraph "Yjs CRDT core"',
          '        Y[Yjs Document]',
          '        A[Embedded types<br/>Text / Map / Array]',
          '        I[Insert operation<br/>{content, position, clock, clientID}]',
          '        D[Delete operation<br/>{position, length, clock, clientID}]',
          '        RM[Room Manager<br/>map[string]*Room]',
          '    end',
          '    I --> Y',
          '    D --> Y',
          '    RM --> Y',
        ].join('\n')}
      />,
    )

    const surface = await screen.findByTestId('mermaid-diagram-surface')

    expect(surface).toHaveTextContent('Insert operation')
    expect(surface).toHaveTextContent('{content, position, clock, clientID}')
    expect(surface).toHaveTextContent('map[string]*Room')
    expect(screen.queryByText('Mermaid Error')).not.toBeInTheDocument()
  })
})
