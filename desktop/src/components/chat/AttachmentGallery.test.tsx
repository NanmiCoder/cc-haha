// @vitest-environment jsdom

import '@testing-library/jest-dom'
import { fireEvent, render, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { browserHost } from '../../lib/desktopHost/browserHost'
import { useOpenTargetStore } from '../../stores/openTargetStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { useUIStore } from '../../stores/uiStore'
import { AttachmentGallery } from './AttachmentGallery'

describe('AttachmentGallery', () => {
  const openPath = vi.fn().mockResolvedValue(undefined)

  beforeEach(() => {
    vi.clearAllMocks()
    useSettingsStore.setState({ locale: 'en' })
    useUIStore.setState({ toasts: [] })
    useOpenTargetStore.setState({
      targets: [
        { id: 'code', kind: 'ide', label: 'VS Code', icon: 'vscode', platform: 'darwin' },
        { id: 'finder', kind: 'file_manager', label: 'Finder', icon: 'finder', platform: 'darwin' },
      ],
      fetchedAt: Date.now(),
      loading: false,
      error: null,
      getTargetsForPath: vi.fn().mockResolvedValue([
        { id: 'code', kind: 'ide', label: 'VS Code', icon: 'vscode', platform: 'darwin' },
        { id: 'system-default', kind: 'system_default', label: 'System default', icon: 'system', platform: 'darwin' },
        { id: 'finder', kind: 'file_manager', label: 'Finder', icon: 'finder', platform: 'darwin' },
      ]),
    })
    window.desktopHost = {
      ...browserHost,
      kind: 'electron',
      isDesktop: true,
      capabilities: {
        ...browserHost.capabilities,
        shell: true,
      },
      shell: {
        ...browserHost.shell,
        openPath,
      },
    }
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

  it.each([
    ['report.pdf', 'PDF', 'picture_as_pdf'],
    ['brief.docx', 'DOCX', 'docs'],
    ['budget.xlsx', 'XLSX', 'table_chart'],
    ['launch.pptx', 'PPTX', 'slideshow'],
    ['sources.zip', 'ZIP', 'folder_zip'],
    ['notes.md', 'MD', 'markdown'],
  ])('renders a type-specific visual for %s', (name, extension, icon) => {
    const view = render(
      <AttachmentGallery
        attachments={[{
          type: 'file',
          name,
        }]}
      />,
    )

    expect(view.container.querySelector(`[data-file-extension="${extension}"]`)).toBeInTheDocument()
    expect(view.getByText(icon)).toBeInTheDocument()
  })

  it('opens an absolute desktop attachment with the system default app', async () => {
    const path = '/Users/example/Desktop/report.pdf'
    const view = render(
      <AttachmentGallery
        attachments={[{
          type: 'file',
          name: 'report.pdf',
          path,
        }]}
      />,
    )

    fireEvent.click(view.getByRole('button', { name: 'Open report.pdf' }))

    await waitFor(() => expect(openPath).toHaveBeenCalledWith(path))
  })

  it('keeps relative and pathless attachments non-interactive', () => {
    const view = render(
      <AttachmentGallery
        attachments={[
          { type: 'file', name: 'relative.md', path: 'docs/relative.md' },
          { type: 'file', name: 'detached.pdf' },
        ]}
      />,
    )

    expect(view.queryByRole('button', { name: 'Open relative.md' })).not.toBeInTheDocument()
    expect(view.queryByRole('button', { name: 'Open detached.pdf' })).not.toBeInTheDocument()
    expect(openPath).not.toHaveBeenCalled()
  })

  it('keeps absolute attachments non-interactive outside the desktop runtime', () => {
    window.desktopHost = browserHost
    const view = render(
      <AttachmentGallery
        attachments={[{
          type: 'file',
          name: 'report.pdf',
          path: '/Users/example/Desktop/report.pdf',
        }]}
      />,
    )

    expect(view.queryByRole('button', { name: 'Open report.pdf' })).not.toBeInTheDocument()
    expect(view.queryByRole('button', { name: 'Open with' })).not.toBeInTheDocument()
  })

  it('shows a localized toast when the local file cannot be opened', async () => {
    openPath.mockRejectedValueOnce(new Error('missing'))
    const view = render(
      <AttachmentGallery
        attachments={[{
          type: 'file',
          name: 'missing.pdf',
          path: '/Users/example/Desktop/missing.pdf',
        }]}
      />,
    )

    fireEvent.click(view.getByRole('button', { name: 'Open missing.pdf' }))

    await waitFor(() => {
      expect(useUIStore.getState().toasts.at(-1)?.message).toBe(
        'Could not open missing.pdf. The file may have been moved or deleted.',
      )
    })
  })

  it('reuses the Open With menu for IDE and file-manager destinations', async () => {
    const view = render(
      <AttachmentGallery
        attachments={[{
          type: 'file',
          name: 'report.pdf',
          path: '/Users/example/Desktop/report.pdf',
        }]}
      />,
    )

    fireEvent.click(view.getByRole('button', { name: 'Open with' }))

    expect(await view.findByText('Open in VS Code')).toBeInTheDocument()
    expect(view.getByText('Default application')).toBeInTheDocument()
    expect(view.getByText('Reveal in Finder')).toBeInTheDocument()
    expect(openPath).not.toHaveBeenCalled()
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
    expect(noteChip.textContent).toContain('<h1>')
    expect(noteChip.getAttribute('title')).toBe('这个标题更轻一点')

    // The note used to be a sibling span kept in the DOM and revealed by
    // `group-hover/selection:` classes. It is now the shared `Tooltip`, which
    // mounts into a portal only while hovered/focused — so the assertions moved
    // from "present but CSS-hidden" to "appears on pointer enter".
    expect(view.queryByRole('tooltip')).toBeNull()

    fireEvent.mouseEnter(noteChip)

    const tooltip = view.getByRole('tooltip')
    expect(noteChip).toHaveAttribute('aria-describedby', tooltip.id)
    // Was the literal '修改内容': the heading was hard-coded Chinese and so
    // rendered untranslated under every locale. This suite runs under `en`.
    expect(tooltip).toHaveTextContent('Requested changes')
    expect(tooltip).toHaveTextContent('这个标题更轻一点')

    fireEvent.mouseLeave(noteChip)
    expect(view.queryByRole('tooltip')).toBeNull()
  })

  it('groups numbered selection screenshots into one compact batch mosaic', () => {
    const view = render(
      <AttachmentGallery
        variant="message"
        attachments={[
          {
            id: 'selection-1',
            type: 'image',
            name: '<h1>',
            data: 'data:image/png;base64,AAAA',
            note: 'Make the title lighter',
            selectionNumber: 1,
          },
          {
            id: 'selection-3',
            type: 'image',
            name: '<button>',
            data: 'data:image/png;base64,BBBB',
            note: 'Increase emphasis',
            selectionNumber: 3,
          },
        ]}
      />,
    )

    expect(view.getByTestId('preview-selection-batch')).toHaveAttribute('aria-label', '2 selected page changes')
    expect(view.getByRole('button', { name: 'Selected element 1: <h1>' })).toHaveAttribute('data-selection-number', '1')
    expect(view.getByRole('button', { name: 'Selected element 3: <button>' })).toHaveAttribute('data-selection-number', '3')
    expect(view.getByText('Make the title lighter')).toBeInTheDocument()
    expect(view.queryByRole('button', { name: 'Open <h1>' })).not.toBeInTheDocument()
  })

  it('keeps one ordinary message image readable at its natural aspect ratio and opens it', async () => {
    const view = render(
      <AttachmentGallery
        variant="message"
        attachments={[{
          id: 'image-1',
          type: 'image',
          name: 'single.png',
          data: 'data:image/png;base64,AAAA',
        }]}
      />,
    )

    const button = view.getByRole('button', { name: 'Open single.png' })
    const image = button.querySelector('img')
    expect(image).toHaveClass('max-h-[340px]', 'w-full', 'max-w-[360px]')
    expect(image).not.toHaveClass('h-28', 'w-28')

    fireEvent.click(button)
    expect(await view.findByText('1 / 1')).toBeInTheDocument()
  })

  it.each([2, 5])('keeps %i ordinary message images in a bounded thumbnail gallery and opens the selected image', async (imageCount) => {
    const attachments = Array.from({ length: imageCount }, (_, index) => ({
      id: `image-${index + 1}`,
      type: 'image' as const,
      name: `image-${index + 1}.png`,
      data: `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="hsl(${index * 60} 60% 50%)"/></svg>`)}`,
    }))
    const view = render(
      <AttachmentGallery
        variant="message"
        attachments={attachments}
      />,
    )

    const imageButtons = attachments.map(({ name }) =>
      view.getByRole('button', { name: `Open ${name}` }))
    const gallery = imageButtons[0]?.parentElement?.parentElement

    expect(gallery).toHaveClass('max-w-full', 'flex-wrap')
    for (const button of imageButtons) {
      expect(button.parentElement?.parentElement).toBe(gallery)
      expect(button.querySelector('img')).toHaveClass('h-28', 'w-28')
    }

    fireEvent.click(imageButtons[imageCount - 1]!)
    expect(await view.findByText(`${imageCount} / ${imageCount}`)).toBeInTheDocument()
  })

  it('keeps the surviving image compact when another image in the original multi-image set fails', () => {
    const view = render(
      <AttachmentGallery
        variant="message"
        attachments={[
          { id: 'image-1', type: 'image', name: 'missing.png', data: 'data:image/png;base64,AAAA' },
          { id: 'image-2', type: 'image', name: 'kept.png', data: 'data:image/png;base64,BBBB' },
        ]}
      />,
    )

    fireEvent.error(view.getByRole('img', { name: 'missing.png' }))

    expect(view.getByRole('img', { name: 'kept.png' })).toHaveClass('h-28', 'w-28')
  })

  it('previews a path-only pasted image instead of a file chip', () => {
    const path = '/Users/nanmi/Desktop/6代码仓库.png'
    const view = render(
      <AttachmentGallery
        variant="message"
        attachments={[{ id: 'pasted-1', type: 'image', name: '6代码仓库.png', path }]}
      />,
    )

    const image = view.getByRole('img', { name: '6代码仓库.png' })
    expect(image).toHaveAttribute(
      'src',
      `http://127.0.0.1:3456/api/filesystem/file?path=${encodeURIComponent(path)}`,
    )
    expect(view.container.querySelector('[data-file-extension]')).not.toBeInTheDocument()
  })

  it('opens the path-only image preview in the gallery modal', async () => {
    const view = render(
      <AttachmentGallery
        variant="composer"
        attachments={[{ id: 'pasted-1', type: 'image', name: 'shot.png', path: '/Users/nanmi/Desktop/shot.png' }]}
      />,
    )

    const button = view.getByRole('button', { name: 'Open shot.png' })
    expect(button.querySelector('img')).toHaveClass('h-16', 'w-16')
    fireEvent.click(button)

    expect(await view.findByText('1 / 1')).toBeInTheDocument()
  })

  it('falls back to the file card when a path-only image cannot be loaded', () => {
    const view = render(
      <AttachmentGallery
        attachments={[{ id: 'pasted-1', type: 'image', name: 'moved.png', path: '/Volumes/external/moved.png' }]}
      />,
    )

    fireEvent.error(view.getByRole('img', { name: 'moved.png' }))

    expect(view.queryByRole('img', { name: 'moved.png' })).not.toBeInTheDocument()
    expect(view.container.querySelector('[data-file-extension="PNG"]')).toBeInTheDocument()
  })

  it('keeps relative image paths on the file card', () => {
    const view = render(
      <AttachmentGallery
        attachments={[{ id: 'relative-1', type: 'image', name: 'diagram.png', path: 'docs/diagram.png' }]}
      />,
    )

    expect(view.queryByRole('img')).not.toBeInTheDocument()
    expect(view.container.querySelector('[data-file-extension="PNG"]')).toBeInTheDocument()
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
