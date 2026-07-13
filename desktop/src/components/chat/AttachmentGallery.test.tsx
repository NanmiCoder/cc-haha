// @vitest-environment jsdom

import '@testing-library/jest-dom'
import { fireEvent, render } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useSettingsStore } from '../../stores/settingsStore'
import { AttachmentGallery } from './AttachmentGallery'

describe('AttachmentGallery', () => {
  beforeEach(() => {
    useSettingsStore.setState({ locale: 'en' })
  })

  it('renders diff comments as note-first composer cards with side-aware locations', () => {
    const view = render(
      <AttachmentGallery
        variant="composer"
        attachments={[{
          id: 'diff-comment-1',
          type: 'file',
          name: 'a.ts',
          path: 'src/a.ts',
          lineStart: 11,
          lineEnd: 12,
          diffSide: 'new',
          hunkId: 'hunk-1',
          note: 'Use a shared helper',
          quote: 'const result = buildResult()\nreturn result',
        }]}
      />,
    )

    const card = view.getByTestId('diff-comment-card')
    expect(card.textContent).toContain('src/a.ts · new L11-L12')
    expect(card.textContent).toContain('Use a shared helper')
    expect(card.textContent).toContain('const result = buildResult() return result')
    expect(card.textContent?.indexOf('Use a shared helper')).toBeLessThan(
      card.textContent?.indexOf('const result = buildResult()') ?? -1,
    )
  })

  it('renders a compact quote preview for selected workspace text', () => {
    render(
      <AttachmentGallery
        variant="composer"
        attachments={[{
          id: 'selection-1',
          type: 'file',
          name: 'App.tsx',
          path: 'src/App.tsx',
          lineStart: 10,
          lineEnd: 12,
          quote: 'const value = calculate(input)\nreturn value',
        }]}
      />,
    )

    expect(document.body.textContent).toContain('App.tsx:L10-L12')
    expect(document.body.textContent).toContain('const value = calculate(input) return value')
  })

  it('keeps plain file chips on the one-line treatment', () => {
    render(
      <AttachmentGallery
        variant="composer"
        attachments={[{
          id: 'file-1',
          type: 'file',
          name: 'README.md',
          path: 'README.md',
        }]}
      />,
    )

    expect(document.body.textContent).toContain('README.md')
    expect(document.body.textContent).not.toContain(':L')
  })

  it('removes a quoted workspace attachment by id', () => {
    const onRemove = vi.fn()

    const view = render(
      <AttachmentGallery
        variant="composer"
        onRemove={onRemove}
        attachments={[{
          id: 'selection-1',
          type: 'file',
          name: 'App.tsx',
          path: 'src/App.tsx',
          lineStart: 10,
          quote: 'const value = 1',
        }]}
      />,
    )

    fireEvent.click(view.getByRole('button', { name: 'Remove App.tsx' }))

    expect(onRemove).toHaveBeenCalledWith('selection-1')
  })

  it('shows a compact element chip for annotated selection images and exposes the note on hover', () => {
    const view = render(
      <AttachmentGallery
        variant="message"
        attachments={[{
          id: 'preview-selection',
          type: 'image',
          name: '<h1>',
          data: 'data:image/png;base64,AAAA',
          note: '这个标题更轻一点',
        }]}
      />,
    )

    expect(view.getByRole('button', { name: 'Open <h1>' })).toBeTruthy()
    const noteChip = view.getByLabelText('Selection note: 这个标题更轻一点')
    const tooltip = view.getByRole('tooltip')
    expect(noteChip.textContent).toContain('<h1>')
    expect(noteChip.getAttribute('title')).toBe('这个标题更轻一点')
    expect(noteChip).toHaveAttribute('aria-describedby', tooltip.id)
    expect(tooltip).toHaveTextContent('修改内容')
    expect(tooltip).toHaveTextContent('这个标题更轻一点')
    expect(tooltip.className).toContain('group-hover/selection:visible')
  })

  it('localizes diff sides and remove actions in Chinese', () => {
    useSettingsStore.setState({ locale: 'zh' })
    const view = render(
      <AttachmentGallery
        variant="composer"
        onRemove={vi.fn()}
        attachments={[{
          id: 'diff-comment-zh',
          type: 'file',
          name: 'a.ts',
          path: 'src/a.ts',
          lineStart: 11,
          diffSide: 'new',
          note: '使用共享辅助函数',
        }]}
      />,
    )

    expect(view.getByTestId('diff-comment-card')).toHaveTextContent('src/a.ts · 新 L11')
    expect(view.getByRole('button', { name: '移除 a.ts' })).toBeInTheDocument()
  })
})
