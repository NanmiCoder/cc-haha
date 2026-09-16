// @vitest-environment jsdom
import '@testing-library/jest-dom'
import { render, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { browserHost } from '../../lib/desktopHost/browserHost'
import type { OpenTarget } from '@/api/openTargets'

const openTarget = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))
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

// The unified open entry point replaced the per-store `open` / `openPreview`
// pair: every caller now names a target and the controller decides the tab.
vi.mock('../../lib/workspace/openTarget', () => ({
  workspaceOpen: {
    file: (...args: unknown[]) => openPreview(...args),
    browser: (...args: unknown[]) => browserOpen(...args),
    review: (...args: unknown[]) => openPreview(...args),
    terminal: vi.fn(),
  },
  openWorkspaceTarget: vi.fn(),
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
    expect(labels.some((l) => l?.includes('workspace.files.openContainingFolder'))).toBe(true)
    // This is now a standalone menu: there is no parent copy-path pair.
    expect(labels).toContain('openWith.copyFileContent')
    expect(labels).toContain('openWith.copyPath')
    expect(labels).not.toContain('openWith.systemDefault')
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

  it('groups all detected native apps above file actions without truncating the list or rediscovering', () => {
    const targets: OpenTarget[] = Array.from({ length: 9 }, (_, index) => ({
      id: `editor-${index}`, kind: 'ide', label: `Editor ${index}`, icon: '', platform: 'darwin',
    }))
    targets.push({ id: 'finder', kind: 'file_manager', label: 'Finder', icon: '', platform: 'darwin' })
    const { getAllByRole, getByRole, queryByText } = render(<WorkspaceFileOpenWith absolutePath="/fixture/app.ts" targets={targets} onRefresh={vi.fn()} />)
    const items = getAllByRole('menuitem')
    expect(items.slice(0, 9).map((item) => item.textContent)).toEqual(targets.slice(0, 9).map((target) => target.label))
    expect(items[0]).toHaveClass('h-9', 'text-[15px]')
    expect(items[8]?.nextElementSibling).toBe(getByRole('separator'))
    expect(items[9]?.previousElementSibling).toBe(getByRole('separator'))
    expect(items.at(-1)).toHaveTextContent('workspace.refresh')
    expect(queryByText('openWith.systemDefault')).not.toBeInTheDocument()
    expect(openTargetState.getTargetsForPath).not.toHaveBeenCalled()
  })

  it('opens the containing folder through the detected file manager with the current exact file path', () => {
    const onAfter = vi.fn()
    const { getByRole } = render(<WorkspaceFileOpenWith absolutePath="/fixture/with spaces/app.ts" onAfterSelect={onAfter} />)
    fireEvent.click(getByRole('menuitem', { name: 'workspace.files.openContainingFolder' }))
    expect(openTarget).toHaveBeenCalledWith('finder', '/fixture/with spaces/app.ts')
    expect(onAfter).toHaveBeenCalledTimes(1)
  })

  it('retains real preview and refresh actions but omits reopening the same already-active file', () => {
    const refresh = vi.fn()
    const after = vi.fn()
    const { getByRole, queryByText } = render(<WorkspaceFileOpenWith absolutePath="/w/index.html" workspacePath="index.html" sessionId="s1" targets={[]} onRefresh={refresh} onAfterSelect={after} />)
    expect(queryByText('openWith.workspacePreview')).not.toBeInTheDocument()
    expect(getByRole('menuitem', { name: 'openWith.inAppBrowser' })).toBeInTheDocument()
    fireEvent.click(getByRole('menuitem', { name: 'workspace.refresh' }))
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(after).toHaveBeenCalledTimes(1)
  })

  it('adds native applications discovered for this exact file path', async () => {
    openTargetState.getTargetsForPath.mockResolvedValueOnce([
      { id: 'application:pages', kind: 'application', label: 'Pages', icon: 'application', platform: 'darwin' },
      { id: 'system-default', kind: 'system_default', label: 'System default', icon: 'system', platform: 'darwin' },
    ])

    const view = render(<WorkspaceFileOpenWith absolutePath="/w/brief.docx" />)

    expect(await view.findByText('Pages')).toBeInTheDocument()
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
    expect(labels.some((l) => l?.includes('workspace.files.openContainingFolder'))).toBe(true)
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

    expect(openPreview).toHaveBeenCalledWith('s1', 'report.md')
  })
})
