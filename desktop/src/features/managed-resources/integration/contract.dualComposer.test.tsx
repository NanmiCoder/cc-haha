/**
 * M6-A contract: the picker surface both composers share.
 *
 * Driven through the real composers (`ChatInput` / `EmptySession`) and a real
 * managed-resources host (`createConceptHarness` — real repository + real IPC
 * handlers), so nothing here asserts against a hand-written store state.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
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
      handler('connecting')
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
import type { Host, ResourceTag } from '../types/resourceTypes'
import type { DataConnection } from '../types/dataConnectionTypes'

const SESSION_ID = 'session-context-picker'

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

describe('M6-A composer context picker', () => {
  let harness: ConceptHarness
  let hostTagA: ResourceTag
  let hostTagB: ResourceTag
  let conceptTag: ResourceTag
  let databaseTag: ResourceTag
  let redisTag: ResourceTag
  let hostA: Host
  let hostB: Host
  let hostC: Host
  let databaseConnection: DataConnection
  let redisConnection: DataConnection

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

    harness = await createConceptHarness('mr-context-composer-')
    resetContextSelectionStore()

    hostTagA = createdValue(await harness.services.libService.createTag({ namespace: 'host', name: '生产', colorToken: null }), 'host tag A')
    hostTagB = createdValue(await harness.services.libService.createTag({ namespace: 'host', name: '测试', colorToken: null }), 'host tag B')
    conceptTag = createdValue(await harness.services.libService.createTag({ namespace: 'concept', name: '架构', colorToken: null }), 'concept tag')
    databaseTag = createdValue(await harness.services.libService.createTag({ namespace: 'database', name: '数据', colorToken: null }), 'database tag')
    redisTag = createdValue(await harness.services.libService.createTag({ namespace: 'redis', name: '缓存', colorToken: null }), 'redis tag')

    // A hosts h1; A+B hosts h2 (the overlap both sources can keep alive); B hosts h3.
    hostA = await seedHost('web-1', [hostTagA.id])
    hostB = await seedHost('web-2', [hostTagA.id, hostTagB.id])
    hostC = await seedHost('web-3', [hostTagB.id])
    databaseConnection = createdValue(await harness.services.libService.createDataConnection({
      kind: 'database',
      name: 'orders-db',
      address: 'db.internal',
      port: 5432,
      username: 'reader',
      credentialId: null,
      tagIds: [databaseTag.id],
      relatedHostId: null,
      environment: 'test',
      tls: { enabled: false, serverName: null, caCertificate: null, clientCertificate: null, clientKeyCredentialId: null },
      description: 'orders database',
      accessInstructions: 'test network only',
      engine: 'postgresql',
      database: 'orders',
      schema: 'public',
      mode: 'inspection',
    }), 'database connection')
    redisConnection = createdValue(await harness.services.libService.createDataConnection({
      kind: 'redis',
      name: 'orders-cache',
      address: 'redis.internal',
      port: 6379,
      username: 'default',
      credentialId: null,
      tagIds: [redisTag.id],
      relatedHostId: null,
      environment: 'test',
      tls: { enabled: false, serverName: null, caCertificate: null, clientCertificate: null, clientKeyCredentialId: null },
      description: 'orders cache',
      accessInstructions: 'test network only',
      topology: 'standalone',
      databaseIndex: 0,
      keyPrefixDescription: 'orders:*',
    }), 'redis connection')
    await harness.seedConcept({
      title: '部署架构',
      summary: 'Deployment topology',
      bodyMarkdown: 'Deployment topology',
      tagIds: [conceptTag.id],
      dependsOnIds: [],
      referenceIds: [],
    })

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

  const openEntry = async (kind: 'host' | 'concept') => {
    fireEvent.click(screen.getByTestId(`context-entry-${kind}`))
    const picker = await screen.findByTestId('context-picker')
    // The catalog arrives through the real host; wait for its options.
    await waitFor(() => {
      expect(within(picker).queryAllByRole('checkbox').length).toBeGreaterThan(0)
    })
    return picker
  }

  const pick = () => useContextSelectionStore.getState()
  const optionCheckboxes = (picker: HTMLElement) =>
    within(picker)
      .queryAllByRole('checkbox')
      .filter((checkbox) => checkbox.getAttribute('data-testid') !== 'context-include-passwords')

  it('routes clicks from ChatInput and EmptySession into the same controller', async () => {
    const first = render(<ChatInput compact />)

    const chatPicker = await openEntry('host')
    fireEvent.click(within(chatPicker).getByRole('checkbox', { name: /^生产/ }))

    expect(pick().pick.sourceTags).toHaveLength(1)
    expect(sorted(pick().resolvedIds().host)).toEqual(sorted([hostA.id, hostB.id]))

    first.unmount()
    render(<EmptySession />)

    // If EmptySession owned a second controller this count would be 0 — the
    // selection was made in ChatInput.
    await waitFor(() => {
      expect(screen.getByTestId('context-entry-host-count')).toHaveTextContent('2')
    })

    const draftPicker = await openEntry('concept')
    fireEvent.click(within(draftPicker).getByRole('checkbox', { name: /^架构/ }))

    // One selection model: both kinds coexist in the same store.
    expect(pick().pick.sourceTags).toHaveLength(2)
    expect(sorted(pick().resolvedIds().host)).toEqual(sorted([hostA.id, hostB.id]))
    expect(pick().resolvedIds().concept).toHaveLength(1)
  })

  it('keeps ids contributed by a remaining source when another source is removed', async () => {
    render(<EmptySession />)
    const picker = await openEntry('host')

    fireEvent.click(within(picker).getByRole('checkbox', { name: /^生产/ }))
    fireEvent.click(within(picker).getByRole('checkbox', { name: /^测试/ }))
    expect(sorted(pick().resolvedIds().host)).toEqual(sorted([hostA.id, hostB.id, hostC.id]))

    // Removing tag A must not take web-2 with it: tag B still contributes it.
    fireEvent.click(within(picker).getByRole('button', { name: 'Remove 生产' }))
    expect(pick().pick.sourceTags).toHaveLength(1)
    expect(sorted(pick().resolvedIds().host)).toEqual(sorted([hostB.id, hostC.id]))
  })

  it('keeps ids contributed by a remaining tag when the other tag is removed', async () => {
    render(<EmptySession />)
    const picker = await openEntry('host')

    fireEvent.click(within(picker).getByRole('checkbox', { name: /^测试/ }))
    fireEvent.click(within(picker).getByRole('checkbox', { name: /^生产/ }))

    // A direct id that tag A also contributes: removing tag A leaves it alive.
    fireEvent.click(within(picker).getByRole('checkbox', { name: /^web-1/ }))
    expect(sorted(pick().resolvedIds().host)).toEqual(sorted([hostA.id, hostB.id, hostC.id]))

    fireEvent.click(within(picker).getByRole('button', { name: 'Remove 生产' }))
    expect(sorted(pick().resolvedIds().host)).toEqual(sorted([hostA.id, hostB.id, hostC.id]))

    // Removing tag B too leaves only what the direct source contributes.
    fireEvent.click(within(picker).getByRole('button', { name: 'Remove 测试' }))
    expect(pick().pick.sourceTags).toHaveLength(0)
    expect(sorted(pick().resolvedIds().host)).toEqual(sorted([hostA.id]))
  })

  it('opens from /hh, filters a Chinese query and confirms with Enter without sending', async () => {
    const sendSpy = vi
      .spyOn(useChatStore.getState(), 'sendMessage')
      .mockResolvedValue(undefined as never)
    render(<ChatInput compact />)

    setComposerText('/hh', 3)
    const picker = await screen.findByTestId('context-picker')
    await waitFor(() => {
      expect(optionCheckboxes(picker)).toHaveLength(5)
    })

    setComposerText('/hh 生产', 6)
    await waitFor(() => {
      expect(optionCheckboxes(picker)).toHaveLength(1)
    })
    expect(within(picker).getByRole('checkbox', { name: /^生产/ })).toHaveAttribute('data-highlighted', 'true')

    fireEvent.keyDown(getComposerElement(), { key: 'Enter' })

    expect(pick().pick.sourceTags).toHaveLength(1)
    expect(sorted(pick().resolvedIds().host)).toEqual(sorted([hostA.id, hostB.id]))
    expect(sendSpy).not.toHaveBeenCalled()
    // Confirming a pick is not a send: the composer text is untouched.
    expect(getComposerText()).toBe('/hh 生产')
  })

  it('ignores IME composition text and never confirms on a composing Enter', async () => {
    const sendSpy = vi
      .spyOn(useChatStore.getState(), 'sendMessage')
      .mockResolvedValue(undefined as never)
    render(<ChatInput compact />)

    setComposerText('/hh', 3)
    const picker = await screen.findByTestId('context-picker')
    await waitFor(() => {
      expect(optionCheckboxes(picker)).toHaveLength(5)
    })

    // The candidate-window text is provisional: it must not drive the picker.
    fireEvent.compositionStart(getComposerElement())
    setComposerText('/hh 生产', 6)
    expect(optionCheckboxes(picker)).toHaveLength(5)

    // Enter while composing (keyCode 229) is swallowed by the IME guard.
    fireEvent.keyDown(getComposerElement(), { key: 'Enter', keyCode: 229 })
    fireEvent.compositionEnd(getComposerElement())
    expect(pick().pick.sourceTags).toHaveLength(0)

    // Once composition ends the picker is live again, which is itself the proof
    // that the composer cleared its composing guard: `syncTrigger` drops every
    // update while that guard is set, so the filter could not have been applied.
    setComposerText('/hh 生产', 6)
    await waitFor(() => {
      expect(optionCheckboxes(picker)).toHaveLength(1)
    })
    expect(
      pick().pickerKind,
      `diag=${JSON.stringify({
        filter: pick().pickerFilter,
        options: pick().options().length,
        highlighted: pick().highlightedIndex,
        text: getComposerText(),
        open: screen.queryByTestId('context-picker') !== null,
      })}`,
    ).toBe('host')

    // ProseMirror deliberately swallows the one keydown that arrives within
    // 500 ms of a `compositionend` — on Safari the Enter that confirms an IME
    // candidate is emitted together with the `compositionend`, and letting it
    // reach the editor would also act on the document. ProseMirror picks that
    // branch from `navigator.vendor`, and jsdom reports
    // `Apple Computer, Inc.`; Electron reports `Google Inc.`, where the first
    // Enter after composition ends is delivered to the composer. Moving the
    // clock past the window therefore models the user's own keypress (a real
    // Enter handled by `handleComposerKeyDown`), not the IME one.
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 1000)
    fireEvent.keyDown(getComposerElement(), { key: 'Enter' })
    clock.mockRestore()

    expect(pick().pick.sourceTags).toHaveLength(1)
    // A confirm is not a send, even after an IME sequence.
    expect(sendSpy).not.toHaveBeenCalled()
  })

  it('opens from /ce with a Chinese query and adds a concept source', async () => {
    render(<ChatInput compact />)

    setComposerText('/ce 架构', 6)
    const picker = await screen.findByTestId('context-picker')
    await waitFor(() => {
      expect(within(picker).getByRole('checkbox', { name: /^架构/ })).toBeInTheDocument()
    })

    fireEvent.keyDown(getComposerElement(), { key: 'Enter' })

    expect(pick().pick.sourceTags).toHaveLength(1)
    expect(pick().resolvedIds().concept).toHaveLength(1)
  })

  it('closes the picker with Escape and adds nothing', async () => {
    render(<ChatInput compact />)

    setComposerText('/hh', 3)
    await screen.findByTestId('context-picker')

    fireEvent.keyDown(getComposerElement(), { key: 'Escape' })

    expect(screen.queryByTestId('context-picker')).not.toBeInTheDocument()
    expect(pick().pick.sourceTags).toHaveLength(0)
  })

  it('opens /db and /rd against real repository data and keeps both selected refs', async () => {
    render(<ChatInput compact />)

    setComposerText('/db 数据', 6)
    let picker = await screen.findByTestId('context-picker')
    await waitFor(() => {
      expect(within(picker).getByRole('checkbox', { name: /^数据/ })).toBeInTheDocument()
    })
    fireEvent.keyDown(getComposerElement(), { key: 'Enter' })
    expect(pick().resolvedIds().database).toEqual([databaseConnection.id])

    setComposerText('/rd 缓存', 6)
    picker = await screen.findByTestId('context-picker')
    await waitFor(() => {
      expect(within(picker).getByRole('checkbox', { name: /^缓存/ })).toBeInTheDocument()
    })
    fireEvent.keyDown(getComposerElement(), { key: 'Enter' })

    expect(pick().resolvedIds().database).toEqual([databaseConnection.id])
    expect(pick().resolvedIds().redis).toEqual([redisConnection.id])
    expect(pick().pick.sourceTags.map((tag) => tag.namespace)).toEqual(expect.arrayContaining(['database', 'redis']))
  })

  it('leaves the four commands and the plain send path untouched', async () => {
    const sendSpy = vi
      .spyOn(useChatStore.getState(), 'sendMessage')
      .mockResolvedValue(undefined as never)
    render(<ChatInput compact />)

    // A legacy command still opens the original slash menu, not the picker.
    setComposerText('/cle', 4)
    expect(await screen.findByRole('listbox', { name: 'Slash commands' })).toBeInTheDocument()
    expect(screen.queryByTestId('context-picker')).not.toBeInTheDocument()
    expect(pick().pickerKind).toBeNull()

    // Nothing selected: the composer sends exactly as before.
    setComposerText('plain prompt', 12)
    fireEvent.keyDown(getComposerElement(), { key: 'Enter' })

    await waitFor(() => {
      expect(sendSpy).toHaveBeenCalled()
    })
  })
})

describe('contextSelectionStore derivation', () => {
  it('projects the pick onto the ConversationContextSelectionV2 shape', () => {
    resetContextSelectionStore()
    const store = useContextSelectionStore.getState()
    store.addSourceTag({ namespace: 'host', id: 'tag-1' })
    store.addDirectId({ namespace: 'host', id: 'host-9' })
    store.addDirectId({ namespace: 'concept', id: 'concept-9' })

    const projected = useContextSelectionStore.getState().toConversationContextSelection()
    expect(projected.schemaVersion).toBe(2)
    expect(projected.sourceTags).toEqual([
      { namespace: 'host', id: 'tag-1', labelAtSelection: 'tag-1', memberIds: [] },
    ])
    expect(projected.directHostIds).toEqual(['host-9'])
    expect(projected.directConceptIds).toEqual(['concept-9'])
    expect(projected.databaseRefs).toEqual([])
    expect(projected.includePasswords).toBe(false)
  })

  it('moves draft to session in one atomic update and snapshots immutably', () => {
    resetContextSelectionStore()
    useContextSelectionStore.getState().addDirectId({ namespace: 'host', id: 'host-1' })

    const before = useContextSelectionStore.getState().snapshot()
    expect(before.scope).toBe('draft')
    expect(before.sessionId).toBeNull()

    useContextSelectionStore.getState().migrateToSession('session-1')

    const after = useContextSelectionStore.getState()
    expect(after.scope).toBe('session')
    expect(after.sessionId).toBe('session-1')
    expect(after.snapshot().resolved.host).toEqual(['host-1'])

    // The snapshot is a deep copy: mutating it cannot reach the controller.
    before.directIds.push({ namespace: 'concept', id: 'concept-1' })
    before.resolved.host.push('host-2')
    expect(useContextSelectionStore.getState().snapshot().directIds).toEqual([
      { namespace: 'host', id: 'host-1' },
    ])
  })

  it('never carries one session pick into another session', () => {
    resetContextSelectionStore()
    const store = useContextSelectionStore.getState()
    store.setScope('session', 'session-a')
    store.addDirectId({ namespace: 'host', id: 'host-a' })

    const inSessionA = useContextSelectionStore.getState()
    expect(inSessionA.sessionId).toBe('session-a')
    expect(inSessionA.hasSelection()).toBe(true)
    expect(inSessionA.toConversationContextSelection().directHostIds).toEqual(['host-a'])

    // `setScope` is what the composer entry effect runs on every session switch.
    // The pick belongs to one conversation: carrying `host-a` into `session-b`
    // would make the next message there stage a stale selection.
    useContextSelectionStore.getState().setScope('session', 'session-b')

    const inSessionB = useContextSelectionStore.getState()
    expect(inSessionB.sessionId).toBe('session-b')
    expect(inSessionB.hasSelection()).toBe(false)
    expect(inSessionB.snapshot().resolved.host).toEqual([])
    expect(inSessionB.toConversationContextSelection().directHostIds).toEqual([])

    // Re-selecting inside `session-b` and going back to `session-a` must not
    // resurrect either pick, and re-entering the same session stays a no-op.
    useContextSelectionStore.getState().addDirectId({ namespace: 'host', id: 'host-b' })
    useContextSelectionStore.getState().setScope('session', 'session-a')
    expect(useContextSelectionStore.getState().snapshot().resolved.host).toEqual([])

    useContextSelectionStore.getState().addDirectId({ namespace: 'host', id: 'host-a2' })
    useContextSelectionStore.getState().setScope('session', 'session-a')
    expect(useContextSelectionStore.getState().snapshot().resolved.host).toEqual(['host-a2'])
  })
})
