import '@testing-library/jest-dom'
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { act, useState } from 'react'

// ──────────────────────────────────────────────────────────────────────────────
// Hoisted mocks (vi.hoisted runs before module evaluation)
// ──────────────────────────────────────────────────────────────────────────────
const { reviewOpenSpy, openPreviewSpy, browserOpenSpy, openTargetSpy, ensureTargetsMock, getTargetsForPathMock, openSystemFileSpy, panelState } = vi.hoisted(() => {
  const reviewOpenSpy = vi.fn()
  const openPreviewSpy = vi.fn().mockResolvedValue(undefined)
  const browserOpenSpy = vi.fn()
  const openTargetSpy = vi.fn().mockResolvedValue(undefined)
  const ensureTargetsMock = vi.fn().mockResolvedValue(undefined)
  const getTargetsForPathMock = vi.fn().mockResolvedValue([
    { id: 'code', kind: 'ide', label: 'VS Code', icon: '', platform: 'darwin' },
    { id: 'system-default', kind: 'system_default', label: 'System default', icon: '', platform: 'darwin' },
  ])
  const openSystemFileSpy = vi.fn().mockResolvedValue(undefined)
  const panelState = { isOpen: false }
  return { reviewOpenSpy, openPreviewSpy, browserOpenSpy, openTargetSpy, ensureTargetsMock, getTargetsForPathMock, openSystemFileSpy, panelState }
})

// Mock openTargetStore
vi.mock('../../stores/openTargetStore', () => ({
  useOpenTargetStore: Object.assign(
    // Selector hook form: useOpenTargetStore((s) => s.xxx)
    (selector: (s: { targets: unknown[]; ensureTargets: () => Promise<void>; getTargetsForPath: () => Promise<unknown[]>; openTarget: () => Promise<void> }) => unknown) =>
      selector({
        targets: [{ id: 'code', kind: 'ide', label: 'VS Code', icon: '', platform: 'darwin' }],
        ensureTargets: ensureTargetsMock,
        getTargetsForPath: getTargetsForPathMock,
        openTarget: openTargetSpy,
      }),
    {
      // Static .getState() access
      getState: vi.fn(() => ({
        targets: [{ id: 'code', kind: 'ide', label: 'VS Code', icon: '', platform: 'darwin' }],
        ensureTargets: ensureTargetsMock,
        getTargetsForPath: getTargetsForPathMock,
        openTarget: openTargetSpy,
      })),
    },
  ),
}))

// The unified open entry point replaced the per-store `open` / `openPreview`
// pair: every caller now names a target and the controller decides the tab.
vi.mock('../../lib/workspace/openTarget', () => ({
  workspaceOpen: {
    file: (sessionId: string, path: string, options?: Record<string, unknown>) =>
      openPreviewSpy(sessionId, path, 'file', options?.origin),
    browser: (sessionId: string, url?: string) => browserOpenSpy(sessionId, url),
    review: (sessionId: string, options?: Record<string, unknown>) => {
      reviewOpenSpy(sessionId, options)
      return openPreviewSpy(sessionId, options?.path, 'diff', options?.origin)
    },
    terminal: vi.fn(),
  },
  openWorkspaceTarget: vi.fn(),
}))

// Mock @tauri-apps/plugin-shell
vi.mock('@tauri-apps/plugin-shell', () => ({
  open: vi.fn().mockResolvedValue(undefined),
}))

// Mock desktopRuntime.getServerBaseUrl
vi.mock('../../lib/desktopRuntime', () => ({
  getServerBaseUrl: vi.fn(() => 'http://127.0.0.1:4321'),
}))

