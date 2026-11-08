// @vitest-environment jsdom

import '@testing-library/jest-dom'
import { fireEvent, render, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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

  it.each(['composer', 'message'] as const)('shows Office annotation locations and requests in %s while retaining file actions', async (variant) => {
    const onRemove = vi.fn()
    const path = '/tmp/office-annotations/budget.xlsx'
    const view = render(
      <AttachmentGallery
        variant={variant}
        onRemove={variant === 'composer' ? onRemove : undefined}
        attachments={[{
          id: 'office-comment-1',
          type: 'file',
          name: 'budget.xlsx',
          path,
          note: 'Budget!B3\nChange the quantity to 5; keep the unit price unchanged.',
          quote: '3',
        }]}
      />,
    )

    // Office comments have no diffSide: their location and request used to disappear.
    expect(view.getByText(/Budget!B3/)).toHaveTextContent('Change the quantity to 5; keep the unit price unchanged.')
    expect(view.getByText('3')).toBeVisible()
    expect(view.queryByTestId('diff-comment-card')).not.toBeInTheDocument()
    if (variant === 'composer') {
      fireEvent.click(view.getByRole('button', { name: 'Remove budget.xlsx' }))
      expect(onRemove).toHaveBeenCalledWith('office-comment-1')
    } else {
      fireEvent.click(view.getByRole('button', { name: 'Open budget.xlsx' }))
      await waitFor(() => expect(openPath).toHaveBeenCalledWith(path))
      expect(view.getByRole('button', { name: 'Open with' })).toBeInTheDocument()
    }
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
    ['report.pdf', 'PDF', 'pdf'],
    ['brief.docx', 'DOCX', 'docx'],
    ['budget.xlsx', 'XLSX', 'xlsx'],
    ['launch.pptx', 'PPTX', 'pptx'],
    ['sources.zip', 'ZIP', 'zip'],
    ['notes.md', 'MD', 'markdown'],
  ])('renders a type-specific visual for %s', (name, extension, kind) => {
    const view = render(
      <AttachmentGallery
        attachments={[{
          type: 'file',
          name,
        }]}
      />,
    )

    expect(view.container.querySelector(`[data-file-extension="${extension}"]`)).toBeInTheDocument()
    expect(view.container.querySelector(`[data-file-type="${kind}"] svg`)).toBeInTheDocument()
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
          name: 'notes.md',
          path: '/Users/example/Desktop/notes.md',
        }]}
      />,
    )

    fireEvent.click(view.getByRole('button', { name: 'Open with' }))

    expect(await view.findByText('Open in VS Code')).toBeInTheDocument()
    expect(view.getByText('Default application')).toBeInTheDocument()
    expect(view.getByText('Reveal in Finder')).toBeInTheDocument()
    expect(openPath).not.toHaveBeenCalled()
  })

  it('leaves the editor out for an attachment no editor can open', async () => {
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

    expect(await view.findByText('Default application')).toBeInTheDocument()
    expect(view.queryByText('Open in VS Code')).not.toBeInTheDocument()
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

  it('lets the gallery hand the path-backed image to the system app', async () => {
    const view = render(
      <AttachmentGallery
        variant="composer"
        attachments={[{ id: 'pasted-1', type: 'image', name: 'shot.png', path: '/Users/nanmi/Desktop/shot.png' }]}
      />,
    )
    fireEvent.click(view.getByRole('button', { name: 'Open shot.png' }))

    fireEvent.click(await view.findByRole('button', { name: 'Open in system app' }))

    await waitFor(() => expect(openPath).toHaveBeenCalledWith('/Users/nanmi/Desktop/shot.png'))
  })

  it('offers no original to open for an image that has no file behind it', async () => {
    const view = render(
      <AttachmentGallery
        variant="composer"
        attachments={[{ id: 'inline-1', type: 'image', name: 'inline.png', previewUrl: 'data:image/png;base64,AAAA' }]}
      />,
    )
    fireEvent.click(view.getByRole('button', { name: 'Open inline.png' }))

    await view.findByText('1 / 1')
    expect(view.queryByRole('button', { name: 'Open in system app' })).not.toBeInTheDocument()
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

it.each(['composer', 'message'] as const)('labels a selected-text reference as text instead of a file in %s', (variant) => {
  useSettingsStore.setState({ locale: 'en' })
  const view = render(<AttachmentGallery variant={variant} attachments={[{ type: 'file', name: 'AI reply', quote: 'quoted text', referenceKind: 'chat-selection' }]} />)
  expect(view.getByText('Selected text')).toBeInTheDocument()
  expect(view.queryByText('File')).not.toBeInTheDocument()
})

/**
 * #1838: past a handful of selected-text references the composer's cards
 * wrapped onto row after row with nothing bounding them. The composer grew
 * until the transcript above it had no height left; at 20 cards in a 1280×820
 * window the editor and the send button went off the bottom as well.
 */
describe('composer attachment tray', () => {
  const selections = (count: number) => Array.from({ length: count }, (_, index) => ({
    id: `selection-${index}`,
    type: 'file' as const,
    name: `AI reply ${index}`,
    referenceKind: 'chat-selection' as const,
    quote: `quoted text ${index}`,
  }))

  beforeEach(() => {
    useSettingsStore.setState({ locale: 'en' })
  })

  it('scrolls a long run of cards inside a capped tray instead of growing the composer', () => {
    const view = render(<AttachmentGallery variant="composer" onRemove={vi.fn()} attachments={selections(20)} />)

    const tray = view.getByTestId('composer-attachment-tray')
    expect(tray.className).toMatch(/(^|\s)max-h-\[/)
    expect(tray).toHaveClass('overflow-y-auto')
    for (let index = 0; index < 20; index += 1) {
      expect(within(tray).getByRole('button', { name: `Remove AI reply ${index}` })).toBeInTheDocument()
    }
  })

  it('leaves the attachments of a sent message uncapped', () => {
    const view = render(<AttachmentGallery variant="message" attachments={selections(20)} />)

    expect(view.queryByTestId('composer-attachment-tray')).not.toBeInTheDocument()
  })

  describe('revealing a new card', () => {
    // jsdom has no layout. The stub puts the tray's visible box at 100–288px
    // and its cards two to a row on a 76px pitch, moved up by its scrollTop.
    const TRAY_TOP = 100
    const TRAY_BOTTOM = 288
    const originalRect = HTMLElement.prototype.getBoundingClientRect

    beforeEach(() => {
      HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect(this: HTMLElement) {
        const tray = this.closest<HTMLElement>('[data-testid="composer-attachment-tray"]')
        let box = { top: 0, bottom: 0 }
        if (tray === this) {
          box = { top: TRAY_TOP, bottom: TRAY_BOTTOM }
        } else if (tray && this.parentElement === tray) {
          const top = TRAY_TOP + 4 + Math.floor([...tray.children].indexOf(this) / 2) * 76 - tray.scrollTop
          box = { top, bottom: top + 68 }
        }
        return { left: 0, right: 0, width: 0, height: box.bottom - box.top, x: 0, y: box.top, toJSON: () => ({}), ...box } as DOMRect
      }
    })

    afterEach(() => {
      HTMLElement.prototype.getBoundingClientRect = originalRect
    })

    function trackScrollTop(tray: HTMLElement) {
      let scrollTop = 0
      Object.defineProperty(tray, 'scrollTop', {
        configurable: true,
        get: () => scrollTop,
        set: (value: number) => { scrollTop = value },
      })
    }

    it('scrolls a card added below the fold into view, and leaves the tray alone otherwise', () => {
      const attachments = selections(7)
      const view = render(<AttachmentGallery variant="composer" onRemove={vi.fn()} attachments={attachments.slice(0, 2)} />)
      const tray = view.getByTestId('composer-attachment-tray')
      trackScrollTop(tray)

      // Cards 3 and 4 open the second row, still inside the tray.
      view.rerender(<AttachmentGallery variant="composer" onRemove={vi.fn()} attachments={attachments.slice(0, 4)} />)
      expect(tray.scrollTop).toBe(0)

      // Card 7 opens a fourth row at 332–400px, 112px past the tray's edge.
      view.rerender(<AttachmentGallery variant="composer" onRemove={vi.fn()} attachments={attachments} />)
      expect(tray.scrollTop).toBe(112)

      // Removing a card is not an addition to reveal, even when the card left
      // last (256–324px with the tray back at the top) is out of view.
      tray.scrollTop = 0
      view.rerender(<AttachmentGallery variant="composer" onRemove={vi.fn()} attachments={attachments.slice(0, 6)} />)
      expect(tray.scrollTop).toBe(0)
    })

    it('reveals a file attached ahead of the references, not the last card', () => {
      const references = selections(6)
      const view = render(<AttachmentGallery variant="composer" onRemove={vi.fn()} attachments={references} />)
      const tray = view.getByTestId('composer-attachment-tray')
      trackScrollTop(tray)
      tray.scrollTop = 80

      // The composer lists uploads before references, so a new upload lands in
      // the first row: at 24px, above the visible box while the tray is scrolled.
      const upload = { id: 'upload-1', type: 'file' as const, name: 'notes.md', path: '/repo/notes.md' }
      view.rerender(<AttachmentGallery variant="composer" onRemove={vi.fn()} attachments={[upload, ...references]} />)

      expect(tray.scrollTop).toBe(4)
    })

    it('reveals a reference added again, which moves its card to the end', () => {
      const references = selections(6)
      const view = render(<AttachmentGallery variant="composer" onRemove={vi.fn()} attachments={references} />)
      const tray = view.getByTestId('composer-attachment-tray')
      trackScrollTop(tray)

      // The store drops the earlier copy and appends the reference again: no new
      // id, but the first card is now the sixth, at 256–324px.
      view.rerender(<AttachmentGallery variant="composer" onRemove={vi.fn()} attachments={[...references.slice(1), references[0]!]} />)

      expect(tray.scrollTop).toBe(36)
    })
  })
})
