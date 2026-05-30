import '@testing-library/jest-dom'
import { render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

// getServerBaseUrl backs the relative-path src (/preview-fs/<sessionId>/...).
vi.mock('../../lib/desktopRuntime', () => ({
  getServerBaseUrl: () => 'http://127.0.0.1:4321',
}))

import { InlineVideoGallery } from './InlineVideoGallery'

function videoSrcs(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll('video')).map((v) => v.getAttribute('src') ?? '')
}

describe('InlineVideoGallery', () => {
  it('renders a relative workspace video via previewFsUrl when sessionId is provided', () => {
    const { container } = render(
      <InlineVideoGallery text={'render saved to outputs/demo.mp4'} sessionId="s1" workDir="/w" />,
    )

    const srcs = videoSrcs(container)
    expect(srcs).toHaveLength(1)
    expect(srcs[0]).toBe('http://127.0.0.1:4321/preview-fs/s1/outputs/demo.mp4')
  })

  it('uses preload="metadata" and never autoplays', () => {
    const { container } = render(
      <InlineVideoGallery text={'clip at outputs/demo.mp4'} sessionId="s1" workDir="/w" />,
    )

    const video = container.querySelector('video')!
    expect(video).toHaveAttribute('preload', 'metadata')
    expect(video).not.toHaveAttribute('autoplay')
    expect(video).not.toHaveAttribute('loop')
  })

  it('renders nothing when sessionId is absent', () => {
    const { container } = render(<InlineVideoGallery text={'clip at outputs/demo.mp4'} />)
    expect(container.querySelectorAll('video')).toHaveLength(0)
  })

  it('renders nothing when there are no video paths', () => {
    const { container } = render(
      <InlineVideoGallery text={'just some text and an image outputs/a.png'} sessionId="s1" workDir="/w" />,
    )
    expect(container.querySelectorAll('video')).toHaveLength(0)
  })

  it('deduplicates a repeated video path', () => {
    const { container } = render(
      <InlineVideoGallery
        text={'see outputs/demo.mp4 and again outputs/demo.mp4'}
        sessionId="s1"
        workDir="/w"
      />,
    )
    expect(container.querySelectorAll('video')).toHaveLength(1)
  })
})
