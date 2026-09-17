/**
 * M6-B contract: three send points, one prepare.
 *
 * The immediate send (`ChatInput`), the first send of a created session
 * (`EmptySession`'s create-then-send) and the queued-while-busy send must all
 * prepare the context selection exactly once and hand that one snapshot to the
 * send that carries it. A queued item keeps the snapshot it captured, so a later
 * composer edit cannot change what it sends and the flush cannot prepare — or
 * send — a second time.
 *
 * Driven through the real composers over a real managed-resources host
 * (`createConceptHarness`), like the M6-A contracts. `chatSubmission` is wrapped
 * only to count prepares: the wrapper delegates to the real implementation, so
 * nothing about its behaviour is faked.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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

// Counts prepares without replacing the implementation: the wrapper delegates to
// the module's own function, so a call count is the only thing this adds.
vi.mock('./chatSubmission', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./chatSubmission')>()
  return {
    ...actual,
    prepareManagedContextSubmission: vi.fn(actual.prepareManagedContextSubmission),
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
import { prepareManagedContextSubmission, type ManagedContextSubmission } from './chatSubmission'
import type { Host, ResourceTag } from '../types/resourceTypes'

const SESSION_ID = 'session-ticket-share'
const CREATED_SESSION_ID = 'created-session'

type ChatSessions = ReturnType<typeof useChatStore.getState>['sessions']

function sessionState(): ChatSessions {
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

describe('M6-B one prepare for three send points', () => {
  let harness: ConceptHarness
  let hostTagA: ResourceTag
  let hostTagB: ResourceTag
  let conceptTag: ResourceTag
  let hostA: Host
  let hostB: Host
  let hostC: Host
  let conceptId: string

  const initialChatState = useChatStore.getInitialState()
  const initialSessionState = useSessionStore.getInitialState()
  const initialTabState = useTabStore.getInitialState()
  const initialRuntimeState = useSessionRuntimeStore.getInitialState()
  const initialUiState = useUIStore.getInitialState()
  const initialPluginState = usePluginStore.getInitialState()
  const initialProviderState = useProviderStore.getInitialState()
  const initialWorkflowState = useWorkflowStore.getInitialState()

  const createdValue = <T,>(result: { status: string; value?: T }, label: string): T => {
    if (result.status !== 'created' || result.value === undefined) {
      throw new Error(`seed ${label} failed: ${JSON.stringify(result)}`)
    }
    return result.value
  }

  const sorted = (ids: ReadonlyArray<string>): string[] => [...ids].sort()

  const seedHost = async (name: string, tagIds: string[]): Promise<Host> => {
    const result = await harness.services.libService.createHost({
      name,
      address: `${name}.internal`,
      port: 22,
      username: 'deploy',
      auth: { type: 'password', credentialId: null },
      tagIds,
      initialDirectory: null,
      applications: [],
      notes: '',
    })
    if (result.status !== 'created') throw new Error(`seed failed: ${JSON.stringify(result)}`)
    return result.value
  }

  beforeEach(async () => {
    vi.clearAllMocks()
    mocks.isMobile = false
    mocks.isTauriRuntime = false
    mocks.wsOnMessage.mockImplementation((sessionId: string, handler: (message: unknown) => void) => {
      handler({ type: 'connected', sessionId, runtimeRevision: 1 })
      return () => {}
    })

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
    mocks.create.mockResolvedValue({ sessionId: CREATED_SESSION_ID, workDir: '/workspace/project' })
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

    harness = await createConceptHarness('mr-ticket-share-')
    resetContextSelectionStore()

    hostTagA = createdValue(await harness.services.libService.createTag({ namespace: 'host', name: '生产', colorToken: null }), 'host tag A')
    hostTagB = createdValue(await harness.services.libService.createTag({ namespace: 'host', name: '测试', colorToken: null }), 'host tag B')
    conceptTag = createdValue(await harness.services.libService.createTag({ namespace: 'concept', name: '架构', colorToken: null }), 'concept tag')

    // A hosts h1; A+B hosts h2; B hosts h3.
    hostA = await seedHost('web-1', [hostTagA.id])
    hostB = await seedHost('web-2', [hostTagA.id, hostTagB.id])
    hostC = await seedHost('web-3', [hostTagB.id])
    conceptId = (
      await harness.seedConcept({
        title: '部署架构',
        summary: 'Deployment topology',
        bodyMarkdown: 'Deployment topology',
        tagIds: [conceptTag.id],
        dependsOnIds: [],
        referenceIds: [],
      })
    ).id

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
    useChatStore.getState().handleServerMessage(SESSION_ID, {
      type: 'connected',
      sessionId: SESSION_ID,
      runtimeRevision: 1,
    })
  })

  afterEach(async () => {
    cleanup()
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

  const openEntry = async (kind: 'host' | 'concept' | 'database' | 'redis') => {
    fireEvent.click(screen.getByTestId(`context-entry-${kind}`))
    const picker = await screen.findByTestId('context-picker')
    await waitFor(() => {
      expect(within(picker).queryAllByRole('checkbox').length).toBeGreaterThan(0)
    })
    return picker
  }

  /** Flush the mount-time catalog load and any pending store update. */
  const settle = async () => {
    await act(async () => {})
  }

  const prepareSpy = () => vi.mocked(prepareManagedContextSubmission)

  const prepareCount = (): number => prepareSpy().mock.calls.length

  const userMessageFrames = () =>
    mocks.wsSend.mock.calls.filter(
      ([, payload]) => (payload as { type?: string } | undefined)?.type === 'user_message',
    ) as Array<[string, { type: string; content: string; attachments?: unknown }]>

  const queuedItems = (sessionId: string) => useChatStore.getState().sessions[sessionId]?.queuedUserMessages ?? []

  const lastUserText = (sessionId: string) => {
    const messages = useChatStore.getState().sessions[sessionId]?.messages ?? []
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index]
      if (message?.type === 'user_text') return message
    }
    return undefined
  }

  const submit = async (text: string) => {
    setComposerText(text, text.length)
    fireEvent.keyDown(getComposerElement(), { key: 'Enter' })
  }

  /**
   * The content of a prepared snapshot, normalised for comparison: member ids and
   * resolved ids are sorted (their order is the catalog's, not the contract's).
   */
  const snapshotContent = (submission: ManagedContextSubmission) => ({
    sourceTags: submission.snapshot.sourceTags.map((tag) => ({
      namespace: tag.namespace,
      id: tag.id,
      label: tag.label,
      memberIds: sorted(tag.memberIds),
    })),
    directIds: submission.snapshot.directIds.map((direct) => ({ ...direct })),
    resolved: {
      host: sorted(submission.snapshot.resolved.host),
      concept: sorted(submission.snapshot.resolved.concept),
      dataConnection: sorted(submission.snapshot.resolved.dataConnection),
    },
  })

  /** The selection both send points below pick: host tag 生产 + concept tag 架构. */
  const pickSharedSelection = async () => {
    const hostPicker = await openEntry('host')
    fireEvent.click(within(hostPicker).getByRole('checkbox', { name: /^生产/ }))
    const conceptPicker = await openEntry('concept')
    fireEvent.click(within(conceptPicker).getByRole('checkbox', { name: /^架构/ }))
  }

  const expectSharedSelection = (submission: ManagedContextSubmission) => {
    expect(snapshotContent(submission)).toEqual({
      sourceTags: [
        { namespace: 'host', id: hostTagA.id, label: '生产', memberIds: sorted([hostA.id, hostB.id]) },
        { namespace: 'concept', id: conceptTag.id, label: '架构', memberIds: [conceptId] },
      ],
      directIds: [],
      resolved: {
        host: sorted([hostA.id, hostB.id]),
        concept: [conceptId],
        dataConnection: [],
      },
    })
  }

  it('prepares one identical snapshot for the created-session, immediate and queued send points', async () => {
    // ── Send point 1: the first send of a newly created session (EmptySession).
    const home = render(<EmptySession />)
    await settle()
    await pickSharedSelection()

    const beforeFirst = prepareCount()
    await submit('first prompt')
    await waitFor(() => {
      expect(userMessageFrames()).toHaveLength(1)
    })
    expect(prepareCount() - beforeFirst).toBe(1)
    expect(userMessageFrames()[0]![0]).toBe(CREATED_SESSION_ID)
    const first = lastUserText(CREATED_SESSION_ID)?.managedContext
    expect(first).toBeDefined()
    expectSharedSelection(first!)

    home.unmount()
    await settle()
    // The turn ends through the server message that ends it, so the next send is
    // the immediate one rather than another queue entry.
    act(() => {
      useChatStore.getState().handleServerMessage(CREATED_SESSION_ID, { type: 'status', state: 'idle' })
    })

    // ── Send point 2: the immediate send from ChatInput into that session.
    render(<ChatInput compact />)
    await settle()
    const beforeImmediate = prepareCount()
    await submit('second prompt')
    await waitFor(() => {
      expect(userMessageFrames()).toHaveLength(2)
    })
    expect(prepareCount() - beforeImmediate).toBe(1)
    const second = lastUserText(CREATED_SESSION_ID)?.managedContext
    expect(second).toBeDefined()
    expectSharedSelection(second!)

    // ── Send point 3: the queued-while-busy send.
    act(() => {
      useChatStore.getState().handleServerMessage(CREATED_SESSION_ID, { type: 'status', state: 'thinking' })
    })
    const beforeQueued = prepareCount()
    await submit('third prompt')
    await waitFor(() => {
      expect(queuedItems(CREATED_SESSION_ID)).toHaveLength(1)
    })
    expect(prepareCount() - beforeQueued).toBe(1)
    const third = queuedItems(CREATED_SESSION_ID)[0]!.managedContext
    expect(third).toBeDefined()
    expectSharedSelection(third!)

    // Same content from all three send points, one identity each.
    expect(snapshotContent(second!)).toEqual(snapshotContent(first!))
    expect(snapshotContent(third!)).toEqual(snapshotContent(first!))
    expect(second).not.toBe(first)
    expect(third).not.toBe(first)
    expect(new Set([first!.submissionId, second!.submissionId, third!.submissionId]).size).toBe(3)
    expect(second!.selection).toEqual(first!.selection)
    expect(third!.selection).toEqual(first!.selection)
  })

  it('keeps the queued snapshot after the selection changes and re-uses it on flush', async () => {
    render(<ChatInput compact />)
    await settle()
    const hostPicker = await openEntry('host')
    fireEvent.click(within(hostPicker).getByRole('checkbox', { name: /^生产/ }))

    act(() => {
      useChatStore.getState().handleServerMessage(SESSION_ID, { type: 'status', state: 'thinking' })
    })
    await submit('queued prompt')
    await waitFor(() => {
      expect(queuedItems(SESSION_ID)).toHaveLength(1)
    })

    const queued = queuedItems(SESSION_ID)[0]!
    const captured = queued.managedContext!
    expect(captured.snapshot.resolved.host).toEqual(sorted([hostA.id, hostB.id]))

    // The composer moves on: one source removed, another added, plus a direct id.
    act(() => {
      useContextSelectionStore.getState().removeSourceTag({ namespace: 'host', id: hostTagA.id })
      useContextSelectionStore.getState().addSourceTag({ namespace: 'host', id: hostTagB.id })
      useContextSelectionStore.getState().addDirectId({ namespace: 'concept', id: conceptId })
    })
    expect(useContextSelectionStore.getState().resolvedIds().host).toEqual(sorted([hostB.id, hostC.id]))

    // The queued item still carries exactly what it was prepared with.
    const stillQueued = queuedItems(SESSION_ID)[0]!.managedContext!
    expect(stillQueued).toBe(captured)
    expect(stillQueued.snapshot.resolved.host).toEqual(sorted([hostA.id, hostB.id]))
    expect(stillQueued.snapshot.sourceTags.map((tag) => tag.id)).toEqual([hostTagA.id])
    expect(Object.isFrozen(stillQueued.snapshot)).toBe(true)
    expect(() => (stillQueued.snapshot.resolved.host as string[]).push('tampered')).toThrow()
    // The frozen copy is the queue item's own, not the store's pick.
    expect(useContextSelectionStore.getState().resolvedIds().host).toEqual(sorted([hostB.id, hostC.id]))

    // Flush (the session is still busy): no second prepare, the stored snapshot
    // rides the optimistic row, and the wire frame carries the prepared identity
    // (M7-B: requestId comes from the submission, never regenerated at send).
    const beforeFlush = prepareCount()
    act(() => {
      useChatStore.getState().sendQueuedUserMessage(SESSION_ID, queued.id)
    })
    expect(prepareCount() - beforeFlush).toBe(0)
    const flushed = lastUserText(SESSION_ID)
    expect(flushed?.optimisticQueued).toBe(true)
    expect(flushed?.managedContext!.snapshot.resolved.host).toEqual(sorted([hostA.id, hostB.id]))
    await waitFor(() => {
      expect(userMessageFrames().at(-1)).toEqual([
        SESSION_ID,
        {
          type: 'user_message',
          content: 'queued prompt',
          requestId: stillQueued.submissionId,
          contextTicket: {
            ticketId: expect.stringMatching(/^fixture-ticket-/),
            sidecarInstanceId: 'sidecar-test-instance',
          },
          attachments: [],
        },
      ])
    })
  })

  it('drives the password checkbox through real DOM into main-only staging without leaking the secret to renderer state', async () => {
    const secret = 'fake-host-password-123'
    const credential = await harness.services.credentialService.create({
      kind: 'ssh-password',
      label: 'M8 selected host login',
      secret: { kind: 'ssh-password', password: secret },
    })
    expect(credential.status).toBe('created')
    if (credential.status !== 'created') return

    const secretHostResult = await harness.services.libService.createHost({
      name: 'secret-host',
      address: 'secret-host.internal',
      port: 22,
      username: 'deploy',
      auth: { type: 'password', credentialId: credential.credential.id },
      tagIds: [],
      initialDirectory: null,
      applications: [],
      notes: '',
    })
    expect(secretHostResult.status).toBe('created')
    if (secretHostResult.status !== 'created') return

    render(<ChatInput compact />)
    await settle()
    const picker = await openEntry('host')
    fireEvent.click(within(picker).getByRole('checkbox', { name: 'secret-host' }))
    const passwordToggle = within(picker).getByRole('checkbox', { name: 'Include selected credentials' })
    expect(passwordToggle).not.toBeDisabled()
    fireEvent.click(passwordToggle)
    expect(passwordToggle).toBeChecked()
    expect(useContextSelectionStore.getState().toConversationContextSelection().includePasswords).toBe(true)

    await submit('inspect the selected secret host')
    await waitFor(() => {
      expect(harness.stagedContextRequests).toHaveLength(1)
      expect(userMessageFrames()).toHaveLength(1)
    })

    const staged = harness.stagedContextRequests[0]!
    expect(staged.modelContext).toContain(secret)
    expect(staged.publicManifest.containsSecrets).toBe(true)
    expect(staged.publicManifest.secretFieldCount).toBe(1)
    expect(staged.publicManifest.selection.credentialRefs).toEqual([
      { id: credential.credential.id, revision: credential.credential.revision },
    ])
    expect(JSON.stringify(staged.publicManifest)).not.toContain(secret)
    expect(JSON.stringify(lastUserText(SESSION_ID))).not.toContain(secret)
    expect(JSON.stringify(useContextSelectionStore.getState().snapshot())).not.toContain(secret)
    expect(JSON.stringify(userMessageFrames()[0])).not.toContain(secret)
    expect(userMessageFrames()[0]![1]).toMatchObject({
      type: 'user_message',
      content: 'inspect the selected secret host',
      contextTicket: {
        ticketId: expect.stringMatching(/^fixture-ticket-/),
        sidecarInstanceId: 'sidecar-test-instance',
      },
    })
  })

  it('routes database and Redis picks through the same managed-context ticket', async () => {
    const redisTag = createdValue(
      await harness.services.libService.createTag({ namespace: 'redis', name: '缓存', colorToken: null }),
      'redis tag',
    )
    const tls = {
      enabled: false,
      serverName: null,
      caCertificate: null,
      clientCertificate: null,
      clientKeyCredentialId: null,
    }
    const databaseResult = await harness.host.dataConnections.save({
      mode: 'create',
      connection: {
        kind: 'database', name: 'orders-db', address: 'db.internal', port: 3306,
        username: 'orders_app', credentialId: null, tagIds: [], relatedHostId: null,
        environment: 'production', tls, description: 'Order database',
        accessInstructions: 'Read operational order data', engine: 'mysql',
        database: 'orders', schema: null, mode: 'inspection',
      },
    })
    expect(databaseResult.ok).toBe(true)
    if (!databaseResult.ok) return
    const redisResult = await harness.host.dataConnections.save({
      mode: 'create',
      connection: {
        kind: 'redis', name: 'orders-cache', address: 'redis.internal', port: 6379,
        username: null, credentialId: null, tagIds: [redisTag.id], relatedHostId: null,
        environment: 'production', tls, description: 'Order cache',
        accessInstructions: 'Inspect cache keys only', topology: 'standalone',
        databaseIndex: 3, keyPrefixDescription: 'orders:*',
      },
    })
    expect(redisResult.ok).toBe(true)
    if (!redisResult.ok) return

    render(<ChatInput compact />)
    await waitFor(() => expect(useContextSelectionStore.getState().catalog.dataConnections).toHaveLength(2))
    const databasePicker = await openEntry('database')
    fireEvent.click(within(databasePicker).getByTestId(`context-option-resource-${databaseResult.data.id}`))
    const redisPicker = await openEntry('redis')
    fireEvent.click(within(redisPicker).getByRole('checkbox', { name: /^缓存/ }))

    const selection = useContextSelectionStore.getState().toConversationContextSelection()
    expect(selection.databaseRefs).toEqual([{ id: databaseResult.data.id, revision: databaseResult.data.revision }])
    expect(selection.redisRefs).toEqual([{ id: redisResult.data.id, revision: redisResult.data.revision }])
    expect(selection.directDatabaseIds).toEqual([databaseResult.data.id])
    expect(selection.sourceTags).toEqual([
      expect.objectContaining({ namespace: 'redis', id: redisTag.id, memberIds: [redisResult.data.id] }),
    ])

    await submit('inspect orders data and cache')
    await waitFor(() => expect(harness.stagedContextRequests).toHaveLength(1))
    const staged = harness.stagedContextRequests[0]!
    expect(staged.publicManifest.databases).toEqual([
      expect.objectContaining({ id: databaseResult.data.id, name: 'orders-db', database: 'orders' }),
    ])
    expect(staged.publicManifest.redisConnections).toEqual([
      expect.objectContaining({ id: redisResult.data.id, name: 'orders-cache', databaseIndex: 3 }),
    ])
    expect(staged.publicManifest.containsSecrets).toBe(false)
    expect(staged.modelContext).toContain('orders-db')
    expect(staged.modelContext).toContain('orders-cache')
    expect(userMessageFrames()[0]![1]).toMatchObject({
      type: 'user_message',
      content: 'inspect orders data and cache',
      contextTicket: {
        ticketId: expect.stringMatching(/^fixture-ticket-/),
        sidecarInstanceId: 'sidecar-test-instance',
      },
    })
  })

  it('moves the home draft selection onto the created session, persistently and without duplication', async () => {
    const observed: Array<{ scope: string; sessionId: string | null; sourceTagIds: string[] }> = []
    const unsubscribe = useContextSelectionStore.subscribe((state) => {
      observed.push({ scope: state.scope, sessionId: state.sessionId, sourceTagIds: state.pick.sourceTags.map((tag) => tag.id) })
    })

    render(<EmptySession />)
    await settle()
    const hostPicker = await openEntry('host')
    fireEvent.click(within(hostPicker).getByRole('checkbox', { name: /^生产/ }))

    const draftSnapshot = useContextSelectionStore.getState().snapshot()
    const draftSelection = useContextSelectionStore.getState().toConversationContextSelection()
    expect(draftSnapshot.scope).toBe('draft')
    expect(draftSnapshot.sessionId).toBeNull()
    expect(draftSelection.sourceTags).toHaveLength(1)

    await submit('hello home')
    await waitFor(() => {
      expect(userMessageFrames()).toHaveLength(1)
    })
    expect(mocks.create).toHaveBeenCalledTimes(1)

    // The moved selection is the draft's own pick — same draft token, now bound
    // to the session, and not a second copy beside it.
    const moved = useContextSelectionStore.getState()
    expect(moved.scope).toBe('session')
    expect(moved.sessionId).toBe(CREATED_SESSION_ID)
    expect(moved.snapshot().draftId).toBe(draftSnapshot.draftId)
    expect(moved.snapshot().sourceTags.map((tag) => tag.id)).toEqual([hostTagA.id])
    // Atomic: the first session-scoped state already had the pick, so no render
    // could observe a session-scoped empty draft.
    expect(observed.find((entry) => entry.scope === 'session')).toEqual({
      scope: 'session',
      sessionId: CREATED_SESSION_ID,
      sourceTagIds: [hostTagA.id],
    })
    unsubscribe()

    // Persisted for the session through the real host API, and read back.
    const persisted = await harness.host.conversationContext.getSelection(CREATED_SESSION_ID)
    expect(persisted).toEqual({ ok: true, data: draftSelection })

    const sent = lastUserText(CREATED_SESSION_ID)?.managedContext
    expect(sent?.selection).toEqual(draftSelection)
    expect(sent?.snapshot.sourceTags.map((tag) => tag.id)).toEqual([hostTagA.id])

    // A later edit of the home composer's selection cannot reach the session.
    act(() => {
      useContextSelectionStore.getState().removeSourceTag({ namespace: 'host', id: hostTagA.id })
      useContextSelectionStore.getState().addDirectId({ namespace: 'host', id: hostC.id })
    })
    expect(await harness.host.conversationContext.getSelection(CREATED_SESSION_ID)).toEqual({
      ok: true,
      data: draftSelection,
    })
    expect(sent?.selection).toEqual(draftSelection)
    expect(getComposerText()).toBe('')
  })
})
