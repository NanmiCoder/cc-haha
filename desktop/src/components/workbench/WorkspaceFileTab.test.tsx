import '@testing-library/jest-dom'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { loadFile, loadStatus } = vi.hoisted(() => ({
  loadFile: vi.fn().mockResolvedValue(undefined),
  loadStatus: vi.fn().mockResolvedValue(undefined),
}))
const openWithState = vi.hoisted(() => ({
  primaryTarget: { id: 'code', kind: 'ide', label: 'VS Code', icon: '', platform: 'darwin' },
  targets: [], loading: false, error: null, openTarget: vi.fn(),
}))
vi.mock('../workspace/workspaceFileOpenTargets', () => ({ useWorkspaceFileOpenTargets: () => openWithState }))

/**
 * The tree pane and the two text surfaces have their own suites. Stubbing them
 * keeps these cases about the one decision this component makes: which surface
 * a given entry belongs on, and what stays on screen while that changes.
 */
vi.mock('./WorkspaceFileTreePane', () => ({
  WorkspaceFileTreePane: ({ selectedPath, onOpen }: {
    selectedPath: string | null
    onOpen: (path: string) => void
  }) => (
    <div data-testid="file-tree-pane" data-selected={selectedPath ?? ''}>
      <button type="button" onClick={() => onOpen('src/other.ts')}>
        tree row
      </button>
      <button type="button" onClick={() => onOpen('src/third.ts')}>
        second tree row
      </button>
    </div>
  ),
}))

vi.mock('../workspace/surfaces/CodeSurface', () => ({
  CodeSurface: ({ value, language, onAddSelection }: {
    value: string
    language: string
    onAddSelection: (selection: { startLine: number; endLine: number; text: string }) => void
  }) => (
    <div data-testid="code-surface" data-language={language}>
      {value}
      <button
        type="button"
        onClick={() => onAddSelection({ startLine: 3, endLine: 5, text: 'const x = 1' })}
      >
        add selection
      </button>
    </div>
  ),
}))

vi.mock('../workspace/surfaces/MarkdownSurface', () => ({
  MarkdownSurface: ({ value }: { value: string }) => (
    <div data-testid="markdown-surface">{value}</div>
  ),
}))

/**
 * The real menu resolves open targets over the network; what matters here is
 * the path it is handed, so the stub renders it and two real `menuitem`s for
 * the keyboard cases.
 */
vi.mock('../workspace/WorkspaceFileOpenWith', () => ({
  WorkspaceFileOpenWith: ({ absolutePath, onRefresh }: { absolutePath: string; onRefresh?: () => void }) => (
    <div data-testid="open-with-menu" data-absolute-path={absolutePath}>
      <button type="button" role="menuitem">Open in editor</button>
      <button type="button" role="menuitem">Reveal in finder</button>
      <button type="button" role="menuitem" onClick={onRefresh}>Refresh workspace</button>
    </div>
  ),
}))

import { WorkspaceFileTab } from './WorkspaceFileTab'
import { useSettingsStore } from '../../stores/settingsStore'
import { useWorkspaceChatContextStore } from '../../stores/workspaceChatContextStore'
import { useWorkspaceContentStore, type WorkspaceFileEntry } from '../../stores/workspaceContentStore'
import { useWorkspaceStore } from '../../stores/workspaceStore'
import type { WorkspaceFileTab as WorkspaceFileTabModel } from '../../lib/workspace/types'

const SESSION = 'session-a'

function fileTab(path: string, overrides: Partial<WorkspaceFileTabModel> = {}): WorkspaceFileTabModel {
  return {
    id: 'tab-1',
    kind: 'file',
    dock: 'side',
    preview: false,
    createdAt: 0,
    path,
    ...overrides,
  }
}

function seedEntry(path: string, entry: Partial<WorkspaceFileEntry>) {
  useWorkspaceContentStore.setState((state) => ({
    filesByKey: {
      ...state.filesByKey,
      [`${SESSION}::${path}`]: { path, state: 'ok', ...entry } as WorkspaceFileEntry,
    },
  }))
}

function renderTab(path: string, overrides: Partial<WorkspaceFileTabModel> = {}) {
  return render(<WorkspaceFileTab sessionId={SESSION} tab={fileTab(path, overrides)} />)
}

