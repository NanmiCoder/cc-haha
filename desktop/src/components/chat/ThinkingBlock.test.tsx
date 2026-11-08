import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'

import { ThinkingBlock, thinkingPreview } from './ThinkingBlock'
import { useSettingsStore } from '../../stores/settingsStore'
import { clearDisclosureMemory } from '../../lib/disclosureMemory'

describe('thinkingPreview', () => {
  it('follows the tail while streaming so the row says what it is thinking now', () => {
    const content = 'Diagnosis complete:\nlint is clean\nnow checking the retry path'
    expect(thinkingPreview(content, { streaming: true })).toBe('now checking the retry path')
  })

  it('settles back onto the opening line once the block is done', () => {
    const content = 'The user ran the lifecycle suite and hit real failures.\nSo I will reset #7.'
    expect(thinkingPreview(content)).toBe('The user ran the lifecycle suite and hit real failures.')
  })

  it('skips an opening that is only a heading for what follows', () => {
    // `Diagnosis complete:` is the one line in the block that carries nothing.
    expect(thinkingPreview('Diagnosis complete:\nlint is clean, 2 files left')).toBe('lint is clean, 2 files left')
  })

  it('keeps a long opening that merely happens to end in a colon', () => {
    const content = 'The user wants me to handle GitHub issue #498 about the new KS signature, specifically:\n1. read the issue'
    expect(thinkingPreview(content)).toBe(
      'The user wants me to handle GitHub issue #498 about the new KS signature, specifically:',
    )
  })

  it('keeps a bare heading when it is all there is', () => {
    expect(thinkingPreview('Diagnosis complete:')).toBe('Diagnosis complete:')
  })
})

