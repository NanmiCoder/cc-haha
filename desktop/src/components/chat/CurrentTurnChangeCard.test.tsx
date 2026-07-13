import '@testing-library/jest-dom'
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { act } from 'react'

// ──────────────────────────────────────────────────────────────────────────────
// Hoisted mocks (vi.hoisted runs before module evaluation)
// ──────────────────────────────────────────────────────────────────────────────
const { openPreviewSpy, browserOpenSpy, openTargetSpy, ensureTargetsMock, panelState } = vi.hoisted(() => {
  const openPreviewSpy = vi.fn().mockResolvedValue(undefined)
  const browserOpenSpy = vi.fn()
  const openTargetSpy = vi.fn().mockResolvedValue(undefined)
  const ensureTargetsMock = vi.fn().mockResolvedValue(undefined)
  const panelState = { isOpen: false }
  return { openPreviewSpy, browserOpenSpy, openTargetSpy, ensureTargetsMock, panelState }
})

// Mock openTargetStore
vi.mock('../../stores/openTargetStore', () => ({
  useOpenTargetStore: Object.assign(
    // Selector hook form: useOpenTargetStore((s) => s.xxx)
    (selector: (s: { targets: unknown[]; ensureTargets: () => Promise<void>; openTarget: () => Promise<void> }) => unknown) =>
      selector({
        targets: [{ id: 'code', kind: 'ide', label: 'VS Code', icon: '', platform: 'darwin' }],
        ensureTargets: ensureTargetsMock,
        openTarget: openTargetSpy,
      }),
    {
      // Static .getState() access
      getState: vi.fn(() => ({
        targets: [{ id: 'code', kind: 'ide', label: 'VS Code', icon: '', platform: 'darwin' }],
        ensureTargets: ensureTargetsMock,
        openTarget: openTargetSpy,
      })),
    },
  ),
}))

// Mock browserPanelStore
vi.mock('../../stores/browserPanelStore', () => ({
  useBrowserPanelStore: Object.assign(
    (selector: (s: { open: () => void }) => unknown) =>
      selector({ open: browserOpenSpy }),
    {
      getState: vi.fn(() => ({ open: browserOpenSpy })),
    },
  ),
}))

// Mock workspacePanelStore
vi.mock('../../stores/workspacePanelStore', () => ({
  useWorkspacePanelStore: Object.assign(
    (selector: (s: { openPreview: () => Promise<void>; isPanelOpen: () => boolean }) => unknown) =>
      selector({ openPreview: openPreviewSpy, isPanelOpen: () => panelState.isOpen }),
    {
      getState: vi.fn(() => ({ openPreview: openPreviewSpy, isPanelOpen: () => panelState.isOpen })),
    },
  ),
}))

// Mock @tauri-apps/plugin-shell
vi.mock('@tauri-apps/plugin-shell', () => ({
  open: vi.fn().mockResolvedValue(undefined),
}))

// Mock desktopRuntime.getServerBaseUrl
vi.mock('../../lib/desktopRuntime', () => ({
  getServerBaseUrl: vi.fn(() => 'http://127.0.0.1:4321'),
}))

// Mock useTranslation: returns identity-ish t function
vi.mock('../../i18n', () => ({
  useTranslation: () => (key: string, params?: Record<string, string | number>) => {
    if (params) {
      return Object.entries(params).reduce<string>(
        (acc, [k, v]) => acc.replace(`{${k}}`, String(v)),
        key,
      )
    }
    return key
  },
}))

// ──────────────────────────────────────────────────────────────────────────────
// Import after mocks
// ──────────────────────────────────────────────────────────────────────────────
import { CurrentTurnChangeCard } from './CurrentTurnChangeCard'
import { localFileUrl } from '../../lib/handlePreviewLink'
import type { SessionTurnCheckpoint } from '../../api/sessions'

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────
function makeCheckpoint(filesChanged: string[]): SessionTurnCheckpoint {
  return {
    code: {
      available: true,
      filesChanged,
      insertions: 10,
      deletions: 0,
    },
    target: {
      targetUserMessageId: 'msg-1',
      userMessageIndex: 0,
      userMessageCount: 1,
    },
    conversation: {
      messagesRemoved: 0,
    },
  }
}

function renderCard(filesChanged: string[], isLatest = true) {
  const checkpoint = makeCheckpoint(filesChanged)
  return render(
    <CurrentTurnChangeCard
      sessionId="s1"
      checkpoint={checkpoint}
      workDir="/w/proj"
      error={null}
      isUndoing={false}
      isLatest={isLatest}
      onUndo={vi.fn()}
    />,
  )
}

// ──────────────────────────────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────────────────────────────
afterEach(() => {
  cleanup()
})