beforeEach(() => {
  useSettingsStore.setState({ locale: 'en' })
  useWorkspaceContentStore.setState({
    filesByKey: {},
    treeByKey: {},
    treeLoadingByKey: {},
    expandedBySession: {},
    treeViewBySession: {},
    fileViewByKey: {},
    statusBySession: {
      [SESSION]: {
        state: 'ok',
        workDir: '/repo',
        repoName: 'repo',
        branch: 'main',
        isGitRepo: true,
        changedFiles: [],
      },
    },
    loadFile,
    loadStatus,
  })
  useWorkspaceChatContextStore.setState({ referencesBySession: {} })
  useWorkspaceStore.setState({ bySession: {}, sideWidth: 860, bottomHeight: 420 })
  loadFile.mockClear()
  loadStatus.mockClear()
})

afterEach(() => {
  cleanup()
})

describe('content states', () => {
  it('gives the file picker a centered invitation while the tree remains available', () => {
    renderTab('')
    expect(screen.getByRole('heading', { name: 'Open file' })).toBeVisible()
    expect(screen.getByText('Choose a file from the tree')).toBeVisible()
    expect(screen.getByTestId('file-tree-pane')).toBeVisible()
  })

  it('keeps one full-width toolbar above both the preview and the file tree', () => {
    seedEntry('src/a.ts', { content: 'export const value = 1', language: 'typescript' })
    renderTab('src/a.ts')
    const header = screen.getByTestId('workspace-file-header')
    const body = screen.getByTestId('workspace-file-body')
    expect(header.parentElement).toBe(body.parentElement)
    expect(body).toContainElement(screen.getByTestId('code-surface'))
    expect(body).toContainElement(screen.getByTestId('file-tree-pane'))
    expect(header).not.toContainElement(screen.getByTestId('file-tree-pane'))
    fireEvent.click(screen.getByTestId('workspace-file-tree-toggle'))
    expect(header).toBeVisible()
    expect(screen.getByTestId('workspace-tree-sidebar')).not.toBeVisible()
    expect(screen.getByTestId('code-surface')).toBeVisible()
  })

  it('asks for the file as soon as the tab is shown', () => {
    renderTab('src/a.ts')
    expect(loadFile).toHaveBeenCalledWith(SESSION, 'src/a.ts')
  })

  it('shows a loading message before the first payload arrives', () => {
    renderTab('src/a.ts')
    expect(screen.getByText('Loading preview...')).toBeInTheDocument()
  })

  it('keeps showing the loading message while a first read is in flight', () => {
    seedEntry('src/a.ts', { state: 'loading' })
    renderTab('src/a.ts')
    expect(screen.getByText('Loading preview...')).toBeInTheDocument()
  })

  it.each([
    ['missing', 'File not found.'],
    ['too_large', 'File is too large to preview.'],
    ['binary', 'Binary file preview is unavailable.'],
  ] as const)('gives %s its own explanation rather than an empty pane', (state, message) => {
    seedEntry('src/a.ts', { state })
    renderTab('src/a.ts')

    expect(screen.getByText(message)).toBeInTheDocument()
    expect(screen.queryByTestId('code-surface')).toBeNull()
  })

  it('reports the server reason for a failed read', () => {
    seedEntry('src/a.ts', { state: 'error', error: 'EACCES: permission denied' })
    renderTab('src/a.ts')

    expect(screen.getByRole('alert')).toHaveTextContent('EACCES: permission denied')
  })

  it('falls back to a generic message when a failure carries no reason', () => {
    seedEntry('src/a.ts', { state: 'error' })
    renderTab('src/a.ts')

    expect(screen.getByRole('alert')).toHaveTextContent('Failed to load workspace data.')
  })

  it('renders an image payload as an image', () => {
    seedEntry('assets/logo.png', {
      state: 'ok',
      previewType: 'image',
      dataUrl: 'data:image/png;base64,AAAA',
    })
    renderTab('assets/logo.png')

    expect(screen.getByAltText('assets/logo.png')).toHaveAttribute(
      'src',
      'data:image/png;base64,AAAA',
    )
  })

  it('renders markdown through the markdown surface', () => {
    seedEntry('docs/README.md', { state: 'ok', previewType: 'text', content: '# Title' })
    renderTab('docs/README.md')

    expect(screen.getByTestId('markdown-surface')).toHaveTextContent('# Title')
    expect(screen.queryByTestId('code-surface')).toBeNull()
  })

  it('renders everything else as code, with the language the server detected', () => {
    seedEntry('src/a.ts', { state: 'ok', previewType: 'text', content: 'const x = 1', language: 'typescript' })
    renderTab('src/a.ts')

    const surface = screen.getByTestId('code-surface')
    expect(surface).toHaveTextContent('const x = 1')
    expect(surface).toHaveAttribute('data-language', 'typescript')
  })

  it('invites the user to pick a file when the tab has no path yet', () => {
    renderTab('')

    expect(screen.getByText('Choose a file from the tree')).toBeInTheDocument()
    expect(loadFile).not.toHaveBeenCalled()
  })
})

