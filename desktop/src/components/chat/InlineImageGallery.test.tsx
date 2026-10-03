import '@testing-library/jest-dom'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { browserHost } from '../../lib/desktopHost/browserHost'

// getBaseUrl backs the absolute-path src (/api/filesystem/file).
vi.mock('../../api/client', () => ({
  getBaseUrl: () => 'http://127.0.0.1:3456',
}))

// getServerBaseUrl backs the relative-path src (/preview-fs/<sessionId>/...).
vi.mock('../../lib/desktopRuntime', () => ({
  getServerBaseUrl: () => 'http://127.0.0.1:4321',
}))

// The authenticated fallback an <img> error falls back to. It rejects by default,
// which is what a missing or denied file does, so the failure notice shows.
const fetchServerImageBlobUrl = vi.hoisted(() => vi.fn())
vi.mock('../../lib/authedImage', () => ({ fetchServerImageBlobUrl }))

import { InlineImageGallery } from './InlineImageGallery'

beforeEach(() => {
  fetchServerImageBlobUrl.mockReset().mockRejectedValue(new Error('403'))
  // jsdom ships no object-URL support.
  Object.defineProperty(URL, 'revokeObjectURL', { value: vi.fn(), configurable: true, writable: true })
})

function imgSrcs(): string[] {
  return screen.getAllByRole('img').map((img) => (img as HTMLImageElement).getAttribute('src') ?? '')
}