vi.mock('../../lib/systemFileOpen', () => ({
  openLocalFileWithSystem: openSystemFileSpy,
  resolveAbsoluteOpenPath: (path: string, workDir?: string) => (
    path.startsWith('/') || !workDir ? path : `${workDir}/${path}`
  ),
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
import { en } from '../../i18n/locales/en'
import { zh } from '../../i18n/locales/zh'
import { zh as zhTW } from '../../i18n/locales/zh-TW'
import { jp } from '../../i18n/locales/jp'
import { kr } from '../../i18n/locales/kr'

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────
function makeCheckpoint(
  filesChanged: string[],
  restoreAvailable?: boolean,
  unverifiedChangeSources?: string[],
): SessionTurnCheckpoint {
  return {
    code: {
      available: true,
      filesChanged,
      insertions: filesChanged.length > 0 ? 10 : 0,
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
    ...(restoreAvailable === undefined ? {} : { restoreAvailable }),
    ...(unverifiedChangeSources === undefined ? {} : { unverifiedChangeSources }),
  }
}

function renderCard(
  filesChanged: string[],
  isLatest = true,
  restoreAvailable?: boolean,
  unverifiedChangeSources?: string[],
  onUndo: () => void = vi.fn(),
) {
  const checkpoint = makeCheckpoint(filesChanged, restoreAvailable, unverifiedChangeSources)
  function Card() {
    const [expanded, setExpanded] = useState(false)
    return <CurrentTurnChangeCard
      expanded={expanded}
      onExpandedChange={setExpanded}
      sessionId="s1"
      checkpoint={checkpoint}
      workDir="/w/proj"
      error={null}
      isUndoing={false}
      isLatest={isLatest}
      onUndo={onUndo}
    />
  }
  return render(<Card />)
}

function renderExpandedCard(...args: Parameters<typeof renderCard>) {
  const view = renderCard(...args)
  const toggle = screen.queryByRole('button', { name: /chat.turnChangesExpand/ })
  if (toggle) fireEvent.click(toggle)
  return view
}

// ──────────────────────────────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────────────────────────────
afterEach(() => {
  cleanup()
})

describe('CurrentTurnChangeCard – disclosure', () => {
  it('keeps incomplete coverage visible while files are collapsed', () => {
    const onUndo = vi.fn()
    renderCard(['/w/proj/src/main.ts'], true, true, ['Bash'], onUndo)
    expect(screen.queryByText('main.ts')).not.toBeInTheDocument()
    expect(screen.getByText('chat.turnChangesPartialCoverageSubtitle')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'chat.turnChangesLatestUndoAria' }))
    expect(onUndo).toHaveBeenCalledOnce()
  })

  it.each([
    [true, true, []],
    [true, true, ['Bash']],
    [false, true, ['Bash']],
    [true, false, ['Bash']],
  ] as const)('hides an empty file-change card (latest=%s, restorable=%s, sources=%j)', (isLatest, restoreAvailable, sources) => {
    const { container } = renderCard([], isLatest, restoreAvailable, [...sources])
    expect(container).toBeEmptyDOMElement()
  })

  it('starts collapsed and preserves undo and change totals', () => {
    renderCard(['/w/proj/src/main.ts'])
    expect(screen.queryByText('main.ts')).not.toBeInTheDocument()
    expect(screen.getByText('+10')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'chat.turnChangesLatestUndoAria' })).toBeEnabled()
    const toggle = screen.getByRole('button', { name: /chat.turnChangesExpand/ })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(document.getElementById(toggle.getAttribute('aria-controls')!)).toContainElement(screen.getByText('main.ts'))
    fireEvent.click(toggle)
    expect(screen.queryByText('main.ts')).not.toBeInTheDocument()
  })

  it('updates visibility when checkpoint files arrive or become empty', () => {
    const props = {
      sessionId: 's1',
      workDir: '/w/proj',
      error: null,
      isUndoing: false,
      isLatest: true,
      expanded: true,
      onExpandedChange: vi.fn(),
      onUndo: vi.fn(),
    }
    const view = render(<CurrentTurnChangeCard {...props} checkpoint={makeCheckpoint([])} />)
    expect(view.container).toBeEmptyDOMElement()
    view.rerender(<CurrentTurnChangeCard {...props} checkpoint={makeCheckpoint(['/w/proj/src/main.ts'], true, ['Bash'])} />)
    expect(screen.getByText('main.ts')).toBeInTheDocument()
    expect(screen.getByText('chat.turnChangesPartialCoverageSubtitle')).toBeInTheDocument()
    view.rerender(<CurrentTurnChangeCard {...props} checkpoint={makeCheckpoint([], true, ['Bash'])} />)
    expect(view.container).toBeEmptyDOMElement()
  })
})

