import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, createEvent, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import '@testing-library/jest-dom'
import { act } from 'react'

const viewportMocks = vi.hoisted(() => ({
  isMobile: false,
}))

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

vi.mock('../components/workbench/WorkbenchPanel', () => ({
  WorkbenchPanel: ({ sessionId }: { sessionId: string }) => (
    <div data-testid="workspace-panel">workspace:{sessionId}</div>
  ),
}))

vi.mock('../api/teams', () => ({
  teamsApi: {
    getMemberTranscript: vi.fn(() => Promise.resolve({ messages: [] })),
    get: vi.fn(),
    list: vi.fn(),
    sendMemberMessage: vi.fn(),
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
import { useChatStore } from '../stores/chatStore'
import { useCLITaskStore } from '../stores/cliTaskStore'
import { useSessionStore } from '../stores/sessionStore'
import { useSettingsStore } from '../stores/settingsStore'
import { useTabStore } from '../stores/tabStore'
import { useTeamStore } from '../stores/teamStore'
import { useWorkspacePanelStore } from '../stores/workspacePanelStore'
import { WORKSPACE_PANEL_DEFAULT_WIDTH } from '../stores/workspacePanelStore'
import { useTerminalPanelStore } from '../stores/terminalPanelStore'
import { useActivityPanelStore } from '../stores/activityPanelStore'
import {
  TERMINAL_PANEL_DEFAULT_HEIGHT,
  TERMINAL_PANEL_MAX_HEIGHT,
  TERMINAL_PANEL_MIN_HEIGHT,
} from '../stores/terminalPanelStore'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  viewportMocks.isMobile = false
  useTabStore.setState({ tabs: [], activeTabId: null })
  useSessionStore.setState({ sessions: [], activeSessionId: null, isLoading: false, error: null })
  useChatStore.setState({ sessions: {} })
  useSettingsStore.setState({ locale: 'en' })
  useTeamStore.getState().stopMemberPolling()
  useTeamStore.setState({ teams: [], activeTeam: null, memberColors: new Map(), error: null })
  useWorkspacePanelStore.setState(useWorkspacePanelStore.getInitialState(), true)
  useTerminalPanelStore.setState(useTerminalPanelStore.getInitialState(), true)
  useActivityPanelStore.setState(useActivityPanelStore.getInitialState(), true)
  useCLITaskStore.setState(useCLITaskStore.getInitialState(), true)
})

describe('ActiveSession task polling', () => {
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

  it('shows the session token badge when usage is cache-only', () => {
    const sessionId = 'cache-only-token-session'

    useSessionStore.setState({
      sessions: [{
        id: sessionId,
        title: 'Cache Only Token Session',
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
      tabs: [{ sessionId, title: 'Cache Only Token Session', type: 'session', status: 'idle' }],
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
          tokenUsage: {
            input_tokens: 0,
            output_tokens: 0,
            cache_read_tokens: 1200,
            cache_creation_tokens: 300,
          },
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

    const tokenBadge = screen.getByTitle(/1,500/)
    expect(tokenBadge).toHaveTextContent('1.5k')
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
      useWorkspacePanelStore.getState().openPanel(sessionId)
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
    })
  })

  it('auto-opens the activity panel when the current session first produces activity', async () => {
    const sessionId = 'activity-auto-open-session'
    const fetchSessionTasks = vi.fn().mockResolvedValue(undefined)

    useCLITaskStore.setState({ fetchSessionTasks })
    useSessionStore.setState({
      sessions: [{
        id: sessionId,
        title: 'Auto Open Activity Session',
        createdAt: '2026-05-07T00:00:00.000Z',
        modifiedAt: '2026-05-07T00:00:00.000Z',
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
      tabs: [{ sessionId, title: 'Auto Open Activity Session', type: 'session', status: 'idle' }],
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
    })
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
    })
    expect(useTabStore.getState().activeTabId).toBe('__subagent__activity-subagent-open-session__agent-tool-1')
  })

  it('opens a team member session from the activity panel', () => {
    const sessionId = 'team-activity-panel-session'
    const memberSessionId = 'team-member:security-reviewer@test-team'

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

    const panel = screen.getByTestId('session-activity-panel')
    expect(within(panel).queryByText('team-lead')).not.toBeInTheDocument()
    expect(within(panel).getByText('security-reviewer')).toBeInTheDocument()
    expect(within(panel).queryByText('Auditing auth flow')).not.toBeInTheDocument()

    fireEvent.click(within(panel).getByRole('button', { name: /open team member security-reviewer/i }))

    expect(useTabStore.getState().activeTabId).toBe(memberSessionId)
    expect(useTabStore.getState().tabs).toEqual(expect.arrayContaining([
      expect.objectContaining({ sessionId: memberSessionId, title: 'security-reviewer', type: 'session' }),
    ]))
  })

  it('clears the last visible background task by closing Activity while preserving later runs', () => {
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
    expect(screen.queryByTestId('session-activity-panel')).not.toBeInTheDocument()
    expect(useActivityPanelStore.getState().isOpen(sessionId)).toBe(false)

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

  it('keeps member sessions interactive and skips leader task polling', () => {
    const memberSessionId = 'team-member:security-reviewer@test-team'
    const originalCliTaskState = useCLITaskStore.getState()
    const fetchSessionTasks = vi.fn().mockResolvedValue(undefined)

    useCLITaskStore.setState({
      sessionId: null,
      tasks: [],
      fetchSessionTasks,
    })

    useTeamStore.setState({
      teams: [],
      activeTeam: {
        name: 'test-team',
        leadAgentId: 'team-lead@test-team',
        leadSessionId: 'leader-session',
        members: [
          {
            agentId: 'team-lead@test-team',
            role: 'team-lead',
            status: 'running',
            sessionId: 'leader-session',
          },
          {
            agentId: 'security-reviewer@test-team',
            role: 'security-reviewer',
            status: 'running',
          },
        ],
      },
      memberColors: new Map(),
      error: null,
    })

    useTabStore.setState({
      tabs: [{ sessionId: memberSessionId, title: 'security-reviewer', type: 'session', status: 'idle' }],
      activeTabId: memberSessionId,
    })

    useChatStore.setState({
      sessions: {
        [memberSessionId]: {
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
    useActivityPanelStore.getState().open(memberSessionId)

    const { queryByTestId, unmount } = render(<ActiveSession />)

    expect(queryByTestId('chat-input')).toBeInTheDocument()
    expect(queryByTestId('session-task-bar')).not.toBeInTheDocument()
    expect(queryByTestId('session-activity-panel')).not.toBeInTheDocument()
    expect(fetchSessionTasks).not.toHaveBeenCalled()

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
    useWorkspacePanelStore.getState().openPanel(sessionId)

    render(<ActiveSession />)

    const contentRow = screen.getByTestId('active-session-content-row')
    const chatColumn = screen.getByTestId('active-session-chat-column')
    const resizeHandle = screen.getByTestId('workspace-resize-handle')

    const workbenchPanel = screen.getByTestId('workbench-panel')

    expect(within(contentRow).getByTestId('message-list')).toBeInTheDocument()
    expect(within(contentRow).getByTestId('message-list')).toHaveAttribute('data-compact', 'true')
    expect(within(workbenchPanel).getByTestId('workspace-panel')).toHaveTextContent(`workspace:${sessionId}`)
    expect(within(chatColumn).getByTestId('chat-input')).toBeInTheDocument()
    expect(within(chatColumn).getByTestId('chat-input')).toHaveAttribute('data-compact', 'true')
    expect(chatColumn).toHaveClass('flex-1')
    expect(chatColumn).not.toHaveClass('shrink-0')
    expect(contentRow.children[0]).toBe(chatColumn)
    expect(contentRow.children[1]).toBe(resizeHandle)
    expect(contentRow.children[2]).toBe(workbenchPanel)

    act(() => {
      fireEvent.keyDown(resizeHandle, { key: 'ArrowLeft' })
    })

    expect(useWorkspacePanelStore.getState().width).toBe(WORKSPACE_PANEL_DEFAULT_WIDTH + 32)

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

    expect(useWorkspacePanelStore.getState().width).toBe(526)
  })

  it('does not render the workspace panel when closed or for member sessions', () => {
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

    const { rerender } = render(<ActiveSession />)
    expect(screen.queryByTestId('workspace-panel')).not.toBeInTheDocument()

    const memberSessionId = 'team-member:security-reviewer@test-team'
    act(() => {
      useTeamStore.setState({
        teams: [],
        activeTeam: {
          name: 'test-team',
          leadAgentId: 'team-lead@test-team',
          leadSessionId: 'leader-session',
          members: [
            {
              agentId: 'team-lead@test-team',
              role: 'team-lead',
              status: 'running',
              sessionId: 'leader-session',
            },
            {
              agentId: 'security-reviewer@test-team',
              role: 'security-reviewer',
              status: 'running',
            },
          ],
        },
        memberColors: new Map(),
        error: null,
      })
      useTabStore.setState({
        tabs: [{ sessionId: memberSessionId, title: 'security-reviewer', type: 'session', status: 'idle' }],
        activeTabId: memberSessionId,
      })
      useChatStore.setState({
        sessions: {
          [memberSessionId]: {
            messages: [{ id: 'msg-2', type: 'assistant_text', content: 'hello', timestamp: 1 }],
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
      useWorkspacePanelStore.getState().openPanel(memberSessionId)
      rerender(<ActiveSession />)
    })

    expect(screen.queryByTestId('workspace-panel')).not.toBeInTheDocument()
    expect(screen.getByTestId('message-list')).toBeInTheDocument()
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
    useWorkspacePanelStore.getState().openPanel(sessionId)
    useTerminalPanelStore.getState().openPanel(sessionId)

    render(<ActiveSession />)

    expect(screen.getByTestId('active-session-chat-column')).toHaveClass('min-w-0')
    expect(screen.getByTestId('message-list')).toHaveAttribute('data-compact', 'false')
    expect(screen.getByTestId('chat-input')).toHaveAttribute('data-compact', 'false')
    expect(screen.queryByRole('heading', { name: 'Mobile Session' })).not.toBeInTheDocument()
    expect(screen.queryByTestId('workspace-panel')).not.toBeInTheDocument()
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
    useTerminalPanelStore.getState().openPanel(sessionId)

    render(<ActiveSession />)

    const panel = screen.getByTestId('session-terminal-panel')
    const resizeHandle = screen.getByTestId('terminal-resize-handle')
    const host = screen.getByTestId(`session-terminal-host-${sessionId}`)

    expect(panel).toHaveStyle({ height: `${TERMINAL_PANEL_DEFAULT_HEIGHT}px` })
    expect(host).toHaveAttribute('data-cwd', '/tmp/project-root/packages/app')
    expect(host).toHaveAttribute('data-active', 'true')
    expect(host).toHaveAttribute('data-preserve-on-unmount', 'true')
    expect(resizeHandle).toHaveAttribute('aria-valuemin', `${TERMINAL_PANEL_MIN_HEIGHT}`)
    expect(resizeHandle).toHaveAttribute('aria-valuemax', `${TERMINAL_PANEL_MAX_HEIGHT}`)

    act(() => {
      fireEvent.keyDown(resizeHandle, { key: 'ArrowUp' })
    })
    expect(useTerminalPanelStore.getState().height).toBe(TERMINAL_PANEL_DEFAULT_HEIGHT + 24)

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
    expect(useTerminalPanelStore.getState().height).toBe(TERMINAL_PANEL_DEFAULT_HEIGHT + 64)

    act(() => {
      fireEvent.keyDown(resizeHandle, { key: 'End' })
    })
    expect(useTerminalPanelStore.getState().height).toBe(TERMINAL_PANEL_MAX_HEIGHT)

    act(() => {
      fireEvent.keyDown(resizeHandle, { key: 'Home' })
    })
    expect(useTerminalPanelStore.getState().height).toBe(TERMINAL_PANEL_MIN_HEIGHT)

    act(() => {
      fireEvent.doubleClick(resizeHandle)
    })
    expect(useTerminalPanelStore.getState().height).toBe(TERMINAL_PANEL_DEFAULT_HEIGHT)

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Open in Tab' }))
      await Promise.resolve()
    })

    const terminalTab = useTabStore.getState().tabs.find((tab) => tab.type === 'terminal')
    expect(useTerminalPanelStore.getState().isPanelOpen(sessionId)).toBe(false)
    expect(useTerminalPanelStore.getState().getPanelRuntimeId(sessionId)).toBeUndefined()
    expect(terminalTab?.terminalCwd).toBe('/tmp/project-root/packages/app')
    expect(terminalTab?.terminalRuntimeId).toBe(`__session_terminal__${sessionId}`)
    expect(useTabStore.getState().activeTabId).toBe(terminalTab?.sessionId)
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
    useTerminalPanelStore.getState().openPanel(sessionId)

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
    useTerminalPanelStore.getState().openPanel(sessionId)

    render(<ActiveSession />)

    fireEvent.click(screen.getByRole('button', { name: 'Close terminal panel' }))

    expect(useTerminalPanelStore.getState().isPanelOpen(sessionId)).toBe(false)
    expect(screen.getByTestId('session-terminal-panel')).toHaveClass('hidden')
    expect(screen.getByTestId(`session-terminal-host-${sessionId}`)).toHaveAttribute('data-active', 'false')
    expect(screen.getByTestId(`session-terminal-host-${sessionId}`)).toHaveAttribute('data-runtime-id', `__session_terminal__${sessionId}`)
  })
})
