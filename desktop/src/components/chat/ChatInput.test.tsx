import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom'
import { act } from 'react'

const viewportMocks = vi.hoisted(() => ({
  isMobile: false,
}))

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  delete: vi.fn(),
  list: vi.fn(),
  getMessages: vi.fn(),
  getGitInfo: vi.fn(),
  getSlashCommands: vi.fn(),
  listAgents: vi.fn(),
  getRepositoryContext: vi.fn(),
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
    onMessage: vi.fn(() => () => {}),
    clearHandlers: vi.fn(),
    send: mocks.wsSend,
  },
}))

vi.mock('../../hooks/useMobileViewport', () => ({
  useMobileViewport: () => viewportMocks.isMobile,
}))

vi.mock('../controls/PermissionModeSelector', () => ({
  PermissionModeSelector: () => <button type="button">Permissions</button>,
}))

vi.mock('../controls/ModelSelector', () => ({
  ModelSelector: () => <button type="button">Model</button>,
}))

import { ChatInput } from './ChatInput'
import { useChatStore } from '../../stores/chatStore'
import { useSessionStore } from '../../stores/sessionStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { useTabStore } from '../../stores/tabStore'
import { useWorkspaceChatContextStore } from '../../stores/workspaceChatContextStore'
import { browserHost } from '../../lib/desktopHost/browserHost'

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
    mocks.webviewDragHandlers.length = 0
    Reflect.deleteProperty(window, 'desktopHost')
    delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
    viewportMocks.isMobile = false
    useSettingsStore.setState({ locale: 'en' })
    useChatStore.setState(initialChatState, true)
    useSessionStore.setState(initialSessionState, true)
    useTabStore.setState(initialTabState, true)
    useWorkspaceChatContextStore.setState(initialWorkspaceContextState, true)

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

    const input = screen.getByRole('textbox') as HTMLTextAreaElement
    fireEvent.change(input, {
      target: { value: 'new tab draft', selectionStart: 13 },
    })
    expect(input.value).toBe('new tab draft')

    act(() => {
      useTabStore.setState({ activeTabId: historySessionId })
    })

    await waitFor(() => {
      expect(input.value).toBe('')
    })

    fireEvent.change(input, {
      target: { value: 'history tab draft', selectionStart: 17 },
    })

    act(() => {
      useTabStore.setState({ activeTabId: sessionId })
    })

    await waitFor(() => {
      expect(input.value).toBe('new tab draft')
    })

    act(() => {
      useTabStore.setState({ activeTabId: historySessionId })
    })

    await waitFor(() => {
      expect(input.value).toBe('history tab draft')
    })
  })

  it('restores an unsent composer draft after the composer unmounts', async () => {
    const { unmount } = render(<ChatInput compact />)

    const input = screen.getByRole('textbox') as HTMLTextAreaElement
    fireEvent.change(input, {
      target: { value: 'keep this prompt while I inspect another tab', selectionStart: 43 },
    })
    expect(input.value).toBe('keep this prompt while I inspect another tab')

    unmount()
    render(<ChatInput compact />)

    await waitFor(() => {
      expect(screen.getByRole('textbox')).toHaveValue('keep this prompt while I inspect another tab')
    })
  })

  it('appends a delayed browser screenshot without clearing an unsent draft after remount', async () => {
    const { unmount } = render(<ChatInput compact />)

    const input = screen.getByRole('textbox') as HTMLTextAreaElement
    fireEvent.change(input, {
      target: { value: 'draft written while the agent is still running', selectionStart: 44 },
    })
    expect(input.value).toBe('draft written while the agent is still running')

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
      expect(screen.getByRole('textbox')).toHaveValue('draft written while the agent is still running')
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

    const input = screen.getByRole('textbox') as HTMLTextAreaElement
    fireEvent.change(input, {
      target: { value: 'please adjust the current direction', selectionStart: 35 },
    })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(mocks.wsSend).not.toHaveBeenCalledWith(sessionId, expect.objectContaining({
      type: 'user_message',
    }))
    expect(input.value).toBe('')
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

    const input = screen.getByRole('textbox') as HTMLTextAreaElement
    fireEvent.change(input, {
      target: { value: 'first queued draft', selectionStart: 18 },
    })
    fireEvent.keyDown(input, { key: 'Enter' })

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

    const input = screen.getByRole('textbox') as HTMLTextAreaElement
    fireEvent.change(input, {
      target: { value: 'continue after completion', selectionStart: 25 },
    })
    fireEvent.keyDown(input, { key: 'Enter' })

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
    expect(panel).toHaveClass('rounded-xl')
    expect(panel).not.toHaveClass('rounded-b-none')

    expect(await screen.findByRole('button', { name: /Select branch: main/ })).toBeInTheDocument()
    expect(screen.getByText('Current worktree')).toBeInTheDocument()
    expect(screen.queryByText('Select a project...')).not.toBeInTheDocument()
    const branchButton = screen.getByRole('button', { name: /Select branch: main/ })
    expect(panel).toContainElement(branchButton.parentElement)
    expect(branchButton.parentElement).toHaveClass('bg-transparent')
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
    mocks.create.mockResolvedValueOnce({ sessionId: 'created-direct', workDir: '/repo' })
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

    fireEvent.click(await screen.findByRole('button', { name: /Select branch: main/ }))
    fireEvent.click(await screen.findByRole('option', { name: /feature\/a/ }))
    const input = screen.getByRole('textbox') as HTMLTextAreaElement
    fireEvent.change(input, { target: { value: 'run on feature branch', selectionStart: 21 } })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => {
      expect(mocks.create).toHaveBeenCalledWith({
        workDir: '/repo',
        repository: { branch: 'feature/a', worktree: false },
      })
    })
    expect(mocks.delete).toHaveBeenCalledWith(sessionId)
    expect(mocks.wsSend).toHaveBeenCalledWith('created-direct', {
      type: 'user_message',
      content: 'run on feature branch',
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

    fireEvent.click(await screen.findByRole('button', { name: /Select branch: main/ }))
    fireEvent.click(await screen.findByRole('option', { name: /feature\/a/ }))
    fireEvent.click(screen.getByRole('button', { name: /Select worktree mode: Current worktree/ }))
    fireEvent.click(await screen.findByRole('option', { name: 'Isolated worktree' }))
    expect(screen.getByText('Isolated worktree')).toBeInTheDocument()
    const input = screen.getByRole('textbox') as HTMLTextAreaElement
    fireEvent.change(input, { target: { value: 'run in a worktree', selectionStart: 17 } })
    fireEvent.keyDown(input, { key: 'Enter' })

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

  it('turns a selected @ file into a chip without corrupting the typed path', async () => {
    mocks.search.mockResolvedValueOnce({
      currentPath: '/repo/backend/src',
      parentPath: '/repo/backend',
      query: 'conditions.py',
      entries: [
        { name: 'conditions.py', path: '/repo/backend/src/conditions.py', isDirectory: false },
      ],
    })

    render(<ChatInput compact />)

    const input = screen.getByRole('textbox') as HTMLTextAreaElement
    const mention = '@backend/src/conditions.py'
    fireEvent.change(input, {
      target: {
        value: `${mention} 记一下这个文件讲了什么东西。`,
        selectionStart: mention.length,
      },
    })

    fireEvent.click(await screen.findByText('backend/src/conditions.py'))

    await waitFor(() => {
      expect(input.value).toBe('记一下这个文件讲了什么东西。')
    })
    expect(screen.getByText('conditions.py')).toBeInTheDocument()

    fireEvent.keyDown(input, { key: 'Enter' })

    expect(mocks.wsSend).toHaveBeenCalledWith(sessionId, {
      type: 'user_message',
      content: '记一下这个文件讲了什么东西。',
      attachments: [{
        type: 'file',
        name: 'conditions.py',
        path: '/repo/backend/src/conditions.py',
        isDirectory: false,
        lineStart: undefined,
        lineEnd: undefined,
        note: undefined,
        quote: undefined,
      }],
    })
    const messages = useChatStore.getState().sessions[sessionId]?.messages ?? []
    expect(messages[messages.length - 1]).toMatchObject({
      type: 'user_text',
      content: '记一下这个文件讲了什么东西。',
      modelContent: '@"/repo/backend/src/conditions.py" 记一下这个文件讲了什么东西。',
      attachments: [{ name: 'conditions.py', path: '/repo/backend/src/conditions.py' }],
    })
  })

  it('inserts queued inline workspace citations at the current cursor and keeps file context attached', async () => {
    render(<ChatInput compact />)

    const input = screen.getByRole('textbox') as HTMLTextAreaElement
    fireEvent.change(input, {
      target: {
        value: '请看实现',
        selectionStart: 2,
        selectionEnd: 2,
      },
    })
    input.setSelectionRange(2, 2)

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
      expect(input.value).toBe('请看 @"src/App.tsx" 实现')
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

    fireEvent.keyDown(input, { key: 'Enter' })

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

  it('turns a selected @ directory into a workspace chip and model path reference', async () => {
    mocks.search.mockResolvedValueOnce({
      currentPath: '/repo',
      parentPath: '/',
      query: 'backend',
      entries: [
        { name: 'backend', path: '/repo/backend', relativePath: 'backend', isDirectory: true },
      ],
    })

    render(<ChatInput compact />)

    const input = screen.getByRole('textbox') as HTMLTextAreaElement
    fireEvent.change(input, {
      target: {
        value: '@backend 讲一下这个目录。',
        selectionStart: '@backend'.length,
      },
    })

    fireEvent.click(await screen.findByRole('option', { name: /backend/i }))

    await waitFor(() => {
      expect(input.value).toBe('讲一下这个目录。')
    })
    expect(screen.getByText('backend/')).toBeInTheDocument()
    expect(screen.getByText('folder')).toBeInTheDocument()

    fireEvent.keyDown(input, { key: 'Enter' })

    expect(mocks.wsSend).toHaveBeenCalledWith(sessionId, {
      type: 'user_message',
      content: '讲一下这个目录。',
      attachments: [{
        type: 'file',
        name: 'backend/',
        path: '/repo/backend',
        isDirectory: true,
        lineStart: undefined,
        lineEnd: undefined,
        note: undefined,
        quote: undefined,
      }],
    })
    const messages = useChatStore.getState().sessions[sessionId]?.messages ?? []
    expect(messages[messages.length - 1]).toMatchObject({
      type: 'user_text',
      content: '讲一下这个目录。',
      modelContent: '@"/repo/backend" 讲一下这个目录。',
      attachments: [{ name: 'backend/', path: '/repo/backend' }],
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

    const input = screen.getByRole('textbox') as HTMLTextAreaElement
    fireEvent.change(input, {
      target: {
        value: 'analyze these',
        selectionStart: 'analyze these'.length,
      },
    })
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

    const input = screen.getByRole('textbox') as HTMLTextAreaElement
    fireEvent.change(input, {
      target: {
        value: 'analyze dropped file',
        selectionStart: 'analyze dropped file'.length,
      },
    })
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
    const input = screen.getByRole('textbox') as HTMLTextAreaElement

    fireEvent.change(input, {
      target: {
        value: '/',
        selectionStart: 1,
      },
    })
    expect(await screen.findByText('/mcp')).toBeInTheDocument()
    expect(panel).toHaveClass('overflow-visible')
    expect(panel).not.toHaveClass('overflow-hidden')

    fireEvent.change(input, {
      target: {
        value: '@readme',
        selectionStart: 7,
      },
    })
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

    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: 'ship it', selectionStart: 7 },
    })

    expect(screen.getByRole('button', { name: 'Open composer tools' })).toHaveClass('h-11', 'w-11')
    expect(screen.getByRole('button', { name: 'Run' })).toHaveClass('h-11', 'w-11')
    expect(screen.queryByText('Run')).not.toBeInTheDocument()
    expect(screen.getByTestId('chat-input-shell')).toHaveClass('px-3')
    expect(screen.getByTestId('chat-input-shell').className).toContain('safe-area-inset-bottom')
    expect(screen.getByTestId('chat-input-panel')).toHaveClass('rounded-2xl')
    expect(screen.getByTestId('chat-input-panel')).not.toHaveClass('rounded-b-none')

    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: '@cond', selectionStart: 5 },
    })

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
    expect(toolbar).toHaveClass('mt-2')
    expect(input).not.toHaveClass('pb-12')
    expect(input).not.toHaveClass('pb-14')
  })

  it('uses Ctrl or Command Enter to send when that composer preference is selected', async () => {
    useSettingsStore.setState({
      chatSendBehavior: 'modifierEnter',
    })

    render(<ChatInput />)

    await waitFor(() => {
      expect(mocks.getGitInfo).toHaveBeenCalledWith(sessionId)
    })

    const input = screen.getByRole('textbox') as HTMLTextAreaElement
    fireEvent.change(input, {
      target: {
        value: 'avoid accidental sends',
        selectionStart: 'avoid accidental sends'.length,
      },
    })

    fireEvent.keyDown(input, { key: 'Enter' })
    expect(mocks.wsSend).not.toHaveBeenCalled()

    fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true })
    expect(mocks.wsSend).toHaveBeenCalledWith(sessionId, {
      type: 'user_message',
      content: 'avoid accidental sends',
      attachments: [],
    })
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
            },
            {
              name: 'lark-calendar',
              description: 'Includes suggestion helpers.',
            },
            {
              name: 'superpowers:brainstorming',
              description: 'Creative work planning.',
            },
          ],
        },
      },
    })

    render(<ChatInput />)

    await waitFor(() => {
      expect(mocks.getGitInfo).toHaveBeenCalledWith(sessionId)
    })

    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: '/su', selectionStart: 3 },
    })

    await waitFor(() => {
      const commandButtons = screen
        .getAllByRole('button')
        .filter((button) => button.textContent?.startsWith('/'))
      expect(commandButtons[0]).toHaveTextContent('/superpowers:brainstorming')
    })
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

    const input = screen.getByRole('textbox') as HTMLTextAreaElement
    fireEvent.change(input, {
      target: { value: '/debug', selectionStart: 6 },
    })

    const agentOption = await screen.findByText('/agent debugger')
    fireEvent.click(agentOption)

    expect(input).toHaveValue('/agent debugger ')
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

    const input = screen.getByRole('textbox') as HTMLTextAreaElement
    fireEvent.change(input, {
      target: { value: '/agent', selectionStart: 6 },
    })

    await screen.findByText('/agent debugger')
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(input).toHaveValue('/agent debugger ')
    expect(mocks.wsSend).not.toHaveBeenCalled()

    const prompt = '/agent debugger investigate this failure'
    fireEvent.change(input, {
      target: { value: prompt, selectionStart: prompt.length },
    })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(mocks.wsSend).not.toHaveBeenCalled()

    fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true })
    expect(mocks.wsSend).toHaveBeenCalledWith(sessionId, {
      type: 'user_message',
      content: prompt,
      attachments: [],
    })
  })
})
