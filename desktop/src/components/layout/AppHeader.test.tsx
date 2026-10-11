import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom'
import type { PerSessionState } from '../../stores/chatStore'
import type { BackgroundAgentTask, ChatState, ServerMessage, UIMessage } from '../../types/chat'
import type { TeamWorkbenchSessionTimeline, TeamWorkbenchTask, TeamWorkbenchTimeline } from '../../types/team'
import type { WorkflowRun } from '../../types/workflow'
import { browserHost } from '../../lib/desktopHost/browserHost'

type ToolUseMessage = Extract<UIMessage, { type: 'tool_use' }>

const startDraggingMock = vi.hoisted(() => vi.fn(() => Promise.resolve()))
const getCurrentWindowMock = vi.hoisted(() => vi.fn(() => ({
  startDragging: startDraggingMock,
})))
const windowControlsMock = vi.hoisted(() => ({
  show: true,
}))
const deleteSessionMock = vi.hoisted(() => vi.fn())
const openProjectMenuMock = vi.hoisted(() => ({
  paths: [] as Array<string | null | undefined>,
}))
const sessionsApiMock = vi.hoisted(() => ({
  delete: vi.fn(() => Promise.resolve()),
  rename: vi.fn(() => Promise.resolve()),
  getLiveStatus: vi.fn(() => Promise.resolve({ sessions: [] as Array<{ id: string; activityState: 'running' | 'waiting' }> })),
}))
const teamsApiMock = vi.hoisted(() => ({
  getWorkbenchForSession: vi.fn<() => Promise<TeamWorkbenchSessionTimeline>>(),
}))

function makeChatSession(chatState: ChatState, overrides: Partial<PerSessionState> = {}): PerSessionState {
  return {
    messages: [],
    chatState,
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

function makeBackgroundTask(
  taskId: string,
  overrides: Partial<BackgroundAgentTask> = {},
): BackgroundAgentTask {
  return {
    taskId,
    toolUseId: `tool-${taskId}`,
    status: 'running',
    taskType: 'local_bash',
    description: `Task ${taskId}`,
    startedAt: 1,
    updatedAt: 2,
    ...overrides,
  }
}

const completedTodoWriteMessage = (overrides: Partial<ToolUseMessage> = {}): UIMessage => ({
  id: 'todo-1',
  type: 'tool_use',
  toolName: 'TodoWrite',
  toolUseId: 'todo-1',
  input: {
    todos: [
      { content: 'Review existing implementation', status: 'completed' },
    ],
  },
  timestamp: 1000,
  ...overrides,
})

function teamWorkbenchTimeline(
  sessionId: string,
  options: { leadSessionId?: string; tasks?: TeamWorkbenchTask[] } = {},
): TeamWorkbenchTimeline {
  return {
    teamName: 'review-team',
    loading: false,
    error: null,
    snapshots: [{
      version: 'v1',
      generatedAt: '2026-08-08T00:00:00.000Z',
      team: {
        name: 'review-team',
        leadAgentId: 'lead',
        leadSessionId: options.leadSessionId ?? sessionId,
        createdAt: '2026-08-08T00:00:00.000Z',
        members: [
          { agentId: 'lead', role: 'Lead', status: 'running' },
          { agentId: 'security', role: 'Security reviewer', status: 'running' },
        ],
      },
      tasks: options.tasks ?? [],
      messages: [],
    }],
  }
}

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: getCurrentWindowMock,
}))

vi.mock('../../api/sessions', () => ({
  sessionsApi: {
    batchDelete: vi.fn(),
    branch: vi.fn(),
    create: vi.fn(),
    delete: deleteSessionMock,
    list: vi.fn(),
    rename: vi.fn(),
  },
}))

vi.mock('../../i18n', () => ({
  useTranslation: () => (key: string, params?: Record<string, string | number>) => {
    const translations: Record<string, string> = {
      'sidebar.extensions': 'Extension Market',
      'sidebar.sessionNeedsAttention': 'Waiting for your approval',
      'tabs.close': 'Close',
      'tabs.sessionRunning': 'Session running',
      'workspace.controls.toggleBottom': 'Toggle bottom panel',
      'workspace.controls.toggleSide': 'Show/hide side panel',
      'tabs.showWorkspace': 'Show Workspace',
      'tabs.hideWorkspace': 'Hide Workspace',
      'tabs.showBrowser': 'Show Browser',
      'tabs.hideBrowser': 'Hide Browser',
      'agentTeams.hideReport': 'Hide Agent Teams Run Report',
      'tabs.jumpToAttention': 'Jump to the next waiting session ({count} waiting)',
      'tabs.untitled': 'Untitled',
      'header.backTo': 'Back to {title}',
      'header.breadcrumb': 'Page path',
      'header.waitingCount': '{count} waiting',
      'header.renameSession': 'Session name',
      'header.renameHint': 'Double-click to rename',
      'header.sessionFailed': 'The last turn failed',
      'sidebar.newSession': 'New session',
      'sidebar.scheduled': 'Scheduled',
      'settings.title': 'Localized Settings',
      'openProject.openProject': 'Open project',
      'openProject.openIn': 'Open in {target}',
      'openProject.openFailed': 'Could not open project',
      'common.cancel': 'Cancel',
      'session.activity.title': 'Activity',
    }

    let text = translations[key] ?? key
    if (params) {
      for (const [paramKey, paramValue] of Object.entries(params)) {
        text = text.replace(new RegExp(`\\{${paramKey}\\}`, 'g'), String(paramValue))
      }
    }
    return text
  },
}))

vi.mock('../../api/sessions', () => ({
  sessionsApi: sessionsApiMock,
}))

vi.mock('../../api/teams', () => ({
  teamsApi: teamsApiMock,
}))

vi.mock('./OpenProjectMenu', () => ({
  OpenProjectMenu: ({ path }: { path: string | null | undefined }) => {
    if (!path) return null
    openProjectMenuMock.paths.push(path)
    return <div data-testid="open-project-menu">{path}</div>
  },
}))

vi.mock('./WindowControls', () => ({
  WindowControls: () => (windowControlsMock.show ? <div data-testid="window-controls" /> : null),
  get showWindowControls() {
    return windowControlsMock.show
  },
}))

