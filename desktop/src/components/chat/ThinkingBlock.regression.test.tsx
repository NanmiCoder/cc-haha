import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import { Marked } from 'marked'
import { ThinkingBlock } from '@/components/chat/ThinkingBlock'
import { splitStreamingMarkdown } from '@/lib/streamingMarkdownSegments'

const parse = new Marked({ gfm: true, breaks: true })
const paragraph = 'Long reasoning: ' + 'reasoning about the request '.repeat(100)
afterEach(cleanup)

function renderActive(content: string) {
  const result = render(<ThinkingBlock content={content} isActive />)
  fireEvent.click(screen.getByRole('button', { name: /思考中|Thinking/ }))
  return result
}

describe('ThinkingBlock streaming Markdown regressions', () => {
  it('keeps thinking typography on every active renderer', () => {
    const { container } = renderActive(paragraph + '\n\nStill streaming')
    const renderers = container.querySelectorAll('.markdown-prose')
    expect(renderers.length).toBeGreaterThan(0)
    for (const renderer of renderers) expect(renderer).toHaveClass('thinking-markdown')
  })

  it('does not split the body of a four-backtick fenced block at a shorter code example fence', () => {
    const content = '````md\n' + paragraph + '\n```\n\n**this stays in the code example**\n````\n\nStill streaming'
    const fullTokens = parse.lexer(content)
    expect(fullTokens.filter(t => t.type === 'code')).toHaveLength(1)
    expect(fullTokens[0]).toMatchObject({ type: 'code', text: expect.stringContaining('**this stays in the code example**') })
    const { container } = renderActive(content)
    expect(container.querySelectorAll('[data-code-viewer-content]')).toHaveLength(1)
    expect(container.querySelector('[data-code-viewer-content]')).toHaveTextContent('**this stays in the code example**')
    expect(container.querySelector('.markdown-prose strong')).toBeNull()
  })

  it('keeps all rows of a long GFM table rendered in the table while active', () => {
    const rows = Array.from({ length: 70 }, (_, index) => `| ${index} | ${'condition and consequence '.repeat(5)} |`)
    const content = '| Step | Reason |\n| --- | --- |\n' + rows.join('\n') + '\n\nStill streaming'
    const { container } = renderActive(content)
    expect(container.querySelectorAll('tbody tr')).toHaveLength(rows.length)
  })

  it('retains the resolved reference link in an earlier paragraph', () => {
    const content = paragraph + ' [the doc][doc]\n\n' + '[doc]: https://example.com/documentation\n\nStill streaming'
    const full = parse.parse(content) as string
    expect(full).toContain('href="https://example.com/documentation"')
    const { container } = renderActive(content)
    expect(container.querySelector('a[href="https://example.com/documentation"]')).not.toBeNull()
  })

  it('resolves an earlier link when its definition arrives in a later delta', () => {
    const before = paragraph + ' [the doc][doc]\n\nStill streaming'
    const { container, rerender } = renderActive(before)
    expect(container.querySelector('a[href="https://example.com/documentation"]')).toBeNull()

    rerender(<ThinkingBlock content={before + '\n\n[doc]: https://example.com/documentation'} isActive />)

    expect(container.querySelector('a[href="https://example.com/documentation"]')).not.toBeNull()
  })

  it('resolves a document-scoped link definition inside a block quote', () => {
    const content = paragraph + ' [the doc][doc]\n\n> [doc]: https://example.com/documentation\n\nStill streaming'
    expect(parse.parse(content)).toContain('href="https://example.com/documentation"')
    const { container } = renderActive(content)
    expect(container.querySelector('a[href="https://example.com/documentation"]')).not.toBeNull()
  })

  it('keeps the table header when the delimiter arrives incrementally at a fallback boundary', () => {
    const prefix = 'Reasoning '.repeat(590) + '\n| ' + 'field '.repeat(30) + ' | Other |\n'
    const before = prefix + '|'
    const content = prefix + '| --- | --- |\n| value | other |\n\nStill streaming'
    expect(parse.parse(content)).toContain('<table>')
    const previous = splitStreamingMarkdown(before)
    const { container, rerender } = renderActive(before)

    rerender(<ThinkingBlock content={content} isActive />)

    expect(container.querySelectorAll('table')).toHaveLength(1)
    expect(splitStreamingMarkdown(content, previous)).toEqual(splitStreamingMarkdown(content))
  })
})
