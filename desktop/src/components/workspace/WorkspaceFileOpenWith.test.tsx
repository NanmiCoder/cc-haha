// @vitest-environment jsdom
import '@testing-library/jest-dom'
import { render, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { browserHost } from '../../lib/desktopHost/browserHost'

const openTarget = vi.hoisted(() => vi.fn())
const shellOpen = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))
const hostOpenPath = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))
const browserOpen = vi.hoisted(() => vi.fn())
const openPreview = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))

const openTargetState = vi.hoisted(() => ({
  targets: [
    { id: 'code', kind: 'ide', label: 'VS Code', icon: '', platform: 'darwin' },
    { id: 'finder', kind: 'file_manager', label: 'Finder', icon: '', platform: 'darwin' },
  ],
  ensureTargets: () => {},
  getTargetsForPath: vi.fn((): Promise<unknown[]> => new Promise(() => {})),
}))

// A zustand store is callable as a hook AND exposes getState; the shared menu
// wiring in lib/openWithMenuItems uses the latter, the same way openPreviewLink
// reads the browser/workspace stores.
vi.mock('../../stores/openTargetStore', () => {
  const state = { ...openTargetState, openTarget }
  return {
    useOpenTargetStore: Object.assign(
      (sel: (s: unknown) => unknown) => sel(state),
      { getState: () => state },
    ),
  }
})

vi.mock('@tauri-apps/plugin-shell', () => ({ open: shellOpen }))

vi.mock('../../i18n', () => ({
  useTranslation: () => (k: string, v?: Record<string, string>) =>
    v?.target ? `${k}:${v.target}` : k,
}))

vi.mock('../../stores/browserPanelStore', () => ({
  useBrowserPanelStore: {
    getState: () => ({ open: browserOpen }),
  },
}))

vi.mock('../../stores/workspacePanelStore', () => ({
  useWorkspacePanelStore: {
    getState: () => ({ openPreview }),
  },
}))

import { WorkspaceFileOpenWith } from './WorkspaceFileOpenWith'

describe('WorkspaceFileOpenWith', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    window.desktopHost = {
      ...browserHost,
      kind: 'electron',
      isDesktop: true,
      capabilities: {
        ...browserHost.capabilities,
        shell: true,
      },
      shell: {
        ...browserHost.shell,
        openPath: hostOpenPath,
      },
    }
  })

  it('renders the IDE, file-manager and copy-contents items', () => {
    const { getAllByRole } = render(
      <WorkspaceFileOpenWith absolutePath="/w/report.md" />,
    )

    const labels = getAllByRole('menuitem').map((el) => el.textContent)
    expect(labels).toHaveLength(4)
    expect(labels.some((l) => l?.includes('VS Code'))).toBe(true)
    expect(labels.some((l) => l?.includes('Finder'))).toBe(true)
    // Added with #1146. "Copy path" is deliberately absent: WorkspacePanel
    // already renders its own copy-path pair directly above this block.
    expect(labels).toContain('openWith.copyFileContent')
    expect(labels).not.toContain('openWith.copyPath')
    expect(labels).toContain('openWith.systemDefault')
  })

  it('clicking the IDE item calls openTarget and onAfterSelect', () => {
    const onAfter = vi.fn()
    const { getAllByRole } = render(
      <WorkspaceFileOpenWith absolutePath="/w/report.md" onAfterSelect={onAfter} />,
    )

    const menuItems = getAllByRole('menuitem')
    const ideItem = menuItems.find((el) => el.textContent?.includes('VS Code'))
    if (!ideItem) throw new Error('IDE menu item not found')

    fireEvent.click(ideItem)

    expect(openTarget).toHaveBeenCalledWith('code', '/w/report.md')
    expect(onAfter).toHaveBeenCalledTimes(1)
  })

  it('adds native applications discovered for this exact file path', async () => {
    openTargetState.getTargetsForPath.mockResolvedValueOnce([
      { id: 'application:pages', kind: 'application', label: 'Pages', icon: 'application', platform: 'darwin' },
      { id: 'system-default', kind: 'system_default', label: 'System default', icon: 'system', platform: 'darwin' },
    ])

    const view = render(<WorkspaceFileOpenWith absolutePath="/w/brief.docx" />)

    expect(await view.findByText('openWith.openInTarget:Pages')).toBeInTheDocument()
    expect(openTargetState.getTargetsForPath).toHaveBeenCalledWith('/w/brief.docx')
  })

  it('does not call shell open from the file open-with menu', () => {
    render(<WorkspaceFileOpenWith absolutePath="/w/report.md" />)
    expect(shellOpen).not.toHaveBeenCalled()
    expect(hostOpenPath).not.toHaveBeenCalled()
  })

  it('offers workspace preview and in-app browser for generated html files with session context', () => {
    const { getAllByRole } = render(
      <WorkspaceFileOpenWith
        absolutePath="/w/66estmutl_files/index.html"
        sessionId="s1"
        workspacePath="66estmutl_files/index.html"
      />,
    )

    const menuItems = getAllByRole('menuitem')
    const labels = menuItems.map((el) => el.textContent)
    expect(labels.some((l) => l?.includes('openWith.workspacePreview'))).toBe(true)
    expect(labels.some((l) => l?.includes('openWith.inAppBrowser'))).toBe(true)
    expect(labels.some((l) => l?.includes('VS Code'))).toBe(true)
    expect(labels.some((l) => l?.includes('Finder'))).toBe(true)
  })

  it('opens the in-app browser preview URL from workspace html files', () => {
    const { getAllByRole } = render(
      <WorkspaceFileOpenWith
        absolutePath="/w/66estmutl_files/index.html"
        sessionId="s1"
        workspacePath="66estmutl_files/index.html"
      />,
    )

    const menuItems = getAllByRole('menuitem')
    const inAppItem = menuItems.find((el) => el.textContent?.includes('openWith.inAppBrowser'))
    if (!inAppItem) throw new Error('In-app browser menu item not found')

    fireEvent.click(inAppItem)

    expect(browserOpen).toHaveBeenCalledWith(
      's1',
      'http://127.0.0.1:3456/preview-fs/s1/66estmutl_files/index.html',
    )
  })

  it('opens the workspace preview for workspace files with session context', () => {
    const { getAllByRole } = render(
      <WorkspaceFileOpenWith
        absolutePath="/w/report.md"
        sessionId="s1"
        workspacePath="report.md"
      />,
    )

    const menuItems = getAllByRole('menuitem')
    const previewItem = menuItems.find((el) => el.textContent?.includes('openWith.workspacePreview'))
    if (!previewItem) throw new Error('Workspace preview menu item not found')

    fireEvent.click(previewItem)

    expect(openPreview).toHaveBeenCalledWith('s1', 'report.md', 'file')
  })
})
