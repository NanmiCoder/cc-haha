import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import '@testing-library/jest-dom'
import type {
  DesktopUiPreferencesResponse,
  SidebarProjectPreferences,
} from '../../api/desktopUiPreferences'

const desktopUiPreferencesApiMock = vi.hoisted(() => ({
  updateSidebarPreferences: vi.fn(),
  updateProjectDisplayName: vi.fn(),
}))

vi.mock('../../api/desktopUiPreferences', () => ({
  desktopUiPreferencesApi: desktopUiPreferencesApiMock,
}))

const repositoryContextMock = vi.hoisted(() => vi.fn())

vi.mock('../../api/sessions', () => ({
  sessionsApi: {
    getRepositoryContext: repositoryContextMock,
  },
}))

const openTargetStoreMock = vi.hoisted(() => ({
  ensureTargets: vi.fn(),
  openTarget: vi.fn(),
  platform: 'darwin',
  targets: [{ id: 'finder', kind: 'file_manager', label: 'Finder', platform: 'darwin' }],
}))

vi.mock('../../stores/openTargetStore', () => ({
  useOpenTargetStore: Object.assign(
    (selector: (state: typeof openTargetStoreMock) => unknown) => selector(openTargetStoreMock),
    { getState: () => openTargetStoreMock },
  ),
}))

vi.mock('../../i18n', () => ({
  useTranslation: () => (key: string, params?: Record<string, string | number>) => {
    const translations: Record<string, string> = {
      'sidebar.newSession': 'New Session',
      'sidebar.scheduled': 'Scheduled',
      'sidebar.market': 'Skills Market',
      'sidebar.settings': 'Settings',
      'sidebar.searchPlaceholder': 'Search sessions',
      'sidebar.noSessions': 'No sessions',
      'sidebar.noMatching': 'No matching sessions',
      'sidebar.sessionListFailed': 'Session list failed',
      'sidebar.refreshSessions': 'Refresh sessions',
      'sidebar.indexDegraded': 'Using standard history loading',
      'search.global.trigger': 'Search chats',
      'sidebar.projects': 'Projects',
      'sidebar.projectMenu': 'Project menu',
      'sidebar.newProject': 'New project',
      'sidebar.archiveAllChats': 'Archive all chats',
      'sidebar.organizeSidebar': 'Organize sidebar',
      'sidebar.sortCondition': 'Sort condition',
      'sidebar.organizeByProject': 'By project',
      'sidebar.organizeByRecentProject': 'Recent projects',
      'sidebar.organizeByTime': 'By time',
      'sidebar.sortByCreatedAt': 'Created time',
      'sidebar.sortByUpdatedAt': 'Updated time',
      'sidebar.newBlankProject': 'New blank project',
      'sidebar.newBlankSession': 'New blank session',
      'sidebar.projectEditor.editTitle': 'Edit project',
      'sidebar.useExistingFolder': 'Use existing folder',
      'sidebar.chooseProjectFolderUnavailable': 'Folder selection is only available in the desktop app.',
      'sidebar.projectActions': 'Project actions for {project}',
      'sidebar.pinProject': 'Pin Project',
      'sidebar.unpinProject': 'Unpin Project',
      'sidebar.openInFileManager.darwin': 'Open in Finder',
      'sidebar.openInFileManager.win32': 'Open in File Explorer',
      'sidebar.openInFileManager.linux': 'Open in File Manager',
      'sidebar.openInFileManager.default': 'Open in File Manager',
      'sidebar.openInFileManagerFailed': 'Could not open the project in the file manager.',
      'sidebar.openInFileManagerUnavailable': 'No file manager is available.',
      'sidebar.hideProjectFromSidebar': 'Hide from Sidebar',
      'sidebar.restoreProjectToSidebar': 'Restore to Sidebar',
      'sidebar.restoreHiddenProjects': 'Restore hidden projects ({count})',
      'sidebar.projectHidden': '{project} was hidden from the sidebar. Existing sessions were not deleted.',
      'sidebar.newSessionInProject': 'New session in {project}',
      'sidebar.showMoreSessions': 'Expand display',
      'sidebar.showFewerSessions': 'Collapse display',
      'sidebar.expandProject': 'Expand {project}',
      'sidebar.collapseProject': 'Collapse {project}',
      'sidebar.worktree': 'worktree',
      'sidebar.sessionRunning': 'Session running',
      'common.retry': 'Retry',
      'common.loading': 'Loading...',
      'common.cancel': 'Cancel',
      'common.delete': 'Delete',
      'common.rename': 'Rename',
      'sidebar.timeGroup.today': 'Today',
      'sidebar.timeGroup.yesterday': 'Yesterday',
      'sidebar.timeGroup.last7days': 'Last 7 Days',
      'sidebar.timeGroup.last30days': 'Last 30 Days',
      'sidebar.timeGroup.older': 'Older',
      'sidebar.missingDir': 'Missing',
      'sidebar.confirmDelete': 'Delete this session? This cannot be undone.',
      'sidebar.batchManage': 'Batch manage',
      'sidebar.batchSelectedCount': '{count} selected',
      'sidebar.batchSelectAll': 'Select all',
      'sidebar.batchDeselectAll': 'Deselect all',
      'sidebar.batchSelectGroup': 'Select {group}',
      'sidebar.batchDeleteSelected': 'Delete selected ({count})',
      'sidebar.batchDeleteConfirm': 'Delete {count} sessions? This cannot be undone.',
      'sidebar.batchDeleteConfirmBody': 'The following sessions will be deleted:',
      'sidebar.batchDeleteMore': '...and {count} more',
      'sidebar.batchExit': 'Cancel batch mode',
      'sidebar.batchDeleteSucceeded': 'Deleted {count} sessions.',
      'sidebar.batchDeleteFailed': '{count} sessions could not be deleted.',
      'sidebar.collapse': 'Collapse sidebar',
      'sidebar.expand': 'Expand sidebar',
      'session.lastUpdated': 'last updated {time}',
      'session.timeJustNow': 'just now',
      'session.timeMinutes': '{n}m ago',
      'session.timeHours': '{n}h ago',
      'session.timeDays': '{n}d ago',
    }

    let text = translations[key] ?? key
    for (const [name, value] of Object.entries(params ?? {})) {
      text = text.replace(new RegExp(`\\{${name}\\}`, 'g'), String(value))
    }
    return text
  },
}))

vi.mock('./ProjectEditorModal', () => ({
  ProjectEditorModal: (props: {
    open: boolean
    mode: 'create' | 'edit'
    sourceFolder?: string
    logicalRoot?: string
    initialName?: string
    suggestedName?: string
    loading?: boolean
    error?: string | null
    onClose: () => void
    onSourceFolderChange?: (path: string) => void
    onSubmit: (submission: { name: string; sourceFolder: string; logicalRoot: string }) => void | Promise<void>
    onRestoreFolderName?: () => void | Promise<void>
    onRemoveFromSidebar?: () => void | Promise<void>
  }) => {
    if (!props.open) return null
    const sourceFolder = props.sourceFolder ?? props.logicalRoot ?? ''
    const logicalRoot = props.logicalRoot ?? sourceFolder
    const name = props.mode === 'create' ? 'Created project' : 'Edited project'

    return (
      <div
        role="dialog"
        aria-label={`${props.mode} project editor`}
        data-testid="project-editor-modal"
        data-source-folder={sourceFolder}
        data-logical-root={logicalRoot}
        data-initial-name={props.initialName ?? ''}
        data-suggested-name={props.suggestedName ?? ''}
        data-loading={props.loading ? 'true' : 'false'}
      >
        {props.mode === 'create' && (
          <>
            <button type="button" onClick={() => props.onSourceFolderChange?.('/workspace/repository/packages/app')}>
              Choose project source
            </button>
            <button type="button" onClick={() => props.onSourceFolderChange?.('/workspace/other')}>
              Choose other project source
            </button>
          </>
        )}
        <button
          type="button"
          onClick={() => void props.onSubmit({ name, sourceFolder, logicalRoot })}
        >
          Submit {props.mode} project
        </button>
        {props.suggestedName && (
          <button
            type="button"
            onClick={() => void props.onSubmit({
              name: props.suggestedName!.trim().replace(/\s+/g, ' '),
              sourceFolder,
              logicalRoot,
            })}
          >
            Submit folder project name
          </button>
        )}
        {props.onRestoreFolderName && (
          <button type="button" onClick={() => void props.onRestoreFolderName?.()}>
            Restore folder name
          </button>
        )}
        {props.onRemoveFromSidebar && (
          <button type="button" onClick={() => void props.onRemoveFromSidebar?.()}>
            Remove project from sidebar
          </button>
        )}
        <button type="button" onClick={props.onClose}>Close project editor</button>
      </div>
    )
  },
}))

import { Sidebar } from './Sidebar'
import { useChatStore } from '../../stores/chatStore'
import { useSessionStore } from '../../stores/sessionStore'
import { useTabStore } from '../../stores/tabStore'
import { useUIStore } from '../../stores/uiStore'
import {
  captureProjectDisplayNameHydrationRevision,
  hydrateProjectDisplayNames,
} from '../../stores/projectDisplayNameStore'
import type { SessionListItem } from '../../types/session'
import type { PerSessionState } from '../../stores/chatStore'

const PROJECT_ORDER_STORAGE_KEY = 'cc-haha-sidebar-project-order'
const PROJECT_PINNED_STORAGE_KEY = 'cc-haha-sidebar-pinned-projects'
const PROJECT_HIDDEN_STORAGE_KEY = 'cc-haha-sidebar-hidden-projects'
const PROJECT_ORGANIZATION_STORAGE_KEY = 'cc-haha-sidebar-project-organization'
const PROJECT_SORT_STORAGE_KEY = 'cc-haha-sidebar-project-sort'

function makeSession(
  id: string,
  title: string,
  projectRoot: string,
  modifiedAt: string,
): SessionListItem {
  return {
    id,
    title,
    createdAt: modifiedAt,
    modifiedAt,
    messageCount: 1,
    projectPath: projectRoot,
    projectRoot,
    workDir: projectRoot,
    workDirExists: true,
  }
}

function makeChatSessionState(overrides: Partial<PerSessionState> = {}): PerSessionState {
  return {
    messages: [],
    chatState: 'idle',
    connectionState: 'connected',
    streamingText: '',
    streamingToolInput: '',
    activeToolUseId: null,
    activeToolName: null,
    activeThinkingId: null,
    pendingPermission: null,
    pendingComputerUsePermission: null,
    tokenUsage: { input_tokens: 0, output_tokens: 0 },
    streamingResponseChars: 0,
    elapsedSeconds: 0,
    statusVerb: '',
    slashCommands: [],
    agentTaskNotifications: {},
    backgroundAgentTasks: {},
    activeGoal: null,
    elapsedTimer: null,
    composerPrefill: null,
    composerDraft: null,
    ...overrides,
  }
}

function createDeferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function makeDesktopUiPreferencesResponse({
  exists = true,
  sidebar = {
    projectOrder: [],
    pinnedProjects: [],
    hiddenProjects: [],
    projectOrganization: 'recentProject',
    projectSortBy: 'updatedAt',
  },
  projectDisplayNames = {},
}: {
  exists?: boolean
  sidebar?: SidebarProjectPreferences
  projectDisplayNames?: Record<string, string>
} = {}): DesktopUiPreferencesResponse {
  return {
    exists,
    preferences: {
      schemaVersion: 5,
      sidebar,
      projectDisplayNames,
      profile: {
        displayName: 'cc-haha',
        subtitle: 'github.com/NanmiCoder/cc-haha',
        avatarFile: null,
        avatarUpdatedAt: null,
      },
      pet: {
        enabled: false,
        selectedPetId: 'dada-code',
        size: 144,
        showTaskPanel: true,
        collapsed: false,
        motionEnabled: true,
        lastSessionId: null,
      },
    },
  }
}

