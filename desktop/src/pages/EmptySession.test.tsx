import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom'
import { rawRecordDiagnosticEvent } from '../api/client'

const originalRangeGetClientRects = Object.getOwnPropertyDescriptor(Range.prototype, 'getClientRects')
const originalRangeGetBoundingClientRect = Object.getOwnPropertyDescriptor(Range.prototype, 'getBoundingClientRect')

const mocks = vi.hoisted(() => ({
  createSession: vi.fn(),
  listSessions: vi.fn(),
  getRepositoryContext: vi.fn(),
  getMessages: vi.fn(),
  getSlashCommands: vi.fn(),
  listSkills: vi.fn(),
  listAgents: vi.fn(),
  listReferences: vi.fn(),
  search: vi.fn(),
  browse: vi.fn(),
  getTasksForList: vi.fn(),
  resetTaskList: vi.fn(),
  getProviderAuthStatus: vi.fn(),
  wsClearHandlers: vi.fn(),
  wsConnect: vi.fn(),
  wsOnMessage: vi.fn(),
  wsSend: vi.fn(),
  wsDisconnect: vi.fn(),
  dialogOpen: vi.fn(),
  webviewDragHandlers: [] as Array<(event: { payload: unknown }) => void>,
  webviewUnlisten: vi.fn(),
  isMobile: false,
  isTauriRuntime: false,
  voiceSupported: vi.fn(() => false),
  voiceStartRecording: vi.fn(),
  voiceTranscribe: vi.fn(),
  voiceCatalog: vi.fn(async () => ({
    supported: false,
    providers: [],
    preferences: { enabled: false, providerId: 'sensevoice-local', language: 'auto', downloadSource: 'auto' },
    limits: { maxAudioSeconds: 60, maxAudioBytes: 1_000_000 },
  })),
}))

vi.mock('../api/client', async (importOriginal) => ({
  ...await importOriginal<typeof import('../api/client')>(),
  rawRecordDiagnosticEvent: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../api/sessions', () => ({
  sessionsApi: {
    create: mocks.createSession,
    list: mocks.listSessions,
    getRepositoryContext: mocks.getRepositoryContext,
    getMessages: mocks.getMessages,
    getSlashCommands: mocks.getSlashCommands,
  },
}))

vi.mock('@/api/voice', () => ({
  voiceApi: {
    catalog: mocks.voiceCatalog,
    transcribe: mocks.voiceTranscribe,
    providerStatus: vi.fn(),
    updatePreferences: vi.fn(),
    prepare: vi.fn(),
    cancelPrepare: vi.fn(),
    removeAssets: vi.fn(),
  },
}))

vi.mock('@/features/voiceInput/recorder', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/features/voiceInput/recorder')>()),
  isVoiceCaptureSupported: mocks.voiceSupported,
  startRecording: mocks.voiceStartRecording,
}))

vi.mock('../api/skills', () => ({
  skillsApi: {
    list: mocks.listSkills,
  },
}))

vi.mock('../api/composerReferences', async (importOriginal) => ({
  ...await importOriginal<typeof import('../api/composerReferences')>(),
  composerReferencesApi: { list: mocks.listReferences },
}))

vi.mock('../api/agents', () => ({
  agentsApi: {
    list: mocks.listAgents,
  },
}))

vi.mock('../api/providers', () => ({
  providersApi: {
    authStatus: mocks.getProviderAuthStatus,
  },
}))

vi.mock('../api/filesystem', () => ({
  filesystemApi: {
    search: mocks.search,
    browse: mocks.browse,
  },
}))

vi.mock('../api/cliTasks', () => ({
  cliTasksApi: {
    getTasksForList: mocks.getTasksForList,
    resetTaskList: mocks.resetTaskList,
  },
}))

vi.mock('../api/websocket', () => ({
  wsManager: {
    clearHandlers: mocks.wsClearHandlers,
    connect: mocks.wsConnect,
    onConnectionState: vi.fn((_sessionId: string, handler: (state: string) => void) => {
      handler('connecting')
      return () => {}
    }),
    onMessage: mocks.wsOnMessage,
    send: mocks.wsSend,
    disconnect: mocks.wsDisconnect,
  },
}))

vi.mock('../hooks/useMobileViewport', () => ({
  useMobileViewport: () => mocks.isMobile,
}))

vi.mock('../lib/desktopRuntime', () => ({
  isTauriRuntime: () => mocks.isTauriRuntime,
  isDesktopRuntime: () => mocks.isTauriRuntime,
}))

vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: mocks.dialogOpen,
}))

vi.mock('@tauri-apps/api/webview', () => ({
  getCurrentWebview: () => ({
    onDragDropEvent: vi.fn(async (handler: (event: { payload: unknown }) => void) => {
      mocks.webviewDragHandlers.push(handler)
      return mocks.webviewUnlisten
    }),
  }),
}))

vi.mock('@/components/composite/DirectoryPicker', () => ({
  RecentProjectsPanel: ({ value, onSelect }: { value: string; onSelect: (path: string) => void }) => (
    <button type="button" aria-label="Pick project" data-value={value} onClick={() => onSelect('/workspace/project')}>
      Pick project
    </button>
  ),
}))

// The launch controls' project editor is out of scope here; its folder field
// would pull the mocked picker module back in.
vi.mock('@/components/layout/ProjectEditorModal', () => ({
  ProjectEditorModal: () => null,
}))

vi.mock('../components/controls/PermissionModeSelector', () => ({
  PermissionModeSelector: ({ compact, value, onChange, menuAlign }: { compact?: boolean; value?: string; onChange?: (mode: string) => void; menuAlign?: string }) => (
    <button
      type="button"
      data-testid="permission-mode-selector"
      data-compact={compact ? 'true' : 'false'}
      data-menu-align={menuAlign}
      aria-label={`Permission mode: ${value ?? 'default'}`}
      onClick={() => onChange?.('auto')}
    >
      {value ?? 'default'}
    </button>
  ),
}))

vi.mock('../components/controls/ModelSelector', async () => {
  const React = await vi.importActual<typeof import('react')>('react')
  return {
    ModelSelector: React.forwardRef<{ open: () => void }, { compact?: boolean; fluid?: boolean }>(({ compact, fluid }, ref) => {
      const [open, setOpen] = React.useState(false)
      React.useImperativeHandle(ref, () => ({ open: () => setOpen(true) }), [])
      return (
        <>
          <button type="button" data-testid="model-selector" data-compact={compact ? 'true' : 'false'} data-fluid={fluid ? 'true' : 'false'}>
            Model
          </button>
          {open && <div data-testid="model-selector-dropdown">Model selector opened</div>}
        </>
      )
    }),
  }
})

import { EmptySession } from './EmptySession'
import { ApiError } from '../api/client'
import { useChatStore } from '../stores/chatStore'
import { useProviderStore } from '../stores/providerStore'
import { useSessionRuntimeStore } from '../stores/sessionRuntimeStore'
import { useSessionStore } from '../stores/sessionStore'
import { useSettingsStore } from '../stores/settingsStore'
import { useTabStore } from '../stores/tabStore'
import { useUIStore } from '../stores/uiStore'
import { useWorkspaceStore } from '../stores/workspaceStore'
import { usePluginStore } from '../stores/pluginStore'
import { useWorkflowStore } from '../stores/workflowStore'
import type { RepositoryContextResult } from '../api/sessions'
import { browserHost } from '../lib/desktopHost/browserHost'
import { AGENT_TEAMS_NOTICE_STORAGE_KEY } from '../lib/agentTeamsNotice'
import { getComposerElement, getComposerText, getComposerView, setComposerSelection, setComposerText } from '../components/chat/composerTestUtils'
import { useVoiceInputStore } from '../stores/voiceInputStore'

function okRepositoryContext(overrides: Partial<RepositoryContextResult> = {}): RepositoryContextResult {
  return {
    state: 'ok',
    workDir: '/workspace/project',
    repoRoot: '/workspace/project',
    repoName: 'project',
    currentBranch: 'main',
    defaultBranch: 'main',
    dirty: false,
    branches: [{
      name: 'main',
      current: true,
      local: true,
      remote: false,
      checkedOut: true,
      worktreePath: '/workspace/project',
    }],
    worktrees: [{
      path: '/workspace/project',
      branch: 'main',
      current: true,
    }],
    ...overrides,
  }
}

function notGitRepositoryContext(): RepositoryContextResult {
  return {
    state: 'not_git_repo',
    workDir: '/workspace/project',
    repoRoot: null,
    repoName: null,
    currentBranch: null,
    defaultBranch: null,
    dirty: false,
    branches: [],
    worktrees: [],
  }
}

/** Opens the run-location pill's menu. */
async function openLaunchMenu() {
  fireEvent.click(await screen.findByRole('button', { name: /^Location/ }))
}

/**
 * Picks the mocked project. The directory list is no longer a standing button
 * on a bar under the composer — it is a view of the run-location pill's menu,
 * which a fresh session opens directly onto.
 */
