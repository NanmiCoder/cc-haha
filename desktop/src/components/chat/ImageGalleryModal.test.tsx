import '@testing-library/jest-dom'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ImageGalleryModal } from './ImageGalleryModal'
import { browserHost } from '../../lib/desktopHost/browserHost'
import { openLocalFileWithSystem, reportOpenFailure } from '../../lib/systemFileOpen'
import { useSettingsStore } from '../../stores/settingsStore'

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

  it('uses an immersive media stage with a named close control', () => {
    render(<ImageGalleryModal open images={images} activeIndex={0} onClose={() => {}} onSelect={() => {}} />)

    expect(screen.getByRole('dialog', { name: 'a.png' })).toHaveClass('bg-[var(--color-media-bg)]')
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