function SidebarDrawerHarness({ request }: { request: Promise<DesktopUiPreferencesResponse> }) {
  const [open, setOpen] = useState(true)
  const [preferencesRequest, setPreferencesRequest] = useState<
    Promise<DesktopUiPreferencesResponse> | null
  >(request)

  return (
    <>
      <button type="button" onClick={() => setOpen((current) => !current)}>
        {open ? 'Close drawer harness' : 'Open drawer harness'}
      </button>
      {open && (
        <Sidebar
          isMobile
          desktopUiPreferencesRequest={preferencesRequest}
          onDesktopUiPreferencesConsumed={(consumedRequest) => {
            setPreferencesRequest((current) => current === consumedRequest ? null : current)
          }}
        />
      )}
    </>
  )
}

function makeDataTransfer() {
  const data = new Map<string, string>()
  return {
    effectAllowed: '',
    dropEffect: '',
    setData: vi.fn((type: string, value: string) => data.set(type, value)),
    getData: vi.fn((type: string) => data.get(type) ?? ''),
  }
}

function projectGroupNames(): string[] {
  return screen
    .getAllByTestId(/^sidebar-project-group-/)
    .map((group) => group.textContent ?? '')
    .map((text) => {
      if (text.includes('alpha')) return 'alpha'
      if (text.includes('beta')) return 'beta'
      if (text.includes('gamma')) return 'gamma'
      return text
    })
}

