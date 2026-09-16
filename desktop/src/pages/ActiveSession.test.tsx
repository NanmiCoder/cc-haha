import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, createEvent, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import '@testing-library/jest-dom'
import { act } from 'react'
import type { TeamWorkbenchSessionTimeline, TeamWorkbenchSnapshot } from '../types/team'

const viewportMocks = vi.hoisted(() => ({
  isMobile: false,
}))
const sessionApiMocks = vi.hoisted(() => ({
  getGitInfo: vi.fn(),
}))
const teamApiMocks = vi.hoisted(() => ({
  getMemberTranscript: vi.fn(() => Promise.resolve({ messages: [] })),
  getTeam: vi.fn(),
  listTeams: vi.fn(),
  getWorkbenchForSession: vi.fn(
    (): Promise<TeamWorkbenchSessionTimeline> => Promise.reject(new Error('not a team session')),
  ),
  getWorkbench: vi.fn(),
  sendMemberMessage: vi.fn(),
}))

vi.mock('../api/sessions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/sessions')>()
  return {
    ...actual,
    sessionsApi: {
      ...actual.sessionsApi,
      getGitInfo: sessionApiMocks.getGitInfo,
    },
  }
})

vi.mock('../hooks/useMobileViewport', () => ({
  useMobileViewport: () => viewportMocks.isMobile,
}))

vi.mock('../components/chat/MessageList', () => ({
  MessageList: ({ compact }: { compact?: boolean }) => (
    <div data-testid="message-list" data-compact={compact ? 'true' : 'false'} />
  ),
}))

vi.mock('../components/chat/ChatInput', () => ({
  ChatInput: ({ compact, variant }: { compact?: boolean; variant?: string }) => (
    <div data-testid="chat-input" data-compact={compact ? 'true' : 'false'} data-variant={variant} />
  ),
}))

vi.mock('../api/teams', () => ({
  teamsApi: {
    getMemberTranscript: teamApiMocks.getMemberTranscript,
    get: teamApiMocks.getTeam,
    list: teamApiMocks.listTeams,
    getWorkbenchForSession: teamApiMocks.getWorkbenchForSession,
    getWorkbench: teamApiMocks.getWorkbench,
    sendMemberMessage: teamApiMocks.sendMemberMessage,
  },
}))

vi.mock('./TerminalSettings', () => ({
  TerminalSettings: ({
    active,
    cwd,
    onOpenInTab,
    onClose,
    runtimeId,
    preserveOnUnmount,
    testId,
  }: {
    active?: boolean
    cwd?: string
    onOpenInTab?: () => void
    onClose?: () => void
    runtimeId?: string
    preserveOnUnmount?: boolean
    testId: string
  }) => (
    <div
      data-testid={testId}
      data-active={active ? 'true' : 'false'}
      data-cwd={cwd ?? ''}
      data-preserve-on-unmount={preserveOnUnmount ? 'true' : 'false'}
      data-runtime-id={runtimeId ?? ''}
    >
      <button type="button" onClick={onOpenInTab}>Open in Tab</button>
      <button type="button" onClick={onClose}>Close terminal panel</button>
    </div>
  ),
}))

import { ActiveSession } from './ActiveSession'
import { createDefaultSessionState, useChatStore } from '../stores/chatStore'
import { useCLITaskStore } from '../stores/cliTaskStore'
import { useSessionStore } from '../stores/sessionStore'
import { useSettingsStore } from '../stores/settingsStore'
import { useTabStore } from '../stores/tabStore'
import { useTeamStore } from '../stores/teamStore'
import { useActivityPanelStore } from '../stores/activityPanelStore'
import {
  WORKSPACE_BOTTOM_DEFAULT_HEIGHT,
  WORKSPACE_BOTTOM_MAX_HEIGHT,
  WORKSPACE_BOTTOM_MIN_HEIGHT,
  WORKSPACE_SIDE_DEFAULT_WIDTH,
  useWorkspaceStore,
} from '../stores/workspaceStore'

beforeEach(() => {
  sessionApiMocks.getGitInfo.mockReset()
  sessionApiMocks.getGitInfo.mockResolvedValue({
    branch: 'main',
    repoName: 'project',
    workDir: '/workspace/project',
    changedFiles: 0,
    worktree: null,
  })
  teamApiMocks.getMemberTranscript.mockReset()
  teamApiMocks.getMemberTranscript.mockResolvedValue({ messages: [] })
  teamApiMocks.getTeam.mockReset()
  teamApiMocks.listTeams.mockReset()
  teamApiMocks.getWorkbenchForSession.mockReset()
  teamApiMocks.getWorkbenchForSession.mockRejectedValue(new Error('not a team session'))
  teamApiMocks.getWorkbench.mockReset()
  teamApiMocks.sendMemberMessage.mockReset()
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  viewportMocks.isMobile = false
  useTabStore.setState({ tabs: [], activeTabId: null })
  useSessionStore.setState({ sessions: [], activeSessionId: null, isLoading: false, error: null })
  useChatStore.setState({ sessions: {} })
  useSettingsStore.setState({ locale: 'en' })
  useTeamStore.getState().stopMemberPolling()
  useTeamStore.setState(useTeamStore.getInitialState(), true)
  useWorkspaceStore.setState(useWorkspaceStore.getInitialState(), true)
  useActivityPanelStore.setState(useActivityPanelStore.getInitialState(), true)
  useCLITaskStore.setState(useCLITaskStore.getInitialState(), true)
})

