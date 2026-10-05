import { beforeEach, describe, it, expect, vi } from 'vitest'
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

import { MarkdownRenderer, __markdownParseCacheInternals } from './MarkdownRenderer'
import { CODE_LINK_CLASS } from '../../lib/markdownAutolink'
import { useSettingsStore } from '../../stores/settingsStore'

beforeEach(() => {
  useSettingsStore.setState({ locale: 'zh' })
})

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

  it('gives default markdown lists enough inset to keep bullets inside message cards', () => {
    const { container } = render(
      <MarkdownRenderer content={'- First item\n- Second item'} />,
    )

    const root = container.firstChild as HTMLDivElement
    expect(root.className).toContain('prose-ul:pl-5')
    expect(root.className).toContain('prose-ol:pl-5')
    expect(root.className).toContain('prose-ul:list-outside')
    expect(root.className).toContain('prose-ol:list-outside')
    expect(screen.getByText('First item')).toBeInTheDocument()
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
    // A sunken chip, not a bordered box: regular weight, the shared
    // `surface-container` fill, the smallest radius and no outline.
    expect(root.className).toContain('prose-code:bg-[var(--color-surface-container)]')
    expect(root.className).toContain('prose-code:font-normal')
    expect(root.className).toContain('prose-code:rounded-[var(--radius-xs)]')
    expect(root.className).not.toContain('prose-code:border')
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

  it('keeps mermaid blocks in a generating state while assistant text is streaming', () => {
    render(<MarkdownRenderer content={'```mermaid\ngraph TB\nA-->B'} streaming />)

    expect(screen.getByTestId('mermaid-streaming-placeholder')).toHaveTextContent(
      '正在生成图表…',
    )
    expect(screen.queryByTestId('mermaid-renderer')).not.toBeInTheDocument()
    expect(screen.queryByTestId('code-viewer')).not.toBeInTheDocument()
  })

  it('does not render completed mermaid blocks until streaming has finalized', () => {
    render(<MarkdownRenderer content={'```mermaid\ngraph TB\nA-->B\n```'} streaming />)

    expect(screen.getByTestId('mermaid-streaming-placeholder')).toBeInTheDocument()
    expect(screen.queryByTestId('mermaid-renderer')).not.toBeInTheDocument()
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

  it('removes automatic network image sources from untrusted markdown', () => {
    const { container } = render(
      <MarkdownRenderer
        content={[
          '![loopback](http://127.0.0.1:3456/api/status)',
          '![remote](https://attacker.example/track.png)',
          '<img alt="responsive" srcset="https://attacker.example/a.png 1x">',
        ].join('\n')}
      />,
    )

    expect(container.querySelectorAll('img, source')).toHaveLength(0)
  })

  it('preserves local in-memory image sources in markdown', () => {
    const { container } = render(
      <MarkdownRenderer
        content={[
          '![inline](data:image/png;base64,AAAA)',
          '![object-url](blob:https://desktop.invalid/1234)',
        ].join('\n')}
      />,
    )

    const images = Array.from(container.querySelectorAll('img'))
    expect(images.map((image) => image.getAttribute('src'))).toEqual([
      'data:image/png;base64,AAAA',
      'blob:https://desktop.invalid/1234',
    ])
  })

  it('resolves every image source through resolveImageSrc when provided', () => {
    const { container } = render(
      <MarkdownRenderer
        content={[
          '![relative](assets/logo.png)',
          '![remote](https://img.shields.io/badge/stars-1k.svg)',
          '<img alt="raw-html" src="./raw.png">',
        ].join('\n')}
        resolveImageSrc={(src) => `resolved:${src}`}
      />,
    )

    const images = Array.from(container.querySelectorAll('img'))
    expect(images.map((image) => image.getAttribute('src'))).toEqual([
      'resolved:assets/logo.png',
      'resolved:https://img.shields.io/badge/stars-1k.svg',
      'resolved:./raw.png',
    ])
  })

  it('strips the image when resolveImageSrc returns null', () => {
    const { container } = render(
      <MarkdownRenderer
        content={[
          '![kept](keep.png)',
          '![dropped](drop.png)',
        ].join('\n')}
        resolveImageSrc={(src) => (src === 'drop.png' ? null : `resolved:${src}`)}
      />,
    )

    const images = Array.from(container.querySelectorAll('img'))
    expect(images).toHaveLength(1)
    expect(images[0]!.getAttribute('src')).toBe('resolved:keep.png')
  })

  it('strips style tags from assistant text before injecting markdown html', () => {
    const { container } = render(
      <MarkdownRenderer
        content={[
          '开始构建完整的 Web Linux 桌面环境。',
          '<function=Write>',
          '<parameter=content>',
          '<!DOCTYPE html>',
          '<html lang="zh-CN">',
          '<head>',
          '<style>',
          '* { margin: 0; padding: 0; box-sizing: border-box; user-select: none; }',
          'html, body { width: 100%; height: 100%; overflow: hidden; }',
          '</style>',
          '</head>',
          '<body>unsafe preview content</body>',
          '</html>',
        ].join('\n')}
      />,
    )

    expect(container.querySelector('style')).not.toBeInTheDocument()
    expect(container).not.toHaveTextContent('overflow: hidden')
    expect(screen.getByText(/开始构建完整的 Web Linux 桌面环境/)).toBeInTheDocument()
  })

  it('strips inline style attributes from assistant markdown html', () => {
    const { container } = render(
      <MarkdownRenderer
        content={'<div style="position: fixed; inset: 0; z-index: 999999">assistant text</div>'}
      />,
    )

    const injectedDiv = screen.getByText('assistant text')
    expect(injectedDiv).toBeInTheDocument()
    expect(injectedDiv).not.toHaveAttribute('style')
    expect(container.innerHTML).not.toContain('position: fixed')
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
      expect(screen.getByRole('button', { name: '已复制' })).toBeInTheDocument()
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

describe('MarkdownRenderer local image destinations', () => {
  // These are the shapes a model writes for a picture on disk. DOMPurify used to drop
  // the src of the first two (a `file:` scheme; `C:` read as a scheme), so the image
  // lost its source before the resolver ever saw it.
  function seenByResolver(markdown: string): string[] {
    const seen: string[] = []
    render(
      <MarkdownRenderer
        content={markdown}
        resolveImageSrc={(src) => {
          seen.push(src)
          return `resolved:${src}`
        }}
      />,
    )
    return seen
  }

  it.each([
    ['a file:// URL with a drive letter', '![chart](file:///C:/Users/me/chart.png)', '/C:/Users/me/chart.png'],
    ['a file:// URL', '![chart](file:///Users/me/chart.png)', '/Users/me/chart.png'],
    ['a Windows path with backslashes', '![chart](C:\\Users\\me\\chart.png)', '/C:/Users/me/chart.png'],
    ['a Windows path with slashes', '![chart](C:/Users/me/chart.png)', '/C:/Users/me/chart.png'],
    // Markdown reads `\.` and `\_` as escapes, but here the backslash is the separator.
    ['a Windows path through a hidden folder', '![chart](C:\\Users\\me\\.claude\\chart.png)', '/C:/Users/me/.claude/chart.png'],
    ['a Windows path through an underscored folder', '![chart](C:\\Users\\me\\_out\\chart.png)', '/C:/Users/me/_out/chart.png'],
    // The renderer escapes the space, as for any destination; the resolver decodes it.
    ['a Windows path in angle brackets, which may hold spaces and parentheses', '![chart](<C:\\Users\\me\\(new) pics\\chart.png>)', '/C:/Users/me/(new)%20pics/chart.png'],
    ['a home-relative path', '![chart](~/Pictures/chart.png)', '~/Pictures/chart.png'],
    ['an absolute POSIX path', '![chart](/Users/me/chart.png)', '/Users/me/chart.png'],
    ['a relative path', '![chart](figures/chart.png)', 'figures/chart.png'],
  ])('hands the resolver %s', (_label, markdown, expected) => {
    expect(seenByResolver(markdown)).toEqual([expected])
  })

  it('keeps a percent-escaped name as written, for the resolver to decode', () => {
    expect(seenByResolver('![chart](file:///Users/me/My%20Pics/chart.png)')).toEqual(['/Users/me/My%20Pics/chart.png'])
  })

  it('still strips a file:// URL that names no local root, and a script scheme', () => {
    const seen = seenByResolver([
      '![unc](file://server/share/chart.png)',
      '![script](javascript:alert(1))',
    ].join('\n\n'))

    expect(seen).toEqual([])
  })

  it('does not rewrite a raw HTML image, which the author did not write as Markdown', () => {
    expect(seenByResolver('<img alt="raw" src="file:///Users/me/chart.png">')).toEqual([])
  })
})

describe('MarkdownRenderer image clicks', () => {
  const TWO_IMAGES = '![one](data:image/png;base64,AAAA)\n\n![two](blob:https://desktop.invalid/2)'

  it('reports the image that was clicked, with every image in the text and its place among them', () => {
    const onImageClick = vi.fn()
    const { container } = render(<MarkdownRenderer content={TWO_IMAGES} onImageClick={onImageClick} />)

    fireEvent.click(container.querySelectorAll('img')[1]!)

    expect(onImageClick).toHaveBeenCalledExactlyOnceWith({
      images: [
        { src: 'data:image/png;base64,AAAA', alt: 'one' },
        { src: 'blob:https://desktop.invalid/2', alt: 'two' },
      ],
      index: 1,
    })
  })

  it('counts the images across code blocks, which split the text into parts', () => {
    const onImageClick = vi.fn()
    const { container } = render(
      <MarkdownRenderer
        content={'![one](data:image/png;base64,AAAA)\n\n```js\nconst x = 1\n```\n\n![two](blob:https://desktop.invalid/2)'}
        onImageClick={onImageClick}
      />,
    )

    fireEvent.click(container.querySelectorAll('img')[1]!)

    expect(onImageClick.mock.calls[0]![0]).toMatchObject({ index: 1 })
    expect(onImageClick.mock.calls[0]![0].images).toHaveLength(2)
  })

  it('reports the resolved source, since that is the one that loads', () => {
    const onImageClick = vi.fn()
    const { container } = render(
      <MarkdownRenderer content="![chart](figures/chart.png)" resolveImageSrc={(src) => `http://127.0.0.1:3456/${src}`} onImageClick={onImageClick} />,
    )

    fireEvent.click(container.querySelector('img')!)

    expect(onImageClick.mock.calls[0]![0].images).toEqual([{ src: 'http://127.0.0.1:3456/figures/chart.png', alt: 'chart' }])
  })

  it('leaves an image inside a link to the link', () => {
    const onImageClick = vi.fn()
    const onLinkClick = vi.fn(() => false)
    const { container } = render(
      <MarkdownRenderer
        content="[![badge](data:image/png;base64,AAAA)](https://example.com)"
        onImageClick={onImageClick}
        onLinkClick={onLinkClick}
      />,
    )

    fireEvent.click(container.querySelector('img')!)

    expect(onImageClick).not.toHaveBeenCalled()
    expect(onLinkClick).toHaveBeenCalledTimes(1)
  })

  it('ignores a picture that has lost its source: there is nothing to show', () => {
    const onImageClick = vi.fn()
    const { container } = render(<MarkdownRenderer content={TWO_IMAGES} onImageClick={onImageClick} />)
    const [first] = Array.from(container.querySelectorAll('img'))
    first!.removeAttribute('src')

    fireEvent.click(first!)

    expect(onImageClick).not.toHaveBeenCalled()
  })

  it('ignores a click that is not on an image', () => {
    const onImageClick = vi.fn()
    render(<MarkdownRenderer content={`words\n\n${TWO_IMAGES}`} onImageClick={onImageClick} />)

    fireEvent.click(screen.getByText('words'))

    expect(onImageClick).not.toHaveBeenCalled()
  })

  it('does nothing about an image click when nobody asked to hear about it', () => {
    const { container } = render(<MarkdownRenderer content={TWO_IMAGES} />)

    expect(() => fireEvent.click(container.querySelector('img')!)).not.toThrow()
  })

  it('shows the zoom cursor on images only when a click will be handled', () => {
    const { container, rerender } = render(<MarkdownRenderer content={TWO_IMAGES} />)
    expect(container.firstElementChild!.className).not.toContain('cursor-zoom-in')

    rerender(<MarkdownRenderer content={TWO_IMAGES} onImageClick={() => undefined} />)
    expect(container.firstElementChild!.className).toContain('[&_img]:cursor-zoom-in')
  })
})

describe('MarkdownRenderer parse cache', () => {
  beforeEach(() => {
    __markdownParseCacheInternals.reset()
  })

  it('uses the finalized cache for non-streaming content and hits on the second render', () => {
    const content = '# heading one\n\nbody text body text'
    render(<MarkdownRenderer content={content} />)
    expect(__markdownParseCacheInternals.hasFinalized(content)).toBe(true)
    expect(__markdownParseCacheInternals.finalizedSize()).toBe(1)

    const beforeChars = __markdownParseCacheInternals.finalizedChars()
    render(<MarkdownRenderer content={content} />)
    expect(__markdownParseCacheInternals.finalizedSize()).toBe(1)
    expect(__markdownParseCacheInternals.finalizedChars()).toBe(beforeChars)
  })

  it('routes streaming content into the streaming cache without evicting finalized entries', () => {
    const finalizedContent = 'finalized assistant turn text'
    render(<MarkdownRenderer content={finalizedContent} />)
    expect(__markdownParseCacheInternals.hasFinalized(finalizedContent)).toBe(true)

    for (let i = 0; i < 8; i++) {
      const chunk = `streaming partial ${i.toString().repeat(20)}`
      render(<MarkdownRenderer content={chunk} streaming />)
    }

    expect(__markdownParseCacheInternals.hasFinalized(finalizedContent)).toBe(true)
    expect(__markdownParseCacheInternals.streamingSize()).toBeLessThanOrEqual(4)
  })

  it('caps the finalized cache to roughly 200 entries', () => {
    for (let i = 0; i < 220; i++) {
      render(<MarkdownRenderer content={`entry ${i} content body`} />)
    }
    expect(__markdownParseCacheInternals.finalizedSize()).toBeLessThanOrEqual(200)
  })
})

// Regression cover for #1145. marked's built-in GFM autolink only trims ASCII
// trailing punctuation, so in Chinese prose the rest of the sentence used to end
// up inside the href — the link rendered, but clicking it loaded a 404.
describe('MarkdownRenderer bare-URL autolink', () => {
  const anchorsOf = (container: HTMLElement) =>
    [...container.querySelectorAll('a')].map((a) => ({
      href: a.getAttribute('href'),
      text: a.textContent,
    }))

  it.each([
    ['开发服务器已启动：http://localhost:3000。', 'http://localhost:3000'],
    ['打开 http://localhost:5173，然后刷新页面', 'http://localhost:5173'],
    ['服务在http://localhost:3000上运行', 'http://localhost:3000'],
    ['打开（http://localhost:3000）看看', 'http://localhost:3000'],
    ['前端已启动，请访问 http://localhost:3000 查看效果', 'http://localhost:3000'],
  ])('stops the href at the URL boundary in %j', (content, href) => {
    const { container } = render(<MarkdownRenderer content={content} />)
    expect(anchorsOf(container)).toEqual([{ href, text: href }])
  })

  it('leaves the trailing Chinese text outside the link', () => {
    const { container } = render(
      <MarkdownRenderer content={'打开 http://localhost:5173，然后刷新页面'} />,
    )
    expect(container.textContent).toContain('，然后刷新页面')
    expect(container.querySelector('a')?.textContent).toBe('http://localhost:5173')
  })

  it('still autolinks schemeless www hosts through the built-in tokenizer', () => {
    const { container } = render(<MarkdownRenderer content={'裸域名 www.example.com 呢'} />)
    expect(anchorsOf(container)).toEqual([
      { href: 'http://www.example.com', text: 'www.example.com' },
    ])
  })

  it('does not nest a link when the markdown label is itself a URL', () => {
    const { container } = render(
      <MarkdownRenderer content={'见 [http://localhost:3000](http://localhost:3000/real)'} />,
    )
    expect(anchorsOf(container)).toEqual([
      { href: 'http://localhost:3000/real', text: 'http://localhost:3000' },
    ])
  })

  it('leaves URLs inside a fenced code block alone', () => {
    const { container } = render(
      <MarkdownRenderer content={'```log\n[INFO] 代理地址: http://127.0.0.1:15721\n```'} />,
    )
    expect(container.querySelectorAll('a')).toHaveLength(0)
    expect(screen.getByTestId('code-viewer')).toBeInTheDocument()
  })

  it('links inline code that is nothing but a URL, keeping the code chip', () => {
    const { container } = render(
      <MarkdownRenderer content={'访问 `http://localhost:3000` 就能看到'} />,
    )
    const anchor = container.querySelector('a')
    expect(anchor?.getAttribute('href')).toBe('http://localhost:3000')
    expect(anchor?.className).toContain('md-code-link')
    expect(anchor?.querySelector('code')?.textContent).toBe('http://localhost:3000')
  })

  it('leaves inline code that is a command as plain code', () => {
    const { container } = render(
      <MarkdownRenderer content={'跑 `curl http://localhost:3000` 试试'} />,
    )
    expect(container.querySelectorAll('a')).toHaveLength(0)
    expect(container.querySelector('code')?.textContent).toBe('curl http://localhost:3000')
  })

  it('escapes markup inside a non-URL code span', () => {
    const { container } = render(<MarkdownRenderer content={'用 `<script>x</script>` 试试'} />)
    expect(container.querySelectorAll('script')).toHaveLength(0)
    expect(container.querySelector('code')?.textContent).toBe('<script>x</script>')
  })

  // The accent is only ~2:1 against body text (see theme/contrast.test.ts), so
  // color alone cannot mark a link — the resting underline is load-bearing here,
  // not decoration.
  it('gives links a resting underline so they read as clickable', () => {
    const { container } = render(<MarkdownRenderer content={'看 http://localhost:3000'} />)
    const root = container.firstChild as HTMLDivElement
    expect(root.className).toContain('prose-a:underline')
    expect(root.className).toContain('prose-a:decoration-[var(--color-text-accent)]')
    expect(root.className).not.toContain('prose-a:no-underline')
  })

  // The prose variant spells the class out so Tailwind can see it; this ties that
  // literal back to the constant the renderer actually emits.
  it('styles the code-link class the renderer emits', () => {
    const { container } = render(<MarkdownRenderer content={'看 `http://localhost:3000`'} />)
    const root = container.firstChild as HTMLDivElement
    expect(root.className).toContain(`[&_a.${CODE_LINK_CLASS}]:no-underline`)
    expect(container.querySelector('a')?.className).toContain(CODE_LINK_CLASS)
  })
})
