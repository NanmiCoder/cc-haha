import '@testing-library/jest-dom'
import { act, cleanup, createEvent, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { AttachmentGallery } from '@/components/chat/AttachmentGallery'
import { collectConversationImages } from '@/components/chat/conversationImages'
import { ImageGalleryModal } from './ImageGalleryModal'
import { browserHost } from '../../lib/desktopHost/browserHost'
import { openLocalFileWithSystem, reportOpenFailure } from '../../lib/systemFileOpen'
import { useSettingsStore } from '../../stores/settingsStore'
import { ConversationImageGalleryContext, type GalleryImage } from '@/components/chat/conversationImageGallery'

vi.mock('../../lib/systemFileOpen', () => ({
  openLocalFileWithSystem: vi.fn().mockResolvedValue(undefined),
  reportOpenFailure: vi.fn(),
}))

const images = [{ src: 'data:image/png;base64,AAAA', name: 'a.png' }]

const gallery = [
  { src: 'data:image/png;base64,AAAA', name: 'a.png' },
  { src: 'data:image/png;base64,BBBB', name: 'b.png' },
  { src: 'data:image/png;base64,CCCC', name: 'c.png' },
]

const reset = () => {
  useSettingsStore.setState({ locale: 'en' })
}

beforeEach(reset)
afterEach(reset)

describe('ImageGalleryModal · navigation', () => {
  it('names both arrows, which an icon-only control otherwise lacks', () => {
    render(<ImageGalleryModal open images={gallery} activeIndex={0} onClose={() => {}} onSelect={() => {}} />)

    expect(screen.getByRole('button', { name: 'Previous image' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Next image' })).toBeInTheDocument()
  })

  it('hides the arrows for a single image', () => {
    render(<ImageGalleryModal open images={images} activeIndex={0} onClose={() => {}} onSelect={() => {}} />)

    expect(screen.queryByRole('button', { name: 'Previous image' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Next image' })).not.toBeInTheDocument()
  })

  it('uses a transparent lightbox stage with named download and close controls', () => {
    render(<ImageGalleryModal open images={images} activeIndex={0} onClose={() => {}} onSelect={() => {}} />)

    const dialog = screen.getByRole('dialog', { name: 'a.png' })
    expect(dialog).not.toHaveClass('bg-[var(--color-media-bg)]', 'dialog-panel')
    expect(dialog.previousElementSibling).toHaveClass('bg-[var(--color-lightbox-scrim)]')
    expect(screen.getByRole('button', { name: 'Download image' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Close' })).toBeInTheDocument()
  })

  it('advances and wraps past the last image', () => {
    const onSelect = vi.fn()
    const { rerender } = render(
      <ImageGalleryModal open images={gallery} activeIndex={0} onClose={() => {}} onSelect={onSelect} />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Next image' }))
    expect(onSelect).toHaveBeenLastCalledWith(1)

    rerender(<ImageGalleryModal open images={gallery} activeIndex={2} onClose={() => {}} onSelect={onSelect} />)
    fireEvent.click(screen.getByRole('button', { name: 'Next image' }))
    expect(onSelect).toHaveBeenLastCalledWith(0)
  })

  it('closes on stage whitespace without closing on pictures, controls, or a pan gesture', () => {
    const onClose = vi.fn()
    render(<ImageGalleryModal open images={gallery} activeIndex={0} onClose={onClose} onSelect={() => {}} />)
    const image = screen.getByRole('img', { name: 'a.png' })
    const stage = screen.getByRole('group', { name: 'a.png' })
    const press = (node: Element) => {
      const event = createEvent.pointerDown(node)
      Object.defineProperties(event, { clientX: { value: 80 }, clientY: { value: 80 } })
      fireEvent(node, event)
    }
    fireEvent.click(image)
    fireEvent.click(screen.getByRole('button', { name: 'Next image' }))
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }))
    expect(onClose).not.toHaveBeenCalled()

    // Pointer capture can retarget a click from the picture to its scroll stage.
    press(image)
    fireEvent.click(stage, { clientX: 80, clientY: 80 })
    press(stage)
    fireEvent.click(stage, { clientX: 120, clientY: 80 })
    expect(onClose).not.toHaveBeenCalled()

    press(stage)
    fireEvent.click(stage, { clientX: 80, clientY: 80 })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('steps back and wraps before the first image', () => {
    const onSelect = vi.fn()
    render(<ImageGalleryModal open images={gallery} activeIndex={0} onClose={() => {}} onSelect={onSelect} />)

    fireEvent.click(screen.getByRole('button', { name: 'Previous image' }))
    expect(onSelect).toHaveBeenLastCalledWith(2)
  })

  it('navigates with the arrow keys, not only the buttons', () => {
    const onSelect = vi.fn()
    render(<ImageGalleryModal open images={gallery} activeIndex={1} onClose={() => {}} onSelect={onSelect} />)

    fireEvent.keyDown(document, { key: 'ArrowRight' })
    expect(onSelect).toHaveBeenLastCalledWith(2)

    fireEvent.keyDown(document, { key: 'ArrowLeft' })
    expect(onSelect).toHaveBeenLastCalledWith(0)
  })

  it('ignores arrow keys once closed', () => {
    const onSelect = vi.fn()
    const { rerender } = render(
      <ImageGalleryModal open images={gallery} activeIndex={0} onClose={() => {}} onSelect={onSelect} />,
    )
    rerender(<ImageGalleryModal open={false} images={gallery} activeIndex={0} onClose={() => {}} onSelect={onSelect} />)

    fireEvent.keyDown(document, { key: 'ArrowRight' })
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('shows the position and closes on Escape', () => {
    const onClose = vi.fn()
    render(<ImageGalleryModal open images={gallery} activeIndex={1} onClose={onClose} onSelect={() => {}} />)

    expect(screen.getByText('2 / 3')).toBeInTheDocument()

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalled()
  })
})

describe('ImageGalleryModal · conversation history', () => {
  it('opens the clicked picture in the full session and owns cross-message navigation', () => {
    const onSelect = vi.fn()
    const getImages = vi.fn(() => gallery)
    render(
      <ConversationImageGalleryContext.Provider value={getImages}>
        <ImageGalleryModal open images={[gallery[1]!]} activeIndex={0} onClose={() => {}} onSelect={onSelect} />
      </ConversationImageGalleryContext.Provider>,
    )

    expect(screen.getByText('2 / 3')).toBeInTheDocument()
    expect(screen.getByRole('dialog', { name: 'b.png' })).toBeInTheDocument()
    fireEvent.keyDown(document, { key: 'ArrowRight' })
    expect(screen.getByRole('dialog', { name: 'c.png' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Next image' }))
    expect(screen.getByRole('dialog', { name: 'a.png' })).toBeInTheDocument()
    expect(onSelect).not.toHaveBeenCalled()
    expect(getImages).toHaveBeenCalledTimes(1)
  })

  it('opens each uploaded snapshot even when both retain the same source filename', () => {
    const attachments = gallery.slice(0, 2).map((image) => ({
      type: 'image' as const, name: image.name, path: '/tmp/screenshot.png', data: image.src,
    }))
    const getImages = () => collectConversationImages([
      { id: 'user', type: 'user_text', content: 'Compare', timestamp: 1, attachments },
    ], { sessionId: 'snapshots', baseUrl: 'http://localhost', imageLabel: 'Image' })
    render(
      <ConversationImageGalleryContext.Provider value={getImages}>
        <AttachmentGallery attachments={attachments} />
      </ConversationImageGalleryContext.Provider>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Open a.png' }))
    expect(screen.getByText('1 / 2')).toBeInTheDocument()
    expect(screen.getByRole('dialog').querySelector('img')).toHaveAttribute('src', gallery[0]!.src)
    fireEvent.keyDown(document, { key: 'ArrowRight' })
    expect(screen.getByText('2 / 2')).toBeInTheDocument()
    expect(screen.getByRole('dialog').querySelector('img')).toHaveAttribute('src', gallery[1]!.src)
  })

  it('preserves navigation while disk-confirmed history is loading', async () => {
    let resolve!: (images: GalleryImage[]) => void
    const pending = new Promise<GalleryImage[]>((done) => { resolve = done })
    render(
      <ConversationImageGalleryContext.Provider value={() => pending}>
        <ImageGalleryModal open images={gallery.slice(1)} activeIndex={0} onClose={() => {}} onSelect={() => {}} />
      </ConversationImageGalleryContext.Provider>,
    )
    expect(screen.getByText('1 / 2')).toBeInTheDocument()
    fireEvent.keyDown(document, { key: 'ArrowRight' })
    await act(async () => resolve(gallery))
    expect(screen.getByText('3 / 3')).toBeInTheDocument()
    expect(screen.getByRole('dialog', { name: 'c.png' })).toBeInTheDocument()
    fireEvent.keyDown(document, { key: 'ArrowRight' })
    expect(screen.getByRole('dialog', { name: 'a.png' })).toBeInTheDocument()
  })

  it('ignores history completed after closing and keeps local pictures if a new load fails', async () => {
    let resolve!: (images: GalleryImage[]) => void
    const pending = new Promise<GalleryImage[]>((done) => { resolve = done })
    const getImages = vi.fn<() => Promise<GalleryImage[]>>().mockReturnValueOnce(pending).mockRejectedValueOnce(new Error('offline'))
    const view = (open: boolean) => (
      <ConversationImageGalleryContext.Provider value={getImages}>
        <ImageGalleryModal open={open} images={[gallery[1]!]} activeIndex={0} onClose={() => {}} onSelect={() => {}} />
      </ConversationImageGalleryContext.Provider>
    )
    const { rerender } = render(view(true))
    rerender(view(false))
    await act(async () => resolve(gallery))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    await act(async () => rerender(view(true)))
    expect(screen.getByText('1 / 1')).toBeInTheDocument()
    expect(screen.getByRole('dialog', { name: 'b.png' })).toBeInTheDocument()
  })

  it('retains its opening snapshot during streaming and refreshes it after reopening', () => {
    const extra = { src: 'data:image/png;base64,DDDD', name: 'new.png' }
    let conversation = gallery
    const getImages = () => conversation
    const view = (open: boolean) => (
      <ConversationImageGalleryContext.Provider value={getImages}>
        <ImageGalleryModal open={open} images={[gallery[0]!]} activeIndex={0} onClose={() => {}} onSelect={() => {}} />
      </ConversationImageGalleryContext.Provider>
    )
    const { rerender } = render(view(true))
    fireEvent.keyDown(document, { key: 'ArrowRight' })
    conversation = [...gallery, extra]
    rerender(view(true))
    expect(screen.getByText('2 / 3')).toBeInTheDocument()
    expect(screen.getByRole('dialog', { name: 'b.png' })).toBeInTheDocument()
    rerender(view(false))
    rerender(view(true))
    expect(screen.getByText('1 / 4')).toBeInTheDocument()
  })

  it('decodes only the active tool image and releases every gallery-owned blob URL', () => {
    let nextUrl = 0
    const create = vi.fn((_: Blob) => `blob:gallery-${++nextUrl}`)
    const revoke = vi.fn()
    const originalCreate = Object.getOwnPropertyDescriptor(URL, 'createObjectURL')
    const originalRevoke = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL')
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: create })
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revoke })
    try {
      const toolImages: GalleryImage[] = Array.from({ length: 30 }, (_, index) => ({
        src: '', name: `tool-${index}.png`, inline: { mediaType: 'image/png', data: btoa(`picture ${index}`) },
      }))
      const clicked = { ...toolImages[0]!, src: 'blob:source-row' }
      const { unmount } = render(
        <ConversationImageGalleryContext.Provider value={() => toolImages}>
          <ImageGalleryModal open images={[clicked]} activeIndex={0} onClose={() => {}} onSelect={() => {}} />
        </ConversationImageGalleryContext.Provider>,
      )
      expect(create).toHaveBeenCalledTimes(1)
      expect(screen.getByText('1 / 30')).toBeInTheDocument()
      expect(screen.getAllByRole('img').every((image) => image.getAttribute('src') !== 'blob:source-row')).toBe(true)
      fireEvent.click(screen.getByRole('button', { name: 'Previous image' }))
      expect(screen.getByText('30 / 30')).toBeInTheDocument()
      expect(create.mock.calls.length - revoke.mock.calls.length).toBe(1)
      unmount()
      expect(new Set(revoke.mock.calls.map(([url]) => url))).toEqual(new Set(create.mock.results.map(({ value }) => value)))
      expect(revoke).not.toHaveBeenCalledWith('blob:source-row')
    } finally {
      cleanup()
      if (originalCreate) Object.defineProperty(URL, 'createObjectURL', originalCreate)
      else Reflect.deleteProperty(URL, 'createObjectURL')
      if (originalRevoke) Object.defineProperty(URL, 'revokeObjectURL', originalRevoke)
      else Reflect.deleteProperty(URL, 'revokeObjectURL')
    }
  })

  it('keeps navigation available when a tool picture cannot decode', () => {
    const corrupt: GalleryImage = { src: '', name: 'corrupt.png', inline: { mediaType: 'image/png', data: 'invalid%%%' } }
    render(
      <ConversationImageGalleryContext.Provider value={() => [corrupt, gallery[0]!] }>
        <ImageGalleryModal open images={[corrupt]} activeIndex={0} onClose={() => {}} onSelect={() => {}} />
      </ConversationImageGalleryContext.Provider>,
    )
    expect(screen.getByRole('alert')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Next image' }))
    expect(screen.getByRole('dialog', { name: 'a.png' })).toBeInTheDocument()
  })
})

describe('ImageGalleryModal · closer look', () => {
  it('gives the picture the zoom controls of the workspace image viewer', () => {
    render(<ImageGalleryModal open images={images} activeIndex={0} onClose={() => {}} onSelect={() => {}} />)

    expect(screen.getByRole('group', { name: 'Zoom controls' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Zoom in' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Zoom out' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Fit to window' })).toBeInTheDocument()
  })

  it('shows the active picture in the viewer, and the next one when the reader moves on', () => {
    const { rerender } = render(<ImageGalleryModal open images={gallery} activeIndex={0} onClose={() => {}} onSelect={() => {}} />)
    const viewer = () => screen.getByRole('group', { name: /\.png$/ }).querySelector('img')!

    expect(viewer()).toHaveAttribute('src', 'data:image/png;base64,AAAA')

    rerender(<ImageGalleryModal open images={gallery} activeIndex={1} onClose={() => {}} onSelect={() => {}} />)

    expect(viewer()).toHaveAttribute('src', 'data:image/png;base64,BBBB')
  })

  it('starts each picture fitted: the zoom of the last one is not the next one\'s', () => {
    const { rerender } = render(<ImageGalleryModal open images={gallery} activeIndex={0} onClose={() => {}} onSelect={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }))
    expect(screen.getByRole('button', { name: 'Fit to window' })).toBeEnabled()

    rerender(<ImageGalleryModal open images={gallery} activeIndex={1} onClose={() => {}} onSelect={() => {}} />)

    expect(screen.getByRole('button', { name: 'Fit to window' })).toBeDisabled()
  })
})

describe('ImageGalleryModal · open the original', () => {
  const openPath = vi.fn().mockResolvedValue(undefined)
  const desktop = () => {
    window.desktopHost = {
      ...browserHost,
      kind: 'electron',
      isDesktop: true,
      capabilities: { ...browserHost.capabilities, shell: true },
      shell: { ...browserHost.shell, openPath },
    }
  }
  const withPath = (path?: string) => [{ src: 'blob:https://desktop.invalid/1', name: 'chart.png', ...(path ? { path } : {}) }]
  const original = () => screen.queryByRole('button', { name: 'Open in system app' })

  beforeEach(() => {
    openPath.mockClear()
    vi.mocked(openLocalFileWithSystem).mockClear()
    vi.mocked(reportOpenFailure).mockClear()
    Reflect.deleteProperty(window, 'desktopHost')
  })
  afterEach(() => {
    Reflect.deleteProperty(window, 'desktopHost')
  })

  it('offers it, in the desktop app, for a picture that is a file', () => {
    desktop()
    render(<ImageGalleryModal open images={withPath('/Users/me/chart.png')} activeIndex={0} onClose={() => {}} onSelect={() => {}} />)

    fireEvent.click(original()!)

    expect(openLocalFileWithSystem).toHaveBeenCalledWith('/Users/me/chart.png')
  })

  it.each([
    ['a Windows path', 'C:\\Users\\me\\chart.png'],
    ['a home-relative path', '~/Pictures/chart.png'],
  ])('offers it for %s too', (_label, path) => {
    desktop()
    render(<ImageGalleryModal open images={withPath(path)} activeIndex={0} onClose={() => {}} onSelect={() => {}} />)

    expect(original()).toBeInTheDocument()
  })

  it('offers it for the picture on show, not for another', () => {
    desktop()
    const both = [
      { src: 'blob:https://desktop.invalid/1', name: 'a.png', path: '/Users/me/a.png' },
      { src: 'blob:https://desktop.invalid/2', name: 'b.png' },
    ]
    const { rerender } = render(<ImageGalleryModal open images={both} activeIndex={0} onClose={() => {}} onSelect={() => {}} />)
    expect(original()).toBeInTheDocument()

    rerender(<ImageGalleryModal open images={both} activeIndex={1} onClose={() => {}} onSelect={() => {}} />)
    expect(original()).not.toBeInTheDocument()
  })

  it('does not offer it for a picture that is not a file: an inline one, a blob', () => {
    desktop()
    render(<ImageGalleryModal open images={withPath()} activeIndex={0} onClose={() => {}} onSelect={() => {}} />)

    expect(original()).not.toBeInTheDocument()
  })

  it('does not offer it for a relative path, which names no file to hand to the system', () => {
    desktop()
    render(<ImageGalleryModal open images={withPath('figures/chart.png')} activeIndex={0} onClose={() => {}} onSelect={() => {}} />)

    expect(original()).not.toBeInTheDocument()
  })

  it('does not offer it in a browser, where the "system" is the machine the server runs on', () => {
    render(<ImageGalleryModal open images={withPath('/Users/me/chart.png')} activeIndex={0} onClose={() => {}} onSelect={() => {}} />)

    expect(original()).not.toBeInTheDocument()
  })

  it('says so when the system could not open it, instead of doing nothing', async () => {
    desktop()
    vi.mocked(openLocalFileWithSystem).mockRejectedValueOnce(new Error('gone'))
    render(<ImageGalleryModal open images={withPath('/Users/me/chart.png')} activeIndex={0} onClose={() => {}} onSelect={() => {}} />)

    fireEvent.click(original()!)

    await waitFor(() => expect(reportOpenFailure).toHaveBeenCalledWith('/Users/me/chart.png'))
  })
})
