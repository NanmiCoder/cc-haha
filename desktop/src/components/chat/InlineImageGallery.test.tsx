import '@testing-library/jest-dom'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ApiError } from '../../api/client'
import { browserHost } from '../../lib/desktopHost/browserHost'

// getBaseUrl backs the absolute-path src (/api/filesystem/file).
vi.mock('../../api/client', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  getBaseUrl: () => 'http://127.0.0.1:3456',
}))

// getServerBaseUrl backs the relative-path src (/preview-fs/<sessionId>/...).
vi.mock('../../lib/desktopRuntime', () => ({
  getServerBaseUrl: () => 'http://127.0.0.1:4321',
}))

// The authenticated fallback an <img> error falls back to. It rejects by default
// the way a server fault does, so the failure notice shows; a file the server will
// not serve is answered with its 4xx status instead.
const fetchServerImageBlobUrl = vi.hoisted(() => vi.fn())
vi.mock('../../lib/authedImage', () => ({ fetchServerImageBlobUrl }))

// Bare names glued to prose are settled against a workspace listing.
const getWorkspaceTree = vi.hoisted(() => vi.fn())
vi.mock('../../api/sessions', () => ({ sessionsApi: { getWorkspaceTree } }))

import { InlineImageGallery } from './InlineImageGallery'
import { resetDiskListingCacheForTests } from '../../hooks/useDiskConfirmedTargets'
import { useSettingsStore } from '../../stores/settingsStore'

beforeEach(() => {
  useSettingsStore.setState({ locale: 'en' })
  resetDiskListingCacheForTests()
  getWorkspaceTree.mockReset().mockResolvedValue({ state: 'missing', path: '', entries: [] })
  fetchServerImageBlobUrl.mockReset().mockRejectedValue(new ApiError(500, { error: 'Internal error' }))
  // jsdom ships no object-URL support.
  Object.defineProperty(URL, 'revokeObjectURL', { value: vi.fn(), configurable: true, writable: true })
})

function imgSrcs(): string[] {
  return screen.getAllByRole('img').map((img) => (img as HTMLImageElement).getAttribute('src') ?? '')
}