describe('CurrentTurnChangeCard – rich file row (icon / name / type)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ensureTargetsMock.mockResolvedValue(undefined)
    openPreviewSpy.mockResolvedValue(undefined)
    panelState.isOpen = false
  })

  it('renders the filename (not just full path) for each file', () => {
    renderCard(['/w/proj/README.md', '/w/proj/src/index.ts'])
    expect(screen.getByText('README.md')).toBeInTheDocument()
    expect(screen.getByText('index.ts')).toBeInTheDocument()
  })

  it('sorts previewable changed files before source-only files', () => {
    renderCard([
      '/w/proj/package.json',
      '/w/proj/preview.md',
      '/w/proj/src/main.ts',
      '/w/proj/index.html',
      '/w/proj/style.css',
    ])

    const rows = screen.getAllByRole('button', { name: /turnChangesOpenInWorkspaceAria/ })
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining('preview.md'),
      expect.stringContaining('index.html'),
      expect.stringContaining('package.json'),
      expect.stringContaining('main.ts'),
      expect.stringContaining('style.css'),
    ])
  })

  it('renders the extension badge for a markdown file', () => {
    renderCard(['/w/proj/README.md'])
    // The type subtitle contains the ext in uppercase: "· MD"
    expect(screen.getByText(/MD/)).toBeInTheDocument()
  })

  it('renders the extension badge for a TypeScript file', () => {
    renderCard(['/w/proj/src/main.ts'])
    expect(screen.getByText(/TS/)).toBeInTheDocument()
  })

  it('renders the extension badge for an HTML file', () => {
    renderCard(['/w/proj/index.html'])
    expect(screen.getByText(/HTML/)).toBeInTheDocument()
  })
})

describe('CurrentTurnChangeCard – row opens the workspace diff', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ensureTargetsMock.mockResolvedValue(undefined)
    openPreviewSpy.mockResolvedValue(undefined)
  })

  it('clicking a file row calls openPreview(sessionId, displayPath, "diff")', () => {
    renderCard(['/w/proj/src/main.ts'])
    const row = screen.getByRole('button', { name: /turnChangesOpenInWorkspaceAria/ })
    fireEvent.click(row)
    // displayPath is the workDir-relative path (matches the workspace file tree)
    expect(openPreviewSpy).toHaveBeenCalledWith('s1', 'src/main.ts', 'diff', expect.objectContaining({ sourceTurnKey: 'msg-1' }))
  })

  it('passes the workDir-relative displayPath (not the absolute path) to openPreview', () => {
    renderCard(['/w/proj/README.md'])
    const row = screen.getByRole('button', { name: /turnChangesOpenInWorkspaceAria/ })
    fireEvent.click(row)
    expect(openPreviewSpy).toHaveBeenCalledWith('s1', 'README.md', 'diff', expect.objectContaining({ sourceTurnKey: 'msg-1' }))
  })

  it('clicking an outside-workspace html changed file opens the in-app browser via local-file', () => {
    // The file lives outside the workdir (absolute displayPath) — no diff baseline,
    // so html renders directly in the in-app browser via the /local-file route.
    renderCard(['/other/place/todo.html'])
    const row = screen.getByRole('button', { name: /turnChangesOpenInWorkspaceAria/ })
    fireEvent.click(row)
    expect(browserOpenSpy).toHaveBeenCalledWith('s1', localFileUrl('http://127.0.0.1:4321', '/other/place/todo.html'))
    expect(openPreviewSpy).not.toHaveBeenCalled()
  })

  it('clicking an outside-workspace non-html changed file opens a file preview (not a diff)', () => {
    renderCard(['/other/place/notes.txt'])
    const row = screen.getByRole('button', { name: /turnChangesOpenInWorkspaceAria/ })
    fireEvent.click(row)
    expect(openPreviewSpy).toHaveBeenCalledWith('s1', '/other/place/notes.txt', 'file', expect.objectContaining({ sourceTurnKey: 'msg-1' }))
    expect(browserOpenSpy).not.toHaveBeenCalled()
  })

  it('does NOT render an inline diff surface after clicking a row', () => {
    renderCard(['/w/proj/src/main.ts'])
    const row = screen.getByRole('button', { name: /turnChangesOpenInWorkspaceAria/ })
    fireEvent.click(row)
    // No inline diff is rendered inside the card anymore — the diff opens in the
    // right-side workspace panel instead.
    expect(screen.queryByText('chat.turnChangesDiffLoading')).not.toBeInTheDocument()
    expect(screen.queryByText('chat.turnChangesDiffUnavailable')).not.toBeInTheDocument()
    // The CodeMirror diff surface (.cm-editor) is never mounted in the card.
    expect(document.querySelector('.cm-editor')).toBeNull()
  })

  it('each file row exposes a single "open in workspace" button (no expand/collapse toggle)', () => {
    renderCard(['/w/proj/README.md', '/w/proj/src/index.ts'])
    expect(screen.getAllByRole('button', { name: /turnChangesOpenInWorkspaceAria/ })).toHaveLength(2)
  })
})

