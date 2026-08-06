import '@testing-library/jest-dom'
import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ImageGalleryModal } from './ImageGalleryModal'
import { useOverlayStore } from '../../stores/overlayStore'
import { useSettingsStore } from '../../stores/settingsStore'

const images = [{ src: 'data:image/png;base64,AAAA', name: 'a.png' }]

const gallery = [
  { src: 'data:image/png;base64,AAAA', name: 'a.png' },
  { src: 'data:image/png;base64,BBBB', name: 'b.png' },
  { src: 'data:image/png;base64,CCCC', name: 'c.png' },
]

const reset = () => {
  useOverlayStore.setState(useOverlayStore.getInitialState(), true)
  useSettingsStore.setState({ locale: 'en' })
}

beforeEach(reset)
afterEach(reset)

describe('ImageGalleryModal · overlay suppression', () => {
  it('increments overlay count while open and decrements on unmount', () => {
    expect(useOverlayStore.getState().count).toBe(0)

    const { unmount } = render(
      <ImageGalleryModal
        open
        images={images}
        activeIndex={0}
        onClose={() => {}}
        onSelect={() => {}}
      />,
    )
    expect(useOverlayStore.getState().count).toBe(1)

    unmount()
    expect(useOverlayStore.getState().count).toBe(0)
  })

  it('does not increment when rendered with open=false', () => {
    const { unmount } = render(
      <ImageGalleryModal
        open={false}
        images={images}
        activeIndex={0}
        onClose={() => {}}
        onSelect={() => {}}
      />,
    )
    expect(useOverlayStore.getState().count).toBe(0)
    unmount()
    expect(useOverlayStore.getState().count).toBe(0)
  })

  it('toggles count when open prop flips closed → open → closed', () => {
    const { rerender, unmount } = render(
      <ImageGalleryModal
        open={false}
        images={images}
        activeIndex={0}
        onClose={() => {}}
        onSelect={() => {}}
      />,
    )
    expect(useOverlayStore.getState().count).toBe(0)

    rerender(
      <ImageGalleryModal
        open
        images={images}
        activeIndex={0}
        onClose={() => {}}
        onSelect={() => {}}
      />,
    )
    expect(useOverlayStore.getState().count).toBe(1)

    rerender(
      <ImageGalleryModal
        open={false}
        images={images}
        activeIndex={0}
        onClose={() => {}}
        onSelect={() => {}}
      />,
    )
    expect(useOverlayStore.getState().count).toBe(0)

    unmount()
    expect(useOverlayStore.getState().count).toBe(0)
  })
})

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

    expect(screen.getByRole('dialog', { name: 'a.png' })).toHaveClass('bg-[var(--color-terminal-bg)]')
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
