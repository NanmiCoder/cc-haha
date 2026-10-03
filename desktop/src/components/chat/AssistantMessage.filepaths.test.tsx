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
vi.mock('../../api/sessions', () => ({
  sessionsApi: { getWorkspaceFile, getWorkspaceTree },
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
  resetDiskListingCacheForTests()
})

describe('AssistantMessage file references', () => {
  it('opens the code view at the referenced line', () => {
    // #1146, and the contract src/constants/prompts.ts already asks the model for.
    render(<AssistantMessage sessionId="s1" content={'越界在 desktop/src/lib/foo.ts:42'} isStreaming={false} />)
    fireEvent.click(screen.getByRole('link', { name: 'desktop/src/lib/foo.ts:42' }))
    expect(openPreviewFn).toHaveBeenCalledWith('s1', 'desktop/src/lib/foo.ts', { line: 42 })
  })

  it('opens an inline-code reference through the same route', () => {
    render(<AssistantMessage sessionId="s1" content={'改 `src/app.ts:7`'} isStreaming={false} />)
    fireEvent.click(screen.getByRole('link', { name: 'src/app.ts:7' }))
    expect(openPreviewFn).toHaveBeenCalledWith('s1', 'src/app.ts', { line: 7 })
  })

  it('opens a source reference under the explicitly declared project root', () => {
    render(<AssistantMessage sessionId="s1" content={'项目根目录是 `/other/promo/`：\n- `src/lib/shots.ts:7`'} />)
    fireEvent.click(screen.getByRole('link', { name: 'src/lib/shots.ts:7' }))
    expect(openPreviewFn).toHaveBeenCalledWith('s1', '/other/promo/src/lib/shots.ts', { line: 7 })
  })

  it('uses the declared root for prose context menus and copy path', async () => {
    render(<AssistantMessage sessionId="s1" content={'项目根目录是 `/other/promo/`：\n- `public/audio/track.wav`'} />)
    fireEvent.contextMenu(screen.getByRole('link', { name: 'public/audio/track.wav' }))
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
    const { container } = render(<AssistantMessage sessionId="s1" content={content} turnChangedFiles={turnChangedFiles} />)
    expect(container.querySelectorAll('video')).toHaveLength(1)
    expect(container.querySelector('video')).toHaveAttribute('src', 'http://127.0.0.1:4321/local-file/other/promo/out/movie.mp4')
    fireEvent.click(screen.getByText('track.wav').closest('button')!)
    await waitFor(() => expect(openPath).toHaveBeenCalledWith('/other/promo/public/audio/track.wav'))
    openPath.mockClear()
    fireEvent.click(screen.getByRole('link', { name: 'public/audio/track.wav' }))
    await waitFor(() => expect(openPath).toHaveBeenCalledWith('/other/promo/public/audio/track.wav'))
  })

  it('names and opens the card by the file that exists when the prose could not bound it (#1423)', async () => {
    getWorkspaceTree.mockResolvedValue({
      state: 'ok',
      path: '',
      entries: [{ name: '报告v2.docx', path: '报告v2.docx', isDirectory: false }],
    })
    render(<AssistantMessage sessionId="s1" content={'已生成报告v2.docx'} turnChangedFiles={[]} />)

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
    render(<AssistantMessage sessionId="s1" content={'已生成 开题报告.docx。只支持后缀为.docx的文件'} turnChangedFiles={[]} />)

    expect(await screen.findByText('开题报告.docx', { selector: 'span' })).toBeInTheDocument()
    expect(screen.queryByText(/后缀为\.docx/, { selector: 'span' })).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /docx/ })).not.toBeInTheDocument()
  })

  it('keeps prose and card destinations equal when the project root is stated later', async () => {
    render(<AssistantMessage sessionId="s1" content={'`track.wav`\n\n项目根目录是 `/other/promo/`'} />)
    fireEvent.click(screen.getByRole('link', { name: 'track.wav' }))
    await waitFor(() => expect(openPath).toHaveBeenLastCalledWith('/other/promo/track.wav'))
    openPath.mockClear()
    fireEvent.click(screen.getByText('track.wav', { selector: 'span' }).closest('button')!)
    await waitFor(() => expect(openPath).toHaveBeenLastCalledWith('/other/promo/track.wav'))
  })

  it('does not linkify a bare path mid-stream', () => {
    render(<AssistantMessage sessionId="s1" content={'越界在 desktop/src/lib/foo.ts:42'} isStreaming />)
    expect(screen.queryByRole('link', { name: 'desktop/src/lib/foo.ts:42' })).toBeNull()
  })

  it('offers the open-with menu on right-click, including the copy entries', async () => {
    render(<AssistantMessage sessionId="s1" content={'见 src/app.ts:42'} isStreaming={false} />)
    fireEvent.contextMenu(screen.getByRole('link', { name: 'src/app.ts:42' }))

    await waitFor(() => expect(screen.getByRole('menu')).toBeInTheDocument())
    const labels = screen.getAllByRole('menuitem').map((el) => el.textContent)
    expect(labels).toContain('openWith.openInTarget:VS Code')
    expect(labels).toContain('openWith.revealIn.darwin')
    expect(labels).toContain('openWith.copyPath')
    expect(labels).toContain('openWith.copyFileContent')
  })

  it('copies the absolute path, resolved against the session workdir', async () => {
    render(<AssistantMessage sessionId="s1" content={'见 src/app.ts:42'} isStreaming={false} />)
    fireEvent.contextMenu(screen.getByRole('link', { name: 'src/app.ts:42' }))

    await waitFor(() => expect(screen.getByRole('menu')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('menuitem', { name: 'openWith.copyPath' }))
    expect(copyTextToClipboard).toHaveBeenCalledWith('/work/src/app.ts')
  })

  it('copies file contents by reading the path without its line suffix', async () => {
    render(<AssistantMessage sessionId="s1" content={'见 src/app.ts:42'} isStreaming={false} />)
    fireEvent.contextMenu(screen.getByRole('link', { name: 'src/app.ts:42' }))

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
