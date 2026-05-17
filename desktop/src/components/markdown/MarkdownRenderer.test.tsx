import { describe, it, expect, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'

vi.mock('../chat/CodeViewer', () => ({
  CodeViewer: ({ code, language }: { code: string; language?: string }) => (
    <div data-testid="code-viewer" data-language={language ?? ''}>
      {code}
    </div>
  ),
}))

vi.mock('../chat/MermaidRenderer', () => ({
  MermaidRenderer: ({ code }: { code: string }) => (
    <div data-testid="mermaid-renderer">{code}</div>
  ),
}))

import { MarkdownRenderer } from './MarkdownRenderer'

function visibleMathText(container: HTMLElement): string {
  const clone = container.cloneNode(true) as HTMLElement
  clone.querySelectorAll('annotation').forEach((node) => node.remove())
  return clone.textContent ?? ''
}

describe('MarkdownRenderer', () => {
  it('applies document prose classes and custom width classes', () => {
    const { container } = render(
      <MarkdownRenderer
        content={'# Skill Title\n\nReadable paragraph text.'}
        variant="document"
        className="mx-auto max-w-[72ch]"
      />,
    )

    const root = container.firstChild as HTMLDivElement
    expect(root).toBeInTheDocument()
    expect(root.className).toContain('prose-p:text-[15px]')
    expect(root.className).toContain('prose-h2:border-b')
    expect(root.className).toContain('mx-auto')
    expect(root.className).toContain('max-w-[72ch]')
    expect(screen.getByText('Skill Title')).toBeInTheDocument()
    expect(screen.getByText('Readable paragraph text.')).toBeInTheDocument()
  })

  it('keeps default variant free of document-only typography classes', () => {
    const { container } = render(
      <MarkdownRenderer content={'## Default Heading\n\nBody copy.'} />,
    )

    const root = container.firstChild as HTMLDivElement
    expect(root).toBeInTheDocument()
    expect(root.className).not.toContain('prose-p:text-[15px]')
    expect(root.className).not.toContain('prose-h2:border-b')
    expect(screen.getByText('Default Heading')).toBeInTheDocument()
    expect(screen.getByText('Body copy.')).toBeInTheDocument()
  })

  it('applies compact prose classes for dense surfaces', () => {
    const { container } = render(
      <MarkdownRenderer
        content={'**Done**\n\n- One\n- Two'}
        variant="compact"
      />,
    )

    const root = container.firstChild as HTMLDivElement
    expect(root).toBeInTheDocument()
    expect(root.className).toContain('prose-p:text-xs')
    expect(root.className).toContain('prose-li:text-xs')
    expect(screen.getByText('Done')).toBeInTheDocument()
    expect(screen.getByText('One')).toBeInTheDocument()
  })

  it('uses semantic code colors for inline code so both themes stay readable', () => {
    const { container } = render(
      <MarkdownRenderer content={'Use `claude-sonnet-4-6` for balanced speed.'} />,
    )

    const root = container.firstChild as HTMLDivElement
    expect(root).toBeInTheDocument()
    expect(root.className).toContain('prose-code:text-[var(--color-code-fg)]')
    expect(root.className).toContain('prose-code:bg-[var(--color-code-bg)]')
    expect(root.className).not.toContain('prose-code:text-[var(--color-primary-fixed)]')
    expect(screen.getByText('claude-sonnet-4-6')).toBeInTheDocument()
  })

  it('renders mermaid fenced blocks with the Mermaid renderer', () => {
    render(<MarkdownRenderer content={'```mermaid\ngraph TB\nA-->B\n```'} />)

    expect(screen.getByTestId('mermaid-renderer')).toHaveTextContent(
      /graph TB\s+A-->B/,
    )
    expect(screen.queryByTestId('code-viewer')).not.toBeInTheDocument()
  })

  it('detects mermaid diagrams even when the fence has no language tag', () => {
    render(<MarkdownRenderer content={'```\ngraph TB\nA-->B\n```'} />)

    expect(screen.getByTestId('mermaid-renderer')).toHaveTextContent(
      /graph TB\s+A-->B/,
    )
    expect(screen.queryByTestId('code-viewer')).not.toBeInTheDocument()
  })

  it('keeps non-mermaid code fences in the normal code viewer', () => {
    render(<MarkdownRenderer content={'```ts\nconst value = 1\n```'} />)

    expect(screen.getByTestId('code-viewer')).toHaveAttribute(
      'data-language',
      'ts',
    )
    expect(screen.queryByTestId('mermaid-renderer')).not.toBeInTheDocument()
  })

  it('renders inline and block LaTeX formulas with KaTeX', () => {
    const { container } = render(
      <MarkdownRenderer
        content={'Inline formula: $E = mc^2$\n\nBlock formula:\n\n$$\\int_0^1 x^2 \\, dx = \\frac{1}{3}$$'}
      />,
    )

    expect(container.querySelectorAll('.katex')).toHaveLength(2)
    expect(container.querySelectorAll('.katex-html')).toHaveLength(2)
    expect(container.querySelector('.katex-mathml')).not.toBeInTheDocument()
    expect(container.querySelector('.md-math-inline')).toBeInTheDocument()
    expect(container.querySelector('.md-math-display')).toBeInTheDocument()
    expect(container.textContent).not.toContain('$E = mc^2$')
    expect(container.textContent).not.toContain('$$')
  })

  it('renders multi-line display LaTeX formulas', () => {
    const { container } = render(
      <MarkdownRenderer
        content={'$$\n\\begin{aligned}\na &= b + c \\\\\nd &= e + f\n\\end{aligned}\n$$'}
      />,
    )

    expect(container.querySelector('.md-math-display .katex')).toBeInTheDocument()
  })

  it('renders bracket-delimited inline and display formulas', () => {
    const { container } = render(
      <MarkdownRenderer
        content={'圆面积是 \\(A = \\pi r^2\\)。\n\n\\[\nE = mc^2\n\\]'}
      />,
    )

    expect(container.querySelectorAll('.katex')).toHaveLength(2)
    expect(container.querySelector('.md-math-inline .katex')).toBeInTheDocument()
    expect(container.querySelector('.md-math-display .katex-display')).toBeInTheDocument()
    expect(container.textContent).not.toContain('\\(A = \\pi r^2\\)')
    expect(container.textContent).not.toContain('\\[')
  })

  it('renders complex display formulas without exposing TeX source', () => {
    const { container } = render(
      <MarkdownRenderer
        content={[
          '矩阵和分段函数：',
          '',
          '$$',
          '\\begin{bmatrix}1 & 2 \\\\ 3 & 4\\end{bmatrix}',
          '\\begin{bmatrix}x \\\\ y\\end{bmatrix}',
          '=',
          '\\begin{cases}',
          'x + 2y, & x > 0 \\\\',
          '3x + 4y, & x \\le 0',
          '\\end{cases}',
          '$$',
        ].join('\n')}
      />,
    )

    expect(container.querySelector('.md-math-display .katex')).toBeInTheDocument()
    expect(visibleMathText(container)).not.toContain('\\begin{bmatrix}')
    expect(visibleMathText(container)).not.toContain('\\begin{cases}')
  })

  it('keeps math layout protected from markdown forced wrapping rules', () => {
    const { container } = render(
      <MarkdownRenderer
        content={'Long display:\n\n$$\\sum_{i=1}^{n} \\left(y_i - \\hat{y}_i\\right)^2 + \\frac{\\alpha}{2}\\|w\\|_2^2 = \\mathcal{L}(w, b)$$'}
      />,
    )

    const root = container.firstChild as HTMLDivElement
    expect(root.className).toContain('[&_.katex]:[white-space:nowrap]')
    expect(root.className).toContain('[&_.katex]:[overflow-wrap:normal]')
    expect(root.className).toContain('[&_.md-math-display]:justify-center')
    expect(container.querySelector('.md-math-display .katex')).toBeInTheDocument()
  })

  it('does not treat escaped dollars or currency text as formulas', () => {
    const { container } = render(
      <MarkdownRenderer content={'Price is \\$5 and not math. Range is $5 to $10.'} />,
    )

    expect(container.querySelector('.katex')).not.toBeInTheDocument()
    expect(container.textContent).toContain('$5')
    expect(container.textContent).toContain('$10')
  })

  it('does not render LaTeX inside inline code or code fences', () => {
    const { container } = render(
      <MarkdownRenderer
        content={'Keep `$E = mc^2$` as code.\n\n```text\n$$\\int_0^1 x^2 dx$$\n```'}
      />,
    )

    expect(container.querySelector('.katex')).not.toBeInTheDocument()
    expect(screen.getByText('$E = mc^2$')).toBeInTheDocument()
    expect(screen.getByTestId('code-viewer')).toHaveTextContent('$$\\int_0^1 x^2 dx$$')
  })

  it('wraps markdown tables for horizontal overflow handling', () => {
    const { container } = render(
      <MarkdownRenderer
        content={'| Name | Value |\n| --- | --- |\n| `index.html` | Ready |'}
      />,
    )

    expect(container.querySelector('.md-table-wrap')).toBeInTheDocument()
    expect(screen.getByText('index.html')).toBeInTheDocument()
  })

  it('opens markdown links in a new tab safely', () => {
    render(<MarkdownRenderer content={'[OpenAI](https://openai.com)'} />)

    const link = screen.getByRole('link', { name: 'OpenAI' })
    expect(link).toHaveAttribute('target', '_blank')
    expect(link).toHaveAttribute('rel', expect.stringContaining('noopener'))
  })

  it('lets callers intercept markdown link clicks', () => {
    const onLinkClick = vi.fn().mockReturnValue(true)
    render(
      <MarkdownRenderer
        content={'[Manual](notes/manual.md)'}
        onLinkClick={onLinkClick}
      />,
    )

    fireEvent.click(screen.getByRole('link', { name: 'Manual' }))

    expect(onLinkClick).toHaveBeenCalledWith(
      'notes/manual.md',
      expect.objectContaining({ type: 'click' }),
    )
  })

  it('copies enhanced markdown button text with the legacy clipboard fallback', async () => {
    const originalClipboard = navigator.clipboard
    const originalExecCommand = document.execCommand
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: vi.fn().mockReturnValue(true),
    })
    const execCommand = vi.mocked(document.execCommand)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: vi.fn().mockRejectedValue(new Error('clipboard blocked')),
      },
    })
    const writeText = vi.mocked(navigator.clipboard.writeText)

    try {
      render(<MarkdownRenderer content={'<button data-copy-code="npm run verify">Copy</button>'} />)

      fireEvent.click(screen.getByRole('button', { name: 'Copy' }))

      await waitFor(() => {
        expect(execCommand).toHaveBeenCalledWith('copy')
      })
      expect(writeText).toHaveBeenCalledWith('npm run verify')
      expect(screen.getByRole('button', { name: 'Copied' })).toBeInTheDocument()
    } finally {
      Object.defineProperty(document, 'execCommand', {
        configurable: true,
        value: originalExecCommand,
      })
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: originalClipboard,
      })
    }
  })
})
