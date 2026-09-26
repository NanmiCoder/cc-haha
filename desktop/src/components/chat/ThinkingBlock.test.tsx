import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'

import { ThinkingBlock, thinkingPreview, formatThinkingDuration, formatThinkingTokens, thinkingBadgeLabel } from './ThinkingBlock'
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

describe('formatThinkingDuration', () => {
  it('shows one-decimal seconds under a minute', () => {
    expect(formatThinkingDuration(12300)).toBe('12.3s')
    expect(formatThinkingDuration(59400)).toBe('59.4s')
  })

  it('switches to whole minutes with zero-padded seconds at one minute', () => {
    expect(formatThinkingDuration(60000)).toBe('1m00s')
    expect(formatThinkingDuration(185000)).toBe('3m05s')
  })

  it('drops the seconds once the span reaches an hour', () => {
    expect(formatThinkingDuration(3600000)).toBe('1h00m')
    expect(formatThinkingDuration(7500000)).toBe('2h05m')
  })
})

describe('thinkingBadgeLabel', () => {
  it('joins the token count and duration for a settled block', () => {
    expect(thinkingBadgeLabel('思考'.repeat(400), 12340, 0, false, undefined)).toBe('0.80k · 12.3s')
  })

  it('shows nothing for empty content', () => {
    expect(thinkingBadgeLabel('   ', 12340, 0, false, undefined)).toBe('')
  })

  it('uses the live elapsed while active and anchored', () => {
    expect(thinkingBadgeLabel('reasoning', undefined, 20000, true, 1700000000000)).toBe(
      `${formatThinkingTokens('reasoning')} · 20.0s`,
    )
  })

  it('shows nothing for an active block with no start anchor', () => {
    expect(thinkingBadgeLabel('reasoning', undefined, 0, true, undefined)).toBe('')
  })

  it('shows the token count alone for a settled block with no recorded duration', () => {
    // Pre-feature transcripts never measured the wait — keep the token side of
    // the badge instead of dropping the whole thing.
    expect(thinkingBadgeLabel('reasoning', undefined, 0, false, undefined)).toBe(
      formatThinkingTokens('reasoning'),
    )
  })

  it('treats a zero duration as unmeasured rather than printing 0.0s', () => {
    // An unanchored block records no span; a literal `0.0s` would claim a
    // measurement that never happened.
    expect(thinkingBadgeLabel('reasoning', 0, 0, false, undefined)).toBe(
      formatThinkingTokens('reasoning'),
    )
    // A real (if short) span still renders with its duration.
    expect(thinkingBadgeLabel('reasoning', 1200, 0, false, undefined)).toBe(
      `${formatThinkingTokens('reasoning')} · 1.2s`,
    )
  })
})

describe('ThinkingBlock', () => {
  beforeEach(() => {
    useSettingsStore.setState({ locale: 'zh' })
  })

  afterEach(() => {
    cleanup()
    useSettingsStore.setState({ locale: 'zh', sessionExtendedInfo: true })
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

  it('shows the token + duration badge once thinking has settled', () => {
    // 800 CJK chars → estimateTokens ≈ 800 → "0.80k"; 12340ms → "12.3s".
    const content = '思考'.repeat(400)
    render(<ThinkingBlock content={content} thinkingDurationMs={12340} />)
    const badge = screen.getByText(/\d\.\d{2}k · \d+\.\ds/)
    expect(badge).toHaveTextContent('0.80k')
    expect(badge).toHaveTextContent('12.3s')
  })

  it('shows the token-only badge for a block with no recorded duration', () => {
    // No measured wait → the badge keeps its token side only (pre-feature
    // transcripts would otherwise render no badge at all).
    render(<ThinkingBlock content="reasoning..." isActive={false} />)
    expect(screen.getByText(formatThinkingTokens('reasoning...'))).toBeInTheDocument()
    expect(screen.queryByText(/\d\.\d{2}k · /)).toBeNull()
  })

  it('treats a still-active block without a start anchor as not yet showing a badge', () => {
    render(<ThinkingBlock content="reasoning..." isActive />)
    expect(screen.queryByText(/\d\.\d{2}k · /)).toBeNull()
  })

  it('hides the token + duration badge when session extended info is off', () => {
    useSettingsStore.setState({ sessionExtendedInfo: false })
    const { container } = render(<ThinkingBlock content={'思考'.repeat(400)} thinkingDurationMs={12340} />)
    // 徽标整体消失，思考正文与行标签照常渲染。
    expect(container.querySelector('[data-thinking-usage="true"]')).toBeNull()
    expect(screen.getByRole('button')).toHaveTextContent('已思考')
  })

  it('shows a live badge for an active block anchored to a start time', () => {
    // Active + a start anchor in the past → a non-zero live elapsed renders.
    render(<ThinkingBlock content="reasoning..." isActive liveStartAt={Date.now() - 20000} />)
    const badge = screen.getByText(/\d\.\d{2}k · /)
    expect(badge).toBeInTheDocument()
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