describe('refresh', () => {
  it('forces a re-read on request', () => {
    seedEntry('src/a.ts', { state: 'ok', content: 'const x = 1' })
    renderTab('src/a.ts')

    fireEvent.click(screen.getByTestId('workspace-file-open-with'))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Refresh workspace' }))

    expect(loadFile).toHaveBeenLastCalledWith(SESSION, 'src/a.ts', { force: true })
  })

  it('keeps the last good content on screen when a refresh fails, and says so', () => {
    // Regression anchor: blanking the pane on a failed refresh loses whatever
    // the user was reading, and the failure is usually transient (the file was
    // mid-write). The store models this as `refreshError` precisely so the
    // content and the failure can be on screen at the same time.
    seedEntry('src/a.ts', {
      state: 'ok',
      previewType: 'text',
      content: 'const x = 1',
      refreshError: 'EBUSY: resource busy',
    })
    renderTab('src/a.ts')

    expect(screen.getByTestId('code-surface')).toHaveTextContent('const x = 1')
    expect(screen.getByRole('status')).toHaveTextContent('EBUSY: resource busy')
  })

  it('shows no failure notice while the content is current', () => {
    seedEntry('src/a.ts', { state: 'ok', previewType: 'text', content: 'const x = 1' })
    renderTab('src/a.ts')

    expect(screen.queryByRole('status')).toBeNull()
  })
})

describe('file tree', () => {
  it('keeps the tree beside the content instead of replacing one with the other', () => {
    // The previous panel hid its navigation the moment a file opened, so
    // browsing a repository made the structure appear and disappear.
    seedEntry('src/a.ts', { state: 'ok', previewType: 'text', content: 'const x = 1' })
    renderTab('src/a.ts')

    expect(screen.getByTestId('file-tree-pane')).toBeInTheDocument()
    expect(screen.getByTestId('code-surface')).toBeInTheDocument()
    expect(screen.getByTestId('file-tree-pane')).toHaveAttribute('data-selected', 'src/a.ts')
  })

  it('collapses the tree without dropping the content', () => {
    // Narrow widths give the space to the content, because the content is what
    // the user asked for.
    seedEntry('src/a.ts', { state: 'ok', previewType: 'text', content: 'const x = 1' })
    renderTab('src/a.ts')

    const toggle = screen.getByTestId('workspace-file-tree-toggle')
    expect(toggle).toHaveAttribute('aria-pressed', 'true')

    fireEvent.click(toggle)

    expect(screen.getByTestId('file-tree-pane')).not.toBeVisible()
    expect(screen.getByTestId('code-surface')).toBeInTheDocument()
    expect(screen.getByTestId('workspace-file-tree-toggle')).toHaveAttribute('aria-pressed', 'false')

    fireEvent.click(screen.getByTestId('workspace-file-tree-toggle'))
    expect(screen.getByTestId('file-tree-pane')).toBeInTheDocument()
  })

  it('opens every tree pick as a permanent tab of its own', () => {
    renderTab('src/a.ts')

    fireEvent.click(screen.getByRole('button', { name: 'tree row' }))
    fireEvent.click(screen.getByRole('button', { name: 'second tree row' }))

    // Ten picks must mean ten tabs: the old preview slot replaced the previous
    // pick, so a row of files collapsed into whichever was clicked last.
    const tabs = useWorkspaceStore.getState().getTabs(SESSION, 'side')
    expect(tabs).toHaveLength(2)
    expect(tabs.map((tab) => tab.kind === 'file' && tab.path)).toEqual(['src/other.ts', 'src/third.ts'])
    expect(tabs.every((tab) => !tab.preview)).toBe(true)
  })

  it('lets the first pick take over the empty Files tab instead of adding beside it', () => {
    // Seed the launcher tab the way the "+" menu does, so the store has an
    // active blank tab that the pick is expected to replace.
    useWorkspaceStore.getState().openTarget(SESSION, { kind: 'file', path: '' }, { preview: true })
    renderTab('')

    fireEvent.click(screen.getByRole('button', { name: 'tree row' }))

    const tabs = useWorkspaceStore.getState().getTabs(SESSION, 'side')
    expect(tabs).toHaveLength(1)
    expect(tabs[0]).toMatchObject({ kind: 'file', path: 'src/other.ts', preview: false })
  })
})

