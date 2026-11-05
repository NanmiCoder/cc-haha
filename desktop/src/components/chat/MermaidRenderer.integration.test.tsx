import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import mermaid from 'mermaid'

import { MermaidRenderer } from './MermaidRenderer'
import { useUIStore } from '../../stores/uiStore'

type SvgMeasurementPrototype = SVGElement & {
  getBBox?: () => { x: number; y: number; width: number; height: number }
  getComputedTextLength?: () => number
}

describe('MermaidRenderer Mermaid integration', () => {
  const svgPrototype = SVGElement.prototype as SvgMeasurementPrototype
  const originalBBox = Object.getOwnPropertyDescriptor(svgPrototype, 'getBBox')
  const originalTextLength = Object.getOwnPropertyDescriptor(svgPrototype, 'getComputedTextLength')

  beforeAll(async () => {
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

    // Mermaid lazily imports both the flowchart renderer and Dagre layout on
    // its first render. Await that real engine setup separately from the
    // component's ordinary DOM waits; cold Vite transforms can exceed 5 s.
    mermaid.initialize({ startOnLoad: false, htmlLabels: false, flowchart: { htmlLabels: false } })
    const { svg } = await mermaid.render('mermaid-integration-warmup', 'flowchart LR\nwarmupA[Initialize] --> warmupB[Ready]')
    expect(svg).toContain('<svg')
  }, 30_000)

  afterAll(() => {
    if (originalBBox) Object.defineProperty(svgPrototype, 'getBBox', originalBBox)
    else delete svgPrototype.getBBox
    if (originalTextLength) Object.defineProperty(svgPrototype, 'getComputedTextLength', originalTextLength)
    else delete svgPrototype.getComputedTextLength
  })

  beforeEach(() => {
    useUIStore.setState({ theme: 'white' })
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

  it('auto-quotes flowchart labels containing forward slashes to avoid lexical errors', async () => {
    render(
      <MermaidRenderer
        code={[
          'flowchart TD',
          '  D1[/api/dcl] --> D2[直接调用 dclService]',
          '  D2 --> R[返回结果]',
        ].join('\n')}
      />,
    )

    const surface = await screen.findByTestId('mermaid-diagram-surface')

    expect(surface).toHaveTextContent('/api/dcl')
    expect(surface).toHaveTextContent('直接调用 dclService')
    expect(screen.queryByText('Mermaid Error')).not.toBeInTheDocument()
  })

  it('preserves cylinder shapes whose quoted labels contain forward slashes', async () => {
    render(
      <MermaidRenderer
        code={[
          'flowchart LR',
          '    A["客户端 / Web"] --> B{"是否已登录 / 有权限？"}',
          '',
          '    subgraph S["服务端 / API 子图"]',
          '        B -- "是 / Yes" --> C[("用户数据库 / MySQL")]',
          '        B -- "否 / No" --> D["登录 / OAuth"]',
          '        D --> C',
          '    end',
          '',
          '    C --> E["返回结果 / JSON"]',
        ].join('\n')}
      />,
    )

    const surface = await screen.findByTestId('mermaid-diagram-surface')
    const databaseNode = Array.from(surface.querySelectorAll('.node'))
      .find((node) => node.textContent?.includes('用户数据库 / MySQL'))

    expect(surface).toHaveTextContent('用户数据库 / MySQL')
    expect(databaseNode?.querySelector('path')).toBeInTheDocument()
    expect(screen.queryByText('Mermaid Error')).not.toBeInTheDocument()
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