describe('ThinkingBlock', () => {
  beforeEach(() => {
    useSettingsStore.setState({ locale: 'zh' })
  })

  afterEach(() => {
    cleanup()
    useSettingsStore.setState({ locale: 'zh' })
  })

  it('shows the in-progress label while thinking is active', () => {
    render(<ThinkingBlock content="reasoning..." isActive />)
    expect(screen.getByRole('button')).toHaveTextContent('思考中')
    expect(screen.getByRole('button')).not.toHaveTextContent('已思考')
  })

  it('shows the done label once thinking has completed', () => {
    render(<ThinkingBlock content="reasoning..." isActive={false} />)
    expect(screen.getByRole('button')).toHaveTextContent('已思考')
    expect(screen.getByRole('button')).not.toHaveTextContent('思考中')
  })

  it('defaults to the done label when isActive is omitted', () => {
    render(<ThinkingBlock content="reasoning..." />)
    expect(screen.getByRole('button')).toHaveTextContent('已思考')
  })

  it('localizes both labels in English', () => {
    useSettingsStore.setState({ locale: 'en' })
    const { rerender } = render(<ThinkingBlock content="reasoning..." isActive />)
    expect(screen.getByRole('button')).toHaveTextContent('Thinking')
    rerender(<ThinkingBlock content="reasoning..." isActive={false} />)
    expect(screen.getByRole('button')).toHaveTextContent('Thought')
  })

  it('draws one upright row whose chevron turns and whose preview yields to the body when open', () => {
    // CJK has no italic: the old slanted row was the browser shearing glyphs.
    const { container } = render(<ThinkingBlock content={'Checking the retry path first'} />)
    const row = screen.getByRole('button')
    expect(container.querySelector('.italic')).toBeNull()
    expect(row.textContent).not.toMatch(/[▸▾]/)
    const chevron = row.querySelector('.lucide-chevron-right')
    expect(chevron).not.toBeNull()
    expect(chevron).not.toHaveClass('rotate-90')
    const preview = screen.getByText('Checking the retry path first')
    expect(preview).not.toHaveClass('invisible')

    fireEvent.click(row)

    expect(row.querySelector('.lucide-chevron-right')).toHaveClass('rotate-90')
    // Hidden but kept, so the row does not reflow when it opens.
    expect(preview).toHaveClass('invisible')
    expect(container.querySelector('[data-thinking-content="expanded"]')).toHaveClass('border-l')
  })

  it('leaves settled segments untouched while an expanded block streams', () => {
    // One renderer over the whole text re-parsed all of it on every delta, so a
    // long deliberation starved the paste or keystroke that arrived during it
    // (#1508). The settled segments must keep their DOM; only the tail changes.
    const paragraph = (index: number) => `Paragraph ${index}: ${'reasoning about the request '.repeat(40)}`.trim()
    const settled = Array.from({ length: 4 }, (_, index) => paragraph(index + 1)).join('\n\n')
    const before = `${settled}\n\nStill thinking about`
    const { container, rerender } = render(<ThinkingBlock content={before} isActive />)
    fireEvent.click(screen.getByRole('button'))
    const body = container.querySelector('[data-thinking-content="expanded"]')!
    const segmentsBefore = Array.from(body.querySelectorAll('.markdown-prose'))
    expect(segmentsBefore.length).toBeGreaterThan(1)
    const settledHtmlBefore = segmentsBefore.slice(0, -1).map((segment) => segment.innerHTML)

    rerender(<ThinkingBlock content={`${before} the retry path`} isActive />)

    const segmentsAfter = Array.from(body.querySelectorAll('.markdown-prose'))
    expect(segmentsAfter).toHaveLength(segmentsBefore.length)
    segmentsBefore.slice(0, -1).forEach((segment, index) => expect(segmentsAfter[index]).toBe(segment))
    expect(segmentsAfter.slice(0, -1).map((segment) => segment.innerHTML)).toEqual(settledHtmlBefore)
    expect(segmentsAfter.at(-1)).toHaveTextContent('Still thinking about the retry path')
    expect(body.textContent).toContain(paragraph(1))
    expect(body.textContent).toContain(paragraph(4))
  })

  it('renders the finished block whole again', () => {
    const paragraph = (index: number) => `Paragraph ${index}: ${'reasoning about the request '.repeat(40)}`.trim()
    const content = `${Array.from({ length: 4 }, (_, index) => paragraph(index + 1)).join('\n\n')}\n\nDone.`
    const { container, rerender } = render(<ThinkingBlock content={content} isActive />)
    fireEvent.click(screen.getByRole('button'))
    expect(container.querySelectorAll('.markdown-prose').length).toBeGreaterThan(1)
    expect(container.querySelector('.thinking-cursor')).not.toBeNull()

    rerender(<ThinkingBlock content={content} isActive={false} />)

    const bodies = container.querySelectorAll('.markdown-prose')
    expect(bodies).toHaveLength(1)
    expect(bodies[0]).toHaveClass('thinking-markdown')
    expect(bodies[0]).toHaveTextContent('Done.')
    expect(container.querySelector('.thinking-cursor')).toBeNull()
  })

  it('keeps the expanded state across a virtualized row unmount and remount', () => {
    // Virtualization unmounts rows outside the window. Losing the reader's
    // disclosure choice changes the row height on the way back, which is the
    // scroll jump this key exists to prevent.
    clearDisclosureMemory()
    const content = 'line one\nline two\nline three'
    const first = render(<ThinkingBlock content={content} disclosureKey="think-1" />)
    expect(first.container.querySelector('[data-thinking-content]')).toBeNull()
    fireEvent.click(screen.getByRole('button'))
    expect(first.container.querySelector('[data-thinking-content="expanded"]')).not.toBeNull()
    expect(first.container.querySelector('.markdown-prose')).toHaveClass('chat-reading-markdown')
    expect(screen.getByRole('button')).not.toHaveClass('chat-reading-markdown', 'chat-reading-text')
    first.unmount()
    const second = render(<ThinkingBlock content={content} disclosureKey="think-1" />)
    expect(second.container.querySelector('[data-thinking-content="expanded"]')).not.toBeNull()
  })
})
