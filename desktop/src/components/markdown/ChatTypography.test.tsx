import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { MarkdownRenderer } from './MarkdownRenderer'
import { UserMessage } from '../chat/UserMessage'
import { AssistantMessage } from '../chat/AssistantMessage'

describe('chat reading preferences', () => {
  it('opts conversation prose into reading preferences without changing other markdown', () => {
    const content = '# Heading\n\nParagraph with `code`.\n\n- List item\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n```js\nconst value = 1\n```'
    const { container } = render(<>
      <AssistantMessage content={content} />
      <MarkdownRenderer content={content} variant="document" />
      <UserMessage content="My prompt" />
    </>)
    const roots = container.querySelectorAll('.markdown-prose')
    const conversation = roots[0]!
    const document = roots[1]!
    expect(conversation.classList.contains('chat-reading-markdown')).toBe(true)
    expect(document.classList.contains('chat-reading-markdown')).toBe(false)
    expect(container.querySelector('[data-message-body="user"]')?.classList.contains('chat-reading-text')).toBe(true)
    expect(conversation.querySelector('h1')).toBeTruthy()
    expect(conversation.querySelector('table')).toBeTruthy()
    const code = conversation.querySelector<HTMLElement>('[data-code-viewer-content]')
    expect(code?.style.fontSize).toBe('var(--code-viewer-font-size, 13px)')
    expect(code?.style.fontFamily).toBe('var(--font-mono)')
  })
})
