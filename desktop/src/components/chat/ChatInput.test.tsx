import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom'
import { act, StrictMode } from 'react'

const viewportMocks = vi.hoisted(() => ({
  isMobile: false,
}))

const originalOffsetWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth')
const originalRangeGetClientRects = Object.getOwnPropertyDescriptor(Range.prototype, 'getClientRects')
const originalRangeGetBoundingClientRect = Object.getOwnPropertyDescriptor(Range.prototype, 'getBoundingClientRect')

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  delete: vi.fn(),
  list: vi.fn(),
  getMessages: vi.fn(),
  getGitInfo: vi.fn(),
  getSlashCommands: vi.fn(),
  listAgents: vi.fn(),
  getRepositoryContext: vi.fn(),
  createRepositoryBranch: vi.fn(),
  getRecentProjects: vi.fn(),
  search: vi.fn(),
  browse: vi.fn(),
  wsSend: vi.fn(),
  dialogOpen: vi.fn(),
  webviewDragHandlers: [] as Array<(event: { payload: unknown }) => void>,
  webviewUnlisten: vi.fn(),
}))

vi.mock('../../api/sessions', () => ({
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

vi.mock('../../api/agents', () => ({
  agentsApi: {
    list: mocks.listAgents,
  },
}))

vi.mock('../../api/filesystem', () => ({
  filesystemApi: {
    search: mocks.search,
    browse: mocks.browse,
  },
}))

vi.mock('../../api/websocket', () => ({
  wsManager: {
    connect: vi.fn(),
    disconnect: vi.fn(),
    onConnectionState: vi.fn((_sessionId: string, handler: (state: string) => void) => {
      handler('connecting')
      return () => {}
    }),
    onMessage: vi.fn(() => () => {}),
    clearHandlers: vi.fn(),
    send: mocks.wsSend,
  },
}))

vi.mock('../../hooks/useMobileViewport', () => ({
  useMobileViewport: () => viewportMocks.isMobile,
}))

vi.mock('../controls/PermissionModeSelector', () => ({
  // Surfaces `compact` because that prop is the difference between the labelled
  // pill and the bare icon the real selector renders, and the composer decides
  // it from the column width.
  PermissionModeSelector: ({ compact }: { compact?: boolean }) => (
    <button type="button" data-testid="permission-mode-selector" data-compact={compact ? 'true' : 'false'}>
      Permissions
    </button>
  ),
}))

vi.mock('../controls/ModelSelector', async () => {
  const React = await vi.importActual<typeof import('react')>('react')
  return {
    ModelSelector: React.forwardRef<{ open: () => void }, { fluid?: boolean }>(({ fluid }, ref) => {
      const [open, setOpen] = React.useState(false)
      React.useImperativeHandle(ref, () => ({ open: () => setOpen(true) }), [])
      return (
        <div data-testid="model-selector-shell" className={fluid ? 'min-w-0 flex-1' : 'shrink-0'}>
          <button type="button">Model</button>
          {open && <div data-testid="model-selector-dropdown">Model selector opened</div>}
        </div>
      )
    }),
  }
})

import { ChatInput } from './ChatInput'
import { getComposerElement, getComposerText, setComposerText } from './composerTestUtils'
import { useChatStore } from '../../stores/chatStore'
import { useSessionStore } from '../../stores/sessionStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { useTabStore } from '../../stores/tabStore'
import { useWorkspaceChatContextStore } from '../../stores/workspaceChatContextStore'
import { useWorkflowStore } from '../../stores/workflowStore'
import { workflowsApi } from '../../api/workflows'
import { browserHost } from '../../lib/desktopHost/browserHost'
import { settingsApi } from '../../api/settings'
import {
  captureProjectDisplayNameHydrationRevision,
  hydrateProjectDisplayNames,
} from '../../stores/projectDisplayNameStore'

/**
 * Opens the run-location pill's menu. Directory, branch and worktree all live
 * behind it now — they used to be three standing buttons on a bar under the
 * composer.
 */
async function openLocationMenu() {
  fireEvent.click(await screen.findByRole('button', { name: /^Location/ }))
}

/** Opens the pill, then drills into its branch list. */
async function openBranchList() {
  await openLocationMenu()
  fireEvent.click(await screen.findByRole('menuitem', { name: /Branch/ }))
  return screen.findByRole('listbox', { name: 'Select branch' })
}

function okRepositoryContext() {
  return {
    state: 'ok' as const,
    workDir: '/repo',
    repoRoot: '/repo',
    repoName: 'repo',
    currentBranch: 'main',
    defaultBranch: 'main',
    dirty: false,
    branches: [
      {
        name: 'main',
        current: true,
        local: true,
        remote: false,
        checkedOut: true,
        worktreePath: '/repo',
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
      path: '/repo',
      branch: 'main',
      current: true,
    }],
  }
}

describe('ChatInput file mentions', () => {
  const sessionId = 'session-file-mention'
  const initialChatState = useChatStore.getInitialState()
  const initialSessionState = useSessionStore.getInitialState()
  const initialTabState = useTabStore.getInitialState()
  const initialWorkspaceContextState = useWorkspaceChatContextStore.getInitialState()

  const installElectronFileHost = () => {
    window.desktopHost = {
      ...browserHost,
      kind: 'electron',
      isDesktop: true,
      capabilities: {
        ...browserHost.capabilities,
        dialogs: true,
      },
      dialogs: {
        ...browserHost.dialogs,
        open: mocks.dialogOpen,
      },
      webview: {
        ...browserHost.webview,
        onDragDropEvent: async (handler) => {
          mocks.webviewDragHandlers.push(handler as (event: { payload: unknown }) => void)
          return mocks.webviewUnlisten
        },
      },
    }
  }

  beforeEach(() => {
    vi.clearAllMocks()
    mocks.createRepositoryBranch.mockReset()
    act(() => {
      hydrateProjectDisplayNames({}, Number.MAX_SAFE_INTEGER)
    })
    mocks.webviewDragHandlers.length = 0
    Reflect.deleteProperty(window, 'desktopHost')
    delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
    viewportMocks.isMobile = false
    useSettingsStore.setState({ locale: 'en' })
    useChatStore.setState(initialChatState, true)
    useSessionStore.setState(initialSessionState, true)
    useTabStore.setState(initialTabState, true)
    useWorkspaceChatContextStore.setState(initialWorkspaceContextState, true)
    useWorkflowStore.setState({ runs: {}, openRunId: null })

    useTabStore.setState({
      activeTabId: sessionId,
      tabs: [{ sessionId, title: 'Project', type: 'session', status: 'idle' }],
    })
    useSessionStore.setState({
      sessions: [{
        id: sessionId,
        title: 'Project',
        createdAt: '2026-05-01T00:00:00.000Z',
        modifiedAt: '2026-05-01T00:00:00.000Z',
        messageCount: 1,
        projectPath: '/repo',
        workDir: '/repo',
        workDirExists: true,
      }],
      activeSessionId: sessionId,
    })
    useChatStore.setState({
      sessions: {
        [sessionId]: {
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
      },
    })
    // jsdom does not implement these layout APIs. ProseMirror reads Range
    // geometry when a newline transaction scrolls the new selection into view.
    Object.defineProperties(Range.prototype, {
      getClientRects: {
        configurable: true,
        value: () => [],
      },
      getBoundingClientRect: {
        configurable: true,
        value: () => ({
          x: 0,
          y: 0,
          top: 0,
          right: 0,
          bottom: 0,
          left: 0,
          width: 0,
          height: 0,
          toJSON: () => ({}),
        }),
      },
    })
    // The branch list also scrolls its active row whenever the selection moves.
    Element.prototype.scrollIntoView = vi.fn()
    mocks.getGitInfo.mockResolvedValue({ branch: 'main', repoName: 'repo', workDir: '/repo', changedFiles: 0 })
    mocks.getRepositoryContext.mockResolvedValue(okRepositoryContext())
    mocks.getRecentProjects.mockResolvedValue({ projects: [] })
    mocks.create.mockResolvedValue({ sessionId: 'created-session', workDir: '/repo' })
    mocks.delete.mockResolvedValue({ ok: true })
    mocks.list.mockResolvedValue({ sessions: [], total: 0 })
    mocks.getMessages.mockResolvedValue({ messages: [] })
    mocks.getSlashCommands.mockResolvedValue({ commands: [] })
    mocks.listAgents.mockResolvedValue({ activeAgents: [], allAgents: [] })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    act(() => {
      hydrateProjectDisplayNames({}, Number.MAX_SAFE_INTEGER)
    })
    vi.unstubAllGlobals()
    if (originalOffsetWidth) {
      Object.defineProperty(HTMLElement.prototype, 'offsetWidth', originalOffsetWidth)
    } else {
      Reflect.deleteProperty(HTMLElement.prototype, 'offsetWidth')
    }
    if (originalRangeGetClientRects) {
      Object.defineProperty(Range.prototype, 'getClientRects', originalRangeGetClientRects)
    } else {
      Reflect.deleteProperty(Range.prototype, 'getClientRects')
    }
    if (originalRangeGetBoundingClientRect) {
      Object.defineProperty(Range.prototype, 'getBoundingClientRect', originalRangeGetBoundingClientRect)
    } else {
      Reflect.deleteProperty(Range.prototype, 'getBoundingClientRect')
    }
  })

  // jsdom lays nothing out, so the composer column's width has to be stated.
  // Only the shell answers: that is the single node the composer measures, and
  // a blanket stub would let an unrelated element satisfy the assertion.
  function stubComposerColumnWidth(initialWidth: number) {
    let width = initialWidth
    const subscribers = new Set<() => void>()

    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
      configurable: true,
      get(this: HTMLElement) {
        return this.dataset.testid === 'chat-input-shell' ? width : 0
      },
    })

    class StubResizeObserver {
      constructor(private readonly callback: () => void) {}
      observe() { subscribers.add(this.callback) }
      unobserve() { subscribers.delete(this.callback) }
      disconnect() { subscribers.delete(this.callback) }
    }
    vi.stubGlobal('ResizeObserver', StubResizeObserver)

    return {
      resizeTo(nextWidth: number) {
        width = nextWidth
        act(() => {
          subscribers.forEach((notify) => notify())
        })
      },
    }
  }

  it('explains a cleaned worktree without calling the source project missing', () => {
    useSessionStore.setState({
      sessions: [{
        id: sessionId,
        title: 'Cleaned Worktree',
        createdAt: '2026-05-01T00:00:00.000Z',
        modifiedAt: '2026-05-01T00:00:00.000Z',
        messageCount: 1,
        projectPath: '/repo-worktree',
        projectRoot: '/repo',
        workDir: '/repo/.claude/worktrees/desktop-main-12345678',
        workDirExists: false,
        workspaceState: 'worktree_removed',
      }],
    })

    render(<ChatInput />)

    const editor = screen.getByRole('textbox')
    expect(editor).toHaveAttribute(
      'data-placeholder',
      'This temporary workspace was cleaned up. Start a new session in the original project to continue.',
    )
    expect(editor).toHaveAttribute('contenteditable', 'false')
  })

  it('passes diff metadata to the composer card and clears the reference after send', async () => {
    act(() => {
      useWorkspaceChatContextStore.getState().addReference(sessionId, {
        kind: 'code-comment',
        path: 'src/a.ts',
        absolutePath: '/repo/src/a.ts',
        name: 'a.ts',
        lineStart: 11,
        lineEnd: 12,
        diffSide: 'new',
        hunkId: 'hunk-1',
        note: 'Use a shared helper',
        quote: 'const result = buildResult()\nreturn result',
      })
    })

    render(<ChatInput compact />)

    expect(screen.getByTestId('diff-comment-card')).toHaveTextContent('src/a.ts · new L11-L12')
    expect(screen.getByTestId('diff-comment-card')).toHaveTextContent('Use a shared helper')

    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' })

    await waitFor(() => {
      expect(useWorkspaceChatContextStore.getState().referencesBySession[sessionId]).toEqual([])
    })
    expect(screen.queryByTestId('diff-comment-card')).not.toBeInTheDocument()
  })

  it('keeps unsent composer drafts isolated when switching between session tabs', async () => {
    const historySessionId = 'history-session'
    useTabStore.setState({
      activeTabId: sessionId,
      tabs: [
        { sessionId, title: 'New session', type: 'session', status: 'idle' },
        { sessionId: historySessionId, title: 'History session', type: 'session', status: 'idle' },
      ],
    })
    useSessionStore.setState({
      sessions: [
        {
          id: sessionId,
          title: 'New session',
          createdAt: '2026-05-01T00:00:00.000Z',
          modifiedAt: '2026-05-01T00:00:00.000Z',
          messageCount: 0,
          projectPath: '/repo',
          workDir: '/repo',
          workDirExists: true,
        },
        {
          id: historySessionId,
          title: 'History session',
          createdAt: '2026-05-01T00:00:00.000Z',
          modifiedAt: '2026-05-01T00:00:00.000Z',
          messageCount: 1,
          projectPath: '/repo',
          workDir: '/repo',
          workDirExists: true,
        },
      ],
      activeSessionId: sessionId,
    })
    useChatStore.setState({
      sessions: {
        [sessionId]: {
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
          elapsedTimer: null,
        },
        [historySessionId]: {
          messages: [{ id: 'history-message', type: 'assistant_text', content: 'ready', timestamp: 1 }],
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
      },
    })

    render(<ChatInput variant="hero" />)

    setComposerText('new tab draft', 13)
    expect(getComposerText()).toBe('new tab draft')

    act(() => {
      useTabStore.setState({ activeTabId: historySessionId })
    })

    await waitFor(() => {
      expect(getComposerText()).toBe('')
    })

    setComposerText('history tab draft', 17)

    act(() => {
      useTabStore.setState({ activeTabId: sessionId })
    })

    await waitFor(() => {
      expect(getComposerText()).toBe('new tab draft')
    })

    act(() => {
      useTabStore.setState({ activeTabId: historySessionId })
    })

    await waitFor(() => {
      expect(getComposerText()).toBe('history tab draft')
    })
  })

  it('keeps the unsent draft when switching project on an empty active session', async () => {
    installElectronFileHost()
    mocks.dialogOpen.mockResolvedValueOnce('/other')
    mocks.create.mockResolvedValueOnce({ sessionId: 'session-project-switch', workDir: '/other' })
    mocks.getRepositoryContext.mockImplementation(async (workDir: string) => ({
      ...okRepositoryContext(),
      workDir,
      repoRoot: workDir,
      repoName: workDir.split('/').filter(Boolean).pop() ?? 'repo',
    }))
    useSessionStore.setState({
      sessions: [{
        id: sessionId,
        title: 'Project',
        createdAt: '2026-05-01T00:00:00.000Z',
        modifiedAt: '2026-05-01T00:00:00.000Z',
        messageCount: 0,
        projectPath: '/repo',
        workDir: '/repo',
        workDirExists: true,
      }],
      activeSessionId: sessionId,
    })
    useChatStore.setState({
      sessions: {
        [sessionId]: {
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
          elapsedTimer: null,
        },
      },
    })

    render(<ChatInput variant="hero" />)

    setComposerText('draft before switching project', 30)

    await openLocationMenu()
    fireEvent.click(screen.getAllByTitle('/repo')[0]!)
    // The directory list is a view of the location menu now, not a second
    // dropdown portalled outside it.
    fireEvent.click(await screen.findByRole('button', { name: /Choose a different folder/ }))

    await waitFor(() => {
      expect(mocks.create).toHaveBeenCalledWith({ workDir: '/other' })
    })
    await waitFor(() => {
      expect(useTabStore.getState().activeTabId).toBe('session-project-switch')
    })
    expect(getComposerText()).toBe('draft before switching project')
  })

  it('restores an unsent composer draft after the composer unmounts', async () => {
    const { unmount } = render(<ChatInput compact />)

    setComposerText('keep this prompt while I inspect another tab', 43)
    expect(getComposerText()).toBe('keep this prompt while I inspect another tab')

    unmount()
    render(<ChatInput compact />)

    await waitFor(() => {
      expect(getComposerText()).toBe('keep this prompt while I inspect another tab')
    })
  })

  it('appends a delayed browser screenshot without clearing an unsent draft after remount', async () => {
    const { unmount } = render(<ChatInput compact />)

    setComposerText('draft written while the agent is still running', 44)
    expect(getComposerText()).toBe('draft written while the agent is still running')

    unmount()

    act(() => {
      useChatStore.getState().queueComposerPrefill(sessionId, {
        text: '',
        mode: 'append',
        attachments: [{
          type: 'image',
          name: 'screenshot-full.png',
          mimeType: 'image/png',
          data: 'data:image/png;base64,DELAYED',
        }],
      })
    })

    render(<ChatInput compact />)

    await waitFor(() => {
      expect(getComposerText()).toBe('draft written while the agent is still running')
      expect(screen.getByAltText('screenshot-full.png')).toBeInTheDocument()
    })
  })

  it('does not replay a handled browser screenshot after the composer remounts', async () => {
    const { unmount } = render(<ChatInput compact />)

    act(() => {
      useChatStore.getState().queueComposerPrefill(sessionId, {
        text: '',
        mode: 'append',
        attachments: [{
          type: 'image',
          name: 'screenshot-full.png',
          mimeType: 'image/png',
          data: 'data:image/png;base64,OLD',
        }],
      })
    })

    await waitFor(() => {
      expect(screen.getByAltText('screenshot-full.png')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByLabelText('Remove screenshot-full.png'))

    await waitFor(() => {
      expect(screen.queryByAltText('screenshot-full.png')).not.toBeInTheDocument()
    })

    unmount()
    render(<ChatInput compact />)

    await waitFor(() => {
      expect(screen.queryByAltText('screenshot-full.png')).not.toBeInTheDocument()
    })
  })

  it('queues prompts submitted while a turn is running until the user guides them', async () => {
    useChatStore.setState({
      sessions: {
        [sessionId]: {
          messages: [{ id: 'assistant-stream', type: 'assistant_text', content: 'working', timestamp: 1 }],
          chatState: 'streaming',
          connectionState: 'connected',
          streamingText: 'still answering',
          streamingToolInput: '',
          activeToolUseId: null,
          activeToolName: null,
          activeThinkingId: null,
          pendingPermission: null,
          pendingComputerUsePermission: null,
          tokenUsage: { input_tokens: 0, output_tokens: 0 },
          streamingResponseChars: 0,
          elapsedSeconds: 12,
          statusVerb: '',
          slashCommands: [],
          agentTaskNotifications: {},
          elapsedTimer: null,
        },
      },
    })

    render(<ChatInput compact />)

    setComposerText('please adjust the current direction', 35)
    fireEvent.keyDown(getComposerElement(), { key: 'Enter' })

    expect(mocks.wsSend).not.toHaveBeenCalledWith(sessionId, expect.objectContaining({
      type: 'user_message',
    }))
    expect(getComposerText()).toBe('')
    expect(screen.getByTestId('pending-user-message')).toHaveTextContent('please adjust the current direction')

    fireEvent.click(screen.getByRole('button', { name: /Guide now/i }))

    expect(mocks.wsSend).toHaveBeenCalledWith(sessionId, {
      type: 'user_message',
      content: 'please adjust the current direction',
      attachments: [],
    })
    expect(screen.queryByTestId('pending-user-message')).not.toBeInTheDocument()
    expect(useChatStore.getState().sessions[sessionId]?.messages).toMatchObject([
      { type: 'assistant_text', content: 'workingstill answering' },
      { type: 'user_text', content: 'please adjust the current direction' },
    ])

    act(() => {
      useChatStore.getState().handleServerMessage(sessionId, {
        type: 'tool_result',
        toolUseId: 'tool-1',
        content: 'tool finished',
        isError: false,
      })
      useChatStore.getState().handleServerMessage(sessionId, {
        type: 'user_message_replay',
        content: 'please adjust the current direction',
      })
    })

    const guidedMessages = useChatStore.getState().sessions[sessionId]?.messages
      .filter((message) => message.type === 'user_text' && message.content === 'please adjust the current direction')
    expect(guidedMessages).toHaveLength(1)
  })

  it('edits and deletes queued prompts without sending them', async () => {
    useChatStore.setState({
      sessions: {
        [sessionId]: {
          messages: [{ id: 'assistant-stream', type: 'assistant_text', content: 'working', timestamp: 1 }],
          chatState: 'streaming',
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
          elapsedSeconds: 12,
          statusVerb: '',
          slashCommands: [],
          agentTaskNotifications: {},
          elapsedTimer: null,
        },
      },
    })

    render(<ChatInput compact />)

    setComposerText('first queued draft', 18)
    fireEvent.keyDown(getComposerElement(), { key: 'Enter' })

    fireEvent.click(screen.getByRole('button', { name: /Edit queued message/i }))
    const editInput = screen.getByLabelText('Queued message text')
    fireEvent.change(editInput, {
      target: { value: 'edited queued draft' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    expect(screen.getByTestId('pending-user-message')).toHaveTextContent('edited queued draft')

    fireEvent.click(screen.getByRole('button', { name: /Delete queued message/i }))

    expect(screen.queryByTestId('pending-user-message')).not.toBeInTheDocument()
    expect(mocks.wsSend).not.toHaveBeenCalledWith(sessionId, expect.objectContaining({
      type: 'user_message',
    }))
  })

  it('sends a queued prompt as the next tail message when the running turn completes', async () => {
    useChatStore.setState({
      sessions: {
        [sessionId]: {
          messages: [{ id: 'assistant-stream', type: 'assistant_text', content: 'working', timestamp: 1 }],
          chatState: 'streaming',
          connectionState: 'connected',
          streamingText: 'done now',
          streamingToolInput: '',
          activeToolUseId: null,
          activeToolName: null,
          activeThinkingId: null,
          pendingPermission: null,
          pendingComputerUsePermission: null,
          tokenUsage: { input_tokens: 0, output_tokens: 0 },
          streamingResponseChars: 0,
          elapsedSeconds: 12,
          statusVerb: '',
          slashCommands: [],
          agentTaskNotifications: {},
          elapsedTimer: null,
        },
      },
    })

    render(<ChatInput compact />)

    setComposerText('continue after completion', 25)
    fireEvent.keyDown(getComposerElement(), { key: 'Enter' })

    expect(screen.getByTestId('pending-user-message')).toHaveTextContent('continue after completion')
    expect(mocks.wsSend).not.toHaveBeenCalledWith(sessionId, expect.objectContaining({
      type: 'user_message',
    }))

    act(() => {
      useChatStore.getState().handleServerMessage(sessionId, {
        type: 'message_complete',
        usage: { input_tokens: 1, output_tokens: 2 },
      })
    })

    expect(mocks.wsSend).toHaveBeenCalledWith(sessionId, {
      type: 'user_message',
      content: 'continue after completion',
      attachments: [],
    })
    expect(useChatStore.getState().sessions[sessionId]?.messages).toMatchObject([
      { type: 'assistant_text', content: 'workingdone now' },
      { type: 'user_text', content: 'continue after completion' },
    ])
  })

  it('shows branch and worktree launch controls for an empty active Git session', async () => {
    useSessionStore.setState({
      sessions: [{
        id: sessionId,
        title: 'Project',
        createdAt: '2026-05-01T00:00:00.000Z',
        modifiedAt: '2026-05-01T00:00:00.000Z',
        messageCount: 0,
        projectPath: '/repo',
        workDir: '/repo',
        workDirExists: true,
      }],
      activeSessionId: sessionId,
    })
    useChatStore.setState({
      sessions: {
        [sessionId]: {
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
          elapsedTimer: null,
        },
      },
    })

    render(<ChatInput variant="hero" />)

    const panel = screen.getByTestId('chat-input-panel')
    // 20px composer corner + the composer step of the shadow scale, the same
    // shell EmptySession renders (docs/redesign-paper-ink-seal.md §2).
    expect(panel).toHaveClass('rounded-[var(--radius-2xl)]', 'glass-panel--composer')
    expect(panel).not.toHaveClass('rounded-b-none')

    // One pill in the toolbar instead of a three-button bar welded to the
    // panel's bottom edge — which is what used to square off that edge.
    const pill = await screen.findByRole('button', { name: 'Location: repo / main' })
    expect(panel).toContainElement(pill)
    expect(pill).toHaveClass('h-9')
    expect(screen.queryByText('Select a project...')).not.toBeInTheDocument()

    await openLocationMenu()
    const menu = await screen.findByRole('menu', { name: 'Location' })
    expect(within(menu).getByRole('menuitem', { name: /Branch/ })).toBeInTheDocument()
    expect(within(menu).getByRole('menuitemradio', { name: /Current worktree/ })).toHaveAttribute('aria-checked', 'true')
    expect(within(menu).getByRole('menuitemradio', { name: /Isolated worktree/ })).toBeInTheDocument()
  })

  // Sending the first message used to move the run location from inside the
  // panel to a chip below it. It stays in the toolbar now and only loses its
  // affordances, so nothing shifts under the cursor.
  //
  // The variant here is `default` on purpose: ActiveSession renders the hero
  // composer only while the session is empty, so a live session is always the
  // default one. Asserting this against `hero` passed while the shipped
  // composer still dropped the chip below the panel.
  it('swaps the pill for a read-only chip in the same row once the session has messages', async () => {
    // beforeEach seeds one message, so this is a live session, not a draft.
    render(<ChatInput variant="default" />)

    const chip = await screen.findByTestId('run-location-readonly')
    expect(chip).toHaveTextContent('repo')
    expect(chip).toHaveTextContent('main')

    expect(screen.getByTestId('chat-input-toolbar')).toContainElement(chip)
    expect(screen.getByTestId('chat-input-panel')).toContainElement(chip)
    expect(screen.queryByTestId('run-location-outside')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Location/ })).not.toBeInTheDocument()
  })

  it('reactively uses the active session project root display name while retaining the active worktree path in context', async () => {
    const worktreePath = '/repo/.claude/worktrees/desktop-main-12345678'
    useSessionStore.setState({
      sessions: [{
        id: sessionId,
        title: 'Project',
        createdAt: '2026-05-01T00:00:00.000Z',
        modifiedAt: '2026-05-01T00:00:00.000Z',
        messageCount: 1,
        projectPath: '/repo',
        projectRoot: '/repo',
        workDir: worktreePath,
        workDirExists: true,
      }],
      activeSessionId: sessionId,
    })
    mocks.getGitInfo.mockResolvedValue({
      branch: 'main',
      repoName: 'repo',
      workDir: worktreePath,
      changedFiles: 0,
      worktree: {
        enabled: true,
        path: worktreePath,
        plannedPath: null,
        sourceWorkDir: '/repo',
        slug: 'desktop-main-12345678',
        branch: 'main',
      },
    })

    render(<ChatInput />)

    const chip = await screen.findByTestId('run-location-readonly')
    expect(chip).toHaveTextContent('repo')

    act(() => {
      hydrateProjectDisplayNames(
        { '/repo': 'Personal repo' },
        captureProjectDisplayNameHydrationRevision(),
      )
    })

    expect(chip).toHaveTextContent('Personal repo')

    // Once the alias takes over the label, the worktree details tooltip is the
    // only place still naming the real project root and the active worktree
    // path — the toolbar variant carries no `title` for a worktree.
    expect(chip).not.toHaveAttribute('title')
    fireEvent.mouseEnter(screen.getByTestId('worktree-details-trigger'))

    const tooltip = await screen.findByRole('tooltip')
    // Exact-text lookups: '/repo' is a prefix of the worktree path, so a
    // substring assertion would pass even if the project root row went missing.
    expect(within(tooltip).getByText('/repo')).toBeInTheDocument()
    expect(within(tooltip).getByText(worktreePath)).toBeInTheDocument()
  })

  // The narrow layouts never adopted the in-toolbar pill: there is no room for
  // it beside the model selector, so they keep the location on its own line
  // below the panel.
  it('keeps the run location below the panel when the composer column is narrow', async () => {
    stubComposerColumnWidth(360)

    render(<ChatInput compact />)

    const chip = await screen.findByTestId('run-location-outside')
    expect(chip).toHaveTextContent('repo')
    expect(screen.getByTestId('chat-input-panel')).not.toContainElement(chip)
    expect(screen.queryByTestId('run-location-readonly')).not.toBeInTheDocument()
  })

  // The bug this replaces: `compact` is wired to "is the workspace panel open",
  // so opening the panel dropped the location to a second line and shrank the
  // permission mode to a bare icon even on a column with room to spare — the
  // panel is resizable and the window is not fixed, so its open state says
  // nothing about the width the composer actually got.
  it('keeps the run location in the toolbar when a workspace panel leaves the column wide', async () => {
    stubComposerColumnWidth(580)

    render(<ChatInput compact />)

    const chip = await screen.findByTestId('run-location-readonly')
    expect(screen.getByTestId('chat-input-toolbar')).toContainElement(chip)
    expect(screen.queryByTestId('run-location-outside')).not.toBeInTheDocument()

    // The same width buys back the labelled permission pill.
    expect(screen.getByTestId('permission-mode-selector')).toHaveAttribute('data-compact', 'false')
  })

  // The run button's word is the cheaper thing to drop — the icon keeps its
  // `aria-label` and tooltip, while dropping the location costs a whole line
  // and the directory the turn runs in. So the label goes first, at a width
  // where keeping both would squeeze the location down to its ellipsis.
  it('keeps the same circle when it turns into the stop button mid-turn', async () => {
    // Send and stop are one control that swaps role, so the shape has to
    // survive the swap — a round send that becomes a pill on stop would move
    // the whole toolbar every time a turn starts. Only the fill and the glyph
    // change.
    stubComposerColumnWidth(700)

    render(<ChatInput compact />)

    const send = screen.getByRole('button', { name: 'Run' })
    expect(send).toHaveClass('rounded-full', 'h-8', 'w-8')
    expect(send).toHaveTextContent('arrow_upward')

    await act(async () => {
      useChatStore.setState({
        sessions: {
          ...useChatStore.getState().sessions,
          [sessionId]: { ...useChatStore.getState().sessions[sessionId]!, chatState: 'streaming' },
        },
      })
    })

    const stop = screen.getByRole('button', { name: 'Stop' })
    expect(stop).toHaveClass('rounded-full', 'h-8', 'w-8')
    expect(stop).toHaveTextContent('stop')
    expect(stop).not.toBeDisabled()
  })

  it.each(['local_agent', 'remote_agent'])('keeps Run available alongside Stop for an idle session with a running %s', (taskType) => {
    useChatStore.setState({
      sessions: {
        ...useChatStore.getState().sessions,
        [sessionId]: {
          ...useChatStore.getState().sessions[sessionId]!,
          chatState: 'idle',
          backgroundAgentTasks: {
            agent: {
              taskId: 'agent',
              taskType,
              status: 'running',
              startedAt: 1,
              updatedAt: 1,
            },
          },
        },
      },
    })

    render(<ChatInput compact />)

    setComposerText('continue while the agent runs', 29)

    const run = screen.getByRole('button', { name: 'Run' })
    const stop = screen.getByRole('button', { name: 'Stop' })
    expect(run).not.toBeDisabled()
    expect(stop).not.toBeDisabled()

    fireEvent.click(stop)
    fireEvent.click(run)

    expect(mocks.wsSend).toHaveBeenCalledWith(sessionId, { type: 'stop_generation' })
    expect(mocks.wsSend).toHaveBeenCalledWith(sessionId, {
      type: 'user_message',
      content: 'continue while the agent runs',
      attachments: [],
    })
  })

  it.each(['local_bash', 'dream'])('does not turn Run into Stop for a running %s task', (taskType) => {
    useChatStore.setState({
      sessions: {
        ...useChatStore.getState().sessions,
        [sessionId]: {
          ...useChatStore.getState().sessions[sessionId]!,
          chatState: 'idle',
          backgroundAgentTasks: {
            task: {
              taskId: 'task',
              taskType,
              status: 'running',
              startedAt: 1,
              updatedAt: 1,
            },
          },
        },
      },
    })

    render(<ChatInput compact />)

    expect(screen.getByRole('button', { name: 'Run' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Stop' })).not.toBeInTheDocument()
  })

  // This used to assert that the run button shed its label before the location
  // moved. The button has no label to shed any more — it is one round icon at
  // every width — so what needs pinning is that it does *not* change with the
  // column, leaving the location as the only thing that degrades (next test).
  it('keeps the send button a fixed circle as the column narrows', async () => {
    const column = stubComposerColumnWidth(700)

    render(<ChatInput compact />)

    expect(await screen.findByTestId('run-location-readonly')).toBeInTheDocument()
    const wide = screen.getByRole('button', { name: 'Run' })
    expect(wide).not.toHaveTextContent('Run')
    expect(wide).toHaveClass('rounded-full', 'h-8', 'w-8')

    column.resizeTo(580)

    expect(screen.getByTestId('run-location-readonly')).toBeInTheDocument()
    const narrow = screen.getByRole('button', { name: 'Run' })
    expect(narrow).not.toHaveTextContent('Run')
    expect(narrow).toHaveClass('rounded-full', 'h-8', 'w-8')
  })

  it('moves the run location out of the toolbar as the column is dragged narrow', async () => {
    const column = stubComposerColumnWidth(580)

    render(<ChatInput compact />)

    expect(await screen.findByTestId('run-location-readonly')).toBeInTheDocument()

    column.resizeTo(360)

    expect(await screen.findByTestId('run-location-outside')).toBeInTheDocument()
    expect(screen.queryByTestId('run-location-readonly')).not.toBeInTheDocument()
    expect(screen.getByTestId('permission-mode-selector')).toHaveAttribute('data-compact', 'true')

    column.resizeTo(580)

    expect(await screen.findByTestId('run-location-readonly')).toBeInTheDocument()
    expect(screen.queryByTestId('run-location-outside')).not.toBeInTheDocument()
  })

  // The band cancels the panel's `p-3`, so it has to follow the panel's padding
  // rather than the control layout. A wide column beside an open panel renders
  // the wide toolbar inside a `p-3` panel; keying the band on the controls would
  // have inset the divider by 12px there.
  it('keeps the toolbar band matched to the panel padding when a wide column sits beside a panel', async () => {
    stubComposerColumnWidth(580)

    render(<ChatInput compact />)

    await screen.findByTestId('run-location-readonly')
    expect(screen.getByTestId('chat-input-panel')).toHaveClass('p-3')
    expect(screen.getByTestId('chat-input-toolbar')).toHaveClass('-mx-3')
  })

  it('uses the persisted message count to keep reopened sessions in context mode while history loads', async () => {
    useSessionStore.setState({
      sessions: [{
        id: sessionId,
        title: 'Project',
        createdAt: '2026-05-01T00:00:00.000Z',
        modifiedAt: '2026-05-01T00:00:00.000Z',
        messageCount: 2,
        projectPath: '/repo',
        workDir: '/repo',
        workDirExists: true,
      }],
      activeSessionId: sessionId,
    })
    useChatStore.setState({
      sessions: {
        [sessionId]: {
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
          elapsedTimer: null,
        },
      },
    })

    render(<ChatInput variant="hero" />)

    expect(await screen.findByText('repo')).toBeInTheDocument()
    expect(screen.getByText('main')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Select branch:/ })).not.toBeInTheDocument()
    expect(screen.queryByText('Current worktree')).not.toBeInTheDocument()
  })

  it('starts an empty active session on the selected branch without an isolated worktree', async () => {
    let resolveCreate!: (value: { sessionId: string; workDir: string }) => void
    mocks.create.mockReturnValueOnce(new Promise((resolve) => {
      resolveCreate = resolve
    }))
    useSessionStore.setState({
      sessions: [{
        id: sessionId,
        title: 'Project',
        createdAt: '2026-05-01T00:00:00.000Z',
        modifiedAt: '2026-05-01T00:00:00.000Z',
        messageCount: 0,
        projectPath: '/repo',
        workDir: '/repo',
        workDirExists: true,
      }],
      activeSessionId: sessionId,
    })
    useChatStore.setState({
      sessions: {
        [sessionId]: {
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
          elapsedTimer: null,
        },
      },
    })

    render(<ChatInput variant="hero" />)

    await openBranchList()
    fireEvent.click(await screen.findByRole('option', { name: /feature\/a/ }))
    setComposerText('run on feature branch', 21)
    fireEvent.keyDown(getComposerElement(), { key: 'Enter' })

    await waitFor(() => {
      expect(mocks.create).toHaveBeenCalledWith({
        workDir: '/repo',
        repository: { branch: 'feature/a', worktree: false },
      })
    })

    // Session creation can take seconds. The click must cross the store
    // boundary immediately so the transcript can replace its empty hero with
    // a live placeholder before the new session id exists.
    expect(useChatStore.getState().sessions[sessionId]?.isPreparingTurn).toBe(true)

    resolveCreate({ sessionId: 'created-direct', workDir: '/repo' })

    await waitFor(() => {
      expect(mocks.wsSend).toHaveBeenCalledWith('created-direct', {
        type: 'user_message',
        content: 'run on feature branch',
        attachments: [],
      })
    })
    expect(useChatStore.getState().sessions['created-direct']?.isPreparingTurn).toBe(false)
    expect(mocks.delete).toHaveBeenCalledWith(sessionId)
  })

  it('launches on a branch created from the picker instead of falling back to the current branch', async () => {
    const headCommit = 'a'.repeat(40)
    const initialContext = {
      ...okRepositoryContext(),
      headCommit,
      dirty: true,
      branches: okRepositoryContext().branches.map((branch) => ({ ...branch, commit: headCommit })),
    }
    const createdContext = {
      ...initialContext,
      branches: [
        ...initialContext.branches,
        {
          name: 'qa/launch-picker',
          current: false,
          local: true,
          remote: false,
          checkedOut: false,
          commit: headCommit,
        },
      ],
    }
    mocks.getRepositoryContext.mockResolvedValue(initialContext)
    mocks.createRepositoryBranch.mockImplementation(() => new Promise((resolve) => {
      window.setTimeout(() => resolve({
        branch: 'qa/launch-picker',
        baseRef: 'main',
        context: createdContext,
      }), 0)
    }))
    mocks.create.mockResolvedValueOnce({ sessionId: 'created-picker-branch', workDir: '/repo' })
    useSessionStore.setState({
      sessions: [{
        id: sessionId,
        title: 'Project',
        createdAt: '2026-05-01T00:00:00.000Z',
        modifiedAt: '2026-05-01T00:00:00.000Z',
        messageCount: 0,
        projectPath: '/repo',
        workDir: '/repo',
        workDirExists: true,
      }],
      activeSessionId: sessionId,
    })
    useChatStore.setState({
      sessions: {
        [sessionId]: {
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
          elapsedTimer: null,
        },
      },
    })

    render(
      <StrictMode>
        <ChatInput variant="hero" />
      </StrictMode>,
    )

    await openBranchList()
    fireEvent.click(screen.getByRole('button', { name: 'Create branch…' }))
    fireEvent.change(await screen.findByLabelText('Branch name'), {
      target: { value: 'qa/launch-picker' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))

    expect(await screen.findByRole('button', { name: 'Location: repo / qa/launch-picker' }))
      .toBeInTheDocument()
    expect(useChatStore.getState().sessions[sessionId]?.repositoryLaunchDraft?.branch)
      .toBe('qa/launch-picker')
    expect(screen.queryByRole('status', { name: /Uncommitted changes/ })).not.toBeInTheDocument()

    setComposerText('show the current branch', 23)
    fireEvent.keyDown(getComposerElement(), { key: 'Enter' })

    await waitFor(() => {
      expect(mocks.create).toHaveBeenCalledWith({
        workDir: '/repo',
        repository: { branch: 'qa/launch-picker', worktree: false },
      })
    })
    expect(mocks.wsSend).toHaveBeenCalledWith('created-picker-branch', {
      type: 'user_message',
      content: 'show the current branch',
      attachments: [],
    })
  })

  it('preserves explicit permission mode when replacing an empty session for branch launch', async () => {
    mocks.create.mockResolvedValueOnce({ sessionId: 'created-permission', workDir: '/repo' })
    useSessionStore.setState({
      sessions: [{
        id: sessionId,
        title: 'Project',
        createdAt: '2026-05-01T00:00:00.000Z',
        modifiedAt: '2026-05-01T00:00:00.000Z',
        messageCount: 0,
        projectPath: '/repo',
        workDir: '/repo',
        workDirExists: true,
        permissionMode: 'acceptEdits',
      }],
      activeSessionId: sessionId,
    })
    useChatStore.setState({
      sessions: {
        [sessionId]: {
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
          elapsedTimer: null,
        },
      },
    })

    render(<ChatInput variant="hero" />)

    await openBranchList()
    fireEvent.click(await screen.findByRole('option', { name: /feature\/a/ }))
    setComposerText('run with preserved permissions', 30)
    fireEvent.keyDown(getComposerElement(), { key: 'Enter' })

    await waitFor(() => {
      expect(mocks.create).toHaveBeenCalledWith({
        workDir: '/repo',
        repository: { branch: 'feature/a', worktree: false },
        permissionMode: 'acceptEdits',
      })
    })
    expect(mocks.wsSend).toHaveBeenCalledWith('created-permission', {
      type: 'user_message',
      content: 'run with preserved permissions',
      attachments: [],
    })
  })

  it('starts an empty active session on the selected branch inside an isolated worktree', async () => {
    mocks.create.mockResolvedValueOnce({
      sessionId: 'created-worktree',
      workDir: '/repo/.claude/worktrees/desktop-feature-a-12345678',
    })
    mocks.list.mockImplementationOnce(() => new Promise(() => {}))
    useSessionStore.setState({
      sessions: [{
        id: sessionId,
        title: 'Project',
        createdAt: '2026-05-01T00:00:00.000Z',
        modifiedAt: '2026-05-01T00:00:00.000Z',
        messageCount: 0,
        projectPath: '/repo',
        workDir: '/repo',
        workDirExists: true,
      }],
      activeSessionId: sessionId,
    })
    useChatStore.setState({
      sessions: {
        [sessionId]: {
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
          elapsedTimer: null,
        },
      },
    })

    render(<ChatInput variant="hero" />)

    await openBranchList()
    fireEvent.click(await screen.findByRole('option', { name: /feature\/a/ }))
    // Picking a branch returns to the root view, where both worktree modes are
    // one click away — no second menu to open.
    fireEvent.click(await screen.findByRole('menuitemradio', { name: /Isolated worktree/ }))
    expect(await screen.findByText('Isolated')).toBeInTheDocument()
    setComposerText('run in a worktree', 17)
    fireEvent.keyDown(getComposerElement(), { key: 'Enter' })

    await waitFor(() => {
      expect(mocks.create).toHaveBeenCalledWith({
        workDir: '/repo',
        repository: { branch: 'feature/a', worktree: true },
      })
    })
    expect(mocks.delete).toHaveBeenCalledWith(sessionId)
    expect(mocks.wsSend).toHaveBeenCalledWith('created-worktree', {
      type: 'user_message',
      content: 'run in a worktree',
      attachments: [],
    })
    expect(useSessionStore.getState().sessions[0]?.workDir)
      .toBe('/repo/.claude/worktrees/desktop-feature-a-12345678')
  })

  it('keeps an isolated worktree choice scoped to its empty session across tab switches and remounts', async () => {
    const otherSessionId = 'other-empty-session'
    const baseChatState = useChatStore.getState().sessions[sessionId]!
    useTabStore.setState({
      activeTabId: sessionId,
      tabs: [
        { sessionId, title: 'Repo A', type: 'session', status: 'idle' },
        { sessionId: otherSessionId, title: 'Repo B', type: 'session', status: 'idle' },
      ],
    })
    useSessionStore.setState({
      sessions: [
        {
          id: sessionId,
          title: 'Repo A',
          createdAt: '2026-05-01T00:00:00.000Z',
          modifiedAt: '2026-05-01T00:00:00.000Z',
          messageCount: 0,
          projectPath: '/repo-a',
          workDir: '/repo-a',
          workDirExists: true,
        },
        {
          id: otherSessionId,
          title: 'Repo B',
          createdAt: '2026-05-01T00:00:00.000Z',
          modifiedAt: '2026-05-01T00:00:00.000Z',
          messageCount: 0,
          projectPath: '/repo-b',
          workDir: '/repo-b',
          workDirExists: true,
        },
      ],
      activeSessionId: sessionId,
    })
    useChatStore.setState({
      sessions: {
        [sessionId]: { ...baseChatState, messages: [] },
        [otherSessionId]: { ...baseChatState, messages: [] },
      },
    })
    mocks.getGitInfo.mockImplementation(async (activeSessionId: string) => {
      const workDir = activeSessionId === otherSessionId ? '/repo-b' : '/repo-a'
      return {
        branch: 'main',
        repoName: workDir.slice(1),
        workDir,
        changedFiles: 0,
      }
    })
    mocks.getRepositoryContext.mockImplementation(async (workDir: string) => ({
      ...okRepositoryContext(),
      workDir,
      repoRoot: workDir,
      repoName: workDir.slice(1),
    }))
    mocks.create.mockResolvedValueOnce({
      sessionId: 'created-restored-worktree',
      workDir: '/repo-a/.claude/worktrees/desktop-main-restored',
    })

    const view = render(<ChatInput variant="hero" />)

    await openLocationMenu()
    fireEvent.click(await screen.findByRole('menuitemradio', { name: /Isolated worktree/ }))
    expect(await screen.findByText('Isolated')).toBeInTheDocument()

    act(() => {
      useTabStore.setState({ activeTabId: otherSessionId })
    })
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /^Location: repo-b/ })).toBeInTheDocument()
    })
    expect(screen.queryByText('Isolated')).not.toBeInTheDocument()

    act(() => {
      useTabStore.setState({ activeTabId: sessionId })
    })
    expect(await screen.findByText('Isolated')).toBeInTheDocument()
    expect(useChatStore.getState().sessions[sessionId]?.repositoryLaunchDraft?.useWorktree).toBe(true)
    expect(useChatStore.getState().sessions[otherSessionId]?.repositoryLaunchDraft?.useWorktree).toBe(false)

    view.unmount()
    render(<ChatInput variant="hero" />)
    expect(await screen.findByText('Isolated')).toBeInTheDocument()

    setComposerText('keep the isolated worktree', 26)
    fireEvent.keyDown(getComposerElement(), { key: 'Enter' })

    await waitFor(() => {
      expect(mocks.create).toHaveBeenCalledWith({
        workDir: '/repo-a',
        repository: { branch: 'main', worktree: true },
      })
    })
  })

  it('keeps mention pills in the unsent draft across session tab switches', async () => {
    mocks.search.mockResolvedValueOnce({
      currentPath: '/repo',
      parentPath: '/',
      query: 'backend',
      entries: [
        { name: 'backend', path: '/repo/backend', relativePath: 'backend', isDirectory: true },
      ],
    })
    const historySessionId = 'history-session'
    useTabStore.setState({
      activeTabId: sessionId,
      tabs: [
        { sessionId, title: 'New session', type: 'session', status: 'idle' },
        { sessionId: historySessionId, title: 'History session', type: 'session', status: 'idle' },
      ],
    })
    useChatStore.setState({
      sessions: {
        [sessionId]: {
          ...useChatStore.getState().sessions[sessionId]!,
        },
        [historySessionId]: {
          ...useChatStore.getState().sessions[sessionId]!,
        },
      },
    })

    render(<ChatInput compact />)

    setComposerText('总结一下 @backend 这个目录', '总结一下 @backend'.length)
    fireEvent.click(await screen.findByRole('option', { name: /backend/i }))
    await waitFor(() => {
      expect(getComposerText()).toBe('总结一下 @backend/ 这个目录')
    })

    act(() => {
      useTabStore.setState({ activeTabId: historySessionId })
    })

    await waitFor(() => {
      expect(getComposerText()).toBe('')
    })

    act(() => {
      useTabStore.setState({ activeTabId: sessionId })
    })

    // The pill, not just its text: path and directory attrs survive the round
    // trip through the composer draft.
    await waitFor(() => {
      expect(getComposerText()).toBe('总结一下 @backend/ 这个目录')
    })
    expect(document.querySelector('.composer-mention')).toHaveAttribute('data-mention-path', '/repo/backend')
  })

  it('inserts a selected @ file as an inline mention pill and sends its absolute path', async () => {
    mocks.search.mockResolvedValueOnce({
      currentPath: '/repo/backend/src',
      parentPath: '/repo/backend',
      query: 'conditions.py',
      entries: [
        { name: 'conditions.py', path: '/repo/backend/src/conditions.py', isDirectory: false },
      ],
    })

    render(<ChatInput compact />)

    const mention = '@backend/src/conditions.py'
    setComposerText(`${mention} 记一下这个文件讲了什么东西。`, mention.length)

    fireEvent.click(await screen.findByText('backend/src/conditions.py'))

    // The trigger text becomes an inline pill — no attachment chip is added.
    await waitFor(() => {
      expect(getComposerText()).toBe('@conditions.py 记一下这个文件讲了什么东西。')
    })
    expect(document.querySelector('.composer-mention')).toHaveTextContent('@conditions.py')
    expect(screen.queryByTestId('attachment-chip')).not.toBeInTheDocument()

    fireEvent.keyDown(getComposerElement(), { key: 'Enter' })

    expect(mocks.wsSend).toHaveBeenCalledWith(sessionId, {
      type: 'user_message',
      content: '@"/repo/backend/src/conditions.py" 记一下这个文件讲了什么东西。',
      attachments: [],
    })
    const messages = useChatStore.getState().sessions[sessionId]?.messages ?? []
    expect(messages[messages.length - 1]).toMatchObject({
      type: 'user_text',
      content: '@conditions.py 记一下这个文件讲了什么东西。',
      modelContent: '@"/repo/backend/src/conditions.py" 记一下这个文件讲了什么东西。',
    })
    expect(getComposerText()).toBe('')
  })

  it('inserts queued inline workspace citations at the current cursor and keeps file context attached', async () => {
    render(<ChatInput compact />)

    setComposerText('请看实现', 2)

    act(() => {
      useChatStore.getState().queueComposerInsertion(sessionId, {
        text: '@"src/App.tsx"',
        reference: {
          kind: 'file',
          path: 'src/App.tsx',
          absolutePath: '/repo/src/App.tsx',
          name: 'App.tsx',
        },
      })
    })

    await waitFor(() => {
      expect(getComposerText()).toBe('请看 @"src/App.tsx" 实现')
    })
    expect(screen.getByText('App.tsx')).toBeInTheDocument()
    expect(useWorkspaceChatContextStore.getState().referencesBySession[sessionId]).toMatchObject([
      {
        kind: 'file',
        path: 'src/App.tsx',
        absolutePath: '/repo/src/App.tsx',
        name: 'App.tsx',
      },
    ])

    fireEvent.keyDown(getComposerElement(), { key: 'Enter' })

    expect(mocks.wsSend).toHaveBeenCalledWith(sessionId, {
      type: 'user_message',
      content: '请看 @"src/App.tsx" 实现',
      attachments: [{
        type: 'file',
        name: 'App.tsx',
        path: '/repo/src/App.tsx',
        isDirectory: undefined,
        lineStart: undefined,
        lineEnd: undefined,
        note: undefined,
        quote: undefined,
      }],
    })
    const messages = useChatStore.getState().sessions[sessionId]?.messages ?? []
    expect(messages[messages.length - 1]).toMatchObject({
      type: 'user_text',
      content: '请看 @"src/App.tsx" 实现',
      modelContent: '@"/repo/src/App.tsx" 请看 @"src/App.tsx" 实现',
      attachments: [{ name: 'App.tsx', path: 'src/App.tsx' }],
    })
  })

  it('inserts a selected @ directory as an inline mention pill and sends its absolute path', async () => {
    mocks.search.mockResolvedValueOnce({
      currentPath: '/repo',
      parentPath: '/',
      query: 'backend',
      entries: [
        { name: 'backend', path: '/repo/backend', relativePath: 'backend', isDirectory: true },
      ],
    })

    render(<ChatInput compact />)

    setComposerText('@backend 讲一下这个目录。', '@backend'.length)

    fireEvent.click(await screen.findByRole('option', { name: /backend/i }))

    await waitFor(() => {
      expect(getComposerText()).toBe('@backend/ 讲一下这个目录。')
    })
    const pill = document.querySelector('.composer-mention')
    expect(pill).toHaveTextContent('@backend/')
    expect(pill).toHaveAttribute('data-mention-path', '/repo/backend')

    fireEvent.keyDown(getComposerElement(), { key: 'Enter' })

    expect(mocks.wsSend).toHaveBeenCalledWith(sessionId, {
      type: 'user_message',
      content: '@"/repo/backend" 讲一下这个目录。',
      attachments: [],
    })
    const messages = useChatStore.getState().sessions[sessionId]?.messages ?? []
    expect(messages[messages.length - 1]).toMatchObject({
      type: 'user_text',
      content: '@backend/ 讲一下这个目录。',
      modelContent: '@"/repo/backend" 讲一下这个目录。',
    })
  })

  it('serializes only the pill when the same token also exists as literal text', async () => {
    mocks.search.mockResolvedValueOnce({
      currentPath: '/repo',
      parentPath: '/',
      query: 'main',
      entries: [
        { name: 'main.ts', path: '/repo/src/main.ts', isDirectory: false },
      ],
    })

    render(<ChatInput compact />)

    // The first `@main.ts` is literal text the user typed; only the second
    // one goes through the picker and becomes a pill.
    setComposerText('@main.ts 对比 @main', '@main.ts 对比 @main'.length)
    fireEvent.click(await screen.findByRole('option', { name: /main\.ts/ }))

    await waitFor(() => {
      expect(getComposerText()).toBe('@main.ts 对比 @main.ts ')
    })
    expect(document.querySelectorAll('.composer-mention')).toHaveLength(1)

    fireEvent.keyDown(getComposerElement(), { key: 'Enter' })

    // The literal occurrence stays verbatim; the pill — and only the pill —
    // becomes the @"absolute path" form.
    expect(mocks.wsSend).toHaveBeenCalledWith(sessionId, {
      type: 'user_message',
      content: '@main.ts 对比 @"/repo/src/main.ts"',
      attachments: [],
    })
  })

  it('deletes a mention pill atomically with Backspace', async () => {
    mocks.search.mockResolvedValueOnce({
      currentPath: '/repo',
      parentPath: '/',
      query: 'backend',
      entries: [
        { name: 'backend', path: '/repo/backend', relativePath: 'backend', isDirectory: true },
      ],
    })

    render(<ChatInput compact />)

    setComposerText('看下 @backend 这个目录', '看下 @backend'.length)
    fireEvent.click(await screen.findByRole('option', { name: /backend/i }))

    await waitFor(() => {
      expect(getComposerText()).toBe('看下 @backend/ 这个目录')
    })

    // Keep the caret exactly where the real picker transition placed it:
    // after the separator space that insertion adds behind the atom. One
    // Backspace must remove that insertion unit, not consume the invisible
    // separator first and make the user press Backspace a second time.
    fireEvent.keyDown(getComposerElement(), { key: 'Backspace' })
    expect(getComposerText()).toBe('看下 这个目录')
    expect(document.querySelector('.composer-mention')).not.toBeInTheDocument()

    // Nothing to serialize any more: the path is gone from the model text too.
    fireEvent.keyDown(getComposerElement(), { key: 'Enter' })
    expect(mocks.wsSend).toHaveBeenCalledWith(sessionId, {
      type: 'user_message',
      content: '看下 这个目录',
      attachments: [],
    })
  })

  it('uses native desktop file paths instead of inlining selected files', async () => {
    installElectronFileHost()
    mocks.dialogOpen.mockResolvedValueOnce([
      '/Users/nanmi/tmp/large-a.log',
      'C:\\Users\\Nanmi\\Desktop\\large-b.zip',
    ])

    render(<ChatInput compact />)

    fireEvent.click(screen.getByLabelText('Open composer tools'))
    fireEvent.click(screen.getByText('Add files or photos'))

    expect(await screen.findByText('large-a.log')).toBeInTheDocument()
    expect(await screen.findByText('large-b.zip')).toBeInTheDocument()

    const input = getComposerElement()
    setComposerText('analyze these', 'analyze these'.length)
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(mocks.wsSend).toHaveBeenCalledWith(sessionId, {
      type: 'user_message',
      content: 'analyze these',
      attachments: [
        expect.objectContaining({
          type: 'file',
          name: 'large-a.log',
          path: '/Users/nanmi/tmp/large-a.log',
          data: undefined,
        }),
        expect.objectContaining({
          type: 'file',
          name: 'large-b.zip',
          path: 'C:\\Users\\Nanmi\\Desktop\\large-b.zip',
          data: undefined,
        }),
      ],
    })
  })

  it('accepts native desktop file drops on the active session composer as path-only attachments', async () => {
    installElectronFileHost()

    render(<ChatInput compact />)

    const panel = screen.getByTestId('chat-input-panel')
    Object.defineProperty(panel, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({
        left: 0,
        top: 0,
        right: 640,
        bottom: 180,
        width: 640,
        height: 180,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }),
    })

    await waitFor(() => {
      expect(mocks.webviewDragHandlers).toHaveLength(1)
    })

    act(() => {
      mocks.webviewDragHandlers[0]?.({
        payload: { type: 'over', position: { x: 24, y: 24 } },
      })
    })
    expect(screen.getByTestId('chat-input-drop-overlay')).toBeInTheDocument()

    act(() => {
      mocks.webviewDragHandlers[0]?.({
        payload: {
          type: 'drop',
          position: { x: 24, y: 24 },
          paths: ['/Users/nanmi/drop/large-a.log'],
        },
      })
    })

    expect(await screen.findByText('large-a.log')).toBeInTheDocument()
    expect(screen.queryByTestId('chat-input-drop-overlay')).not.toBeInTheDocument()

    const input = getComposerElement()
    setComposerText('analyze dropped file', 'analyze dropped file'.length)
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(mocks.wsSend).toHaveBeenCalledWith(sessionId, {
      type: 'user_message',
      content: 'analyze dropped file',
      attachments: [
        expect.objectContaining({
          type: 'file',
          name: 'large-a.log',
          path: '/Users/nanmi/drop/large-a.log',
          data: undefined,
        }),
      ],
    })
  })

  it('pastes copied desktop files into the active session as path-only attachments', async () => {
    installElectronFileHost()
    const copiedFile = new File(['# Project notes'], 'ignored-name.md', { type: 'text/markdown' })
    Object.defineProperty(copiedFile, 'path', {
      configurable: true,
      value: 'C:\\Users\\Nanmi\\Desktop\\project-notes.md',
    })

    render(<ChatInput compact />)

    const input = getComposerElement()
    fireEvent.paste(input, {
      clipboardData: {
        files: [],
        // ProseMirror reads text data before consulting our paste handler, so
        // the stub has to answer like a real DataTransfer.
        getData: () => '',
        items: [{
          kind: 'file',
          type: 'text/markdown',
          getAsFile: () => copiedFile,
        }],
      },
    })

    expect(await screen.findByText('project-notes.md')).toBeInTheDocument()

    setComposerText('review this document', 'review this document'.length)
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(mocks.wsSend).toHaveBeenCalledWith(sessionId, {
      type: 'user_message',
      content: 'review this document',
      attachments: [
        expect.objectContaining({
          type: 'file',
          name: 'project-notes.md',
          path: 'C:\\Users\\Nanmi\\Desktop\\project-notes.md',
          data: undefined,
        }),
      ],
    })
  })

  it('preserves Feishu-style paragraph breaks when pasting text', async () => {
    render(<ChatInput compact />)

    const input = getComposerElement()
    fireEvent.paste(input, {
      clipboardData: {
        files: [],
        items: [],
        types: ['text/plain', 'text/html'],
        getData: (type: string) => {
          if (type === 'text/plain') return '第一行\r\n第二行\r\n\r\n第四行'
          if (type === 'text/html') {
            return '<div><span>第一行</span></div><div><span>第二行</span></div><div><br></div><div><span>第四行</span></div>'
          }
          return ''
        },
      },
    })

    await waitFor(() => {
      expect(getComposerText()).toBe('第一行\n第二行\n\n第四行')
    })
  })

  it('ignores pasted files that finish loading after the prompt was sent', async () => {
    class DeferredFileReader {
      result: string | ArrayBuffer | null = null
      onload: ((event: ProgressEvent<FileReader>) => void) | null = null

      readAsDataURL(file: Blob) {
        pendingReaders.push({ reader: this, file })
      }
    }
    const pendingReaders: Array<{ reader: DeferredFileReader; file: Blob }> = []
    vi.stubGlobal('FileReader', DeferredFileReader)

    render(<ChatInput compact />)

    const input = getComposerElement()
    const file = new File(['image'], 'late.png', { type: 'image/png' })

    fireEvent.paste(input, {
      clipboardData: {
        files: [],
        // ProseMirror reads text data before consulting our paste handler, so
        // the stub has to answer like a real DataTransfer.
        getData: () => '',
        items: [{
          kind: 'file',
          type: 'image/png',
          getAsFile: () => file,
        }],
      },
    })
    expect(pendingReaders).toHaveLength(1)

    setComposerText('send now', 'send now'.length)
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(mocks.wsSend).toHaveBeenCalledWith(sessionId, {
      type: 'user_message',
      content: 'send now',
      attachments: [],
    })

    act(() => {
      pendingReaders[0]!.reader.result = 'data:image/png;base64,LATE'
      pendingReaders[0]!.reader.onload?.({} as ProgressEvent<FileReader>)
    })

    await waitFor(() => {
      expect(screen.queryByAltText(/pasted-image-/)).not.toBeInTheDocument()
    })
  })

  it('keeps slash and @ popovers outside the drop target clipping context', async () => {
    mocks.search.mockResolvedValueOnce({
      currentPath: '/repo',
      parentPath: null,
      query: '',
      entries: [
        { name: 'README.md', path: '/repo/README.md', isDirectory: false },
      ],
    })

    render(<ChatInput compact />)

    const panel = screen.getByTestId('chat-input-panel')

    setComposerText('/', 1)
    expect(await screen.findByText('mcp')).toBeInTheDocument()
    expect(panel).toHaveClass('overflow-visible')
    expect(panel).not.toHaveClass('overflow-hidden')

    setComposerText('@readme', 7)
    expect(await screen.findByText('README.md')).toBeInTheDocument()
    expect(panel).toHaveClass('overflow-visible')
    expect(panel).not.toHaveClass('overflow-hidden')
  })

  it('uses larger icon-only mobile action buttons for browser H5 access', async () => {
    viewportMocks.isMobile = true
    mocks.search.mockResolvedValueOnce({
      currentPath: '/repo',
      parentPath: null,
      query: 'cond',
      entries: [
        { name: 'conditions.py', path: '/repo/conditions.py', isDirectory: false },
      ],
    })

    render(<ChatInput />)

    await waitFor(() => {
      expect(mocks.getGitInfo).toHaveBeenCalledWith(sessionId)
    })

    setComposerText('ship it', 7)

    expect(screen.getByRole('button', { name: 'Open composer tools' })).toHaveClass('h-11', 'w-11')
    expect(screen.getByRole('button', { name: 'Run' })).toHaveClass('h-11', 'w-11')
    expect(screen.queryByText('Run')).not.toBeInTheDocument()
    expect(screen.getByTestId('chat-input-shell')).toHaveClass('px-3')
    expect(screen.getByTestId('chat-input-shell').className).toContain('safe-area-inset-bottom')
    // `glass-panel--composer` carries the composer step of the shadow scale.
    // The phone branch used to swap it for a `shadow-[…]` utility, which loses
    // to `.glass-panel`'s own `box-shadow` on stylesheet order — so the phone
    // composer silently rendered the floating-overlay shadow instead.
    expect(screen.getByTestId('chat-input-panel')).toHaveClass('glass-panel--composer')
    expect(screen.getByTestId('chat-input-panel')).toHaveClass('rounded-[var(--radius-2xl)]')
    expect(screen.getByTestId('chat-input-panel')).not.toHaveClass('rounded-b-none')
    expect(screen.getByTestId('chat-input-toolbar-leading')).toHaveClass('shrink-0', 'gap-1')
    expect(screen.getByTestId('chat-input-toolbar-trailing')).toHaveClass('min-w-0', 'flex-1', 'justify-end', 'gap-1')
    expect(screen.getByTestId('model-selector-shell')).toHaveClass('min-w-0', 'flex-1')

    setComposerText('@cond', 5)

    expect(await screen.findByText('conditions.py')).toBeInTheDocument()
    const fileSearchMenu = document.getElementById('file-search-menu')
    expect(fileSearchMenu).toHaveClass('min-w-0')
    expect(fileSearchMenu).not.toHaveClass('min-w-[480px]')
    expect(fileSearchMenu).not.toHaveTextContent('Navigate')
  })

  it('keeps the active-session toolbar in flow so multiline caret cannot render behind controls', async () => {
    render(<ChatInput />)

    await waitFor(() => {
      expect(mocks.getGitInfo).toHaveBeenCalledWith(sessionId)
    })

    const input = screen.getByRole('textbox')
    const toolbar = screen.getByTestId('chat-input-toolbar')

    expect(toolbar).not.toHaveClass('absolute')
    expect(toolbar).toHaveClass('mt-3')
    expect(input).not.toHaveClass('pb-12')
    expect(input).not.toHaveClass('pb-14')
  })

  // The draft and the live session render the same composer, so the row that
  // carries the location, the permission mode and the model has to sit in the
  // same place in both. The live one used to weld itself to the panel edge
  // with `-mx-4 -mb-4`, which pulled every control 4px left and stretched the
  // divider across the panel the moment the first message landed.
  it('keeps the wide composer toolbar inset when a draft turns into a live session', async () => {
    const { unmount } = render(<ChatInput variant="hero" />)

    const draftToolbar = screen.getByTestId('chat-input-toolbar')
    expect(draftToolbar).toHaveClass('pt-3')
    expect(draftToolbar.className).not.toMatch(/-m[xy]-\d/)
    unmount()

    const live = render(<ChatInput variant="default" />)

    const liveToolbar = screen.getByTestId('chat-input-toolbar')
    expect(liveToolbar).toHaveClass('pt-3')
    expect(liveToolbar.className).not.toMatch(/-m[xy]-\d/)
    live.unmount()

    // The narrow composer keeps the band: `p-3` leaves too little room to
    // spend on inset, and it never swaps variants mid-session.
    render(<ChatInput compact />)

    expect(screen.getByTestId('chat-input-toolbar')).toHaveClass('-mx-3')
  })

  it('uses Shift+Enter for a newline when Enter is the configured send shortcut', async () => {
    useSettingsStore.setState({
      chatSendBehavior: 'enter',
    })

    render(<ChatInput />)

    await waitFor(() => {
      expect(mocks.getGitInfo).toHaveBeenCalledWith(sessionId)
    })

    const input = getComposerElement()
    setComposerText('firstsecond', 5)

    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true })

    expect(mocks.wsSend).not.toHaveBeenCalled()
    expect(getComposerText()).toBe('first\nsecond')

    fireEvent.keyDown(input, { key: 'Enter' })
    expect(mocks.wsSend).toHaveBeenCalledWith(sessionId, {
      type: 'user_message',
      content: 'first\nsecond',
      attachments: [],
    })
  })

  it.each([
    ['Ctrl+Enter', { ctrlKey: true }],
    ['Command+Enter', { metaKey: true }],
  ])('uses Enter or Shift+Enter for newlines and %s to send when configured', async (_shortcut, modifier) => {
    useSettingsStore.setState({
      chatSendBehavior: 'modifierEnter',
    })

    render(<ChatInput />)

    await waitFor(() => {
      expect(mocks.getGitInfo).toHaveBeenCalledWith(sessionId)
    })

    const input = getComposerElement()
    setComposerText('firstsecond', 5)

    fireEvent.keyDown(input, { key: 'Enter' })
    expect(mocks.wsSend).not.toHaveBeenCalled()
    expect(getComposerText()).toBe('first\nsecond')

    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true })
    expect(mocks.wsSend).not.toHaveBeenCalled()
    expect(getComposerText()).toBe('first\n\nsecond')

    fireEvent.keyDown(input, { key: 'Enter', ...modifier })
    expect(mocks.wsSend).toHaveBeenCalledWith(sessionId, {
      type: 'user_message',
      content: 'first\n\nsecond',
      attachments: [],
    })
  })

  it('opens the model selector for /model without sending a user message', async () => {
    useSettingsStore.setState({
      chatSendBehavior: 'enter',
    })

    render(<ChatInput />)

    await waitFor(() => {
      expect(mocks.getGitInfo).toHaveBeenCalledWith(sessionId)
    })

    const input = getComposerElement()
    setComposerText('/model', 6)

    fireEvent.keyDown(input, { key: 'Enter' })

    expect(mocks.wsSend).not.toHaveBeenCalled()
    expect(await screen.findByTestId('model-selector-dropdown')).toHaveTextContent('Model selector opened')
    expect(getComposerText()).toBe('')
  })

  it('opens actionable /save-workflow help locally without creating a silent user turn', async () => {
    useSettingsStore.setState({ chatSendBehavior: 'enter' })
    render(<ChatInput />)

    const beforeMessages = useChatStore.getState().sessions[sessionId]!.messages
    setComposerText('/save-workflow', '/save-workflow'.length)
    fireEvent.keyDown(getComposerElement(), { key: 'Enter' })

    expect(mocks.wsSend).not.toHaveBeenCalled()
    expect(await screen.findByText('Save workflow')).toBeInTheDocument()
    expect(screen.getByText(/Complete a workflow in this session/)).toBeInTheDocument()
    expect(useChatStore.getState().sessions[sessionId]!.messages).toBe(beforeMessages)
    expect(getComposerText()).toBe('')
  })

  it('saves a completed runtime workflow through the composer command', async () => {
    useSettingsStore.setState({ chatSendBehavior: 'enter' })
    const runId = 'wf_save-flow-abc'
    act(() => {
      const handle = useChatStore.getState().handleServerMessage
      handle(sessionId, {
        type: 'system_notification',
        subtype: 'task_started',
        data: {
          task_id: 'workflow-save-flow',
          task_type: 'local_workflow',
          workflow_name: 'generated-audit',
          workflow_run_id: runId,
        },
      })
      handle(sessionId, {
        type: 'system_notification',
        subtype: 'task_progress',
        data: {
          task_id: 'workflow-save-flow',
          workflow_run_id: runId,
          workflow_progress: [
            { type: 'workflow_phase', index: 1, title: 'Scan' },
            {
              type: 'workflow_agent',
              index: 1,
              label: 'scan routes',
              state: 'done',
              phaseIndex: 1,
              agentId: 'agent-save-flow',
            },
          ],
        },
      })
      handle(sessionId, {
        type: 'system_notification',
        subtype: 'task_notification',
        data: {
          task_id: 'workflow-save-flow',
          workflow_run_id: runId,
          status: 'completed',
        },
      })
    })

    const script = [
      "export const meta = { name: 'generated-audit', description: 'Audit routes' }",
      "return await agent('scan routes')",
    ].join('\n')
    const getRun = vi.spyOn(workflowsApi, 'getRun').mockResolvedValue({
      runId,
      sessionId,
      workflowName: 'generated-audit',
      scriptPath: '/tmp/generated-audit.js',
      startedAt: 1,
      completedAgents: 1,
      status: 'completed',
      script,
      agents: [],
    })
    const save = vi.spyOn(workflowsApi, 'save').mockResolvedValue({
      ok: true,
      name: 'release-audit',
      filePath: '/repo/.claude/workflows/release-audit.js',
    })

    render(<ChatInput />)
    setComposerText('/save-workflow', '/save-workflow'.length)
    fireEvent.keyDown(getComposerElement(), { key: 'Enter' })

    await waitFor(() => expect(getRun).toHaveBeenCalledWith(sessionId, runId))
    fireEvent.change(
      await screen.findByRole('textbox', { name: 'Command name' }),
      { target: { value: 'release-audit' } },
    )
    fireEvent.click(screen.getByRole('button', { name: 'Save workflow' }))

    await waitFor(() => {
      expect(save).toHaveBeenCalledWith(
        script,
        'project',
        '/repo',
        'release-audit',
      )
    })
    expect(await screen.findByText(/Start a new session and run \/release-audit/)).toBeInTheDocument()
    expect(mocks.wsSend).not.toHaveBeenCalledWith(
      sessionId,
      expect.objectContaining({ type: 'user_message' }),
    )
  })

  it('prioritizes active-session slash commands by command name when filtering', async () => {
    useChatStore.setState({
      sessions: {
        [sessionId]: {
          ...useChatStore.getState().sessions[sessionId]!,
          slashCommands: [
            {
              name: 'agent-team-orchestrator',
              description: 'Agent Teams can use Subagent orchestration.',
              kind: 'skill',
              source: 'user',
            },
            {
              name: 'lark-calendar',
              description: 'Includes suggestion helpers.',
              kind: 'skill',
              source: 'user',
            },
            {
              name: 'superpowers:brainstorming',
              description: 'Creative work planning.',
              kind: 'skill',
              source: 'user',
            },
          ],
        },
      },
    })

    render(<ChatInput />)

    await waitFor(() => {
      expect(mocks.getGitInfo).toHaveBeenCalledWith(sessionId)
    })

    setComposerText('/su', 3)

    await waitFor(() => {
      const commandButtons = screen
        .getAllByRole('option')
        .filter((option) => option.textContent?.includes('Creative work planning.'))
      expect(commandButtons[0]).toHaveTextContent('superpowers:brainstorming')
      expect(commandButtons[0]).toHaveTextContent('Personal')
    })
  })

  it('groups commands before skills and shows each skill source accurately', async () => {
    useChatStore.setState({
      sessions: {
        [sessionId]: {
          ...useChatStore.getState().sessions[sessionId]!,
          slashCommands: [
            {
              name: 'future-native-command',
              description: 'A CLI command unknown to this desktop build.',
              kind: 'command',
            },
            {
              name: 'audit',
              description: 'Audit product UX.',
              kind: 'skill',
              source: 'project',
            },
            {
              name: 'drawing:render',
              description: 'Render an illustration.',
              kind: 'skill',
              source: 'plugin',
            },
          ],
        },
      },
    })

    render(<ChatInput />)

    setComposerText('/', 1)

    const systemCommand = await screen.findByText('mcp')
    const futureNativeCommand = screen.getByText('future-native-command')
    const skillsHeading = screen.getByText('Skills')
    const projectSkill = screen.getByText('audit')
    const pluginSkill = screen.getByText('drawing:render')
    const listbox = screen.getByRole('listbox', { name: 'Slash commands' })
    const combobox = screen.getByRole('combobox')

    expect(systemCommand.compareDocumentPosition(skillsHeading)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    )
    expect(futureNativeCommand.compareDocumentPosition(skillsHeading)).toBe(
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

    render(<ChatInput />)

    await waitFor(() => {
      expect(mocks.listAgents).toHaveBeenCalledWith('/repo')
    })

    setComposerText('/debug', 6)

    const agentOption = await screen.findByText('agent debugger')
    fireEvent.click(agentOption)

    expect(getComposerText()).toBe('/agent debugger ')
  })

  it('selects a highlighted agent entry from /agent without sending until the configured send shortcut is used', async () => {
    useSettingsStore.setState({
      chatSendBehavior: 'modifierEnter',
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

    render(<ChatInput />)

    await waitFor(() => {
      expect(mocks.listAgents).toHaveBeenCalledWith('/repo')
    })

    const input = getComposerElement()
    setComposerText('/agent', 6)

    await screen.findByText('agent debugger')
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(getComposerText()).toBe('/agent debugger ')
    expect(mocks.wsSend).not.toHaveBeenCalled()

    const prompt = '/agent debugger investigate this failure'
    setComposerText(prompt, prompt.length)
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(mocks.wsSend).not.toHaveBeenCalled()

    fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true })
    expect(mocks.wsSend).toHaveBeenCalledWith(sessionId, {
      type: 'user_message',
      content: prompt,
      attachments: [],
    })
  })

  it('highlights only actionable ultracode tokens and follows the persisted setting in both directions', async () => {
    const updateUser = vi.spyOn(settingsApi, 'updateUser').mockResolvedValue({ ok: true })

    try {
      render(<ChatInput />)

      const highlightedKeywords = () =>
        Array.from(document.querySelectorAll('[data-workflow-keyword="true"]'))
          .map((element) => element.textContent)

      const complexPrompt = 'ultracode：audit routes, error propagation, and missing tests with several agents'
      setComposerText(complexPrompt, complexPrompt.length)
      await waitFor(() => {
        expect(highlightedKeywords()).toEqual(['ultracode'])
      })

      for (const literalPrompt of [
        '```text\nultracode\n```',
        'explain "ultracode" without running it',
        'open docs/ultracode/readme.md',
        'pass --ultracode to the CLI',
        'inspect the ultracode-runner package',
      ]) {
        setComposerText(literalPrompt, literalPrompt.length)
        await waitFor(() => {
          expect(highlightedKeywords()).toEqual([])
        })
      }

      setComposerText(complexPrompt, complexPrompt.length)
      await waitFor(() => {
        expect(highlightedKeywords()).toEqual(['ultracode'])
      })

      await act(async () => {
        await useSettingsStore.getState().setWorkflowKeywordTriggerEnabled(false)
      })
      await waitFor(() => {
        expect(highlightedKeywords()).toEqual([])
      })

      await act(async () => {
        await useSettingsStore.getState().setWorkflowKeywordTriggerEnabled(true)
      })
      await waitFor(() => {
        expect(highlightedKeywords()).toEqual(['ultracode'])
      })

      fireEvent.click(screen.getByRole('button', { name: 'Run' }))
      expect(mocks.wsSend).toHaveBeenCalledWith(sessionId, {
        type: 'user_message',
        content: complexPrompt,
        attachments: [],
      })
      expect(updateUser).toHaveBeenNthCalledWith(1, { workflowKeywordTriggerEnabled: false })
      expect(updateUser).toHaveBeenNthCalledWith(2, { workflowKeywordTriggerEnabled: true })
    } finally {
      updateUser.mockRestore()
    }
  })
})
