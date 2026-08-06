import '@testing-library/jest-dom'
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

// getBaseUrl backs the absolute-path src (/api/filesystem/file).
vi.mock('../../api/client', () => ({
  getBaseUrl: () => 'http://127.0.0.1:3456',
}))

// getServerBaseUrl backs the relative-path src (/preview-fs/<sessionId>/...).
vi.mock('../../lib/desktopRuntime', () => ({
  getServerBaseUrl: () => 'http://127.0.0.1:4321',
}))

import { InlineImageGallery } from './InlineImageGallery'

function imgSrcs(): string[] {
  return screen.getAllByRole('img').map((img) => (img as HTMLImageElement).getAttribute('src') ?? '')
}

describe('InlineImageGallery', () => {
  it('suppresses host-managed ImageGen paths when their dedicated card owns the image', () => {
    render(
      <InlineImageGallery
        text={'已生成：/Users/me/.claude/cc-haha/generated-images/session/result.png'}
        suppressManagedGeneratedImages
      />,
    )

    expect(screen.queryByRole('img')).not.toBeInTheDocument()
  })

  it('renders an absolute image path via /api/filesystem/file (legacy behavior)', () => {
    render(<InlineImageGallery text={'see /Users/me/out/result.png done'} />)

    const srcs = imgSrcs()
    expect(srcs).toHaveLength(1)
    expect(srcs[0]).toBe(
      'http://127.0.0.1:3456/api/filesystem/file?path=' + encodeURIComponent('/Users/me/out/result.png'),
    )
  })

  it('ignores relative workspace images when sessionId is absent', () => {
    render(<InlineImageGallery text={'output at outputs/a/frame.png'} />)
    expect(screen.queryAllByRole('img')).toHaveLength(0)
  })

  it('renders a relative workspace image via previewFsUrl when sessionId is provided', () => {
    render(
      <InlineImageGallery
        text={'render saved to outputs/a/frame.png'}
        sessionId="s1"
        workDir="/w"
      />,
    )

    const srcs = imgSrcs()
    expect(srcs).toHaveLength(1)
    expect(srcs[0]).toBe('http://127.0.0.1:4321/preview-fs/s1/outputs/a/frame.png')
  })

  it('uses the absolute-file route for a changed image outside the workspace', () => {
    render(
      <InlineImageGallery
        text={'render saved to result.png'}
        sessionId="s1"
        workDir="/w"
        changedFiles={['/outside/result.png']}
      />,
    )

    expect(imgSrcs()).toEqual([
      'http://127.0.0.1:3456/api/filesystem/file?path=' + encodeURIComponent('/outside/result.png'),
    ])
  })

  it('keeps an absolute image when the turn checkpoint recorded no changes (Bash writes are untracked)', () => {
    // Regression: a PIL/Bash-generated image at /tmp is invisible to the turn
    // checkpoint (filesChanged=[]), but the gallery must not filter it away.
    render(
      <InlineImageGallery
        text={'已生成，保存到 /tmp/result.png'}
        sessionId="s1"
        workDir="/w"
        changedFiles={[]}
      />,
    )

    expect(imgSrcs()).toEqual([
      'http://127.0.0.1:3456/api/filesystem/file?path=' + encodeURIComponent('/tmp/result.png'),
    ])
  })

  it('keeps an absolute image that is not among the turn changed files', () => {
    render(
      <InlineImageGallery
        text={'已生成，保存到 /tmp/result.png，同时更新了 app.ts'}
        sessionId="s1"
        workDir="/w"
        changedFiles={['/w/src/app.ts']}
      />,
    )

    expect(imgSrcs()).toEqual([
      'http://127.0.0.1:3456/api/filesystem/file?path=' + encodeURIComponent('/tmp/result.png'),
    ])
  })

  it('treats an empty changedFiles as no evidence for relative mentions', () => {
    render(
      <InlineImageGallery
        text={'render saved to outputs/a/frame.png'}
        sessionId="s1"
        workDir="/w"
        changedFiles={[]}
      />,
    )

    expect(imgSrcs()).toEqual(['http://127.0.0.1:4321/preview-fs/s1/outputs/a/frame.png'])
  })

  it('renders both absolute and relative images together', () => {
    render(
      <InlineImageGallery
        text={'abs /Users/me/pics/photo.png and rel outputs/b/chart.png'}
        sessionId="s1"
        workDir="/w"
      />,
    )

    const srcs = imgSrcs()
    expect(srcs).toEqual([
      'http://127.0.0.1:3456/api/filesystem/file?path=' + encodeURIComponent('/Users/me/pics/photo.png'),
      'http://127.0.0.1:4321/preview-fs/s1/outputs/b/chart.png',
    ])
  })

  it('scopes image hover overlays to each image tile', () => {
    render(
      <div className="group">
        <InlineImageGallery
          text={'abs /Users/me/pics/photo.png and rel outputs/b/chart.png'}
          sessionId="s1"
          workDir="/w"
        />
      </div>,
    )

    const firstTile = screen.getByRole('button', { name: /photo\.png/i })
    expect(firstTile).toHaveClass('group/image')
    expect(firstTile).not.toHaveClass('group')

    const overlay = firstTile.querySelector('.group-hover\\/image\\:opacity-100')
    expect(overlay).not.toBeNull()
    expect(firstTile.querySelector('.group-hover\\:opacity-100')).toBeNull()
  })

  it('does not render an in-workspace absolute path twice (dedup by basename)', () => {
    // The absolute path is INSIDE workDir, so extractAssistantOutputTargets also
    // surfaces it as a relative target (frame.png). It must only render once.
    render(
      <InlineImageGallery
        text={'saved /w/outputs/a/frame.png to disk'}
        sessionId="s1"
        workDir="/w"
      />,
    )

    const srcs = imgSrcs()
    expect(srcs).toHaveLength(1)
    expect(srcs[0]).toBe(
      'http://127.0.0.1:3456/api/filesystem/file?path=' + encodeURIComponent('/w/outputs/a/frame.png'),
    )
  })
})
