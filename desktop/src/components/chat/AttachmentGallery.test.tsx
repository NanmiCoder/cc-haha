// @vitest-environment jsdom

import '@testing-library/jest-dom'
import { fireEvent, render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { AttachmentGallery } from './AttachmentGallery'

describe('AttachmentGallery', () => {
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

  it('renders image attachments from previewUrl without using the local path as img src', () => {
    const view = render(
      <AttachmentGallery
        variant="message"
        attachments={[{
          id: 'image-preview',
          type: 'image',
          name: 'chart.png',
          path: 'C:\\Users\\Ada\\Pictures\\chart.png',
          previewUrl: 'http://127.0.0.1:3456/api/filesystem/file?path=C%3A%5CUsers%5CAda%5CPictures%5Cchart.png',
        }]}
      />,
    )

    const image = view.getByAltText('chart.png')
    expect(image).toHaveAttribute('src', 'http://127.0.0.1:3456/api/filesystem/file?path=C%3A%5CUsers%5CAda%5CPictures%5Cchart.png')
    expect(image).not.toHaveAttribute('src', 'C:\\Users\\Ada\\Pictures\\chart.png')
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
})