describe('CurrentTurnChangeCard – open-with buttons', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ensureTargetsMock.mockResolvedValue(undefined)
    openPreviewSpy.mockResolvedValue(undefined)
  })

  it('renders an "open-with" button for each previewable file', () => {
    renderCard(['/w/proj/README.md', '/w/proj/index.html'])
    // aria-label is the i18n key itself (identity mock)
    const buttons = screen.getAllByRole('button', { name: 'openWith.title' })
    expect(buttons).toHaveLength(2)
  })

  it('does NOT render an "open-with" button for a source file (row still opens workspace)', () => {
    renderCard(['/w/proj/src/main.ts'])
    expect(screen.queryAllByRole('button', { name: 'openWith.title' })).toHaveLength(0)
    // source files keep their workspace-open row — only the open-with pill is dropped
    expect(screen.getByRole('button', { name: /turnChangesOpenInWorkspaceAria/ })).toBeInTheDocument()
  })

  it('mixed turn: only previewable rows (md/html) get the open-with button, not .ts', () => {
    renderCard(['/w/proj/README.md', '/w/proj/src/main.ts', '/w/proj/index.html'])
    expect(screen.getAllByRole('button', { name: 'openWith.title' })).toHaveLength(2)
  })

  it('keeps open-with secondary while every row retains its workspace chevron', () => {
    renderCard(['/w/proj/README.md', '/w/proj/index.html', '/w/proj/src/main.ts'])

    expect(screen.getAllByRole('button', { name: 'openWith.title' })).toHaveLength(2)
    const rows = screen.getAllByRole('button', { name: /turnChangesOpenInWorkspaceAria/ })
    expect(rows.every((row) => row.querySelector('.lucide-chevron-right'))).toBe(true)
  })

  it('shows the same destination chevron on every changed-file row', () => {
    const { container } = renderCard(['/w/proj/README.md', '/w/proj/src/main.ts'])

    expect(container.querySelectorAll('.lucide-chevron-right')).toHaveLength(2)
  })

  it('clicking README.md open-with opens menu with workspace preview item', async () => {
    renderCard(['/w/proj/README.md'])
    const [openWithBtn] = screen.getAllByRole('button', { name: 'openWith.title' })

    await act(async () => {
      fireEvent.click(openWithBtn!)
    })

    // The menu should show a workspace preview item (i18n key)
    expect(await screen.findByText('openWith.workspacePreview')).toBeInTheDocument()
  })

  it('clicking workspace preview item in README.md menu calls openPreview', async () => {
    renderCard(['/w/proj/README.md'])
    const [openWithBtn] = screen.getAllByRole('button', { name: 'openWith.title' })

    await act(async () => {
      fireEvent.click(openWithBtn!)
    })

    const previewItem = await screen.findByText('openWith.workspacePreview')
    await act(async () => {
      fireEvent.click(previewItem)
    })

    expect(openPreviewSpy).toHaveBeenCalledWith('s1', 'README.md', 'file')
  })

  it('clicking a standalone index.html (no manifest in change-set) offers both workspace preview and in-app browser', async () => {
    // A hand-authored single-page index.html is statically previewable, so the
    // menu offers the in-app browser alongside the workspace source view.
    renderCard(['/w/proj/index.html'])
    const [openWithBtn] = screen.getAllByRole('button', { name: 'openWith.title' })

    await act(async () => {
      fireEvent.click(openWithBtn!)
    })

    expect(await screen.findByText('openWith.workspacePreview')).toBeInTheDocument()
    expect(screen.queryByText('openWith.inAppBrowser')).toBeInTheDocument()
  })

  it('clicking a framework-template index.html (manifest in same change-set) hides the in-app browser', async () => {
    // With a package.json in the same turn, the root index.html is a build
    // template that needs a dev server — static preview would render blank — so
    // only the workspace source view is offered.
    renderCard(['/w/proj/index.html', '/w/proj/package.json', '/w/proj/vite.config.ts'])
    const [openWithBtn] = screen.getAllByRole('button', { name: 'openWith.title' })

    await act(async () => {
      fireEvent.click(openWithBtn!)
    })

    expect(await screen.findByText('openWith.workspacePreview')).toBeInTheDocument()
    expect(screen.queryByText('openWith.inAppBrowser')).not.toBeInTheDocument()
  })

  it('clicking built dist index.html open-with opens menu with in-app browser item', async () => {
    renderCard(['/w/proj/dist/index.html'])
    const [openWithBtn] = screen.getAllByRole('button', { name: 'openWith.title' })

    await act(async () => {
      fireEvent.click(openWithBtn!)
    })

    expect(await screen.findByText('openWith.inAppBrowser')).toBeInTheDocument()
  })

  it('ensureTargets is called when open-with button is clicked', async () => {
    renderCard(['/w/proj/README.md'])
    const [openWithBtn] = screen.getAllByRole('button', { name: 'openWith.title' })

    await act(async () => {
      fireEvent.click(openWithBtn!)
    })

    expect(ensureTargetsMock).toHaveBeenCalledTimes(1)
  })

  it('open-with button does not also trigger the row workspace-open (stopPropagation)', async () => {
    renderCard(['/w/proj/README.md'])
    const [openWithBtn] = screen.getAllByRole('button', { name: 'openWith.title' })

    await act(async () => {
      fireEvent.click(openWithBtn!)
    })

    // The diff open (3rd arg 'diff') must not have fired from clicking the pill.
    expect(openPreviewSpy).not.toHaveBeenCalledWith('s1', 'README.md', 'diff')
  })
})