describe('CurrentTurnChangeCard – rich file row (icon / name / type)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ensureTargetsMock.mockResolvedValue(undefined)
    openPreviewSpy.mockResolvedValue(undefined)
    panelState.isOpen = false
  })

  it('renders the filename (not just full path) for each file', () => {
    renderExpandedCard(['/w/proj/README.md', '/w/proj/src/index.ts'])
    expect(screen.getByText('README.md')).toBeInTheDocument()
    expect(screen.getByText('index.ts')).toBeInTheDocument()
  })

  it('sorts previewable changed files before source-only files', () => {
    renderExpandedCard([
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
    renderExpandedCard(['/w/proj/README.md'])
    // The type subtitle contains the ext in uppercase: "· MD"
    expect(screen.getByText(/MD/)).toBeInTheDocument()
  })

  it('renders the extension badge for a TypeScript file', () => {
    renderExpandedCard(['/w/proj/src/main.ts'])
    expect(screen.getByText(/TS/)).toBeInTheDocument()
  })

  it('renders the extension badge for an HTML file', () => {
    renderExpandedCard(['/w/proj/index.html'])
    expect(screen.getByText(/HTML/)).toBeInTheDocument()
  })

  it('keeps incomplete checkpoint files visible and still offers undo for the conversation', () => {
    const onUndo = vi.fn()
    renderExpandedCard(['/w/proj/src/main.ts', '/outside/generated.ts'], true, false, undefined, onUndo)

    expect(screen.getByText('main.ts')).toBeInTheDocument()
    expect(screen.getByText('generated.ts')).toBeInTheDocument()
    expect(screen.getByText('chat.turnChangesConversationOnlySubtitle')).toBeInTheDocument()
    // An unrestorable checkpoint must not cost the user the conversation
    // rollback too — the dialog is where the remaining action is chosen.
    const undoButton = screen.getByRole('button', { name: 'chat.turnChangesLatestUndoAria' })
    expect(undoButton).toBeEnabled()
    fireEvent.click(undoButton)
    expect(onUndo).toHaveBeenCalledTimes(1)
  })

  it('keeps undo usable and warns instead of blocking when coverage is partial', () => {
    const onUndo = vi.fn()
    renderExpandedCard(['/w/proj/src/main.ts'], true, true, ['Bash', 'TaskCreate'], onUndo)

    // Warn about what undo will NOT reverse...
    expect(screen.getByText('chat.turnChangesPartialCoverageSubtitle')).toBeInTheDocument()
    expect(screen.queryByText('chat.turnChangesConversationOnlySubtitle')).toBeNull()

    // ...while still letting the user reverse the files it did capture.
    const undoButton = screen.getByRole('button', { name: 'chat.turnChangesLatestUndoAria' })
    expect(undoButton).toBeEnabled()
    fireEvent.click(undoButton)
    expect(onUndo).toHaveBeenCalledTimes(1)
  })

  it('names the unverified sources in every locale message', () => {
    // Every surface that warns about partial coverage feeds the joined tool list
    // in as {sources}; a locale that drops the placeholder would warn without
    // saying what undo is leaving behind.
    const keys = [
      'chat.turnChangesPartialCoverageSubtitle',
      'chat.turnChangesPartialCoverageConfirmBody',
      'chat.rewindSuccessPartialCoverage',
    ] as const
    for (const [name, messages] of Object.entries({ en, zh, zhTW, jp, kr })) {
      for (const key of keys) {
        expect(messages[key], `${name}/${key} must interpolate {sources}`)
          .toContain('{sources}')
      }
    }
    // The post-undo message also has to say how much of the conversation went.
    for (const [name, messages] of Object.entries({ en, zh, zhTW, jp, kr })) {
      expect(
        messages['chat.rewindSuccessPartialCoverage'],
        `${name} must interpolate {count}`,
      ).toContain('{count}')
    }
  })

  it('shows no coverage warning when every change source is accounted for', () => {
    renderExpandedCard(['/w/proj/src/main.ts'], true, true, [])

    expect(screen.queryByText('chat.turnChangesPartialCoverageSubtitle', { exact: false }))
      .toBeNull()
    expect(screen.getByText('chat.turnChangesLatestSubtitle')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'chat.turnChangesLatestUndoAria' })).toBeEnabled()
  })

  it('prefers the conversation-only message over the coverage warning when restore is unavailable', () => {
    renderExpandedCard(['/w/proj/src/main.ts'], true, false, ['Bash'])

    // Both conditions hold, but "files cannot be restored at all" is the one
    // that changes what the user can do, so it wins the subtitle.
    expect(screen.getByText('chat.turnChangesConversationOnlySubtitle')).toBeInTheDocument()
    expect(screen.queryByText('chat.turnChangesPartialCoverageSubtitle', { exact: false }))
      .toBeNull()
    expect(screen.getByRole('button', { name: 'chat.turnChangesLatestUndoAria' })).toBeEnabled()
  })
})

