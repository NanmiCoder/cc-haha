import '@testing-library/jest-dom'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const { openBrowser } = vi.hoisted(() => ({ openBrowser: vi.fn() }))
// The unified open entry point replaced the per-store `open` / `openPreview`
// pair: every caller now names a target and the controller decides the tab.
vi.mock('../../lib/workspace/openTarget', () => ({
  workspaceOpen: {
    file: (...args: unknown[]) => openPreviewFn(...args),
    browser: (...args: unknown[]) => openBrowser(...args),
    review: (...args: unknown[]) => openPreviewFn(...args),
    terminal: vi.fn(),
  },
  openWorkspaceTarget: vi.fn(),
}))
vi.mock('../../lib/desktopRuntime', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getServerBaseUrl: () => 'http://127.0.0.1:4321',
}))

const ensureTargets = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))
const getTargetsForPath = vi.hoisted(() => vi.fn())
const openTargetFn = vi.hoisted(() => vi.fn())
const openTargets = vi.hoisted(() => [
  { id: 'code', kind: 'ide', label: 'VS Code', icon: '', platform: 'darwin' },
  { id: 'finder', kind: 'file_manager', label: 'Finder', icon: '', platform: 'darwin' },
])
getTargetsForPath.mockResolvedValue(openTargets)
vi.mock('../../stores/openTargetStore', () => ({
  useOpenTargetStore: {
    getState: () => ({ ensureTargets, getTargetsForPath, targets: openTargets, openTarget: openTargetFn }),
  },
}))

const openPreviewFn = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))
// The workspace status probe moved to the content store; the workDir it
// reports is what resolves a relative reference to an absolute path.
vi.mock('../../stores/workspaceContentStore', () => {
  const state = {
    statusBySession: { s1: { workDir: '/work' } } as Record<string, { workDir?: string } | undefined>,
  }
  return {
    useWorkspaceContentStore: Object.assign(
      (selector: (s: typeof state) => unknown) => selector(state),
      { getState: () => state },
    ),
  }
})

const getWorkspaceFile = vi.hoisted(() => vi.fn().mockResolvedValue({ state: 'ok', content: 'file body' }))
const getWorkspaceTree = vi.hoisted(() => vi.fn().mockResolvedValue({ state: 'missing', path: '', entries: [] }))
// The turn ran a shell command, so a named file may be its output.
const shellTurn = { unlistedWrites: true }
// Unless a test says otherwise, every file a card names was just written.
const writtenNow = async (_sessionId: string, paths: string[]) => ({
  files: paths.map((path) => ({ path, state: 'file' as const, mtimeMs: Date.now() })),
})
const nothingOnDisk = async (_sessionId: string, paths: string[]) => ({
  files: paths.map((path) => ({ path, state: 'missing' as const })),
})
const statWorkspaceFiles = vi.hoisted(() => vi.fn())
statWorkspaceFiles.mockImplementation(writtenNow)
vi.mock('../../api/sessions', () => ({
  sessionsApi: { getWorkspaceFile, getWorkspaceTree, statWorkspaceFiles },
}))

const copyTextToClipboard = vi.hoisted(() => vi.fn().mockResolvedValue(true))
vi.mock('../../lib/clipboard', () => ({ copyTextToClipboard }))

vi.mock('@tauri-apps/plugin-shell', () => ({ open: vi.fn().mockResolvedValue(undefined) }))

const openPath = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))
vi.mock('../../lib/desktopHost', () => ({
  getDesktopHost: () => ({ shell: { openPath } }),
}))

vi.mock('../../i18n', () => ({
  useTranslation: () => (k: string, v?: Record<string, string>) => (v?.target ? `${k}:${v.target}` : k),
}))

vi.mock('../../stores/settingsStore', () => ({
  useSettingsStore: Object.assign((sel: (s: { locale: string }) => unknown) => sel({ locale: 'en' }), {
    getState: () => ({ locale: 'en' }),
    subscribe: () => () => {},
  }),
}))

