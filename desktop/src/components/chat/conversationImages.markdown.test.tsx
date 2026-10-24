import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { MarkdownRenderer } from '@/components/markdown/MarkdownRenderer'
import { collectConversationImages } from '@/components/chat/conversationImages'
import { createAssistantMarkdownImageResolver } from '@/lib/markdownImages'

const context = { sessionId: 'fixture', baseUrl: 'http://127.0.0.1:3456', workDir: '/repo', imageLabel: 'Image' }
const first = 'data:image/png;base64,AAAA'
const second = 'data:image/png;base64,BBBB'
const third = 'data:image/png;base64,CCCC'
const collect = (content: string) => collectConversationImages([
  { id: 'reply', type: 'assistant_text', content, timestamp: 1 },
], context).map((image) => image.src)

afterEach(cleanup)

describe('conversation gallery Markdown parity', () => {
  it.each([
    ['raw HTML', `<img alt="snapshot" src="${first}">`],
    ['reference Markdown', `![snapshot][picture]\n\n[picture]: ${first}`],
  ])('includes %s pictures from transcript rows that have never mounted', (_label, content) => {
    // Gallery collection precedes mounting: virtualized history cannot depend on DOM rows.
    const images = collect(content)
    const { container } = render(<MarkdownRenderer content={content} resolveImageSrc={createAssistantMarkdownImageResolver(context)} />)
    expect(container.querySelector('img')?.getAttribute('src')).toBe(first)
    expect(images).toEqual([first])
  })

  it('preserves mixed Markdown and HTML reading order across a fenced code block', () => {
    const content = [
      `![inline](${first})`,
      `\`\`\`html\n<img src="data:image/png;base64,DDDD">\n\`\`\``,
      `<img src="${second}" alt="HTML">`,
      `![reference][picture]\n\n[picture]: ${third}`,
    ].join('\n\n')
    expect(collect(content)).toEqual([first, second, third])
  })

  it('excludes code examples and images rejected by sanitization or the assistant URL policy', () => {
    const content = [
      `\`![code](${first})\``,
      `\`\`\`markdown\n![fenced](${second})\n\`\`\``,
      `<script><img src="${third}"></script>`,
      '<img src="javascript:alert(1)">',
      '<img src="data:text/html;base64,AAAA">',
      '<img src="https://tracker.invalid/pixel.png">',
    ].join('\n\n')
    const { container } = render(<MarkdownRenderer content={content} resolveImageSrc={createAssistantMarkdownImageResolver(context)} />)
    expect(container.querySelectorAll('img')).toHaveLength(0)
    expect(collect(content)).toEqual([])
  })

  it('ignores srcset sources and keeps managed generation images owned by their result card', () => {
    const managed = '/Users/me/.claude/cc-haha/generated-images/session/generated.png'
    expect(collect([
      `<img src="${first}" srcset="${second}">`,
      `<img src="${managed}">`,
      `![generated][result]\n\n[result]: ${managed}`,
    ].join('\n\n'))).toEqual([first])
  })
})
