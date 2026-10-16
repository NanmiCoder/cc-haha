import '@testing-library/jest-dom'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

// getServerBaseUrl backs the relative-path src (/preview-fs/<sessionId>/...).
vi.mock('../../lib/desktopRuntime', () => ({
  getServerBaseUrl: () => 'http://127.0.0.1:4321',
}))

// The router reports whether it could place the link; a card the router places opens.
const openPreviewLink = vi.hoisted(() => vi.fn(() => true))
vi.mock('../../lib/openPreviewLink', () => ({ openPreviewLink }))
vi.mock('../../i18n', () => ({ useTranslation: () => (key: string) => key }))

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

  it('treats an empty changedFiles as no evidence for relative mentions', () => {
    const { container } = render(
      <InlineVideoGallery
        text={'render saved to outputs/demo.mp4'}
        sessionId="s1"
        workDir="/w"
        changedFiles={[]}
      />,
    )

    expect(videoSrcs(container)).toEqual(['http://127.0.0.1:4321/preview-fs/s1/outputs/demo.mp4'])
  })

  it('uses the local-file route for a changed video outside the workspace', () => {
    const { container } = render(
      <InlineVideoGallery
        text={'render saved to demo.mp4'}
        sessionId="s1"
        workDir="/w"
        changedFiles={['/outside/demo.mp4']}
      />,
    )

    expect(videoSrcs(container)).toEqual([
      'http://127.0.0.1:4321/local-file/outside/demo.mp4',
    ])
  })

  it.each([
    ['/outside/direct.mp4', 'http://127.0.0.1:4321/local-file/outside/direct.mp4'],
    ['D:\\outside\\direct.mp4', 'http://127.0.0.1:4321/local-file/D%3A/outside/direct.mp4'],
  ])('renders a directly mentioned changed video at %s', (filePath, expectedSrc) => {
    const { container } = render(
      <InlineVideoGallery
        text={`render saved to ${filePath}`}
        sessionId="s1"
        workDir="/w"
        changedFiles={[filePath]}
      />,
    )

    expect(videoSrcs(container)).toEqual([expectedSrc])
  })

  it('renders an absolute workspace video link only once', () => {
    const { container } = render(
      <InlineVideoGallery
        text={'[clip](/w/out/demo.mp4)'}
        sessionId="s1"
        workDir="/w"
        changedFiles={['/w/out/demo.mp4']}
      />,
    )

    expect(videoSrcs(container)).toEqual([
      'http://127.0.0.1:4321/local-file/w/out/demo.mp4',
    ])
  })

  it.each([undefined, []])('renders an external shell video without checkpoint evidence (%j)', (changedFiles) => {
    const { container } = render(
      <InlineVideoGallery text={'Saved to `/outside/render.mp4`'} sessionId="s1" workDir="/w" changedFiles={changedFiles} />,
    )
    expect(videoSrcs(container)).toEqual(['http://127.0.0.1:4321/local-file/outside/render.mp4'])
  })

  it.each(['outputs/render.mp4', '/outside/render.mp4', 'outputs/literal%20render.mp4'])(
    'keeps a failed preview available as an actionable file card (%s)', (path) => {
    const { container } = render(
      <InlineVideoGallery text={`Saved to ${path}`} sessionId="s1" workDir="/w" />,
    )
    fireEvent.error(container.querySelector('video')!)
    expect(container.querySelector('video')).toBeNull()
    expect(screen.getByText(path.split('/').pop()!)).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'assistantOutputs.openAria' }))
    expect(openPreviewLink).toHaveBeenCalledWith({ path }, 's1')
    expect(screen.getByRole('button', { name: 'openWith.title' })).toBeVisible()
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