describe('ActiveSession task polling', () => {
  it('shows cleaned worktrees as retained history and uses the source project for tools', () => {
    const sessionId = 'cleaned-worktree-session'
    useSettingsStore.setState({ locale: 'en' })

    useSessionStore.setState({
      sessions: [{
        id: sessionId,
        title: 'Cleaned Worktree Session',
        createdAt: '2026-05-07T00:00:00.000Z',
        modifiedAt: '2026-05-07T00:00:00.000Z',
        messageCount: 1,
        projectPath: '/repo-worktree',
        projectRoot: '/repo',
        workDir: '/repo/.claude/worktrees/desktop-main-12345678',
        workDirExists: false,
        workspaceState: 'worktree_removed',
      }],
      activeSessionId: sessionId,
      isLoading: false,
      error: null,
    })
    useTabStore.setState({
      tabs: [{ sessionId, title: 'Cleaned Worktree Session', type: 'session', status: 'idle' }],
      activeTabId: sessionId,
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
    render(<ActiveSession />)

    expect(screen.getByText(
      'The temporary workspace was cleaned up. History is still available; start a new session in /repo to continue.',
    )).toBeInTheDocument()

    // Open the terminal the way a user does, through the workspace launcher,
    // so the cwd under test is the one ActiveSession actually hands down: the
    // source project, not the worktree path that no longer exists.
    act(() => {
      useWorkspaceStore.getState().toggleWorkspace(sessionId)
    })
    act(() => {
      fireEvent.click(screen.getByTestId('workspace-launcher-terminal'))
    })

    expect(screen.getByTestId('workspace-terminal-host-1')).toHaveAttribute('data-cwd', '/repo')
  })

  it('treats a persisted historical session as non-empty before messages finish loading', () => {
    const sessionId = 'history-loading-session'

    useSessionStore.setState({
      sessions: [{
        id: sessionId,
        title: 'History Loading Session',
        createdAt: '2026-05-07T00:00:00.000Z',
        modifiedAt: '2026-05-07T00:00:00.000Z',
        messageCount: 2,
        projectPath: '/workspace/project',
        workDir: '/workspace/project',
        workDirExists: true,
      }],
      activeSessionId: sessionId,
      isLoading: false,
      error: null,
    })
    useTabStore.setState({
      tabs: [{ sessionId, title: 'History Loading Session', type: 'session', status: 'idle' }],
      activeTabId: sessionId,
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

    render(<ActiveSession />)

    expect(screen.getByTestId('message-list')).toBeInTheDocument()
    expect(screen.getByTestId('chat-input')).toHaveAttribute('data-variant', 'default')
  })

  it('replaces the empty hero with the transcript as soon as first-turn preparation begins', () => {
    const sessionId = 'preparing-first-turn-session'
    useSessionStore.setState({
      sessions: [{
        id: sessionId,
        title: 'New Session',
        createdAt: '2026-08-07T00:00:00.000Z',
        modifiedAt: '2026-08-07T00:00:00.000Z',
        messageCount: 0,
        projectPath: '/workspace/project',
        workDir: '/workspace/project',
        workDirExists: true,
      }],
      activeSessionId: sessionId,
      isLoading: false,
      error: null,
    })
    useTabStore.setState({
      tabs: [{ sessionId, title: 'New Session', type: 'session', status: 'idle' }],
      activeTabId: sessionId,
    })
    useChatStore.setState({
      sessions: {
        [sessionId]: {
          ...useChatStore.getState().getSession(sessionId),
          connectionState: 'connected',
          historyStatus: 'ready',
        },
      },
    })

    render(<ActiveSession />)
    expect(screen.getByTestId('empty-session-hero')).toBeInTheDocument()

    act(() => {
      useChatStore.getState().setPreparingTurn(sessionId, true)
    })

    expect(screen.queryByTestId('empty-session-hero')).not.toBeInTheDocument()
    expect(screen.getByTestId('message-list')).toBeInTheDocument()
    expect(screen.getByTestId('chat-input')).toHaveAttribute('data-variant', 'default')
  })

  it('labels result usage that includes cache tokens without implying the Trace input/output total', async () => {
    const sessionId = 'deepseek-cache-token-session'

    useSessionStore.setState({
      sessions: [{
        id: sessionId,
        title: 'DeepSeek Cache Token Session',
        createdAt: '2026-05-07T00:00:00.000Z',
        modifiedAt: '2026-05-07T00:00:00.000Z',
        messageCount: 1,
        projectPath: '/workspace/project',
        workDir: '/workspace/project',
        workDirExists: true,
      }],
      activeSessionId: sessionId,
      isLoading: false,
      error: null,
    })
    useTabStore.setState({
      tabs: [{ sessionId, title: 'DeepSeek Cache Token Session', type: 'session', status: 'idle' }],
      activeTabId: sessionId,
    })
    useChatStore.setState({
      sessions: {
        [sessionId]: {
          ...createDefaultSessionState(),
          connectionState: 'connected',
        },
      },
    })
    render(<ActiveSession />)

    await act(async () => {
      useChatStore.getState().handleServerMessage(sessionId, {
        type: 'message_complete',
        usage: {
          input_tokens: 107_600,
          output_tokens: 11_400,
          cache_read_tokens: 4_971_000,
          cache_creation_tokens: 10_000,
        },
      })
      await Promise.resolve()
      await Promise.resolve()
    })

    const tokenBadge = screen.getByTitle(/cache read 4,971,000.*cache write 10,000/i)
    expect(tokenBadge).toHaveTextContent('5.1m tokens incl. cache')
  })

  it('shows the worktree name in the header and reveals its directory on focus', async () => {
    const worktreeSessionId = 'worktree-header-session'
    const regularSessionId = 'regular-header-session'
    const worktreeName = 'desktop-feature-worktree-header'
    const plannedPath = `/workspace/project/.claude/worktrees/${worktreeName}`

    sessionApiMocks.getGitInfo.mockImplementation(async (sessionId: string) => ({
      branch: 'feature/worktree-header',
      repoName: 'project',
      workDir: sessionId === worktreeSessionId ? plannedPath : '/workspace/project',
      changedFiles: 0,
      worktree: sessionId === worktreeSessionId ? {
        enabled: true,
        path: null,
        plannedPath,
        sourceWorkDir: '/workspace/project',
        slug: worktreeName,
        branch: 'worktree/feature-worktree-header',
      } : null,
    }))

    useSessionStore.setState({
      sessions: [
        {
          id: worktreeSessionId,
          title: 'Worktree Header Session',
          createdAt: '2026-08-07T00:00:00.000Z',
          modifiedAt: '2026-08-07T00:00:00.000Z',
          messageCount: 1,
          projectPath: '/workspace/project',
          workDir: plannedPath,
          workDirExists: true,
        },
        {
          id: regularSessionId,
          title: 'Regular Header Session',
          createdAt: '2026-08-07T00:00:00.000Z',
          modifiedAt: '2026-08-07T00:00:00.000Z',
          messageCount: 1,
          projectPath: '/workspace/project',
          workDir: '/workspace/project',
          workDirExists: true,
        },
      ],
      activeSessionId: worktreeSessionId,
      isLoading: false,
      error: null,
    })
    useTabStore.setState({
      tabs: [
        { sessionId: worktreeSessionId, title: 'Worktree Header Session', type: 'session', status: 'idle' },
        { sessionId: regularSessionId, title: 'Regular Header Session', type: 'session', status: 'idle' },
      ],
      activeTabId: worktreeSessionId,
    })
    const idleSessionState = {
      chatState: 'idle' as const,
      connectionState: 'connected' as const,
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
    }
    useChatStore.setState({
      sessions: {
        [worktreeSessionId]: {
          ...idleSessionState,
          messages: [{ id: 'worktree-message', type: 'assistant_text', content: 'ready', timestamp: 1 }],
        },
        [regularSessionId]: {
          ...idleSessionState,
          messages: [{ id: 'regular-message', type: 'assistant_text', content: 'ready', timestamp: 1 }],
        },
      },
    })

    render(<ActiveSession />)

    const indicator = await screen.findByTestId('session-worktree-indicator')
    expect(indicator).toHaveTextContent(worktreeName)
    expect(screen.getByRole('heading', { name: 'Worktree Header Session' })).toBeInTheDocument()
    expect(within(screen.getByTestId('session-header')).queryByText(plannedPath)).not.toBeInTheDocument()

    fireEvent.focus(indicator)
    expect(await screen.findByRole('tooltip')).toHaveTextContent(plannedPath)

    act(() => {
      useTabStore.getState().setActiveTab(regularSessionId)
    })

    await waitFor(() => {
      expect(screen.queryByTestId('session-worktree-indicator')).not.toBeInTheDocument()
    })
    expect(screen.getByRole('heading', { name: 'Regular Header Session' })).toBeInTheDocument()
  })

  it('shows a loading state for historical sessions while messages are loading', () => {
    const sessionId = 'history-visible-loading-session'

    useSessionStore.setState({
      sessions: [{
        id: sessionId,
        title: 'History Loading Session',
        createdAt: '2026-05-07T00:00:00.000Z',
        modifiedAt: '2026-05-07T00:00:00.000Z',
        messageCount: 2,
        projectPath: '/workspace/project',
        workDir: '/workspace/project',
        workDirExists: true,
      }],
      activeSessionId: sessionId,
      isLoading: false,
      error: null,
    })
    useTabStore.setState({
      tabs: [{ sessionId, title: 'History Loading Session', type: 'session', status: 'idle' }],
      activeTabId: sessionId,
    })
    useChatStore.setState({
      sessions: {
        [sessionId]: {
          ...useChatStore.getState().getSession(sessionId),
          connectionState: 'connected',
          historyStatus: 'loading',
        },
      },
    })

    render(<ActiveSession />)

    expect(screen.getByRole('status')).toHaveTextContent(/Loading|加载中/)
    expect(screen.queryByTestId('message-list')).not.toBeInTheDocument()
    expect(screen.getByTestId('chat-input')).toHaveAttribute('data-variant', 'default')
  })

  it('renders the current goal as a lightweight header strip without a page-level panel', () => {
    const sessionId = 'goal-visible-session'

    useSessionStore.setState({
      sessions: [{
        id: sessionId,
        title: 'Goal Visible Session',
        createdAt: '2026-05-07T00:00:00.000Z',
        modifiedAt: '2026-05-07T00:00:00.000Z',
        messageCount: 1,
        projectPath: '/workspace/project',
        workDir: '/workspace/project',
        workDirExists: true,
      }],
      activeSessionId: sessionId,
      isLoading: false,
      error: null,
    })
    useTabStore.setState({
      tabs: [{ sessionId, title: 'Goal Visible Session', type: 'session', status: 'running' }],
      activeTabId: sessionId,
    })
    useChatStore.setState({
      sessions: {
        [sessionId]: {
          messages: [{
            id: 'goal-event',
            type: 'goal_event',
            action: 'created',
            status: 'active',
            objective: 'ship the smoke test',
            budget: '0 / 2,000 tokens',
            continuations: '0',
            timestamp: 1,
          }],
          activeGoal: {
            action: 'created',
            status: 'active',
            objective: 'ship the smoke test',
            budget: '0 / 2,000 tokens',
            continuations: '0',
            updatedAt: 1,
          },
          chatState: 'thinking',
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

    render(<ActiveSession />)

    expect(screen.queryByTestId('active-goal-panel')).not.toBeInTheDocument()
    expect(screen.getByTestId('active-goal-strip')).toBeInTheDocument()
    expect(screen.getByTestId('active-goal-strip')).toHaveTextContent('ship the smoke test')
    expect(screen.getByTestId('message-list')).toBeInTheDocument()
  })

  it('does not keep a completed goal pinned in the header', () => {
    const sessionId = 'goal-completed-session'

    useSessionStore.setState({
      sessions: [{
        id: sessionId,
        title: 'Goal Completed Session',
        createdAt: '2026-05-07T00:00:00.000Z',
        modifiedAt: '2026-05-07T00:00:00.000Z',
        messageCount: 3,
        projectPath: '/workspace/project',
        workDir: '/workspace/project',
        workDirExists: true,
      }],
      activeSessionId: sessionId,
      isLoading: false,
      error: null,
    })
    useTabStore.setState({
      tabs: [{ sessionId, title: 'Goal Completed Session', type: 'session', status: 'idle' }],
      activeTabId: sessionId,
    })
    useChatStore.setState({
      sessions: {
        [sessionId]: {
          messages: [{
            id: 'goal-completed-event',
            type: 'goal_event',
            action: 'completed',
            status: 'complete',
            message: 'Goal marked complete.',
            timestamp: 3,
          }],
          activeGoal: {
            action: 'completed',
            status: 'complete',
            message: 'Goal marked complete.',
            updatedAt: 3,
          },
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

    render(<ActiveSession />)

    expect(screen.queryByTestId('active-goal-strip')).not.toBeInTheDocument()
    expect(screen.getByTestId('message-list')).toBeInTheDocument()
  })

  it('keeps persistent activity surfaces out of the composer area', () => {
    const sessionId = 'activity-clean-composer-session'

    useCLITaskStore.setState({
      sessionId,
      tasks: [{
        id: 'task-1',
        subject: 'Write tests',
        description: '',
        status: 'in_progress',
        blocks: [],
        blockedBy: [],
        taskListId: sessionId,
      }],
      completedAndDismissed: false,
    })
    useSessionStore.setState({
      sessions: [{
        id: sessionId,
        title: 'Activity Session',
        createdAt: '2026-05-07T00:00:00.000Z',
        modifiedAt: '2026-05-07T00:00:00.000Z',
        messageCount: 1,
        projectPath: '/workspace/project',
        workDir: '/workspace/project',
        workDirExists: true,
      }],
      activeSessionId: sessionId,
      isLoading: false,
      error: null,
    })
    useTabStore.setState({
      tabs: [{ sessionId, title: 'Activity Session', type: 'session', status: 'idle' }],
      activeTabId: sessionId,
    })
    useChatStore.setState({
      sessions: {
        [sessionId]: {
          messages: [],
          backgroundAgentTasks: {
            'agent-task-1': {
              taskId: 'agent-task-1',
              toolUseId: 'agent-tool-1',
              status: 'running',
              taskType: 'local_agent',
              description: 'Explore code',
              startedAt: 1,
              updatedAt: 2,
            },
          },
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

    render(<ActiveSession />)

    const chatColumn = screen.getByTestId('active-session-chat-column')
    expect(chatColumn).toContainElement(screen.getByTestId('chat-input'))
    expect(chatColumn).toHaveClass('relative')
    expect(screen.queryByTestId('session-task-bar')).not.toBeInTheDocument()
    expect(screen.queryByTestId('team-status-bar')).not.toBeInTheDocument()
    expect(screen.queryByTestId('background-tasks-bar')).not.toBeInTheDocument()
    expect(screen.queryByTestId('background-tasks-button')).not.toBeInTheDocument()
  })

  it('renders the activity panel as a rail and hides it when the workspace opens', async () => {
    const sessionId = 'activity-panel-open-session'

    useCLITaskStore.setState({
      sessionId,
      tasks: [{
        id: 'task-1',
        subject: 'Implement panel',
        description: 'Move persistent rows',
        status: 'in_progress',
        blocks: [],
        blockedBy: [],
        taskListId: sessionId,
      }],
      completedAndDismissed: false,
    })
    useActivityPanelStore.getState().open(sessionId)
    useSessionStore.setState({
      sessions: [{
        id: sessionId,
        title: 'Activity Panel Session',
        createdAt: '2026-05-07T00:00:00.000Z',
        modifiedAt: '2026-05-07T00:00:00.000Z',
        messageCount: 1,
        projectPath: '/workspace/project',
        workDir: '/workspace/project',
        workDirExists: true,
      }],
      activeSessionId: sessionId,
      isLoading: false,
      error: null,
    })
    useTabStore.setState({
      tabs: [{ sessionId, title: 'Activity Panel Session', type: 'session', status: 'idle' }],
      activeTabId: sessionId,
    })
    useChatStore.setState({
      sessions: {
        [sessionId]: {
          messages: [
            {
              id: 'agent-tool-1',
              type: 'tool_use',
              toolName: 'Agent',
              toolUseId: 'agent-tool-1',
              input: { description: 'Explore repo' },
              timestamp: 1,
            },
            {
              id: 'agent-result-1',
              type: 'tool_result',
              toolUseId: 'agent-tool-1',
              content: 'Done',
              isError: false,
              timestamp: 2,
            },
          ],
          backgroundAgentTasks: {
            'bash-task-1': {
              taskId: 'bash-task-1',
              toolUseId: 'bash-tool-1',
              status: 'running',
              taskType: 'local_bash',
              description: 'Run smoke checks',
              startedAt: 1,
              updatedAt: 2,
            },
          },
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
          agentTaskNotifications: {
            'agent-task-1': {
              taskId: 'agent-task-1',
              toolUseId: 'agent-tool-1',
              status: 'completed',
              summary: 'Explore repo',
              timestamp: '2026-07-03T00:00:00.000Z',
            },
          },
          elapsedTimer: null,
        },
      },
    })

    render(<ActiveSession />)

    const chatColumn = screen.getByTestId('active-session-chat-column')
    const panel = screen.getByTestId('session-activity-panel')
    expect(chatColumn).not.toContainElement(panel)
    expect(panel).toHaveAttribute('data-placement', 'rail')
    expect(panel).toHaveAttribute('role', 'dialog')
    expect(within(panel).getByText('Implement panel')).toBeInTheDocument()
    expect(within(panel).getAllByText('Run smoke checks')).not.toHaveLength(0)
    expect(within(panel).getAllByText('Explore repo')).not.toHaveLength(0)
    expect(chatColumn).toContainElement(screen.getByTestId('chat-input'))
    expect(screen.queryByTestId('session-task-bar')).not.toBeInTheDocument()
    expect(screen.queryByTestId('background-tasks-button')).not.toBeInTheDocument()

    act(() => {
      useWorkspaceStore.getState().openTarget(sessionId, { kind: 'file', path: 'src/a.ts' })
    })

    expect(screen.getByTestId('workbench-panel')).toBeInTheDocument()
    expect(screen.queryByTestId('session-activity-panel')).not.toBeInTheDocument()
    await waitFor(() => {
      expect(useActivityPanelStore.getState().isOpen(sessionId)).toBe(false)
    })
  })

  it('does not render the activity panel when the store is open without visible activity', async () => {
    const sessionId = 'activity-open-empty-session'

    useActivityPanelStore.getState().open(sessionId)
    useSessionStore.setState({
      sessions: [{
        id: sessionId,
        title: 'Empty Activity Session',
        createdAt: '2026-05-07T00:00:00.000Z',
        modifiedAt: '2026-05-07T00:00:00.000Z',
        messageCount: 1,
        projectPath: '/workspace/project',
        workDir: '/workspace/project',
        workDirExists: true,
      }],
      activeSessionId: sessionId,
      isLoading: false,
      error: null,
    })
    useTabStore.setState({
      tabs: [{ sessionId, title: 'Empty Activity Session', type: 'session', status: 'idle' }],
      activeTabId: sessionId,
    })
    useChatStore.setState({
      sessions: {
        [sessionId]: {
          messages: [{ id: 'msg-1', type: 'assistant_text', content: 'hello', timestamp: 1 }],
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
          backgroundAgentTasks: {},
          agentTaskNotifications: {},
          elapsedTimer: null,
        },
      },
    })

    render(<ActiveSession />)

    expect(screen.queryByTestId('session-activity-panel')).not.toBeInTheDocument()
    await waitFor(() => {
      expect(useActivityPanelStore.getState().isOpen(sessionId)).toBe(false)
    }, { timeout: 4000 })
  })

  it('auto-opens for current activity and seals unfinished tasks when the turn becomes idle', async () => {
    const sessionId = 'activity-auto-open-session'
    const fetchSessionTasks = vi.fn().mockResolvedValue(undefined)

    useCLITaskStore.setState({ fetchSessionTasks })
    useSessionStore.setState({
      sessions: [{
        id: sessionId,
        title: 'Auto Open Activity Session',
        createdAt: '2026-05-07T00:00:00.000Z',
        modifiedAt: '2026-05-07T00:00:00.000Z',
        messageCount: 1,
        projectPath: '/workspace/project',
        workDir: '/workspace/project',
        workDirExists: true,
      }],
      activeSessionId: sessionId,
      isLoading: false,
      error: null,
    })
    useTabStore.setState({
      tabs: [{ sessionId, title: 'Auto Open Activity Session', type: 'session', status: 'idle' }],
      activeTabId: sessionId,
    })
    useChatStore.setState({
      sessions: {
        [sessionId]: {
          messages: [],
          chatState: 'thinking',
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
          backgroundAgentTasks: {},
          agentTaskNotifications: {},
          elapsedTimer: null,
        },
      },
    })

    render(<ActiveSession />)

    expect(screen.queryByTestId('session-activity-panel')).not.toBeInTheDocument()
    expect(useActivityPanelStore.getState().isOpen(sessionId)).toBe(false)

    act(() => {
      useCLITaskStore.setState({
        sessionId,
        tasks: [{
          id: 'task-1',
          subject: 'Draft implementation plan',
          description: 'Create the first activity row',
          status: 'in_progress',
          blocks: [],
          blockedBy: [],
          taskListId: sessionId,
        }],
        completedAndDismissed: false,
      })
    })

    await waitFor(() => {
      expect(useActivityPanelStore.getState().isOpen(sessionId)).toBe(true)
    })
    expect(screen.getByTestId('session-activity-panel')).toHaveAttribute('data-placement', 'rail')
    expect(screen.getByText('Draft implementation plan')).toBeInTheDocument()
    expect(within(screen.getByTestId('session-activity-panel')).getByLabelText('Task in progress')).toBeInTheDocument()

    act(() => {
      useChatStore.setState((state) => ({
        sessions: {
          ...state.sessions,
          [sessionId]: {
            ...state.sessions[sessionId]!,
            chatState: 'idle',
          },
        },
      }))
    })

    expect(within(screen.getByTestId('session-activity-panel')).getByLabelText('Stopped')).toBeInTheDocument()
    expect(within(screen.getByTestId('session-activity-panel')).queryByLabelText('Task in progress')).not.toBeInTheDocument()
    expect(screen.queryByText(/session active|会话活跃中/)).not.toBeInTheDocument()
  })

  it('renders completed historical TodoWrite activity in the rail', () => {
    const sessionId = 'activity-todowrite-history-session'

    useActivityPanelStore.getState().open(sessionId)
    useSessionStore.setState({
      sessions: [{
        id: sessionId,
        title: 'TodoWrite History Session',
        createdAt: '2026-05-07T00:00:00.000Z',
        modifiedAt: '2026-05-07T00:00:00.000Z',
        messageCount: 1,
        projectPath: '/workspace/project',
        workDir: '/workspace/project',
        workDirExists: true,
      }],
      activeSessionId: sessionId,
      isLoading: false,
      error: null,
    })
    useTabStore.setState({
      tabs: [{ sessionId, title: 'TodoWrite History Session', type: 'session', status: 'idle' }],
      activeTabId: sessionId,
    })
    useChatStore.setState({
      sessions: {
        [sessionId]: {
          messages: [{
            id: 'todo-1',
            type: 'tool_use',
            toolName: 'TodoWrite',
            toolUseId: 'todo-1',
            input: {
              todos: [
                { content: 'Review historical implementation', status: 'completed' },
              ],
            },
            timestamp: 1,
          }],
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
          backgroundAgentTasks: {},
          agentTaskNotifications: {},
          elapsedTimer: null,
        },
      },
    })

    render(<ActiveSession />)

    const panel = screen.getByTestId('session-activity-panel')
    expect(panel).toHaveAttribute('data-placement', 'rail')
    expect(within(panel).getByText('Review historical implementation')).toBeInTheDocument()
  })

  it('isolates Agent Teams tasks before the first workbench snapshot while preserving lead activity', async () => {
    const sessionId = 'team-task-ownership-session'
    vi.useFakeTimers()

    useActivityPanelStore.getState().open(sessionId)
    useSessionStore.setState({
      sessions: [{
        id: sessionId,
        title: 'Team Task Ownership',
        createdAt: '2026-08-10T00:00:00.000Z',
        modifiedAt: '2026-08-10T00:00:00.000Z',
        messageCount: 1,
        projectPath: '/workspace/project',
        workDir: '/workspace/project',
        workDirExists: true,
      }],
      activeSessionId: sessionId,
      isLoading: false,
      error: null,
    })
    useTabStore.setState({
      tabs: [{ sessionId, title: 'Team Task Ownership', type: 'session', status: 'idle' }],
      activeTabId: sessionId,
    })
    useChatStore.setState({
      sessions: { [sessionId]: createDefaultSessionState() },
    })
    const handleServerMessage = useChatStore.getState().handleServerMessage
    handleServerMessage(sessionId, {
      type: 'team_created',
      teamName: 'test-team',
    })
    expect(useTeamStore.getState().teamNameBySession[sessionId]).toBe('test-team')
    expect(useTeamStore.getState().workbenchesBySession[sessionId]).toBeUndefined()
    handleServerMessage(sessionId, {
      type: 'tool_use_complete',
      toolName: 'TaskCreate',
      toolUseId: 'team-task-create',
      input: { subject: 'Review shared auth task' },
    })
    handleServerMessage(sessionId, {
      type: 'tool_use_complete',
      toolName: 'TodoWrite',
      toolUseId: 'lead-personal-todo',
      input: {
        todos: [{ content: 'Summarize team delivery', status: 'in_progress' }],
      },
    })
    useCLITaskStore.setState({
      sessionId,
      tasks: [{
        id: '1',
        subject: 'Finish the lead release checklist',
        description: 'Created before the team task list existed',
        status: 'in_progress',
        blocks: [],
        blockedBy: [],
        taskListId: sessionId,
      }],
      fetchSessionTasks: vi.fn().mockResolvedValue(undefined),
    })

    await act(async () => {
      render(<ActiveSession />)
      await Promise.resolve()
    })

    const panel = screen.getByTestId('session-activity-panel')
    expect(within(panel).getByText('Finish the lead release checklist')).toBeInTheDocument()
    expect(within(panel).getByText('Summarize team delivery')).toBeInTheDocument()
    expect(within(panel).queryByText('Review shared auth task')).not.toBeInTheDocument()
    vi.clearAllTimers()
  })

  it('ignores unrelated active team rows when deciding Activity visibility', async () => {
    const sessionId = 'activity-unrelated-team-session'

    useActivityPanelStore.getState().open(sessionId)
    useTeamStore.setState({
      teams: [],
      activeTeam: {
        name: 'other-team',
        leadAgentId: 'team-lead@other-team',
        leadSessionId: 'other-session',
        members: [
          {
            agentId: 'security-reviewer@other-team',
            role: 'security-reviewer',
            status: 'running',
            currentTask: 'Auditing another session',
          },
        ],
      },
      memberColors: new Map(),
      error: null,
    })
    useSessionStore.setState({
      sessions: [{
        id: sessionId,
        title: 'Unrelated Team Session',
        createdAt: '2026-05-07T00:00:00.000Z',
        modifiedAt: '2026-05-07T00:00:00.000Z',
        messageCount: 1,
        projectPath: '/workspace/project',
        workDir: '/workspace/project',
        workDirExists: true,
      }],
      activeSessionId: sessionId,
      isLoading: false,
      error: null,
    })
    useTabStore.setState({
      tabs: [{ sessionId, title: 'Unrelated Team Session', type: 'session', status: 'idle' }],
      activeTabId: sessionId,
    })
    useChatStore.setState({
      sessions: {
        [sessionId]: {
          messages: [{ id: 'msg-1', type: 'assistant_text', content: 'hello', timestamp: 1 }],
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
          backgroundAgentTasks: {},
          agentTaskNotifications: {},
          elapsedTimer: null,
        },
      },
    })

    render(<ActiveSession />)

    expect(screen.queryByText('security-reviewer')).not.toBeInTheDocument()
    expect(screen.queryByTestId('session-activity-panel')).not.toBeInTheDocument()
    await waitFor(() => {
      expect(useActivityPanelStore.getState().isOpen(sessionId)).toBe(false)
    }, { timeout: 4000 })
  })

  it('opens a SubAgent detail tab from the activity panel', () => {
    const sessionId = 'activity-subagent-open-session'

    useActivityPanelStore.getState().open(sessionId)
    useSessionStore.setState({
      sessions: [{
        id: sessionId,
        title: 'SubAgent Activity Session',
        createdAt: '2026-05-07T00:00:00.000Z',
        modifiedAt: '2026-05-07T00:00:00.000Z',
        messageCount: 1,
        projectPath: '/workspace/project',
        workDir: '/workspace/project',
        workDirExists: true,
      }],
      activeSessionId: sessionId,
      isLoading: false,
      error: null,
    })
    useTabStore.setState({
      tabs: [{ sessionId, title: 'SubAgent Activity Session', type: 'session', status: 'idle' }],
      activeTabId: sessionId,
    })
    useChatStore.setState({
      sessions: {
        [sessionId]: {
          messages: [
            {
              id: 'agent-tool-1',
              type: 'tool_use',
              toolName: 'Agent',
              toolUseId: 'agent-tool-1',
              input: { description: 'Review workspace seams' },
              timestamp: 1,
            },
            {
              id: 'agent-result-1',
              type: 'tool_result',
              toolUseId: 'agent-tool-1',
              content: 'Done',
              isError: false,
              timestamp: 2,
            },
          ],
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
          backgroundAgentTasks: {},
          agentTaskNotifications: {
            'agent-task-1': {
              taskId: 'agent-task-1',
              toolUseId: 'agent-tool-1',
              status: 'completed',
              summary: 'Review workspace seams',
              timestamp: '2026-07-03T00:00:00.000Z',
            },
          },
          elapsedTimer: null,
        },
      },
    })

    render(<ActiveSession />)

    fireEvent.click(screen.getByRole('button', { name: /Open run Review workspace seams.*Completed/ }))

    const tab = useTabStore.getState().tabs.find((candidate) => candidate.sessionId === '__subagent__activity-subagent-open-session__agent-tool-1')
    expect(tab).toMatchObject({
      sessionId: '__subagent__activity-subagent-open-session__agent-tool-1',
      title: 'Review workspace seams',
      type: 'subagent',
      status: 'idle',
      sourceSessionId: sessionId,
      subagentToolUseId: 'agent-tool-1',
      subagentTaskId: 'agent-task-1',
    })
    expect(useTabStore.getState().activeTabId).toBe('__subagent__activity-subagent-open-session__agent-tool-1')
    expect(useActivityPanelStore.getState().openSessionId).toBe(
      '__subagent__activity-subagent-open-session__agent-tool-1',
    )
  })

  it('opens the full team workbench directly from the header strip', () => {
    const sessionId = 'team-activity-panel-session'

    useActivityPanelStore.getState().open(sessionId)
    useTeamStore.setState({
      teams: [],
      activeTeam: {
        name: 'test-team',
        leadAgentId: 'team-lead@test-team',
        leadSessionId: sessionId,
        members: [
          {
            agentId: 'team-lead@test-team',
            role: 'team-lead',
            status: 'running',
          },
          {
            agentId: 'security-reviewer@test-team',
            role: 'security-reviewer',
            status: 'running',
            currentTask: 'Auditing auth flow',
          },
        ],
      },
      memberColors: new Map(),
      error: null,
      workbenchesBySession: {
        [sessionId]: {
          teamName: 'test-team',
          loading: false,
          error: null,
          snapshots: [{
            version: 'v1',
            generatedAt: '2026-08-08T00:00:00.000Z',
            team: {
              name: 'test-team',
              leadAgentId: 'team-lead@test-team',
              leadSessionId: sessionId,
              members: [
                { agentId: 'team-lead@test-team', role: 'team-lead', status: 'running' },
                {
                  agentId: 'security-reviewer@test-team',
                  role: 'security-reviewer',
                  status: 'running',
                  currentTask: 'Auditing auth flow',
                },
              ],
            },
            tasks: [],
            messages: [],
          }],
        },
      },
    })
    useSessionStore.setState({
      sessions: [{
        id: sessionId,
        title: 'Team Activity Session',
        createdAt: '2026-05-07T00:00:00.000Z',
        modifiedAt: '2026-05-07T00:00:00.000Z',
        messageCount: 1,
        projectPath: '/workspace/project',
        workDir: '/workspace/project',
        workDirExists: true,
      }],
      activeSessionId: sessionId,
      isLoading: false,
      error: null,
    })
    useTabStore.setState({
      tabs: [{ sessionId, title: 'Team Activity Session', type: 'session', status: 'idle' }],
      activeTabId: sessionId,
    })
    useChatStore.setState({
      sessions: {
        [sessionId]: {
          messages: [{ id: 'msg-1', type: 'assistant_text', content: 'hello', timestamp: 1 }],
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
          backgroundAgentTasks: {},
          agentTaskNotifications: {},
          elapsedTimer: null,
        },
      },
    })

    render(<ActiveSession />)

    // Discovering a team must not seize the right-hand slot or compact the
    // transcript; the header strip is the whole of its main-session footprint.
    const strip = screen.getByTestId('agent-teams-strip')
    expect(screen.queryByTestId('agent-teams-workbench-panel')).not.toBeInTheDocument()
    expect(screen.getByTestId('message-list')).toHaveAttribute('data-compact', 'false')

    act(() => {
      fireEvent.click(strip)
    })

    const teamTabId = `__team__${sessionId}`
    expect(useTabStore.getState().activeTabId).toBe(teamTabId)
    expect(useTabStore.getState().tabs.find((tab) => tab.sessionId === teamTabId)).toMatchObject({
      type: 'team',
      teamLeadSessionId: sessionId,
      title: 'test-team',
    })
    expect(screen.queryByTestId('agent-teams-workbench-panel')).not.toBeInTheDocument()
    expect(useTeamStore.getState().workbenchesBySession[sessionId]?.snapshots).toHaveLength(1)
  })

  it('updates the Team workbench without leaking its DAG, roster, or transcript spawns into main Activity', async () => {
    const sessionId = 'team-activity-runtime-state-session'
    const teamName = 'runtime-state-team'
    const taskDefinitions = [
      { id: 'A', subject: 'Map routes' },
      { id: 'B', subject: 'Review security' },
      { id: 'C', subject: 'Verify integration' },
      { id: 'D', subject: 'Write report' },
    ]
    const snapshot = (
      version: string,
      statuses: Record<string, 'pending' | 'in_progress' | 'completed'>,
    ): TeamWorkbenchSnapshot => ({
      version,
      generatedAt: `2026-08-10T00:00:0${version === 'v1' ? '1' : '2'}.000Z`,
      team: {
        name: teamName,
        leadAgentId: `team-lead@${teamName}`,
        leadSessionId: sessionId,
        createdAt: '2026-08-10T00:00:00.000Z',
        members: [
          { agentId: `team-lead@${teamName}`, role: 'team-lead', status: 'running' },
          { agentId: `route-mapper@${teamName}`, role: 'route-mapper', status: 'running' },
          { agentId: `security-reviewer@${teamName}`, role: 'security-reviewer', status: 'running' },
          { agentId: `integration-tester@${teamName}`, role: 'integration-tester', status: 'running' },
        ],
      },
      tasks: taskDefinitions.map(({ id, subject }) => ({
        id,
        subject,
        description: subject,
        status: statuses[id] ?? 'pending',
        blocks: [],
        blockedBy: [],
        taskListId: teamName,
      })),
      messages: version === 'v2'
        ? [{
            id: 'route-mapper-to-security-reviewer',
            from: 'route-mapper',
            to: 'security-reviewer',
            recipients: ['security-reviewer'],
            kind: 'direct',
            text: '**Routes mapped.** Review the auth boundary.',
            timestamp: '2026-08-10T00:00:02.000Z',
          }]
        : [],
    })
    const initialSnapshot = snapshot('v1', {
      A: 'pending',
      B: 'pending',
      C: 'pending',
      D: 'completed',
    })
    const completedSnapshot = snapshot('v2', {
      A: 'completed',
      B: 'completed',
      C: 'completed',
      D: 'completed',
    })

    teamApiMocks.getWorkbenchForSession.mockResolvedValue({
      sessionId,
      teamName,
      source: 'live',
      snapshots: [initialSnapshot],
    })
    teamApiMocks.getTeam.mockResolvedValue(completedSnapshot.team)
    teamApiMocks.getWorkbench.mockResolvedValue(completedSnapshot)
    useActivityPanelStore.getState().open(sessionId)
    useSessionStore.setState({
      sessions: [{
        id: sessionId,
        title: 'Runtime State Team',
        createdAt: '2026-08-10T00:00:00.000Z',
        modifiedAt: '2026-08-10T00:00:00.000Z',
        messageCount: 1,
        projectPath: '/workspace/project',
        workDir: '/workspace/project',
        workDirExists: true,
      }],
      activeSessionId: sessionId,
      isLoading: false,
      error: null,
    })
    useTabStore.setState({
      tabs: [{ sessionId, title: 'Runtime State Team', type: 'session', status: 'idle' }],
      activeTabId: sessionId,
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
          backgroundAgentTasks: {},
          agentTaskNotifications: {},
          elapsedTimer: null,
        },
      },
    })

    useChatStore.getState().handleServerMessage(sessionId, {
      type: 'team_created',
      teamName,
    })
    useChatStore.getState().sendMessage(sessionId, 'Coordinate the four-task team')
    for (const { id, subject } of taskDefinitions) {
      useChatStore.getState().handleServerMessage(sessionId, {
        type: 'tool_use_complete',
        toolName: 'TaskCreate',
        toolUseId: `create-${id}`,
        input: { subject },
      })
      useChatStore.getState().handleServerMessage(sessionId, {
        type: 'tool_result',
        toolUseId: `create-${id}`,
        content: `Task #${id} created successfully: ${subject}`,
        isError: false,
      })
    }
    for (const id of ['A', 'B', 'C']) {
      useChatStore.getState().handleServerMessage(sessionId, {
        type: 'tool_use_complete',
        toolName: 'TaskUpdate',
        toolUseId: `failed-update-${id}`,
        input: { taskId: id, status: 'completed' },
      })
      useChatStore.getState().handleServerMessage(sessionId, {
        type: 'tool_result',
        toolUseId: `failed-update-${id}`,
        content: 'Task not found',
        isError: false,
      })
    }
    useChatStore.getState().handleServerMessage(sessionId, {
      type: 'tool_use_complete',
      toolName: 'TaskUpdate',
      toolUseId: 'completed-update-D',
      input: { taskId: 'D', status: 'completed' },
    })
    useChatStore.getState().handleServerMessage(sessionId, {
      type: 'tool_result',
      toolUseId: 'completed-update-D',
      content: 'Updated task #D status',
      isError: false,
    })
    useChatStore.getState().handleServerMessage(sessionId, {
      type: 'tool_use_complete',
      toolName: 'Agent',
      toolUseId: 'spawn-late-reviewer',
      input: {
        team_name: teamName,
        name: 'late-reviewer',
        description: 'Review the shared Team DAG',
      },
    })
    useChatStore.getState().handleServerMessage(sessionId, {
      type: 'tool_result',
      toolUseId: 'spawn-late-reviewer',
      content: 'Agent launched successfully',
      isError: false,
    })
    useChatStore.getState().handleServerMessage(sessionId, {
      type: 'message_complete',
      usage: { input_tokens: 1, output_tokens: 1 },
    })

    render(<ActiveSession />)

    await waitFor(() => {
      expect(within(screen.getByTestId('agent-teams-strip')).getByText(/1\/4/)).toBeInTheDocument()
    })
    // Opening a stale Activity preference must not give Team-only state a
    // panel. The shared DAG, roster, and member launch all belong to the Team
    // tab/workbench, not to the main agent's run.
    expect(screen.queryByTestId('session-activity-panel')).not.toBeInTheDocument()
    await waitFor(() => {
      expect(useActivityPanelStore.getState().isOpen(sessionId)).toBe(false)
    }, { timeout: 4000 })

    act(() => {
      useChatStore.getState().handleServerMessage(sessionId, {
        type: 'team_workbench_updated',
        teamName,
      })
    })

    await waitFor(() => {
      expect(within(screen.getByTestId('agent-teams-strip')).getByText(/4\/4/)).toBeInTheDocument()
    })
    expect(screen.queryByTestId('session-activity-panel')).not.toBeInTheDocument()
    const timeline = useTeamStore.getState().workbenchesBySession[sessionId]
    expect(timeline?.snapshots.map(current => current.version)).toEqual(['v1', 'v2'])
    expect(timeline?.snapshots.at(-1)?.messages).toEqual([
      expect.objectContaining({ id: 'route-mapper-to-security-reviewer' }),
    ])

    act(() => {
      useChatStore.getState().handleServerMessage(sessionId, {
        type: 'tool_use_complete',
        toolName: 'Agent',
        toolUseId: 'direct-main-subagent',
        input: { description: 'Inspect a main-session seam' },
      })
    })

    // Filtering is ownership-based, not a blanket Activity shutdown: a
    // direct SubAgent spawned by the main session still opens the shared UI.
    const panel = await screen.findByTestId('session-activity-panel')
    expect(within(panel).getByText('Inspect a main-session seam')).toBeInTheDocument()
  })

  it('clears the last visible background task by closing Activity while preserving later runs', async () => {
    const sessionId = 'activity-background-clear-session'
    const otherSessionId = 'activity-background-other-session'

    useActivityPanelStore.getState().open(sessionId)
    useSessionStore.setState({
      sessions: [
        {
          id: sessionId,
          title: 'Background Clear Session',
          createdAt: '2026-05-07T00:00:00.000Z',
          modifiedAt: '2026-05-07T00:00:00.000Z',
          messageCount: 1,
          projectPath: '/workspace/project',
          workDir: '/workspace/project',
          workDirExists: true,
        },
        {
          id: otherSessionId,
          title: 'Other Session',
          createdAt: '2026-05-07T00:00:00.000Z',
          modifiedAt: '2026-05-07T00:00:00.000Z',
          messageCount: 1,
          projectPath: '/workspace/project',
          workDir: '/workspace/project',
          workDirExists: true,
        },
      ],
      activeSessionId: sessionId,
      isLoading: false,
      error: null,
    })
    useTabStore.setState({
      tabs: [
        { sessionId, title: 'Background Clear Session', type: 'session', status: 'idle' },
        { sessionId: otherSessionId, title: 'Other Session', type: 'session', status: 'idle' },
      ],
      activeTabId: sessionId,
    })
    useChatStore.setState({
      sessions: {
        [sessionId]: {
          messages: [{ id: 'msg-1', type: 'assistant_text', content: 'hello', timestamp: 1 }],
          backgroundAgentTasks: {
            'bash-task-1': {
              taskId: 'bash-task-1',
              toolUseId: 'bash-tool-1',
              status: 'completed',
              taskType: 'local_bash',
              description: 'Finished smoke run',
              startedAt: 1000,
              updatedAt: 2000,
            },
          },
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
        [otherSessionId]: {
          messages: [{ id: 'msg-2', type: 'assistant_text', content: 'other', timestamp: 2 }],
          backgroundAgentTasks: {},
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

    render(<ActiveSession />)

    expect(screen.getByText('Finished smoke run')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /clear finished/i }))

    expect(screen.queryByText('Finished smoke run')).not.toBeInTheDocument()
    // The panel close is debounced so transient empty states cannot hide it.
    await waitFor(() => {
      expect(useActivityPanelStore.getState().isOpen(sessionId)).toBe(false)
    }, { timeout: 4000 })
    expect(screen.queryByTestId('session-activity-panel')).not.toBeInTheDocument()

    act(() => {
      useTabStore.getState().setActiveTab(otherSessionId)
    })
    act(() => {
      useTabStore.getState().setActiveTab(sessionId)
    })

    expect(screen.queryByText('Finished smoke run')).not.toBeInTheDocument()

    act(() => {
      useChatStore.setState((state) => ({
        sessions: {
          ...state.sessions,
          [sessionId]: {
            ...state.sessions[sessionId]!,
            backgroundAgentTasks: {
              'bash-task-1': {
                taskId: 'bash-task-1',
                toolUseId: 'bash-tool-2',
                status: 'completed',
                taskType: 'local_bash',
                description: 'Finished smoke rerun',
                startedAt: 3000,
                updatedAt: 4000,
              },
            },
          },
        },
      }))
    })

    expect(screen.queryByText('Finished smoke rerun')).not.toBeInTheDocument()

    act(() => {
      useActivityPanelStore.getState().open(sessionId)
    })

    expect(screen.getByText('Finished smoke rerun')).toBeInTheDocument()
  })

  it('keeps the session header active while a background task is still running after the turn completes', () => {
    const sessionId = 'background-shell-running-session'

    useSessionStore.setState({
      sessions: [{
        id: sessionId,
        title: 'Background Shell Session',
        createdAt: '2026-05-07T00:00:00.000Z',
        modifiedAt: new Date().toISOString(),
        messageCount: 1,
        projectPath: '/workspace/project',
        workDir: '/workspace/project',
        workDirExists: true,
      }],
      activeSessionId: sessionId,
      isLoading: false,
      error: null,
    })
    useTabStore.setState({
      tabs: [{ sessionId, title: 'Background Shell Session', type: 'session', status: 'idle' }],
      activeTabId: sessionId,
    })
    useChatStore.setState({
      sessions: {
        [sessionId]: {
          messages: [{ id: 'msg-1', type: 'assistant_text', content: 'task started', timestamp: 1 }],
          backgroundAgentTasks: {
            'bash-task-1': {
              taskId: 'bash-task-1',
              toolUseId: 'bash-tool-1',
              status: 'running',
              taskType: 'local_bash',
              description: 'Run page integration checks',
              startedAt: 1,
              updatedAt: 2,
            },
          },
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

    render(<ActiveSession />)

    expect(screen.getByText(/session active|会话活跃中/)).toBeInTheDocument()
    expect(screen.getByTestId('chat-input')).toHaveAttribute('data-variant', 'default')
  })

  it('refreshes CLI tasks repeatedly while a turn is active', async () => {
    vi.useFakeTimers()

    const sessionId = 'polling-session'
    const originalCliTaskState = useCLITaskStore.getState()
    const fetchSessionTasks = vi.fn().mockResolvedValue(undefined)

    useCLITaskStore.setState({
      sessionId,
      tasks: [],
      fetchSessionTasks,
    })

    useSessionStore.setState({
      sessions: [{
        id: sessionId,
        title: 'Polling Session',
        createdAt: '2026-04-10T00:00:00.000Z',
        modifiedAt: '2026-04-10T00:00:00.000Z',
        messageCount: 1,
        projectPath: '',
        workDir: null,
        workDirExists: true,
      }],
      activeSessionId: sessionId,
      isLoading: false,
      error: null,
    })
    useTabStore.setState({
      tabs: [{ sessionId, title: 'Polling Session', type: 'session', status: 'idle' }],
      activeTabId: sessionId,
    })
    useChatStore.setState({
      sessions: {
        [sessionId]: {
          messages: [],
          chatState: 'thinking',
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

    const { unmount } = render(<ActiveSession />)

    expect(fetchSessionTasks).toHaveBeenCalledWith(sessionId)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2200)
    })

    expect(
      fetchSessionTasks.mock.calls.filter(([currentSessionId]) => currentSessionId === sessionId),
    ).toHaveLength(4)

    unmount()
    useCLITaskStore.setState(originalCliTaskState)
  })

  it('renders the workspace panel to the right of chat and supports resizing', () => {
    const sessionId = 'workspace-session'

    useSessionStore.setState({
      sessions: [{
        id: sessionId,
        title: 'Workspace Session',
        createdAt: '2026-04-10T00:00:00.000Z',
        modifiedAt: '2026-04-10T00:00:00.000Z',
        messageCount: 1,
        projectPath: '',
        workDir: '/tmp/project',
        workDirExists: true,
      }],
      activeSessionId: sessionId,
      isLoading: false,
      error: null,
    })
    useTabStore.setState({
      tabs: [{ sessionId, title: 'Workspace Session', type: 'session', status: 'idle' }],
      activeTabId: sessionId,
    })
    useChatStore.setState({
      sessions: {
        [sessionId]: {
          messages: [{ id: 'msg-1', type: 'assistant_text', content: 'hello', timestamp: 1 }],
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
    useWorkspaceStore.getState().openTarget(sessionId, { kind: 'file', path: 'src/a.ts' })

    render(<ActiveSession />)

    const contentRow = screen.getByTestId('active-session-content-row')
    const chatColumn = screen.getByTestId('active-session-chat-column')
    const resizeHandle = screen.getByTestId('workspace-resize-handle')

    const workbenchPanel = screen.getByTestId('workbench-panel')
    expect(workbenchPanel.style.maxWidth).toBe('70%')

    expect(within(contentRow).getByTestId('message-list')).toBeInTheDocument()
    expect(within(contentRow).getByTestId('message-list')).toHaveAttribute('data-compact', 'true')
    // The unified surface renders a tab strip even for a single tab, and the
    // four-entry launcher when the workspace is empty.
    expect(within(workbenchPanel).getByTestId('workspace-surface-side')).toBeInTheDocument()
    expect(within(workbenchPanel).getByTestId('workspace-tab-strip-side')).toBeInTheDocument()
    expect(within(chatColumn).getByTestId('chat-input')).toBeInTheDocument()
    expect(within(chatColumn).getByTestId('chat-input')).toHaveAttribute('data-compact', 'true')
    expect(chatColumn).toHaveClass('flex-1')
    expect(chatColumn).not.toHaveClass('shrink-0')
    expect(chatColumn).not.toHaveClass('border-r')
    expect(workbenchPanel).not.toHaveClass('border-l')
    expect(resizeHandle).toHaveClass('w-px', 'bg-[var(--color-border)]')
    expect(resizeHandle.firstElementChild).toHaveClass('-inset-x-1')
    expect(contentRow.children[0]).toBe(chatColumn)
    expect(contentRow.children[1]).toBe(resizeHandle)
    expect(contentRow.children[2]).toBe(workbenchPanel)

    act(() => {
      fireEvent.keyDown(resizeHandle, { key: 'ArrowLeft' })
    })

    expect(useWorkspaceStore.getState().sideWidth).toBe(WORKSPACE_SIDE_DEFAULT_WIDTH + 32)

    vi.spyOn(workbenchPanel, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      width: 558,
      height: 720,
      top: 0,
      right: 558,
      bottom: 720,
      left: 0,
      toJSON: () => ({}),
    })

    act(() => {
      const pointerDown = createEvent.pointerDown(resizeHandle)
      Object.defineProperty(pointerDown, 'button', { value: 0 })
      Object.defineProperty(pointerDown, 'clientX', { value: 100 })
      fireEvent(resizeHandle, pointerDown)
    })

    act(() => {
      const pointerMove = new Event('pointermove')
      Object.defineProperty(pointerMove, 'clientX', { value: 132 })
      window.dispatchEvent(pointerMove)
      window.dispatchEvent(new Event('pointerup'))
    })

    expect(useWorkspaceStore.getState().sideWidth).toBe(526)
  })

  it('does not render the workspace panel when closed', () => {
    const regularSessionId = 'regular-session'

    useSessionStore.setState({
      sessions: [{
        id: regularSessionId,
        title: 'Regular Session',
        createdAt: '2026-04-10T00:00:00.000Z',
        modifiedAt: '2026-04-10T00:00:00.000Z',
        messageCount: 0,
        projectPath: '',
        workDir: '/tmp/project',
        workDirExists: true,
      }],
      activeSessionId: regularSessionId,
      isLoading: false,
      error: null,
    })
    useTabStore.setState({
      tabs: [{ sessionId: regularSessionId, title: 'Regular Session', type: 'session', status: 'idle' }],
      activeTabId: regularSessionId,
    })
    useChatStore.setState({
      sessions: {
        [regularSessionId]: {
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

    render(<ActiveSession />)
    expect(screen.queryByTestId('workspace-surface-side')).not.toBeInTheDocument()
  })

  it('keeps chat as the primary surface on mobile by hiding workspace and terminal panels', () => {
    const sessionId = 'mobile-session'
    viewportMocks.isMobile = true

    useSessionStore.setState({
      sessions: [{
        id: sessionId,
        title: 'Mobile Session',
        createdAt: '2026-04-10T00:00:00.000Z',
        modifiedAt: '2026-04-10T00:00:00.000Z',
        messageCount: 1,
        projectPath: '/tmp/project-root',
        workDir: '/tmp/project-root',
        workDirExists: true,
      }],
      activeSessionId: sessionId,
      isLoading: false,
      error: null,
    })
    useTabStore.setState({
      tabs: [{ sessionId, title: 'Mobile Session', type: 'session', status: 'idle' }],
      activeTabId: sessionId,
    })
    useChatStore.setState({
      sessions: {
        [sessionId]: {
          messages: [{ id: 'msg-1', type: 'assistant_text', content: 'hello', timestamp: 1 }],
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
    useWorkspaceStore.getState().openTarget(sessionId, { kind: 'file', path: 'src/a.ts' })
    useWorkspaceStore.getState().toggleBottomPanel(
      sessionId,
      useSessionStore.getState().sessions.find((entry) => entry.id === sessionId)?.workDir ?? '',
    )

    render(<ActiveSession />)

    expect(screen.getByTestId('active-session-chat-column')).toHaveClass('min-w-0')
    expect(screen.getByTestId('message-list')).toHaveAttribute('data-compact', 'false')
    expect(screen.getByTestId('chat-input')).toHaveAttribute('data-compact', 'false')
    expect(screen.queryByRole('heading', { name: 'Mobile Session' })).not.toBeInTheDocument()
    expect(screen.queryByTestId('workspace-surface-side')).not.toBeInTheDocument()
    expect(screen.queryByTestId('workspace-resize-handle')).not.toBeInTheDocument()
    expect(screen.queryByTestId('session-terminal-panel')).not.toBeInTheDocument()
    expect(screen.queryByTestId('terminal-resize-handle')).not.toBeInTheDocument()
  })

  it('renders a bottom terminal panel in the current session cwd and can promote it to a tab', async () => {
    const sessionId = 'terminal-session'

    useSessionStore.setState({
      sessions: [{
        id: sessionId,
        title: 'Terminal Session',
        createdAt: '2026-04-10T00:00:00.000Z',
        modifiedAt: '2026-04-10T00:00:00.000Z',
        messageCount: 1,
        projectPath: '/tmp/project-root',
        workDir: '/tmp/project-root/packages/app',
        workDirExists: true,
      }],
      activeSessionId: sessionId,
      isLoading: false,
      error: null,
    })
    useTabStore.setState({
      tabs: [{ sessionId, title: 'Terminal Session', status: 'idle' } as ReturnType<typeof useTabStore.getState>['tabs'][number]],
      activeTabId: sessionId,
    })
    useChatStore.setState({
      sessions: {
        [sessionId]: {
          messages: [{ id: 'msg-1', type: 'assistant_text', content: 'hello', timestamp: 1 }],
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
    useWorkspaceStore.getState().toggleBottomPanel(
      sessionId,
      useSessionStore.getState().sessions.find((entry) => entry.id === sessionId)?.workDir ?? '',
    )

    render(<ActiveSession />)

    const panel = screen.getByTestId('session-terminal-panel')
    const resizeHandle = screen.getByTestId('terminal-resize-handle')
    const host = screen.getByTestId(`workspace-terminal-host-1`)

    expect(panel).toHaveStyle({ height: `${WORKSPACE_BOTTOM_DEFAULT_HEIGHT}px` })
    expect(host).toHaveAttribute('data-cwd', '/tmp/project-root/packages/app')
    expect(host).toHaveAttribute('data-active', 'true')
    expect(host).toHaveAttribute('data-preserve-on-unmount', 'true')
    expect(resizeHandle).toHaveAttribute('aria-valuemin', `${WORKSPACE_BOTTOM_MIN_HEIGHT}`)
    expect(resizeHandle).toHaveAttribute('aria-valuemax', `${WORKSPACE_BOTTOM_MAX_HEIGHT}`)
    // The hit target overlays the existing panel border instead of adding a
    // second visible line and a spacer above the terminal tabs.
    expect(panel).toHaveClass('relative', 'border-t')
    expect(resizeHandle).toHaveClass('absolute', 'bg-transparent')
    expect(resizeHandle.firstElementChild).toHaveClass('bg-transparent')

    act(() => {
      fireEvent.keyDown(resizeHandle, { key: 'ArrowUp' })
    })
    expect(useWorkspaceStore.getState().bottomHeight).toBe(WORKSPACE_BOTTOM_DEFAULT_HEIGHT + 24)

    await act(async () => {
      const pointerDown = createEvent.pointerDown(resizeHandle)
      Object.defineProperty(pointerDown, 'button', { value: 0 })
      Object.defineProperty(pointerDown, 'clientY', { value: 300 })
      fireEvent(resizeHandle, pointerDown)
    })

    await act(async () => {
      const pointerMove = new Event('pointermove')
      Object.defineProperty(pointerMove, 'clientY', { value: 260 })
      window.dispatchEvent(pointerMove)
      window.dispatchEvent(new Event('pointerup'))
    })
    expect(useWorkspaceStore.getState().bottomHeight).toBe(WORKSPACE_BOTTOM_DEFAULT_HEIGHT + 64)

    act(() => {
      fireEvent.keyDown(resizeHandle, { key: 'End' })
    })
    expect(useWorkspaceStore.getState().bottomHeight).toBe(WORKSPACE_BOTTOM_MAX_HEIGHT)

    act(() => {
      fireEvent.keyDown(resizeHandle, { key: 'Home' })
    })
    expect(useWorkspaceStore.getState().bottomHeight).toBe(WORKSPACE_BOTTOM_MIN_HEIGHT)

    act(() => {
      fireEvent.doubleClick(resizeHandle)
    })
    expect(useWorkspaceStore.getState().bottomHeight).toBe(WORKSPACE_BOTTOM_DEFAULT_HEIGHT)

    // Moving the terminal to the side dock keeps the same PTY and creates no
    // global app tab — the old "Open in Tab" promotion is gone on purpose.
    const terminalTabId = useWorkspaceStore.getState().getTabs(sessionId, 'bottom')[0]!.id
    const runtimeId = (useWorkspaceStore.getState().getTab(sessionId, terminalTabId) as {
      runtimeId: string
    }).runtimeId

    act(() => {
      useWorkspaceStore.getState().moveTabToDock(sessionId, terminalTabId, 'side')
    })

    expect(useWorkspaceStore.getState().getTabs(sessionId, 'side')).toHaveLength(1)
    expect((useWorkspaceStore.getState().getTab(sessionId, terminalTabId) as {
      runtimeId: string
    }).runtimeId).toBe(runtimeId)
    expect(useTabStore.getState().tabs.some((tab) => tab.type === 'terminal')).toBe(false)
  })

  it('keeps the docked terminal usable on a new empty session', () => {
    const sessionId = 'empty-terminal-session'

    useSessionStore.setState({
      sessions: [{
        id: sessionId,
        title: 'Empty Terminal Session',
        createdAt: '2026-04-10T00:00:00.000Z',
        modifiedAt: '2026-04-10T00:00:00.000Z',
        messageCount: 0,
        projectPath: '/tmp/project-root',
        workDir: '/tmp/project-root',
        workDirExists: true,
      }],
      activeSessionId: sessionId,
      isLoading: false,
      error: null,
    })
    useTabStore.setState({
      tabs: [{ sessionId, title: 'Empty Terminal Session', type: 'session', status: 'idle' }],
      activeTabId: sessionId,
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
    useWorkspaceStore.getState().toggleBottomPanel(
      sessionId,
      useSessionStore.getState().sessions.find((entry) => entry.id === sessionId)?.workDir ?? '',
    )

    render(<ActiveSession />)

    expect(screen.getByTestId('active-session-chat-column')).toHaveClass('min-h-0')
    expect(screen.getByTestId('empty-session-hero')).toHaveClass('min-h-0')
    expect(screen.getByTestId('empty-session-hero')).toHaveClass('pb-6')
    expect(screen.getByTestId('empty-session-hero')).not.toHaveClass('pb-32')
    expect(screen.getByTestId('session-terminal-panel')).toHaveStyle({ height: '420px' })
    expect(screen.getByTestId('terminal-resize-handle')).toHaveAttribute('aria-valuemax', '760')
  })

  it('keeps the docked terminal mounted when the panel is hidden', async () => {
    const sessionId = 'terminal-hide-session'

    useSessionStore.setState({
      sessions: [{
        id: sessionId,
        title: 'Terminal Hide Session',
        createdAt: '2026-04-10T00:00:00.000Z',
        modifiedAt: '2026-04-10T00:00:00.000Z',
        messageCount: 1,
        projectPath: '/tmp/project-root',
        workDir: '/tmp/project-root',
        workDirExists: true,
      }],
      activeSessionId: sessionId,
      isLoading: false,
      error: null,
    })
    useTabStore.setState({
      tabs: [{ sessionId, title: 'Terminal Hide Session', type: 'session', status: 'idle' }],
      activeTabId: sessionId,
    })
    useChatStore.setState({
      sessions: {
        [sessionId]: {
          messages: [{ id: 'msg-1', type: 'assistant_text', content: 'hello', timestamp: 1 }],
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
    useWorkspaceStore.getState().toggleBottomPanel(
      sessionId,
      useSessionStore.getState().sessions.find((entry) => entry.id === sessionId)?.workDir ?? '',
    )

    render(<ActiveSession />)

    const runtimeIdBefore = screen
      .getByTestId('workspace-terminal-host-1')
      .getAttribute('data-runtime-id')
    expect(runtimeIdBefore).toBeTruthy()

    act(() => useWorkspaceStore.getState().toggleBottomPanel(sessionId, '/tmp/project'))

    expect(useWorkspaceStore.getState().getSession(sessionId).bottomOpen).toBe(false)
    // Hidden, not unmounted, and still the same PTY: re-opening must come back
    // to the same shell rather than starting a new one.
    expect(screen.getByTestId('session-terminal-panel')).toHaveClass('hidden')
    expect(screen.getByTestId('workspace-terminal-host-1')).toHaveAttribute('data-active', 'false')
    expect(screen.getByTestId('workspace-terminal-host-1'))
      .toHaveAttribute('data-runtime-id', runtimeIdBefore!)
  })
})

describe('ActiveSession header', () => {
  // 回归锚点：标题曾经是 text-[22px] 且不截断，长标题会折成两行再加一行元数据，
  // 连同 pt-6/pb-4 把聊天区顶掉约 120px。标题必须单行截断，元数据留在它下面那行。
  const longTitle = 'Create a todo_cccc-ccccbb directory, write a throwaway todo app with react + vite + tailwindcss, then start it'

  function mountSessionWithLongTitle(sessionId: string) {
    useSessionStore.setState({
      sessions: [{
        id: sessionId,
        title: longTitle,
        createdAt: '2026-05-07T00:00:00.000Z',
        modifiedAt: new Date().toISOString(),
        messageCount: 2,
        projectPath: '/workspace/project',
        workDir: '/workspace/project',
        workDirExists: true,
      }],
      activeSessionId: sessionId,
      isLoading: false,
      error: null,
    })
    useTabStore.setState({
      tabs: [{ sessionId, title: longTitle, type: 'session', status: 'idle' }],
      activeTabId: sessionId,
    })
    useChatStore.setState({
      sessions: {
        [sessionId]: {
          messages: [
            { id: 'msg-1', type: 'user_text', content: 'hi', timestamp: 1 },
            { id: 'msg-2', type: 'assistant_text', content: 'hello', timestamp: 2 },
          ],
          chatState: 'idle',
          connectionState: 'connected',
          streamingText: '',
          streamingToolInput: '',
          activeToolUseId: null,
          activeToolName: null,
          activeThinkingId: null,
          pendingPermission: null,
          pendingComputerUsePermission: null,
          tokenUsage: { input_tokens: 12000, output_tokens: 3000 },
          streamingResponseChars: 0,
          elapsedSeconds: 0,
          statusVerb: '',
          slashCommands: [],
          agentTaskNotifications: {},
          elapsedTimer: null,
        },
      },
    })
  }

  it('keeps a long title on one truncated line and hovers the full text', () => {
    const sessionId = 'long-title-session'
    mountSessionWithLongTitle(sessionId)

    render(<ActiveSession />)

    const heading = within(screen.getByTestId('session-header')).getByRole('heading', { level: 1 })
    expect(heading).toHaveTextContent(longTitle)
    expect(heading).toHaveAttribute('title', longTitle)
    expect(heading).toHaveClass('truncate')
    expect(heading.className).not.toMatch(/text-\[22px\]/)
  })

  it('gives the metadata its own line under the title', () => {
    const sessionId = 'header-meta-session'
    mountSessionWithLongTitle(sessionId)

    render(<ActiveSession />)

    expect(screen.getByTestId('session-chat-surface')).toHaveAttribute(
      'data-session-chat-kind',
      'main',
    )
    const header = screen.getByTestId('session-header')
    const heading = within(header).getByRole('heading', { level: 1 })
    const titleRow = heading.parentElement as HTMLElement
    const meta = titleRow.nextElementSibling as HTMLElement

    // 元数据挤在标题右侧时会离标题很远，读起来像飘在角落的另一块内容。
    expect(within(titleRow).queryByText('2 messages')).not.toBeInTheDocument()
    expect(within(meta).getByText('2 messages')).toBeInTheDocument()
    expect(within(meta).getByText('15k API tokens')).toBeInTheDocument()
    expect(header).toHaveClass('py-3')
  })

  it('keeps the separators between metadata items, never in front of them', () => {
    const sessionId = 'idle-header-session'
    mountSessionWithLongTitle(sessionId)

    render(<ActiveSession />)

    const heading = within(screen.getByTestId('session-header')).getByRole('heading', { level: 1 })
    const meta = (heading.parentElement as HTMLElement).nextElementSibling as HTMLElement

    // 空闲会话只有三项元数据（tokens / 更新时间 / 消息数），之间两个「·」，开头不该有。
    // 分隔符是纯装饰，读屏时不该被念出来。
    expect(meta.textContent?.trimStart().startsWith('·')).toBe(false)
    expect(meta.querySelectorAll('[aria-hidden="true"]')).toHaveLength(2)
  })
})

describe('ActiveSession activity panel auto-close grace', () => {
  const sessionId = 'activity-grace-session'

  function seedActivitySession(overrides: Record<string, unknown> = {}) {
    useSessionStore.setState({
      sessions: [{
        id: sessionId,
        title: 'Activity Grace Session',
        createdAt: '2026-08-02T00:00:00.000Z',
        modifiedAt: '2026-08-02T00:00:00.000Z',
        messageCount: 1,
        projectPath: '/workspace/project',
        workDir: '/workspace/project',
        workDirExists: true,
      }],
      activeSessionId: sessionId,
      isLoading: false,
      error: null,
    })
    useTabStore.setState({
      tabs: [{ sessionId, title: 'Activity Grace Session', type: 'session', status: 'idle' }],
      activeTabId: sessionId,
    })
    useChatStore.setState({
      sessions: {
        [sessionId]: {
          messages: [{ id: 'm1', type: 'assistant_text', content: 'ready', timestamp: 1 }],
          chatState: 'idle',
          connectionState: 'connected',
          historyStatus: 'ready',
          historyError: null,
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
          backgroundAgentTasks: {
            'agent-task-1': {
              taskId: 'agent-task-1',
              taskType: 'agent',
              status: 'running',
              startedAt: 1,
              updatedAt: 1,
            },
          },
          elapsedTimer: null,
          ...overrides,
        },
      },
    })
  }

  function patchSession(overrides: Record<string, unknown>) {
    useChatStore.setState((state) => ({
      sessions: {
        ...state.sessions,
        [sessionId]: { ...state.sessions[sessionId], ...overrides },
      },
    }) as never)
  }

  it('keeps the panel open through transient empty states and only closes after the grace period', () => {
    vi.useFakeTimers()
    seedActivitySession()
    render(<ActiveSession />)
    act(() => {
      useActivityPanelStore.getState().open(sessionId)
    })
    expect(useActivityPanelStore.getState().isOpen(sessionId)).toBe(true)

    // History reload window: activity caches are briefly drained while loading.
    act(() => {
      patchSession({ backgroundAgentTasks: {}, messages: [], historyStatus: 'loading' })
      vi.advanceTimersByTime(5000)
    })
    expect(useActivityPanelStore.getState().isOpen(sessionId)).toBe(true)

    // Empty but settled: still within the grace period. The debounce timer is
    // scheduled when React flushes the effect at act exit, so patch and
    // advance in separate acts to keep the timeline honest.
    act(() => {
      patchSession({ historyStatus: 'ready' })
    })
    act(() => {
      vi.advanceTimersByTime(1000)
    })
    expect(useActivityPanelStore.getState().isOpen(sessionId)).toBe(true)

    // The empty state outlives the grace period: genuinely no activity left.
    act(() => {
      vi.advanceTimersByTime(1500)
    })
    expect(useActivityPanelStore.getState().isOpen(sessionId)).toBe(false)
  })

  it('cancels the pending close when activity reappears inside the grace period', () => {
    vi.useFakeTimers()
    seedActivitySession()
    render(<ActiveSession />)
    act(() => {
      useActivityPanelStore.getState().open(sessionId)
    })

    act(() => {
      patchSession({ backgroundAgentTasks: {}, messages: [], historyStatus: 'ready' })
      vi.advanceTimersByTime(1000)
    })
    act(() => {
      patchSession({
        messages: [{ id: 'm2', type: 'assistant_text', content: 'back', timestamp: 2 }],
        backgroundAgentTasks: {
          'agent-task-1': {
            taskId: 'agent-task-1',
            taskType: 'agent',
            status: 'running',
            startedAt: 1,
            updatedAt: 1,
          },
        },
      })
      vi.advanceTimersByTime(5000)
    })

    expect(useActivityPanelStore.getState().isOpen(sessionId)).toBe(true)
  })
})
