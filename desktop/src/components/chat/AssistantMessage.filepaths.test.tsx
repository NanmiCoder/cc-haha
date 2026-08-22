import '@testing-library/jest-dom'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const { openBrowser } = vi.hoisted(() => ({ openBrowser: vi.fn() }))
vi.mock('../../stores/browserPanelStore', () => ({
  useBrowserPanelStore: { getState: () => ({ open: openBrowser }) },
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
vi.mock('../../stores/workspacePanelStore', () => {
  const state = {
    statusBySession: { s1: { workDir: '/work' } } as Record<string, { workDir?: string } | undefined>,
    openPreview: openPreviewFn,
  }
  return {
    useWorkspacePanelStore: Object.assign(
      (selector: (s: typeof state) => unknown) => selector(state),
      { getState: () => state },
    ),
  }
})

const getWorkspaceFile = vi.hoisted(() => vi.fn().mockResolvedValue({ state: 'ok', content: 'file body' }))
vi.mock('../../api/sessions', () => ({
  sessionsApi: { getWorkspaceFile },
}))

const copyTextToClipboard = vi.hoisted(() => vi.fn().mockResolvedValue(true))
vi.mock('../../lib/clipboard', () => ({ copyTextToClipboard }))

vi.mock('@tauri-apps/plugin-shell', () => ({ open: vi.fn().mockResolvedValue(undefined) }))

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

afterEach(() => {
  openBrowser.mockReset()
  ensureTargets.mockReset().mockResolvedValue(undefined)
  getTargetsForPath.mockReset().mockResolvedValue(openTargets)
  openTargetFn.mockReset()
  openPreviewFn.mockReset().mockResolvedValue(undefined)
  copyTextToClipboard.mockReset().mockResolvedValue(true)
  getWorkspaceFile.mockReset().mockResolvedValue({ state: 'ok', content: 'file body' })
})

describe('AssistantMessage file references', () => {
  it('opens the code view at the referenced line', () => {
    // #1146, and the contract src/constants/prompts.ts already asks the model for.
    render(<AssistantMessage sessionId="s1" content={'越界在 desktop/src/lib/foo.ts:42'} isStreaming={false} />)
    fireEvent.click(screen.getByRole('link', { name: 'desktop/src/lib/foo.ts:42' }))
    expect(openPreviewFn).toHaveBeenCalledWith('s1', 'desktop/src/lib/foo.ts', 'file', undefined, { line: 42 })
  })

  it('opens an inline-code reference through the same route', () => {
    render(<AssistantMessage sessionId="s1" content={'改 `src/app.ts:7`'} isStreaming={false} />)
    fireEvent.click(screen.getByRole('link', { name: 'src/app.ts:7' }))
    expect(openPreviewFn).toHaveBeenCalledWith('s1', 'src/app.ts', 'file', undefined, { line: 7 })
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
    expect(labels).toContain('openWith.revealInTarget:Finder')
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