describe('InlineImageGallery', () => {
  it('shows a retryable notice when an image the server would serve fails to load', async () => {
    render(<InlineImageGallery text="See E:/test/chart.png" />)

    fireEvent.error(screen.getByRole('img'))

    const notice = await screen.findByRole('alert')
    expect(notice).toBeVisible()
    expect(notice).toHaveTextContent('Unable to load image')
    expect(notice).toHaveTextContent('chart.png')
    expect(notice).toHaveTextContent('The file may be damaged, or the local server did not respond.')
    expect(screen.getByRole('button', { name: 'Retry' })).toBeVisible()
  })

  it.each([
    ['en', 'See /tmp/chart.png', '1 image'],
    ['en', 'See /tmp/a.png and /tmp/b.png', '2 images'],
    ['zh', 'See /tmp/a.png and /tmp/b.png', '2 张图片'],
    ['jp', 'See /tmp/a.png and /tmp/b.png', '画像 2 枚'],
  ] as const)('counts the pictures in the reader\'s language (%s: %s)', (locale, text, header) => {
    // The header was typed in English and read "1 IMAGE" in every locale.
    useSettingsStore.setState({ locale })
    render(<InlineImageGallery text={text} />)

    expect(screen.getByText(header)).toBeInTheDocument()
  })

  it('keeps other images usable and tracks failures by source when the list changes', async () => {
    const { rerender } = render(<InlineImageGallery text="See /tmp/broken.png and /tmp/chart.png" />)
    fireEvent.error(screen.getByRole('img', { name: 'broken.png' }))
    await screen.findByRole('alert')

    expect(screen.getByRole('img', { name: 'chart.png' })).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: /chart.png/ }))
    expect(screen.getByRole('dialog')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))

    rerender(<InlineImageGallery text="See /tmp/new.png and /tmp/broken.png" />)
    expect(screen.getByRole('img', { name: 'new.png' })).toBeVisible()
    expect(screen.getByRole('alert')).toHaveTextContent('broken.png')
    expect(screen.queryByRole('img', { name: 'broken.png' })).not.toBeInTheDocument()
  })

  describe('an image the server will not serve', () => {
    // Most paths a reply names that do not load are not there at all: a file
    // cleaned out of /tmp since, a web route, a name quoted from a log. That is
    // no fault and no retry fixes it, yet every such reply in the history carried
    // a red "unable to load" notice.
    it.each([
      [404, 'it is missing'],
      [403, 'it is outside the readable roots'],
      [400, 'it is not an image file'],
    ])('leaves no trace when the server answers %i: %s', async (status) => {
      fetchServerImageBlobUrl.mockRejectedValue(new ApiError(status, { error: 'refused' }))
      render(<InlineImageGallery text="截图已保存到 /tmp/cleaned/chart.png" />)

      fireEvent.error(screen.getByRole('img'))

      await waitFor(() => expect(screen.queryByRole('img')).not.toBeInTheDocument())
      expect(screen.queryByRole('alert')).not.toBeInTheDocument()
      expect(screen.queryByText('1 image')).not.toBeInTheDocument()
    })

    it('keeps the images that load beside one that is gone', async () => {
      fetchServerImageBlobUrl.mockRejectedValue(new ApiError(404, { error: 'File not found' }))
      render(<InlineImageGallery text="See /tmp/gone.png and /tmp/chart.png" />)

      fireEvent.error(screen.getByRole('img', { name: 'gone.png' }))

      await waitFor(() => expect(screen.queryByRole('img', { name: 'gone.png' })).not.toBeInTheDocument())
      expect(screen.getByRole('img', { name: 'chart.png' })).toBeVisible()
      expect(screen.getByText('1 image')).toBeInTheDocument()
    })

    it('leaves no trace for a missing workspace image the prose spelled out with its directory', async () => {
      fetchServerImageBlobUrl.mockRejectedValue(new ApiError(404, 'not found'))
      render(
        <InlineImageGallery
          text={'渲染结果已保存到 outputs/a/frame.png'}
          sessionId="s1"
          workDir="/w"
          changedFiles={[]}
        />,
      )

      fireEvent.error(screen.getByRole('img'))

      await waitFor(() => expect(screen.queryByRole('img')).not.toBeInTheDocument())
      expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    })

    it('tries again in another workspace, where the same path can exist', async () => {
      fetchServerImageBlobUrl.mockRejectedValue(new ApiError(404, { error: 'File not found' }))
      const { rerender } = render(<InlineImageGallery text="See /tmp/chart.png" sessionId="old" workDir="/tmp/old" />)
      fireEvent.error(screen.getByRole('img'))
      await waitFor(() => expect(screen.queryByRole('img')).not.toBeInTheDocument())

      rerender(<InlineImageGallery text="See /tmp/chart.png" sessionId="new" workDir="/tmp/old" />)

      expect(screen.getByRole('img', { name: 'chart.png' })).toBeVisible()
    })
  })

  it('retries the same URL and keeps feedback if the retry fails', async () => {
    render(<InlineImageGallery text="See /tmp/broken.png" />)
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
    const { rerender } = render(<InlineImageGallery text="See /tmp/broken.png" sessionId="old-session" workDir="/tmp/old" />)
    const source = screen.getByRole('img').getAttribute('src')
    fireEvent.error(screen.getByRole('img'))
    rerender(<InlineImageGallery text="See /tmp/broken.png" {...context} />)
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
    // file it never wrote. Resolved at the workdir root it is not there, and a file
    // that is not there leaves no trace.
    it('does not raise the error block when a guessed bare name is not there', async () => {
      fetchServerImageBlobUrl.mockRejectedValue(new ApiError(404, 'not found'))
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

    it('shows the image the workspace really holds when a verb is glued to its name', async () => {
      getWorkspaceTree.mockResolvedValue({
        state: 'ok',
        path: '',
        entries: [{ name: '1.png', path: '1.png', isDirectory: false }],
      })
      render(<InlineImageGallery text={'截图保存为1.png'} sessionId="s1" workDir="/w" changedFiles={[]} />)

      await waitFor(() => expect(imgSrcs()).toEqual(['http://127.0.0.1:4321/preview-fs/s1/1.png']))
    })

    it('shows a CJK-named image only once the workspace confirms it', async () => {
      getWorkspaceTree.mockResolvedValue({
        state: 'ok',
        path: '',
        entries: [{ name: '流程图.png', path: '流程图.png', isDirectory: false }],
      })
      render(<InlineImageGallery text={'已导出 流程图.png，格式选.png即可'} sessionId="s1" workDir="/w" changedFiles={[]} />)

      expect(screen.queryAllByRole('img')).toHaveLength(0)
      await waitFor(() => expect(imgSrcs()).toEqual([
        `http://127.0.0.1:4321/preview-fs/s1/${encodeURIComponent('流程图.png')}`,
      ]))
    })

    it('shows the notice for a guessed name too when its load fails for another reason', async () => {
      // How the reply named a file does not decide the notice; why the load failed does.
      render(
        <InlineImageGallery
          text={'素材也换成 `nodemaven_banner_sep.png`,说明是按月续的'}
          sessionId="s1"
          workDir="/w"
          changedFiles={[]}
        />,
      )

      fireEvent.error(screen.getByRole('img'))

      expect(await screen.findByRole('alert')).toHaveTextContent('nodemaven_banner_sep.png')
    })
  })

  describe('a pattern the text quotes, not a file', () => {
    // The reply pointed at the screenshots it had taken as a glob. No URL loads
    // `0*.png`, so the gallery showed a red "unable to load" tile with a retry.
    it('shows nothing for a glob quoted in the reply', () => {
      render(
        <InlineImageGallery
          text={'并截了 8 张关键界面（`/tmp/cc-haha-ui-review/0*.png`，含权限卡片、工具完成态）。'}
          sessionId="s1"
          workDir="/w"
          changedFiles={['/tmp/cc-haha-ui-review/design/index.html']}
        />,
      )

      expect(screen.queryAllByRole('img')).toHaveLength(0)
      expect(screen.queryByText('1 image')).not.toBeInTheDocument()
    })

    it.each([
      ['a wildcard directory listing', 'zsh: no matches found: /tmp/pres-verify/steps/*.png'],
      ['a wildcard name', '截图在 /private/tmp/todo_*.png'],
      ['a single-character wildcard', '帧序列 /tmp/frames/shot-??.png'],
      ['a format-string placeholder', 'plt.savefig(f"/tmp/plots/{name}.png")'],
      ['a template variable', 'logo 路径是 /connectors/${brand.id}.svg'],
      ['a brace expansion', '两张图 /tmp/{before,after}.png'],
      ['a shell variable', 'cp shot.png /tmp/$NAME.png'],
      ['a printf frame pattern', 'ffmpeg -i in.mp4 /tmp/frames/f%03d.png'],
    ])('shows nothing for %s', (_shape, text) => {
      render(<InlineImageGallery text={text} />)

      expect(screen.queryAllByRole('img')).toHaveLength(0)
    })

    it('still shows the concrete file named beside the pattern', () => {
      render(
        <InlineImageGallery
          text={'截图 `/tmp/cc-haha-ui-review/0*.png`，首屏见 `/tmp/cc-haha-ui-review/01-initial.png`'}
          sessionId="s1"
          workDir="/w"
        />,
      )

      expect(imgSrcs()).toEqual([
        'http://127.0.0.1:3456/api/filesystem/file?path=' + encodeURIComponent('/tmp/cc-haha-ui-review/01-initial.png'),
      ])
    })

    it('keeps a real directory whose name has brackets', () => {
      render(<InlineImageGallery text={'已生成 /w/app/blog/[slug]/opengraph-image.png'} />)

      expect(imgSrcs()).toEqual([
        'http://127.0.0.1:3456/api/filesystem/file?path=' + encodeURIComponent('/w/app/blog/[slug]/opengraph-image.png'),
      ])
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