describe('breadcrumb and chat handoff', () => {
  it.each([
    { workDir: 'C:\\repo', path: 'C:\\repo\\src\\a.ts', watchPath: undefined },
    { workDir: 'C:\\repo\\', path: 'c:/repo/src/a.ts', watchPath: undefined },
    { workDir: '\\\\server\\share\\repo', path: '\\\\server\\share\\repo\\src\\a.ts', watchPath: undefined },
    { workDir: '/repo', path: '/resolved/alias/a.ts', watchPath: 'src/a.ts' },
  ])('normalizes the project-relative breadcrumb for $path', ({ workDir, path, watchPath }) => {
    useWorkspaceContentStore.setState(state => ({ statusBySession: {
      ...state.statusBySession,
      [SESSION]: { ...state.statusBySession[SESSION]!, workDir },
    } }))
    seedEntry(path, { content: '', watchPath })
    renderTab(path)
    expect(screen.getByRole('navigation', { name: 'File path' })).toHaveTextContent(/^reposrca.ts$/)
  })

  it('identifies the project before the file path', () => {
    seedEntry('src/a.ts', { content: '' })
    renderTab('src/a.ts')
    expect(screen.getByRole('navigation', { name: 'File path' })).toHaveTextContent(/^reposrca.ts$/)
  })

  it('spells out the path segments of the open file', () => {
    seedEntry('src/lib/a.ts', { state: 'ok', previewType: 'text', content: '' })
    renderTab('src/lib/a.ts')

    const breadcrumb = screen.getByRole('navigation', { name: 'File path' })
    expect(breadcrumb).toHaveTextContent('src')
    expect(breadcrumb).toHaveTextContent('lib')
    expect(breadcrumb).toHaveTextContent('a.ts')
  })

  it('says no file is selected rather than showing an empty breadcrumb', () => {
    renderTab('')
    expect(screen.getByRole('navigation', { name: 'File path' })).toHaveTextContent(
      '/',
    )
  })

  it('sends a selection to the chat composer as a located quote', () => {
    seedEntry('src/a.ts', { state: 'ok', previewType: 'text', content: 'const x = 1' })
    renderTab('src/a.ts')

    fireEvent.click(screen.getByRole('button', { name: 'add selection' }))

    expect(useWorkspaceChatContextStore.getState().referencesBySession[SESSION]).toMatchObject([
      {
        kind: 'code-selection',
        path: 'src/a.ts',
        name: 'a.ts',
        lineStart: 3,
        lineEnd: 5,
        quote: 'const x = 1',
      },
    ])
  })
})