describe('CurrentTurnChangeCard – row opens the workspace diff', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ensureTargetsMock.mockResolvedValue(undefined)
    openPreviewSpy.mockResolvedValue(undefined)
  })

  it('clicking a file row calls openPreview(sessionId, displayPath, "diff")', () => {
    renderExpandedCard(['/w/proj/src/main.ts'])
    const row = screen.getByRole('button', { name: /turnChangesOpenInWorkspaceAria/ })
    fireEvent.click(row)
    // displayPath is the workDir-relative path (matches the workspace file tree)
    expect(openPreviewSpy).toHaveBeenCalledWith('s1', 'src/main.ts', 'diff', expect.objectContaining({ sourceTurnKey: 'msg-1' }))
    expect(reviewOpenSpy).toHaveBeenCalledWith('s1', expect.objectContaining({ source: { kind: 'turn', turnKey: 'msg-1', userMessageIndex: 0 } }))
  })

  it('passes the workDir-relative displayPath (not the absolute path) to openPreview', () => {
    renderExpandedCard(['/w/proj/README.md'])
    const row = screen.getByRole('button', { name: /turnChangesOpenInWorkspaceAria/ })
    fireEvent.click(row)
    expect(openPreviewSpy).toHaveBeenCalledWith('s1', 'README.md', 'diff', expect.objectContaining({ sourceTurnKey: 'msg-1' }))
  })

  it('clicking an outside-workspace html changed file opens the in-app browser via local-file', () => {
    // The file lives outside the workdir (absolute displayPath) — no diff baseline,
    // so html renders directly in the in-app browser via the /local-file route.
    renderExpandedCard(['/other/place/todo.html'])
    const row = screen.getByRole('button', { name: /turnChangesOpenInWorkspaceAria/ })
    fireEvent.click(row)
    expect(browserOpenSpy).toHaveBeenCalledWith('s1', localFileUrl('http://127.0.0.1:4321', '/other/place/todo.html'))
    expect(openPreviewSpy).not.toHaveBeenCalled()
  })

  it('clicking an outside-workspace non-html changed file opens a file preview (not a diff)', () => {
    renderExpandedCard(['/other/place/notes.txt'])
    const row = screen.getByRole('button', { name: /turnChangesOpenInWorkspaceAria/ })
    fireEvent.click(row)
    expect(openPreviewSpy).toHaveBeenCalledWith('s1', '/other/place/notes.txt', 'file', expect.objectContaining({ sourceTurnKey: 'msg-1' }))
    expect(browserOpenSpy).not.toHaveBeenCalled()
  })

  it('does NOT render an inline diff surface after clicking a row', () => {
    renderExpandedCard(['/w/proj/src/main.ts'])
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
    renderExpandedCard(['/w/proj/README.md', '/w/proj/src/index.ts'])
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
    renderExpandedCard(['/w/proj/README.md', '/w/proj/index.html'])
    // aria-label is the i18n key itself (identity mock)
    const buttons = screen.getAllByRole('button', { name: 'openWith.title' })
    expect(buttons).toHaveLength(2)
  })

  it('renders an "open-with" button for a source file while its row still opens workspace', () => {
    renderExpandedCard(['/w/proj/src/main.ts'])
    expect(screen.getAllByRole('button', { name: 'openWith.title' })).toHaveLength(1)
    expect(screen.getByRole('button', { name: /turnChangesOpenInWorkspaceAria/ })).toBeInTheDocument()
  })

  it('mixed turn: every real changed file gets the open-with button', () => {
    renderExpandedCard(['/w/proj/README.md', '/w/proj/src/main.ts', '/w/proj/index.html'])
    expect(screen.getAllByRole('button', { name: 'openWith.title' })).toHaveLength(3)
  })

  it('keeps open-with secondary while every row retains its workspace chevron', () => {
    renderExpandedCard(['/w/proj/README.md', '/w/proj/index.html', '/w/proj/src/main.ts'])

    expect(screen.getAllByRole('button', { name: 'openWith.title' })).toHaveLength(3)
    const rows = screen.getAllByRole('button', { name: /turnChangesOpenInWorkspaceAria/ })
    expect(rows.every((row) => row.querySelector('.lucide-chevron-right'))).toBe(true)
  })

  it('shows the same destination chevron on every changed-file row', () => {
    const { container } = renderExpandedCard(['/w/proj/README.md', '/w/proj/src/main.ts'])

    expect(container.querySelectorAll('.lucide-chevron-right')).toHaveLength(2)
  })

  it('clicking README.md open-with opens menu with workspace preview item', async () => {
    renderExpandedCard(['/w/proj/README.md'])
    const [openWithBtn] = screen.getAllByRole('button', { name: 'openWith.title' })

    await act(async () => {
      fireEvent.click(openWithBtn!)
    })

    // The menu should show a workspace preview item (i18n key)
    expect(await screen.findByText('openWith.workspacePreview')).toBeInTheDocument()
  })

  it('offers the copy entries every other open-with surface has', async () => {
    // This card built its dependencies by hand instead of using the shared
    // factory, so it silently lacked the two clipboard rows the prose links and
    // the file tree both offer.
    renderExpandedCard(['/w/proj/README.md'])
    const [openWithBtn] = screen.getAllByRole('button', { name: 'openWith.title' })

    await act(async () => {
      fireEvent.click(openWithBtn!)
    })

    expect(await screen.findByText('openWith.copyPath')).toBeInTheDocument()
    expect(screen.getByText('openWith.copyFileContent')).toBeInTheDocument()
  })

  it('clicking workspace preview item in README.md menu calls openPreview', async () => {
    renderExpandedCard(['/w/proj/README.md'])
    const [openWithBtn] = screen.getAllByRole('button', { name: 'openWith.title' })

    await act(async () => {
      fireEvent.click(openWithBtn!)
    })

    const previewItem = await screen.findByText('openWith.workspacePreview')
    await act(async () => {
      fireEvent.click(previewItem)
    })

    expect(openPreviewSpy).toHaveBeenCalledWith('s1', 'README.md', 'file', undefined)
  })

  it('clicking a standalone index.html (no manifest in change-set) offers both workspace preview and in-app browser', async () => {
    // A hand-authored single-page index.html is statically previewable, so the
    // menu offers the in-app browser alongside the workspace source view.
    renderExpandedCard(['/w/proj/index.html'])
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
    renderExpandedCard(['/w/proj/index.html', '/w/proj/package.json', '/w/proj/vite.config.ts'])
    const [openWithBtn] = screen.getAllByRole('button', { name: 'openWith.title' })

    await act(async () => {
      fireEvent.click(openWithBtn!)
    })

    expect(await screen.findByText('openWith.workspacePreview')).toBeInTheDocument()
    expect(screen.queryByText('openWith.inAppBrowser')).not.toBeInTheDocument()
  })

  it('clicking built dist index.html open-with opens menu with in-app browser item', async () => {
    renderExpandedCard(['/w/proj/dist/index.html'])
    const [openWithBtn] = screen.getAllByRole('button', { name: 'openWith.title' })

    await act(async () => {
      fireEvent.click(openWithBtn!)
    })

    expect(await screen.findByText('openWith.inAppBrowser')).toBeInTheDocument()
  })

  it('loads targets for the concrete file when open-with is clicked', async () => {
    renderExpandedCard(['/w/proj/README.md'])
    const [openWithBtn] = screen.getAllByRole('button', { name: 'openWith.title' })

    await act(async () => {
      fireEvent.click(openWithBtn!)
    })

    expect(getTargetsForPathMock).toHaveBeenCalledWith('/w/proj/README.md')
  })

  it('opens an office changed file with the system application instead of the binary workspace preview', () => {
    renderExpandedCard(['/w/proj/reports/brief.docx'])

    fireEvent.click(screen.getByRole('button', { name: /turnChangesOpenFileAria/ }))

    expect(openSystemFileSpy).toHaveBeenCalledWith('/w/proj/reports/brief.docx')
    expect(openPreviewSpy).not.toHaveBeenCalled()
  })

  it('open-with button does not also trigger the row workspace-open (stopPropagation)', async () => {
    renderExpandedCard(['/w/proj/README.md'])
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
    renderExpandedCard(['/w/proj/src/main.ts'], false)

    expect(screen.getByText('chat.turnChangesCurrentWorkspaceDiff')).toBeInTheDocument()
  })

  it('records a stable opener id and semantic turn key before opening the diff', () => {
    renderExpandedCard(['/w/proj/src/main.ts'])
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
    renderExpandedCard(makeFiles(5))
    expect(screen.getAllByRole('button', { name: /turnChangesOpenInWorkspaceAria/ })).toHaveLength(5)
    expect(screen.queryByText('chat.turnChangesShowMore')).not.toBeInTheDocument()
    expect(screen.queryByText('chat.turnChangesShowLess')).not.toBeInTheDocument()
  })

  it('with 8 files shows only 5 rows + a "show more" toggle (remaining = 3)', () => {
    renderExpandedCard(makeFiles(8))
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
    renderExpandedCard(makeFiles(8))
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