describe('Sidebar', () => {
  const connectToSession = vi.fn()
  const disconnectSession = vi.fn()
  const fetchSessions = vi.fn()
  const createSession = vi.fn()
  const deleteSession = vi.fn()
  const deleteSessions = vi.fn()
  const addToast = vi.fn()

  beforeEach(() => {
    connectToSession.mockReset()
    disconnectSession.mockReset()
    fetchSessions.mockReset()
    createSession.mockReset()
    deleteSession.mockReset()
    deleteSessions.mockReset()
    addToast.mockReset()
    desktopUiPreferencesApiMock.updateSidebarPreferences.mockReset()
    desktopUiPreferencesApiMock.updateProjectDisplayName.mockReset()
    desktopUiPreferencesApiMock.updateProjectDisplayName.mockImplementation((projectKey: string, displayName: string | null) => Promise.resolve({
      ok: true,
      projectKey,
      displayName,
    }))
    repositoryContextMock.mockReset()
    repositoryContextMock.mockImplementation(async (workDir: string) => ({ repoRoot: null, workDir }))
    act(() => {
      hydrateProjectDisplayNames({}, Number.MAX_SAFE_INTEGER)
    })
    desktopUiPreferencesApiMock.updateSidebarPreferences.mockResolvedValue({
      ok: true,
      preferences: {
        schemaVersion: 1,
        sidebar: {
          projectOrder: [],
          pinnedProjects: [],
          hiddenProjects: [],
          projectOrganization: 'recentProject',
          projectSortBy: 'updatedAt',
        },
      },
    })
    openTargetStoreMock.ensureTargets.mockReset()
    openTargetStoreMock.openTarget.mockReset()
    openTargetStoreMock.platform = 'darwin'
    openTargetStoreMock.targets = [{ id: 'finder', kind: 'file_manager', label: 'Finder', platform: 'darwin' }]
    window.localStorage.removeItem(PROJECT_ORDER_STORAGE_KEY)
    window.localStorage.removeItem(PROJECT_PINNED_STORAGE_KEY)
    window.localStorage.removeItem(PROJECT_HIDDEN_STORAGE_KEY)
    window.localStorage.removeItem(PROJECT_ORGANIZATION_STORAGE_KEY)
    window.localStorage.removeItem(PROJECT_SORT_STORAGE_KEY)

    useTabStore.setState({ tabs: [], activeTabId: null })
    useSessionStore.setState({
      sessions: [],
      activeSessionId: null,
      isLoading: false,
      error: null,
      indexStatus: null,
      isBatchMode: false,
      selectedSessionIds: new Set(),
      fetchSessions,
      createSession,
      deleteSession,
      deleteSessions,
    })
    useChatStore.setState({
      connectToSession,
      disconnectSession,
    } as Partial<ReturnType<typeof useChatStore.getState>>)
    useUIStore.setState({
      sidebarOpen: true,
      addToast,
    } as Partial<ReturnType<typeof useUIStore.getState>>)
  })

  afterEach(() => {
    vi.useRealTimers()
    cleanup()
    act(() => {
      hydrateProjectDisplayNames({}, Number.MAX_SAFE_INTEGER)
    })
    useTabStore.setState({ tabs: [], activeTabId: null })
    window.localStorage.removeItem(PROJECT_ORDER_STORAGE_KEY)
    window.localStorage.removeItem(PROJECT_PINNED_STORAGE_KEY)
    window.localStorage.removeItem(PROJECT_HIDDEN_STORAGE_KEY)
    window.localStorage.removeItem(PROJECT_ORGANIZATION_STORAGE_KEY)
    window.localStorage.removeItem(PROJECT_SORT_STORAGE_KEY)
  })

  it('opens a new tab when creating a session from the sidebar', async () => {
    createSession.mockResolvedValue('session-new-1')

    render(<Sidebar />)

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'New Session' }))
    })

    await waitFor(() => {
      expect(createSession).toHaveBeenCalled()
      expect(connectToSession).toHaveBeenCalledWith('session-new-1')
    })

    expect(useTabStore.getState().tabs).toEqual([
      { sessionId: 'session-new-1', title: 'New Session', type: 'session', status: 'idle' },
    ])
    expect(useTabStore.getState().activeTabId).toBe('session-new-1')
    expect(screen.getByRole('complementary')).not.toHaveAttribute('data-desktop-drag-region')
    expect(screen.getByTestId('sidebar-title-region')).toHaveAttribute('data-desktop-drag-region')
  })

  // The header used to render both "Claude Code Haha" and "cc-haha" and hide
  // one with a container query, so the app answered to two names depending on
  // how far the sidebar had been dragged. Only the short one ships now — and
  // the long one must not linger in the DOM, since a display-hidden copy still
  // reaches screen readers and in-page search.
  it('renders one wordmark and it is the short one', () => {
    render(<Sidebar />)

    const region = screen.getByTestId('sidebar-title-region')

    expect(region).toHaveTextContent('cc-haha')
    expect(region).not.toHaveTextContent('Claude Code')
  })

  it('groups sessions by project and expands overflow rows', () => {
    const base = new Date('2026-05-15T10:00:00.000Z').getTime()
    useSessionStore.setState({
      sessions: [
        ...Array.from({ length: 11 }, (_, index) => (
          makeSession(
            `alpha-${index + 1}`,
            index === 0 ? 'Alpha newest' : index === 10 ? 'Alpha hidden' : `Alpha ${index + 1}`,
            '/workspace/alpha',
            new Date(base - index * 1000).toISOString(),
          )
        )),
        makeSession('beta-1', 'Beta only', '/workspace/beta', new Date(base - 4000).toISOString()),
      ],
    })

    render(<Sidebar />)

    expect(screen.getByText('Projects')).toBeInTheDocument()
    expect(screen.getByText('alpha')).toBeInTheDocument()
    expect(screen.queryByText('/workspace/alpha')).not.toBeInTheDocument()
    expect(screen.getByText('beta')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Alpha newest/ })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Alpha hidden/ })).not.toBeInTheDocument()
    expect(screen.getByTestId('sidebar-project-session-list-workspace-alpha').parentElement).toHaveClass('pl-5')
    expect(screen.getByRole('button', { name: 'Collapse alpha' })).toHaveAttribute('data-state', 'open')
    expect(screen.getByTestId('sidebar-project-icon-workspace-alpha')).toHaveAttribute('data-icon-state', 'open')

    fireEvent.click(screen.getByRole('button', { name: 'Expand display' }))

    expect(screen.getByRole('button', { name: /Alpha hidden/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Collapse display' })).toBeInTheDocument()
  })

  it('lets a manual session refresh supersede a stuck automatic refresh', async () => {
    fetchSessions.mockReturnValue(new Promise(() => {}))

    render(<Sidebar />)

    await waitFor(() => expect(fetchSessions).toHaveBeenCalledTimes(1))
    fireEvent.click(screen.getByRole('button', { name: 'Refresh sessions' }))

    await waitFor(() => expect(fetchSessions).toHaveBeenCalledTimes(2))
  })

  it('keeps the session refresh control usable when a background refresh is still loading existing sessions', async () => {
    useSessionStore.setState({
      sessions: [
        makeSession('session-loaded', 'Loaded session', '/workspace/alpha', '2026-05-15T10:00:00.000Z'),
      ],
      isLoading: true,
    })

    render(<Sidebar />)

    const refreshButton = screen.getByRole('button', { name: 'Refresh sessions' })
    expect(refreshButton).not.toBeDisabled()
    expect(refreshButton.querySelector('svg')).not.toHaveClass('animate-spin')

    fireEvent.click(refreshButton)
    await waitFor(() => expect(fetchSessions).toHaveBeenCalled())
  })

  it('exposes the full session title as a row tooltip when the label is truncated', () => {
    const longTitle = '这是一个非常非常长的会话标题，用来验证侧边栏截断后仍然可以通过气泡查看完整内容'
    useSessionStore.setState({
      sessions: [
        makeSession('session-long-title', longTitle, '/workspace/alpha', '2026-05-15T10:00:00.000Z'),
      ],
    })

    render(<Sidebar />)

    expect(screen.getByRole('button', { name: new RegExp(longTitle) })).toHaveAttribute('title', longTitle)
  })

  it('reorders project groups by dragging project headers while preserving expanded state', async () => {
    const base = new Date('2026-05-15T10:00:00.000Z').getTime()
    useSessionStore.setState({
      sessions: [
        ...Array.from({ length: 11 }, (_, index) => (
          makeSession(
            `alpha-${index + 1}`,
            index === 10 ? 'Alpha hidden' : `Alpha ${index + 1}`,
            '/workspace/alpha',
            new Date(base - index * 1000).toISOString(),
          )
        )),
        makeSession('beta-1', 'Beta Session', '/workspace/beta', new Date(base - 20_000).toISOString()),
        makeSession('gamma-1', 'Gamma Session', '/workspace/gamma', new Date(base - 30_000).toISOString()),
      ],
    })

    render(<Sidebar />)

    fireEvent.click(screen.getByRole('button', { name: 'Expand display' }))
    expect(screen.getByRole('button', { name: /Alpha hidden/ })).toBeInTheDocument()
    expect(projectGroupNames().slice(0, 3)).toEqual(['alpha', 'beta', 'gamma'])

    const dataTransfer = makeDataTransfer()
    const alphaGroup = screen.getByTestId('sidebar-project-group-workspace-alpha')
    vi.spyOn(alphaGroup, 'getBoundingClientRect').mockReturnValue({
      top: 0,
      bottom: 100,
      left: 0,
      right: 280,
      width: 280,
      height: 100,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    })

    fireEvent.dragStart(screen.getByRole('button', { name: 'Collapse gamma' }), { dataTransfer })
    fireEvent.dragOver(alphaGroup, { clientY: -10, dataTransfer })
    fireEvent.drop(alphaGroup, { clientY: -10, dataTransfer })

    await waitFor(() => {
      expect(projectGroupNames().slice(0, 3)).toEqual(['alpha', 'gamma', 'beta'])
    })
    expect(screen.getByRole('button', { name: /Alpha hidden/ })).toBeInTheDocument()
    expect(JSON.parse(window.localStorage.getItem(PROJECT_ORDER_STORAGE_KEY) ?? '[]').slice(0, 3)).toEqual([
      '/workspace/alpha',
      '/workspace/gamma',
      '/workspace/beta',
    ])
  })

  it('restores the saved project drag order on render', () => {
    window.localStorage.setItem(PROJECT_ORDER_STORAGE_KEY, JSON.stringify([
      '/workspace/beta',
      '/workspace/alpha',
    ]))
    const now = new Date().toISOString()
    useSessionStore.setState({
      sessions: [
        makeSession('alpha-1', 'Alpha Session', '/workspace/alpha', now),
        makeSession('beta-1', 'Beta Session', '/workspace/beta', now),
        makeSession('gamma-1', 'Gamma Session', '/workspace/gamma', now),
      ],
    })

    render(<Sidebar />)

    expect(projectGroupNames().slice(0, 3)).toEqual(['beta', 'alpha', 'gamma'])
  })

  it('collapses a project group without removing the project header', () => {
    const now = new Date().toISOString()
    useSessionStore.setState({
      sessions: [
        makeSession('alpha-1', 'Alpha Session', '/workspace/alpha', now),
        makeSession('beta-1', 'Beta Session', '/workspace/beta', now),
      ],
    })

    render(<Sidebar />)

    fireEvent.click(screen.getByRole('button', { name: 'Collapse alpha' }))

    expect(screen.getByText('alpha')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Alpha Session/ })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Beta Session/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Expand alpha' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Expand alpha' })).toHaveAttribute('data-state', 'closed')
    expect(screen.getByTestId('sidebar-project-icon-workspace-alpha')).toHaveAttribute('data-icon-state', 'closed')
  })

  it('uses a bounded per-project session scroller for large expanded groups', () => {
    const base = new Date('2026-05-15T10:00:00.000Z').getTime()
    useSessionStore.setState({
      sessions: Array.from({ length: 14 }, (_, index) => (
        makeSession(`alpha-${index + 1}`, `Alpha ${index + 1}`, '/workspace/alpha', new Date(base - index * 1000).toISOString())
      )),
    })

    render(<Sidebar />)

    const expandButton = screen.getByRole('button', { name: 'Expand display' })
    expect(expandButton).toHaveAttribute('aria-expanded', 'false')
    expect(expandButton.parentElement).toHaveClass('justify-start')
    expect(expandButton).toHaveClass('text-[var(--color-text-tertiary)]', 'opacity-75')

    fireEvent.click(expandButton)

    expect(screen.getByTestId('sidebar-project-session-list-workspace-alpha')).toHaveClass('max-h-[420px]', 'overflow-y-auto')
    expect(screen.getByRole('button', { name: 'Collapse display' })).toHaveAttribute('aria-expanded', 'true')
  })

  it('creates a new session from the project group context', async () => {
    createSession.mockResolvedValue('session-alpha-new')
    useSessionStore.setState({
      sessions: [
        makeSession('alpha-1', 'Alpha Session', '/workspace/alpha', new Date().toISOString()),
      ],
    })

    render(<Sidebar />)

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'New session in alpha' }))
    })

    await waitFor(() => {
      expect(createSession).toHaveBeenCalledWith('/workspace/alpha')
      expect(connectToSession).toHaveBeenCalledWith('session-alpha-new')
    })
  })

  it('shows project header menus and starts a blank project session', async () => {
    createSession.mockResolvedValue('session-blank-project')
    useSessionStore.setState({
      sessions: [
        makeSession('alpha-1', 'Alpha Session', '/workspace/alpha', new Date().toISOString()),
      ],
    })

    render(<Sidebar />)

    expect(screen.getByTestId('sidebar-projects-header')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'New project' }))
    expect(screen.getByRole('menuitem', { name: 'New blank session' })).toBeInTheDocument()

    await act(async () => {
      fireEvent.click(screen.getByRole('menuitem', { name: 'New blank session' }))
    })

    await waitFor(() => {
      expect(createSession).toHaveBeenCalledWith(undefined)
      expect(connectToSession).toHaveBeenCalledWith('session-blank-project')
    })
  })

  it('keeps project controls available when there are no projects', () => {
    render(<Sidebar />)

    expect(screen.getByTestId('sidebar-projects-header')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'New project' }))
    expect(screen.getByRole('menuitem', { name: 'New blank session' })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: 'Use existing folder' })).toBeInTheDocument()
  })

  it('uses hydrated display names while preserving the project path used by actions', async () => {
    act(() => {
      hydrateProjectDisplayNames(
        { '/workspace/alpha': 'Custom alpha' },
        captureProjectDisplayNameHydrationRevision(),
      )
    })
    createSession.mockResolvedValue('custom-alpha-new')
    useSessionStore.setState({
      sessions: [makeSession('alpha-1', 'Alpha Session', '/workspace/alpha', new Date().toISOString())],
    })

    render(<Sidebar />)

    await waitFor(() => expect(screen.getByText('Custom alpha')).toBeInTheDocument())
    const header = screen.getByRole('button', { name: 'Collapse Custom alpha' })
    expect(header).toHaveAttribute('title', '/workspace/alpha')

    fireEvent.click(screen.getByRole('button', { name: 'New session in Custom alpha' }))
    await waitFor(() => expect(createSession).toHaveBeenCalledWith('/workspace/alpha'))
  })

  it('creates a named project at its resolved root while launching the selected source folder', async () => {
    repositoryContextMock.mockResolvedValue({ repoRoot: '/workspace/repository' })
    createSession.mockResolvedValue('created-project-session')

    render(<Sidebar />)

    fireEvent.click(screen.getByRole('button', { name: 'New project' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Use existing folder' }))

    const editor = screen.getByTestId('project-editor-modal')
    expect(editor).toHaveAttribute('data-source-folder', '')
    fireEvent.click(screen.getByRole('button', { name: 'Choose project source' }))

    await waitFor(() => expect(repositoryContextMock).toHaveBeenCalledWith('/workspace/repository/packages/app'))
    await waitFor(() => {
      expect(editor).toHaveAttribute('data-source-folder', '/workspace/repository/packages/app')
      expect(editor).toHaveAttribute('data-logical-root', '/workspace/repository')
      expect(editor).toHaveAttribute('data-suggested-name', 'repository')
    })

    fireEvent.click(screen.getByRole('button', { name: 'Submit create project' }))
    await waitFor(() => {
      expect(desktopUiPreferencesApiMock.updateProjectDisplayName).toHaveBeenCalledWith(
        '/workspace/repository',
        'Created project',
      )
      expect(createSession).toHaveBeenCalledWith('/workspace/repository/packages/app')
      expect(connectToSession).toHaveBeenCalledWith('created-project-session')
    })
    expect(createSession.mock.invocationCallOrder[0]).toBeLessThan(
      desktopUiPreferencesApiMock.updateProjectDisplayName.mock.invocationCallOrder[0]!,
    )
    expect(repositoryContextMock).toHaveBeenCalledTimes(1)
  })

  it('opens the session before repository context resolves and falls back after lookup failure', async () => {
    const repositoryContext = createDeferred<{ repoRoot: string | null; workDir?: string }>()
    repositoryContextMock.mockReturnValueOnce(repositoryContext.promise)
    createSession.mockResolvedValue('created-project-session')

    render(<Sidebar />)

    fireEvent.click(screen.getByRole('button', { name: 'New project' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Use existing folder' }))
    fireEvent.click(screen.getByRole('button', { name: 'Choose project source' }))
    fireEvent.click(screen.getByRole('button', { name: 'Submit create project' }))

    await waitFor(() => {
      expect(createSession).toHaveBeenCalledWith('/workspace/repository/packages/app')
      expect(connectToSession).toHaveBeenCalledWith('created-project-session')
      expect(screen.queryByTestId('project-editor-modal')).not.toBeInTheDocument()
    })
    expect(desktopUiPreferencesApiMock.updateProjectDisplayName).not.toHaveBeenCalled()

    await act(async () => {
      repositoryContext.reject(new Error('repository context unavailable'))
      await repositoryContext.promise.catch(() => undefined)
    })

    await waitFor(() => expect(desktopUiPreferencesApiMock.updateProjectDisplayName).toHaveBeenCalledWith(
      '/workspace/repository/packages/app',
      'Created project',
    ))
  })

  it('resets instead of persisting a redundant alias when creating with the folder name', async () => {
    repositoryContextMock.mockResolvedValue({
      repoRoot: '/workspace/repository',
      workDir: '/workspace/repository/packages/app',
    })
    createSession.mockResolvedValue('created-project-session')

    render(<Sidebar />)

    fireEvent.click(screen.getByRole('button', { name: 'New project' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Use existing folder' }))
    fireEvent.click(screen.getByRole('button', { name: 'Choose project source' }))
    await waitFor(() => expect(screen.getByTestId('project-editor-modal')).toHaveAttribute(
      'data-suggested-name',
      'repository',
    ))
    fireEvent.click(screen.getByRole('button', { name: 'Submit folder project name' }))

    await waitFor(() => {
      expect(connectToSession).toHaveBeenCalledWith('created-project-session')
      expect(screen.queryByTestId('project-editor-modal')).not.toBeInTheDocument()
    })
    expect(desktopUiPreferencesApiMock.updateProjectDisplayName).toHaveBeenCalledWith(
      '/workspace/repository',
      null,
    )
  })

  it('opens the session before reporting a project display-name save failure', async () => {
    let rejectDisplayNameSave!: (error: Error) => void
    const displayNameSave = new Promise<never>((_resolve, reject) => {
      rejectDisplayNameSave = reject
    })
    repositoryContextMock.mockResolvedValue({
      repoRoot: '/workspace/repository',
      workDir: '/workspace/repository/packages/app',
    })
    createSession.mockResolvedValue('created-project-session')
    desktopUiPreferencesApiMock.updateProjectDisplayName.mockReturnValueOnce(displayNameSave)

    render(<Sidebar />)

    fireEvent.click(screen.getByRole('button', { name: 'New project' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Use existing folder' }))
    fireEvent.click(screen.getByRole('button', { name: 'Choose project source' }))
    await waitFor(() => expect(repositoryContextMock).toHaveBeenCalled())
    fireEvent.click(screen.getByRole('button', { name: 'Submit create project' }))

    await waitFor(() => {
      expect(createSession).toHaveBeenCalledWith('/workspace/repository/packages/app')
      expect(connectToSession).toHaveBeenCalledWith('created-project-session')
      expect(screen.queryByTestId('project-editor-modal')).not.toBeInTheDocument()
    })
    expect(addToast).not.toHaveBeenCalled()

    await act(async () => {
      rejectDisplayNameSave(new Error('Display name save failed'))
      await displayNameSave.catch(() => undefined)
    })

    await waitFor(() => expect(addToast).toHaveBeenCalledWith({
      type: 'error',
      message: 'Display name save failed',
    }))
    expect(deleteSession).not.toHaveBeenCalled()
    expect(deleteSessions).not.toHaveBeenCalled()
  })

  it('does not persist an orphan display name when session creation fails', async () => {
    repositoryContextMock.mockResolvedValue({
      repoRoot: '/workspace/repository',
      workDir: '/workspace/repository/packages/app',
    })
    createSession.mockRejectedValueOnce(new Error('Session creation failed'))

    render(<Sidebar />)

    fireEvent.click(screen.getByRole('button', { name: 'New project' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Use existing folder' }))
    fireEvent.click(screen.getByRole('button', { name: 'Choose project source' }))
    await waitFor(() => expect(repositoryContextMock).toHaveBeenCalled())
    fireEvent.click(screen.getByRole('button', { name: 'Submit create project' }))

    await waitFor(() => {
      expect(createSession).toHaveBeenCalledWith('/workspace/repository/packages/app')
      expect(screen.getByTestId('project-editor-modal')).toBeInTheDocument()
    })
    expect(desktopUiPreferencesApiMock.updateProjectDisplayName).not.toHaveBeenCalled()
    expect(connectToSession).not.toHaveBeenCalled()
  })

  it('uses the resolved non-git workDir as the project display-name key', async () => {
    repositoryContextMock.mockResolvedValue({
      repoRoot: null,
      workDir: '/real/workspace/project',
    })
    createSession.mockResolvedValue('created-project-session')

    render(<Sidebar />)

    fireEvent.click(screen.getByRole('button', { name: 'New project' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Use existing folder' }))
    fireEvent.click(screen.getByRole('button', { name: 'Choose project source' }))

    await waitFor(() => {
      const editor = screen.getByTestId('project-editor-modal')
      expect(editor).toHaveAttribute('data-source-folder', '/workspace/repository/packages/app')
      expect(editor).toHaveAttribute('data-logical-root', '/real/workspace/project')
      expect(editor).toHaveAttribute('data-suggested-name', 'project')
    })

    fireEvent.click(screen.getByRole('button', { name: 'Submit create project' }))
    await waitFor(() => {
      expect(desktopUiPreferencesApiMock.updateProjectDisplayName).toHaveBeenCalledWith(
        '/real/workspace/project',
        'Created project',
      )
      expect(createSession).toHaveBeenCalledWith('/workspace/repository/packages/app')
    })
  })

  it('keeps the latest logical root when an earlier lookup finishes late', async () => {
    let resolveFirstLookup: (value: { repoRoot: string | null }) => void = () => undefined
    const firstLookup = new Promise<{ repoRoot: string | null }>((resolve) => {
      resolveFirstLookup = resolve
    })
    repositoryContextMock
      .mockImplementationOnce(() => firstLookup)
      .mockResolvedValueOnce({ repoRoot: '/workspace/other' })

    render(<Sidebar />)

    fireEvent.click(screen.getByRole('button', { name: 'New project' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Use existing folder' }))
    fireEvent.click(screen.getByRole('button', { name: 'Choose project source' }))
    fireEvent.click(screen.getByRole('button', { name: 'Choose other project source' }))

    await waitFor(() => expect(repositoryContextMock).toHaveBeenNthCalledWith(2, '/workspace/other'))
    await waitFor(() => {
      const editor = screen.getByTestId('project-editor-modal')
      expect(editor).toHaveAttribute('data-source-folder', '/workspace/other')
      expect(editor).toHaveAttribute('data-logical-root', '/workspace/other')
      expect(editor).toHaveAttribute('data-suggested-name', 'other')
    })

    await act(async () => {
      resolveFirstLookup({ repoRoot: '/workspace/repository' })
      await Promise.resolve()
    })

    const editor = screen.getByTestId('project-editor-modal')
    expect(editor).toHaveAttribute('data-source-folder', '/workspace/other')
    expect(editor).toHaveAttribute('data-logical-root', '/workspace/other')
    expect(editor).toHaveAttribute('data-suggested-name', 'other')
  })

  it('edits, resets, and removes a project without changing its real path or sessions', async () => {
    act(() => {
      hydrateProjectDisplayNames(
        { '/workspace/alpha': 'Custom alpha' },
        captureProjectDisplayNameHydrationRevision(),
      )
    })
    useSessionStore.setState({
      sessions: [makeSession('alpha-1', 'Alpha Session', '/workspace/alpha', new Date().toISOString())],
    })

    render(<Sidebar />)

    fireEvent.click(screen.getByRole('button', { name: 'Project actions for Custom alpha' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Edit project' }))
    const editor = screen.getByTestId('project-editor-modal')
    expect(editor).toHaveAttribute('data-logical-root', '/workspace/alpha')
    expect(editor).toHaveAttribute('data-initial-name', 'Custom alpha')

    fireEvent.click(screen.getByRole('button', { name: 'Submit edit project' }))
    await waitFor(() => {
      expect(desktopUiPreferencesApiMock.updateProjectDisplayName).toHaveBeenNthCalledWith(
        1,
        '/workspace/alpha',
        'Edited project',
      )
      expect(screen.getByText('Edited project')).toBeInTheDocument()
    })
    expect(screen.getByRole('button', { name: 'Collapse Edited project' })).toHaveAttribute('title', '/workspace/alpha')

    fireEvent.click(screen.getByRole('button', { name: 'Project actions for Edited project' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Edit project' }))
    fireEvent.click(screen.getByRole('button', { name: 'Restore folder name' }))
    await waitFor(() => {
      expect(desktopUiPreferencesApiMock.updateProjectDisplayName).toHaveBeenNthCalledWith(
        2,
        '/workspace/alpha',
        null,
      )
      expect(screen.getByText('alpha')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByRole('button', { name: 'Close project editor' }))
    fireEvent.click(screen.getByRole('button', { name: 'Project actions for alpha' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Edit project' }))
    fireEvent.click(screen.getByRole('button', { name: 'Remove project from sidebar' }))

    await waitFor(() => expect(screen.queryByTestId('sidebar-project-group-workspace-alpha')).not.toBeInTheDocument())
    expect(deleteSession).not.toHaveBeenCalled()
    expect(deleteSessions).not.toHaveBeenCalled()
  })

  it('resets the alias when an edit saves the default folder name', async () => {
    act(() => {
      hydrateProjectDisplayNames(
        { '/workspace/alpha': 'Custom alpha' },
        captureProjectDisplayNameHydrationRevision(),
      )
    })
    useSessionStore.setState({
      sessions: [makeSession('alpha-1', 'Alpha Session', '/workspace/alpha', new Date().toISOString())],
    })

    render(<Sidebar />)

    fireEvent.click(screen.getByRole('button', { name: 'Project actions for Custom alpha' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Edit project' }))
    fireEvent.click(screen.getByRole('button', { name: 'Submit folder project name' }))

    await waitFor(() => {
      expect(desktopUiPreferencesApiMock.updateProjectDisplayName).toHaveBeenCalledWith(
        '/workspace/alpha',
        null,
      )
      expect(screen.getByText('alpha')).toBeInTheDocument()
    })
  })

  it('resets the default name before a stale alias hydration finishes', async () => {
    const hydrationRevision = captureProjectDisplayNameHydrationRevision()
    useSessionStore.setState({
      sessions: [makeSession('alpha-1', 'Alpha Session', '/workspace/alpha', new Date().toISOString())],
    })

    render(<Sidebar />)

    fireEvent.click(screen.getByRole('button', { name: 'Project actions for alpha' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Edit project' }))
    fireEvent.click(screen.getByRole('button', { name: 'Submit folder project name' }))

    await waitFor(() => expect(desktopUiPreferencesApiMock.updateProjectDisplayName).toHaveBeenCalledWith(
      '/workspace/alpha',
      null,
    ))

    act(() => {
      hydrateProjectDisplayNames(
        { '/workspace/alpha': 'Stale custom alpha' },
        hydrationRevision,
      )
    })

    expect(screen.getByText('alpha')).toBeInTheDocument()
    expect(screen.queryByText('Stale custom alpha')).not.toBeInTheDocument()
  })

  it('recognizes a normalized whitespace basename as the default project name', async () => {
    const projectKey = '/workspace/My  project '
    act(() => {
      hydrateProjectDisplayNames(
        { [projectKey]: 'Custom project' },
        captureProjectDisplayNameHydrationRevision(),
      )
    })
    useSessionStore.setState({
      sessions: [makeSession('project-1', 'Project Session', projectKey, new Date().toISOString())],
    })

    render(<Sidebar />)

    fireEvent.click(screen.getByRole('button', { name: 'Project actions for Custom project' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Edit project' }))
    fireEvent.click(screen.getByRole('button', { name: 'Submit folder project name' }))

    await waitFor(() => expect(desktopUiPreferencesApiMock.updateProjectDisplayName).toHaveBeenCalledWith(
      projectKey,
      null,
    ))
  })

  it('keeps remove-from-sidebar idempotent after delayed preferences hide the project', async () => {
    const preferencesResponse = createDeferred<DesktopUiPreferencesResponse>()
    useSessionStore.setState({
      sessions: [makeSession('alpha-1', 'Alpha Session', '/workspace/alpha', new Date().toISOString())],
    })

    render(<Sidebar desktopUiPreferencesRequest={preferencesResponse.promise} />)

    fireEvent.click(screen.getByRole('button', { name: 'Project actions for alpha' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Edit project' }))

    await act(async () => {
      preferencesResponse.resolve(makeDesktopUiPreferencesResponse({
        sidebar: {
          projectOrder: [],
          pinnedProjects: [],
          hiddenProjects: ['/workspace/alpha'],
          projectOrganization: 'recentProject',
          projectSortBy: 'updatedAt',
        },
      }))
      await preferencesResponse.promise
    })

    await waitFor(() => {
      expect(screen.queryByTestId('sidebar-project-group-workspace-alpha')).not.toBeInTheDocument()
      expect(screen.getByTestId('project-editor-modal')).toBeInTheDocument()
    })
    fireEvent.click(screen.getByRole('button', { name: 'Remove project from sidebar' }))

    await waitFor(() => expect(screen.queryByTestId('project-editor-modal')).not.toBeInTheDocument())
    expect(screen.queryByTestId('sidebar-project-group-workspace-alpha')).not.toBeInTheDocument()
    expect(desktopUiPreferencesApiMock.updateSidebarPreferences).not.toHaveBeenCalled()
  })

  it('sorts same-named projects by their stable real-path keys', async () => {
    act(() => {
      hydrateProjectDisplayNames(
        {
          '/workspace/alpha': 'Same name',
          '/workspace/beta': 'Same name',
        },
        captureProjectDisplayNameHydrationRevision(),
      )
    })
    useSessionStore.setState({
      sessions: [
        makeSession('alpha-1', 'Alpha Session', '/workspace/alpha', '2026-05-01T00:00:00.000Z'),
        makeSession('beta-1', 'Beta Session', '/workspace/beta', '2026-05-02T00:00:00.000Z'),
      ],
    })

    render(<Sidebar />)

    fireEvent.click(screen.getByRole('button', { name: 'Project menu' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Organize sidebar' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'By project' }))

    await waitFor(() => {
      expect(screen.getAllByTestId(/^sidebar-project-group-/).map((group) => group.getAttribute('data-testid'))).toEqual([
        'sidebar-project-group-workspace-alpha',
        'sidebar-project-group-workspace-beta',
      ])
    })
  })

  it('persists project header sort preferences through desktop UI settings', async () => {
    useSessionStore.setState({
      sessions: [
        makeSession('alpha-1', 'Alpha Session', '/workspace/alpha', '2026-03-01T00:00:00.000Z'),
        {
          ...makeSession('beta-1', 'Beta Session', '/workspace/beta', '2026-02-01T00:00:00.000Z'),
          createdAt: '2026-04-01T00:00:00.000Z',
        },
      ],
    })

    render(<Sidebar />)

    expect(projectGroupNames().slice(0, 2)).toEqual(['alpha', 'beta'])

    fireEvent.click(screen.getByRole('button', { name: 'Project menu' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Sort condition' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Created time' }))

    await waitFor(() => {
      expect(desktopUiPreferencesApiMock.updateSidebarPreferences).toHaveBeenCalledWith({
        projectOrder: [],
        pinnedProjects: [],
        hiddenProjects: [],
        projectOrganization: 'recentProject',
        projectSortBy: 'createdAt',
      })
      expect(projectGroupNames().slice(0, 2)).toEqual(['beta', 'alpha'])
    })
    expect(window.localStorage.getItem(PROJECT_SORT_STORAGE_KEY)).toBe('createdAt')
  })

  it('hides archive-all from the project header menu', () => {
    const now = new Date().toISOString()
    useSessionStore.setState({
      sessions: [
        makeSession('alpha-1', 'Alpha Session', '/workspace/alpha', now),
        makeSession('beta-1', 'Beta Session', '/workspace/beta', now),
      ],
    })

    render(<Sidebar />)

    fireEvent.click(screen.getByRole('button', { name: 'Project menu' }))

    expect(screen.queryByRole('menuitem', { name: 'Archive all chats' })).not.toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: 'Organize sidebar' })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: 'Sort condition' })).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('keeps project row actions hidden until project hover or focus', () => {
    useSessionStore.setState({
      sessions: [
        makeSession('alpha-1', 'Alpha Session', '/workspace/alpha', new Date().toISOString()),
      ],
    })

    render(<Sidebar />)

    const actionButton = screen.getByRole('button', { name: 'Project actions for alpha' })
    expect(actionButton.parentElement).toHaveClass('opacity-0')
    expect(actionButton.parentElement).toHaveClass('group-hover/project:opacity-100')
    expect(actionButton.parentElement).toHaveClass('group-focus-within/project:opacity-100')
  })

  it('shows the project action menu with pin and Finder actions', async () => {
    const now = new Date().toISOString()
    useSessionStore.setState({
      sessions: [
        makeSession('alpha-1', 'Alpha Session', '/workspace/alpha', now),
      ],
    })

    render(<Sidebar />)

    fireEvent.click(screen.getByRole('button', { name: 'Project actions for alpha' }))

    expect(screen.getByRole('menuitem', { name: 'Edit project' })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: 'Pin Project' })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: 'Open in Finder' })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: 'Hide from Sidebar' })).toBeInTheDocument()
    expect(screen.queryByRole('menuitem', { name: 'Create Permanent Worktree' })).not.toBeInTheDocument()
    expect(screen.queryByRole('menuitem', { name: 'Rename Project' })).not.toBeInTheDocument()
    expect(screen.queryByRole('menuitem', { name: 'Archive Conversations' })).not.toBeInTheDocument()

    await act(async () => {
      fireEvent.click(screen.getByRole('menuitem', { name: 'Open in Finder' }))
    })

    expect(openTargetStoreMock.ensureTargets).toHaveBeenCalledTimes(2)
    expect(openTargetStoreMock.openTarget).toHaveBeenCalledWith('finder', '/workspace/alpha')
  })

  it.each([
    ['win32', 'explorer', 'Open in File Explorer'],
    ['linux', 'file-manager', 'Open in File Manager'],
  ])('uses the %s file-manager name in project actions', (platform, targetId, actionName) => {
    openTargetStoreMock.platform = platform
    openTargetStoreMock.targets = [{
      id: targetId,
      kind: 'file_manager',
      label: actionName,
      platform,
    }]
    useSessionStore.setState({
      sessions: [
        makeSession('alpha-1', 'Alpha Session', '/workspace/alpha', new Date().toISOString()),
      ],
    })

    render(<Sidebar />)

    fireEvent.click(screen.getByRole('button', { name: 'Project actions for alpha' }))

    expect(screen.getByRole('menuitem', { name: actionName })).toBeInTheDocument()
    expect(screen.queryByRole('menuitem', { name: 'Open in Finder' })).not.toBeInTheDocument()
  })

  it('pins a project above the rest of the project list', async () => {
    const base = new Date('2026-05-15T10:00:00.000Z').getTime()
    useSessionStore.setState({
      sessions: [
        makeSession('alpha-1', 'Alpha Session', '/workspace/alpha', new Date(base).toISOString()),
        makeSession('beta-1', 'Beta Session', '/workspace/beta', new Date(base - 20_000).toISOString()),
      ],
    })

    render(<Sidebar />)

    expect(projectGroupNames().slice(0, 2)).toEqual(['alpha', 'beta'])

    fireEvent.click(screen.getByRole('button', { name: 'Project actions for beta' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Pin Project' }))

    await waitFor(() => {
      expect(projectGroupNames().slice(0, 2)).toEqual(['beta', 'alpha'])
    })
    expect(JSON.parse(window.localStorage.getItem(PROJECT_PINNED_STORAGE_KEY) ?? '[]')).toEqual(['/workspace/beta'])
  })

  it('removes a project from the sidebar without deleting its sessions', async () => {
    const base = new Date('2026-05-15T10:00:00.000Z').getTime()
    useSessionStore.setState({
      sessions: [
        makeSession('alpha-1', 'Alpha Session', '/workspace/alpha', new Date(base).toISOString()),
        makeSession('beta-1', 'Beta Session', '/workspace/beta', new Date(base - 20_000).toISOString()),
      ],
    })

    render(<Sidebar />)

    fireEvent.click(screen.getByRole('button', { name: 'Project actions for beta' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Hide from Sidebar' }))

    await waitFor(() => {
      expect(screen.queryByText('beta')).not.toBeInTheDocument()
    })
    expect(screen.getByText('alpha')).toBeInTheDocument()
    expect(deleteSessions).not.toHaveBeenCalled()
    expect(deleteSession).not.toHaveBeenCalled()
    expect(JSON.parse(window.localStorage.getItem(PROJECT_HIDDEN_STORAGE_KEY) ?? '[]')).toEqual(['/workspace/beta'])
    expect(addToast).toHaveBeenCalledWith({
      type: 'info',
      message: 'beta was hidden from the sidebar. Existing sessions were not deleted.',
    })
  })

  it('keeps hidden projects out of the sidebar without the removed project filter', () => {
    window.localStorage.setItem(PROJECT_HIDDEN_STORAGE_KEY, JSON.stringify(['/workspace/beta']))
    const now = new Date().toISOString()
    useSessionStore.setState({
      sessions: [
        makeSession('alpha-1', 'Alpha Session', '/workspace/alpha', now),
        makeSession('beta-1', 'Beta Session', '/workspace/beta', now),
      ],
    })

    render(<Sidebar />)

    expect(screen.getByText('alpha')).toBeInTheDocument()
    expect(screen.queryByText('beta')).not.toBeInTheDocument()
    expect(screen.queryByTestId('project-filter')).not.toBeInTheDocument()
  })

  it('restores hidden projects from the project header menu', async () => {
    window.localStorage.setItem(PROJECT_HIDDEN_STORAGE_KEY, JSON.stringify(['/workspace/beta']))
    const now = new Date().toISOString()
    useSessionStore.setState({
      sessions: [
        makeSession('alpha-1', 'Alpha Session', '/workspace/alpha', now),
        makeSession('beta-1', 'Beta Session', '/workspace/beta', now),
      ],
    })

    render(<Sidebar />)

    expect(screen.getByText('alpha')).toBeInTheDocument()
    expect(screen.queryByText('beta')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Project menu' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Restore hidden projects (1)' }))

    await waitFor(() => {
      expect(screen.getByText('beta')).toBeInTheDocument()
    })
    expect(JSON.parse(window.localStorage.getItem(PROJECT_HIDDEN_STORAGE_KEY) ?? '[]')).toEqual([])
    expect(desktopUiPreferencesApiMock.updateSidebarPreferences).toHaveBeenCalledWith({
      projectOrder: [],
      pinnedProjects: [],
      hiddenProjects: [],
      projectOrganization: 'recentProject',
      projectSortBy: 'updatedAt',
    })
  })

  it('restores a hidden project when a new session is created in that project', async () => {
    window.localStorage.setItem(PROJECT_HIDDEN_STORAGE_KEY, JSON.stringify(['/workspace/beta']))
    createSession.mockResolvedValue('beta-new')
    const now = new Date().toISOString()
    useSessionStore.setState({
      sessions: [
        makeSession('alpha-1', 'Alpha Session', '/workspace/alpha', now),
        makeSession('beta-1', 'Beta Session', '/workspace/beta', now),
      ],
    })
    useTabStore.setState({
      tabs: [{ sessionId: 'beta-1', title: 'Beta Session', type: 'session', status: 'idle' }],
      activeTabId: 'beta-1',
    })

    render(<Sidebar />)

    expect(screen.queryByText('beta')).not.toBeInTheDocument()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'New Session' }))
    })

    await waitFor(() => {
      expect(createSession).toHaveBeenCalledWith('/workspace/beta')
      expect(screen.getByText('beta')).toBeInTheDocument()
    })
    expect(JSON.parse(window.localStorage.getItem(PROJECT_HIDDEN_STORAGE_KEY) ?? '[]')).toEqual([])
    expect(desktopUiPreferencesApiMock.updateSidebarPreferences).toHaveBeenCalledWith({
      projectOrder: [],
      pinnedProjects: [],
      hiddenProjects: [],
      projectOrganization: 'recentProject',
      projectSortBy: 'updatedAt',
    })
  })

  it('uses server sidebar preferences across browser and desktop storage contexts', async () => {
    const preferencesRequest = Promise.resolve(makeDesktopUiPreferencesResponse({
      sidebar: {
        projectOrder: ['/workspace/beta', '/workspace/alpha'],
        pinnedProjects: ['/workspace/beta'],
        hiddenProjects: ['/workspace/alpha'],
        projectOrganization: 'recentProject',
        projectSortBy: 'updatedAt',
      },
    }))
    const now = new Date().toISOString()
    useSessionStore.setState({
      sessions: [
        makeSession('alpha-1', 'Alpha Session', '/workspace/alpha', now),
        makeSession('beta-1', 'Beta Session', '/workspace/beta', now),
      ],
    })

    const onPreferencesConsumed = vi.fn()
    render(
      <Sidebar
        desktopUiPreferencesRequest={preferencesRequest}
        onDesktopUiPreferencesConsumed={onPreferencesConsumed}
      />,
    )

    await waitFor(() => {
      expect(screen.queryByText('alpha')).not.toBeInTheDocument()
      expect(screen.getByText('beta')).toBeInTheDocument()
      expect(onPreferencesConsumed).toHaveBeenCalledWith(preferencesRequest)
    })
    expect(JSON.parse(window.localStorage.getItem(PROJECT_ORDER_STORAGE_KEY) ?? '[]')).toEqual([
      '/workspace/beta',
      '/workspace/alpha',
    ])
    expect(JSON.parse(window.localStorage.getItem(PROJECT_PINNED_STORAGE_KEY) ?? '[]')).toEqual(['/workspace/beta'])
    expect(JSON.parse(window.localStorage.getItem(PROJECT_HIDDEN_STORAGE_KEY) ?? '[]')).toEqual(['/workspace/alpha'])
  })

  it('invalidates stale bootstrap preferences before a mobile drawer remount', async () => {
    const preferencesResponse = createDeferred<DesktopUiPreferencesResponse>()
    useSessionStore.setState({
      sessions: [makeSession('alpha-1', 'Alpha Session', '/workspace/alpha', new Date().toISOString())],
    })

    render(<SidebarDrawerHarness request={preferencesResponse.promise} />)

    fireEvent.click(screen.getByRole('button', { name: 'Project actions for alpha' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Hide from Sidebar' }))
    await waitFor(() => {
      expect(screen.queryByTestId('sidebar-project-group-workspace-alpha')).not.toBeInTheDocument()
      expect(desktopUiPreferencesApiMock.updateSidebarPreferences).toHaveBeenCalledWith({
        projectOrder: [],
        pinnedProjects: [],
        hiddenProjects: ['/workspace/alpha'],
        projectOrganization: 'recentProject',
        projectSortBy: 'updatedAt',
      })
    })

    fireEvent.click(screen.getByRole('button', { name: 'Close drawer harness' }))
    fireEvent.click(screen.getByRole('button', { name: 'Open drawer harness' }))
    expect(screen.queryByTestId('sidebar-project-group-workspace-alpha')).not.toBeInTheDocument()

    await act(async () => {
      preferencesResponse.resolve(makeDesktopUiPreferencesResponse())
      await preferencesResponse.promise
    })

    expect(screen.queryByTestId('sidebar-project-group-workspace-alpha')).not.toBeInTheDocument()
    expect(JSON.parse(window.localStorage.getItem(PROJECT_HIDDEN_STORAGE_KEY) ?? '[]')).toEqual([
      '/workspace/alpha',
    ])
  })

  it('migrates cached local sidebar preferences when the server file is missing after update', async () => {
    const preferencesRequest = Promise.resolve(makeDesktopUiPreferencesResponse({ exists: false }))
    window.localStorage.setItem(PROJECT_HIDDEN_STORAGE_KEY, JSON.stringify(['/workspace/beta']))
    useSessionStore.setState({
      sessions: [
        makeSession('alpha-1', 'Alpha Session', '/workspace/alpha', new Date().toISOString()),
        makeSession('beta-1', 'Beta Session', '/workspace/beta', new Date().toISOString()),
      ],
    })

    render(<Sidebar desktopUiPreferencesRequest={preferencesRequest} />)

    await waitFor(() => {
      expect(desktopUiPreferencesApiMock.updateSidebarPreferences).toHaveBeenCalledWith({
        projectOrder: [],
        pinnedProjects: [],
        hiddenProjects: ['/workspace/beta'],
        projectOrganization: 'recentProject',
        projectSortBy: 'updatedAt',
      })
    })
    expect(screen.queryByText('beta')).not.toBeInTheDocument()
  })

  it('ignores corrupt hidden project storage for backward compatibility', () => {
    window.localStorage.setItem(PROJECT_HIDDEN_STORAGE_KEY, '{bad json')
    useSessionStore.setState({
      sessions: [
        makeSession('alpha-1', 'Alpha Session', '/workspace/alpha', new Date().toISOString()),
      ],
    })

    render(<Sidebar />)

    expect(screen.getByText('alpha')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Alpha Session/ })).toBeInTheDocument()
  })

  it('keeps persisted worktree sessions under the source project group', () => {
    const now = new Date().toISOString()
    useSessionStore.setState({
      sessions: [
        makeSession('source-1', 'Source Session', '/workspace/repo', now),
        {
          ...makeSession('worktree-1', 'Worktree Session', '/workspace/repo/.claude/worktrees/desktop-main-12345678', now),
          projectRoot: '/workspace/repo',
        },
        {
          ...makeSession('subdir-1', 'Subdir Session', '/workspace/repo/packages/app', now),
          projectRoot: '/workspace/repo',
        },
      ],
    })

    render(<Sidebar />)

    expect(screen.getByText('repo')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Source Session/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Worktree Session/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Subdir Session/ })).toBeInTheDocument()
    expect(screen.getAllByText('worktree')).toHaveLength(1)
  })

  it('does not label a cleaned worktree as a missing project directory', () => {
    const now = new Date().toISOString()
    useSessionStore.setState({
      sessions: [{
        ...makeSession(
          'cleaned-worktree',
          'Cleaned Worktree Session',
          '/workspace/repo/.claude/worktrees/desktop-main-12345678',
          now,
        ),
        projectRoot: '/workspace/repo',
        workDirExists: false,
        workspaceState: 'worktree_removed',
      }],
    })

    render(<Sidebar />)

    expect(screen.getByRole('button', { name: /Cleaned Worktree Session/ })).toBeInTheDocument()
    expect(screen.queryByText('Missing')).not.toBeInTheDocument()
    expect(screen.getByText('worktree')).toBeInTheDocument()
  })

  it('keeps a Windows drive root session separate from sessions in child projects', () => {
    const now = new Date().toISOString()
    useSessionStore.setState({
      sessions: [
        makeSession('drive-root', 'Drive Root Session', 'D:\\', now),
        makeSession('drive-project', 'Drive Project Session', 'D:\\SomeProject', now),
      ],
    })

    render(<Sidebar />)

    expect(screen.getByText('D:')).toBeInTheDocument()
    expect(screen.getByText('SomeProject')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Drive Root Session/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Drive Project Session/ })).toBeInTheDocument()
  })

  it('does not restore a hidden Windows drive root when creating a child project session', async () => {
    window.localStorage.setItem(PROJECT_HIDDEN_STORAGE_KEY, JSON.stringify(['D:\\']))
    createSession.mockResolvedValue('child-new')
    const now = new Date().toISOString()
    useSessionStore.setState({
      sessions: [
        makeSession('child-1', 'Child Session', 'D:\\workspace\\code\\cc-haha', now),
      ],
    })
    useTabStore.setState({
      tabs: [{ sessionId: 'child-1', title: 'Child Session', type: 'session', status: 'idle' }],
      activeTabId: 'child-1',
    })

    render(<Sidebar />)

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'New Session' }))
    })

    await waitFor(() => {
      expect(createSession).toHaveBeenCalledWith('D:\\workspace\\code\\cc-haha')
    })
    expect(JSON.parse(window.localStorage.getItem(PROJECT_HIDDEN_STORAGE_KEY) ?? '[]')).toEqual(['D:\\'])
    expect(desktopUiPreferencesApiMock.updateSidebarPreferences).not.toHaveBeenCalled()
  })

  it('right-aligns running status, worktree marker, and update time on session rows', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-19T12:00:00.000Z'))

    useSessionStore.setState({
      sessions: [
        {
          ...makeSession('running-worktree', 'Running Worktree', '/workspace/repo/.claude/worktrees/desktop-main-12345678', '2026-05-19T07:00:00.000Z'),
          projectRoot: '/workspace/repo',
        },
        makeSession('background-running', 'Background Running', '/workspace/repo', '2026-05-19T10:30:00.000Z'),
        makeSession('idle-source', 'Idle Source', '/workspace/repo', '2026-05-19T11:40:00.000Z'),
      ],
    })
    useTabStore.setState({
      tabs: [
        { sessionId: 'running-worktree', title: 'Running Worktree', type: 'session', status: 'running' },
        { sessionId: 'background-running', title: 'Background Running', type: 'session', status: 'idle' },
        { sessionId: 'idle-source', title: 'Idle Source', type: 'session', status: 'idle' },
      ],
      activeTabId: 'running-worktree',
    })
    useChatStore.setState({
      sessions: {
        'background-running': makeChatSessionState({
          backgroundAgentTasks: {
            'agent-task-1': {
              taskId: 'agent-task-1',
              toolUseId: 'agent-tool-1',
              status: 'running',
              taskType: 'local_agent',
              description: 'Review screenshots',
              startedAt: 1,
              updatedAt: 2,
            },
          },
        }),
      },
    })

    render(<Sidebar />)

    const runningRow = screen.getByRole('button', { name: /Running Worktree/ })
    expect(within(runningRow).getByLabelText('Session running')).toBeInTheDocument()
    expect(within(runningRow).getByText('worktree')).toHaveClass('sr-only')
    expect(within(runningRow).getByText('5h ago')).toBeInTheDocument()

    const backgroundRunningRow = screen.getByRole('button', { name: /Background Running/ })
    expect(within(backgroundRunningRow).getByLabelText('Session running')).toBeInTheDocument()

    const idleRow = screen.getByRole('button', { name: /Idle Source/ })
    expect(within(idleRow).queryByLabelText('Session running')).not.toBeInTheDocument()
    expect(within(idleRow).getByText('20m ago')).toBeInTheDocument()
    const idleMeta = within(idleRow).getByTitle('last updated 20m ago')
    expect(idleMeta).toHaveClass('flex-shrink-0', 'whitespace-nowrap')
    expect(idleMeta).not.toHaveClass('min-w-[78px]')
  })

  it('shows a toast when session creation fails', async () => {
    createSession.mockRejectedValue(new Error('boom'))

    render(<Sidebar />)

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'New Session' }))
    })

    await waitFor(() => {
      expect(addToast).toHaveBeenCalledWith({
        type: 'error',
        message: 'boom',
      })
    })

    expect(useTabStore.getState().tabs).toEqual([])
  })

  it('requires confirmation before deleting a session from the sidebar', async () => {
    deleteSession.mockResolvedValue(undefined)
    useSessionStore.setState({
      sessions: [
        {
          id: 'session-1',
          title: 'Open Session',
          createdAt: new Date().toISOString(),
          modifiedAt: new Date().toISOString(),
          messageCount: 1,
          projectPath: '/workspace/project',
          workDir: '/workspace/project',
          workDirExists: true,
        },
      ],
    })
    useTabStore.setState({
      tabs: [{ sessionId: 'session-1', title: 'Open Session', type: 'session', status: 'idle' }],
      activeTabId: 'session-1',
    })

    render(<Sidebar />)

    fireEvent.contextMenu(screen.getByRole('button', { name: /Open Session/ }))

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))

    expect(deleteSession).not.toHaveBeenCalled()
    const dialog = screen.getByRole('dialog')
    expect(dialog).toBeInTheDocument()
    expect(screen.getByText('Delete this session? This cannot be undone.')).toBeInTheDocument()

    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }))
    })

    await waitFor(() => {
      expect(deleteSession).toHaveBeenCalledWith('session-1')
      expect(disconnectSession).toHaveBeenCalledWith('session-1')
    })

    expect(useTabStore.getState().tabs).toEqual([])
    expect(useTabStore.getState().activeTabId).toBeNull()
  })

  it('selects and deletes multiple sessions from batch mode', async () => {
    deleteSessions.mockResolvedValue({
      ok: true,
      successes: ['session-1', 'session-2'],
      failures: [],
    })
    const now = new Date().toISOString()
    useSessionStore.setState({
      sessions: [
        {
          id: 'session-1',
          title: 'First Session',
          createdAt: now,
          modifiedAt: now,
          messageCount: 1,
          projectPath: '/workspace/project',
          workDir: '/workspace/project',
          workDirExists: true,
        },
        {
          id: 'session-2',
          title: 'Second Session',
          createdAt: now,
          modifiedAt: now,
          messageCount: 1,
          projectPath: '/workspace/project',
          workDir: '/workspace/project',
          workDirExists: true,
        },
      ],
    })
    useTabStore.setState({
      tabs: [
        { sessionId: 'session-1', title: 'First Session', type: 'session', status: 'idle' },
        { sessionId: 'session-2', title: 'Second Session', type: 'session', status: 'idle' },
      ],
      activeTabId: 'session-1',
    })

    render(<Sidebar />)

    fireEvent.click(screen.getByRole('button', { name: 'Batch manage' }))
    fireEvent.click(screen.getByRole('button', { name: /First Session/ }))
    fireEvent.click(screen.getByRole('button', { name: /Second Session/ }))

    expect(screen.getByText('2 selected')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Delete selected (2)' }))
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByText('Delete 2 sessions? This cannot be undone.')).toBeInTheDocument()
    expect(within(dialog).getByText('First Session')).toBeInTheDocument()
    expect(within(dialog).getByText('Second Session')).toBeInTheDocument()

    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }))
    })

    await waitFor(() => {
      expect(deleteSessions).toHaveBeenCalledWith(['session-1', 'session-2'])
      expect(disconnectSession).toHaveBeenCalledWith('session-1')
      expect(disconnectSession).toHaveBeenCalledWith('session-2')
    })
    expect(useTabStore.getState().tabs).toEqual([])
    expect(addToast).toHaveBeenCalledWith({
      type: 'success',
      message: 'Deleted 2 sessions.',
    })
  })

  it('renders batch-selected sessions as separated selected rows', () => {
    const now = new Date().toISOString()
    useSessionStore.setState({
      sessions: [
        {
          id: 'session-1',
          title: 'First Session',
          createdAt: now,
          modifiedAt: now,
          messageCount: 1,
          projectPath: '/workspace/project',
          workDir: '/workspace/project',
          workDirExists: true,
        },
        {
          id: 'session-2',
          title: 'Second Session',
          createdAt: now,
          modifiedAt: now,
          messageCount: 1,
          projectPath: '/workspace/project',
          workDir: '/workspace/project',
          workDirExists: true,
        },
        {
          id: 'session-3',
          title: 'Third Session',
          createdAt: now,
          modifiedAt: now,
          messageCount: 1,
          projectPath: '/workspace/project',
          workDir: '/workspace/project',
          workDirExists: true,
        },
      ],
    })
    useTabStore.setState({
      tabs: [{ sessionId: 'session-2', title: 'Second Session', type: 'session', status: 'idle' }],
      activeTabId: 'session-2',
    })

    render(<Sidebar />)

    fireEvent.click(screen.getByRole('button', { name: 'Batch manage' }))
    fireEvent.click(screen.getByRole('button', { name: /First Session/ }))

    expect(screen.getByRole('button', { name: /First Session/ }).parentElement).toHaveClass('mb-0.5')
    expect(screen.getByRole('button', { name: /First Session/ })).toHaveClass('sidebar-session-row--selected')
    expect(screen.getByRole('button', { name: /Second Session/ })).toHaveClass('sidebar-session-row--active')
    expect(screen.getByRole('button', { name: /Third Session/ })).toHaveClass('sidebar-session-row--idle')
  })

  it('collapses into an icon rail and expands back', async () => {
    render(<Sidebar />)

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Collapse sidebar' }))
    })

    expect(useUIStore.getState().sidebarOpen).toBe(false)
    expect(screen.queryByRole('button', { name: 'Search chats' })).not.toBeInTheDocument()
    expect(screen.getByRole('complementary')).toHaveAttribute('data-state', 'closed')
    expect(screen.getByTestId('sidebar-expand-button')).toHaveClass('sidebar-toggle-button--collapsed')

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Expand sidebar' }))
    })

    expect(useUIStore.getState().sidebarOpen).toBe(true)
    expect(screen.getByRole('button', { name: 'Search chats' })).toBeInTheDocument()
    expect(screen.getByRole('complementary')).toHaveAttribute('data-state', 'open')
  })

  it('shows the brand mark only on the rail, where the wordmark is clamped away', async () => {
    render(<Sidebar />)

    // Scope to the wordmark's own row — the GitHub link in the same header is
    // also an svg and would answer a looser query.
    const brandRow = () => screen.getByText('haha').closest('div')

    // Expanded, the name carries the brand and the mark beside it is clutter.
    expect(brandRow()?.querySelector('svg')).toBeNull()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Collapse sidebar' }))
    })

    // Collapsed, the copy is width-clamped to zero, so the mark is the only
    // thing left to identify the app.
    expect(brandRow()?.querySelector('svg')).not.toBeNull()
  })

  it('renders search controls without the removed embedded project filter', () => {
    render(<Sidebar />)

    expect(screen.getByTestId('sidebar-search-controls-section')).toHaveStyle({ overflow: 'visible' })
    expect(screen.getByTestId('sidebar-search-controls-section')).toHaveClass('relative', 'z-20')
    expect(screen.getByRole('button', { name: 'Search chats' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /All projects/i })).not.toBeInTheDocument()
    expect(screen.queryByTestId('project-filter')).not.toBeInTheDocument()
  })

  it('keeps the session list section in a constrained flex column for scrolling', () => {
    render(<Sidebar />)

    expect(screen.getByTestId('sidebar-session-list-section')).toHaveClass('flex', 'flex-1', 'min-h-0', 'flex-col')
  })

  it('keeps the settings dock opaque above the scrolling session list', () => {
    render(<Sidebar />)

    expect(screen.getByTestId('sidebar-settings-dock')).toHaveClass('sidebar-settings-dock')
    expect(screen.getByTestId('sidebar-settings-dock')).toHaveClass('absolute', 'bottom-0')
  })

  it('keeps mobile navigation focused on chat sessions', async () => {
    const onRequestClose = vi.fn()
    createSession.mockResolvedValue('session-mobile-new')
    useSessionStore.setState({
      sessions: [
        {
          id: 'session-1',
          title: 'Open Session',
          createdAt: new Date().toISOString(),
          modifiedAt: new Date().toISOString(),
          messageCount: 1,
          projectPath: '/workspace/project',
          workDir: '/workspace/project',
          workDirExists: true,
        },
      ],
    })

    render(<Sidebar isMobile onRequestClose={onRequestClose} />)

    expect(screen.queryByRole('button', { name: 'Scheduled' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Skills Market' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Settings' })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /Open Session/ }))
    expect(onRequestClose).toHaveBeenCalledTimes(1)

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'New Session' }))
    })

    await waitFor(() => {
      expect(createSession).toHaveBeenCalled()
    })
    expect(onRequestClose).toHaveBeenCalledTimes(2)
  })

  it('keeps the market entry available in desktop navigation', () => {
    render(<Sidebar />)

    fireEvent.click(screen.getByRole('button', { name: 'Skills Market' }))

    expect(useTabStore.getState().activeTabId).toBe('__market__')
    expect(useTabStore.getState().tabs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sessionId: '__market__', title: 'Skills Market', type: 'market' }),
      ]),
    )
  })

  it('shows a loading state instead of an empty session list while initial fetch is pending', () => {
    useSessionStore.setState({ isLoading: true, sessions: [] })

    render(<Sidebar />)

    expect(screen.getByText('Loading...')).toBeInTheDocument()
    expect(screen.queryByText('No sessions')).not.toBeInTheDocument()
  })

  // Indexing is background housekeeping the user cannot act on, so a partially
  // built index must look exactly like a finished one: rows visible, no counter.
  it('keeps indexed rows visible while building without surfacing progress', () => {
    useSessionStore.setState({
      sessions: [makeSession('indexed-row', 'Indexed row', '/workspace/alpha', '2026-07-15T00:00:00.000Z')],
      indexStatus: {
        mode: 'on',
        state: 'building',
        discovered: 10,
        indexed: 2,
        degradedSources: 0,
        databaseBytes: 4096,
        walBytes: 0,
        lastUpdatedAt: '2026-07-15T00:00:00.000Z',
        lastErrorCode: null,
      },
    })

    render(<Sidebar />)

    expect(screen.getByRole('button', { name: /Indexed row/ })).toBeInTheDocument()
    expect(screen.queryByTestId('sidebar-index-progress')).not.toBeInTheDocument()
    expect(screen.queryByText(/2\s*\/\s*10/)).not.toBeInTheDocument()
    expect(screen.getByRole('status')).toBeEmptyDOMElement()
  })

  it.each(['ready', 'off'] as const)('hides visible index status when state is %s', (state) => {
    useSessionStore.setState({
      sessions: [makeSession('ready-row', 'Ready row', '/workspace/alpha', '2026-07-15T00:00:00.000Z')],
      indexStatus: {
        mode: state === 'off' ? 'off' : 'on',
        state,
        discovered: 1,
        indexed: 1,
        degradedSources: 0,
        databaseBytes: 4096,
        walBytes: 0,
        lastUpdatedAt: '2026-07-15T00:00:00.000Z',
        lastErrorCode: null,
      },
    })

    render(<Sidebar />)

    expect(screen.queryByTestId('sidebar-index-progress')).not.toBeInTheDocument()
    expect(screen.queryByTestId('sidebar-index-degraded')).not.toBeInTheDocument()
  })

  it('shows degraded fallback inline without emitting an error toast', () => {
    useSessionStore.setState({
      sessions: [makeSession('fallback-row', 'Fallback row', '/workspace/alpha', '2026-07-15T00:00:00.000Z')],
      error: null,
      indexStatus: {
        mode: 'on',
        state: 'degraded',
        discovered: 2,
        indexed: 1,
        degradedSources: 1,
        databaseBytes: 4096,
        walBytes: 0,
        lastUpdatedAt: '2026-07-15T00:00:00.000Z',
        lastErrorCode: 'source_unreadable',
      },
    })

    render(<Sidebar />)

    expect(screen.getByRole('button', { name: /Fallback row/ })).toBeInTheDocument()
    expect(screen.getByTestId('sidebar-index-degraded')).toHaveTextContent('Using standard history loading')
    expect(screen.queryByText('Session list failed')).not.toBeInTheDocument()
    expect(addToast).not.toHaveBeenCalled()
  })

  it('announces a session list failure and offers a retry', () => {
    useSessionStore.setState({ sessions: [], isLoading: false, error: 'upstream exploded' })

    render(<Sidebar />)

    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('Session list failed')
    expect(alert).toHaveTextContent('upstream exploded')

    fetchSessions.mockClear()
    fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }))
    expect(fetchSessions).toHaveBeenCalled()
  })

  it('does not claim there are no sessions while the list is failing', () => {
    useSessionStore.setState({ sessions: [], isLoading: false, error: 'upstream exploded' })

    render(<Sidebar />)

    // Showing "no sessions" next to the failure reads as "the list is empty",
    // which is a different fact from "we could not load the list".
    expect(screen.queryByText('No sessions')).not.toBeInTheDocument()
  })

  it('says there are no sessions once the list loads empty', () => {
    useSessionStore.setState({ sessions: [], isLoading: false, error: null })

    render(<Sidebar />)

    expect(screen.getByText('No sessions')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('keeps the initial loading state during an empty first build', () => {
    useSessionStore.setState({
      sessions: [],
      isLoading: true,
      indexStatus: {
        mode: 'on',
        state: 'building',
        discovered: 10,
        indexed: 0,
        degradedSources: 0,
        databaseBytes: 4096,
        walBytes: 0,
        lastUpdatedAt: '2026-07-15T00:00:00.000Z',
        lastErrorCode: null,
      },
    })

    render(<Sidebar />)

    expect(screen.getByText('Loading...')).toBeInTheDocument()
    expect(screen.queryByText('No sessions')).not.toBeInTheDocument()
    expect(screen.queryByTestId('sidebar-index-progress')).not.toBeInTheDocument()
  })

  it('keeps row, scroll container, active state, and selection stable across progress ticks', () => {
    const session = makeSession('stable-row', 'Stable row', '/workspace/alpha', '2026-07-15T00:00:00.000Z')
    useSessionStore.setState({
      sessions: [session],
      isBatchMode: true,
      selectedSessionIds: new Set([session.id]),
      indexStatus: {
        mode: 'on',
        state: 'building',
        discovered: 10,
        indexed: 2,
        degradedSources: 0,
        databaseBytes: 4096,
        walBytes: 0,
        lastUpdatedAt: '2026-07-15T00:00:00.000Z',
        lastErrorCode: null,
      },
    })
    useTabStore.setState({
      tabs: [{ sessionId: session.id, title: session.title, type: 'session', status: 'idle' }],
      activeTabId: session.id,
    })
    render(<Sidebar />)

    const row = screen.getByRole('button', { name: /Stable row/ })
    const scrollArea = screen.getByTestId('sidebar-session-scroll-area')
    scrollArea.scrollTop = 37

    act(() => {
      useSessionStore.setState((current) => ({
        indexStatus: current.indexStatus && { ...current.indexStatus, indexed: 3 },
      }))
    })

    expect(screen.getByRole('button', { name: /Stable row/ })).toBe(row)
    expect(screen.getByTestId('sidebar-session-scroll-area')).toBe(scrollArea)
    expect(scrollArea.scrollTop).toBe(37)
    expect(row).toHaveClass('sidebar-session-row--selected')
    expect(useTabStore.getState().activeTabId).toBe(session.id)
  })

  it('keeps the first visible session anchored when building inserts a newer row above it', () => {
    const anchored = makeSession('anchored-row', 'Anchored row', '/workspace/alpha', '2026-07-15T00:00:01.000Z')
    const older = makeSession('older-row', 'Older row', '/workspace/alpha', '2026-07-15T00:00:00.000Z')
    useSessionStore.setState({
      sessions: [anchored, older],
      indexStatus: {
        mode: 'on',
        state: 'building',
        discovered: 10,
        indexed: 2,
        degradedSources: 0,
        databaseBytes: 4096,
        walBytes: 0,
        lastUpdatedAt: '2026-07-15T00:00:00.000Z',
        lastErrorCode: null,
      },
    })

    const rectSpy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const isScrollArea = this.dataset.testid === 'sidebar-session-scroll-area'
      const insertedRowsMounted = ['Inserted row', 'Top row', 'Ready row']
        .filter((title) => document.querySelector(`[title="${title}"]`))
        .length
      const top = isScrollArea
        ? 0
        : this.getAttribute('data-sidebar-session-id') === anchored.id
          ? 20 + insertedRowsMounted * 30
          : this.getAttribute('data-sidebar-session-id') === older.id
            ? 50 + insertedRowsMounted * 30
            : 20
      const height = isScrollArea ? 200 : 30
      return {
        x: 0,
        y: top,
        top,
        right: 300,
        bottom: top + height,
        left: 0,
        width: 300,
        height,
        toJSON: () => ({}),
      }
    })

    try {
      render(<Sidebar />)
      const scrollArea = screen.getByTestId('sidebar-session-scroll-area')
      scrollArea.scrollTop = 40

      act(() => {
        useSessionStore.setState({
          sessions: [
            makeSession('inserted-row', 'Inserted row', '/workspace/alpha', '2026-07-15T00:00:02.000Z'),
            anchored,
            older,
          ],
          indexStatus: {
            ...useSessionStore.getState().indexStatus!,
            indexed: 3,
            lastUpdatedAt: '2026-07-15T00:00:01.000Z',
          },
        })
      })

      expect(screen.getByRole('button', { name: /Anchored row/ })).toBeInTheDocument()
      expect(scrollArea.scrollTop).toBe(70)

      scrollArea.scrollTop = 0
      act(() => {
        useSessionStore.setState({
          sessions: [
            makeSession('top-row', 'Top row', '/workspace/alpha', '2026-07-15T00:00:03.000Z'),
            ...useSessionStore.getState().sessions,
          ],
          indexStatus: {
            ...useSessionStore.getState().indexStatus!,
            indexed: 4,
            lastUpdatedAt: '2026-07-15T00:00:02.000Z',
          },
        })
      })
      expect(scrollArea.scrollTop).toBe(0)

      scrollArea.scrollTop = 40
      act(() => {
        useSessionStore.setState({
          sessions: [
            makeSession('ready-row', 'Ready row', '/workspace/alpha', '2026-07-15T00:00:04.000Z'),
            ...useSessionStore.getState().sessions,
          ],
          indexStatus: {
            ...useSessionStore.getState().indexStatus!,
            state: 'ready',
            indexed: 10,
            lastUpdatedAt: '2026-07-15T00:00:03.000Z',
          },
        })
      })
      expect(scrollArea.scrollTop).toBe(40)
    } finally {
      rectSpy.mockRestore()
    }
  })

  // The live region exists for the one transition a user can perceive: history
  // is being served the slow way. Building/ready/off are silent there too, so a
  // screen reader is not told about work that needs no reaction.
  it.each(['building', 'ready', 'off'] as const)('stays silent in the live region while %s', (state) => {
    useSessionStore.setState({
      sessions: [makeSession('live-row', 'Live row', '/workspace/alpha', '2026-07-15T00:00:00.000Z')],
      indexStatus: {
        mode: state === 'off' ? 'off' : 'on',
        state,
        discovered: 10,
        indexed: state === 'building' ? 2 : 10,
        degradedSources: 0,
        databaseBytes: 4096,
        walBytes: 0,
        lastUpdatedAt: '2026-07-15T00:00:00.000Z',
        lastErrorCode: null,
      },
    })

    render(<Sidebar />)

    expect(screen.getByRole('status')).toBeEmptyDOMElement()
  })

  it('announces the degraded fallback in the live region', () => {
    useSessionStore.setState({
      sessions: [makeSession('live-row', 'Live row', '/workspace/alpha', '2026-07-15T00:00:00.000Z')],
      indexStatus: {
        mode: 'on',
        state: 'degraded',
        discovered: 10,
        indexed: 2,
        degradedSources: 1,
        databaseBytes: 4096,
        walBytes: 0,
        lastUpdatedAt: '2026-07-15T00:00:00.000Z',
        lastErrorCode: 'source_unreadable',
      },
    })

    render(<Sidebar />)

    const liveRegion = screen.getByRole('status')
    expect(liveRegion).toHaveTextContent('Using standard history loading')
    expect(liveRegion).not.toHaveTextContent('2/10')
    expect(screen.getByTestId('sidebar-index-degraded')).toHaveAttribute('aria-hidden', 'true')
  })

  it('refreshes sessions manually and through low-frequency visible polling', async () => {
    vi.useFakeTimers()

    render(<Sidebar />)
    await act(async () => {
      await Promise.resolve()
    })

    expect(fetchSessions).toHaveBeenCalledTimes(1)

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Refresh sessions' }))
      await Promise.resolve()
    })
    expect(fetchSessions).toHaveBeenCalledTimes(2)

    await act(async () => {
      window.dispatchEvent(new Event('focus'))
      await Promise.resolve()
    })
    expect(fetchSessions).toHaveBeenCalledTimes(2)

    await act(async () => {
      vi.advanceTimersByTime(30_000)
      await Promise.resolve()
    })
    expect(fetchSessions).toHaveBeenCalledTimes(3)
  })

  it('does not overlap automatic session refreshes when the previous request is still pending', async () => {
    vi.useFakeTimers()
    fetchSessions.mockReturnValue(new Promise(() => {}))

    render(<Sidebar />)
    await act(async () => {
      await Promise.resolve()
    })
    expect(fetchSessions).toHaveBeenCalledTimes(1)

    await act(async () => {
      vi.advanceTimersByTime(90_000)
      await Promise.resolve()
    })

    expect(fetchSessions).toHaveBeenCalledTimes(1)
  })

  it('does not poll for session changes while the document is hidden', async () => {
    vi.useFakeTimers()
    const originalVisibility = document.visibilityState
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'hidden',
    })

    render(<Sidebar />)
    await act(async () => {
      await Promise.resolve()
    })
    expect(fetchSessions).toHaveBeenCalledTimes(1)

    await act(async () => {
      vi.advanceTimersByTime(30_000)
      await Promise.resolve()
    })
    expect(fetchSessions).toHaveBeenCalledTimes(1)

    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'visible',
    })
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'))
      await Promise.resolve()
    })
    expect(fetchSessions).toHaveBeenCalledTimes(2)

    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: originalVisibility,
    })
  })

  // The whole drawer is touch-only: it has no hover, and nothing can be focused
  // through `pointer-events: none`. Every control gated on `group-hover` was
  // therefore either dead or an invisible tap target, and the 53 tests above
  // never saw it because they all render the desktop sidebar.
  describe('touch drawer controls', () => {
    const renderWithProject = (isMobile: boolean) => {
      useSessionStore.setState({
        sessions: [makeSession('alpha-1', 'Alpha newest', '/workspace/alpha', new Date('2026-05-15T10:00:00.000Z').toISOString())],
      })
      return render(<Sidebar isMobile={isMobile} />)
    }

    it('keeps the project row actions hover-gated on desktop', () => {
      renderWithProject(false)

      const actions = screen.getByRole('button', { name: 'Project actions for alpha' })
      expect(actions).toHaveClass('h-7', 'w-7')
      expect(actions.parentElement).toHaveClass('pointer-events-none', 'opacity-0')
    })

    it('leaves the project row actions tappable at 44px in the drawer', () => {
      renderWithProject(true)

      const actions = screen.getByRole('button', { name: 'Project actions for alpha' })
      const create = screen.getByRole('button', { name: 'New session in alpha' })
      expect(actions).toHaveClass('h-11', 'w-11')
      expect(create).toHaveClass('h-11', 'w-11')
      // Both live in one row, so they need a gap wide enough not to catch a
      // thumb aimed at the other.
      expect(actions.parentElement).toHaveClass('opacity-100', 'gap-1.5')
      expect(actions.parentElement).not.toHaveClass('pointer-events-none')
    })

    it('stops rendering the projects header actions as an invisible tap target', () => {
      renderWithProject(true)

      // These kept `pointer-events` while sitting at `opacity: 0` — visually
      // absent on a phone, yet still firing on tap.
      const menu = screen.getByRole('button', { name: 'Project menu' })
      expect(menu).toHaveClass('h-11', 'w-11')
      expect(menu.parentElement).toHaveClass('opacity-100')
      expect(menu.parentElement).not.toHaveClass('opacity-0')
    })

    it('raises the search row and overflow toggle to the touch minimum', () => {
      renderWithProject(true)

      expect(screen.getByRole('button', { name: 'Refresh sessions' })).toHaveClass('h-11', 'w-11')
      expect(screen.getByRole('button', { name: 'Batch manage' })).toHaveClass('h-11', 'w-11')
      // Same flex row as the two above; at h-9 it left the row ragged.
      expect(screen.getAllByRole('button', { name: 'Search chats' })[0]).toHaveClass('h-11')
    })
  })
})
