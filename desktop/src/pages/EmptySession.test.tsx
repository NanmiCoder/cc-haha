import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom'

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

vi.mock('../api/skills', () => ({
  skillsApi: {
    list: mocks.listSkills,
  },
}))

vi.mock('../api/composerReferences', () => ({
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

vi.mock('../components/controls/PermissionModeSelector', () => ({
  PermissionModeSelector: ({ compact, value, onChange }: { compact?: boolean; value?: string; onChange?: (mode: string) => void }) => (
    <button
      type="button"
      data-testid="permission-mode-selector"
      data-compact={compact ? 'true' : 'false'}
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
    ModelSelector: React.forwardRef<{ open: () => void }, { compact?: boolean }>(({ compact }, ref) => {
      const [open, setOpen] = React.useState(false)
      React.useImperativeHandle(ref, () => ({ open: () => setOpen(true) }), [])
      return (
        <>
          <button type="button" data-testid="model-selector" data-compact={compact ? 'true' : 'false'}>
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
import { usePluginStore } from '../stores/pluginStore'
import { useWorkflowStore } from '../stores/workflowStore'
import type { RepositoryContextResult } from '../api/sessions'
import { browserHost } from '../lib/desktopHost/browserHost'
import { getComposerElement, getComposerText, setComposerText } from '../components/chat/composerTestUtils'

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

describe('EmptySession', () => {
  const initialSessionState = useSessionStore.getInitialState()
  const initialChatState = useChatStore.getInitialState()
  const initialTabState = useTabStore.getInitialState()
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
    useSettingsStore.setState({ locale: 'en', activeProviderName: null, permissionMode: 'default' })
    useSessionStore.setState(initialSessionState, true)
    useChatStore.setState(initialChatState, true)
    useTabStore.setState(initialTabState, true)
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
    useSessionRuntimeStore.setState(initialRuntimeState, true)
    useUIStore.setState(initialUiState, true)
    usePluginStore.setState(initialPluginState, true)
    useProviderStore.setState(initialProviderState, true)
    useWorkflowStore.setState(initialWorkflowState, true)
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
    expect(screen.getByTestId('empty-session-composer-panel')).toHaveClass('rounded-[var(--radius-2xl)]')
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
    setComposerText('/', 1)
    expect(await screen.findByText('old-directory-skill')).toBeInTheDocument()
    await pickProject()
    setComposerText('/', 1)
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

    setComposerText('/', 1)

    const listbox = await screen.findByRole('listbox', { name: 'Slash commands' })
    const combobox = screen.getByRole('combobox')
    const systemCommand = screen.getByText('mcp')
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

    const agentOption = await screen.findByText('agent debugger')
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

    await screen.findByText('agent debugger')
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
    // 20px corner and the middle shadow step — the composer's own place on the
    // handoff's scale. The repository controls live inside this panel, so it
    // must stay a single rounded block rather than a split top/bottom pair.
    expect(panel).toHaveClass('rounded-[var(--radius-2xl)]', 'p-0', 'glass-panel--composer')
    expect(panel).not.toHaveClass('rounded-b-none')

    await pickProject()

    const pill = await screen.findByRole('button', { name: 'Location: project / main' })
    expect(panel).toContainElement(pill)
    expect(pill).toHaveClass('h-9')

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
        model1mSupport: { main: enabled, haiku: enabled, sonnet: enabled, opus: enabled },
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
      effortLevel: 'max',
    })
    expect(mocks.wsSend.mock.calls.slice(0, 3)).toEqual([
      [
        'draft-session',
        {
          type: 'set_runtime_config',
          providerId: 'provider-minimax',
          modelId: enabled ? 'MiniMax-M3[1m]' : 'MiniMax-M3',
          effortLevel: 'max',
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

    fireEvent.click(screen.getByLabelText('Open composer tools'))
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

    setComposerText('/', 1)
    expect(await screen.findByText('mcp')).toBeInTheDocument()
    expect(panel).toHaveClass('overflow-visible')
    expect(panel).not.toHaveClass('overflow-hidden')

    setComposerText('@readme', 7)
    expect(await screen.findByText('README.md')).toBeInTheDocument()
    expect(panel).toHaveClass('overflow-visible')
    expect(panel).not.toHaveClass('overflow-hidden')
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

  it('keeps current worktree selectable when the fallback branch is checked out elsewhere', async () => {
    mocks.getRepositoryContext.mockResolvedValueOnce(okRepositoryContext({
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
    }))

    render(<EmptySession />)

    setComposerText('draft question', 14)
    await pickProject()

    await waitFor(() => {
      expect(screen.getByText('main')).toBeInTheDocument()
    })

    const warning = screen.getByRole('status', {
      name: 'Selected branch is already checked out in another worktree. Direct launch may be blocked by Git; use "Isolated worktree" to avoid changing directories.',
    })
    expect(warning).toHaveTextContent('Branch already checked out')
    expect(warning).toHaveAttribute(
      'title',
      'Selected branch is already checked out in another worktree. Direct launch may be blocked by Git; use "Isolated worktree" to avoid changing directories.',
    )

    // Staying on the current worktree has to remain a live choice even when the
    // fallback branch is checked out elsewhere — it must not render disabled.
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
})