describe('open with', () => {
  it.each([
    ['/repo/src/a.ts', '/repo', '/repo/src/a.ts'],
    ['/tmp/outside.ts', '/repo', '/tmp/outside.ts'],
    ['C:\\repo\\src\\a.ts', 'C:\\repo', 'C:\\repo\\src\\a.ts'],
    ['D:/outside/a.ts', 'C:/repo', 'D:/outside/a.ts'],
    ['\\\\server\\share\\a.ts', 'C:/repo', '\\\\server\\share\\a.ts'],
    ['src/a.ts', 'C:\\repo\\', 'C:\\repo/src/a.ts'],
  ])('resolves Open With target %s without prefixing an already absolute path', (path, workDir, expected) => {
    useWorkspaceContentStore.setState((state) => ({ statusBySession: {
      ...state.statusBySession,
      [SESSION]: { ...state.statusBySession[SESSION]!, workDir },
    } }))
    seedEntry(path, { state: 'ok', previewType: 'text', content: 'const x = 1' })
    renderTab(path)
    fireEvent.click(screen.getByTestId('workspace-file-open-with'))
    expect(screen.getByTestId('open-with-menu')).toHaveAttribute('data-absolute-path', expected)
  })

  it('hands the open-with menu an absolute path', async () => {
    // Regression anchor: `workDir` was an optional prop that the only render
    // site never passed, so this menu (and the Markdown surface) received
    // "src/a.ts" and asked the OS to open a path relative to nothing.
    seedEntry('src/a.ts', { state: 'ok', previewType: 'text', content: 'const x = 1' })
    renderTab('src/a.ts')

    fireEvent.click(screen.getByTestId('workspace-file-open-with'))

    expect(await screen.findByTestId('open-with-menu')).toHaveAttribute(
      'data-absolute-path',
      '/repo/src/a.ts',
    )
  })

  it('asks for the workspace status it needs to build that path', () => {
    renderTab('src/a.ts')
    expect(loadStatus).toHaveBeenCalledWith(SESSION)
  })

  it('falls back to the workspace-relative path until the status arrives', () => {
    // Better a relative path than "/undefined/src/a.ts": the menu can decline,
    // a fabricated absolute path cannot.
    useWorkspaceContentStore.setState({ statusBySession: {} })
    renderTab('src/a.ts')

    fireEvent.click(screen.getByTestId('workspace-file-open-with'))

    expect(screen.getByTestId('open-with-menu')).toHaveAttribute('data-absolute-path', 'src/a.ts')
  })

  it('announces the menu on its trigger', () => {
    renderTab('src/a.ts')
    const trigger = screen.getByTestId('workspace-file-open-with')

    expect(trigger).toHaveAttribute('aria-haspopup', 'menu')
    expect(trigger).toHaveAttribute('aria-expanded', 'false')

    fireEvent.click(trigger)
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
  })

  it('moves focus into the menu and walks it with the arrow keys', () => {
    renderTab('src/a.ts')

    fireEvent.click(screen.getByTestId('workspace-file-open-with'))

    const items = screen.getAllByRole('menuitem')
    expect(document.activeElement).toBe(items[0])

    fireEvent.keyDown(screen.getByRole('menu'), { key: 'ArrowDown' })
    expect(document.activeElement).toBe(items[1])
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'ArrowDown' })
    expect(document.activeElement).toBe(items[2])

    fireEvent.keyDown(screen.getByRole('menu'), { key: 'ArrowDown' })
    // Wraps rather than dead-ends at the bottom.
    expect(document.activeElement).toBe(items[0])

    fireEvent.keyDown(screen.getByRole('menu'), { key: 'End' })
    expect(document.activeElement).toBe(items[2])

    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Home' })
    expect(document.activeElement).toBe(items[0])
  })

  it('closes on Escape and gives focus back to the trigger', () => {
    renderTab('src/a.ts')
    const trigger = screen.getByTestId('workspace-file-open-with')

    fireEvent.click(trigger)
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })

    expect(screen.queryByRole('menu')).toBeNull()
    // Escape with focus left in the void is how a keyboard user gets stranded.
    expect(document.activeElement).toBe(trigger)
  })
})

describe('toolbar density', () => {
  it('matches the shared workbench bar height', () => {
    // Same height as the resource tab strip and review toolbar; switching
    // resources must not move the content boundary.
    renderTab('src/a.ts')
    expect(screen.getByTestId('workspace-file-header').className).toContain('h-[52px]')
  })

  it('opens with the displayed application from the primary half without opening the dropdown', () => {
    renderTab('src/a.ts')
    fireEvent.click(screen.getByTestId('workspace-file-open-primary'))
    expect(openWithState.openTarget).toHaveBeenCalledWith(openWithState.primaryTarget)
    expect(screen.queryByRole('menu')).toBeNull()
  })
})