describe('InlineImageGallery', () => {
  it('shows a failed image notice and filename instead of hiding the gallery entry', async () => {
    render(<InlineImageGallery text="See E:/test/denied.png" />)

    fireEvent.error(screen.getByRole('img'))

    const notice = await screen.findByRole('alert')
    expect(notice).toBeVisible()
    expect(notice).toHaveTextContent('Unable to load image')
    expect(notice).toHaveTextContent('denied.png')
    expect(notice).toHaveTextContent('The file may be missing or access may be denied.')
    expect(screen.getByRole('button', { name: 'Retry' })).toBeVisible()
  })

  it('keeps other images usable and tracks failures by source when the list changes', async () => {
    const { rerender } = render(<InlineImageGallery text="See /tmp/denied.png and /tmp/allowed.png" />)
    fireEvent.error(screen.getByRole('img', { name: 'denied.png' }))
    await screen.findByRole('alert')

    expect(screen.getByRole('img', { name: 'allowed.png' })).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: /allowed.png/ }))
    expect(screen.getByRole('dialog')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))

    rerender(<InlineImageGallery text="See /tmp/new.png and /tmp/denied.png" />)
    expect(screen.getByRole('img', { name: 'new.png' })).toBeVisible()
    expect(screen.getByRole('alert')).toHaveTextContent('denied.png')
    expect(screen.queryByRole('img', { name: 'denied.png' })).not.toBeInTheDocument()
  })

  it('retries the same protected URL and keeps feedback if the retry fails', async () => {
    render(<InlineImageGallery text="See /tmp/denied.png" />)
    const source = screen.getByRole('img').getAttribute('src')
    fireEvent.error(screen.getByRole('img'))
    fireEvent.click(await screen.findByRole('button', { name: 'Retry' }))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.getByRole('img')).toHaveAttribute('src', source)
    fireEvent.error(screen.getByRole('img'))
    expect(await screen.findByRole('alert')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    fireEvent.load(screen.getByRole('img'))
    expect(screen.getByRole('img')).toBeVisible()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('falls back to an authenticated fetch when the bare <img> is refused, as in the web UI', async () => {
    fetchServerImageBlobUrl.mockResolvedValue('blob:http://localhost/chart')
    render(<InlineImageGallery text="See /tmp/chart.png" />)
    const source = screen.getByRole('img').getAttribute('src')!

    fireEvent.error(screen.getByRole('img'))

    await waitFor(() => expect(screen.getByRole('img')).toHaveAttribute('src', 'blob:http://localhost/chart'))
    expect(fetchServerImageBlobUrl).toHaveBeenCalledWith(source)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('retries the full-size view with the credential too when the lightbox picture is refused', async () => {
    render(<InlineImageGallery text="See /tmp/chart.png" />)
    fireEvent.click(screen.getByRole('button', { name: /chart.png/ }))
    const dialog = screen.getByRole('dialog')
    const refused = dialog.querySelector('img')!.getAttribute('src')
    fetchServerImageBlobUrl.mockResolvedValue('blob:http://localhost/chart-large')

    fireEvent.error(dialog.querySelector('img')!)

    await waitFor(() => expect(dialog.querySelector('img')).toHaveAttribute('src', 'blob:http://localhost/chart-large'))
    expect(fetchServerImageBlobUrl).toHaveBeenCalledWith(refused)
  })

  it('tries the authenticated fetch only once per image: a broken blob is a real failure', async () => {
    fetchServerImageBlobUrl.mockResolvedValue('blob:http://localhost/broken')
    render(<InlineImageGallery text="See /tmp/broken.png" />)
    fireEvent.error(screen.getByRole('img'))
    await waitFor(() => expect(screen.getByRole('img')).toHaveAttribute('src', 'blob:http://localhost/broken'))

    fireEvent.error(screen.getByRole('img'))

    expect(await screen.findByRole('alert')).toHaveTextContent('broken.png')
    expect(fetchServerImageBlobUrl).toHaveBeenCalledTimes(1)
  })

  it('ignores a late authenticated result that belongs to the previous session', async () => {
    let finish!: (url: string) => void
    fetchServerImageBlobUrl.mockReturnValue(new Promise<string>((resolve) => { finish = resolve }))
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    const { rerender } = render(<InlineImageGallery text="See /tmp/chart.png" sessionId="old" workDir="/tmp/old" />)
    const source = screen.getByRole('img').getAttribute('src')
    fireEvent.error(screen.getByRole('img'))

    rerender(<InlineImageGallery text="See /tmp/chart.png" sessionId="new" workDir="/tmp/old" />)
    finish('blob:http://localhost/late')

    await waitFor(() => expect(revoke).toHaveBeenCalledWith('blob:http://localhost/late'))
    expect(screen.getByRole('img')).toHaveAttribute('src', source)
    revoke.mockRestore()
  })

  it.each([
    { sessionId: 'new-session', workDir: '/tmp/old' },
    { sessionId: 'old-session', workDir: '/tmp/new' },
  ])('clears a failed absolute source when context changes to %j', (context) => {
    const { rerender } = render(<InlineImageGallery text="See /tmp/denied.png" sessionId="old-session" workDir="/tmp/old" />)
    const source = screen.getByRole('img').getAttribute('src')
    fireEvent.error(screen.getByRole('img'))
    rerender(<InlineImageGallery text="See /tmp/denied.png" {...context} />)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.getByRole('img')).toHaveAttribute('src', source)
  })

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

  describe('an image the prose only names, without a path', () => {
    // A read-only turn ("which commit swapped nodemaven_banner_sep.png?") names a
    // file it never wrote. Nothing proves it sits at the workdir root, so a failed
    // load is a wrong guess, not a broken deliverable worth a red error block.
    it('does not raise the error block when a guessed bare name fails to load', async () => {
      render(
        <InlineImageGallery
          text={'素材也换成 `nodemaven_banner_sep.png`,说明是按月续的'}
          sessionId="s1"
          workDir="/w"
          changedFiles={[]}
        />,
      )

      fireEvent.error(screen.getByRole('img'))

      await waitFor(() => expect(screen.queryByRole('img')).not.toBeInTheDocument())
      expect(fetchServerImageBlobUrl).toHaveBeenCalled()
      expect(screen.queryByRole('alert')).not.toBeInTheDocument()
      expect(screen.queryByText('1 image')).not.toBeInTheDocument()
    })

    it('still raises the error block for a path the prose spelled out, though the checkpoint missed it', async () => {
      // A shell-rendered image never reaches changedFiles; its failure is real.
      render(
        <InlineImageGallery
          text={'渲染结果已保存到 outputs/a/frame.png'}
          sessionId="s1"
          workDir="/w"
          changedFiles={[]}
        />,
      )

      fireEvent.error(screen.getByRole('img'))

      expect(await screen.findByRole('alert')).toHaveTextContent('frame.png')
    })

    it('still raises the error block for a name the turn really wrote', async () => {
      render(
        <InlineImageGallery
          text={'已生成 `banner.png`'}
          sessionId="s1"
          workDir="/w"
          changedFiles={['/w/out/banner.png']}
        />,
      )

      fireEvent.error(screen.getByRole('img'))

      expect(await screen.findByRole('alert')).toHaveTextContent('banner.png')
    })
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

  describe('opening the original from the viewer', () => {
    const openPath = vi.fn().mockResolvedValue(undefined)

    beforeEach(() => {
      openPath.mockClear()
      window.desktopHost = {
        ...browserHost,
        kind: 'electron',
        isDesktop: true,
        capabilities: { ...browserHost.capabilities, shell: true },
        shell: { ...browserHost.shell, openPath },
      }
    })
    afterEach(() => {
      Reflect.deleteProperty(window, 'desktopHost')
    })

    it('hands an absolute image to the system app', async () => {
      render(<InlineImageGallery text={'see /Users/me/out/result.png done'} />)
      fireEvent.click(screen.getByRole('button'))

      fireEvent.click(screen.getByRole('button', { name: 'Open in system app' }))

      await waitFor(() => expect(openPath).toHaveBeenCalledWith('/Users/me/out/result.png'))
    })

    it('hands a workspace image to the system app by its place in the workdir', async () => {
      render(<InlineImageGallery text={'render saved to outputs/a/frame.png'} sessionId="s1" workDir="/w" />)
      fireEvent.click(screen.getByRole('button'))

      fireEvent.click(screen.getByRole('button', { name: 'Open in system app' }))

      await waitFor(() => expect(openPath).toHaveBeenCalledWith('/w/outputs/a/frame.png'))
    })

    it('offers nothing for a workspace image whose workdir is not known yet', () => {
      render(<InlineImageGallery text={'render saved to outputs/a/frame.png'} sessionId="s1" />)
      fireEvent.click(screen.getByRole('button'))

      expect(screen.queryByRole('button', { name: 'Open in system app' })).not.toBeInTheDocument()
    })
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
