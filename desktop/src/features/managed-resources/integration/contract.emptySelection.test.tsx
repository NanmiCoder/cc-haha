/**
 * M6-A no-selection contract — the regression the picker could have introduced.
 *
 * Both composers now mount a managed-resources controller. With nothing
 * selected they must still be the composers they were before: the same send
 * path, invoked exactly once with the typed text, and no dependency the picker
 * owns touched on the way out — no host/concept catalog read beyond the
 * mount-time load, no credential vault decrypt, no conversation-context write,
 * and no extra WebSocket connect or frame.
 *
 * Driven through the real `ChatInput` / `EmptySession` over a real
 * managed-resources host (`createConceptHarness`), so the "nothing extra
 * happened" claim is measured against the same objects the feature uses.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import '@testing-library/jest-dom'

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  delete: vi.fn(),
  list: vi.fn(),
  getMessages: vi.fn(),
  getGitInfo: vi.fn(),
  getSlashCommands: vi.fn(),
  listAgents: vi.fn(),
  listSkills: vi.fn(),
  getRepositoryContext: vi.fn(),
  createRepositoryBranch: vi.fn(),
  getRecentProjects: vi.fn(),
  search: vi.fn(),
  browse: vi.fn(),
  getTasksForList: vi.fn(),
  resetTaskList: vi.fn(),
  getProviderAuthStatus: vi.fn(),
  wsSend: vi.fn(),
  wsConnect: vi.fn(),
  wsDisconnect: vi.fn(),
  wsClearHandlers: vi.fn(),
  wsOnMessage: vi.fn(),
  dialogOpen: vi.fn(),
  webviewDragHandlers: [] as Array<(event: { payload: unknown }) => void>,
  webviewUnlisten: vi.fn(),
  isMobile: false,
  isTauriRuntime: false,
}))

vi.mock('../../../api/sessions', () => ({
  sessionsApi: {
    create: mocks.create,
    delete: mocks.delete,
    list: mocks.list,
    getMessages: mocks.getMessages,
    getGitInfo: mocks.getGitInfo,
    getSlashCommands: mocks.getSlashCommands,
    getRepositoryContext: mocks.getRepositoryContext,
    createRepositoryBranch: mocks.createRepositoryBranch,
    getRecentProjects: mocks.getRecentProjects,
  },
}))
vi.mock('../../../api/agents', () => ({ agentsApi: { list: mocks.listAgents } }))
vi.mock('../../../api/skills', () => ({ skillsApi: { list: mocks.listSkills } }))
vi.mock('../../../api/providers', () => ({ providersApi: { authStatus: mocks.getProviderAuthStatus } }))
vi.mock('../../../api/filesystem', () => ({
  filesystemApi: { search: mocks.search, browse: mocks.browse },
}))
vi.mock('../../../api/cliTasks', () => ({
  cliTasksApi: { getTasksForList: mocks.getTasksForList, resetTaskList: mocks.resetTaskList },
}))
vi.mock('../../../api/websocket', () => ({
  wsManager: {
    clearHandlers: mocks.wsClearHandlers,
    connect: mocks.wsConnect,
    disconnect: mocks.wsDisconnect,
    onConnectionState: vi.fn((_sessionId: string, handler: (state: string) => void) => {
      handler('connected')
      return () => {}
    }),
    onMessage: mocks.wsOnMessage,
    send: mocks.wsSend,
  },
}))
vi.mock('../../../hooks/useMobileViewport', () => ({ useMobileViewport: () => mocks.isMobile }))
vi.mock('../../../lib/desktopRuntime', () => ({
  isTauriRuntime: () => mocks.isTauriRuntime,
  isDesktopRuntime: () => mocks.isTauriRuntime,
}))
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: mocks.dialogOpen }))
vi.mock('@tauri-apps/api/webview', () => ({
  getCurrentWebview: () => ({
    onDragDropEvent: vi.fn(async (handler: (event: { payload: unknown }) => void) => {
      mocks.webviewDragHandlers.push(handler)
      return mocks.webviewUnlisten
    }),
  }),
}))
vi.mock('@/components/composite/DirectoryPicker', () => ({
  RecentProjectsPanel: ({ onSelect }: { onSelect: (path: string) => void }) => (
    <button type="button" aria-label="Pick project" onClick={() => onSelect('/workspace/project')}>
      Pick project
    </button>
  ),
}))
vi.mock('../../../components/controls/PermissionModeSelector', () => ({
  PermissionModeSelector: ({ value }: { value?: string }) => (
    <button type="button" data-testid="permission-mode-selector">
      {value ?? 'default'}
    </button>
  ),
}))
vi.mock('../../../components/controls/ModelSelector', async () => {
  const React = await vi.importActual<typeof import('react')>('react')
  return {
    ModelSelector: React.forwardRef<{ open: () => void }, { compact?: boolean }>((_props, ref) => {
      const [open, setOpen] = React.useState(false)
      React.useImperativeHandle(ref, () => ({ open: () => setOpen(true) }), [])
      return (
        <div data-testid="model-selector-shell">
          <button type="button">Model</button>
          {open && <div data-testid="model-selector-dropdown">Model selector opened</div>}
        </div>
      )
    }),
  }
})

import { ChatInput } from '../../../components/chat/ChatInput'
import { getComposerElement, getComposerText, setComposerText } from '../../../components/chat/composerTestUtils'
import { EmptySession } from '../../../pages/EmptySession'
import { useChatStore } from '../../../stores/chatStore'
import { usePluginStore } from '../../../stores/pluginStore'
import { useProviderStore } from '../../../stores/providerStore'
import { useSessionRuntimeStore } from '../../../stores/sessionRuntimeStore'
import { useSessionStore } from '../../../stores/sessionStore'
import { useSettingsStore } from '../../../stores/settingsStore'
import { useTabStore } from '../../../stores/tabStore'
import { useUIStore } from '../../../stores/uiStore'
import { useWorkflowStore } from '../../../stores/workflowStore'
import { createConceptHarness, type ConceptHarness } from '../../../test/conceptKnowledgeHarness'
import { useContextSelectionStore, resetContextSelectionStore } from '../stores/contextSelectionStore'

const SESSION_ID = 'session-empty-selection'
const TYPED_TEXT = 'plain question with no context selection'

type CallCounts = {
  listHosts: number
  listConcepts: number
  listTags: number
  revealCredential: number
  vaultEncrypt: number
  vaultDecrypt: number
  contextGet: number
  contextSave: number
  wsConnect: number
  wsOnMessage: number
  sessionsCreate: number
}

function sessionState(): ReturnType<typeof useChatStore.getState>['sessions'] {
  return {
    [SESSION_ID]: {
      messages: [{ id: 'existing', type: 'assistant_text', content: 'ready', timestamp: 1 }],
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
      elapsedTimer: null,
    },
  }
}

describe('M6-A no-selection contract', () => {
  let harness: ConceptHarness
  let spies: {
    listHosts: MockInstance
    listConcepts: MockInstance
    listTags: MockInstance
    revealCredential: MockInstance
    vaultEncrypt: MockInstance
    vaultDecrypt: MockInstance
    contextGet: MockInstance
    contextSave: MockInstance
  }

  const initialChatState = useChatStore.getInitialState()
  const initialSessionState = useSessionStore.getInitialState()
  const initialTabState = useTabStore.getInitialState()
  const initialRuntimeState = useSessionRuntimeStore.getInitialState()
  const initialUiState = useUIStore.getInitialState()
  const initialPluginState = usePluginStore.getInitialState()
  const initialProviderState = useProviderStore.getInitialState()
  const initialWorkflowState = useWorkflowStore.getInitialState()

  beforeEach(async () => {
    vi.clearAllMocks()
    mocks.isMobile = false
    mocks.isTauriRuntime = false

    useSettingsStore.setState({ locale: 'en', activeProviderName: null, permissionMode: 'default' })
    useChatStore.setState(initialChatState, true)
    useSessionStore.setState(initialSessionState, true)
    useTabStore.setState(initialTabState, true)
    useSessionRuntimeStore.setState(initialRuntimeState, true)
    useUIStore.setState(initialUiState, true)
    usePluginStore.setState(initialPluginState, true)
    useProviderStore.setState(initialProviderState, true)
    useWorkflowStore.setState(initialWorkflowState, true)

    mocks.getRepositoryContext.mockResolvedValue({
      state: 'ok',
      workDir: '/workspace/project',
      repoRoot: '/workspace/project',
      repoName: 'project',
      currentBranch: 'main',
      defaultBranch: 'main',
      dirty: false,
      branches: [],
      worktrees: [],
    })
    mocks.getGitInfo.mockResolvedValue({ branch: 'main', repoName: 'project', workDir: '/workspace/project', changedFiles: 0 })
    mocks.getRecentProjects.mockResolvedValue({ projects: [] })
    mocks.create.mockResolvedValue({ sessionId: 'created-session', workDir: '/workspace/project' })
    mocks.delete.mockResolvedValue({ ok: true })
    mocks.list.mockResolvedValue({ sessions: [], total: 0 })
    mocks.getMessages.mockResolvedValue({ messages: [] })
    mocks.getSlashCommands.mockResolvedValue({ commands: [] })
    mocks.listSkills.mockResolvedValue({ skills: [] })
    mocks.listAgents.mockResolvedValue({ activeAgents: [], allAgents: [] })
    mocks.getProviderAuthStatus.mockResolvedValue({ hasAuth: true, source: 'cc-haha-provider' })
    mocks.search.mockResolvedValue({ currentPath: '/workspace/project', parentPath: null, query: '', entries: [] })
    mocks.getTasksForList.mockResolvedValue({ tasks: [] })

    // jsdom does not implement the layout APIs ProseMirror reads.
    Object.defineProperties(Range.prototype, {
      getClientRects: { configurable: true, value: () => [] },
      getBoundingClientRect: {
        configurable: true,
        value: () => ({
          x: 0, y: 0, top: 0, right: 0, bottom: 0, left: 0, width: 0, height: 0, toJSON: () => ({}),
        }),
      },
    })
    Element.prototype.scrollIntoView = vi.fn()

    harness = await createConceptHarness('mr-empty-selection-')
    resetContextSelectionStore()

    // A non-empty catalog, so "the picker read nothing and sent nothing" is not
    // an accident of there being nothing to read.
    await harness.services.libService.createHost({
      name: 'web-1',
      address: 'web-1.internal',
      port: 22,
      username: 'deploy',
      auth: { type: 'password', credentialId: null },
      tagIds: [],
      initialDirectory: null,
      applications: [],
      notes: '',
    })
    await harness.seedConcept({
      title: 'Deployment topology',
      summary: 'How the service is deployed',
      bodyMarkdown: 'How the service is deployed',
      tagIds: [],
      dependsOnIds: [],
      referenceIds: [],
    })

    spies = {
      listHosts: vi.spyOn(harness.host.hostManagement, 'listHosts'),
      listConcepts: vi.spyOn(harness.host.conceptKnowledge, 'listConcepts'),
      listTags: vi.spyOn(harness.host.hostManagement, 'listTags'),
      revealCredential: vi.spyOn(harness.host.hostManagement, 'revealCredential'),
      vaultEncrypt: vi.spyOn(harness.services.vault, 'encrypt'),
      vaultDecrypt: vi.spyOn(harness.services.vault, 'decrypt'),
      contextGet: vi.spyOn(harness.host.conversationContext, 'getSelection'),
      contextSave: vi.spyOn(harness.host.conversationContext, 'saveSelection'),
    }

    useTabStore.setState({
      activeTabId: SESSION_ID,
      tabs: [{ sessionId: SESSION_ID, title: 'Project', type: 'session', status: 'idle' }],
    })
    useSessionStore.setState({
      sessions: [{
        id: SESSION_ID,
        title: 'Project',
        createdAt: '2026-05-01T00:00:00.000Z',
        modifiedAt: '2026-05-01T00:00:00.000Z',
        messageCount: 1,
        projectPath: '/workspace/project',
        workDir: '/workspace/project',
        workDirExists: true,
      }],
      activeSessionId: SESSION_ID,
    })
    useChatStore.setState({ sessions: sessionState() })
  })

  afterEach(async () => {
    // Unmount before touching the stores: a reset while the picker is still
    // mounted re-renders it outside `act`.
    cleanup()
    for (const spy of Object.values(spies ?? {})) spy.mockRestore()
    resetContextSelectionStore()
    await harness.dispose()
    useChatStore.setState(initialChatState, true)
    useSessionStore.setState(initialSessionState, true)
    useTabStore.setState(initialTabState, true)
    useSessionRuntimeStore.setState(initialRuntimeState, true)
    useUIStore.setState(initialUiState, true)
    usePluginStore.setState(initialPluginState, true)
    useProviderStore.setState(initialProviderState, true)
    useWorkflowStore.setState(initialWorkflowState, true)
  })

  /** Every dependency the picker owns, counted on the real objects. */
  const dependencyCounts = (): CallCounts => ({
    listHosts: spies.listHosts.mock.calls.length,
    listConcepts: spies.listConcepts.mock.calls.length,
    listTags: spies.listTags.mock.calls.length,
    revealCredential: spies.revealCredential.mock.calls.length,
    vaultEncrypt: spies.vaultEncrypt.mock.calls.length,
    vaultDecrypt: spies.vaultDecrypt.mock.calls.length,
    contextGet: spies.contextGet.mock.calls.length,
    contextSave: spies.contextSave.mock.calls.length,
    wsConnect: mocks.wsConnect.mock.calls.length,
    wsOnMessage: mocks.wsOnMessage.mock.calls.length,
    sessionsCreate: mocks.create.mock.calls.length,
  })

  const userMessageFrames = () =>
    mocks.wsSend.mock.calls.filter(
      ([, payload]) => (payload as { type?: string } | undefined)?.type === 'user_message',
    )

  /**
   * `loadCatalog` writes all four lists in a single store update, so a populated
   * catalog is the proof that every mount-time dependency call has settled.
   */
  const settleCatalog = async () => {
    await waitFor(() => {
      const state = useContextSelectionStore.getState()
      expect(state.catalog.hosts).toHaveLength(1)
      expect(state.catalog.concepts).toHaveLength(1)
    })
    await act(async () => {})
  }

  const expectNothingSelected = () => {
    const controller = useContextSelectionStore.getState()
    expect(controller.hasSelection()).toBe(false)
    expect(controller.pick.sourceTags).toEqual([])
    expect(controller.pick.directIds).toEqual([])
    const snapshot = controller.snapshot()
    expect(snapshot.sourceTags).toEqual([])
    expect(snapshot.directIds).toEqual([])
    expect(snapshot.resolved).toEqual({
      host: [],
      concept: [],
      database: [],
      redis: [],
      dataConnection: [],
    })
    // The picker is present and visibly empty: a zero count, not a missing UI.
    expect(screen.getByTestId('context-entry-host-count')).toHaveTextContent('0')
    expect(screen.getByTestId('context-entry-concept-count')).toHaveTextContent('0')
    expect(screen.getByTestId('context-entry-database-count')).toHaveTextContent('0')
    expect(screen.getByTestId('context-entry-redis-count')).toHaveTextContent('0')
  }

  /**
   * Nothing the picker owns may be touched by a send: the counts must not move,
   * and the secret-bearing paths must never have run at all. If the composer
   * grew a context branch, one of these would move by one.
   */
  const expectDependenciesUntouched = (before: CallCounts) => {
    expect(dependencyCounts()).toEqual(before)
    expect(before.revealCredential).toBe(0)
    expect(before.vaultEncrypt).toBe(0)
    expect(before.vaultDecrypt).toBe(0)
    expect(before.contextGet).toBe(0)
    expect(before.contextSave).toBe(0)
  }

  it('sends the typed text through the original path from ChatInput when nothing is selected', async () => {
    render(<ChatInput compact />)
    await settleCatalog()
    const before = dependencyCounts()

    setComposerText(TYPED_TEXT, TYPED_TEXT.length)
    fireEvent.keyDown(getComposerElement(), { key: 'Enter' })

    await waitFor(() => {
      expect(userMessageFrames()).toHaveLength(1)
    })
    // One frame, untouched payload, addressed to the active session.
    expect(userMessageFrames()[0]).toEqual([
      SESSION_ID,
      { type: 'user_message', content: TYPED_TEXT, attachments: [] },
    ])
    expect(getComposerText()).toBe('')
    expect(useChatStore.getState().sessions[SESSION_ID]?.messages.at(-1)).toMatchObject({
      type: 'user_text',
      content: TYPED_TEXT,
    })

    expectDependenciesUntouched(before)
    expectNothingSelected()
  })

  it('sends the typed text through the original path from EmptySession when nothing is selected', async () => {
    render(<EmptySession />)
    await settleCatalog()
    const before = dependencyCounts()

    setComposerText(TYPED_TEXT, TYPED_TEXT.length)
    fireEvent.keyDown(getComposerElement(), { key: 'Enter' })

    await waitFor(() => {
      expect(userMessageFrames()).toHaveLength(1)
    })
    // The home composer still creates the session and then sends into it.
    expect(mocks.create).toHaveBeenCalledTimes(1)
    expect(userMessageFrames()[0]).toEqual([
      'created-session',
      { type: 'user_message', content: TYPED_TEXT, attachments: [] },
    ])
    expect(getComposerText()).toBe('')

    // EmptySession's original path creates the session before sending, and that
    // create is what opens the socket and registers its first message handler —
    // so those three keys belong to the send, not to a context branch. Every
    // other dependency stays pinned.
    expect(dependencyCounts()).toEqual({
      ...before,
      sessionsCreate: before.sessionsCreate + 1,
      wsConnect: before.wsConnect + 1,
      wsOnMessage: before.wsOnMessage + 1,
    })
    expect(before.revealCredential).toBe(0)
    expect(before.vaultEncrypt).toBe(0)
    expect(before.vaultDecrypt).toBe(0)
    expect(before.contextGet).toBe(0)
    expect(before.contextSave).toBe(0)
    expectNothingSelected()
  })
})