import { AssistantMessage } from './AssistantMessage'
import { resetDiskListingCacheForTests } from '../../hooks/useDiskConfirmedTargets'
import { resetWorkspaceFileStatsForTests } from '../../lib/workspaceFileStats'

afterEach(() => {
  openPath.mockClear()
  openBrowser.mockReset()
  ensureTargets.mockReset().mockResolvedValue(undefined)
  getTargetsForPath.mockReset().mockResolvedValue(openTargets)
  openTargetFn.mockReset()
  openPreviewFn.mockReset().mockResolvedValue(undefined)
  copyTextToClipboard.mockReset().mockResolvedValue(true)
  getWorkspaceFile.mockReset().mockResolvedValue({ state: 'ok', content: 'file body' })
  getWorkspaceTree.mockReset().mockResolvedValue({ state: 'missing', path: '', entries: [] })
  statWorkspaceFiles.mockReset().mockImplementation(writtenNow)
  resetDiskListingCacheForTests()
  resetWorkspaceFileStatsForTests()
})

describe('AssistantMessage file references', () => {
  it('opens the code view at the referenced line', async () => {
    // #1146, and the contract src/constants/prompts.ts already asks the model for.
    render(<AssistantMessage sessionId="s1" content={'越界在 desktop/src/lib/foo.ts:42'} isStreaming={false} />)
    fireEvent.click(await screen.findByRole('link', { name: 'desktop/src/lib/foo.ts:42' }))
    expect(openPreviewFn).toHaveBeenCalledWith('s1', 'desktop/src/lib/foo.ts', { line: 42 })
  })

  it('opens an inline-code reference through the same route', async () => {
    render(<AssistantMessage sessionId="s1" content={'改 `src/app.ts:7`'} isStreaming={false} />)
    fireEvent.click(await screen.findByRole('link', { name: 'src/app.ts:7' }))
    expect(openPreviewFn).toHaveBeenCalledWith('s1', 'src/app.ts', { line: 7 })
  })

  it('opens a source reference under the explicitly declared project root', async () => {
    render(<AssistantMessage sessionId="s1" content={'项目根目录是 `/other/promo/`：\n- `src/lib/shots.ts:7`'} />)
    fireEvent.click(await screen.findByRole('link', { name: 'src/lib/shots.ts:7' }))
    // The disk was asked about the file the click opens, not the text as written.
    expect(statWorkspaceFiles).toHaveBeenCalledWith('s1', expect.arrayContaining(['/other/promo/src/lib/shots.ts']))
    expect(openPreviewFn).toHaveBeenCalledWith('s1', '/other/promo/src/lib/shots.ts', { line: 7 })
  })

  it('uses the declared root for prose context menus and copy path', async () => {
    render(<AssistantMessage sessionId="s1" content={'项目根目录是 `/other/promo/`：\n- `public/audio/track.wav`'} />)
    fireEvent.contextMenu(await screen.findByRole('link', { name: 'public/audio/track.wav' }))
    await waitFor(() => expect(screen.getByRole('menu')).toBeInTheDocument())
    expect(getTargetsForPath).toHaveBeenCalledWith('/other/promo/public/audio/track.wav')
    fireEvent.click(screen.getByRole('menuitem', { name: 'openWith.copyPath' }))
    expect(copyTextToClipboard).toHaveBeenCalledWith('/other/promo/public/audio/track.wav')
  })

  it.each([undefined, [], ['/work/README.md']])('opens the screenshot audio from both card and prose with checkpoint %j', async (turnChangedFiles) => {
    const content = [
      '`/other/promo/out/movie.mp4`',
      '项目根目录是 `/other/promo/`：',
      '- `out/movie.mp4` — 成片',
      '- `public/audio/track.wav` — 合成音轨',
      '- `README.md` — 说明',
    ].join('\n\n')
    const { container } = render(<AssistantMessage sessionId="s1" content={content} turnChangedFiles={turnChangedFiles} turnOutputEvidence={shellTurn} />)
    expect(container.querySelectorAll('video')).toHaveLength(1)
    expect(container.querySelector('video')).toHaveAttribute('src', 'http://127.0.0.1:4321/local-file/other/promo/out/movie.mp4')
    // Nothing in the checkpoint wrote it, so the card waits for the disk.
    fireEvent.click((await screen.findByText('track.wav')).closest('button')!)
    await waitFor(() => expect(openPath).toHaveBeenCalledWith('/other/promo/public/audio/track.wav'))
    openPath.mockClear()
    fireEvent.click(await screen.findByRole('link', { name: 'public/audio/track.wav' }))
    await waitFor(() => expect(openPath).toHaveBeenCalledWith('/other/promo/public/audio/track.wav'))
  })

  it('names and opens the card by the file that exists when the prose could not bound it (#1423)', async () => {
    getWorkspaceTree.mockResolvedValue({
      state: 'ok',
      path: '',
      entries: [{ name: '报告v2.docx', path: '报告v2.docx', isDirectory: false }],
    })
    render(<AssistantMessage sessionId="s1" content={'已生成报告v2.docx'} turnChangedFiles={[]} turnOutputEvidence={shellTurn} />)

    const card = await screen.findByText('报告v2.docx', { selector: 'span' })
    fireEvent.click(card.closest('button')!)

    await waitFor(() => expect(openPreviewFn).toHaveBeenCalledWith('s1', '报告v2.docx', {}))
  })

  it('shows a card for a CJK-and-extension name only once it is on disk, and links neither', async () => {
    getWorkspaceTree.mockResolvedValue({
      state: 'ok',
      path: '',
      entries: [{ name: '开题报告.docx', path: '开题报告.docx', isDirectory: false }],
    })
    render(<AssistantMessage sessionId="s1" content={'已生成 开题报告.docx。只支持后缀为.docx的文件'} turnChangedFiles={[]} turnOutputEvidence={shellTurn} />)

    expect(await screen.findByText('开题报告.docx', { selector: 'span' })).toBeInTheDocument()
    expect(screen.queryByText(/后缀为\.docx/, { selector: 'span' })).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /docx/ })).not.toBeInTheDocument()
  })

  it('keeps prose and card destinations equal when the project root is stated later', async () => {
    render(<AssistantMessage sessionId="s1" content={'`track.wav`\n\n项目根目录是 `/other/promo/`'} turnOutputEvidence={shellTurn} />)
    fireEvent.click(await screen.findByRole('link', { name: 'track.wav' }))
    await waitFor(() => expect(openPath).toHaveBeenLastCalledWith('/other/promo/track.wav'))
    openPath.mockClear()
    fireEvent.click((await screen.findByText('track.wav', { selector: 'span' })).closest('button')!)
    await waitFor(() => expect(openPath).toHaveBeenLastCalledWith('/other/promo/track.wav'))
  })

  describe('a reply that only quotes file names', () => {
    // Summarising commits, the reply quoted the names from their messages. The
    // turn ran only `git log`, yet three Word cards appeared and opened "file not
    // found" — read by the user as the agent having made Word documents.
    const content = '正文和行内代码里的 `开题报告2.docx`、`D:/资料/测试文档1.docx` 被截成 1.docx 的问题'

    it('shows neither a card nor a link when the turn wrote nothing and the files are nowhere', async () => {
      statWorkspaceFiles.mockImplementation(nothingOnDisk)
      render(<AssistantMessage
        sessionId="s1"
        content={content}
        turnChangedFiles={[]}
        turnOutputEvidence={{ unlistedWrites: false, startedAt: Date.now() }}
      />)

      await waitFor(() => expect(statWorkspaceFiles).toHaveBeenCalled())
      await new Promise((resolve) => setTimeout(resolve, 20))
      // The names stay readable as the code they were written as.
      expect(screen.getByText('开题报告2.docx', { selector: 'code' })).toBeInTheDocument()
      expect(screen.queryByRole('link', { name: '开题报告2.docx' })).not.toBeInTheDocument()
      expect(screen.queryByRole('link', { name: 'D:/资料/测试文档1.docx' })).not.toBeInTheDocument()
      expect(screen.queryByRole('link', { name: '1.docx' })).not.toBeInTheDocument()
      expect(screen.queryByText('开题报告2.docx', { selector: 'span' })).not.toBeInTheDocument()
      expect(screen.queryByText('测试文档1.docx', { selector: 'span' })).not.toBeInTheDocument()
      expect(screen.queryByText('1.docx', { selector: 'span' })).not.toBeInTheDocument()
      // Only the prose links asked; the card decision needed no disk at all.
      expect(statWorkspaceFiles.mock.calls.flatMap(([, paths]) => paths).sort())
        .toEqual(['1.docx', 'D:/资料/测试文档1.docx', '开题报告2.docx'])
    })

    it('waits for the checkpoint instead of showing a card it may then take back', async () => {
      const { rerender } = render(<AssistantMessage sessionId="s1" content={'报告已生成：`out/report.docx`'} />)

      // The prose link may confirm its file meanwhile; the card still waits.
      expect(await screen.findByRole('link', { name: 'out/report.docx' })).toBeInTheDocument()
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(screen.queryByText('report.docx', { selector: 'span' })).not.toBeInTheDocument()

      rerender(<AssistantMessage
        sessionId="s1"
        content={'报告已生成：`out/report.docx`'}
        turnChangedFiles={[]}
        turnOutputEvidence={{ unlistedWrites: true, startedAt: Date.now() - 1_000 }}
      />)
      expect(await screen.findByText('report.docx', { selector: 'span' })).toBeInTheDocument()
      expect(statWorkspaceFiles).toHaveBeenCalledWith('s1', ['out/report.docx'])
    })

    it('shows no card for files that predate a turn that also ran a shell command', async () => {
      const startedAt = Date.now()
      statWorkspaceFiles.mockImplementation(async (_sessionId: string, paths: string[]) => ({
        files: paths.map((path) => path === '开题报告2.docx'
          ? { path, state: 'file' as const, mtimeMs: startedAt - 86_400_000 }
          : { path, state: 'missing' as const }),
      }))
      render(<AssistantMessage
        sessionId="s1"
        content={content}
        turnChangedFiles={[]}
        turnOutputEvidence={{ unlistedWrites: true, startedAt }}
      />)

      await waitFor(() => expect(statWorkspaceFiles).toHaveBeenCalled())
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(screen.queryByText('开题报告2.docx', { selector: 'span' })).not.toBeInTheDocument()
      expect(screen.queryByText('1.docx', { selector: 'span' })).not.toBeInTheDocument()
    })
  })

  describe('a reference guessed from code or prose', () => {
    it('links only once the file is known to exist', async () => {
      statWorkspaceFiles.mockImplementation(async (_sessionId: string, paths: string[]) => ({
        files: paths.map((path) => path === 'src/app.ts'
          ? { path, state: 'file' as const, mtimeMs: 0 }
          : { path, state: 'missing' as const }),
      }))
      render(<AssistantMessage sessionId="s1" content={'改了 `src/app.ts:7`，`docs/gone.md` 已删除'} />)

      // Plain code until the disk answers, so nothing looks openable on a guess.
      expect(screen.queryByRole('link')).not.toBeInTheDocument()
      expect(screen.getByText('src/app.ts:7', { selector: 'code' })).toBeInTheDocument()

      expect(await screen.findByRole('link', { name: 'src/app.ts:7' })).toBeInTheDocument()
      expect(screen.queryByRole('link', { name: 'docs/gone.md' })).not.toBeInTheDocument()
      expect(screen.getByText('docs/gone.md', { selector: 'code' })).toBeInTheDocument()
      expect(statWorkspaceFiles).toHaveBeenCalledTimes(1)
    })

    it('keeps a link the reply wrote in Markdown, whether or not the file is there', async () => {
      statWorkspaceFiles.mockImplementation(nothingOnDisk)
      render(<AssistantMessage sessionId="s1" content={'见 [说明](docs/gone.md)'} />)

      expect(screen.getByRole('link', { name: '说明' })).toBeInTheDocument()
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(screen.getByRole('link', { name: '说明' })).toBeInTheDocument()
    })

    it('answers a remounted message from memory, without a plain-code flash', async () => {
      const first = render(<AssistantMessage sessionId="s1" content={'改了 `src/app.ts:7`'} />)
      await first.findByRole('link', { name: 'src/app.ts:7' })
      first.unmount()

      render(<AssistantMessage sessionId="s1" content={'改了 `src/app.ts:7`'} />)

      expect(screen.getByRole('link', { name: 'src/app.ts:7' })).toBeInTheDocument()
      expect(statWorkspaceFiles).toHaveBeenCalledTimes(1)
    })

    it('keeps the links when the disk cannot be asked', async () => {
      statWorkspaceFiles.mockRejectedValue(new Error('offline'))
      render(<AssistantMessage sessionId="s1" content={'改了 `src/app.ts:7`'} />)

      expect(await screen.findByRole('link', { name: 'src/app.ts:7' })).toBeInTheDocument()
    })

    it('does not ask the workspace about a home-relative path it would misread', () => {
      render(<AssistantMessage sessionId="s1" content={'笔记在 `~/notes/plan.md`'} />)

      expect(screen.getByRole('link', { name: '~/notes/plan.md' })).toBeInTheDocument()
      expect(statWorkspaceFiles).not.toHaveBeenCalled()
    })
  })

  it('does not linkify a bare path mid-stream', () => {
    render(<AssistantMessage sessionId="s1" content={'越界在 desktop/src/lib/foo.ts:42'} isStreaming />)
    expect(screen.queryByRole('link', { name: 'desktop/src/lib/foo.ts:42' })).toBeNull()
  })

  it('offers the open-with menu on right-click, including the copy entries', async () => {
    render(<AssistantMessage sessionId="s1" content={'见 src/app.ts:42'} isStreaming={false} />)
    fireEvent.contextMenu(await screen.findByRole('link', { name: 'src/app.ts:42' }))

    await waitFor(() => expect(screen.getByRole('menu')).toBeInTheDocument())
    const labels = screen.getAllByRole('menuitem').map((el) => el.textContent)
    expect(labels).toContain('openWith.openInTarget:VS Code')
    expect(labels).toContain('openWith.revealIn.darwin')
    expect(labels).toContain('openWith.copyPath')
    expect(labels).toContain('openWith.copyFileContent')
  })

  it('copies the absolute path, resolved against the session workdir', async () => {
    render(<AssistantMessage sessionId="s1" content={'见 src/app.ts:42'} isStreaming={false} />)
    fireEvent.contextMenu(await screen.findByRole('link', { name: 'src/app.ts:42' }))

    await waitFor(() => expect(screen.getByRole('menu')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('menuitem', { name: 'openWith.copyPath' }))
    expect(copyTextToClipboard).toHaveBeenCalledWith('/work/src/app.ts')
  })

  it('copies file contents by reading the path without its line suffix', async () => {
    render(<AssistantMessage sessionId="s1" content={'见 src/app.ts:42'} isStreaming={false} />)
    fireEvent.contextMenu(await screen.findByRole('link', { name: 'src/app.ts:42' }))

    await waitFor(() => expect(screen.getByRole('menu')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('menuitem', { name: 'openWith.copyFileContent' }))
    await waitFor(() => expect(copyTextToClipboard).toHaveBeenCalledWith('file body'))
    expect(getWorkspaceFile).toHaveBeenCalledWith('s1', 'src/app.ts')
  })

  it('leaves the native context menu alone when the target is not a reference', () => {
    render(<AssistantMessage sessionId="s1" content={'普通文字，没有路径'} isStreaming={false} />)
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
    screen.getByText('普通文字，没有路径').dispatchEvent(event)
    expect(event.defaultPrevented).toBe(false)
    expect(screen.queryByRole('menu')).toBeNull()
  })
})