describe('CurrentTurnChangeCard – conversation continuity', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    panelState.isOpen = false
    openPreviewSpy.mockImplementation(async () => {
      panelState.isOpen = true
    })
  })

  it('truthfully labels a historical row as opening the current workspace diff', () => {
    renderCard(['/w/proj/src/main.ts'], false)

    expect(screen.getByText('chat.turnChangesCurrentWorkspaceDiff')).toBeInTheDocument()
  })

  it('records a stable opener id and semantic turn key before opening the diff', () => {
    renderCard(['/w/proj/src/main.ts'])
    const row = screen.getByRole('button', { name: /turnChangesOpenInWorkspaceAria/ })

    fireEvent.click(row)

    expect(row.id).toContain('msg-1')
    expect(row).toHaveAttribute('data-source-turn-key', 'msg-1')
    expect(openPreviewSpy).toHaveBeenCalledWith('s1', 'src/main.ts', 'diff', {
      sourceTurnKey: 'msg-1',
      sourceElementId: row.id,
    })
  })
})

describe('CurrentTurnChangeCard – collapse long file lists', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ensureTargetsMock.mockResolvedValue(undefined)
    openPreviewSpy.mockResolvedValue(undefined)
  })

  function makeFiles(count: number): string[] {
    return Array.from({ length: count }, (_, i) => `/w/proj/src/file${i + 1}.ts`)
  }

  it('does NOT render a show-more toggle with ≤5 files', () => {
    renderCard(makeFiles(5))
    expect(screen.getAllByRole('button', { name: /turnChangesOpenInWorkspaceAria/ })).toHaveLength(5)
    expect(screen.queryByText('chat.turnChangesShowMore')).not.toBeInTheDocument()
    expect(screen.queryByText('chat.turnChangesShowLess')).not.toBeInTheDocument()
  })

  it('with 8 files shows only 5 rows + a "show more" toggle (remaining = 3)', () => {
    renderCard(makeFiles(8))
    // only the first 5 workspace-open rows are rendered
    expect(screen.getAllByRole('button', { name: /turnChangesOpenInWorkspaceAria/ })).toHaveLength(5)
    // the show-more toggle is present (identity-mock key). The real key carries the
    // remaining count via '{count}'; with the placeholder-bearing real string this
    // renders as "再显示 3 个文件" (8 - COLLAPSED_COUNT(5) = 3).
    expect(screen.getByText('chat.turnChangesShowMore')).toBeInTheDocument()
    // …and it is the only toggle (no "show less" while collapsed)
    expect(screen.queryByText('chat.turnChangesShowLess')).not.toBeInTheDocument()
  })

  it('clicking "show more" reveals all 8 rows and shows "show less"; clicking again re-collapses', () => {
    renderCard(makeFiles(8))
    const showMore = screen.getByText('chat.turnChangesShowMore')

    fireEvent.click(showMore)
    expect(screen.getAllByRole('button', { name: /turnChangesOpenInWorkspaceAria/ })).toHaveLength(8)
    const showLess = screen.getByText('chat.turnChangesShowLess')
    expect(showLess).toBeInTheDocument()
    expect(screen.queryByText('chat.turnChangesShowMore')).not.toBeInTheDocument()

    fireEvent.click(showLess)
    expect(screen.getAllByRole('button', { name: /turnChangesOpenInWorkspaceAria/ })).toHaveLength(5)
    expect(screen.getByText('chat.turnChangesShowMore')).toBeInTheDocument()
  })
})