describe('AppHeader', () => {
  const installElectronDesktopHost = () => {
    window.desktopHost = {
      ...browserHost,
      kind: 'electron',
      isDesktop: true,
      capabilities: {
        ...browserHost.capabilities,
        windowControls: true,
      },
      window: {
        ...browserHost.window,
        startDragging: startDraggingMock,
      },
    }
  }

  beforeEach(() => {
    class ResizeObserverMock {
      observe(_target: Element) {}
      disconnect() {}
      unobserve() {}
    }

    Object.defineProperty(window, 'ResizeObserver', {
      configurable: true,
      value: ResizeObserverMock,
    })

    Reflect.deleteProperty(window, '__TAURI__')
    installElectronDesktopHost()

    startDraggingMock.mockClear()
    getCurrentWindowMock.mockClear()
    deleteSessionMock.mockReset()
    deleteSessionMock.mockResolvedValue(undefined)
    openProjectMenuMock.paths = []
    sessionsApiMock.delete.mockClear()
    sessionsApiMock.delete.mockResolvedValue(undefined)
    sessionsApiMock.rename.mockReset()
    sessionsApiMock.getLiveStatus.mockReset()
    sessionsApiMock.getLiveStatus.mockResolvedValue({ sessions: [] })
    teamsApiMock.getWorkbenchForSession.mockReset()
    windowControlsMock.show = true
    vi.resetModules()
  })

  afterEach(async () => {
    cleanup()

    const { useTabStore } = await import('../../stores/tabStore')
    const { useChatStore } = await import('../../stores/chatStore')
    const { useSessionStore } = await import('../../stores/sessionStore')
    const { useActivityPanelStore } = await import('../../stores/activityPanelStore')
    const { useCLITaskStore } = await import('../../stores/cliTaskStore')
    const { useTeamStore } = await import('../../stores/teamStore')
    const { useWorkflowStore } = await import('../../stores/workflowStore')
    const { useWorkspaceStore } = await import('../../stores/workspaceStore')

    useTabStore.setState({ tabs: [], activeTabId: null })
    useChatStore.setState({
      sessions: {},
    } as Partial<ReturnType<typeof useChatStore.getState>>)
    useSessionStore.setState({
      sessions: [],
      activeSessionId: null,
      isLoading: false,
      error: null,
      isBatchMode: false,
      selectedSessionIds: new Set(),
    } as Partial<ReturnType<typeof useSessionStore.getState>>)
    useWorkspaceStore.setState(useWorkspaceStore.getInitialState(), true)
    useActivityPanelStore.setState(useActivityPanelStore.getInitialState(), true)
    useCLITaskStore.setState(useCLITaskStore.getInitialState(), true)
    useTeamStore.setState(useTeamStore.getInitialState(), true)
    useWorkflowStore.setState({ runs: {} })

    Reflect.deleteProperty(window, 'desktopHost')
    Reflect.deleteProperty(window, '__TAURI__')
  })

  it('owns the workspace layout controls in the window header and preserves resources across layout changes', async () => {
    const { AppHeader } = await import('./AppHeader')
    const { useTabStore } = await import('../../stores/tabStore')
    const { useWorkspaceStore } = await import('../../stores/workspaceStore')
    const sessionId = 'layout-session'
    useTabStore.setState({
      tabs: [{ sessionId, title: 'Layout session', type: 'session', status: 'idle' }],
      activeTabId: sessionId,
    })
    render(<AppHeader />)

    const side = screen.getByTestId('workspace-toggle-side')
    const bottom = screen.getByTestId('workspace-toggle-bottom')
    expect(screen.getByTestId('app-header')).toContainElement(side)
    expect(screen.getByTestId('app-header')).toContainElement(bottom)
    expect(screen.queryByTestId('workspace-toggle-fullscreen')).not.toBeInTheDocument()
    expect(document.querySelectorAll('[data-workspace-focus="side-toggle"]')).toHaveLength(1)
    expect(document.querySelectorAll('[data-workspace-focus="bottom-toggle"]')).toHaveLength(1)

    fireEvent.click(side)
    act(() => {
      useWorkspaceStore.getState().openTarget(sessionId, { kind: 'browser', url: 'https://fixture.test' })
      useWorkspaceStore.getState().openTarget(sessionId, { kind: 'file', path: 'README.md' })
    })
    fireEvent.click(bottom)
    const before = useWorkspaceStore.getState().getSession(sessionId).tabs
    expect(before).toHaveLength(3)
    expect(screen.getByTestId('app-header')).toContainElement(screen.getByTestId('workspace-toggle-fullscreen'))
    fireEvent.click(screen.getByTestId('workspace-toggle-fullscreen'))
    expect(useWorkspaceStore.getState().getSession(sessionId).layout).toBe('full')
    fireEvent.click(screen.getByTestId('workspace-toggle-fullscreen'))
    expect(useWorkspaceStore.getState().getSession(sessionId).layout).toBe('split')
    fireEvent.click(side)
    expect(useWorkspaceStore.getState().getSession(sessionId).layout).toBe('hidden')
    fireEvent.click(side)
    fireEvent.click(bottom)
    fireEvent.click(bottom)
    expect(useWorkspaceStore.getState().getSession(sessionId).tabs).toEqual(before)

    act(() => {
      useTabStore.getState().openTab('second-session', 'Second session')
    })
    expect(side).toHaveAttribute('aria-pressed', 'false')
    expect(bottom).toHaveAttribute('aria-pressed', 'false')
    fireEvent.click(side)
    expect(useWorkspaceStore.getState().getSession('second-session').layout).toBe('split')
    expect(useWorkspaceStore.getState().getSession(sessionId).tabs).toEqual(before)
  })

  it('hides the activity button for no-activity chat session tabs', async () => {
    const { AppHeader } = await import('./AppHeader')
    const { useTabStore } = await import('../../stores/tabStore')
    const { useChatStore } = await import('../../stores/chatStore')
    const { useSessionStore } = await import('../../stores/sessionStore')
    const sessionId = 'session-1'

    useTabStore.setState({
      tabs: [{ sessionId, title: 'Chat', type: 'session', status: 'idle' }],
      activeTabId: sessionId,
    })
    useSessionStore.setState({
      sessions: [{ id: sessionId, title: 'Chat', workDir: '/tmp/project', workDirExists: true }],
    } as Partial<ReturnType<typeof useSessionStore.getState>>)
    useChatStore.setState({
      sessions: {
        [sessionId]: makeChatSession('idle'),
      },
      disconnectSession: vi.fn(),
    } as Partial<ReturnType<typeof useChatStore.getState>>)

    await act(async () => {
      render(<AppHeader />)
    })

    expect(screen.queryByRole('button', { name: /activity/i })).not.toBeInTheDocument()
  })

  it('keeps the activity button available for a persisted workflow-only run', async () => {
    const { AppHeader } = await import('./AppHeader')
    const { useTabStore } = await import('../../stores/tabStore')
    const { useChatStore } = await import('../../stores/chatStore')
    const { useSessionStore } = await import('../../stores/sessionStore')
    const { useWorkflowStore } = await import('../../stores/workflowStore')
    const sessionId = 'workflow-only-session'
    const workflowRun: WorkflowRun = {
      taskId: 'workflow-task',
      sourceSessionId: sessionId,
      sessionId,
      workflowName: 'review-flow',
      status: 'completed',
      startedAt: 1000,
      updatedAt: 2000,
      agentCount: 1,
      totalTokens: 42,
      toolCalls: 1,
      progress: [
        { type: 'workflow_phase', index: 1, title: 'Review' },
        {
          type: 'workflow_agent',
          index: 1,
          label: 'Review the shared surface',
          state: 'done',
          phaseIndex: 1,
          phaseTitle: 'Review',
          agentId: 'workflow-agent-1',
        },
      ],
    }

    useTabStore.setState({
      tabs: [{ sessionId, title: 'Workflow session', type: 'session', status: 'idle' }],
      activeTabId: sessionId,
    })
    useSessionStore.setState({
      sessions: [{ id: sessionId, title: 'Workflow session', workDir: '/tmp/project', workDirExists: true }],
    } as Partial<ReturnType<typeof useSessionStore.getState>>)
    useChatStore.setState({
      sessions: { [sessionId]: makeChatSession('idle') },
      disconnectSession: vi.fn(),
    } as Partial<ReturnType<typeof useChatStore.getState>>)
    useWorkflowStore.setState({ runs: { workflow: workflowRun } })

    await act(async () => {
      render(<AppHeader />)
    })

    expect(screen.getByRole('button', { name: /activity/i })).toBeInTheDocument()
  })

  it('routes Agent Teams tasks to the workbench while keeping lead TodoWrite activity', async () => {
    const { AppHeader } = await import('./AppHeader')
    const { useTabStore } = await import('../../stores/tabStore')
    const { useChatStore } = await import('../../stores/chatStore')
    const { useSessionStore } = await import('../../stores/sessionStore')
    const { useTeamStore } = await import('../../stores/teamStore')
    const sessionId = 'team-task-ownership-session'

    useTabStore.setState({
      tabs: [{ sessionId, title: 'Team lead', type: 'session', status: 'idle' }],
      activeTabId: sessionId,
    })
    useSessionStore.setState({
      sessions: [{ id: sessionId, title: 'Team lead', workDir: '/tmp/project', workDirExists: true }],
    } as Partial<ReturnType<typeof useSessionStore.getState>>)
    useChatStore.setState({
      sessions: { [sessionId]: makeChatSession('idle') },
      disconnectSession: vi.fn(),
    } as Partial<ReturnType<typeof useChatStore.getState>>)
    useTeamStore.setState({
      workbenchesBySession: {
        [sessionId]: teamWorkbenchTimeline(sessionId),
      },
    } as Partial<ReturnType<typeof useTeamStore.getState>>)

    const handleServerMessage = useChatStore.getState().handleServerMessage
    handleServerMessage(sessionId, {
      type: 'tool_use_complete',
      toolName: 'TaskCreate',
      toolUseId: 'team-task-create',
      input: { subject: 'Review shared auth task' },
    })

    await act(async () => {
      render(<AppHeader />)
    })

    expect(screen.queryByRole('button', { name: /activity/i })).not.toBeInTheDocument()

    act(() => {
      handleServerMessage(sessionId, {
        type: 'tool_use_complete',
        toolName: 'TodoWrite',
        toolUseId: 'lead-personal-todo',
        input: {
          todos: [{ content: 'Summarize team delivery', status: 'in_progress' }],
        },
      })
    })

    expect(screen.getByRole('button', { name: /activity/i })).toBeInTheDocument()
  })

  it('keeps an owned Team DAG, roster, and member spawn out of Activity while preserving a direct SubAgent', async () => {
    const { AppHeader } = await import('./AppHeader')
    const { useTabStore } = await import('../../stores/tabStore')
    const { useChatStore } = await import('../../stores/chatStore')
    const { useSessionStore } = await import('../../stores/sessionStore')
    const { useTeamStore } = await import('../../stores/teamStore')
    const sessionId = 'completed-team-activity-session'
    const timeline = teamWorkbenchTimeline(sessionId, {
      tasks: [{
        id: 'A',
        subject: 'Review shared surface',
        description: '',
        status: 'completed',
        blocks: [],
        blockedBy: [],
        taskListId: 'review-team',
      }],
    })

    useTabStore.setState({
      tabs: [{ sessionId, title: 'Team lead', type: 'session', status: 'idle' }],
      activeTabId: sessionId,
    })
    useSessionStore.setState({
      sessions: [{ id: sessionId, title: 'Team lead', workDir: '/tmp/project', workDirExists: true }],
    } as Partial<ReturnType<typeof useSessionStore.getState>>)
    useChatStore.setState({
      sessions: { [sessionId]: makeChatSession('idle') },
      disconnectSession: vi.fn(),
    } as Partial<ReturnType<typeof useChatStore.getState>>)
    teamsApiMock.getWorkbenchForSession.mockResolvedValueOnce({
      sessionId,
      teamName: timeline.teamName,
      snapshots: timeline.snapshots,
      source: 'live',
    })

    await act(async () => {
      await useTeamStore.getState().fetchTeamForSession(sessionId, { force: true })
      const handleServerMessage = useChatStore.getState().handleServerMessage
      handleServerMessage(sessionId, {
        type: 'tool_use_complete',
        toolName: 'Agent',
        toolUseId: 'team-member-spawn',
        input: {
          team_name: timeline.teamName,
          name: 'late-reviewer',
          description: 'Review the shared Team DAG',
        },
      })
      handleServerMessage(sessionId, {
        type: 'tool_result',
        toolUseId: 'team-member-spawn',
        content: 'Agent launched successfully',
        isError: false,
      })
    })

    render(<AppHeader />)

    // All three inputs belong to the Agent Teams workbench, not the lead run:
    // its canonical DAG, its member roster, and the transcript launch row.
    expect(screen.queryByRole('button', { name: /activity/i })).not.toBeInTheDocument()
    expect(screen.queryByTestId('session-activity-badge')).not.toBeInTheDocument()

    act(() => {
      useChatStore.getState().handleServerMessage(sessionId, {
        type: 'tool_use_complete',
        toolName: 'Agent',
        toolUseId: 'direct-subagent-spawn',
        input: { description: 'Inspect a main-session seam' },
      })
    })

    // This proves Team filtering did not disable Activity wholesale: a direct
    // SubAgent spawned by the main session still owns a row there.
    expect(screen.getByRole('button', { name: /activity/i })).toBeInTheDocument()
  })

  it('hides the activity button for output-only activity rows', async () => {
    const { AppHeader } = await import('./AppHeader')
    const { useTabStore } = await import('../../stores/tabStore')
    const { useChatStore } = await import('../../stores/chatStore')
    const { useSessionStore } = await import('../../stores/sessionStore')
    const sessionId = 'session-1'
    const chatSession = makeChatSession('idle')
    chatSession.agentTaskNotifications = {
      'bash-tool-1': {
        taskId: 'bg-bash-1',
        toolUseId: 'bash-tool-1',
        status: 'completed',
        summary: 'Task completed',
        outputFile: '/tmp/bg-test.log',
      },
    }

    useTabStore.setState({
      tabs: [{ sessionId, title: 'Chat', type: 'session', status: 'idle' }],
      activeTabId: sessionId,
    })
    useSessionStore.setState({
      sessions: [{ id: sessionId, title: 'Chat', workDir: '/tmp/project', workDirExists: true }],
    } as Partial<ReturnType<typeof useSessionStore.getState>>)
    useChatStore.setState({
      sessions: {
        [sessionId]: chatSession,
      },
      disconnectSession: vi.fn(),
    } as Partial<ReturnType<typeof useChatStore.getState>>)

    await act(async () => {
      render(<AppHeader />)
    })

    expect(screen.queryByRole('button', { name: /activity/i })).not.toBeInTheDocument()
    expect(screen.queryByTestId('session-activity-badge')).not.toBeInTheDocument()
  })

  it('shows the activity button for completed TodoWrite history and hides it while the workspace is open', async () => {
    const { useWorkspaceStore } = await import('../../stores/workspaceStore')
    const { AppHeader } = await import('./AppHeader')
    const { useTabStore } = await import('../../stores/tabStore')
    const { useChatStore } = await import('../../stores/chatStore')
    const { useSessionStore } = await import('../../stores/sessionStore')
    const sessionId = 'session-1'
    const chatSession = makeChatSession('idle')
    chatSession.messages = [completedTodoWriteMessage()]

    useTabStore.setState({
      tabs: [{ sessionId, title: 'Chat', type: 'session', status: 'idle' }],
      activeTabId: sessionId,
    })
    useSessionStore.setState({
      sessions: [{ id: sessionId, title: 'Chat', workDir: '/tmp/project', workDirExists: true }],
    } as Partial<ReturnType<typeof useSessionStore.getState>>)
    useChatStore.setState({
      sessions: {
        [sessionId]: chatSession,
      },
      disconnectSession: vi.fn(),
    } as Partial<ReturnType<typeof useChatStore.getState>>)

    await act(async () => {
      render(<AppHeader />)
    })

    expect(screen.getByRole('button', { name: /activity/i })).toBeInTheDocument()
    expect(screen.queryByTestId('session-activity-badge')).not.toBeInTheDocument()

    act(() => {
      useWorkspaceStore.getState().openTarget(sessionId, { kind: 'file', path: 'a.ts' })
    })

    expect(screen.queryByRole('button', { name: /activity/i })).not.toBeInTheDocument()
  })

  it('does not re-derive Activity when another session streams (#1480)', async () => {
    // The strip derived Activity inside a store selector, and selectors run on
    // every update of every session. Each token of a background run cost one
    // pass over the on-screen session's whole transcript.
    const actual = await vi.importActual<typeof import('../activity/sessionActivityModel')>('../activity/sessionActivityModel')
    const derivedFor = vi.fn<(sessionId: string) => void>()
    vi.doMock('../activity/sessionActivityModel', () => ({
      ...actual,
      buildMainSessionActivityModel: (input: Parameters<typeof actual.buildMainSessionActivityModel>[0]) => {
        derivedFor(input.sessionId)
        return actual.buildMainSessionActivityModel(input)
      },
      getMainSessionActivityModel: (input: Parameters<typeof actual.getMainSessionActivityModel>[0]) => {
        derivedFor(input.sessionId)
        return actual.getMainSessionActivityModel(input)
      },
    }))
    try {
      const { AppHeader } = await import('./AppHeader')
      const { useTabStore } = await import('../../stores/tabStore')
      const { useChatStore } = await import('../../stores/chatStore')
      const onScreen = makeChatSession('idle')
      onScreen.messages = [completedTodoWriteMessage()]
      useTabStore.setState({
        tabs: [
          { sessionId: 'session-1', title: 'On screen', type: 'session', status: 'idle' },
          { sessionId: 'session-2', title: 'Background', type: 'session', status: 'running' },
        ],
        activeTabId: 'session-1',
      })
      useChatStore.setState({
        sessions: { 'session-1': onScreen, 'session-2': makeChatSession('streaming') },
        disconnectSession: vi.fn(),
      } as Partial<ReturnType<typeof useChatStore.getState>>)

      await act(async () => {
        render(<AppHeader />)
      })
      expect(screen.getByRole('button', { name: /activity/i })).toBeInTheDocument()

      derivedFor.mockClear()
      for (const chunk of ['Adding', 'Adding vehicle', 'Adding vehicle 401']) {
        act(() => {
          useChatStore.setState((state) => ({
            sessions: {
              ...state.sessions,
              'session-2': { ...state.sessions['session-2']!, streamingText: chunk },
            },
          }))
        })
      }
      expect(derivedFor).not.toHaveBeenCalled()

      // The on-screen session still drives it: clearing its history hides the button.
      act(() => {
        useChatStore.setState((state) => ({
          sessions: { ...state.sessions, 'session-1': { ...state.sessions['session-1']!, messages: [] } },
        }))
      })
      expect(derivedFor).toHaveBeenCalledWith('session-1')
      expect(screen.queryByRole('button', { name: /activity/i })).not.toBeInTheDocument()
    } finally {
      vi.doUnmock('../activity/sessionActivityModel')
    }
  })

  it('shows the activity button for a background task that starts after mount', async () => {
    // The strip derives Activity from inputs it selects one by one, so each of
    // them has to reach the derivation when it changes on its own.
    const { AppHeader } = await import('./AppHeader')
    const { useTabStore } = await import('../../stores/tabStore')
    const { useChatStore } = await import('../../stores/chatStore')
    useTabStore.setState({
      tabs: [{ sessionId: 'session-1', title: 'Chat', type: 'session', status: 'idle' }],
      activeTabId: 'session-1',
    })
    useChatStore.setState({
      sessions: { 'session-1': makeChatSession('idle') },
      disconnectSession: vi.fn(),
    } as Partial<ReturnType<typeof useChatStore.getState>>)

    await act(async () => {
      render(<AppHeader />)
    })
    expect(screen.queryByRole('button', { name: /activity/i })).not.toBeInTheDocument()

    // Only the task record changes: the transcript array keeps its identity.
    const withTasks = (tasks: BackgroundAgentTask[]) => {
      useChatStore.setState((state) => ({
        sessions: {
          ...state.sessions,
          'session-1': {
            ...state.sessions['session-1']!,
            backgroundAgentTasks: Object.fromEntries(tasks.map((task) => [task.taskId, task])),
          },
        },
      }))
    }
    act(() => withTasks([makeBackgroundTask('bg-1', { taskType: 'local_agent' })]))
    expect(screen.getByRole('button', { name: /activity/i })).toBeInTheDocument()

    act(() => withTasks([]))
    expect(screen.queryByRole('button', { name: /activity/i })).not.toBeInTheDocument()
  })

  it('shows the activity button without a numeric badge for running or failed activity', async () => {
    const { AppHeader } = await import('./AppHeader')
    const { useTabStore } = await import('../../stores/tabStore')
    const { useChatStore } = await import('../../stores/chatStore')
    const { useSessionStore } = await import('../../stores/sessionStore')
    const { useActivityPanelStore } = await import('../../stores/activityPanelStore')
    const sessionId = 'session-1'
    const chatSession = makeChatSession('idle')
    chatSession.backgroundAgentTasks = {
      'agent-1': {
        taskId: 'agent-1',
        toolUseId: 'tool-1',
        status: 'running',
        taskType: 'local_agent',
        description: 'Explore',
        startedAt: 1,
        updatedAt: 2,
      },
      'agent-2': {
        taskId: 'agent-2',
        toolUseId: 'tool-2',
        status: 'failed',
        taskType: 'local_agent',
        description: 'Report',
        startedAt: 3,
        updatedAt: 4,
      },
    }

    useTabStore.setState({
      tabs: [{ sessionId, title: 'Chat', type: 'session', status: 'idle' }],
      activeTabId: sessionId,
    })
    useSessionStore.setState({
      sessions: [{ id: sessionId, title: 'Chat', workDir: '/tmp/project', workDirExists: true }],
    } as Partial<ReturnType<typeof useSessionStore.getState>>)
    useChatStore.setState({
      sessions: {
        [sessionId]: chatSession,
      },
      disconnectSession: vi.fn(),
    } as Partial<ReturnType<typeof useChatStore.getState>>)

    await act(async () => {
      render(<AppHeader />)
    })

    const button = screen.getByRole('button', { name: /activity/i })
    expect(button).toBeInTheDocument()
    expect(screen.queryByTestId('session-activity-badge')).not.toBeInTheDocument()
    expect(useActivityPanelStore.getState().isOpen(sessionId)).toBe(false)
    expect(button).toHaveAttribute('aria-expanded', 'false')
    expect(button).toHaveAttribute('aria-pressed', 'false')

    fireEvent.click(button)

    expect(button).toHaveAttribute('data-active', 'true')
    expect(button).toHaveAttribute('aria-expanded', 'true')
    expect(button).toHaveAttribute('aria-pressed', 'true')
    expect(useActivityPanelStore.getState().isOpen(sessionId)).toBe(true)
  })

  it('leaves the team entry to the session-header strip', async () => {
    const { AppHeader } = await import('./AppHeader')
    const { useTabStore } = await import('../../stores/tabStore')
    const { useChatStore } = await import('../../stores/chatStore')
    const { useSessionStore } = await import('../../stores/sessionStore')
    const { useTeamStore } = await import('../../stores/teamStore')
    const sessionId = 'session-team'

    useTabStore.setState({
      tabs: [{ sessionId, title: 'Team Chat', type: 'session', status: 'idle' }],
      activeTabId: sessionId,
    })
    useSessionStore.setState({
      sessions: [{ id: sessionId, title: 'Team Chat', workDir: '/tmp/project', workDirExists: true }],
    } as Partial<ReturnType<typeof useSessionStore.getState>>)
    useChatStore.setState({
      sessions: {
        [sessionId]: makeChatSession('idle'),
      },
      disconnectSession: vi.fn(),
    } as Partial<ReturnType<typeof useChatStore.getState>>)
    useTeamStore.setState({
      activeTeam: {
        name: 'review-team',
        leadAgentId: 'lead',
        leadSessionId: sessionId,
        members: [
          { agentId: 'lead', role: 'Lead', status: 'running' },
          { agentId: 'security', role: 'Security reviewer', status: 'running' },
        ],
      },
      workbenchesBySession: {
        [sessionId]: teamWorkbenchTimeline(sessionId),
      },
    } as Partial<ReturnType<typeof useTeamStore.getState>>)

    await act(async () => {
      render(<AppHeader />)
    })

    // The toolbar carries no team toggle of its own — AgentTeamsStrip in the
    // session header owns that entry, under the very same condition.
    expect(screen.queryByRole('button', { name: /Agent Teams/i })).not.toBeInTheDocument()
    // A team existing is not a reason to take over the right-hand slot, so the
    // workspace entry stays reachable.
    expect(screen.getByRole('button', { name: 'Show Workspace' })).toBeInTheDocument()

    expect(useTeamStore.getState().workbenchesBySession[sessionId]?.snapshots).toHaveLength(1)
  })

  it('opens the workspace panel without mutating the team workbench timeline', async () => {
    const { useWorkspaceStore } = await import('../../stores/workspaceStore')
    const { AppHeader } = await import('./AppHeader')
    const { useTabStore } = await import('../../stores/tabStore')
    const { useChatStore } = await import('../../stores/chatStore')
    const { useSessionStore } = await import('../../stores/sessionStore')
    const { useTeamStore } = await import('../../stores/teamStore')
    const sessionId = 'session-team'

    useTabStore.setState({
      tabs: [{ sessionId, title: 'Team Chat', type: 'session', status: 'idle' }],
      activeTabId: sessionId,
    })
    useSessionStore.setState({
      sessions: [{ id: sessionId, title: 'Team Chat', workDir: '/tmp/project', workDirExists: true }],
    } as Partial<ReturnType<typeof useSessionStore.getState>>)
    useChatStore.setState({
      sessions: { [sessionId]: makeChatSession('idle') },
      disconnectSession: vi.fn(),
    } as Partial<ReturnType<typeof useChatStore.getState>>)
    useTeamStore.setState({
      workbenchesBySession: { [sessionId]: teamWorkbenchTimeline(sessionId) },
    } as Partial<ReturnType<typeof useTeamStore.getState>>)

    await act(async () => {
      render(<AppHeader />)
    })

    fireEvent.click(screen.getByRole('button', { name: 'Show Workspace' }))

    expect(useWorkspaceStore.getState().getSession(sessionId).layout).not.toBe('hidden')
    expect(useTeamStore.getState().workbenchesBySession[sessionId]?.snapshots).toHaveLength(1)
  })

  it('hides team-only activity when the active team belongs to another session', async () => {
    const { AppHeader } = await import('./AppHeader')
    const { useTabStore } = await import('../../stores/tabStore')
    const { useChatStore } = await import('../../stores/chatStore')
    const { useSessionStore } = await import('../../stores/sessionStore')
    const { useTeamStore } = await import('../../stores/teamStore')
    const sessionId = 'session-team'

    useTabStore.setState({
      tabs: [{ sessionId, title: 'Team Chat', type: 'session', status: 'idle' }],
      activeTabId: sessionId,
    })
    useSessionStore.setState({
      sessions: [{ id: sessionId, title: 'Team Chat', workDir: '/tmp/project', workDirExists: true }],
    } as Partial<ReturnType<typeof useSessionStore.getState>>)
    useChatStore.setState({
      sessions: {
        [sessionId]: makeChatSession('idle'),
      },
      disconnectSession: vi.fn(),
    } as Partial<ReturnType<typeof useChatStore.getState>>)
    useTeamStore.setState({
      activeTeam: {
        name: 'other-review-team',
        leadAgentId: 'lead',
        leadSessionId: 'other-session',
        members: [
          { agentId: 'security', role: 'Security reviewer', status: 'running' },
        ],
      },
      workbenchesBySession: {
        [sessionId]: teamWorkbenchTimeline(sessionId, {
          leadSessionId: 'other-session',
          tasks: [{
            id: 'other-task',
            subject: 'Other lead task',
            description: '',
            status: 'completed',
            blocks: [],
            blockedBy: [],
            taskListId: 'other-review-team',
          }],
        }),
      },
    } as Partial<ReturnType<typeof useTeamStore.getState>>)

    await act(async () => {
      render(<AppHeader />)
    })

    expect(screen.queryByRole('button', { name: /activity/i })).not.toBeInTheDocument()
    expect(screen.queryByTestId('session-activity-badge')).not.toBeInTheDocument()
  })

  it('keeps the activity rail absent when a workbench arrives after initial render', async () => {
    const { AppHeader } = await import('./AppHeader')
    const { useTabStore } = await import('../../stores/tabStore')
    const { useChatStore } = await import('../../stores/chatStore')
    const { useSessionStore } = await import('../../stores/sessionStore')
    const { useTeamStore } = await import('../../stores/teamStore')
    const sessionId = 'session-team'

    useTabStore.setState({
      tabs: [{ sessionId, title: 'Team Chat', type: 'session', status: 'idle' }],
      activeTabId: sessionId,
    })
    useSessionStore.setState({
      sessions: [{ id: sessionId, title: 'Team Chat', workDir: '/tmp/project', workDirExists: true }],
    } as Partial<ReturnType<typeof useSessionStore.getState>>)
    useChatStore.setState({
      sessions: {
        [sessionId]: makeChatSession('idle'),
      },
      disconnectSession: vi.fn(),
    } as Partial<ReturnType<typeof useChatStore.getState>>)

    await act(async () => {
      render(<AppHeader />)
    })

    expect(screen.queryByRole('button', { name: /activity/i })).not.toBeInTheDocument()

    await act(async () => {
      useTeamStore.setState({
        activeTeam: {
          name: 'review-team',
          leadAgentId: 'lead',
          leadSessionId: sessionId,
          members: [
            { agentId: 'security', role: 'Security reviewer', status: 'error' },
          ],
        },
        workbenchesBySession: {
          [sessionId]: teamWorkbenchTimeline(sessionId),
        },
      } as Partial<ReturnType<typeof useTeamStore.getState>>)
    })

    expect(screen.queryByRole('button', { name: /activity/i })).not.toBeInTheDocument()
    expect(screen.queryByTestId('session-activity-badge')).not.toBeInTheDocument()
    // The workspace entry survives a team arriving mid-session, and the
    // toolbar gains nothing — the team entry lives in the session header.
    expect(screen.getByRole('button', { name: 'Show Workspace' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Agent Teams/i })).not.toBeInTheDocument()
  })

  it('does not show the activity button for settings tabs', async () => {
    const { AppHeader } = await import('./AppHeader')
    const { SETTINGS_TAB_ID, useTabStore } = await import('../../stores/tabStore')

    useTabStore.setState({
      tabs: [{ sessionId: SETTINGS_TAB_ID, title: 'Settings', type: 'settings', status: 'idle' }],
      activeTabId: SETTINGS_TAB_ID,
    })

    await act(async () => {
      render(<AppHeader />)
    })

    expect(screen.queryByRole('button', { name: /activity/i })).not.toBeInTheDocument()
  })

  it('shows current-session CLI tasks without a numeric activity badge', async () => {
    const { AppHeader } = await import('./AppHeader')
    const { useTabStore } = await import('../../stores/tabStore')
    const { useChatStore } = await import('../../stores/chatStore')
    const { useSessionStore } = await import('../../stores/sessionStore')
    const { useCLITaskStore } = await import('../../stores/cliTaskStore')
    const sessionId = 'session-1'

    useTabStore.setState({
      tabs: [{ sessionId, title: 'Chat', type: 'session', status: 'idle' }],
      activeTabId: sessionId,
    })
    useSessionStore.setState({
      sessions: [{ id: sessionId, title: 'Chat', workDir: '/tmp/project', workDirExists: true }],
    } as Partial<ReturnType<typeof useSessionStore.getState>>)
    useChatStore.setState({
      sessions: {
        [sessionId]: makeChatSession('idle'),
      },
      disconnectSession: vi.fn(),
    } as Partial<ReturnType<typeof useChatStore.getState>>)
    useCLITaskStore.setState({
      sessionId,
      tasks: [
        {
          id: 'task-1',
          subject: 'Plan work',
          description: '',
          status: 'pending',
          blocks: [],
          blockedBy: [],
          taskListId: sessionId,
        },
        {
          id: 'task-2',
          subject: 'Ship work',
          description: '',
          status: 'in_progress',
          blocks: [],
          blockedBy: [],
          taskListId: sessionId,
        },
      ],
      completedAndDismissed: false,
    })

    await act(async () => {
      render(<AppHeader />)
    })

    expect(screen.queryByTestId('session-activity-badge')).not.toBeInTheDocument()
  })

  it('keeps running activity available without showing a numeric badge', async () => {
    const { AppHeader } = await import('./AppHeader')
    const { useTabStore } = await import('../../stores/tabStore')
    const { useChatStore } = await import('../../stores/chatStore')
    const { useSessionStore } = await import('../../stores/sessionStore')
    const { useActivityPanelStore } = await import('../../stores/activityPanelStore')
    const { createBackgroundTaskDismissKey } = await import('../../lib/backgroundTasks')
    const sessionId = 'session-1'
    const failedTask = {
      taskId: 'failed-task-1',
      toolUseId: 'failed-tool-1',
      status: 'failed' as const,
      taskType: 'local_bash',
      description: 'Failed run',
      startedAt: 1000,
      updatedAt: 2000,
    }
    const runningTask = {
      taskId: 'running-task-1',
      toolUseId: 'running-tool-1',
      status: 'running' as const,
      taskType: 'local_bash',
      description: 'Running run',
      startedAt: 1000,
      updatedAt: 2000,
    }
    const chatSession = makeChatSession('idle')
    chatSession.backgroundAgentTasks = {
      [failedTask.taskId]: failedTask,
      [runningTask.taskId]: runningTask,
    }

    useActivityPanelStore.getState().dismissBackgroundTaskKeys(sessionId, [
      createBackgroundTaskDismissKey(failedTask),
    ])
    useTabStore.setState({
      tabs: [{ sessionId, title: 'Chat', type: 'session', status: 'idle' }],
      activeTabId: sessionId,
    })
    useSessionStore.setState({
      sessions: [{ id: sessionId, title: 'Chat', workDir: '/tmp/project', workDirExists: true }],
    } as Partial<ReturnType<typeof useSessionStore.getState>>)
    useChatStore.setState({
      sessions: {
        [sessionId]: chatSession,
      },
      disconnectSession: vi.fn(),
    } as Partial<ReturnType<typeof useChatStore.getState>>)

    await act(async () => {
      render(<AppHeader />)
    })

    expect(screen.queryByTestId('session-activity-badge')).not.toBeInTheDocument()
  })

  it('ignores CLI tasks from a different session in the activity badge', async () => {
    const { AppHeader } = await import('./AppHeader')
    const { useTabStore } = await import('../../stores/tabStore')
    const { useChatStore } = await import('../../stores/chatStore')
    const { useSessionStore } = await import('../../stores/sessionStore')
    const { useCLITaskStore } = await import('../../stores/cliTaskStore')

    useTabStore.setState({
      tabs: [{ sessionId: 'session-1', title: 'Chat', type: 'session', status: 'idle' }],
      activeTabId: 'session-1',
    })
    useSessionStore.setState({
      sessions: [{ id: 'session-1', title: 'Chat', workDir: '/tmp/project', workDirExists: true }],
    } as Partial<ReturnType<typeof useSessionStore.getState>>)
    useChatStore.setState({
      sessions: {
        'session-1': makeChatSession('idle'),
      },
      disconnectSession: vi.fn(),
    } as Partial<ReturnType<typeof useChatStore.getState>>)
    useCLITaskStore.setState({
      sessionId: 'session-2',
      tasks: [{
        id: 'task-1',
        subject: 'Other session work',
        description: '',
        status: 'in_progress',
        blocks: [],
        blockedBy: [],
        taskListId: 'session-2',
      }],
      completedAndDismissed: false,
    })

    await act(async () => {
      render(<AppHeader />)
    })

    expect(screen.queryByRole('button', { name: /activity/i })).not.toBeInTheDocument()
    expect(screen.queryByTestId('session-activity-badge')).not.toBeInTheDocument()
  })

  it('keeps the window gutter on the panel paper while the workspace is open', async () => {
    const { AppHeader } = await import('./AppHeader')
    const { useTabStore } = await import('../../stores/tabStore')
    const { useChatStore } = await import('../../stores/chatStore')
    const { useWorkspaceStore } = await import('../../stores/workspaceStore')
    // Imported here, not at the top of the file: `vi.resetModules()` hands the
    // strip a fresh provider module, and a statically imported one would be a
    // second React context that the strip can never see.
    const { WorkspaceHeaderProvider } = await import('./WorkspaceHeaderContext')
    const sessionId = 'gutter-session'

    useTabStore.setState({
      tabs: [{ sessionId, title: 'Gutter session', type: 'session', status: 'idle' }],
      activeTabId: sessionId,
    })
    useChatStore.setState({
      sessions: {},
      disconnectSession: vi.fn(),
    } as Partial<ReturnType<typeof useChatStore.getState>>)

    await act(async () => {
      // The window owns the header slot; without it the strip falls back to
      // the dock and there is no header frame to paint.
      render(<WorkspaceHeaderProvider><AppHeader /></WorkspaceHeaderProvider>)
    })

    const frame = screen.getByTestId('workspace-header-frame')
    const gutter = screen.getByTestId('app-header-drag-gutter')

    // Closed, the trough runs to the window edge and the gutter disappears
    // into it; the frame paints nothing of its own.
    expect(frame.className).not.toMatch(/\bbg-\[/)

    // Open, everything above the panel is one ground — the trough the
    // workspace's resource tabs sit in, not paper. The gutter is a transparent
    // sibling of the header, so the element that paints has to contain it.
    await act(async () => {
      useWorkspaceStore.getState().toggleWorkspace(sessionId)
    })
    expect(frame).toHaveClass('bg-[var(--color-surface-sidebar)]')
    expect(frame).not.toHaveClass('bg-[var(--color-surface)]')
    expect(frame).toContainElement(gutter)
  })

  it('keeps the open workspace header as window chrome instead of a no-drag tab strip', async () => {
    const { AppHeader } = await import('./AppHeader')
    const { useTabStore } = await import('../../stores/tabStore')
    const { useChatStore } = await import('../../stores/chatStore')
    const { useWorkspaceStore } = await import('../../stores/workspaceStore')
    const { WorkspaceHeaderProvider } = await import('./WorkspaceHeaderContext')
    const sessionId = 'header-drag-session'

    useTabStore.setState({
      tabs: [{ sessionId, title: 'Header drag session', type: 'session', status: 'idle' }],
      activeTabId: sessionId,
    })
    useChatStore.setState({
      sessions: {},
      disconnectSession: vi.fn(),
    } as Partial<ReturnType<typeof useChatStore.getState>>)

    await act(async () => {
      render(<WorkspaceHeaderProvider><AppHeader /></WorkspaceHeaderProvider>)
    })
    await act(async () => {
      useWorkspaceStore.getState().toggleWorkspace(sessionId)
    })

    const slot = screen.getByTestId('workspace-header-slot')
    const header = screen.getByTestId('workspace-window-header')
    // `tab-bar-interactive` marks the node *and every descendant* as no-drag.
    // The slot hosts the resource strip's leftover flex space, so that class
    // would make the circled empty titlebar undraggable on every platform.
    expect(slot).toHaveAttribute('data-desktop-drag-region')
    expect(slot.className).not.toMatch(/\btab-bar-interactive\b/)
    expect(header).toHaveAttribute('data-desktop-drag-region')
  })

  it('passes the active session workdir into the open-project control', async () => {
    const { AppHeader } = await import('./AppHeader')
    const { useTabStore } = await import('../../stores/tabStore')
    const { useChatStore } = await import('../../stores/chatStore')
    const { useSessionStore } = await import('../../stores/sessionStore')

    useTabStore.setState({
      tabs: [
        { sessionId: 'tab-1', title: 'Workspace Session', type: 'session', status: 'idle' },
      ],
      activeTabId: 'tab-1',
    })
    useChatStore.setState({
      sessions: {},
      disconnectSession: vi.fn(),
    } as Partial<ReturnType<typeof useChatStore.getState>>)
    useSessionStore.setState({
      sessions: [{
        id: 'tab-1',
        title: 'Workspace Session',
        createdAt: '2026-05-13T00:00:00.000Z',
        modifiedAt: '2026-05-13T00:00:00.000Z',
        messageCount: 0,
        projectPath: '/repo',
        workDir: '/repo/worktree',
        workDirExists: true,
      }],
      activeSessionId: 'tab-1',
    })

    await act(async () => {
      render(<AppHeader />)
    })

    expect(screen.getByTestId('open-project-menu')).toHaveTextContent('/repo/worktree')
    expect(openProjectMenuMock.paths[openProjectMenuMock.paths.length - 1]).toBe('/repo/worktree')
  })

  it('does not rerender for chat payload changes when tab running state is unchanged', async () => {
    const { AppHeader } = await import('./AppHeader')
    const { useTabStore } = await import('../../stores/tabStore')
    const { useChatStore } = await import('../../stores/chatStore')
    const { useSessionStore } = await import('../../stores/sessionStore')

    useTabStore.setState({
      tabs: [
        { sessionId: 'tab-1', title: 'Workspace Session', type: 'session', status: 'idle' },
      ],
      activeTabId: 'tab-1',
    })
    useChatStore.setState({
      sessions: {
        'tab-1': makeChatSession('idle'),
      },
      disconnectSession: vi.fn(),
    } as Partial<ReturnType<typeof useChatStore.getState>>)
    useSessionStore.setState({
      sessions: [{
        id: 'tab-1',
        title: 'Workspace Session',
        createdAt: '2026-05-13T00:00:00.000Z',
        modifiedAt: '2026-05-13T00:00:00.000Z',
        messageCount: 0,
        projectPath: '/repo',
        workDir: '/repo/worktree',
        workDirExists: true,
      }],
      activeSessionId: 'tab-1',
    })

    await act(async () => {
      render(<AppHeader />)
    })
    expect(openProjectMenuMock.paths[openProjectMenuMock.paths.length - 1]).toBe('/repo/worktree')

    openProjectMenuMock.paths = []
    await act(async () => {
      useChatStore.setState((state) => ({
        sessions: {
          ...state.sessions,
          'tab-1': {
            ...state.sessions['tab-1']!,
            streamingText: 'token churn should not affect tab chrome',
          },
        },
      }))
    })

    expect(openProjectMenuMock.paths).toEqual([])
  })

  it('hides the open-project control when the active session workdir is unavailable', async () => {
    const { AppHeader } = await import('./AppHeader')
    const { useTabStore } = await import('../../stores/tabStore')
    const { useChatStore } = await import('../../stores/chatStore')
    const { useSessionStore } = await import('../../stores/sessionStore')

    useTabStore.setState({
      tabs: [
        { sessionId: 'tab-1', title: 'Workspace Session', type: 'session', status: 'idle' },
      ],
      activeTabId: 'tab-1',
    })
    useChatStore.setState({
      sessions: {},
      disconnectSession: vi.fn(),
    } as Partial<ReturnType<typeof useChatStore.getState>>)
    useSessionStore.setState({
      sessions: [{
        id: 'tab-1',
        title: 'Workspace Session',
        createdAt: '2026-05-13T00:00:00.000Z',
        modifiedAt: '2026-05-13T00:00:00.000Z',
        messageCount: 0,
        projectPath: '/repo',
        workDir: '/repo/worktree',
        workDirExists: false,
      }],
      activeSessionId: 'tab-1',
    })

    await act(async () => {
      render(<AppHeader />)
    })

    expect(screen.queryByTestId('open-project-menu')).not.toBeInTheDocument()
  })

  it('opens the source project for a cleaned worktree session', async () => {
    const { AppHeader } = await import('./AppHeader')
    const { useTabStore } = await import('../../stores/tabStore')
    const { useChatStore } = await import('../../stores/chatStore')
    const { useSessionStore } = await import('../../stores/sessionStore')

    useTabStore.setState({
      tabs: [
        { sessionId: 'tab-1', title: 'Cleaned Worktree', type: 'session', status: 'idle' },
      ],
      activeTabId: 'tab-1',
    })
    useChatStore.setState({
      sessions: {},
      disconnectSession: vi.fn(),
    } as Partial<ReturnType<typeof useChatStore.getState>>)
    useSessionStore.setState({
      sessions: [{
        id: 'tab-1',
        title: 'Cleaned Worktree',
        createdAt: '2026-05-13T00:00:00.000Z',
        modifiedAt: '2026-05-13T00:00:00.000Z',
        messageCount: 0,
        projectPath: '/repo-worktree',
        projectRoot: '/repo',
        workDir: '/repo/.claude/worktrees/desktop-main-12345678',
        workDirExists: false,
        workspaceState: 'worktree_removed',
      }],
      activeSessionId: 'tab-1',
    })

    await act(async () => {
      render(<AppHeader />)
    })

    expect(screen.getByTestId('open-project-menu')).toBeInTheDocument()
    expect(openProjectMenuMock.paths[openProjectMenuMock.paths.length - 1]).toBe('/repo')
  })

  it('hides the open-project control outside the desktop shell', async () => {
    Reflect.deleteProperty(window, 'desktopHost')

    const { AppHeader } = await import('./AppHeader')
    const { useTabStore } = await import('../../stores/tabStore')
    const { useChatStore } = await import('../../stores/chatStore')
    const { useSessionStore } = await import('../../stores/sessionStore')

    useTabStore.setState({
      tabs: [
        { sessionId: 'tab-1', title: 'Workspace Session', type: 'session', status: 'idle' },
      ],
      activeTabId: 'tab-1',
    })
    useChatStore.setState({
      sessions: {},
      disconnectSession: vi.fn(),
    } as Partial<ReturnType<typeof useChatStore.getState>>)
    useSessionStore.setState({
      sessions: [{
        id: 'tab-1',
        title: 'Workspace Session',
        createdAt: '2026-05-13T00:00:00.000Z',
        modifiedAt: '2026-05-13T00:00:00.000Z',
        messageCount: 0,
        projectPath: '/repo',
        workDir: '/repo/worktree',
        workDirExists: true,
      }],
      activeSessionId: 'tab-1',
    })

    await act(async () => {
      render(<AppHeader />)
    })

    expect(screen.queryByTestId('open-project-menu')).not.toBeInTheDocument()
  })

  it('opens the bottom terminal panel from the toolbar for an active session', async () => {
    const { useWorkspaceStore } = await import('../../stores/workspaceStore')
    const { AppHeader } = await import('./AppHeader')
    const { useTabStore } = await import('../../stores/tabStore')
    const { useChatStore } = await import('../../stores/chatStore')

    useTabStore.setState({
      tabs: [
        { sessionId: 'tab-1', title: 'First Session', type: 'session', status: 'idle' },
      ],
      activeTabId: 'tab-1',
    })
    useChatStore.setState({
      sessions: {},
      disconnectSession: vi.fn(),
    } as Partial<ReturnType<typeof useChatStore.getState>>)

    await act(async () => {
      render(<AppHeader />)
    })

    fireEvent.click(screen.getByRole('button', { name: 'Toggle bottom panel' }))

    expect(useTabStore.getState().tabs.map((tab) => tab.sessionId)).toEqual(['tab-1'])
    expect(useWorkspaceStore.getState().getSession('tab-1').bottomOpen).toBe(true)
    expect(useWorkspaceStore.getState().getTabs('tab-1', 'bottom')).toHaveLength(1)
  })

  it('toggles the workspace panel for the active session from the toolbar', async () => {
    const { useWorkspaceStore } = await import('../../stores/workspaceStore')
    const { AppHeader } = await import('./AppHeader')
    const { useTabStore } = await import('../../stores/tabStore')
    const { useChatStore } = await import('../../stores/chatStore')

    useTabStore.setState({
      tabs: [
        { sessionId: 'tab-1', title: 'First Session', type: 'session', status: 'idle' },
      ],
      activeTabId: 'tab-1',
    })
    useChatStore.setState({
      sessions: {},
      disconnectSession: vi.fn(),
    } as Partial<ReturnType<typeof useChatStore.getState>>)

    await act(async () => {
      render(<AppHeader />)
    })

    fireEvent.click(screen.getByRole('button', { name: 'Show Workspace' }))
    expect(useWorkspaceStore.getState().getSession('tab-1').layout).toBe('split')

    fireEvent.click(screen.getByRole('button', { name: 'Hide Workspace' }))
    expect(useWorkspaceStore.getState().getSession('tab-1').layout).toBe('hidden')
  })

  it('keeps workspace and terminal entry points available on H5', async () => {
    window.desktopHost = browserHost
    const { AppHeader } = await import('./AppHeader')
    const { useTabStore } = await import('../../stores/tabStore')
    const { useWorkspaceStore } = await import('../../stores/workspaceStore')
    useTabStore.setState({ tabs: [{ sessionId: 'h5-task', title: 'H5 Task', type: 'session', status: 'idle' }], activeTabId: 'h5-task' })
    await act(async () => { render(<AppHeader />) })
    fireEvent.click(screen.getByRole('button', { name: 'Show Workspace' }))
    expect(useWorkspaceStore.getState().getSession('h5-task').layout).toBe('split')
    expect(screen.getByRole('button', { name: 'Toggle bottom panel' })).toBeInTheDocument()
  })

  it('does not render a browser toolbar button for session tabs', async () => {
    const { AppHeader } = await import('./AppHeader')
    const { useTabStore } = await import('../../stores/tabStore')
    const { useChatStore } = await import('../../stores/chatStore')

    useTabStore.setState({
      tabs: [
        { sessionId: 'tab-1', title: 'First Session', type: 'session', status: 'idle' },
      ],
      activeTabId: 'tab-1',
    })
    useChatStore.setState({
      sessions: {},
      disconnectSession: vi.fn(),
    } as Partial<ReturnType<typeof useChatStore.getState>>)

    await act(async () => {
      render(<AppHeader />)
    })

    expect(screen.queryByRole('button', { name: 'Show Browser' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Hide Browser' })).not.toBeInTheDocument()
  })

  it('hides the browser toolbar button for pages that are not chats', async () => {
    const { AppHeader } = await import('./AppHeader')
    const { useTabStore } = await import('../../stores/tabStore')
    const { useChatStore } = await import('../../stores/chatStore')

    useTabStore.setState({
      tabs: [
        { sessionId: '__market__', title: 'Market', type: 'market', status: 'idle' },
        { sessionId: '__settings__', title: 'Settings', type: 'settings', status: 'idle' },
      ],
      activeTabId: '__market__',
    })
    useChatStore.setState({
      sessions: {},
      disconnectSession: vi.fn(),
    } as Partial<ReturnType<typeof useChatStore.getState>>)

    const { rerender } = render(<AppHeader />)

    expect(screen.queryByRole('button', { name: 'Show Browser' })).not.toBeInTheDocument()

    await act(async () => {
      useTabStore.getState().setActiveTab('__settings__')
    })
    rerender(<AppHeader />)

    expect(screen.queryByRole('button', { name: 'Show Browser' })).not.toBeInTheDocument()
  })

  it('hides the workspace toolbar button for pages that are not chats', async () => {
    const { AppHeader } = await import('./AppHeader')
    const { useTabStore } = await import('../../stores/tabStore')
    const { useChatStore } = await import('../../stores/chatStore')

    useTabStore.setState({
      tabs: [
        { sessionId: '__market__', title: 'Market', type: 'market', status: 'idle' },
        { sessionId: '__settings__', title: 'Settings', type: 'settings', status: 'idle' },
      ],
      activeTabId: '__market__',
    })
    useChatStore.setState({
      sessions: {},
      disconnectSession: vi.fn(),
    } as Partial<ReturnType<typeof useChatStore.getState>>)

    const { rerender } = render(<AppHeader />)

    expect(screen.queryByRole('button', { name: 'Show Workspace' })).not.toBeInTheDocument()

    await act(async () => {
      useTabStore.getState().setActiveTab('__settings__')
    })
    rerender(<AppHeader />)

    expect(screen.queryByRole('button', { name: 'Show Workspace' })).not.toBeInTheDocument()
  })

  it('treats an open SubAgent page as a non-chat for toolbar state', async () => {
    const { useWorkspaceStore } = await import('../../stores/workspaceStore')
    const { AppHeader } = await import('./AppHeader')
    const { useTabStore } = await import('../../stores/tabStore')
    const { useChatStore } = await import('../../stores/chatStore')
    const { useActivityPanelStore } = await import('../../stores/activityPanelStore')
    const tabId = '__subagent__session-1__tool-1'

    useTabStore.setState({
      tabs: [{
        sessionId: tabId,
        title: 'Kuhn',
        type: 'subagent',
        status: 'idle',
        sourceSessionId: 'session-1',
        subagentToolUseId: 'tool-1',
      }],
      activeTabId: tabId,
    })
    useChatStore.setState({
      sessions: {},
      disconnectSession: vi.fn(),
    } as Partial<ReturnType<typeof useChatStore.getState>>)

    await act(async () => {
      render(<AppHeader />)
    })

    expect(screen.queryByRole('button', { name: /activity/i })).not.toBeInTheDocument()
    expect(screen.queryByTestId('open-project-menu')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Show Workspace' })).not.toBeInTheDocument()
    expect(screen.queryByTestId('workspace-toggle-bottom')).not.toBeInTheDocument()
    expect(useWorkspaceStore.getState().bySession[tabId]).toBeUndefined()
    expect(useActivityPanelStore.getState().isOpen(tabId)).toBe(false)
  })

  it('treats the market page as a non-chat toolbar target', async () => {
    const { useWorkspaceStore } = await import('../../stores/workspaceStore')
    const { AppHeader } = await import('./AppHeader')
    const { MARKET_TAB_ID, useTabStore } = await import('../../stores/tabStore')
    const { useChatStore } = await import('../../stores/chatStore')

    useTabStore.setState({
      tabs: [
        { sessionId: MARKET_TAB_ID, title: 'Market', type: 'market', status: 'idle' },
      ],
      activeTabId: MARKET_TAB_ID,
    })
    useChatStore.setState({
      sessions: {},
      disconnectSession: vi.fn(),
    } as Partial<ReturnType<typeof useChatStore.getState>>)

    await act(async () => {
      render(<AppHeader />)
    })

    expect(screen.queryByTestId('open-project-menu')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Show Workspace' })).not.toBeInTheDocument()
    expect(screen.queryByTestId('workspace-toggle-bottom')).not.toBeInTheDocument()
    expect(useWorkspaceStore.getState().bySession[MARKET_TAB_ID]).toBeUndefined()
  })

  it('shows no workspace controls on the new-session page', async () => {
    windowControlsMock.show = false
    const { AppHeader } = await import('./AppHeader')
    const { useTabStore } = await import('../../stores/tabStore')

    useTabStore.setState({ tabs: [], activeTabId: null })

    await act(async () => {
      render(<AppHeader />)
    })

    expect(screen.queryByTestId('workspace-toggle-side')).not.toBeInTheDocument()
    expect(screen.queryByTestId('app-header-session')).not.toBeInTheDocument()
    // The app-level terminal tab is gone; nothing offers to open one here.
    expect(screen.queryByRole('button', { name: /terminal/i })).not.toBeInTheDocument()
    expect(screen.queryByTestId('window-controls')).not.toBeInTheDocument()
  })

  it('marks the header as a native drag region and keeps the title out of it', async () => {
    const { AppHeader } = await import('./AppHeader')
    const { useTabStore } = await import('../../stores/tabStore')

    useTabStore.setState({
      tabs: [{ sessionId: 'tab-1', title: 'Untitled Session', type: 'session', status: 'idle' }],
      activeTabId: 'tab-1',
    })

    await act(async () => {
      render(<AppHeader />)
    })

    const header = screen.getByTestId('app-header')
    expect(header).toHaveAttribute('data-desktop-drag-region')
    expect(screen.getByTestId('workspace-session-header')).toHaveAttribute('data-desktop-drag-region')
    expect(screen.getByTestId('app-header-drag-gutter')).toHaveAttribute('data-desktop-drag-region')
    // 52px, and the gutter matches it, so no dead strip of titlebar is left
    // outside the drag region.
    expect(header).toHaveClass('min-h-[52px]')
    expect(screen.getByTestId('app-header-drag-gutter')).toHaveClass('min-h-[52px]')
    // A double-click inside a drag region zooms the window instead of
    // reaching the title, so the title opts out to keep rename working.
    expect(screen.getByTestId('app-header-title')).toHaveClass('tab-bar-interactive')

    fireEvent.mouseDown(screen.getByTestId('workspace-session-header'))
    expect(startDraggingMock).not.toHaveBeenCalled()
  })

  it('keeps the chat title in the header while the workspace is full screen', async () => {
    const { AppHeader } = await import('./AppHeader')
    const { useTabStore } = await import('../../stores/tabStore')
    const { useWorkspaceStore } = await import('../../stores/workspaceStore')
    const { WorkspaceHeaderProvider } = await import('./WorkspaceHeaderContext')
    useTabStore.setState({
      tabs: [{ sessionId: 'full-session', title: 'Full screen session', type: 'session', status: 'idle' }],
      activeTabId: 'full-session',
    })
    await act(async () => {
      render(<WorkspaceHeaderProvider><AppHeader /></WorkspaceHeaderProvider>)
    })
    await act(async () => {
      useWorkspaceStore.getState().toggleWorkspace('full-session')
    })
    const frame = screen.getByTestId('workspace-header-frame')
    const sessionHeader = screen.getByTestId('workspace-session-header')
    // Split: the frame is sized to the panel and the title takes the rest.
    expect(frame).toHaveClass('shrink-0')
    expect(sessionHeader).toHaveClass('flex-1')

    await act(async () => {
      useWorkspaceStore.getState().toggleFullscreen('full-session')
    })

    // Full: a frame as wide as the panel would leave the title no room, so
    // the title keeps a bounded share and the frame takes what is left.
    expect(sessionHeader).toHaveClass('flex-none', 'max-w-[40%]')
    expect(frame).toHaveClass('flex-1')
    expect(frame).not.toHaveClass('shrink-0')
    expect(frame.style.width).toBe('')
    expect(screen.getByTestId('app-header-title')).toHaveTextContent('Full screen session')
  })

  it('stays on the sidebar ground with no rule under it', async () => {
    const { AppHeader } = await import('./AppHeader')
    const { useTabStore } = await import('../../stores/tabStore')

    useTabStore.setState({
      tabs: [{ sessionId: 'tab-1', title: 'Active One', type: 'session', status: 'idle' }],
      activeTabId: 'tab-1',
    })

    await act(async () => {
      render(<AppHeader />)
    })

    const header = screen.getByTestId('app-header')
    // The workspace's resource tabs sit in this row as a trough whose active
    // tab runs into the panel; one ground keeps the row a single band.
    expect(header).toHaveClass('bg-[var(--color-surface-sidebar)]')
    expect(header.className).not.toMatch(/bg-\[var\(--color-(?!surface-sidebar)/)
    expect(header.className).not.toMatch(/\bborder-b\b/)
  })

  it('renders every page kind without stray text consuming the header', async () => {
    const { AppHeader } = await import('./AppHeader')
    const { SETTINGS_TAB_ID, MARKET_TAB_ID, useTabStore } = await import('../../stores/tabStore')
    const { useWorkspaceStore } = await import('../../stores/workspaceStore')
    const { WorkspaceHeaderProvider } = await import('./WorkspaceHeaderContext')
    useTabStore.setState({
      tabs: [{ sessionId: 'header-session', title: 'Header session', type: 'session', status: 'idle' }],
      activeTabId: 'header-session',
    })
    await act(async () => {
      render(<WorkspaceHeaderProvider><AppHeader /></WorkspaceHeaderProvider>)
    })

    const expectNoHeaderText = () => {
      // A bare /* ... */ between JSX elements becomes an anonymous flex item.
      const strayText = [...screen.getByTestId('app-header').childNodes]
        .filter((node) => node.nodeType === Node.TEXT_NODE)
        .map((node) => node.textContent?.trim())
        .filter(Boolean)
      expect(strayText).toEqual([])
    }
    expectNoHeaderText()
    for (const [id, title, type] of [
      [SETTINGS_TAB_ID, 'Settings', 'settings'],
      [MARKET_TAB_ID, 'Market', 'market'],
      ['header-session', 'Header session', 'session'],
    ] as const) {
      await act(async () => {
        useTabStore.getState().openTab(id, title, type)
      })
      expectNoHeaderText()
    }
    await act(async () => {
      useWorkspaceStore.getState().toggleWorkspace('header-session')
    })
    expectNoHeaderText()
  })

  describe('where you are', () => {
    async function renderHeader(
      tabs: ReturnType<typeof import('../../stores/tabStore').useTabStore.getState>['tabs'],
      activeTabId: string | null,
      sessions: Array<{ id: string; title: string }> = [],
    ) {
      const { AppHeader } = await import('./AppHeader')
      const { useTabStore } = await import('../../stores/tabStore')
      const { useSessionStore } = await import('../../stores/sessionStore')
      useTabStore.setState({ tabs, activeTabId })
      useSessionStore.setState({
        sessions: sessions.map((session) => ({
          ...session,
          createdAt: '2026-10-11T00:00:00.000Z',
          modifiedAt: '2026-10-11T00:00:00.000Z',
          messageCount: 1,
          projectPath: '/repo',
          workDir: '/repo',
          workDirExists: true,
        })),
      } as Partial<ReturnType<typeof useSessionStore.getState>>)
      await act(async () => {
        render(<AppHeader />)
      })
      return { useTabStore, useSessionStore }
    }

    it("titles a chat by the session list's name over the tab's stale one", async () => {
      await renderHeader(
        [{ sessionId: 's1', title: 'Old title', type: 'session', status: 'idle' }],
        's1',
        [{ id: 's1', title: 'Fix login redirect' }],
      )

      expect(screen.getByTestId('app-header-title')).toHaveTextContent('Fix login redirect')
    })

    it('renames the chat in place: double-click, type, Enter', async () => {
      sessionsApiMock.rename.mockResolvedValue(undefined)
      const { useSessionStore } = await renderHeader(
        [{ sessionId: 's1', title: 'Fix login redirect', type: 'session', status: 'idle' }],
        's1',
        [{ id: 's1', title: 'Fix login redirect' }],
      )

      fireEvent.doubleClick(screen.getByTestId('app-header-title'))
      const input = screen.getByRole('textbox', { name: 'Session name' })
      fireEvent.change(input, { target: { value: '  Fix the OAuth redirect  ' } })
      await act(async () => {
        fireEvent.keyDown(input, { key: 'Enter' })
      })

      expect(sessionsApiMock.rename).toHaveBeenCalledExactlyOnceWith('s1', 'Fix the OAuth redirect')
      expect(useSessionStore.getState().sessions[0]?.title).toBe('Fix the OAuth redirect')
      expect(screen.queryByRole('textbox', { name: 'Session name' })).not.toBeInTheDocument()
      expect(screen.getByTestId('app-header-title')).toHaveTextContent('Fix the OAuth redirect')
    })

    it('keeps the old name when the rename is escaped or left unchanged', async () => {
      await renderHeader(
        [{ sessionId: 's1', title: 'Fix login redirect', type: 'session', status: 'idle' }],
        's1',
        [{ id: 's1', title: 'Fix login redirect' }],
      )

      fireEvent.doubleClick(screen.getByTestId('app-header-title'))
      const input = screen.getByRole('textbox', { name: 'Session name' })
      fireEvent.change(input, { target: { value: 'Something else' } })
      fireEvent.keyDown(input, { key: 'Escape' })
      expect(screen.getByTestId('app-header-title')).toHaveTextContent('Fix login redirect')

      fireEvent.doubleClick(screen.getByTestId('app-header-title'))
      await act(async () => {
        fireEvent.blur(screen.getByRole('textbox', { name: 'Session name' }))
      })

      expect(sessionsApiMock.rename).not.toHaveBeenCalled()
    })

    it('gives a root page only the way back to the chat it was opened over, never a second title', async () => {
      const { SETTINGS_TAB_ID } = await import('../../stores/tabStore')
      const { useTabStore } = await renderHeader(
        [
          { sessionId: 's1', title: 'Fix login redirect', type: 'session', status: 'idle' },
          { sessionId: SETTINGS_TAB_ID, title: '设置', type: 'settings', status: 'idle', returnTabId: 's1' },
        ],
        SETTINGS_TAB_ID,
        [{ id: 's1', title: 'Fix login redirect' }],
      )

      // The page opens with its own head; the header does not repeat it.
      expect(screen.queryByTestId('app-header-title')).not.toBeInTheDocument()
      expect(screen.getByTestId('workspace-session-header')).not.toHaveTextContent('Localized Settings')

      fireEvent.click(screen.getByRole('button', { name: 'Back to Fix login redirect' }))

      expect(useTabStore.getState().activeTabId).toBe('s1')
      expect(useTabStore.getState().tabs.map((tab) => tab.sessionId)).toEqual(['s1'])
    })

    it('leads back to the new-session page a root page was opened from', async () => {
      const { MARKET_TAB_ID } = await import('../../stores/tabStore')
      const { useTabStore } = await renderHeader(
        [
          { sessionId: 's1', title: 'Fix login redirect', type: 'session', status: 'idle' },
          { sessionId: MARKET_TAB_ID, title: 'Market', type: 'market', status: 'idle', returnTabId: '' },
        ],
        MARKET_TAB_ID,
        [{ id: 's1', title: 'Fix login redirect' }],
      )

      fireEvent.click(screen.getByRole('button', { name: 'Back to New session' }))

      expect(useTabStore.getState().activeTabId).toBeNull()
    })

    it('offers no way back from a root page with nothing behind it', async () => {
      const { MARKET_TAB_ID } = await import('../../stores/tabStore')
      await renderHeader([{ sessionId: MARKET_TAB_ID, title: 'Market', type: 'market', status: 'idle' }], MARKET_TAB_ID)

      expect(screen.queryByTestId('app-header-back')).not.toBeInTheDocument()
    })

    it('shows a server placeholder title in the user\'s language', async () => {
      const { useTabStore } = await renderHeader(
        [{ sessionId: 's1', title: 'New session', type: 'session', status: 'idle' }],
        's1',
        [{ id: 's1', title: 'Untitled Session' }],
      )

      // The tab carries the localized name the sidebar gave it.
      expect(screen.getByTestId('app-header-title')).toHaveTextContent(/^New session$/)

      act(() => {
        useTabStore.getState().updateTabTitle('s1', 'Untitled Session')
      })
      expect(screen.getByTestId('app-header-title')).toHaveTextContent(/^Untitled$/)
    })

    it('renames from the keyboard, and keeps the full title as the hover text', async () => {
      sessionsApiMock.rename.mockResolvedValue(undefined)
      await renderHeader(
        [{ sessionId: 's1', title: 'A long title the row truncates', type: 'session', status: 'idle' }],
        's1',
        [{ id: 's1', title: 'A long title the row truncates' }],
      )
      const title = screen.getByTestId('app-header-title')
      expect(title).toHaveAttribute('tabindex', '0')
      expect(title.getAttribute('title')).toContain('A long title the row truncates')

      fireEvent.keyDown(title, { key: 'F2' })
      const input = screen.getByRole('textbox', { name: 'Session name' })
      fireEvent.change(input, { target: { value: 'Shorter' } })
      await act(async () => {
        fireEvent.keyDown(input, { key: 'Enter' })
      })

      expect(sessionsApiMock.rename).toHaveBeenCalledExactlyOnceWith('s1', 'Shorter')
    })

    it('drops a half-typed rename when another chat takes the screen', async () => {
      const { useTabStore } = await renderHeader(
        [
          { sessionId: 's1', title: 'One', type: 'session', status: 'idle' },
          { sessionId: 's2', title: 'Two', type: 'session', status: 'idle' },
        ],
        's1',
        [{ id: 's1', title: 'One' }, { id: 's2', title: 'Two' }],
      )
      fireEvent.doubleClick(screen.getByTestId('app-header-title'))
      fireEvent.change(screen.getByRole('textbox', { name: 'Session name' }), { target: { value: 'Typed for One' } })

      act(() => {
        useTabStore.setState({ activeTabId: 's2' })
      })

      expect(screen.queryByRole('textbox', { name: 'Session name' })).not.toBeInTheDocument()
      expect(screen.getByTestId('app-header-title')).toHaveTextContent('Two')
      expect(sessionsApiMock.rename).not.toHaveBeenCalled()
    })

    it('updates the title after a rename even for a chat outside the loaded list', async () => {
      sessionsApiMock.rename.mockResolvedValue(undefined)
      await renderHeader([{ sessionId: 'old', title: 'Old chat', type: 'session', status: 'idle' }], 'old')

      fireEvent.doubleClick(screen.getByTestId('app-header-title'))
      fireEvent.change(screen.getByRole('textbox', { name: 'Session name' }), { target: { value: 'Renamed old chat' } })
      await act(async () => {
        fireEvent.keyDown(screen.getByRole('textbox', { name: 'Session name' }), { key: 'Enter' })
      })

      expect(screen.getByTestId('app-header-title')).toHaveTextContent('Renamed old chat')
    })

    it('trails a nested subagent back to its chat, and each step leads there', async () => {
      const { useTabStore } = await import('../../stores/tabStore')
      await renderHeader(
        [{ sessionId: 'root', title: 'Root', type: 'session', status: 'idle' }],
        'root',
        [{ id: 'root', title: 'Root session' }],
      )
      let parent = ''
      let nested = ''
      await act(async () => {
        parent = useTabStore.getState().openSubagentTab('root', 'agent-a', 'Agent A')
        nested = useTabStore.getState().openSubagentTab('root', 'agent-a/agent-b', 'Agent B', undefined, parent)
      })

      const trail = screen.getByRole('navigation', { name: 'Page path' })
      expect(trail).toHaveTextContent('Root session')
      expect(within(trail).getByRole('button', { name: 'Root session' })).toBeInTheDocument()
      expect(within(trail).getByRole('button', { name: 'Agent A' })).toBeInTheDocument()
      expect(within(trail).getByText('Agent B')).toHaveAttribute('aria-current', 'page')

      fireEvent.click(within(trail).getByRole('button', { name: 'Agent A' }))
      expect(useTabStore.getState().activeTabId).toBe(parent)
      expect(useTabStore.getState().tabs.some((tab) => tab.sessionId === nested)).toBe(false)

      fireEvent.click(within(screen.getByRole('navigation', { name: 'Page path' })).getByRole('button', { name: 'Root session' }))
      expect(useTabStore.getState().activeTabId).toBe('root')
      expect(useTabStore.getState().tabs.map((tab) => tab.sessionId)).toEqual(['root'])
    })

    it('names the team page by its surface; the workbench below names the team', async () => {
      const { useTabStore } = await import('../../stores/tabStore')
      await renderHeader(
        [{ sessionId: 'lead', title: 'Lead', type: 'session', status: 'idle' }],
        'lead',
        [{ id: 'lead', title: 'Review the PR' }],
      )
      await act(async () => {
        useTabStore.getState().openTeamWorkbenchTab('lead', 'security-review-team')
      })

      const trail = screen.getByRole('navigation', { name: 'Page path' })
      expect(within(trail).getByTestId('app-header-title')).toHaveTextContent('Agent Teams')
      expect(trail).not.toHaveTextContent('security-review-team')
    })

    it('jumps straight from a team member to its chat, closing the pages in between', async () => {
      const { useTabStore } = await import('../../stores/tabStore')
      await renderHeader(
        [{ sessionId: 'lead', title: 'Lead', type: 'session', status: 'idle' }],
        'lead',
        [{ id: 'lead', title: 'Review the PR' }],
      )
      await act(async () => {
        const team = useTabStore.getState().openTeamWorkbenchTab('lead', 'Agent Teams')
        useTabStore.getState().openTeamMemberTab('lead', 'reviewer@team', 'Reviewer', team)
      })

      const trail = screen.getByRole('navigation', { name: 'Page path' })
      expect([...trail.querySelectorAll('button, [aria-current]')].map((node) => node.textContent))
        .toEqual(['Review the PR', 'Agent Teams', 'Reviewer'])

      fireEvent.click(within(trail).getByRole('button', { name: 'Review the PR' }))

      expect(useTabStore.getState().activeTabId).toBe('lead')
      expect(useTabStore.getState().tabs.map((tab) => tab.sessionId)).toEqual(['lead'])
    })
  })

  describe('a session waiting on the user', () => {
    // A tool approval, an AskUserQuestion card and an ExitPlanMode review all
    // arrive as `permission_request`; only the tool name differs.
    const request = (requestId: string, toolName = 'Bash'): ServerMessage => ({
      type: 'permission_request',
      requestId,
      toolName,
      toolUseId: `tu-${requestId}`,
      input: {},
    })
    const resolved = (requestId: string, allowed = true): ServerMessage => ({
      type: 'permission_resolved',
      requestId,
      permissionType: 'tool',
      allowed,
    })
    // The store keeps the newest request in `pendingPermission` as a
    // compatibility mirror and every outstanding one in `pendingPermissions`.
    const waiting = (...requestIds: string[]): Partial<PerSessionState> => {
      const requests = requestIds.map((requestId) => ({
        requestId,
        toolName: 'Bash',
        toolUseId: `tu-${requestId}`,
        input: {},
      }))
      return {
        pendingPermission: requests.at(-1) ?? null,
        pendingPermissions: Object.fromEntries(requests.map((request) => [request.requestId, request])),
      }
    }
    const headerSession = () => screen.getByTestId('app-header-session')
    const attentionMark = () => within(headerSession()).queryByRole('img', { name: 'Waiting for your approval' })
    const runningMark = () => within(headerSession()).queryByLabelText('Session running')

    // `titles` is also the sidebar order (most recent first), which is the
    // order the jump walks.
    async function renderHeader(
      titles: Record<string, string>,
      activeTabId: string,
      sessions: Record<string, PerSessionState> = {},
    ) {
      const { AppHeader } = await import('./AppHeader')
      const { useTabStore } = await import('../../stores/tabStore')
      const { useChatStore } = await import('../../stores/chatStore')
      const { useSessionStore } = await import('../../stores/sessionStore')

      useTabStore.setState({
        tabs: Object.entries(titles)
          .filter(([sessionId]) => sessionId === activeTabId)
          .map(([sessionId, title]) => ({ sessionId, title, type: 'session' as const, status: 'idle' as const })),
        activeTabId,
      })
      useSessionStore.setState({
        sessions: Object.entries(titles).map(([id, title]) => ({
          id,
          title,
          createdAt: '2026-10-11T00:00:00.000Z',
          modifiedAt: '2026-10-11T00:00:00.000Z',
          messageCount: 1,
          projectPath: '/repo',
          workDir: '/repo',
          workDirExists: true,
        })),
      } as Partial<ReturnType<typeof useSessionStore.getState>>)
      useChatStore.setState({
        sessions: Object.fromEntries(Object.keys(titles).map((id) => [id, sessions[id] ?? makeChatSession('idle')])),
        disconnectSession: vi.fn(),
        // Jumping connects to the session it lands on; no socket in a unit test.
        connectToSession: vi.fn(),
      } as Partial<ReturnType<typeof useChatStore.getState>>)

      await act(async () => {
        render(<AppHeader />)
      })

      return {
        useChatStore,
        useTabStore,
        // The real reducer, driven the way the socket drives it.
        receive: (sessionId: string, message: ServerMessage) => act(() => {
          useChatStore.getState().handleServerMessage(sessionId, message)
        }),
      }
    }

    it('marks the chat on screen while a request is open and gives it back to the running marker once answered', async () => {
      const { receive } = await renderHeader({ waiting: 'Waiting' }, 'waiting')

      await receive('waiting', request('r1'))

      expect(headerSession()).toHaveAttribute('data-attention', 'true')
      expect(attentionMark()).toBeInTheDocument()
      // Parked on a card is "running" by chatState as well; the running dot
      // would say the session can be left alone, which is not true of it.
      expect(runningMark()).toBeNull()

      await receive('waiting', resolved('r1'))

      expect(headerSession()).toHaveAttribute('data-attention', 'false')
      expect(attentionMark()).toBeNull()
      // An allowed tool runs on, so the header is back to reporting that.
      expect(runningMark()).toBeInTheDocument()
    })

    it('stays lit when a status message overwrites chatState under a card that is still open', async () => {
      const { receive, useChatStore } = await renderHeader({ waiting: 'Waiting' }, 'waiting')

      await receive('waiting', request('r1'))
      await receive('waiting', { type: 'status', state: 'tool_executing' })

      // The precondition that makes this a regression test: a rule that read
      // chatState would see "not waiting" from here on, under a live card.
      expect(useChatStore.getState().sessions.waiting?.chatState).toBe('tool_executing')
      expect(headerSession()).toHaveAttribute('data-attention', 'true')
      expect(attentionMark()).toBeInTheDocument()
    })

    it('keeps saying running while a background task outlives the turn', async () => {
      // The only place left that says so: the bar under the header no longer
      // repeats "session active" in words.
      await renderHeader({ shell: 'Shell' }, 'shell', {
        shell: makeChatSession('idle', {
          backgroundAgentTasks: { 'bash-1': makeBackgroundTask('bash-1') },
        }),
      })

      expect(runningMark()).toBeInTheDocument()
      expect(attentionMark()).toBeNull()
    })

    it('does not light for chatState alone, because nothing renders a card for it', async () => {
      await renderHeader({ empty: 'Empty' }, 'empty', { empty: makeChatSession('permission_pending') })

      expect(headerSession()).toHaveAttribute('data-attention', 'false')
      expect(attentionMark()).toBeNull()
      expect(runningMark()).toBeInTheDocument()
    })

    it.each(['Bash', 'AskUserQuestion', 'ExitPlanMode'])('lights for a %s request', async (toolName) => {
      const { receive } = await renderHeader({ waiting: 'Waiting' }, 'waiting')

      await receive('waiting', request('r1', toolName))

      expect(attentionMark()).toBeInTheDocument()
    })

    it('does not light for a Computer Use request, which has no card to answer', async () => {
      const computerUse = { requestId: 'cu-1', request: {} as never }
      await renderHeader({ cu: 'Computer use' }, 'cu', {
        cu: makeChatSession('idle', {
          pendingComputerUsePermission: computerUse,
          pendingComputerUsePermissions: { 'cu-1': computerUse },
        }),
      })

      expect(headerSession()).toHaveAttribute('data-attention', 'false')
      expect(attentionMark()).toBeNull()
    })

    it('still shows the error dot for a failed chat that is neither running nor waiting', async () => {
      const { receive, useTabStore } = await renderHeader({ failed: 'Failed' }, 'failed')

      act(() => {
        useTabStore.getState().updateTabStatus('failed', 'error')
      })
      expect(within(headerSession()).getByLabelText('The last turn failed')).toBeInTheDocument()

      // Waiting outranks an earlier failure: the failed turn is over, the card is not.
      await receive('failed', request('rf'))
      expect(attentionMark()).toBeInTheDocument()
      expect(headerSession().querySelector('[class*="--color-error"]')).toBeNull()
    })

    it('stays lit until the last of several requests is answered', async () => {
      const { receive } = await renderHeader({ waiting: 'Waiting' }, 'waiting')

      await receive('waiting', request('r1'))
      await receive('waiting', request('r2', 'AskUserQuestion'))
      await receive('waiting', resolved('r1'))

      expect(attentionMark()).toBeInTheDocument()

      await receive('waiting', resolved('r2'))

      expect(attentionMark()).toBeNull()
    })

    it('does not rerender when requests change without changing which sessions are waiting', async () => {
      const { useChatStore } = await renderHeader({ 'tab-1': 'Workspace Session', ghost: 'Ghost' }, 'tab-1', {
        'tab-1': makeChatSession('idle', waiting('r1')),
        ghost: makeChatSession('idle', waiting('r2')),
      })
      expect(openProjectMenuMock.paths.length).toBeGreaterThan(0)

      openProjectMenuMock.paths = []
      await act(async () => {
        useChatStore.setState((state) => ({
          sessions: {
            ...state.sessions,
            // Same requests, fresh objects: what a replayed permission_request does.
            'tab-1': { ...state.sessions['tab-1']!, ...waiting('r1') },
            ghost: { ...state.sessions.ghost!, ...waiting('r2'), streamingText: 'token churn' },
          },
        }))
      })
      expect(openProjectMenuMock.paths).toEqual([])

      // Positive control: a change that does alter the set does rerender.
      await act(async () => {
        useChatStore.getState().handleServerMessage('ghost', resolved('r2'))
      })
      expect(openProjectMenuMock.paths.length).toBeGreaterThan(0)
    })

    describe('jumping to the next one', () => {
      const jump = () => screen.queryByTestId('session-attention-jump')

      it('is not offered while nothing is waiting', async () => {
        await renderHeader({ a: 'Alpha', b: 'Bravo' }, 'a')

        expect(jump()).not.toBeInTheDocument()
      })

      it('is not offered when the only waiting session is the one on screen', async () => {
        const { receive } = await renderHeader({ a: 'Alpha', b: 'Bravo' }, 'a')

        await receive('a', request('ra'))

        expect(attentionMark()).toBeInTheDocument()
        expect(jump()).not.toBeInTheDocument()
      })

      it('counts the other waiting sessions, says so in words, and sits with the toolbar buttons', async () => {
        const { receive } = await renderHeader({ a: 'Alpha', b: 'Bravo', c: 'Charlie', d: 'Delta' }, 'a')

        await receive('a', request('ra'))
        await receive('c', request('rc'))
        await receive('d', request('rd'))

        // Alpha is on screen, so it is not somewhere to jump to.
        const button = within(screen.getByTestId('workspace-window-header')).getByTestId('session-attention-jump')
        expect(button).toHaveTextContent('2 waiting')
        expect(button).toHaveAccessibleName('Jump to the next waiting session (2 waiting)')
      })

      it('takes you to the next waiting session after the one on screen, in sidebar order', async () => {
        const { receive, useTabStore } = await renderHeader({ a: 'Alpha', b: 'Bravo', c: 'Charlie', d: 'Delta' }, 'a')
        await receive('c', request('rc'))
        await receive('d', request('rd'))

        fireEvent.click(jump()!)
        expect(useTabStore.getState().activeTabId).toBe('c')

        // From Charlie the only other waiting session is Delta, and then back again.
        fireEvent.click(jump()!)
        expect(useTabStore.getState().activeTabId).toBe('d')
        fireEvent.click(jump()!)
        expect(useTabStore.getState().activeTabId).toBe('c')
      })

      it('wraps past the end of the list', async () => {
        const { receive, useTabStore } = await renderHeader({ a: 'Alpha', b: 'Bravo', c: 'Charlie', d: 'Delta' }, 'd')
        await receive('a', request('ra'))
        await receive('c', request('rc'))

        fireEvent.click(jump()!)

        expect(useTabStore.getState().activeTabId).toBe('a')
      })

      it('counts down as requests are answered and leaves with the last one', async () => {
        const { receive } = await renderHeader({ a: 'Alpha', b: 'Bravo', c: 'Charlie' }, 'a')
        await receive('b', request('rb'))
        await receive('c', request('rc'))
        expect(jump()).toHaveTextContent('2 waiting')

        await receive('b', resolved('rb'))
        expect(jump()).toHaveTextContent('1 waiting')

        await receive('c', resolved('rc'))
        expect(jump()).not.toBeInTheDocument()
      })

      it('counts a session the server reports waiting though this window holds no socket to it', async () => {
        // Started from the phone, an IM channel or a scheduled task, or
        // released from the warm set: only the server knows it is waiting.
        sessionsApiMock.getLiveStatus.mockResolvedValue({ sessions: [{ id: 'elsewhere', activityState: 'waiting' }] })
        const { useTabStore } = await renderHeader({ a: 'Alpha', elsewhere: 'Elsewhere' }, 'a', {
          elsewhere: makeChatSession('idle', { connectionState: 'disconnected' }),
        })

        await waitFor(() => expect(jump()).toHaveTextContent('1 waiting'))
        fireEvent.click(jump()!)

        expect(useTabStore.getState().activeTabId).toBe('elsewhere')
      })

      it('is offered from a page that is not a chat, such as Settings', async () => {
        const { AppHeader } = await import('./AppHeader')
        const { useTabStore } = await import('../../stores/tabStore')
        const { useChatStore } = await import('../../stores/chatStore')
        useTabStore.setState({
          tabs: [
            { sessionId: 'a', title: 'Alpha', type: 'session', status: 'idle' },
            { sessionId: '__settings__', title: 'Settings', type: 'settings', status: 'idle' },
          ],
          activeTabId: '__settings__',
        })
        useChatStore.setState({
          sessions: { a: makeChatSession('idle', waiting('ra')) },
          disconnectSession: vi.fn(),
          connectToSession: vi.fn(),
        } as Partial<ReturnType<typeof useChatStore.getState>>)
        await act(async () => {
          render(<AppHeader />)
        })

        fireEvent.click(jump()!)

        expect(useTabStore.getState().activeTabId).toBe('a')
        expect(useTabStore.getState().tabs.map((tab) => tab.sessionId)).toEqual(['a'])
      })
    })
  })
})