async function pickProject() {
  await openLaunchMenu()
  fireEvent.click(await screen.findByRole('button', { name: 'Pick project' }))
  // Picking a repo holds the menu open on the root view, where the branch and
  // worktree rows have just appeared. Close it so callers start from a clean
  // slate and open it themselves when they mean to.
  fireEvent.keyDown(document, { key: 'Escape' })
  await waitFor(() => {
    expect(screen.queryByRole('menu', { name: 'Location' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Pick project' })).not.toBeInTheDocument()
  })
}

// The Agent mode is a row of the "+" menu: open it, pick the segment, close it.
function chooseMode(mode: 'Standard' | 'Lean') {
  fireEvent.click(screen.getByRole('button', { name: 'Open composer tools' }))
  fireEvent.click(screen.getByRole('radio', { name: mode }))
  fireEvent.click(screen.getByRole('button', { name: 'Open composer tools' }))
}

describe('EmptySession', () => {
  const initialSessionState = useSessionStore.getInitialState()
  const initialChatState = useChatStore.getInitialState()
  const initialTabState = useTabStore.getInitialState()
  const initialWorkspaceState = useWorkspaceStore.getInitialState()
  const initialRuntimeState = useSessionRuntimeStore.getInitialState()
  const initialUiState = useUIStore.getInitialState()
  const initialPluginState = usePluginStore.getInitialState()
  const initialProviderState = useProviderStore.getInitialState()
  const initialWorkflowState = useWorkflowStore.getInitialState()

  beforeEach(() => {
    vi.clearAllMocks()
    // ProseMirror selection scrolling needs geometry APIs absent in jsdom.
    Object.defineProperties(Range.prototype, {
      getClientRects: { configurable: true, value: () => [] },
      getBoundingClientRect: { configurable: true, value: () => ({
        x: 0, y: 0, top: 0, right: 0, bottom: 0, left: 0, width: 0, height: 0,
        toJSON: () => ({}),
      }) },
    })
    mocks.webviewDragHandlers.length = 0
    mocks.isMobile = false
    mocks.isTauriRuntime = false
    mocks.voiceSupported.mockReturnValue(false)
    useVoiceInputStore.setState({ catalog: null, loading: false, error: null })
    useSettingsStore.setState({ locale: 'en', activeProviderName: null, permissionMode: 'default', leanModeEnabled: false })
    useSessionStore.setState(initialSessionState, true)
    useChatStore.setState(initialChatState, true)
    useTabStore.setState(initialTabState, true)
    useWorkspaceStore.setState(initialWorkspaceState, true)
    useSessionRuntimeStore.setState(initialRuntimeState, true)
    useUIStore.setState(initialUiState, true)
    usePluginStore.setState(initialPluginState, true)
    useProviderStore.setState(initialProviderState, true)
    useWorkflowStore.setState(initialWorkflowState, true)

    mocks.createSession.mockResolvedValue({ sessionId: 'draft-session' })
    mocks.getRepositoryContext.mockResolvedValue(okRepositoryContext())
    mocks.listSessions.mockResolvedValue({
      sessions: [{
        id: 'draft-session',
        title: 'New Session',
        createdAt: '2026-05-01T00:00:00.000Z',
        modifiedAt: '2026-05-01T00:00:00.000Z',
        messageCount: 0,
        projectPath: '/workspace/project',
        workDir: '/workspace/project',
        workDirExists: true,
      }],
      total: 1,
    })
    mocks.getMessages.mockResolvedValue({ messages: [] })
    mocks.getSlashCommands.mockResolvedValue({ commands: [] })
    mocks.listSkills.mockResolvedValue({ skills: [] })
    mocks.listAgents.mockResolvedValue({ activeAgents: [], allAgents: [] })
    mocks.listReferences.mockResolvedValue({ plugins: [], skills: [] })
    mocks.search.mockResolvedValue({
      currentPath: '/workspace/project',
      parentPath: null,
      query: '',
      entries: [],
    })
    mocks.browse.mockResolvedValue({ currentPath: '/workspace/project', parentPath: null, entries: [] })
    mocks.getTasksForList.mockResolvedValue({ tasks: [] })
    mocks.resetTaskList.mockResolvedValue(undefined)
    mocks.getProviderAuthStatus.mockResolvedValue({
      hasAuth: true,
      source: 'cc-haha-provider',
    })
  })

  afterEach(() => {
    cleanup()
    for (const [name, descriptor] of [
      ['getClientRects', originalRangeGetClientRects],
      ['getBoundingClientRect', originalRangeGetBoundingClientRect],
    ] as const) {
      if (descriptor) Object.defineProperty(Range.prototype, name, descriptor)
      else Reflect.deleteProperty(Range.prototype, name)
    }
    Reflect.deleteProperty(window, 'desktopHost')
    useSessionStore.setState(initialSessionState, true)
    useChatStore.setState(initialChatState, true)
    useTabStore.setState(initialTabState, true)
    useWorkspaceStore.setState(initialWorkspaceState, true)
    useSessionRuntimeStore.setState(initialRuntimeState, true)
    useUIStore.setState(initialUiState, true)
    usePluginStore.setState(initialPluginState, true)
    useProviderStore.setState(initialProviderState, true)
    useWorkflowStore.setState(initialWorkflowState, true)
  })

  it('drops a starter into the draft and keeps what was already typed', async () => {
    render(<EmptySession />)

    const starters = screen.getByRole('group', { name: 'Suggestions' })
    fireEvent.click(within(starters).getByRole('button', { name: 'Fix the failing tests' }))
    await waitFor(() => expect(getComposerText()).toBe('Fix the failing tests'))

    // A second pick appends on a new line rather than replacing the draft.
    fireEvent.click(within(starters).getByRole('button', { name: 'Build a new feature' }))
    await waitFor(() => expect(getComposerText()).toBe('Fix the failing tests\nBuild a new feature'))
  })

  it('keeps the starter row off the phone layout, where the composer docks to the bottom', () => {
    mocks.isMobile = true

    render(<EmptySession />)

    expect(screen.queryByTestId('new-session-starter')).not.toBeInTheDocument()
    expect(screen.getByTestId('empty-session-composer-shell')).toHaveClass('absolute', 'bottom-0')
  })

  it('puts the project above the hero on a phone, where the keyboard cannot cover it', async () => {
    mocks.isMobile = true

    render(<EmptySession />)

    const launch = screen.getByTestId('empty-session-mobile-launch')
    const pill = await within(launch).findByRole('button', { name: /^Location:/ })
    expect(pill).toHaveClass('h-10')
    // Read before the hero and outside the docked composer.
    expect(launch.compareDocumentPosition(screen.getByRole('heading', { level: 1 })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(screen.getByTestId('empty-session-composer-shell')).not.toContainElement(pill)
    expect(screen.getAllByRole('button', { name: /^Location:/ })).toHaveLength(1)
  })

  it('starts in the folder it is given, holding Run until that repository is read', async () => {
    mocks.isMobile = true
    // Its own id: the session store keeps per-id bookkeeping across tests.
    mocks.createSession.mockResolvedValue({ sessionId: 'phone-session' })
    let resolveContext: (context: RepositoryContextResult) => void = () => {}
    mocks.getRepositoryContext.mockReturnValue(new Promise<RepositoryContextResult>((resolve) => {
      resolveContext = resolve
    }))

    render(<EmptySession initialWorkDir="/workspace/project" />)
    setComposerText('draft question', 14)

    const runButton = screen.getByRole('button', { name: /Run/i })
    expect(mocks.getRepositoryContext).toHaveBeenCalledWith('/workspace/project')
    expect(runButton).toBeDisabled()

    await act(async () => { resolveContext(okRepositoryContext()) })
    expect(await screen.findByRole('button', { name: 'Location: project / main' })).toBeInTheDocument()
    await waitFor(() => expect(runButton).not.toBeDisabled())

    fireEvent.click(runButton)

    await waitFor(() => {
      expect(mocks.createSession).toHaveBeenCalledWith({
        workDir: '/workspace/project',
        repository: { branch: 'main', worktree: false },
        permissionMode: 'default',
      })
    })
    await waitFor(() => {
      expect(mocks.wsSend).toHaveBeenCalledWith('phone-session', expect.objectContaining({ content: 'draft question' }))
    })
  })

  it('uses compact composer controls on phone-sized H5 browsers', async () => {
    mocks.isMobile = true

    render(<EmptySession />)

    await waitFor(() => {
      expect(screen.getByTestId('permission-mode-selector')).toHaveAttribute('data-compact', 'true')
    })
    expect(screen.getByTestId('model-selector')).toHaveAttribute('data-compact', 'true')
    expect(screen.getByRole('button', { name: 'Run' })).toHaveClass('h-11', 'w-11')
    expect(screen.getByTestId('empty-session-composer-shell')).toHaveClass('px-3')
    expect(screen.getByTestId('empty-session-composer-panel')).toHaveClass('rounded-[var(--radius-xl)]')
  })

  it.each(['@', '/', '/empty', '+'] as const)('hides withdrawn bundled capabilities in %s while keeping personal skills and other plugins', async (entry) => {
    const withdrawnPackage = 'office-frontend-design@haha-connectors'
    mocks.listReferences.mockResolvedValue({
      plugins: [
        { kind: 'plugin', id: withdrawnPackage, name: 'office-frontend-design', displayName: 'Removed frontend plugin', description: 'Design', source: withdrawnPackage, modelText: 'Use removed plugin' },
        { kind: 'plugin', id: 'design-tools@community', name: 'design-tools', displayName: 'Design tools', description: 'Design', source: 'community', modelText: 'Use design tools' },
      ],
      skills: [
        { kind: 'skill', id: 'office-frontend-design:frontend-design', name: 'frontend-design', displayName: 'Removed frontend skill', description: 'Design', source: withdrawnPackage, modelText: '/office-frontend-design:frontend-design' },
        { kind: 'skill', id: 'frontend-design', name: 'frontend-design', displayName: 'Personal frontend design', description: 'Design', source: 'user', modelText: '/frontend-design' },
      ],
    })
    const legacyCommands = [
      { name: 'office-frontend-design:frontend-design', description: 'Removed frontend skill', kind: 'skill' as const, source: 'plugin' as const, userInvocable: true },
      { name: 'frontend-design', description: 'Personal frontend design', kind: 'skill' as const, source: 'user' as const, userInvocable: true },
    ]
    mocks.listSkills.mockResolvedValue({ skills: legacyCommands })
    render(<EmptySession />)
    if (entry === '+') {
      fireEvent.click(screen.getByRole('button', { name: 'Open composer tools' }))
      fireEvent.change(screen.getByRole('combobox', { name: 'Search skills, connectors, files…' }), { target: { value: 'design' } })
    } else if (entry === '/empty') setComposerText('/', 1)
    else setComposerText(`${entry}design`, 7)
    expect(await screen.findByRole('option', { name: 'Personal frontend design' })).toBeInTheDocument()
    expect(await screen.findByRole('option', { name: 'Design tools' })).toBeInTheDocument()
    expect(screen.queryByRole('option', { name: /Removed frontend/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('option', { name: /office-frontend-design/ })).not.toBeInTheDocument()
    expect(mocks.wsSend).not.toHaveBeenCalled()
    if (entry === '/empty') {
      const options = screen.getAllByRole('option')
      const skillIndex = options.indexOf(screen.getByRole('option', { name: 'Personal frontend design' }))
      const pluginIndex = options.indexOf(screen.getByRole('option', { name: 'Design tools' }))
      expect(skillIndex).toBeGreaterThan(options.indexOf(screen.getByRole('option', { name: '/model' })))
      expect(pluginIndex).toBeGreaterThan(skillIndex)
      for (let index = 0; index < pluginIndex; index++) fireEvent.keyDown(getComposerElement(), { key: 'ArrowDown' })
      expect(screen.getByRole('option', { name: 'Design tools' })).toHaveAttribute('aria-selected', 'true')
      fireEvent.keyDown(getComposerElement(), { key: 'Enter' })
      expect(document.querySelector('.composer-mention')).toHaveTextContent('Design tools')
      expect(mocks.wsSend).not.toHaveBeenCalled()
    }
  })

  it.each(['empty', 'replacement'] as const)('refreshes skills when opening plus and drops stale entries during a pending %s response', async (result) => {
    const oldSkill = { kind: 'skill' as const, id: 'old-skill', name: 'old-skill', displayName: 'Old skill', description: 'Previously enabled', source: 'user', modelText: '/old-skill' }
    const newSkill = { ...oldSkill, id: 'new-skill', name: 'new-skill', displayName: 'New skill', modelText: '/new-skill' }
    mocks.listReferences.mockResolvedValue({ plugins: [], skills: [oldSkill] })
    render(<EmptySession />)
    await act(async () => { await Promise.resolve() })
    const initialCalls = mocks.listReferences.mock.calls.length
    let resolveRefresh!: (value: { plugins: [], skills: typeof oldSkill[] }) => void
    mocks.listReferences.mockImplementation(() => new Promise(resolve => { resolveRefresh = resolve }))

    fireEvent.click(screen.getByRole('button', { name: 'Open composer tools' }))
    await waitFor(() => expect(mocks.listReferences.mock.calls.length).toBeGreaterThan(initialCalls))
    fireEvent.click(await screen.findByRole('option', { name: /^Skills/ }))
    fireEvent.click(await screen.findByRole('option', { name: /^All skills/ }))
    expect(screen.queryByRole('option', { name: 'Old skill' })).not.toBeInTheDocument()

    await act(async () => resolveRefresh({ plugins: [], skills: result === 'replacement' ? [newSkill] : [] }))
    expect(screen.queryByRole('option', { name: 'Old skill' })).not.toBeInTheDocument()
    if (result === 'replacement') expect(await screen.findByRole('option', { name: 'New skill' })).toBeInTheDocument()
    else expect(screen.queryByRole('option', { name: 'New skill' })).not.toBeInTheDocument()
  })

  it('inserts a structured project file mention selected through the plus menu search', async () => {
    mocks.search.mockResolvedValue({
      currentPath: '/workspace/project', parentPath: null, query: 'README',
      entries: [{ name: 'README.md', path: '/workspace/project/README.md', relativePath: 'README.md', isDirectory: false }],
    })
    render(<EmptySession />)
    await pickProject()
    setComposerText('Please review ', 14)
    fireEvent.click(screen.getByRole('button', { name: 'Open composer tools' }))
    fireEvent.change(screen.getByRole('combobox', { name: 'Search skills, connectors, files…' }), { target: { value: 'README' } })
    fireEvent.click(await screen.findByRole('option', { name: 'README.md' }))

    await waitFor(() => {
      expect(document.querySelector('.composer-mention')).toHaveAttribute('data-mention-path', '/workspace/project/README.md')
    })
    expect(document.querySelector('.composer-mention')).toHaveTextContent('@README.md')
    expect(getComposerText()).toContain('Please review @README.md')
    expect(mocks.search).toHaveBeenCalledWith('README', '/workspace/project', { signal: expect.any(AbortSignal) })
    expect(screen.queryByRole('combobox', { name: 'Search skills, connectors, files…' })).not.toBeInTheDocument()
    expect(mocks.wsSend).not.toHaveBeenCalled()
    expect(mocks.createSession).not.toHaveBeenCalled()
  })

  it('keeps user-only skills as slash text when no mention capability is available', async () => {
    mocks.listSkills.mockResolvedValue({ skills: [{ name: 'manual-only', description: 'User invocation only', userInvocable: true, disableModelInvocation: true }] })
    render(<EmptySession />)
    setComposerText('/manual', 7)
    fireEvent.click(await screen.findByText('manual-only'))
    await waitFor(() => expect(getComposerText()).toBe('/manual-only '))
    expect(document.querySelector('.composer-mention')).not.toBeInTheDocument()
    expect(mocks.createSession).not.toHaveBeenCalled()
  })

  it('hides previous directory skills while the new directory is loading', async () => {
    let resolveProject!: (result: { skills: { name: string, description: string, userInvocable: boolean }[] }) => void
    mocks.listSkills.mockImplementation((cwd?: string) => cwd
      ? new Promise(resolve => { resolveProject = resolve })
      : Promise.resolve({ skills: [{ name: 'old-directory-skill', description: 'Old scope', userInvocable: true }] }))
    render(<EmptySession />)
    setComposerText('/directory', 10)
    expect(await screen.findByText('old-directory-skill')).toBeInTheDocument()
    await pickProject()
    setComposerText('/directory', 10)
    expect(screen.queryByText('old-directory-skill')).not.toBeInTheDocument()
    await act(async () => resolveProject({ skills: [{ name: 'new-directory-skill', description: 'New scope', userInvocable: true }] }))
    expect(await screen.findByText('new-directory-skill')).toBeInTheDocument()
    expect(screen.queryByText('old-directory-skill')).not.toBeInTheDocument()
  })

  it('ignores late mention candidates from a previous directory', async () => {
    const staleResolvers: ((result: { plugins: unknown[], skills: unknown[] }) => void)[] = []
    const candidate = (id: string) => ({
      kind: 'plugin', id, name: id, displayName: id, description: 'Plugin',
      source: 'plugin', modelText: `Use ${id}`,
    })
    mocks.listReferences.mockImplementation((cwd?: string) => cwd
      ? Promise.resolve({ plugins: [candidate('current-plugin')], skills: [] })
      : new Promise(resolve => { staleResolvers.push(resolve) }))
    render(<EmptySession />)
    await waitFor(() => expect(staleResolvers.length).toBeGreaterThan(0))
    await pickProject()
    setComposerText('@', 1)
    expect(await screen.findByText('current-plugin')).toBeInTheDocument()
    await act(async () => {
      staleResolvers.forEach(resolve => resolve({ plugins: [candidate('stale-plugin')], skills: [] }))
    })
    expect(screen.queryByText('stale-plugin')).not.toBeInTheDocument()
    expect(screen.getByText('current-plugin')).toBeInTheDocument()
  })

  it('refreshes empty-session slash commands after plugin reloads', async () => {
    mocks.listSkills
      .mockResolvedValueOnce({ skills: [] })
      .mockResolvedValueOnce({
        skills: [
          {
            name: 'draw:render',
            description: 'Render with the drawing plugin.',
            userInvocable: true,
          },
        ],
      })

    render(<EmptySession />)

    await waitFor(() => {
      expect(mocks.listSkills).toHaveBeenCalledTimes(1)
    })

    act(() => {
      usePluginStore.setState({
        lastReloadSummary: {
          enabled: 1,
          disabled: 0,
          skills: 1,
          agents: 0,
          hooks: 0,
          mcpServers: 0,
          lspServers: 0,
          errors: 0,
        },
      })
    })

    await waitFor(() => {
      expect(mocks.listSkills).toHaveBeenCalledTimes(2)
    })
  })

  it('finds /clear without recommending it in an empty session', async () => {
    render(<EmptySession />)

    setComposerText('/', 1)
    expect(await screen.findByRole('listbox', { name: 'Slash commands' })).toBeInTheDocument()
    expect(screen.queryByRole('option', { name: '/clear' })).not.toBeInTheDocument()

    setComposerText('/clear', 6)
    expect(await screen.findByRole('option', { name: '/clear' })).toBeInTheDocument()
    expect(screen.queryByRole('option', { name: '/goal' })).not.toBeInTheDocument()
  })

  it('prioritizes enabled plugin slash commands by command name when filtering', async () => {
    mocks.listSkills.mockResolvedValueOnce({
      skills: [
        {
          name: 'agent-team-orchestrator',
          description: 'Agent Teams can use Subagent orchestration.',
          userInvocable: true,
        },
        {
          name: 'lark-calendar',
          description: 'Includes suggestion helpers.',
          userInvocable: true,
        },
        {
          name: 'superpowers:brainstorming',
          description: 'Creative work planning.',
          userInvocable: true,
        },
      ],
    })

    render(<EmptySession />)

    await waitFor(() => {
      expect(mocks.listSkills).toHaveBeenCalledTimes(1)
    })

    setComposerText('/su', 3)

    await waitFor(() => {
      const commandOptions = screen.getAllByRole('option')
      expect(commandOptions[0]).toHaveTextContent('superpowers:brainstorming')
    })
  })

  it('uses the grouped accessible slash menu and preserves skill source labels', async () => {
    mocks.listSkills.mockResolvedValueOnce({
      skills: [
        {
          name: 'project-audit',
          description: 'Audit this project.',
          source: 'project',
          userInvocable: true,
        },
        {
          name: 'drawing:render',
          description: 'Render with the drawing plugin.',
          source: 'plugin',
          userInvocable: true,
        },
      ],
    })

    render(<EmptySession />)

    await waitFor(() => {
      expect(mocks.listSkills).toHaveBeenCalledTimes(1)
    })

    setComposerText('/a', 2)

    const listbox = await screen.findByRole('listbox', { name: 'Slash commands' })
    const combobox = screen.getByRole('combobox', { name: '' })
    const systemCommand = screen.getByText('/status')
    const skillsHeading = screen.getByText('Skills')
    const projectSkill = screen.getByText('project-audit')
    const pluginSkill = screen.getByText('drawing:render')

    expect(systemCommand.compareDocumentPosition(skillsHeading)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    )
    expect(skillsHeading.compareDocumentPosition(projectSkill)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    )
    expect(projectSkill.closest('[role="option"]')).toHaveTextContent('Project')
    expect(pluginSkill.closest('[role="option"]')).toHaveTextContent('Plugin')
    expect(combobox).toHaveAttribute('aria-controls', listbox.id)
    expect(combobox).toHaveAttribute(
      'aria-activedescendant',
      screen.getAllByRole('option')[0]!.id,
    )
  })

  it('offers active agents as slash entries that insert /agent with the selected type', async () => {
    mocks.listAgents.mockResolvedValue({
      activeAgents: [
        {
          agentType: 'debugger',
          description: 'Debug failures',
          modelDisplay: 'OPUS',
          source: 'userSettings',
          isActive: true,
        },
      ],
      allAgents: [],
    })

    render(<EmptySession />)

    await waitFor(() => {
      expect(mocks.listAgents).toHaveBeenCalledWith(undefined)
    })

    setComposerText('/debug', 6)

    const agentOption = await screen.findByText('/agent debugger')
    fireEvent.click(agentOption)

    expect(getComposerText()).toBe('/agent debugger ')
  })

  it('opens the draft model selector for /model without creating or sending a session', async () => {
    useSettingsStore.setState({
      chatSendBehavior: 'enter',
    })

    render(<EmptySession />)

    const input = getComposerElement()
    setComposerText('/model', 6)

    fireEvent.keyDown(input, { key: 'Enter' })

    expect(mocks.createSession).not.toHaveBeenCalled()
    expect(mocks.wsSend).not.toHaveBeenCalled()
    expect(await screen.findByTestId('model-selector-dropdown')).toHaveTextContent('Model selector opened')
    expect(getComposerText()).toBe('')
  })

  // Same guard as the ChatInput hero test: this flex row is what the new-tab
  // page renders, and an unbreakable run (long URL, hash) would otherwise
  // grow the composer past the panel border.
  it('keeps min-w-0 on the composer wrapper so unbreakable runs cannot widen it', () => {
    render(<EmptySession />)

    const wrapper = getComposerElement().parentElement
    expect(wrapper).toHaveClass('flex-1')
    expect(wrapper).toHaveClass('min-w-0')
  })

  it('shows /save-workflow help without creating or sending a session', async () => {
    useSettingsStore.setState({ chatSendBehavior: 'enter' })

    render(<EmptySession />)

    setComposerText('/save-workflow', '/save-workflow'.length)
    fireEvent.keyDown(getComposerElement(), { key: 'Enter' })

    expect(mocks.createSession).not.toHaveBeenCalled()
    expect(mocks.getProviderAuthStatus).not.toHaveBeenCalled()
    expect(mocks.wsSend).not.toHaveBeenCalled()
    expect(await screen.findByText('Save workflow')).toBeInTheDocument()
    expect(screen.getByText(/Complete a workflow in this session/)).toBeInTheDocument()
    expect(getComposerText()).toBe('')
  })

  it('selects a highlighted agent entry from /agent without creating a session', async () => {
    useSettingsStore.setState({
      chatSendBehavior: 'enter',
    })
    mocks.listAgents.mockResolvedValue({
      activeAgents: [
        {
          agentType: 'debugger',
          description: 'Debug failures',
          modelDisplay: 'OPUS',
          source: 'userSettings',
          isActive: true,
        },
      ],
      allAgents: [],
    })

    render(<EmptySession />)

    await waitFor(() => {
      expect(mocks.listAgents).toHaveBeenCalledWith(undefined)
    })

    const input = getComposerElement()
    setComposerText('/agent', 6)

    await screen.findByText('/agent debugger')
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(getComposerText()).toBe('/agent debugger ')
    expect(mocks.createSession).not.toHaveBeenCalled()
    expect(mocks.wsSend).not.toHaveBeenCalled()
  })

  // The launch controls used to be a bar welded under the composer, which is
  // what forced the panel's squared bottom edge and the third divider line.
  // They are one pill in the toolbar now, so the panel is fully rounded and
  // the row the pill sits in is the same one holding "+" and the model.
  it('puts the run-location pill in the composer toolbar, not on a bar of its own', async () => {
    render(<EmptySession />)

    const panel = screen.getByTestId('empty-session-composer-panel')
    // 16px corner and the composer shadow step — the same floating card as
    // ChatInput's. The repository controls live inside this panel, so it
    // must stay a single rounded block rather than a split top/bottom pair.
    expect(panel).toHaveClass('rounded-[var(--radius-xl)]', 'p-2', 'glass-panel--composer')
    expect(panel).not.toHaveClass('rounded-b-none')

    await pickProject()

    const pill = await screen.findByRole('button', { name: 'Location: project / main' })
    expect(panel).toContainElement(pill)
    expect(pill).toHaveClass('h-7')

    // Same toolbar row as Run — that row is the whole point of the change.
    const toolbarRow = pill.closest('.justify-between')
    expect(toolbarRow).toContainElement(screen.getByRole('button', { name: /Run/i }))
  })

  it('creates a session with the selected project and branch when submitted', async () => {
    render(<EmptySession />)

    setComposerText('draft question', 14)
    await pickProject()

    expect(mocks.createSession).not.toHaveBeenCalled()

    await waitFor(() => {
      expect(screen.getByText('main')).toBeInTheDocument()
    })

    const runButton = screen.getByRole('button', { name: /Run/i })
    await waitFor(() => {
      expect(runButton).not.toBeDisabled()
    })

    fireEvent.click(runButton)

    await waitFor(() => {
      expect(mocks.createSession).toHaveBeenCalledWith({
        workDir: '/workspace/project',
        repository: { branch: 'main', worktree: false },
        permissionMode: 'default',
      })
    })

    expect(useTabStore.getState().activeTabId).toBe('draft-session')
    expect(useTabStore.getState().tabs).toEqual([
      { sessionId: 'draft-session', title: 'draft question', type: 'session', status: 'idle' },
    ])
    expect(useSessionStore.getState().sessions[0]).toMatchObject({
      id: 'draft-session',
      workDir: '/workspace/project',
    })
    const messages = useChatStore.getState().sessions['draft-session']?.messages ?? []
    expect(messages[messages.length - 1]).toMatchObject({
      type: 'user_text',
      content: 'draft question',
    })
    expect(mocks.wsSend).toHaveBeenCalledWith('draft-session', {
      type: 'user_message',
      content: 'draft question',
      attachments: [],
    })
    expect(mocks.wsConnect).toHaveBeenCalledWith('draft-session')
    expect(useSessionRuntimeStore.getState().selections['draft-session']).toBeUndefined()
  })

  it('stores and replays a draft runtime only when the user explicitly selected one', async () => {
    useSessionRuntimeStore.getState().setSelection('__draft__', {
      providerId: 'provider-explicit',
      modelId: 'model-explicit',
    })

    render(<EmptySession />)

    setComposerText('draft question', 14)

    fireEvent.click(screen.getByRole('button', { name: /Run/i }))

    await waitFor(() => {
      expect(mocks.createSession).toHaveBeenCalledWith({ permissionMode: 'default' })
    })

    expect(useSessionRuntimeStore.getState().selections['draft-session']).toEqual({
      providerId: 'provider-explicit',
      modelId: 'model-explicit',
    })
    expect(useSessionRuntimeStore.getState().selections['__draft__']).toBeUndefined()
    expect(mocks.wsSend.mock.calls.slice(0, 2)).toEqual([
      [
        'draft-session',
        {
          type: 'set_runtime_config',
          providerId: 'provider-explicit',
          modelId: 'model-explicit',
        },
      ],
      ['draft-session', { type: 'prewarm_session' }],
    ])
  })

  it('creates a new session with the draft Auto permission mode', async () => {
    render(<EmptySession />)

    fireEvent.click(screen.getByRole('button', { name: 'Permission mode: default' }))
    setComposerText('run automatically', 17)
    fireEvent.click(screen.getByRole('button', { name: /Run/i }))

    await waitFor(() => {
      expect(mocks.createSession).toHaveBeenCalledWith({ permissionMode: 'auto' })
    })
  })

  // The draft now stays mounted while Settings is open. A mode copied once at
  // mount kept launching "skip permissions" after the user turned it off.
  it('follows the global permission default until this draft picks its own mode', async () => {
    mocks.createSession.mockResolvedValue({ sessionId: 'followed-mode-session' })
    useSettingsStore.setState({ permissionMode: 'bypassPermissions' })
    render(<EmptySession />)
    expect(screen.getByRole('button', { name: 'Permission mode: bypassPermissions' })).toBeInTheDocument()

    act(() => useSettingsStore.setState({ permissionMode: 'default' }))
    expect(screen.getByRole('button', { name: 'Permission mode: default' })).toBeInTheDocument()

    setComposerText('ask before acting', 17)
    fireEvent.click(screen.getByRole('button', { name: /Run/i }))
    await waitFor(() => {
      expect(mocks.createSession).toHaveBeenCalledWith({ permissionMode: 'default' })
    })
  })

  it('keeps a permission mode picked in this draft when the global default changes', async () => {
    mocks.createSession.mockResolvedValue({ sessionId: 'picked-mode-session' })
    render(<EmptySession />)
    // The mocked selector picks Auto.
    fireEvent.click(screen.getByRole('button', { name: 'Permission mode: default' }))
    act(() => useSettingsStore.setState({ permissionMode: 'bypassPermissions' }))
    expect(screen.getByRole('button', { name: 'Permission mode: auto' })).toBeInTheDocument()

    setComposerText('run automatically', 17)
    fireEvent.click(screen.getByRole('button', { name: /Run/i }))
    await waitFor(() => {
      expect(mocks.createSession).toHaveBeenCalledWith({ permissionMode: 'auto' })
    })
  })

  it('carries the global effort into the first draft selection for ChatGPT Official', async () => {
    useSettingsStore.setState({ effortLevel: 'low' })
    useProviderStore.setState({
      providers: [],
      activeId: 'openai-official',
      providerOrder: ['claude-official', 'openai-official', 'grok-official'],
      hasLoadedProviders: true,
    })

    render(<EmptySession />)

    setComposerText('draft question', 14)
    fireEvent.click(screen.getByRole('button', { name: /Run/i }))

    await waitFor(() => {
      expect(mocks.createSession).toHaveBeenCalledWith({ permissionMode: 'default' })
    })

    expect(useSessionRuntimeStore.getState().selections['draft-session']).toMatchObject({
      providerId: 'openai-official',
      effortLevel: 'low',
    })
  })

  it('carries the global effort and the bundled DeepSeek model into the first draft selection for the DeepSeek Account', async () => {
    const previous = useSettingsStore.getState()
    const restoreSettings = {
      effortLevel: previous.effortLevel,
      currentModel: previous.currentModel,
      activeProviderName: previous.activeProviderName,
    }
    useSettingsStore.setState({ effortLevel: 'high', currentModel: null, activeProviderName: 'DeepSeek Account' })
    useProviderStore.setState({
      providers: [],
      activeId: 'deepseek-account',
      providerOrder: ['claude-official', 'openai-official', 'grok-official', 'deepseek-account'],
      hasLoadedProviders: true,
    })

    render(<EmptySession />)

    setComposerText('draft question', 14)
    fireEvent.click(screen.getByRole('button', { name: /Run/i }))

    await waitFor(() => {
      expect(mocks.createSession).toHaveBeenCalledWith({ permissionMode: 'default' })
    })

    try {
      expect(useSessionRuntimeStore.getState().selections['draft-session']).toEqual({
        providerId: 'deepseek-account',
        modelId: 'deepseek-v4-pro[1m]',
        effortLevel: 'high',
      })
    } finally {
      useSettingsStore.setState(restoreSettings)
    }
  })

  it.each([true, false])('materializes raw provider models with 1M=%s before the first draft message', async (enabled) => {
    useProviderStore.setState({
      providers: [{
        id: 'provider-minimax',
        presetId: 'minimax',
        name: 'MiniMax',
        apiKey: 'sk-minimax',
        baseUrl: 'https://api.minimaxi.com/anthropic',
        apiFormat: 'anthropic',
        runtimeKind: 'anthropic_compatible',
        models: {
          main: 'MiniMax-M3',
          haiku: 'MiniMax-M3',
          sonnet: 'MiniMax-M3',
          opus: 'MiniMax-M3',
        },
        model1mSupport: { main: enabled, fable: enabled, haiku: enabled, sonnet: enabled, opus: enabled },
        toolSearchEnabled: true,
      }],
      activeId: 'provider-minimax',
      providerOrder: ['provider-minimax', 'claude-official', 'openai-official', 'grok-official'],
      hasLoadedProviders: true,
    })

    render(<EmptySession />)

    setComposerText('draft question', 14)

    fireEvent.click(screen.getByRole('button', { name: /Run/i }))

    await waitFor(() => {
      expect(mocks.createSession).toHaveBeenCalledWith({ permissionMode: 'default' })
    })

    expect(useSessionRuntimeStore.getState().selections['draft-session']).toEqual({
      providerId: 'provider-minimax',
      modelId: enabled ? 'MiniMax-M3[1m]' : 'MiniMax-M3',
      effortLevel: 'low',
    })
    expect(mocks.wsSend.mock.calls.slice(0, 3)).toEqual([
      [
        'draft-session',
        {
          type: 'set_runtime_config',
          providerId: 'provider-minimax',
          modelId: enabled ? 'MiniMax-M3[1m]' : 'MiniMax-M3',
          effortLevel: 'low',
        },
      ],
      ['draft-session', { type: 'prewarm_session' }],
      [
        'draft-session',
        {
          type: 'user_message',
          content: 'draft question',
          attachments: [],
        },
      ],
    ])
  })

  it('materializes the resolved Claude OAuth model before the first draft message', async () => {
    mocks.getProviderAuthStatus.mockResolvedValue({
      hasAuth: true,
      source: 'claude-oauth',
      activeProvider: 'Claude Official',
    })
    useSettingsStore.setState({
      currentModel: {
        id: 'claude-sonnet-5',
        name: 'Sonnet 5',
        description: 'Claude OAuth Pro default',
        context: '1m',
      },
      effortLevel: 'high',
      activeProviderName: null,
    })
    useProviderStore.setState({
      providers: [],
      activeId: null,
      providerOrder: ['claude-official', 'openai-official', 'grok-official'],
      hasLoadedProviders: true,
    })

    render(<EmptySession />)
    setComposerText('Claude OAuth question', 21)
    fireEvent.click(screen.getByRole('button', { name: /Run/i }))

    await waitFor(() => {
      expect(mocks.createSession).toHaveBeenCalledWith({ permissionMode: 'default' })
    })

    expect(useSessionRuntimeStore.getState().selections['draft-session']).toEqual({
      providerId: null,
      modelId: 'claude-sonnet-5',
      effortLevel: 'high',
    })
    expect(mocks.wsSend.mock.calls.slice(0, 3)).toEqual([
      [
        'draft-session',
        {
          type: 'set_runtime_config',
          providerId: null,
          modelId: 'claude-sonnet-5',
          effortLevel: 'high',
        },
      ],
      ['draft-session', { type: 'prewarm_session' }],
      [
        'draft-session',
        {
          type: 'user_message',
          content: 'Claude OAuth question',
          attachments: [],
        },
      ],
    ])
  })

  it('opens provider settings instead of creating a session when no model authentication exists', async () => {
    mocks.getProviderAuthStatus.mockResolvedValue({ hasAuth: false, source: 'none' })

    render(<EmptySession />)

    setComposerText('draft question', 14)
    fireEvent.click(screen.getByRole('button', { name: /Run/i }))

    await waitFor(() => {
      expect(mocks.getProviderAuthStatus).toHaveBeenCalledTimes(1)
    })
    expect(mocks.createSession).not.toHaveBeenCalled()
    expect(mocks.wsSend).not.toHaveBeenCalled()
    expect(useUIStore.getState().pendingSettingsTab).toBe('providers')
    expect(useTabStore.getState().activeTabId).toBe('__settings__')
  })

  // The gate used to ask only about the global default. A draft that picked a
  // saved DeepSeek model while the default Claude login had expired was sent to
  // Settings with no session and no word about why.
  it('checks the credentials of the model chosen in the draft, not the global default', async () => {
    mocks.createSession.mockResolvedValue({ sessionId: 'explicit-auth-session' })
    mocks.getProviderAuthStatus.mockImplementation(async (providerId?: string) => (
      providerId === 'provider-explicit'
        ? { hasAuth: true, source: 'cc-haha-provider' }
        : { hasAuth: false, source: 'none' }
    ))
    useSessionRuntimeStore.getState().setSelection('__draft__', {
      providerId: 'provider-explicit',
      modelId: 'model-explicit',
    })

    render(<EmptySession />)
    setComposerText('draft question', 14)
    fireEvent.click(screen.getByRole('button', { name: /Run/i }))

    await waitFor(() => {
      expect(mocks.createSession).toHaveBeenCalledWith({ permissionMode: 'default' })
    })
    expect(mocks.getProviderAuthStatus).toHaveBeenCalledTimes(1)
    expect(mocks.getProviderAuthStatus).toHaveBeenCalledWith('provider-explicit')
    expect(useSessionRuntimeStore.getState().selections['explicit-auth-session']).toEqual({
      providerId: 'provider-explicit',
      modelId: 'model-explicit',
    })
    expect(useTabStore.getState().activeTabId).toBe('explicit-auth-session')
    expect(useUIStore.getState().pendingSettingsTab).toBeNull()
  })

  it('asks about Claude Official by its id when the draft chose an official Claude model', async () => {
    mocks.createSession.mockResolvedValue({ sessionId: 'official-auth-session' })
    useSessionRuntimeStore.getState().setSelection('__draft__', {
      providerId: null,
      modelId: 'claude-sonnet-5',
    })

    render(<EmptySession />)
    setComposerText('draft question', 14)
    fireEvent.click(screen.getByRole('button', { name: /Run/i }))

    await waitFor(() => expect(mocks.createSession).toHaveBeenCalledTimes(1))
    expect(mocks.getProviderAuthStatus).toHaveBeenCalledTimes(1)
    expect(mocks.getProviderAuthStatus).toHaveBeenCalledWith('claude-official')
  })

  it('names the chosen model when it has no usable credentials and keeps the draft', async () => {
    mocks.getProviderAuthStatus.mockResolvedValue({ hasAuth: false, source: 'none' })
    useProviderStore.setState({
      providers: [{
        id: 'provider-explicit',
        presetId: 'deepseek',
        name: 'My DeepSeek',
        apiKey: 'sk-test',
        baseUrl: 'https://api.deepseek.test/anthropic',
        apiFormat: 'anthropic',
        models: { main: 'deepseek-flash', haiku: 'deepseek-flash', sonnet: 'deepseek-flash', opus: 'deepseek-flash' },
      }],
      activeId: null,
      hasLoadedProviders: true,
    })
    useSessionRuntimeStore.getState().setSelection('__draft__', {
      providerId: 'provider-explicit',
      modelId: 'deepseek-flash',
    })

    render(<EmptySession />)
    setComposerText('draft question', 14)
    fireEvent.click(screen.getByRole('button', { name: /Run/i }))

    await waitFor(() => expect(useTabStore.getState().activeTabId).toBe('__settings__'))
    expect(mocks.getProviderAuthStatus).toHaveBeenCalledTimes(1)
    expect(mocks.getProviderAuthStatus).toHaveBeenCalledWith('provider-explicit')
    expect(mocks.createSession).not.toHaveBeenCalled()
    expect(useUIStore.getState().pendingSettingsTab).toBe('providers')
    expect(useUIStore.getState().toasts).toContainEqual(expect.objectContaining({
      type: 'warning',
      message: 'deepseek-flash (My DeepSeek) has no usable credentials. Sign in or add an API key in Model Settings, or pick another model.',
    }))
    expect(getComposerText()).toBe('draft question')
  })

  it('still checks the global default, and names it, when the draft has no model of its own', async () => {
    mocks.getProviderAuthStatus.mockResolvedValue({ hasAuth: false, source: 'none' })
    useSettingsStore.setState({
      currentModel: { id: 'claude-sonnet-5', name: 'Sonnet 5', description: 'Default', context: '1m' },
    })
    useProviderStore.setState({ providers: [], activeId: null, hasLoadedProviders: true })

    render(<EmptySession />)
    setComposerText('draft question', 14)
    fireEvent.click(screen.getByRole('button', { name: /Run/i }))

    await waitFor(() => expect(useTabStore.getState().activeTabId).toBe('__settings__'))
    expect(mocks.getProviderAuthStatus).toHaveBeenCalledTimes(1)
    // No providerId: the server keeps evaluating the global default.
    expect(mocks.getProviderAuthStatus.mock.calls[0]?.[0]).toBeUndefined()
    expect(useUIStore.getState().toasts).toContainEqual(expect.objectContaining({
      type: 'warning',
      message: 'Sonnet 5 (Claude Official) has no usable credentials. Sign in or add an API key in Model Settings, or pick another model.',
    }))
  })

  it('uses native desktop file paths for draft attachments', async () => {
    mocks.isTauriRuntime = true
    window.desktopHost = {
      kind: 'electron',
      isDesktop: true,
      capabilities: {
        appMode: false,
        dialogs: true,
        notifications: false,
        previewWebview: false,
        shell: false,
        terminal: false,
        updates: false,
        windowControls: false,
        zoom: false,
      },
      dialogs: {
        open: mocks.dialogOpen,
      },
      webview: {
        onDragDropEvent: vi.fn().mockResolvedValue(mocks.webviewUnlisten),
      },
    } as any
    mocks.dialogOpen.mockResolvedValueOnce([
      'C:\\Users\\Nanmi\\Desktop\\huge-a.log',
      '/Users/nanmi/tmp/huge-b.zip',
    ])

    render(<EmptySession />)

    fireEvent.click(screen.getByRole('button', { name: 'Open composer tools' }))
    fireEvent.click(screen.getByText('Add files or photos'))

    expect(await screen.findByText('huge-a.log')).toBeInTheDocument()
    expect(await screen.findByText('huge-b.zip')).toBeInTheDocument()

    setComposerText('check these files', 'check these files'.length)
    fireEvent.click(screen.getByRole('button', { name: /Run/i }))

    await waitFor(() => {
      expect(mocks.createSession).toHaveBeenCalledWith({ permissionMode: 'default' })
    })
    expect(mocks.wsSend).toHaveBeenCalledWith('draft-session', {
      type: 'user_message',
      content: 'check these files',
      attachments: [
        expect.objectContaining({
          type: 'file',
          name: 'huge-a.log',
          path: 'C:\\Users\\Nanmi\\Desktop\\huge-a.log',
          data: undefined,
        }),
        expect.objectContaining({
          type: 'file',
          name: 'huge-b.zip',
          path: '/Users/nanmi/tmp/huge-b.zip',
          data: undefined,
        }),
      ],
    })
  })

  it('shows a drop affordance and sends dropped desktop files as path attachments', async () => {
    mocks.isTauriRuntime = true
    const droppedFile = new File(['large file'], 'ignored-name.log', { type: 'text/plain' })
    Object.defineProperty(droppedFile, 'path', {
      configurable: true,
      value: '/Users/nanmi/drop/session-context.log',
    })
    const dataTransfer = {
      types: ['Files'],
      files: [droppedFile],
      dropEffect: '',
    }

    render(<EmptySession />)

    const panel = screen.getByTestId('empty-session-composer-panel')
    fireEvent.dragEnter(panel, { dataTransfer })
    expect(screen.getByTestId('empty-session-drop-overlay')).toBeInTheDocument()

    fireEvent.drop(panel, { dataTransfer })

    expect(await screen.findByText('session-context.log')).toBeInTheDocument()
    expect(screen.queryByTestId('empty-session-drop-overlay')).not.toBeInTheDocument()

    setComposerText('use this context', 'use this context'.length)
    fireEvent.click(screen.getByRole('button', { name: /Run/i }))

    await waitFor(() => {
      expect(mocks.createSession).toHaveBeenCalledWith({ permissionMode: 'default' })
    })
    expect(mocks.wsSend).toHaveBeenCalledWith('draft-session', {
      type: 'user_message',
      content: 'use this context',
      attachments: [
        expect.objectContaining({
          type: 'file',
          name: 'session-context.log',
          path: '/Users/nanmi/drop/session-context.log',
          data: undefined,
        }),
      ],
    })
  })

  it('pastes copied desktop files into a new-session draft as path attachments', async () => {
    mocks.isTauriRuntime = true
    const copiedFile = new File(['{\"name\":\"cc-haha\"}'], 'ignored-name.json', {
      type: 'application/json',
    })
    Object.defineProperty(copiedFile, 'path', {
      configurable: true,
      value: 'C:\\Users\\Nanmi\\Desktop\\project-context.json',
    })
    window.desktopHost = {
      ...browserHost,
      kind: 'electron',
      isDesktop: true,
      webview: {
        ...browserHost.webview,
        onDragDropEvent: vi.fn().mockResolvedValue(mocks.webviewUnlisten),
      },
    }

    render(<EmptySession />)

    fireEvent.paste(getComposerElement(), {
      clipboardData: {
        files: [],
        // ProseMirror reads text data before consulting our paste handler, so
        // the stub has to answer like a real DataTransfer.
        getData: () => '',
        items: [{
          kind: 'file',
          type: 'application/json',
          getAsFile: () => copiedFile,
        }],
      },
    })

    expect(await screen.findByText('project-context.json')).toBeInTheDocument()

    setComposerText('use this context', 'use this context'.length)
    fireEvent.click(screen.getByRole('button', { name: /Run/i }))

    await waitFor(() => {
      expect(mocks.createSession).toHaveBeenCalledWith({ permissionMode: 'default' })
    })
    expect(mocks.wsSend).toHaveBeenCalledWith('draft-session', {
      type: 'user_message',
      content: 'use this context',
      attachments: [
        expect.objectContaining({
          type: 'file',
          name: 'project-context.json',
          path: 'C:\\Users\\Nanmi\\Desktop\\project-context.json',
          data: undefined,
        }),
      ],
    })
  })

  it('selects a plugin on the landing composer and sends its runtime request only after Run', async () => {
    const modelText = 'Use plugin "hyperframes@curated" for this request.'
    mocks.listReferences.mockResolvedValue({ skills: [], plugins: [{
      kind: 'plugin', id: 'hyperframes@curated', name: 'hyperframes', displayName: 'HyperFrames',
      description: 'Create HTML videos', source: 'curated', modelText,
    }] })
    render(<EmptySession />)
    setComposerText('@hyper', 6)
    fireEvent.click(await screen.findByRole('option', { name: 'HyperFrames' }))
    await waitFor(() => expect(document.querySelector('[data-mention-kind="plugin"]')).toBeInTheDocument())
    expect(mocks.createSession).not.toHaveBeenCalled()
    fireEvent.keyDown(document.querySelector('[data-mention-kind="plugin"]')!, { key: 'Enter' })
    expect(await screen.findByRole('dialog', { name: 'HyperFrames' })).toHaveTextContent('Create HTML videos')
    fireEvent.click(screen.getByRole('button', { name: 'Close dialog' }))
    fireEvent.click(screen.getByRole('button', { name: /Run/i }))
    await waitFor(() => expect(mocks.wsSend).toHaveBeenCalledWith('draft-session', {
      type: 'user_message', content: modelText, attachments: [],
    }))
  })

  it('sends a selected @ directory as an inline @"path" in the first draft message', async () => {
    mocks.search.mockResolvedValueOnce({
      currentPath: '/workspace/project',
      parentPath: null,
      query: 'backend',
      entries: [
        { name: 'backend', path: '/workspace/project/backend', relativePath: 'backend', isDirectory: true },
      ],
    })

    render(<EmptySession />)

    setComposerText('@backend 讲一下这个目录。', '@backend'.length)
    fireEvent.click(await screen.findByRole('option', { name: /backend/i }))

    await waitFor(() => {
      expect(getComposerText()).toBe('@backend/ 讲一下这个目录。')
    })
    expect(document.querySelector('.composer-mention')).toHaveTextContent('@backend/')

    fireEvent.click(screen.getByRole('button', { name: /Run/i }))

    await waitFor(() => {
      expect(mocks.createSession).toHaveBeenCalled()
    })
    expect(mocks.wsSend).toHaveBeenCalledWith('draft-session', {
      type: 'user_message',
      content: '@"/workspace/project/backend" 讲一下这个目录。',
      attachments: [],
    })
    expect(getComposerText()).toBe('')
  })

  it('keeps slash and @ popovers visible above the empty-session drop target', async () => {
    mocks.search.mockResolvedValueOnce({
      currentPath: '/workspace/project',
      parentPath: null,
      query: '',
      entries: [
        { name: 'README.md', path: '/workspace/project/README.md', isDirectory: false },
      ],
    })

    render(<EmptySession />)

    const panel = screen.getByTestId('empty-session-composer-panel')

    setComposerText('/mcp', 4)
    expect(await screen.findByRole('option', { name: '/mcp' })).toBeInTheDocument()
    expect(panel).toHaveClass('overflow-visible')
    expect(panel).not.toHaveClass('overflow-hidden')

    setComposerText('@readme', 7)
    expect(await screen.findByText('README.md')).toBeInTheDocument()
    expect(panel).toHaveClass('overflow-visible')
    expect(panel).not.toHaveClass('overflow-hidden')
  })

  it('keeps the submitting draft model when auth completes after a newer selection', async () => {
    let completeAuth!: (value: { hasAuth: boolean }) => void
    mocks.getProviderAuthStatus.mockImplementationOnce(() => new Promise(resolve => { completeAuth = resolve }))
    const first = { providerId: 'first-provider', modelId: 'first-model' }
    const second = { providerId: 'second-provider', modelId: 'second-model' }
    useSessionRuntimeStore.getState().setSelection('__draft__', first)
    useUIStore.getState().startNewSessionDraft('/tmp/first')
    const view = render(<EmptySession />)
    setComposerText('first task', 10)
    fireEvent.click(screen.getByRole('button', { name: /Run/i }))
    await waitFor(() => expect(mocks.getProviderAuthStatus).toHaveBeenCalled())
    act(() => {
      useUIStore.getState().startNewSessionDraft('/tmp/second')
      useSessionRuntimeStore.getState().setSelection('__draft__', second)
    })
    view.unmount()
    await act(async () => completeAuth({ hasAuth: true }))
    expect(useSessionRuntimeStore.getState().selections['draft-session']).toEqual(first)
    expect(useSessionRuntimeStore.getState().selections.__draft__).toEqual(second)
  })

  it('does not clear or activate a newer draft when an older creation finishes', async () => {
    let complete!: (value: { sessionId: string }) => void
    mocks.createSession.mockImplementationOnce(() => new Promise(resolve => { complete = resolve }))
    useUIStore.getState().startNewSessionDraft('/tmp/first')
    const view = render(<EmptySession />)
    setComposerText('first task', 10)
    fireEvent.click(screen.getByRole('button', { name: /Run/i }))
    await waitFor(() => expect(mocks.createSession).toHaveBeenCalledTimes(1))
    act(() => {
      useUIStore.getState().startNewSessionDraft('/tmp/second')
      useTabStore.getState().setActiveTab(null)
    })
    const newerDraft = useUIStore.getState().newSessionDraft
    view.unmount()
    await act(async () => complete({ sessionId: 'first-session' }))
    expect(useUIStore.getState().newSessionDraft).toEqual(newerDraft)
    expect(useTabStore.getState().activeTabId).toBeNull()
    expect(useSessionStore.getState().activeSessionId).toBeNull()
  })

  it('hides the mode row by default and creates a standard conversation', async () => {
    render(<EmptySession />)
    fireEvent.click(screen.getByRole('button', { name: 'Open composer tools' }))
    expect(screen.queryByRole('radiogroup', { name: 'Agent mode' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Open composer tools' }))
    setComposerText('edit a file', 11)
    fireEvent.click(screen.getByRole('button', { name: /Run/i }))
    await waitFor(() => expect(mocks.createSession).toHaveBeenCalled())
    expect(mocks.createSession.mock.calls[0]![0]).not.toHaveProperty('agentProfile')
  })

  it('clears a hidden lean selection when the setting is disabled, without losing draft text', async () => {
    useSettingsStore.setState({ leanModeEnabled: true })
    const { rerender } = render(<EmptySession />)
    chooseMode('Lean')
    setComposerText('keep these edits', 16)
    rerender(<EmptySession visible={false} />)
    act(() => useSettingsStore.setState({ leanModeEnabled: false }))
    rerender(<EmptySession visible />)
    expect(screen.queryByTestId('agent-profile-chip')).not.toBeInTheDocument()
    expect(getComposerText()).toBe('keep these edits')
    act(() => useSettingsStore.setState({ leanModeEnabled: true }))
    // Switched back on, the hidden lean choice is gone: the draft is standard.
    expect(screen.queryByTestId('agent-profile-chip')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Open composer tools' }))
    expect(screen.getByRole('radio', { name: 'Standard' })).toBeChecked()
    fireEvent.click(screen.getByRole('button', { name: 'Open composer tools' }))
    act(() => useSettingsStore.setState({ leanModeEnabled: false }))
    fireEvent.click(screen.getByRole('button', { name: /Run/i }))
    await waitFor(() => expect(mocks.createSession).toHaveBeenCalled())
    expect(mocks.createSession.mock.calls[0]![0]).not.toHaveProperty('agentProfile')
  })

  it.each(['file', 'skill'] as const)('preserves %s reference metadata through mode selection and submission', async (kind) => {
    useSettingsStore.setState({ leanModeEnabled: true })
    const modelText = 'Use the Skill tool with skill: "code-review" for this request.'
    mocks.listReferences.mockResolvedValue({ plugins: [], skills: [{
      kind: 'skill', id: 'code-review', name: 'code-review', displayName: 'Code review',
      description: 'Review code', source: 'user', modelText,
    }] })
    mocks.search.mockResolvedValue({
      currentPath: '/workspace/project', parentPath: null, query: 'README',
      entries: [{ name: 'README.md', path: '/workspace/project/README.md', relativePath: 'README.md', isDirectory: false }],
    })
    render(<EmptySession />)
    await pickProject()
    if (kind === 'file') {
      fireEvent.click(screen.getByRole('button', { name: 'Open composer tools' }))
      fireEvent.change(screen.getByRole('combobox', { name: 'Search skills, connectors, files…' }), { target: { value: 'README' } })
      fireEvent.click(await screen.findByRole('option', { name: 'README.md' }))
    } else {
      setComposerText('@code', 5)
      fireEvent.click(await screen.findByRole('option', { name: 'Code review' }))
    }
    await waitFor(() => expect(document.querySelector('.composer-mention')).toBeInTheDocument())
    // Both reselecting the current mode and switching modes must keep the live document metadata.
    for (const mode of ['Standard', 'Lean', 'Standard', 'Lean'] as const) {
      chooseMode(mode)
      expect(document.querySelector('.composer-mention')).toBeInTheDocument()
    }
    fireEvent.click(screen.getByRole('button', { name: /Run/i }))
    await waitFor(() => expect(mocks.wsSend).toHaveBeenCalledWith('draft-session', {
      type: 'user_message', content: kind === 'file' ? '@"/workspace/project/README.md"' : modelText, attachments: [],
    }))
  })

  it('resets plan to asking permission when the draft switches to lean', () => {
    useSettingsStore.setState({ leanModeEnabled: true })
    useSettingsStore.setState({ permissionMode: 'plan' })
    render(<EmptySession />)
    chooseMode('Lean')
    expect(useUIStore.getState().toasts.some(toast => toast.message.includes('Ask permissions'))).toBe(true)
    expect(screen.getByRole('button', { name: 'Permission mode: default' })).toBeInTheDocument()
  })

  it('keeps the lean reset from plan when the global default changes afterwards', async () => {
    mocks.createSession.mockResolvedValue({ sessionId: 'lean-reset-session' })
    useSettingsStore.setState({ leanModeEnabled: true, permissionMode: 'plan' })
    render(<EmptySession />)
    chooseMode('Lean')
    expect(useUIStore.getState().toasts.some(toast => toast.message.includes('Ask permissions'))).toBe(true)

    // The reset is this draft's own mode now, announced to the user.
    act(() => useSettingsStore.setState({ permissionMode: 'acceptEdits' }))
    expect(screen.getByRole('button', { name: 'Permission mode: default' })).toBeInTheDocument()

    setComposerText('edit a file', 11)
    fireEvent.click(screen.getByRole('button', { name: /Run/i }))
    await waitFor(() => {
      expect(mocks.createSession).toHaveBeenCalledWith({ permissionMode: 'default', agentProfile: 'lean' })
    })
  })

  it('keeps an unsupported command editable and explains how to use it', () => {
    useSettingsStore.setState({ leanModeEnabled: true })
    render(<EmptySession />)
    chooseMode('Lean')
    setComposerText('/agent review this', 18)
    fireEvent.click(screen.getByRole('button', { name: /Run/i }))
    expect(mocks.createSession).not.toHaveBeenCalled()
    expect(getComposerText()).toBe('/agent review this')
    expect(useUIStore.getState().toasts.some(toast => toast.message === 'This command is unavailable in lean mode. Switch this draft to Standard and try again.')).toBe(true)
  })

  // A lean session trusts the names its own list carries, so a project
  // `.claude/commands/review.md` runs there although the desktop has a built-in
  // `review` row of its own. The draft has to give the same answer before the
  // session exists, or the command could only be used by starting without it.
  it('lets a lean draft run a project command that shares a name with a desktop built-in', async () => {
    useSettingsStore.setState({ leanModeEnabled: true })
    mocks.listReferences.mockResolvedValue({ plugins: [], skills: [{
      kind: 'skill', id: 'review', name: 'review', displayName: 'review',
      description: 'Project review command', source: 'projectSettings',
      modelText: 'Use the Skill tool with skill: "review" for this request.',
    }] })
    render(<EmptySession />)
    chooseMode('Lean')
    await waitFor(() => expect(mocks.listReferences).toHaveBeenCalledWith(undefined, undefined, 'lean'))
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
    // The menu offers it too, not only the send.
    setComposerText('/review', 7)
    expect(await screen.findByRole('option', { name: '/review' })).toBeInTheDocument()
    setComposerText('/review src', 11)
    // Closing the slash menu fetches the lists again: Run lands while they are empty.
    fireEvent.click(screen.getByRole('button', { name: /Run/i }))
    await waitFor(() => expect(mocks.createSession).toHaveBeenCalledWith(expect.objectContaining({ agentProfile: 'lean' })))
    expect(useUIStore.getState().toasts.some(toast => toast.message.includes('unavailable in lean mode'))).toBe(false)
  })

  it('still refuses a desktop built-in name in a lean draft when the project has no command of that name', async () => {
    useSettingsStore.setState({ leanModeEnabled: true })
    render(<EmptySession />)
    chooseMode('Lean')
    await waitFor(() => expect(mocks.listReferences).toHaveBeenCalledWith(undefined, undefined, 'lean'))
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
    setComposerText('/review', 7)
    expect(screen.queryByRole('option', { name: '/review' })).not.toBeInTheDocument()
    setComposerText('/review src', 11)
    fireEvent.click(screen.getByRole('button', { name: /Run/i }))
    expect(mocks.createSession).not.toHaveBeenCalled()
    expect(useUIStore.getState().toasts.some(toast => toast.message === 'This command is unavailable in lean mode. Switch this draft to Standard and try again.')).toBe(true)
  })

  // The runtime refuses a skill that forks a subagent, so a lean draft must not
  // offer it in the menu or let a send reach that refusal. The server says which
  // skills those are; the choice of lean is made after the list was fetched.
  const forkedAndInlineSkills = {
    skills: [
      { name: 'inline-skill', description: 'Runs inline', source: 'user', userInvocable: true, leanCompatible: true },
      { name: 'forked-skill', description: 'Forks a subagent', source: 'user', userInvocable: true, leanCompatible: false },
    ],
  }

  it('keeps a skill the lean runtime cannot run out of a lean draft, but not out of a standard one', async () => {
    mocks.listSkills.mockResolvedValue(forkedAndInlineSkills)
    useSettingsStore.setState({ leanModeEnabled: true })
    render(<EmptySession />)
    await waitFor(() => expect(mocks.listSkills).toHaveBeenCalled())

    setComposerText('/forked', 7)
    expect(await screen.findByRole('option', { name: /forked-skill/ })).toBeInTheDocument()

    chooseMode('Lean')
    setComposerText('/forke', 6)
    setComposerText('/forked', 7)
    await waitFor(() => expect(screen.queryByRole('option', { name: /forked-skill/ })).not.toBeInTheDocument())
    setComposerText('/inline', 7)
    expect(await screen.findByRole('option', { name: /inline-skill/ })).toBeInTheDocument()
  })

  it('refuses to send a skill the lean runtime cannot run, and sends one it can', async () => {
    mocks.listSkills.mockResolvedValue(forkedAndInlineSkills)
    useSettingsStore.setState({ leanModeEnabled: true })
    render(<EmptySession />)
    chooseMode('Lean')
    await waitFor(() => expect(mocks.listSkills).toHaveBeenCalled())
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })

    setComposerText('/forked-skill go', 16)
    fireEvent.click(screen.getByRole('button', { name: /Run/i }))
    expect(mocks.createSession).not.toHaveBeenCalled()
    expect(useUIStore.getState().toasts.some(toast => toast.message === 'This command is unavailable in lean mode. Switch this draft to Standard and try again.')).toBe(true)

    setComposerText('/inline-skill go', 16)
    fireEvent.click(screen.getByRole('button', { name: /Run/i }))
    await waitFor(() => expect(mocks.createSession).toHaveBeenCalledWith(expect.objectContaining({ agentProfile: 'lean' })))
  })

  it('allows an absolute path prompt in lean mode', async () => {
    useSettingsStore.setState({ leanModeEnabled: true })
    render(<EmptySession />)
    chooseMode('Lean')
    setComposerText('/tmp/cart.js fix this file', 26)
    fireEvent.click(screen.getByRole('button', { name: /Run/i }))
    await waitFor(() => expect(mocks.createSession).toHaveBeenCalledWith(expect.objectContaining({ agentProfile: 'lean' })))
  })

  it('retains the lean mode and unsent text while the draft is hidden', () => {
    useSettingsStore.setState({ leanModeEnabled: true })
    const { rerender } = render(<EmptySession />)
    chooseMode('Lean')
    setComposerText('keep these edits', 16)
    rerender(<EmptySession visible={false} />)
    rerender(<EmptySession visible />)
    expect(screen.getByTestId('agent-profile-chip')).toHaveTextContent('Lean')
    expect(getComposerText()).toBe('keep these edits')
  })

  it('creates a lean conversation and leaves its draft editable when creation fails', async () => {
    useSettingsStore.setState({ leanModeEnabled: true })
    mocks.createSession.mockRejectedValueOnce(new Error('create failed'))
    render(<EmptySession />)
    expect(screen.queryByTestId('agent-profile-chip')).not.toBeInTheDocument()
    chooseMode('Lean')
    expect(screen.getByTestId('agent-profile-chip')).toHaveTextContent('Lean')
    setComposerText('edit a file', 11)
    fireEvent.click(screen.getByRole('button', { name: /Run/i }))
    await waitFor(() => expect(mocks.createSession).toHaveBeenCalledWith(expect.objectContaining({ agentProfile: 'lean' })))
    // The draft stays editable after a failure, so the chip can be taken off again.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Switch back to Standard mode' })).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: 'Switch back to Standard mode' }))
    expect(screen.queryByTestId('agent-profile-chip')).not.toBeInTheDocument()
  })

  // The mode is a row of the "+" menu, with its explanation under it, and the
  // toolbar only marks a lean draft. A permanent "Standard ▾" and an info
  // button used to sit on the row; they cut the project to "claude-cod…" and
  // pushed the trailing group onto a second line. Real widths are measured in
  // a browser; these pin the structure that keeps that from coming back.
  it('picks the mode in the + menu, explains it there, and marks only a lean draft on the toolbar', () => {
    useSettingsStore.setState({ leanModeEnabled: true })
    render(<EmptySession />)
    expect(screen.queryByTestId('agent-profile-chip')).not.toBeInTheDocument()
    expect(screen.queryByTestId('agent-profile-control')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Open composer tools' }))
    const row = screen.getByRole('radiogroup', { name: 'Agent mode' })
    expect(within(row).getByRole('radio', { name: 'Standard' })).toBeChecked()
    expect(screen.getByTestId('agent-profile-detail')).toHaveTextContent('Choose before the first message')
    fireEvent.click(within(row).getByRole('radio', { name: 'Lean' }))
    // Lean's limits are read next to the choice, and the toolbar says "Lean".
    expect(screen.getByTestId('agent-profile-detail')).toHaveTextContent('Web search and fetch, connectors (MCP)')
    expect(screen.getByTestId('agent-profile-chip')).toHaveTextContent(/^Lean$/)
  })

  it('takes a lean draft back to Standard from the chip', async () => {
    useSettingsStore.setState({ leanModeEnabled: true })
    render(<EmptySession />)
    chooseMode('Lean')
    fireEvent.click(screen.getByRole('button', { name: 'Switch back to Standard mode' }))
    expect(screen.queryByTestId('agent-profile-chip')).not.toBeInTheDocument()
    setComposerText('edit a file', 11)
    fireEvent.click(screen.getByRole('button', { name: /Run/i }))
    await waitFor(() => expect(mocks.createSession).toHaveBeenCalled())
    expect(mocks.createSession.mock.calls[0]![0]).not.toHaveProperty('agentProfile')
  })

  it('drops an armed Agent Team when the draft switches to lean, and says so', () => {
    useSettingsStore.setState({ leanModeEnabled: true, agentTeamsEnabled: true })
    window.localStorage.setItem(AGENT_TEAMS_NOTICE_STORAGE_KEY, JSON.stringify({ version: 1, dismissed: true }))
    try {
      render(<EmptySession />)
      fireEvent.click(screen.getByRole('button', { name: 'Open composer tools' }))
      fireEvent.click(screen.getByRole('switch', { name: /Agent Teams/ }))
      expect(screen.getByTestId('agent-team-chip')).toBeInTheDocument()
      fireEvent.click(screen.getByRole('radio', { name: 'Lean' }))
      expect(screen.queryByTestId('agent-team-chip')).not.toBeInTheDocument()
      expect(useUIStore.getState().toasts.some(toast => toast.message.includes('Agent Teams'))).toBe(true)
      // Back on Standard the team is not armed again behind the user's back.
      fireEvent.click(screen.getByRole('radio', { name: 'Standard' }))
      expect(screen.queryByTestId('agent-team-chip')).not.toBeInTheDocument()
    } finally {
      window.localStorage.removeItem(AGENT_TEAMS_NOTICE_STORAGE_KEY)
    }
  })

  it('fixes the mode while the conversation is being created', async () => {
    useSettingsStore.setState({ leanModeEnabled: true })
    mocks.createSession.mockReturnValue(new Promise(() => {}))
    render(<EmptySession />)
    chooseMode('Lean')
    setComposerText('edit a file', 11)
    fireEvent.click(screen.getByRole('button', { name: /Run/i }))
    await waitFor(() => expect(mocks.createSession).toHaveBeenCalled())
    expect(screen.queryByRole('button', { name: 'Switch back to Standard mode' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Open composer tools' }))
    expect(within(screen.getByRole('radiogroup', { name: 'Agent mode' })).getByRole('radio', { name: 'Standard' })).toBeDisabled()
  })

  // jsdom lays nothing out, so this pins the pieces a real-browser measurement
  // showed to matter. The desktop row never wraps, with or without the lean
  // mode: the leading group (the "+", chips, location) gives up width and the
  // location truncates, while the trailing group keeps its own. The row used to
  // wrap its trailing group onto a second line to make room for a lean control,
  // which left the first line's right half empty.
  it.each([false, true])('keeps the desktop toolbar to one row, the location giving way (lean mode %s)', (leanModeEnabled) => {
    mocks.isMobile = false
    useSettingsStore.setState({ leanModeEnabled })
    render(<EmptySession />)
    const toolbar = screen.getByTestId('empty-session-toolbar')
    const leading = screen.getByTestId('empty-session-toolbar-leading')
    const trailing = screen.getByTestId('empty-session-toolbar-trailing')
    expect(toolbar).not.toHaveClass('flex-wrap')
    expect(leading).toHaveClass('min-w-0', 'shrink')
    expect(trailing).toHaveClass('shrink-0')
    expect(trailing).not.toHaveClass('min-w-max')
    // The permission glyph leads the trailing group; the usage ring is not on a draft.
    expect(trailing.firstElementChild).toContainElement(screen.getByRole('button', { name: /^Permission mode/ }))
    // The trigger is at the card's right: its menu opens leftwards, inside the card.
    expect(screen.getByTestId('permission-mode-selector')).toHaveAttribute('data-menu-align', 'right')
    expect(screen.queryByTestId('context-usage-indicator')).not.toBeInTheDocument()
    expect(leading).not.toContainElement(screen.getByRole('button', { name: /^Permission mode/ }))
  })

  // A phone keeps the row it always had; its mode lives in the "+" sheet.
  it.each([
    { leanModeEnabled: false, phone: true },
    { leanModeEnabled: true, phone: true },
  ])('leaves the phone toolbar as it always was (%j)', ({ leanModeEnabled, phone }) => {
    mocks.isMobile = phone
    useSettingsStore.setState({ leanModeEnabled })
    render(<EmptySession />)
    const toolbar = screen.getByTestId('empty-session-toolbar')
    const trailing = screen.getByTestId('empty-session-toolbar-trailing')
    const model = screen.getByTestId('model-selector')
    expect(phone).toBe(true)
    expect(toolbar).toHaveClass('flex-wrap', 'gap-1')
    expect(trailing).toHaveClass('min-w-0', 'flex-1')
    expect(trailing).not.toHaveClass('min-w-max')
    expect(model).toHaveAttribute('data-fluid', 'false')
    // No slot around the picker: it is a direct child of the trailing group.
    expect(model.parentElement).toBe(trailing)
    expect(screen.queryByTestId('agent-profile-control')).not.toBeInTheDocument()
  })

  it('keeps the mode off the phone toolbar and in the + sheet, beside permissions and model', async () => {
    mocks.isMobile = true
    useSettingsStore.setState({ leanModeEnabled: true })
    render(<EmptySession />)
    // The chip, its info button and the badge covered the "+" on a 390px phone.
    expect(screen.queryByRole('button', { name: /^Agent mode:/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'About lean mode' })).not.toBeInTheDocument()
    expect(screen.queryByTestId('agent-profile-control')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Open composer tools' }))
    const row = within(screen.getByTestId('mobile-composer-sheet')).getByRole('button', { name: /^Agent mode/ })
    expect(row).toHaveTextContent('Standard')
    fireEvent.click(row)

    // One sheet at a time: the + sheet closes before the mode sheet opens.
    const modeSheet = await screen.findByTestId('agent-profile-sheet')
    expect(screen.queryByTestId('mobile-composer-sheet')).not.toBeInTheDocument()
    fireEvent.click(within(modeSheet).getByRole('radio', { name: /Lean · experimental/ }))
    expect(screen.queryByTestId('agent-profile-sheet')).not.toBeInTheDocument()

    // The choice is the draft's mode: the row reads it back, and Run creates a lean session.
    fireEvent.click(screen.getByRole('button', { name: 'Open composer tools' }))
    expect(within(screen.getByTestId('mobile-composer-sheet')).getByRole('button', { name: /^Agent mode/ })).toHaveTextContent('Lean · experimental')
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByTestId('mobile-composer-sheet')).not.toBeInTheDocument()
    setComposerText('edit a file', 11)
    fireEvent.click(screen.getByRole('button', { name: /Run/i }))
    await waitFor(() => expect(mocks.createSession).toHaveBeenCalledWith(expect.objectContaining({ agentProfile: 'lean' })))
  })

  it('resets plan to asking permission when the phone sheet switches the draft to lean, as the desktop chip does', async () => {
    mocks.isMobile = true
    useSettingsStore.setState({ leanModeEnabled: true, permissionMode: 'plan' })
    render(<EmptySession />)
    fireEvent.click(screen.getByRole('button', { name: 'Open composer tools' }))
    fireEvent.click(within(screen.getByTestId('mobile-composer-sheet')).getByRole('button', { name: /^Agent mode/ }))
    fireEvent.click(within(await screen.findByTestId('agent-profile-sheet')).getByRole('radio', { name: /Lean · experimental/ }))
    expect(useUIStore.getState().toasts.some(toast => toast.message.includes('Ask permissions'))).toBe(true)
    expect(screen.getByRole('button', { name: 'Permission mode: default' })).toBeInTheDocument()
  })

  it('offers no mode row on the phone while lean mode is switched off in Settings', () => {
    mocks.isMobile = true
    render(<EmptySession />)
    fireEvent.click(screen.getByRole('button', { name: 'Open composer tools' }))
    const sheet = screen.getByTestId('mobile-composer-sheet')
    expect(within(sheet).getByRole('button', { name: /Execution Permissions/ })).toBeInTheDocument()
    expect(within(sheet).queryByRole('button', { name: /^Agent mode/ })).not.toBeInTheDocument()
  })

  it('holds the phone mode row while the conversation is being created', async () => {
    mocks.isMobile = true
    useSettingsStore.setState({ leanModeEnabled: true })
    mocks.createSession.mockReturnValue(new Promise(() => {}))
    render(<EmptySession />)
    setComposerText('edit a file', 11)
    fireEvent.click(screen.getByRole('button', { name: /Run/i }))
    await waitFor(() => expect(mocks.createSession).toHaveBeenCalled())
    fireEvent.click(screen.getByRole('button', { name: 'Open composer tools' }))
    expect(within(screen.getByTestId('mobile-composer-sheet')).getByRole('button', { name: /^Agent mode/ })).toBeDisabled()
  })

  it('starts in a selected non-Git project without showing a repository warning', async () => {
    mocks.getRepositoryContext.mockResolvedValueOnce(notGitRepositoryContext())

    render(<EmptySession />)

    setComposerText('draft question', 14)
    await pickProject()

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Run/i })).not.toBeDisabled()
    })

    expect(screen.queryByText('Current project is not a Git repository.')).not.toBeInTheDocument()

    // Without a repo the pill carries the folder alone, and there are no
    // branch or worktree rows to drop back to — so the menu opens straight on
    // the directory list instead of a root view holding a single row.
    await openLaunchMenu()
    expect(await screen.findByRole('button', { name: 'Pick project' })).toBeInTheDocument()
    expect(screen.queryByRole('menu', { name: 'Location' })).not.toBeInTheDocument()
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Pick project' })).not.toBeInTheDocument()
    })

    fireEvent.click(screen.getByRole('button', { name: /Run/i }))

    await waitFor(() => {
      expect(mocks.createSession).toHaveBeenCalledWith({
        workDir: '/workspace/project',
        permissionMode: 'default',
      })
    })
  })

  it('shows an actionable repository error when direct branch switching is blocked', async () => {
    mocks.createSession.mockRejectedValueOnce(new ApiError(400, {
      error: 'REPOSITORY_DIRTY_WORKTREE',
      message: 'Working tree has uncommitted changes.',
    }))

    render(<EmptySession />)

    setComposerText('draft question', 14)
    await pickProject()

    await waitFor(() => {
      expect(screen.getByText('main')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByRole('button', { name: /Run/i }))

    await waitFor(() => {
      const toasts = useUIStore.getState().toasts
      expect(toasts[toasts.length - 1]?.message).toBe(
        'Current project has uncommitted changes. Direct branch switching was blocked; enable "Isolated worktree" or commit/stash your changes first.',
      )
    })
    expect(useTabStore.getState().activeTabId).toBeNull()
  })

  it('keeps Run disabled until repository context resolves for a selected project', async () => {
    let resolveContext: (context: RepositoryContextResult) => void = () => {}
    mocks.getRepositoryContext.mockImplementationOnce(() => new Promise<RepositoryContextResult>((resolve) => {
      resolveContext = resolve
    }))

    render(<EmptySession />)

    setComposerText('draft question', 14)
    await pickProject()

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Run/i })).toBeDisabled()
    })

    fireEvent.click(screen.getByRole('button', { name: /Run/i }))
    expect(mocks.createSession).not.toHaveBeenCalled()

    resolveContext(okRepositoryContext())

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Run/i })).not.toBeDisabled()
    })
  })

  it('falls back to a visible branch when the current branch is an internal desktop worktree branch', async () => {
    mocks.getRepositoryContext.mockResolvedValueOnce(okRepositoryContext({
      currentBranch: 'worktree-desktop-feature-a-12345678',
      defaultBranch: 'main',
      branches: [
        {
          name: 'main',
          current: false,
          local: true,
          remote: false,
          checkedOut: false,
        },
        {
          name: 'feature/a',
          current: false,
          local: true,
          remote: false,
          checkedOut: false,
        },
      ],
      worktrees: [{
        path: '/workspace/project/.claude/worktrees/desktop-feature-a-12345678',
        branch: 'worktree-desktop-feature-a-12345678',
        current: true,
      }],
    }))

    render(<EmptySession />)

    setComposerText('draft question', 14)
    await pickProject()

    await waitFor(() => {
      expect(screen.getByText('main')).toBeInTheDocument()
      // Branch text can render before the request's finally clears loading
      // and the launch-readiness effect enables sending. Wait for the action, too.
      expect(screen.getByRole('button', { name: /Run/i })).not.toBeDisabled()
    })

    expect(screen.queryByText('worktree-desktop-feature-a-12345678')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /Run/i }))

    await waitFor(() => {
      expect(mocks.createSession).toHaveBeenCalledWith({
        workDir: '/workspace/project',
        repository: { branch: 'main', worktree: false },
        permissionMode: 'default',
      })
    })
  })

  it('keeps the repository launch context on one row and truncates long branch names', async () => {
    const longBranch = 'feature/super-long-branch-name-for-repository-launch-controls-e2e'
    mocks.getRepositoryContext.mockResolvedValueOnce(okRepositoryContext({
      currentBranch: longBranch,
      defaultBranch: 'main',
      branches: [{
        name: longBranch,
        current: true,
        local: true,
        remote: false,
        checkedOut: true,
        worktreePath: '/workspace/project',
      }],
      worktrees: [{
        path: '/workspace/project',
        branch: longBranch,
        current: true,
      }],
    }))

    render(<EmptySession />)

    setComposerText('draft question', 14)
    await pickProject()

    const pill = await screen.findByRole('button', { name: `Location: project / ${longBranch}` })
    // The name sits in a <bdi>; the truncation and direction live on its wrapper.
    const branchWrap = within(pill).getByText(longBranch).closest('[dir="rtl"]')

    // Truncation happens inside the pill so the toolbar row never wraps.
    expect(branchWrap?.className).toContain('truncate')
    expect(pill.className).toContain('max-w-full')

    // `dir="rtl"` moves the ellipsis to the front, so what survives is the
    // tail — `…launch-controls-e2e`, not the useless `feature/super-long…`.
    expect(branchWrap).not.toBeNull()
  })

  // A worktree on a detached HEAD (a Codex-managed one, a checked-out tag or PR)
  // has no branch to follow. Launching "on" the default branch would switch the
  // user off their commit, or be refused outright when that branch is checked
  // out in the main worktree, so nothing is chosen for it and it launches as it is.
  const detachedWorktreeContext = () => okRepositoryContext({
    currentBranch: null,
    defaultBranch: 'main',
    branches: [
      {
        name: 'main',
        current: false,
        local: true,
        remote: false,
        checkedOut: true,
        worktreePath: '/workspace/project',
      },
      {
        name: 'feature/a',
        current: false,
        local: true,
        remote: false,
        checkedOut: false,
      },
    ],
    worktrees: [{
      path: '/workspace/project/.codex/worktrees/detached/project',
      branch: null,
      current: true,
    }],
  })

  it('launches a detached worktree as it is instead of switching it onto a default branch checked out elsewhere', async () => {
    mocks.getRepositoryContext.mockResolvedValueOnce(detachedWorktreeContext())

    render(<EmptySession />)

    setComposerText('draft question', 14)
    await pickProject()

    // No branch is chosen for it, so there is nothing to warn about.
    expect(await screen.findByRole('button', { name: 'Location: project' })).toBeInTheDocument()
    expect(screen.queryByRole('status', { name: /already checked out/ })).not.toBeInTheDocument()

    // Staying on the current worktree is the live, selected choice.
    await openLaunchMenu()
    const currentWorktree = await screen.findByRole('menuitemradio', { name: /Current worktree/ })
    expect(currentWorktree).not.toBeDisabled()
    expect(currentWorktree).toHaveAttribute('aria-checked', 'true')
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => {
      expect(screen.queryByRole('menu', { name: 'Location' })).not.toBeInTheDocument()
    })

    fireEvent.click(screen.getByRole('button', { name: /Run/i }))

    await waitFor(() => {
      expect(mocks.createSession).toHaveBeenCalledWith({
        workDir: '/workspace/project',
        permissionMode: 'default',
      })
    })
  })

  // Picking a project resets the draft's launch state and holds Send until the
  // controls report ready. Picking the one already in use changes nothing, so
  // nothing is reported again: Send used to stay disabled for good there.
  it.each([
    { label: 'a detached worktree', context: () => detachedWorktreeContext() },
    { label: 'a plain folder', context: () => notGitRepositoryContext() },
  ])('keeps Send enabled after the current project is picked again in $label', async ({ context }) => {
    mocks.getRepositoryContext.mockResolvedValue(context())
    mocks.createSession.mockResolvedValue({ sessionId: 'repicked-session' })

    render(<EmptySession />)
    setComposerText('draft question', 14)
    await pickProject()
    await waitFor(() => expect(screen.getByRole('button', { name: /Run/i })).not.toBeDisabled())

    await openLaunchMenu()
    // A repo opens on the root view; a plain folder has nothing but the directory list.
    const directoryRow = screen.queryByRole('menuitem', { name: /Directory/ })
    if (directoryRow) fireEvent.click(directoryRow)
    fireEvent.click(await screen.findByRole('button', { name: 'Pick project' }))
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => {
      expect(screen.queryByRole('menu', { name: 'Location' })).not.toBeInTheDocument()
    })

    const run = screen.getByRole('button', { name: /Run/i })
    await waitFor(() => expect(run).not.toBeDisabled())
    fireEvent.click(run)
    await waitFor(() => expect(mocks.createSession).toHaveBeenCalledWith(expect.objectContaining({ permissionMode: 'default' })))
  })

  it('keeps current worktree selectable, with its warning, when the user picks a branch checked out elsewhere', async () => {
    mocks.getRepositoryContext.mockResolvedValue(detachedWorktreeContext())

    render(<EmptySession />)

    setComposerText('draft question', 14)
    await pickProject()
    await screen.findByRole('button', { name: 'Location: project' })

    await openLaunchMenu()
    fireEvent.click(await screen.findByRole('menuitem', { name: /Branch/ }))
    fireEvent.click(await screen.findByRole('option', { name: /^main/ }))
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => {
      expect(screen.queryByRole('menu', { name: 'Location' })).not.toBeInTheDocument()
    })

    const warning = await screen.findByRole('status', {
      name: 'Selected branch is already checked out in another worktree. Direct launch may be blocked by Git; use "Isolated worktree" to avoid changing directories.',
    })
    expect(warning).toHaveTextContent('Branch already checked out')

    // Staying on the current worktree has to remain a live choice even when the
    // branch picked is checked out elsewhere — it must not render disabled.
    await openLaunchMenu()
    const currentWorktree = await screen.findByRole('menuitemradio', { name: /Current worktree/ })
    expect(currentWorktree).not.toBeDisabled()
    expect(currentWorktree).toHaveAttribute('aria-checked', 'true')
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => {
      expect(screen.queryByRole('menu', { name: 'Location' })).not.toBeInTheDocument()
    })

    fireEvent.click(screen.getByRole('button', { name: /Run/i }))

    await waitFor(() => {
      expect(mocks.createSession).toHaveBeenCalledWith({
        workDir: '/workspace/project',
        repository: { branch: 'main', worktree: false },
        permissionMode: 'default',
      })
    })
  })

  // The retained new-session draft: "New session" may move it to another
  // project only while nothing unsent is in it, so it has to say when it holds
  // something.
  describe('as the retained new-session draft', () => {
    it('tells the draft whether it holds unsent text', () => {
      useUIStore.getState().startNewSessionDraft('')
      const draft = useUIStore.getState().newSessionDraft!
      render(<EmptySession draftRevision={draft.revision} />)
      const hasContent = () => useUIStore.getState().newSessionDraft?.hasContent
      expect(hasContent()).toBe(false)

      setComposerText('   ', 3)
      expect(hasContent()).toBe(false)
      setComposerText('keep me', 7)
      expect(hasContent()).toBe(true)
      setComposerText('', 0)
      expect(hasContent()).toBe(false)
    })

    it('counts an attachment as unsent content', async () => {
      mocks.isTauriRuntime = true
      const file = new File(['notes'], 'ignored-name.md', { type: 'text/markdown' })
      Object.defineProperty(file, 'path', { configurable: true, value: '/Users/nanmi/drop/notes.md' })
      useUIStore.getState().startNewSessionDraft('')
      const draft = useUIStore.getState().newSessionDraft!
      render(<EmptySession draftRevision={draft.revision} />)

      fireEvent.drop(screen.getByTestId('empty-session-composer-panel'), {
        dataTransfer: { types: ['Files'], files: [file], dropEffect: '' },
      })
      expect(await screen.findByText('notes.md')).toBeInTheDocument()
      expect(useUIStore.getState().newSessionDraft?.hasContent).toBe(true)
    })

    it('assigns a session and carries text, attachments and file pills when a workspace control is used', async () => {
      mocks.isTauriRuntime = true
      mocks.createSession.mockResolvedValue({ sessionId: 'materialized-session' })
      mocks.search.mockResolvedValue({
        currentPath: '/workspace/project',
        parentPath: null,
        query: 'README',
        entries: [{ name: 'README.md', path: '/workspace/project/README.md', relativePath: 'README.md', isDirectory: false }],
      })
      useUIStore.getState().startNewSessionDraft('/workspace/project')
      const draft = useUIStore.getState().newSessionDraft!
      render(<EmptySession draftRevision={draft.revision} initialWorkDir="/workspace/project" />)

      setComposerText('Review this change', 'Review this change'.length)
      const file = new File(['notes'], 'ignored-name.md', { type: 'text/markdown' })
      Object.defineProperty(file, 'path', { configurable: true, value: '/workspace/project/notes.md' })
      fireEvent.drop(screen.getByTestId('empty-session-composer-panel'), {
        dataTransfer: { types: ['Files'], files: [file], dropEffect: '' },
      })
      expect(await screen.findByText('notes.md')).toBeInTheDocument()

      fireEvent.click(screen.getByRole('button', { name: 'Open composer tools' }))
      fireEvent.change(screen.getByRole('combobox', { name: 'Search skills, connectors, files…' }), { target: { value: 'README' } })
      fireEvent.click(await screen.findByRole('option', { name: 'README.md' }))
      await waitFor(() => expect(getComposerText()).toContain('@README.md'))

      act(() => useUIStore.getState().requestDraftWorkspace('toggle-side'))

      await waitFor(() => expect(mocks.createSession).toHaveBeenCalledTimes(1))
      expect(mocks.createSession).toHaveBeenCalledWith(expect.objectContaining({
        workDir: '/workspace/project',
        permissionMode: 'default',
      }))
      await waitFor(() => {
        expect(useWorkspaceStore.getState().getSession('materialized-session').layout).toBe('split')
      })
      expect(useUIStore.getState().newSessionDraft).toBeNull()
      expect(useTabStore.getState().activeTabId).toBe('materialized-session')
      expect(mocks.wsSend).not.toHaveBeenCalledWith(
        'materialized-session',
        expect.objectContaining({ type: 'user_message' }),
      )

      const prefill = useChatStore.getState().sessions['materialized-session']?.composerPrefill
      expect(prefill?.text).toContain('@README.md')
      expect(prefill?.mentions).toEqual([
        expect.objectContaining({ label: 'README.md', path: '/workspace/project/README.md' }),
      ])
      expect(prefill?.attachments).toEqual([
        expect.objectContaining({ name: 'notes.md', path: '/workspace/project/notes.md' }),
      ])
    })

    it('opens the bottom panel in the new session folder', async () => {
      mocks.createSession.mockResolvedValue({ sessionId: 'bottom-session' })
      useUIStore.getState().startNewSessionDraft('/workspace/project')
      const draft = useUIStore.getState().newSessionDraft!
      render(<EmptySession draftRevision={draft.revision} initialWorkDir="/workspace/project" />)

      act(() => useUIStore.getState().requestDraftWorkspace('toggle-bottom'))

      await waitFor(() => expect(mocks.createSession).toHaveBeenCalledTimes(1))
      await waitFor(() => {
        const state = useWorkspaceStore.getState().getSession('bottom-session')
        expect(state.bottomOpen).toBe(true)
        expect(state.tabs.find((tab) => tab.kind === 'terminal')).toMatchObject({
          kind: 'terminal',
          cwd: '/workspace/project',
        })
      })
    })

    it('completes workspace setup in the background after the user switches tabs', async () => {
      let complete!: (value: { sessionId: string }) => void
      mocks.createSession.mockImplementationOnce(() => new Promise((resolve) => { complete = resolve }))
      useUIStore.getState().startNewSessionDraft('/workspace/project')
      const draft = useUIStore.getState().newSessionDraft!
      render(<EmptySession draftRevision={draft.revision} initialWorkDir="/workspace/project" />)

      act(() => useUIStore.getState().requestDraftWorkspace('toggle-side'))
      await waitFor(() => expect(mocks.createSession).toHaveBeenCalledTimes(1))
      act(() => useTabStore.getState().openTab('other-session', 'Other session'))

      await act(async () => complete({ sessionId: 'background-session' }))

      expect(useTabStore.getState().activeTabId).toBe('other-session')
      expect(useTabStore.getState().tabs.map((tab) => tab.sessionId)).toContain('background-session')
      expect(useWorkspaceStore.getState().getSession('background-session').layout).toBe('split')
      expect(useUIStore.getState().draftWorkspaceRequest).toBeNull()
    })

    it('does not apply an in-flight workspace action to a newer draft revision', async () => {
      let complete!: (value: { sessionId: string }) => void
      mocks.createSession.mockImplementationOnce(() => new Promise((resolve) => { complete = resolve }))
      useUIStore.getState().startNewSessionDraft('/workspace/project')
      const draft = useUIStore.getState().newSessionDraft!
      render(<EmptySession draftRevision={draft.revision} initialWorkDir="/workspace/project" />)

      act(() => useUIStore.getState().requestDraftWorkspace('toggle-side'))
      await waitFor(() => expect(mocks.createSession).toHaveBeenCalledTimes(1))
      act(() => useUIStore.setState({
        newSessionDraft: { workDir: '/another/project', revision: draft.revision + 1, hasContent: false },
      }))

      await act(async () => complete({ sessionId: 'stale-session' }))

      expect(useUIStore.getState().newSessionDraft?.revision).toBe(draft.revision + 1)
      expect(useWorkspaceStore.getState().getSession('stale-session').layout).toBe('hidden')
      expect(useTabStore.getState().activeTabId).not.toBe('stale-session')
      expect(rawRecordDiagnosticEvent).toHaveBeenCalledWith({
        type: 'draft_workspace_request_stale',
        severity: 'warn',
        summary: 'A draft workspace request became stale before it could be consumed.',
      })
    })

    it('retains a workspace action requested while Run is creating the session', async () => {
      let complete!: (value: { sessionId: string }) => void
      mocks.createSession.mockImplementationOnce(() => new Promise((resolve) => { complete = resolve }))
      useUIStore.getState().startNewSessionDraft('/workspace/project')
      const draft = useUIStore.getState().newSessionDraft!
      render(<EmptySession draftRevision={draft.revision} initialWorkDir="/workspace/project" />)
      setComposerText('run this task', 'run this task'.length)

      const runButton = screen.getByRole('button', { name: /Run/i })
      await waitFor(() => expect(runButton).not.toBeDisabled())
      fireEvent.click(runButton)
      await waitFor(() => expect(mocks.createSession).toHaveBeenCalledTimes(1))
      act(() => useUIStore.getState().requestDraftWorkspace('toggle-side'))

      await act(async () => complete({ sessionId: 'run-workspace-session' }))
      await waitFor(() => {
        expect(useWorkspaceStore.getState().getSession('run-workspace-session').layout).toBe('split')
        expect(useUIStore.getState().draftWorkspaceRequest).toBeNull()
      })
      expect(mocks.createSession).toHaveBeenCalledTimes(1)
      expect(mocks.wsSend).toHaveBeenCalledWith('run-workspace-session', expect.objectContaining({
        type: 'user_message',
        content: 'run this task',
      }))
      expect(useChatStore.getState().sessions['run-workspace-session']?.composerPrefill).toBeNull()
    })

    it('keeps a failed request queued and consumes it after the next Run retry', async () => {
      let resolveContext!: (context: RepositoryContextResult) => void
      mocks.getRepositoryContext.mockImplementationOnce(() => new Promise(resolve => { resolveContext = resolve }))
      mocks.createSession.mockRejectedValueOnce(new Error('temporary failure'))
      useUIStore.getState().startNewSessionDraft('/workspace/project')
      const draft = useUIStore.getState().newSessionDraft!
      render(<EmptySession draftRevision={draft.revision} initialWorkDir="/workspace/project" />)
      setComposerText('retry this task', 'retry this task'.length)

      act(() => useUIStore.getState().requestDraftWorkspace('toggle-side'))
      await waitFor(() => expect(useUIStore.getState().toasts.some((toast) => toast.type === 'error')).toBe(true))
      expect(useUIStore.getState().draftWorkspaceRequest).toMatchObject({
        action: 'toggle-side',
        revision: draft.revision,
      })
      expect(useUIStore.getState().newSessionDraft).not.toBeNull()

      const runButton = screen.getByRole('button', { name: /Run/i })
      expect(runButton).toBeDisabled()
      // Run is unavailable until repository context finishes loading, even
      // after the failed creation has reported its toast. Retry via the UI
      // only once that independent prerequisite has completed.
      await act(async () => resolveContext(okRepositoryContext()))
      await waitFor(() => expect(runButton).not.toBeDisabled())
      fireEvent.click(runButton)
      await waitFor(() => {
        expect(useWorkspaceStore.getState().getSession('draft-session').layout).toBe('split')
        expect(useUIStore.getState().draftWorkspaceRequest).toBeNull()
      })
      expect(mocks.createSession).toHaveBeenCalledTimes(2)
    })

    it('keeps the draft and its input when the workspace action cannot create a session', async () => {
      mocks.getProviderAuthStatus.mockResolvedValue({ hasAuth: false, source: 'none' })
      useUIStore.getState().startNewSessionDraft('/workspace/project')
      const draft = useUIStore.getState().newSessionDraft!
      render(<EmptySession draftRevision={draft.revision} initialWorkDir="/workspace/project" />)
      setComposerText('keep this draft', 'keep this draft'.length)

      act(() => useUIStore.getState().requestDraftWorkspace('toggle-side'))

      await waitFor(() => expect(useUIStore.getState().toasts.length).toBeGreaterThan(0))
      expect(useUIStore.getState().draftWorkspaceRequest).toMatchObject({
        action: 'toggle-side',
        revision: draft.revision,
      })
      expect(mocks.createSession).not.toHaveBeenCalled()
      expect(useUIStore.getState().newSessionDraft).not.toBeNull()
      expect(getComposerText()).toBe('keep this draft')
      expect(useWorkspaceStore.getState().bySession).toEqual({})
    })

    it('assigns only one session when the workspace control is pressed twice', async () => {
      mocks.createSession.mockResolvedValue({ sessionId: 'double-click-session' })
      useUIStore.getState().startNewSessionDraft('/workspace/project')
      const draft = useUIStore.getState().newSessionDraft!
      render(<EmptySession draftRevision={draft.revision} initialWorkDir="/workspace/project" />)

      act(() => {
        useUIStore.getState().requestDraftWorkspace('toggle-side')
        useUIStore.getState().requestDraftWorkspace('toggle-side')
      })

      await waitFor(() => {
        expect(useWorkspaceStore.getState().getSession('double-click-session').layout).toBe('split')
      })
      expect(mocks.createSession).toHaveBeenCalledTimes(1)
    })

    it('preserves draft after a second workspace click while session creation is pending', async () => {
      let complete!: (value: { sessionId: string }) => void
      mocks.createSession.mockImplementationOnce(() => new Promise((resolve) => { complete = resolve }))
      useUIStore.getState().startNewSessionDraft('/workspace/project')
      const draft = useUIStore.getState().newSessionDraft!
      render(<EmptySession draftRevision={draft.revision} initialWorkDir="/workspace/project" />)
      setComposerText('must preserve this input', 'must preserve this input'.length)
      act(() => useUIStore.getState().requestDraftWorkspace('toggle-side'))
      await waitFor(() => expect(mocks.createSession).toHaveBeenCalledTimes(1))
      act(() => useUIStore.getState().requestDraftWorkspace('toggle-side'))
      await act(async () => complete({ sessionId: 'twice-session' }))
      expect(mocks.createSession).toHaveBeenCalledTimes(1)
      expect(useWorkspaceStore.getState().getSession('twice-session').layout).toBe('split')
      expect(useUIStore.getState().newSessionDraft).toBeNull()
      expect(useChatStore.getState().sessions['twice-session']?.composerPrefill?.text).toBe('must preserve this input')
    })

    it('preserves typing while workspace creation is pending', async () => {
      let complete!: (value: { sessionId: string }) => void
      mocks.createSession.mockImplementationOnce(() => new Promise((resolve) => { complete = resolve }))
      useUIStore.getState().startNewSessionDraft('/workspace/project')
      const draft = useUIStore.getState().newSessionDraft!
      render(<EmptySession draftRevision={draft.revision} initialWorkDir="/workspace/project" />)
      setComposerText('first input', 'first input'.length)
      act(() => useUIStore.getState().requestDraftWorkspace('toggle-side'))
      await waitFor(() => expect(mocks.createSession).toHaveBeenCalledTimes(1))
      expect(getComposerElement()).toHaveAttribute('contenteditable', 'true')
      setComposerText('first input plus more', 'first input plus more'.length)
      expect(getComposerText()).toBe('first input plus more')
      await act(async () => complete({ sessionId: 'typing-session' }))
      expect(useUIStore.getState().newSessionDraft).toBeNull()
      expect(useChatStore.getState().sessions['typing-session']?.composerPrefill?.text).toBe('first input plus more')
    })

    it('does not report into a draft it does not belong to', () => {
      useUIStore.getState().startNewSessionDraft('')
      const draft = useUIStore.getState().newSessionDraft!
      render(<EmptySession draftRevision={draft.revision + 1} />)
      setComposerText('typed elsewhere', 15)
      expect(useUIStore.getState().newSessionDraft).toBe(draft)
    })

    // Run is enabled with only a project chosen, so a draft without a word in
    // it can be on its way while "New session" is clicked for another project.
    // Moving it then would aim the launch at the wrong repository: the send
    // keeps the project it started with, the controls would answer for the new one.
    it('is not empty while it is being sent, so "New session" cannot move it to another project mid-send', async () => {
      let resolveAuth!: (status: { hasAuth: boolean; source: string }) => void
      mocks.getProviderAuthStatus.mockImplementationOnce(() => new Promise((resolve) => { resolveAuth = resolve }))
      mocks.createSession.mockResolvedValue({ sessionId: 'sending-draft-session' })
      useUIStore.getState().startNewSessionDraft('/workspace/project')
      const draft = useUIStore.getState().newSessionDraft!
      render(<EmptySession draftRevision={draft.revision} initialWorkDir="/workspace/project" />)
      const runButton = screen.getByRole('button', { name: /Run/i })
      await waitFor(() => expect(runButton).not.toBeDisabled())
      expect(useUIStore.getState().newSessionDraft?.hasContent).toBe(false)

      fireEvent.click(runButton)
      await waitFor(() => expect(useUIStore.getState().newSessionDraft?.hasContent).toBe(true))
      // "New session" for another project while the send waits for its credentials check.
      act(() => { useUIStore.getState().startNewSessionDraft('/workspace/other') })
      expect(useUIStore.getState().newSessionDraft).toMatchObject({ revision: draft.revision, workDir: '/workspace/project' })

      resolveAuth({ hasAuth: true, source: 'env' })
      await waitFor(() => {
        expect(mocks.createSession).toHaveBeenCalledWith(expect.objectContaining({ workDir: '/workspace/project' }))
      })
      expect(mocks.createSession).toHaveBeenCalledTimes(1)
    })

    it('moves to the project it is sent to in place, keeping its mode, permission and model', async () => {
      mocks.createSession.mockResolvedValue({ sessionId: 'moved-draft-session' })
      useSettingsStore.setState({ leanModeEnabled: true })
      useSessionRuntimeStore.getState().setSelection('__draft__', { providerId: 'provider-explicit', modelId: 'model-explicit' })
      useUIStore.getState().startNewSessionDraft('')
      const draft = useUIStore.getState().newSessionDraft!
      const { rerender } = render(<EmptySession draftRevision={draft.revision} initialWorkDir="" visible={false} />)
      chooseMode('Lean')
      // The mocked selector picks Auto.
      fireEvent.click(screen.getByRole('button', { name: 'Permission mode: default' }))
      const composer = getComposerElement()

      // What ContentRouter renders once "New session" moved the empty draft.
      rerender(<EmptySession draftRevision={draft.revision} initialWorkDir="/workspace/project" visible />)

      expect(getComposerElement()).toBe(composer)
      expect(await screen.findByRole('button', { name: 'Location: project / main' })).toBeInTheDocument()
      expect(screen.getByTestId('agent-profile-chip')).toHaveTextContent('Lean')
      expect(screen.getByRole('button', { name: 'Permission mode: auto' })).toBeInTheDocument()

      setComposerText('work here', 9)
      const runButton = screen.getByRole('button', { name: /Run/i })
      await waitFor(() => expect(runButton).not.toBeDisabled())
      fireEvent.click(runButton)
      await waitFor(() => {
        expect(mocks.createSession).toHaveBeenCalledWith({
          workDir: '/workspace/project',
          repository: { branch: 'main', worktree: false },
          permissionMode: 'auto',
          agentProfile: 'lean',
        })
      })
      expect(useSessionRuntimeStore.getState().selections['moved-draft-session']).toEqual({
        providerId: 'provider-explicit',
        modelId: 'model-explicit',
      })
    })

    it('keeps its own project in the draft seed when the user picks one', async () => {
      useUIStore.getState().startNewSessionDraft('')
      const draft = useUIStore.getState().newSessionDraft!
      render(<EmptySession draftRevision={draft.revision} />)
      await pickProject()
      expect(useUIStore.getState().newSessionDraft).toMatchObject({ revision: draft.revision, workDir: '/workspace/project' })
    })

    it('leaves the draft seed alone when it is not the draft', async () => {
      useUIStore.getState().startNewSessionDraft('/workspace/draft')
      const draft = useUIStore.getState().newSessionDraft
      render(<EmptySession />)
      await pickProject()
      expect(useUIStore.getState().newSessionDraft).toBe(draft)
    })
  })

  // A draft can wait for hours now. The server switches the checkout to any
  // launch branch that is not the current one, so a branch chosen for the user
  // when the draft was first read must not be sent as if they had asked for it.
  describe('launch branch freshness', () => {
    function twoBranchContext(currentBranch: 'main' | 'feature-x'): RepositoryContextResult {
      return okRepositoryContext({
        currentBranch,
        branches: (['main', 'feature-x'] as const).map((name) => ({
          name,
          current: name === currentBranch,
          local: true,
          remote: false,
          checkedOut: name === currentBranch,
          worktreePath: name === currentBranch ? '/workspace/project' : undefined,
        })),
      })
    }

    async function sendFrom(text: string) {
      setComposerText(text, text.length)
      const runButton = screen.getByRole('button', { name: /Run/i })
      await waitFor(() => expect(runButton).not.toBeDisabled())
      fireEvent.click(runButton)
    }

    it('follows the checkout when the draft comes back after the repository moved', async () => {
      mocks.createSession.mockResolvedValue({ sessionId: 'moved-checkout-session' })
      mocks.getRepositoryContext.mockResolvedValue(twoBranchContext('main'))
      const { rerender } = render(<EmptySession initialWorkDir="/workspace/project" />)
      expect(await screen.findByRole('button', { name: 'Location: project / main' })).toBeInTheDocument()

      rerender(<EmptySession initialWorkDir="/workspace/project" visible={false} />)
      mocks.getRepositoryContext.mockResolvedValue(twoBranchContext('feature-x'))
      rerender(<EmptySession initialWorkDir="/workspace/project" visible />)
      expect(await screen.findByRole('button', { name: 'Location: project / feature-x' })).toBeInTheDocument()

      await sendFrom('continue here')
      await waitFor(() => {
        expect(mocks.createSession).toHaveBeenCalledWith({
          workDir: '/workspace/project',
          repository: { branch: 'feature-x', worktree: false },
          permissionMode: 'default',
        })
      })
    })

    it('reads the checkout again at send time for a branch chosen automatically', async () => {
      mocks.createSession.mockResolvedValue({ sessionId: 'send-time-checkout-session' })
      mocks.getRepositoryContext.mockResolvedValue(twoBranchContext('main'))
      render(<EmptySession initialWorkDir="/workspace/project" />)
      expect(await screen.findByRole('button', { name: 'Location: project / main' })).toBeInTheDocument()

      // Switched in a terminal while the page stayed open.
      mocks.getRepositoryContext.mockResolvedValue(twoBranchContext('feature-x'))
      await sendFrom('continue here')
      await waitFor(() => {
        expect(mocks.createSession).toHaveBeenCalledWith({
          workDir: '/workspace/project',
          repository: { branch: 'feature-x', worktree: false },
          permissionMode: 'default',
        })
      })
    })

    it('keeps a branch the user picked while the draft was hidden, and sends it', async () => {
      mocks.createSession.mockResolvedValue({ sessionId: 'picked-branch-session' })
      mocks.getRepositoryContext.mockResolvedValue(twoBranchContext('main'))
      const { rerender } = render(<EmptySession initialWorkDir="/workspace/project" />)
      fireEvent.click(await screen.findByRole('button', { name: 'Location: project / main' }))
      fireEvent.click(await screen.findByRole('menuitem', { name: /Branch/ }))
      fireEvent.click(await screen.findByRole('option', { name: /feature-x/ }))
      fireEvent.keyDown(document, { key: 'Escape' })
      expect(await screen.findByRole('button', { name: 'Location: project / feature-x' })).toBeInTheDocument()

      rerender(<EmptySession initialWorkDir="/workspace/project" visible={false} />)
      const reads = mocks.getRepositoryContext.mock.calls.length
      rerender(<EmptySession initialWorkDir="/workspace/project" visible />)
      await waitFor(() => expect(mocks.getRepositoryContext.mock.calls.length).toBeGreaterThan(reads))
      expect(screen.getByRole('button', { name: 'Location: project / feature-x' })).toBeInTheDocument()

      await sendFrom('work on the feature')
      await waitFor(() => {
        expect(mocks.createSession).toHaveBeenCalledWith({
          workDir: '/workspace/project',
          repository: { branch: 'feature-x', worktree: false },
          permissionMode: 'default',
        })
      })
    })
  })

  describe('voice input', () => {
    let finishTranscription: (text: string) => void
    let activeRecording: { getLevel: () => number; stop: ReturnType<typeof vi.fn>; cancel: ReturnType<typeof vi.fn> }

    beforeEach(() => {
      activeRecording = {
        getLevel: () => 0,
        stop: vi.fn(async () => ({ wav: new Blob(['wav']), seconds: 2 })),
        cancel: vi.fn(),
      }
      mocks.voiceSupported.mockReturnValue(true)
      useVoiceInputStore.setState({
        catalog: {
          supported: true,
          providers: [{
            info: { id: 'sensevoice-local', name: 'SenseVoice', location: 'local', languages: ['auto', 'zh'] },
            preparation: { phase: 'ready' },
          }],
          preferences: { enabled: true, providerId: 'sensevoice-local', language: 'zh', downloadSource: 'auto' },
          limits: { maxAudioSeconds: 60, maxAudioBytes: 1_000_000 },
        },
      })
      mocks.voiceStartRecording.mockImplementation(async () => activeRecording)
      mocks.voiceTranscribe.mockImplementation(() => new Promise((resolve) => {
        finishTranscription = (text) => resolve({ text, audioSeconds: 2, inferenceSeconds: 0.1 })
      }))
      // Voice input exists only in the desktop app (the outer beforeEach resets this).
      mocks.isTauriRuntime = true
      // jsdom has no canvas; the recording bar's trace draws nothing without one.
      vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
    })

    async function dictate() {
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /^Dictate( \(.+\))?$/ }))
      })
      await act(async () => {
        fireEvent.click(await screen.findByRole('button', { name: 'Stop recording and transcribe' }))
      })
      await screen.findByRole('button', { name: 'Transcribing…' })
    }

    it('puts the microphone between the model picker and the send button', () => {
      render(<EmptySession />)

      const model = screen.getByTestId('model-selector')
      const voice = screen.getByTestId('voice-input')
      const run = screen.getByRole('button', { name: 'Run' })
      expect(model.nextElementSibling).toBe(voice)
      expect(voice.nextElementSibling).toBe(run)
    })

    it('keeps the microphone right after the model picker when the lean mode is enabled', () => {
      useSettingsStore.setState({ leanModeEnabled: true })
      render(<EmptySession />)

      const model = screen.getByTestId('model-selector')
      const voice = screen.getByTestId('voice-input')
      const run = screen.getByRole('button', { name: 'Run' })
      expect(model.nextElementSibling).toBe(voice)
      expect(voice.nextElementSibling).toBe(run)
    })

    it('does not render the microphone until dictation is ready', () => {
      mocks.voiceSupported.mockReturnValue(false)
      render(<EmptySession />)
      expect(screen.queryByTestId('voice-input')).toBeNull()
    })

    it('does not render the microphone in the browser (H5)', () => {
      mocks.isTauriRuntime = false
      render(<EmptySession />)
      expect(screen.queryByTestId('voice-input')).toBeNull()
    })

    it('writes dictated text at the caret without starting a session', async () => {
      render(<EmptySession />)
      setComposerText('ab', 1)
      vi.spyOn(getComposerView(), 'hasFocus').mockReturnValue(true)
      setComposerSelection(1)

      await dictate()
      await act(async () => {
        finishTranscription('你好')
      })

      expect(getComposerText()).toBe('a你好b')
      expect(mocks.createSession).not.toHaveBeenCalled()
    })

    it('starts the session with the dictated text when sent from the recording bar', async () => {
      render(<EmptySession />)
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /^Dictate( \(.+\))?$/ }))
      })
      // The bar takes the toolbar's row: its controls, Run included, are hidden.
      expect(screen.getByTestId('voice-recording-bar')).toBeVisible()
      expect(screen.queryByRole('button', { name: 'Run' })).toBeNull()

      await act(async () => {
        fireEvent.click(await screen.findByRole('button', { name: 'Transcribe and send' }))
      })
      expect(mocks.createSession).not.toHaveBeenCalled()
      await act(async () => {
        finishTranscription('你好')
      })

      await waitFor(() => {
        expect(mocks.wsSend).toHaveBeenCalledWith('draft-session', {
          type: 'user_message',
          content: '你好',
          attachments: [],
        })
      })
    })

    it('keeps the text aside when the draft was edited while it was being recognised', async () => {
      render(<EmptySession />)
      setComposerText('hello', 5)

      await dictate()
      setComposerText('hello there', 11)
      await act(async () => {
        finishTranscription('dictated')
      })

      expect(getComposerText()).toBe('hello there')
      expect(screen.getByTestId('voice-input-pending-text')).toHaveTextContent('dictated')
    })

    it('holds a result that arrives during an IME composition in the composer', async () => {
      render(<EmptySession />)
      await dictate()

      fireEvent.compositionStart(getComposerElement())
      await act(async () => {
        finishTranscription('你好')
      })

      expect(getComposerText()).toBe('')
      expect(screen.getByTestId('voice-input-pending-text')).toHaveTextContent('你好')
    })

    it('releases the microphone when the page is left mid-recording', async () => {
      const { unmount } = render(<EmptySession />)
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /^Dictate( \(.+\))?$/ }))
      })
      await screen.findByRole('button', { name: 'Stop recording and transcribe' })

      unmount()

      expect(activeRecording.cancel).toHaveBeenCalledTimes(1)
    })
  })

})
