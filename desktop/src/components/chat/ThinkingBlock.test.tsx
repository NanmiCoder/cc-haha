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
    first.unmount()
    const second = render(<ThinkingBlock content={content} disclosureKey="think-1" />)
    expect(second.container.querySelector('[data-thinking-content="expanded"]')).not.toBeNull()
  })
})
