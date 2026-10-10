import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom'
import type { PerSessionState } from '../../stores/chatStore'
import type { BackgroundAgentTask, ChatState, ServerMessage, UIMessage } from '../../types/chat'
import type { TeamWorkbenchSessionTimeline, TeamWorkbenchTask, TeamWorkbenchTimeline } from '../../types/team'
import type { WorkflowRun } from '../../types/workflow'
import { browserHost } from '../../lib/desktopHost/browserHost'
import { tabChipClass } from '@/components/ui/tabChip'

type ToolUseMessage = Extract<UIMessage, { type: 'tool_use' }>

const startDraggingMock = vi.hoisted(() => vi.fn(() => Promise.resolve()))
const getCurrentWindowMock = vi.hoisted(() => vi.fn(() => ({
  startDragging: startDraggingMock,
})))
const windowControlsMock = vi.hoisted(() => ({
  show: true,
}))
const scrollIntoViewMock = vi.hoisted(() => vi.fn())
const deleteSessionMock = vi.hoisted(() => vi.fn())
const openProjectMenuMock = vi.hoisted(() => ({
  paths: [] as Array<string | null | undefined>,
}))
const sessionsApiMock = vi.hoisted(() => ({
  delete: vi.fn(() => Promise.resolve()),
}))
const teamsApiMock = vi.hoisted(() => ({
  getWorkbenchForSession: vi.fn<() => Promise<TeamWorkbenchSessionTimeline>>(),
}))

// The strip re-reveals a clipped active tab from its ResizeObserver, so the
// tests have to be able to fire one. jsdom lays nothing out, so the geometry
// the guard reads has to be stubbed alongside it.
const resizeObserverCallbacks = new Set<ResizeObserverCallback>()

function stubRect(element: Element, left: number, right: number) {
  Object.defineProperty(element, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({
      left,
      right,
      width: right - left,
      top: 0,
      bottom: 46,
      height: 46,
      x: left,
      y: 0,
      toJSON: () => ({}),
    }),
  })
}

function fireStripResize() {
  act(() => {
    for (const callback of [...resizeObserverCallbacks]) {
      callback([], {} as ResizeObserver)
    }
  })
}

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

function makeSessionWithTasks(chatState: ChatState, tasks: BackgroundAgentTask[]): PerSessionState {
  return {
    ...makeChatSession(chatState),
    backgroundAgentTasks: Object.fromEntries(tasks.map((task) => [task.taskId, task])),
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
      'tabs.closeOthers': 'Close Others',
      'tabs.closeLeft': 'Close Left',
      'tabs.closeRight': 'Close Right',
      'tabs.closeAll': 'Close All',
      'tabs.closeConfirmTitle': 'Session Running',
      'tabs.closeConfirmMessage': 'Still running',
      'tabs.closeConfirmKeep': 'Keep Running',
      'tabs.closeConfirmStop': 'Stop & Close',
      'tabs.closeAllConfirmTitle': 'Sessions Running',
      'tabs.closeAllConfirmMessage': '{count} sessions still running',
      'tabs.closeAllConfirmStop': 'Stop All & Close',
      'tabs.sessionRunning': 'Session running',
      'tabs.openTerminal': 'Open Terminal',
      'workspace.controls.toggleBottom': 'Toggle bottom panel',
      'workspace.controls.toggleSide': 'Show/hide side panel',
      'tabs.showWorkspace': 'Show Workspace',
      'tabs.hideWorkspace': 'Hide Workspace',
      'tabs.showBrowser': 'Show Browser',
      'tabs.hideBrowser': 'Hide Browser',
      'agentTeams.hideReport': 'Hide Agent Teams Run Report',
      'tabs.scrollLeft': 'Scroll tabs left',
      'tabs.scrollRight': 'Scroll tabs right',
      'tabs.jumpToAttention': 'Jump to the next waiting session ({count} waiting)',
      'tabs.closeTab': 'Close {title}',
      'tabs.untitled': 'Untitled',
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

describe('TabBar', () => {
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
    resizeObserverCallbacks.clear()

    class ResizeObserverMock {
      constructor(private readonly callback: ResizeObserverCallback) {
        resizeObserverCallbacks.add(callback)
      }

      observe(_target: Element) {}

      disconnect() {
        resizeObserverCallbacks.delete(this.callback)
      }

      unobserve() {}
    }

    Object.defineProperty(window, 'ResizeObserver', {
      configurable: true,
      value: ResizeObserverMock,
    })

    Reflect.deleteProperty(window, '__TAURI__')
    installElectronDesktopHost()

    Object.defineProperty(window.HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoViewMock,
    })

    startDraggingMock.mockClear()
    getCurrentWindowMock.mockClear()
    scrollIntoViewMock.mockClear()
    deleteSessionMock.mockReset()
    deleteSessionMock.mockResolvedValue(undefined)
    openProjectMenuMock.paths = []
    sessionsApiMock.delete.mockClear()
    sessionsApiMock.delete.mockResolvedValue(undefined)
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
    const { TabBar } = await import('./TabBar')
    const { useTabStore } = await import('../../stores/tabStore')
    const { useWorkspaceStore } = await import('../../stores/workspaceStore')
    const sessionId = 'layout-session'
    useTabStore.setState({
      tabs: [{ sessionId, title: 'Layout session', type: 'session', status: 'idle' }],
      activeTabId: sessionId,
    })
    render(<TabBar />)

    const side = screen.getByTestId('workspace-toggle-side')
    const bottom = screen.getByTestId('workspace-toggle-bottom')
    expect(screen.getByTestId('tab-bar')).toContainElement(side)
    expect(screen.getByTestId('tab-bar')).toContainElement(bottom)
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
    expect(screen.getByTestId('tab-bar')).toContainElement(screen.getByTestId('workspace-toggle-fullscreen'))
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
      useTabStore.setState({ activeTabId: 'second-session' })
    })
    expect(side).toHaveAttribute('aria-pressed', 'false')
    expect(bottom).toHaveAttribute('aria-pressed', 'false')
    fireEvent.click(side)
    expect(useWorkspaceStore.getState().getSession('second-session').layout).toBe('split')
    expect(useWorkspaceStore.getState().getSession(sessionId).tabs).toEqual(before)
  })

  it('hides the activity button for no-activity chat session tabs', async () => {
    const { TabBar } = await import('./TabBar')
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
      render(<TabBar />)
    })

    expect(screen.queryByRole('button', { name: /activity/i })).not.toBeInTheDocument()
  })

  it('keeps the activity button available for a persisted workflow-only run', async () => {
    const { TabBar } = await import('./TabBar')
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
      render(<TabBar />)
    })

    expect(screen.getByRole('button', { name: /activity/i })).toBeInTheDocument()
  })

  it('routes Agent Teams tasks to the workbench while keeping lead TodoWrite activity', async () => {
    const { TabBar } = await import('./TabBar')
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
      render(<TabBar />)
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
    const { TabBar } = await import('./TabBar')
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

    render(<TabBar />)

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
    const { TabBar } = await import('./TabBar')
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
      render(<TabBar />)
    })

    expect(screen.queryByRole('button', { name: /activity/i })).not.toBeInTheDocument()
    expect(screen.queryByTestId('session-activity-badge')).not.toBeInTheDocument()
  })

  it('shows the activity button for completed TodoWrite history and hides it while the workspace is open', async () => {
    const { useWorkspaceStore } = await import('../../stores/workspaceStore')
    const { TabBar } = await import('./TabBar')
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
      render(<TabBar />)
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
      const { TabBar } = await import('./TabBar')
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
        render(<TabBar />)
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
    const { TabBar } = await import('./TabBar')
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
      render(<TabBar />)
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
    const { TabBar } = await import('./TabBar')
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
      render(<TabBar />)
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
    const { TabBar } = await import('./TabBar')
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
      render(<TabBar />)
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
    const { TabBar } = await import('./TabBar')
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
      render(<TabBar />)
    })

    fireEvent.click(screen.getByRole('button', { name: 'Show Workspace' }))

    expect(useWorkspaceStore.getState().getSession(sessionId).layout).not.toBe('hidden')
    expect(useTeamStore.getState().workbenchesBySession[sessionId]?.snapshots).toHaveLength(1)
  })

  it('hides team-only activity when the active team belongs to another session', async () => {
    const { TabBar } = await import('./TabBar')
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
      render(<TabBar />)
    })

    expect(screen.queryByRole('button', { name: /activity/i })).not.toBeInTheDocument()
    expect(screen.queryByTestId('session-activity-badge')).not.toBeInTheDocument()
  })

  it('keeps the activity rail absent when a workbench arrives after initial render', async () => {
    const { TabBar } = await import('./TabBar')
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
      render(<TabBar />)
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
    const { TabBar } = await import('./TabBar')
    const { SETTINGS_TAB_ID, useTabStore } = await import('../../stores/tabStore')

    useTabStore.setState({
      tabs: [{ sessionId: SETTINGS_TAB_ID, title: 'Settings', type: 'settings', status: 'idle' }],
      activeTabId: SETTINGS_TAB_ID,
    })

    await act(async () => {
      render(<TabBar />)
    })

    expect(screen.queryByRole('button', { name: /activity/i })).not.toBeInTheDocument()
  })

  it('renders the settings tab title from the current locale instead of its persisted title', async () => {
    const { TabBar } = await import('./TabBar')
    const { SETTINGS_TAB_ID, useTabStore } = await import('../../stores/tabStore')

    useTabStore.setState({
      tabs: [{ sessionId: SETTINGS_TAB_ID, title: '设置', type: 'settings', status: 'idle' }],
      activeTabId: SETTINGS_TAB_ID,
    })

    await act(async () => {
      render(<TabBar />)
    })

    expect(screen.getByText('Localized Settings')).toBeInTheDocument()
    expect(screen.queryByText('设置')).not.toBeInTheDocument()
  })

  it('gives the settings tab the same chip width as every other tab', async () => {
    const { TabBar } = await import('./TabBar')
    const { SETTINGS_TAB_ID, useTabStore } = await import('../../stores/tabStore')

    useTabStore.setState({
      tabs: [
        { sessionId: SETTINGS_TAB_ID, title: 'Settings', type: 'settings', status: 'idle' },
        { sessionId: 'session-1', title: 'Chat', type: 'session', status: 'idle' },
      ],
      activeTabId: SETTINGS_TAB_ID,
    })

    await act(async () => {
      render(<TabBar />)
    })

    const settingsTab = screen.getByText('Localized Settings').closest('.tab-strip-item')
    const chatTab = screen.getByText('Chat').closest('.tab-strip-item')

    // The settings tab used to be pinned to 195px to line up with the old
    // settings rail; that rail is gone, and one strip has one tab width.
    for (const tab of [settingsTab, chatTab]) {
      expect(tab?.className).toContain('min-w-[112px]')
      expect(tab?.className).toContain('max-w-[200px]')
      expect(tab?.className).not.toContain('195px')
    }
  })

  it('shows current-session CLI tasks without a numeric activity badge', async () => {
    const { TabBar } = await import('./TabBar')
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
      render(<TabBar />)
    })

    expect(screen.queryByTestId('session-activity-badge')).not.toBeInTheDocument()
  })

  it('keeps running activity available without showing a numeric badge', async () => {
    const { TabBar } = await import('./TabBar')
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
      render(<TabBar />)
    })

    expect(screen.queryByTestId('session-activity-badge')).not.toBeInTheDocument()
  })

  it('ignores CLI tasks from a different session in the activity badge', async () => {
    const { TabBar } = await import('./TabBar')
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
      render(<TabBar />)
    })

    expect(screen.queryByRole('button', { name: /activity/i })).not.toBeInTheDocument()
    expect(screen.queryByTestId('session-activity-badge')).not.toBeInTheDocument()
  })

  it('drops the glyph from chat tabs but keeps it on the ones that are not chats', async () => {
    const { TabBar } = await import('./TabBar')
    const { useTabStore } = await import('../../stores/tabStore')
    const { useChatStore } = await import('../../stores/chatStore')

    useTabStore.setState({
      tabs: [
        { sessionId: 'tab-1', title: 'Idle Session', type: 'session', status: 'idle' },
        { sessionId: 'terminal-1', title: 'Terminal', type: 'terminal', status: 'idle' },
        { sessionId: 'market', title: 'Skill Market', type: 'market', status: 'idle' },
      ],
      activeTabId: 'tab-1',
    })
    useChatStore.setState({
      sessions: {},
      disconnectSession: vi.fn(),
    } as Partial<ReturnType<typeof useChatStore.getState>>)

    await act(async () => {
      render(<TabBar />)
    })

    // #1123 asked for icons and got one on every kind including `session` —
    // which is most of the strip, so the row filled up with identical bubbles
    // that said nothing the titles did not. The glyph now carries exactly one
    // message: "this tab is not a conversation".
    const glyphOf = (title: string) => screen.getByText(title).previousElementSibling
    expect(glyphOf('Idle Session')?.querySelector('svg')).toBeNull()
    expect(glyphOf('Terminal')?.querySelector('[data-tab-type-icon="terminal"]')).toHaveClass('lucide-square-terminal')
    expect(glyphOf('Extension Market')?.querySelector('[data-tab-type-icon="market"]')).toHaveClass('lucide-store')
    // Glyphs are svg now; no icon-font ligature text leaks into the title row.
    expect(glyphOf('Terminal')?.textContent).toBe('')
  })

  it('keeps the title still when a chat tab starts running', async () => {
    const { TabBar } = await import('./TabBar')
    const { useTabStore } = await import('../../stores/tabStore')
    const { useChatStore } = await import('../../stores/chatStore')

    useTabStore.setState({
      tabs: [
        { sessionId: 'tab-1', title: 'Idle Session', type: 'session', status: 'idle' },
      ],
      activeTabId: 'tab-1',
    })
    useChatStore.setState({
      sessions: {},
      disconnectSession: vi.fn(),
    } as Partial<ReturnType<typeof useChatStore.getState>>)

    await act(async () => {
      render(<TabBar />)
    })

    // Collapsed, not removed. Now that an idle chat tab has no glyph the slot
    // has nothing to show, but it still has to *exist* — see below.
    const idleLabel = screen.getByText('Idle Session')
    const idleSlot = idleLabel.previousElementSibling as HTMLElement
    expect(idleSlot.className).toContain('w-0')
    const siblingsBeforeLabel = Array.from(idleLabel.parentElement?.children ?? [])
      .indexOf(idleLabel)

    await act(async () => {
      useTabStore.setState({
        tabs: [
          { sessionId: 'tab-1', title: 'Idle Session', type: 'session', status: 'running' },
        ],
        activeTabId: 'tab-1',
      })
    })

    // The real bug behind the icon request: the running dot used to be
    // *inserted* ahead of the label, so a title jumped sideways the moment its
    // session started and jumped back when it finished. The dot swaps into the
    // slot instead, which keeps the label's position in the row fixed; with no
    // idle glyph left to hold the slot open, the slot animates its own width
    // so the remaining 20px shift is a 150ms slide rather than a jump. That is
    // also why the spacing is per-child margin — flex `gap` is charged between
    // children whatever their width, so a zero-width slot would still cost 6px
    // and the collapse would do nothing.
    const runningLabel = screen.getByText('Idle Session')
    const runningSlot = runningLabel.previousElementSibling as HTMLElement
    expect(screen.getByRole('status')).toBeInTheDocument()
    expect(Array.from(runningLabel.parentElement?.children ?? []).indexOf(runningLabel))
      .toBe(siblingsBeforeLabel)
    expect(runningSlot.className).toContain('w-[14px]')
    expect(runningSlot.className).toContain('transition-[width,margin-right]')
    expect(runningLabel.parentElement?.className).not.toMatch(/\bgap-/)
  })

  it('confines native no-drag geometry to visible tabs through scrolling and resizing', async () => {
    const { TabBar } = await import('./TabBar')
    const { useTabStore } = await import('../../stores/tabStore')
    useTabStore.setState({
      tabs: [
        { sessionId: 'hit-1', title: 'Hit one', type: 'session', status: 'idle' },
        { sessionId: 'hit-2', title: 'Hit two', type: 'session', status: 'idle' },
      ],
      activeTabId: null,
    })
    await act(async () => { render(<TabBar />) })
    const strip = screen.getByTestId('tab-bar-scroll-region')
    const items = strip.querySelectorAll<HTMLElement>('.tab-strip-item')
    let viewport = 600
    let position = 0
    Object.defineProperty(strip, 'clientWidth', { configurable: true, get: () => viewport })
    Object.defineProperty(strip, 'scrollLeft', { configurable: true, get: () => position })
    items.forEach((item, index) => {
      Object.defineProperty(item, 'offsetLeft', { configurable: true, get: () => index * 142 })
      Object.defineProperty(item, 'offsetWidth', { configurable: true, get: () => 140 })
    })
    fireStripResize()
    const hitRegion = screen.getByTestId('tab-bar-hit-region')
    expect(hitRegion).toHaveStyle({ width: '282px' })
    expect(strip).not.toContainElement(hitRegion)
    // The no-drag rectangle covers the 28px chips only (12px above and below
    // in the 52px strip), so the space around them still drags the window.
    expect(hitRegion).toHaveClass('pointer-events-none', 'top-[12px]', 'bottom-[12px]')
    viewport = 200
    fireStripResize()
    expect(hitRegion).toHaveStyle({ width: '200px' })
    position = 82
    fireEvent.scroll(strip)
    expect(hitRegion).toHaveStyle({ width: '200px' })
    position = 0
    viewport = 600
    fireStripResize()
    expect(hitRegion).toHaveStyle({ width: '282px' })
  })

  it('scrolls by a fraction of the visible strip rather than a fixed tab width', async () => {
    const { TabBar } = await import('./TabBar')
    const { useTabStore } = await import('../../stores/tabStore')
    const { useChatStore } = await import('../../stores/chatStore')

    useTabStore.setState({
      tabs: [
        { sessionId: 'tab-1', title: 'First Session', type: 'session', status: 'idle' },
        { sessionId: 'tab-2', title: 'Second Session', type: 'session', status: 'idle' },
        { sessionId: 'tab-3', title: 'Third Session', type: 'session', status: 'idle' },
      ],
      activeTabId: 'tab-1',
    })
    useChatStore.setState({
      sessions: {},
      disconnectSession: vi.fn(),
    } as Partial<ReturnType<typeof useChatStore.getState>>)

    await act(async () => {
      render(<TabBar />)
    })

    const scrollRegion = screen.getByTestId('tab-bar-scroll-region')
    const scrollByMock = vi.fn()
    Object.defineProperty(scrollRegion, 'clientWidth', { configurable: true, get: () => 400 })
    Object.defineProperty(scrollRegion, 'scrollWidth', { configurable: true, get: () => 1200 })
    Object.defineProperty(scrollRegion, 'scrollLeft', { configurable: true, get: () => 0 })
    Object.defineProperty(scrollRegion, 'scrollBy', { configurable: true, value: scrollByMock })

    act(() => {
      fireEvent.scroll(scrollRegion)
    })

    const rightButton = await waitFor(() => {
      const button = screen.getByRole('button', { name: 'Scroll tabs right' })
      expect(button).toBeInTheDocument()
      return button as HTMLButtonElement
    })

    fireEvent.click(rightButton)

    // Tabs size to their titles now, so the old fixed 180px step would
    // overshoot a row of short ones and undershoot a row of long ones.
    expect(scrollByMock).toHaveBeenCalledWith({ left: 300, behavior: 'smooth' })
  })

  it('scrolls the active tab into view when the active tab changes', async () => {
    const { TabBar } = await import('./TabBar')
    const { useTabStore } = await import('../../stores/tabStore')
    const { useChatStore } = await import('../../stores/chatStore')

    useTabStore.setState({
      tabs: [
        { sessionId: 'tab-1', title: 'First Session', type: 'session', status: 'idle' },
        { sessionId: 'tab-2', title: 'Second Session', type: 'session', status: 'idle' },
        { sessionId: 'tab-3', title: 'Third Session', type: 'session', status: 'idle' },
        { sessionId: 'tab-4', title: 'Fourth Session', type: 'session', status: 'idle' },
        { sessionId: 'tab-5', title: 'New Session', type: 'session', status: 'idle' },
      ],
      activeTabId: 'tab-1',
    })
    useChatStore.setState({
      sessions: {},
      disconnectSession: vi.fn(),
    } as Partial<ReturnType<typeof useChatStore.getState>>)

    await act(async () => {
      render(<TabBar />)
    })
    scrollIntoViewMock.mockClear()

    await act(async () => {
      useTabStore.getState().setActiveTab('tab-5')
    })

    expect(scrollIntoViewMock).toHaveBeenCalledWith({
      block: 'nearest',
      inline: 'nearest',
      behavior: 'smooth',
    })
  })

  describe('keeping the active tab whole while the strip resizes', () => {
    // The chevrons are `w-7` siblings of the scroll region, so the moment the
    // strip is found to overflow they take 28px each out of it — after the
    // activation scroll has already landed on a scrollLeft computed without
    // them. Measured on a 1280px window with seven tabs: the scroll stopped at
    // 108 when the reachable end had moved to 164, and the last tab lost
    // exactly those 56px, taking the close button past the strip edge, where
    // elementFromPoint returned the toolbar's terminal button instead. So the
    // tab could not be closed at all, not merely not seen.
    async function renderOverflowingStrip() {
      const { TabBar } = await import('./TabBar')
      const { useTabStore } = await import('../../stores/tabStore')
      const { useChatStore } = await import('../../stores/chatStore')

      useTabStore.setState({
        tabs: [
          { sessionId: 'tab-1', title: 'First Session', type: 'session', status: 'idle' },
          { sessionId: 'tab-2', title: 'Second Session', type: 'session', status: 'idle' },
          { sessionId: 'tab-3', title: 'Third Session', type: 'session', status: 'idle' },
          { sessionId: 'tab-4', title: 'Fourth Session', type: 'session', status: 'idle' },
          { sessionId: 'tab-5', title: 'Last Session', type: 'session', status: 'idle' },
        ],
        activeTabId: 'tab-5',
      })
      useChatStore.setState({
        sessions: {},
        disconnectSession: vi.fn(),
      } as Partial<ReturnType<typeof useChatStore.getState>>)

      await act(async () => {
        render(<TabBar />)
      })

      const strip = screen.getByTestId('tab-bar-scroll-region')
      const activeTab = strip.querySelector('[data-active="true"]') as HTMLElement
      expect(activeTab).toBeInTheDocument()

      // The strip runs 0–840 once both chevrons are in. Everything below moves
      // only the active tab's own rect against that.
      stubRect(strip, 0, 840)
      Object.defineProperty(strip, 'clientWidth', { configurable: true, get: () => 840 })
      Object.defineProperty(strip, 'scrollWidth', { configurable: true, get: () => 1004 })
      Object.defineProperty(strip, 'scrollLeft', { configurable: true, get: () => 108 })
      Object.defineProperty(strip, 'scrollBy', { configurable: true, value: vi.fn() })

      return { strip, activeTab, useTabStore }
    }

    it('re-reveals the active tab when a resize clips it', async () => {
      const { activeTab } = await renderOverflowingStrip()
      // 56px past the strip's right edge — the close button's slot.
      stubRect(activeTab, 640, 896)
      scrollIntoViewMock.mockClear()

      fireStripResize()

      expect(scrollIntoViewMock).toHaveBeenCalledWith({
        block: 'nearest',
        inline: 'nearest',
        behavior: 'smooth',
      })
    })

    it('leaves an already whole active tab where it is', async () => {
      const { activeTab } = await renderOverflowingStrip()
      stubRect(activeTab, 640, 840)
      scrollIntoViewMock.mockClear()

      fireStripResize()

      // Nothing is clipped, so a resize must not scroll. Without the tolerance
      // in the visibility test, subpixel edges would land here and re-scroll on
      // every single resize.
      expect(scrollIntoViewMock).not.toHaveBeenCalled()
    })

    it('leaves the strip alone once the user has driven it with a chevron', async () => {
      const { activeTab } = await renderOverflowingStrip()
      stubRect(activeTab, 640, 896)

      const leftChevron = await waitFor(() => {
        const button = screen.getByRole('button', { name: 'Scroll tabs left' })
        expect(button).toBeInTheDocument()
        return button as HTMLButtonElement
      })
      fireEvent.click(leftChevron)
      scrollIntoViewMock.mockClear()

      // A chevron press is itself a resize source: reaching an end retires one
      // chevron and leaving an end brings the other back, so a plain user
      // scroll fires this observer mid-flight. Realigning there snapped the
      // view straight back and made the left end unreachable.
      fireStripResize()

      expect(scrollIntoViewMock).not.toHaveBeenCalled()
    })

    it('takes the strip back over when the user switches tabs', async () => {
      const { activeTab, strip, useTabStore } = await renderOverflowingStrip()
      stubRect(activeTab, 640, 896)

      const leftChevron = await waitFor(() => {
        const button = screen.getByRole('button', { name: 'Scroll tabs left' })
        expect(button).toBeInTheDocument()
        return button as HTMLButtonElement
      })
      fireEvent.click(leftChevron)

      await act(async () => {
        useTabStore.getState().setActiveTab('tab-4')
      })
      const nextActiveTab = strip.querySelector('[data-active="true"]') as HTMLElement
      stubRect(nextActiveTab, 640, 896)
      scrollIntoViewMock.mockClear()

      fireStripResize()

      expect(scrollIntoViewMock).toHaveBeenCalledWith({
        block: 'nearest',
        inline: 'nearest',
        behavior: 'smooth',
      })
    })
  })

  it('keeps the overflow button flush against window controls on Windows', async () => {
    const { TabBar } = await import('./TabBar')
    const { useTabStore } = await import('../../stores/tabStore')
    const { useChatStore } = await import('../../stores/chatStore')

    useTabStore.setState({
      tabs: [
        { sessionId: 'tab-1', title: 'Untitled Session', type: 'session', status: 'idle' },
        { sessionId: 'tab-2', title: 'Settings', type: 'settings', status: 'idle' },
        { sessionId: 'tab-3', title: 'hello', type: 'session', status: 'idle' },
        { sessionId: 'tab-4', title: 'overflow', type: 'session', status: 'idle' },
      ],
      activeTabId: 'tab-1',
    })
    useChatStore.setState({
      sessions: {},
      disconnectSession: vi.fn(),
    } as Partial<ReturnType<typeof useChatStore.getState>>)

    await act(async () => {
      render(<TabBar />)
    })

    const scrollRegion = screen.getByTestId('tab-bar').querySelector('.overflow-x-hidden')
    expect(scrollRegion).toBeInTheDocument()

    Object.defineProperty(scrollRegion!, 'clientWidth', {
      configurable: true,
      get: () => 240,
    })
    Object.defineProperty(scrollRegion!, 'scrollWidth', {
      configurable: true,
      get: () => 720,
    })
    Object.defineProperty(scrollRegion!, 'scrollLeft', {
      configurable: true,
      get: () => 0,
    })
    Object.defineProperty(scrollRegion!, 'scrollBy', {
      configurable: true,
      value: vi.fn(),
    })

    act(() => {
      fireEvent.scroll(scrollRegion!)
    })

    await waitFor(() => {
      expect(screen.getByTestId('window-controls')).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Scroll tabs right' })).toBeInTheDocument()
    })

    const rightButton = screen.getByRole('button', { name: 'Scroll tabs right' })
    expect(rightButton?.nextElementSibling).toBe(screen.getByTestId('window-controls'))
  })

  it('shows the terminal toolbar when no tabs are open', async () => {
    windowControlsMock.show = false
    const { TabBar } = await import('./TabBar')
    const { useTabStore } = await import('../../stores/tabStore')

    useTabStore.setState({ tabs: [], activeTabId: null })

    await act(async () => {
      render(<TabBar />)
    })

    fireEvent.click(screen.getByRole('button', { name: 'Open Terminal' }))

    const terminalTabs = useTabStore.getState().tabs.filter((tab) => tab.type === 'terminal')
    expect(terminalTabs).toHaveLength(1)
    expect(useTabStore.getState().activeTabId).toBe(terminalTabs[0]?.sessionId)
    expect(screen.queryByTestId('window-controls')).not.toBeInTheDocument()
  })

  it('marks the tab bar as a native drag region', async () => {
    const { TabBar } = await import('./TabBar')
    const { useTabStore } = await import('../../stores/tabStore')
    const { useChatStore } = await import('../../stores/chatStore')

    useTabStore.setState({
      tabs: [
        { sessionId: 'tab-1', title: 'Untitled Session', type: 'session', status: 'idle' },
      ],
      activeTabId: 'tab-1',
    })
    useChatStore.setState({
      sessions: {},
      disconnectSession: vi.fn(),
    } as Partial<ReturnType<typeof useChatStore.getState>>)

    await act(async () => {
      render(<TabBar />)
    })

    expect(screen.getByTestId('tab-bar')).toHaveAttribute('data-desktop-drag-region')
    expect(screen.getByTestId('tab-bar-scroll-region')).toHaveAttribute('data-desktop-drag-region')
    expect(screen.getByTestId('tab-bar-drag-gutter')).toHaveAttribute('data-desktop-drag-region')
    const tab = screen.getByText('Untitled Session').closest('.tab-bar-interactive')
    expect(tab).toBeInTheDocument()
    expect(tab).not.toHaveAttribute('data-desktop-drag-region')
  })

  it('keeps the desktop tab strip at a roomier titlebar height', async () => {
    const { TabBar } = await import('./TabBar')
    const { useTabStore } = await import('../../stores/tabStore')
    const { useChatStore } = await import('../../stores/chatStore')

    useTabStore.setState({
      tabs: [
        { sessionId: 'tab-1', title: 'Untitled Session', type: 'session', status: 'idle' },
      ],
      activeTabId: 'tab-1',
    })
    useChatStore.setState({
      sessions: {},
      disconnectSession: vi.fn(),
    } as Partial<ReturnType<typeof useChatStore.getState>>)

    await act(async () => {
      render(<TabBar />)
    })

    const tabBar = screen.getByTestId('tab-bar')
    const scrollRegion = screen.getByTestId('tab-bar-scroll-region')
    const tab = screen.getByText('Untitled Session').closest('.tab-bar-interactive')

    // 52px, from the handoff. The strip and the drag gutter are siblings, so a
    // mismatch leaves the shorter one with a dead strip of titlebar that the
    // window drag region does not cover.
    expect(tabBar).toHaveClass('min-h-[52px]')
    expect(screen.getByTestId('tab-bar-drag-gutter')).toHaveClass('min-h-[52px]')

    // The tab is a 28px chip centred in the 52px strip, the same chip the
    // workspace's resource tabs use.
    expect(scrollRegion).toHaveClass('items-center')
    expect(scrollRegion.className).not.toMatch(/\bpt-/)
    expect(tab).toHaveClass('h-7')
    // The space around the chips stays inside the drag region: it belongs to
    // the scroll region, which carries the attribute, not to the tab.
    expect(scrollRegion).toHaveAttribute('data-desktop-drag-region')
    expect(tab).not.toHaveAttribute('data-desktop-drag-region')
  })

  it('renders mixed tab types without stray text consuming the window header', async () => {
    const { TabBar } = await import('./TabBar')
    const { useTabStore } = await import('../../stores/tabStore')
    const { useWorkspaceStore } = await import('../../stores/workspaceStore')
    const { WorkspaceHeaderProvider } = await import('./WorkspaceHeaderContext')
    useTabStore.setState({
      tabs: [
        { sessionId: 'header-session', title: 'Header session', type: 'session', status: 'idle' },
        { sessionId: '__settings__', title: 'Settings', type: 'settings', status: 'idle' },
        { sessionId: '__terminal__1', title: 'Terminal', type: 'terminal', status: 'idle' },
        { sessionId: '__market__', title: 'Market', type: 'market', status: 'idle' },
      ],
      activeTabId: 'header-session',
    })
    await act(async () => {
      render(<WorkspaceHeaderProvider><TabBar /></WorkspaceHeaderProvider>)
    })

    const expectNoHeaderText = () => {
      // A bare /* ... */ between JSX elements becomes an anonymous flex item.
      // jsdom still finds every tab even when that text collapses their width
      // in a browser, so check the rendered text nodes, not just tab presence.
      const strayText = [...screen.getByTestId('tab-bar').childNodes]
        .filter((node) => node.nodeType === Node.TEXT_NODE)
        .map((node) => node.textContent?.trim())
        .filter(Boolean)
      expect(strayText).toEqual([])
    }
    expectNoHeaderText()
    for (const [title, id] of [
      ['Localized Settings', '__settings__'],
      ['Terminal', '__terminal__1'],
      ['Extension Market', '__market__'],
      ['Header session', 'header-session'],
    ] as const) {
      fireEvent.click(screen.getByText(title))
      expect(useTabStore.getState().activeTabId).toBe(id)
    }
    await act(async () => {
      useWorkspaceStore.getState().toggleWorkspace('header-session')
    })
    expectNoHeaderText()
  })

  it('keeps the window gutter on the panel paper while the workspace is open', async () => {
    const { TabBar } = await import('./TabBar')
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
      render(<WorkspaceHeaderProvider><TabBar /></WorkspaceHeaderProvider>)
    })

    const frame = screen.getByTestId('workspace-header-frame')
    const gutter = screen.getByTestId('tab-bar-drag-gutter')

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
    const { TabBar } = await import('./TabBar')
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
      render(<WorkspaceHeaderProvider><TabBar /></WorkspaceHeaderProvider>)
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

  it('uses the shared tab chip, with selection strictly stronger than hover', async () => {
    const { TabBar } = await import('./TabBar')
    const { useTabStore } = await import('../../stores/tabStore')
    const { useChatStore } = await import('../../stores/chatStore')

    useTabStore.setState({
      tabs: [
        { sessionId: 'tab-1', title: 'Active One', type: 'session', status: 'idle' },
        { sessionId: 'tab-2', title: 'Inactive One', type: 'session', status: 'idle' },
      ],
      activeTabId: 'tab-1',
    })
    useChatStore.setState({
      sessions: {},
      disconnectSession: vi.fn(),
    } as Partial<ReturnType<typeof useChatStore.getState>>)

    await act(async () => {
      render(<TabBar />)
    })

    const active = screen.getByText('Active One').closest('.tab-bar-interactive')
    const inactive = screen.getByText('Inactive One').closest('.tab-bar-interactive')

    // One chip for both strips: the session tabs carry exactly the classes the
    // workspace's resource tabs do.
    expect(active?.className).toContain(tabChipClass(true))
    expect(inactive?.className).toContain(tabChipClass(false))

    // #1123 landed because the strip, the active tab and the content were all
    // `--color-surface`. The strip stays on the sidebar's ground and only the
    // active chip is filled with paper at rest.
    expect(active?.className).toContain('bg-[var(--color-surface)]')
    expect(inactive?.className).not.toMatch(/(?:^|\s)bg-/)

    // Paper against the trough is 1.05–1.10:1, so the active chip needs the
    // `--color-tab-edge` ring to have a shape; `--color-border` lands at
    // 1.12:1 there and cannot draw it (see contrast.test.ts).
    expect(active?.className).toContain('0_0_0_1px_var(--color-tab-edge)')
    expect(active?.className).not.toContain('var(--color-border)')

    // Hover rises to paper with the faint ring and never uses
    // `--color-surface-hover`, which is brighter than paper on the ink themes
    // and would make a hovered tab outshine the selected one.
    expect(inactive?.className).toContain('hover:bg-[var(--color-surface)]')
    expect(inactive?.className).toContain('hover:shadow-[0_0_0_1px_var(--color-tab-separator)]')
    expect(inactive?.className).not.toContain('surface-hover')
    expect(active?.className).not.toContain('--color-tab-separator')

    // Rings are shadows, not borders, so selecting a tab never moves its title.
    expect(active?.className).not.toMatch(/(?:^|\s)border(?:-|\s|$)/)
    expect(inactive?.className).not.toMatch(/(?:^|\s)border(?:-|\s|$)/)
  })

  it('keeps the strip on the frame ground so the active tab can lift off it', async () => {
    const { TabBar } = await import('./TabBar')
    const { useTabStore } = await import('../../stores/tabStore')
    const { useChatStore } = await import('../../stores/chatStore')

    useTabStore.setState({
      tabs: [
        { sessionId: 'tab-1', title: 'Active One', type: 'session', status: 'idle' },
      ],
      activeTabId: 'tab-1',
    })
    useChatStore.setState({
      sessions: {},
      disconnectSession: vi.fn(),
    } as Partial<ReturnType<typeof useChatStore.getState>>)

    await act(async () => {
      render(<TabBar />)
    })

    const strip = screen.getByTestId('tab-bar')

    // The two halves of the contract. If the strip ever goes back to
    // `--color-surface` the active tab's fill stops reading as a lift and the
    // whole bar flattens again, which is the regression #1123 reported.
    expect(strip).toHaveClass('bg-[var(--color-surface-sidebar)]')
    expect(screen.getByText('Active One').closest('.tab-bar-interactive')?.className)
      .toContain('bg-[var(--color-surface)]')

    // And it stays *exactly* the sidebar's ground — not a darkened trough.
    // Darkening it is the easy way to make the tabs pop, and it is the wrong
    // one: it turns the titlebar into a separate band running across the top
    // of the window instead of the same surface the sidebar is already on.
    expect(strip.className).not.toMatch(/bg-\[var\(--color-(?!surface-sidebar)/)

    // No rule under the strip: like the workspace's resource strip, it is
    // separated from the content by its ground alone.
    expect(strip.className).not.toMatch(/\bborder-b\b/)
  })

  it('marks every tab with its selection state', async () => {
    const { TabBar } = await import('./TabBar')
    const { useTabStore } = await import('../../stores/tabStore')
    const { useChatStore } = await import('../../stores/chatStore')

    useTabStore.setState({
      tabs: [
        { sessionId: 'tab-1', title: 'Active One', type: 'session', status: 'idle' },
        { sessionId: 'tab-2', title: 'Inactive One', type: 'session', status: 'idle' },
      ],
      activeTabId: 'tab-1',
    })
    useChatStore.setState({
      sessions: {},
      disconnectSession: vi.fn(),
    } as Partial<ReturnType<typeof useChatStore.getState>>)

    await act(async () => {
      render(<TabBar />)
    })

    const active = screen.getByText('Active One').closest('.tab-bar-interactive')
    const inactive = screen.getByText('Inactive One').closest('.tab-bar-interactive')

    // Chips are separated by spacing, not by the old hairline. `tab-strip-item`
    // stays as the hook drag measurement and these tests locate tabs by.
    expect(active).toHaveClass('tab-strip-item')
    expect(inactive).toHaveClass('tab-strip-item')
    expect(active).toHaveAttribute('data-active', 'true')
    expect(inactive).toHaveAttribute('data-active', 'false')
  })

  it('sizes tabs to their titles instead of a fixed width', async () => {
    const { TabBar } = await import('./TabBar')
    const { useTabStore } = await import('../../stores/tabStore')
    const { useChatStore } = await import('../../stores/chatStore')

    useTabStore.setState({
      tabs: [
        { sessionId: 'tab-1', title: 'Short', type: 'session', status: 'idle' },
      ],
      activeTabId: 'tab-1',
    })
    useChatStore.setState({
      sessions: {},
      disconnectSession: vi.fn(),
    } as Partial<ReturnType<typeof useChatStore.getState>>)

    await act(async () => {
      render(<TabBar />)
    })

    const tab = screen.getByText('Short').closest('.tab-bar-interactive') as HTMLElement

    expect(tab.className).toContain('min-w-[112px]')
    expect(tab.className).toContain('max-w-[200px]')
    // The inline `width`/`maxWidth` pair is what pinned every tab to 180px and
    // left short titles trailing dead space. Only `transform` belongs inline
    // now — it carries the drag offset.
    expect(tab.style.width).toBe('')
    expect(tab.style.maxWidth).toBe('')
  })

  it('passes the active session workdir into the open-project control', async () => {
    const { TabBar } = await import('./TabBar')
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
      render(<TabBar />)
    })

    expect(screen.getByTestId('open-project-menu')).toHaveTextContent('/repo/worktree')
    expect(openProjectMenuMock.paths[openProjectMenuMock.paths.length - 1]).toBe('/repo/worktree')
  })

  it('does not rerender for chat payload changes when tab running state is unchanged', async () => {
    const { TabBar } = await import('./TabBar')
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
      render(<TabBar />)
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
    const { TabBar } = await import('./TabBar')
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
      render(<TabBar />)
    })

    expect(screen.queryByTestId('open-project-menu')).not.toBeInTheDocument()
  })

  it('opens the source project for a cleaned worktree session', async () => {
    const { TabBar } = await import('./TabBar')
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
      render(<TabBar />)
    })

    expect(screen.getByTestId('open-project-menu')).toBeInTheDocument()
    expect(openProjectMenuMock.paths[openProjectMenuMock.paths.length - 1]).toBe('/repo')
  })

  it('hides the open-project control outside the desktop shell', async () => {
    Reflect.deleteProperty(window, 'desktopHost')

    const { TabBar } = await import('./TabBar')
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
      render(<TabBar />)
    })

    expect(screen.queryByTestId('open-project-menu')).not.toBeInTheDocument()
  })

  it('marks the empty tab-bar gutter as a native drag region without runtime dragging', async () => {
    const { TabBar } = await import('./TabBar')
    const { useTabStore } = await import('../../stores/tabStore')
    const { useChatStore } = await import('../../stores/chatStore')

    useTabStore.setState({
      tabs: [
        { sessionId: 'tab-1', title: 'Untitled Session', type: 'session', status: 'idle' },
      ],
      activeTabId: 'tab-1',
    })
    useChatStore.setState({
      sessions: {},
      disconnectSession: vi.fn(),
    } as Partial<ReturnType<typeof useChatStore.getState>>)

    await act(async () => {
      render(<TabBar />)
    })

    const scrollRegion = screen.getByTestId('tab-bar-scroll-region')
    expect(scrollRegion).toBeInTheDocument()
    expect(scrollRegion).toHaveAttribute('data-desktop-drag-region')

    fireEvent.mouseDown(scrollRegion)

    expect(startDraggingMock).not.toHaveBeenCalled()
  })

  it('does not start dragging when clicking a tab', async () => {
    const { TabBar } = await import('./TabBar')
    const { useTabStore } = await import('../../stores/tabStore')
    const { useChatStore } = await import('../../stores/chatStore')

    useTabStore.setState({
      tabs: [
        { sessionId: 'tab-1', title: 'Untitled Session', type: 'session', status: 'idle' },
      ],
      activeTabId: 'tab-1',
    })
    useChatStore.setState({
      sessions: {},
      disconnectSession: vi.fn(),
    } as Partial<ReturnType<typeof useChatStore.getState>>)

    await act(async () => {
      render(<TabBar />)
    })

    fireEvent.mouseDown(screen.getByText('Untitled Session'))

    expect(startDraggingMock).not.toHaveBeenCalled()
  })

  it('reorders tabs via pointer drag', async () => {
    const { TabBar } = await import('./TabBar')
    const { useTabStore } = await import('../../stores/tabStore')
    const { useChatStore } = await import('../../stores/chatStore')

    useTabStore.setState({
      tabs: [
        { sessionId: 'tab-1', title: 'First Session', type: 'session', status: 'idle' },
        { sessionId: 'tab-2', title: 'Second Session', type: 'session', status: 'idle' },
      ],
      activeTabId: 'tab-1',
    })
    useChatStore.setState({
      sessions: {},
      disconnectSession: vi.fn(),
    } as Partial<ReturnType<typeof useChatStore.getState>>)

    await act(async () => {
      render(<TabBar />)
    })

    expect(screen.getByTestId('tab-bar').querySelector('.tab-bar-interactive')).toBeInTheDocument()

    const firstTab = screen.getByText('First Session').closest('.tab-bar-interactive')
    const secondTab = screen.getByText('Second Session').closest('.tab-bar-interactive')

    expect(firstTab).toBeTruthy()
    expect(secondTab).toBeTruthy()

    Object.defineProperty(firstTab!, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({ left: 0, width: 180 }),
    })
    Object.defineProperty(secondTab!, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({ left: 180, width: 180 }),
    })

    fireEvent.mouseDown(firstTab!, { button: 0, clientX: 20, clientY: 10 })
    fireEvent.mouseMove(window, { clientX: 260, clientY: 10 })

    expect(firstTab).toHaveAttribute('data-dragging', 'true')

    fireEvent.mouseUp(window)

    expect(useTabStore.getState().tabs.map((tab) => tab.sessionId)).toEqual(['tab-2', 'tab-1'])
  })

  it('reorders the settings tab when its transformed drag preview follows the pointer', async () => {
    const { TabBar } = await import('./TabBar')
    const { SETTINGS_TAB_ID, useTabStore } = await import('../../stores/tabStore')
    const { useChatStore } = await import('../../stores/chatStore')

    useTabStore.setState({
      tabs: [
        { sessionId: 'tab-1', title: 'First Session', type: 'session', status: 'idle' },
        { sessionId: SETTINGS_TAB_ID, title: 'Settings', type: 'settings', status: 'idle' },
        { sessionId: 'tab-2', title: 'Second Session', type: 'session', status: 'idle' },
      ],
      activeTabId: SETTINGS_TAB_ID,
    })
    useChatStore.setState({
      sessions: {},
      disconnectSession: vi.fn(),
    } as Partial<ReturnType<typeof useChatStore.getState>>)

    await act(async () => {
      render(<TabBar />)
    })

    const firstTab = screen.getByText('First Session').closest('.tab-bar-interactive') as HTMLElement
    const settingsTab = screen.getByText('Localized Settings').closest('.tab-bar-interactive') as HTMLElement
    const secondTab = screen.getByText('Second Session').closest('.tab-bar-interactive') as HTMLElement

    stubRect(firstTab, 0, 140)
    stubRect(secondTab, 339, 479)
    Object.defineProperty(settingsTab, 'getBoundingClientRect', {
      configurable: true,
      value: () => {
        const translateX = Number(/translateX\(([-\d.]+)px\)/.exec(settingsTab.style.transform)?.[1] ?? 0)
        const left = 142 + translateX
        return { left, right: left + 195, width: 195 }
      },
    })

    // Grab the left half. Once the preview is transformed, reading its live rect
    // makes its midpoint chase the pointer and the tab incorrectly targets itself.
    fireEvent.mouseDown(settingsTab, { button: 0, clientX: 160, clientY: 10 })
    fireEvent.mouseMove(window, { clientX: 170, clientY: 10 })
    fireEvent.mouseMove(window, { clientX: 430, clientY: 10 })
    fireEvent.mouseUp(window)

    expect(useTabStore.getState().tabs.map((tab) => tab.sessionId)).toEqual([
      'tab-1',
      'tab-2',
      SETTINGS_TAB_ID,
    ])
  })

  // Regression: the click-suppression flag set at drag start was only ever cleared
  // inside handleTabClick, which is reachable only from a tab's own onClick. Release
  // the drag away from any tab — below the strip, or outside the window — and nothing
  // consumes it, so the flag survives and eats the user's next tab click. finalizeDrag
  // clears every other drag ref but not this one.
  it('still activates a tab clicked after a drag that ended off the strip', async () => {
    const { TabBar } = await import('./TabBar')
    const { useTabStore } = await import('../../stores/tabStore')
    const { useChatStore } = await import('../../stores/chatStore')

    const setActiveTab = vi.fn()
    useTabStore.setState({
      tabs: [
        { sessionId: 'tab-1', title: 'First Session', type: 'session', status: 'idle' },
        { sessionId: 'tab-2', title: 'Second Session', type: 'session', status: 'idle' },
      ],
      activeTabId: 'tab-1',
      setActiveTab,
    } as Partial<ReturnType<typeof useTabStore.getState>>)
    useChatStore.setState({
      sessions: {},
      disconnectSession: vi.fn(),
    } as Partial<ReturnType<typeof useChatStore.getState>>)

    await act(async () => {
      render(<TabBar />)
    })

    const firstTab = screen.getByText('First Session').closest('.tab-bar-interactive')
    const secondTab = screen.getByText('Second Session').closest('.tab-bar-interactive')
    for (const [element, left] of [[firstTab, 0], [secondTab, 180]] as const) {
      Object.defineProperty(element!, 'getBoundingClientRect', {
        configurable: true,
        value: () => ({ left, width: 180 }),
      })
    }

    // Drag the first tab and let go well below the strip, so the browser dispatches
    // no click on any tab — exactly the case that used to strand the flag.
    fireEvent.mouseDown(firstTab!, { button: 0, clientX: 20, clientY: 10 })
    fireEvent.mouseMove(window, { clientX: 40, clientY: 400 })
    fireEvent.mouseUp(window)

    setActiveTab.mockClear()
    fireEvent.mouseDown(secondTab!, { button: 0, clientX: 200, clientY: 10 })
    fireEvent.click(secondTab!)

    expect(setActiveTab).toHaveBeenCalledWith('tab-2')
  })

  it('does not reorder on a simple click without dragging', async () => {
    const { TabBar } = await import('./TabBar')
    const { useTabStore } = await import('../../stores/tabStore')
    const { useChatStore } = await import('../../stores/chatStore')

    useTabStore.setState({
      tabs: [
        { sessionId: 'tab-1', title: 'First Session', type: 'session', status: 'idle' },
        { sessionId: 'tab-2', title: 'Second Session', type: 'session', status: 'idle' },
      ],
      activeTabId: 'tab-1',
    })
    useChatStore.setState({
      sessions: {},
      disconnectSession: vi.fn(),
    } as Partial<ReturnType<typeof useChatStore.getState>>)

    await act(async () => {
      render(<TabBar />)
    })

    const firstTab = screen.getByText('First Session').closest('.tab-bar-interactive')
    expect(firstTab).toBeTruthy()

    fireEvent.mouseDown(firstTab!, { button: 0, clientX: 20, clientY: 10 })
    fireEvent.mouseUp(window)
    fireEvent.click(firstTab!)

    expect(useTabStore.getState().tabs.map((tab) => tab.sessionId)).toEqual(['tab-1', 'tab-2'])
    expect(useTabStore.getState().activeTabId).toBe('tab-1')
  })

  it('closes a tab from the close button without activating drag behavior', async () => {
    const { TabBar } = await import('./TabBar')
    const { useTabStore } = await import('../../stores/tabStore')
    const { useChatStore } = await import('../../stores/chatStore')

    const disconnectSession = vi.fn()

    useTabStore.setState({
      tabs: [
        { sessionId: 'tab-1', title: 'First Session', type: 'session', status: 'idle' },
        { sessionId: 'tab-2', title: 'Second Session', type: 'session', status: 'idle' },
      ],
      activeTabId: 'tab-2',
    })
    useChatStore.setState({
      sessions: {},
      disconnectSession,
    } as Partial<ReturnType<typeof useChatStore.getState>>)

    await act(async () => {
      render(<TabBar />)
    })

    const firstTab = screen.getByText('First Session').closest('.tab-bar-interactive')
    const closeButton = screen.getByLabelText('Close First Session')

    expect(firstTab).toHaveClass('group')

    fireEvent.mouseDown(closeButton, { button: 0, clientX: 20, clientY: 10 })
    fireEvent.click(closeButton)
    fireEvent.mouseMove(window, { clientX: 260, clientY: 10 })
    fireEvent.mouseUp(window)

    expect(disconnectSession).toHaveBeenCalledWith('tab-1')
    expect(useTabStore.getState().tabs.map((tab) => tab.sessionId)).toEqual(['tab-2'])
    expect(useTabStore.getState().activeTabId).toBe('tab-2')
  })

  it('does not delete a session when its list and history failed to load', async () => {
    const { TabBar } = await import('./TabBar')
    const { useTabStore } = await import('../../stores/tabStore')
    const { useChatStore } = await import('../../stores/chatStore')
    const { useSessionStore } = await import('../../stores/sessionStore')

    useTabStore.setState({
      tabs: [
        { sessionId: 'recovered-session', title: 'Recovered Session', type: 'session', status: 'idle' },
      ],
      activeTabId: 'recovered-session',
    })
    useSessionStore.setState({
      sessions: [],
      isLoading: false,
      error: 'Session list request timed out',
    })
    useChatStore.setState({
      sessions: {},
      disconnectSession: vi.fn(),
    } as Partial<ReturnType<typeof useChatStore.getState>>)

    await act(async () => {
      render(<TabBar />)
    })

    fireEvent.click(screen.getByLabelText('Close Recovered Session'))

    expect(sessionsApiMock.delete).not.toHaveBeenCalled()
    expect(useTabStore.getState().tabs).toEqual([])
  })

  it('does not delete a session whose server metadata reports messages', async () => {
    const { TabBar } = await import('./TabBar')
    const { useTabStore } = await import('../../stores/tabStore')
    const { useChatStore } = await import('../../stores/chatStore')
    const { useSessionStore } = await import('../../stores/sessionStore')
    const sessionId = 'persisted-session'

    useTabStore.setState({
      tabs: [{ sessionId, title: 'New Session', type: 'session', status: 'idle' }],
      activeTabId: sessionId,
    })
    useSessionStore.setState({
      sessions: [{
        id: sessionId,
        title: 'New Session',
        createdAt: '2026-08-13T00:00:00.000Z',
        modifiedAt: '2026-08-13T00:00:00.000Z',
        messageCount: 2,
        projectPath: '/repo',
        workDir: '/repo',
        workDirExists: true,
      }],
      isLoading: false,
      error: null,
    })
    useChatStore.setState({
      sessions: {
        [sessionId]: { ...makeChatSession('idle'), historyStatus: 'ready' },
      },
      disconnectSession: vi.fn(),
    } as Partial<ReturnType<typeof useChatStore.getState>>)

    await act(async () => {
      render(<TabBar />)
    })

    fireEvent.click(screen.getByLabelText('Close New Session'))

    expect(sessionsApiMock.delete).not.toHaveBeenCalled()
  })

  it('deletes a confirmed empty placeholder session when closing its tab', async () => {
    const { TabBar } = await import('./TabBar')
    const { useTabStore } = await import('../../stores/tabStore')
    const { useChatStore } = await import('../../stores/chatStore')
    const { useSessionStore } = await import('../../stores/sessionStore')
    const sessionId = 'empty-session'

    useTabStore.setState({
      tabs: [{ sessionId, title: 'New Session', type: 'session', status: 'idle' }],
      activeTabId: sessionId,
    })
    useSessionStore.setState({
      sessions: [{
        id: sessionId,
        title: 'New Session',
        createdAt: '2026-08-13T00:00:00.000Z',
        modifiedAt: '2026-08-13T00:00:00.000Z',
        messageCount: 0,
        projectPath: '/repo',
        workDir: '/repo',
        workDirExists: true,
      }],
      isLoading: false,
      error: null,
    })
    useChatStore.setState({
      sessions: {
        [sessionId]: { ...makeChatSession('idle'), historyStatus: 'ready' },
      },
      disconnectSession: vi.fn(),
    } as Partial<ReturnType<typeof useChatStore.getState>>)

    await act(async () => {
      render(<TabBar />)
    })

    fireEvent.click(screen.getByLabelText('Close New Session'))

    await waitFor(() => {
      expect(sessionsApiMock.delete).toHaveBeenCalledWith(sessionId)
    })
  })

  it('closes terminal tabs without disconnecting chat sessions', async () => {
    const { TabBar } = await import('./TabBar')
    const { useTabStore } = await import('../../stores/tabStore')
    const { useChatStore } = await import('../../stores/chatStore')

    const disconnectSession = vi.fn()

    useTabStore.setState({
      tabs: [
        { sessionId: '__terminal__1', title: 'Terminal 1', type: 'terminal', status: 'idle' },
      ],
      activeTabId: '__terminal__1',
    })
    useChatStore.setState({
      sessions: {},
      disconnectSession,
    } as Partial<ReturnType<typeof useChatStore.getState>>)

    await act(async () => {
      render(<TabBar />)
    })

    expect(screen.getByLabelText('Open Terminal')).toBeInTheDocument()

    fireEvent.click(screen.getByLabelText('Close Terminal 1'))

    expect(disconnectSession).not.toHaveBeenCalled()
    expect(useTabStore.getState().tabs).toEqual([])
  })

  it('closes the market tab from the close button without disconnecting chat sessions', async () => {
    const { TabBar } = await import('./TabBar')
    const { MARKET_TAB_ID, useTabStore } = await import('../../stores/tabStore')
    const { useChatStore } = await import('../../stores/chatStore')

    const disconnectSession = vi.fn()

    useTabStore.setState({
      tabs: [
        { sessionId: 'tab-1', title: 'First Session', type: 'session', status: 'idle' },
        { sessionId: MARKET_TAB_ID, title: 'Market', type: 'market', status: 'idle' },
      ],
      activeTabId: MARKET_TAB_ID,
    })
    useChatStore.setState({
      sessions: {},
      disconnectSession,
    } as Partial<ReturnType<typeof useChatStore.getState>>)

    await act(async () => {
      render(<TabBar />)
    })

    fireEvent.click(screen.getByLabelText('Close Extension Market'))

    expect(disconnectSession).not.toHaveBeenCalled()
    expect(useTabStore.getState().tabs.map((tab) => tab.sessionId)).toEqual(['tab-1'])
    expect(useTabStore.getState().activeTabId).toBe('tab-1')
  })

  it('opens the bottom terminal panel from the toolbar for an active session', async () => {
    const { useWorkspaceStore } = await import('../../stores/workspaceStore')
    const { TabBar } = await import('./TabBar')
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
      render(<TabBar />)
    })

    fireEvent.click(screen.getByRole('button', { name: 'Toggle bottom panel' }))

    const terminalTabs = useTabStore.getState().tabs.filter((tab) => tab.type === 'terminal')
    expect(terminalTabs).toHaveLength(0)
    expect(useWorkspaceStore.getState().getSession('tab-1').bottomOpen).toBe(true)
    expect(useWorkspaceStore.getState().getTabs('tab-1', 'bottom')).toHaveLength(1)
  })

  it('treats legacy session tabs without a type as bottom-panel terminal targets', async () => {
    const { useWorkspaceStore } = await import('../../stores/workspaceStore')
    const { TabBar } = await import('./TabBar')
    const { useTabStore } = await import('../../stores/tabStore')
    const { useChatStore } = await import('../../stores/chatStore')

    useTabStore.setState({
      tabs: [
        { sessionId: 'legacy-session', title: 'Legacy Session', status: 'idle' } as ReturnType<typeof useTabStore.getState>['tabs'][number],
      ],
      activeTabId: 'legacy-session',
    })
    useChatStore.setState({
      sessions: {},
      disconnectSession: vi.fn(),
    } as Partial<ReturnType<typeof useChatStore.getState>>)

    await act(async () => {
      render(<TabBar />)
    })

    fireEvent.click(screen.getByRole('button', { name: 'Toggle bottom panel' }))

    expect(useTabStore.getState().tabs.some((tab) => tab.type === 'terminal')).toBe(false)
    expect(useWorkspaceStore.getState().getSession('legacy-session').bottomOpen).toBe(true)
  })

  it('toggles the workspace panel for the active session from the toolbar', async () => {
    const { useWorkspaceStore } = await import('../../stores/workspaceStore')
    const { TabBar } = await import('./TabBar')
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
      render(<TabBar />)
    })

    fireEvent.click(screen.getByRole('button', { name: 'Show Workspace' }))
    expect(useWorkspaceStore.getState().getSession('tab-1').layout).toBe('split')

    fireEvent.click(screen.getByRole('button', { name: 'Hide Workspace' }))
    expect(useWorkspaceStore.getState().getSession('tab-1').layout).toBe('hidden')
  })

  it('keeps workspace and terminal entry points available on H5', async () => {
    window.desktopHost = browserHost
    const { TabBar } = await import('./TabBar')
    const { useTabStore } = await import('../../stores/tabStore')
    const { useWorkspaceStore } = await import('../../stores/workspaceStore')
    useTabStore.setState({ tabs: [{ sessionId: 'h5-task', title: 'H5 Task', type: 'session', status: 'idle' }], activeTabId: 'h5-task' })
    await act(async () => { render(<TabBar />) })
    fireEvent.click(screen.getByRole('button', { name: 'Show Workspace' }))
    expect(useWorkspaceStore.getState().getSession('h5-task').layout).toBe('split')
    expect(screen.getByRole('button', { name: 'Toggle bottom panel' })).toBeInTheDocument()
  })

  it('does not render a browser toolbar button for session tabs', async () => {
    const { TabBar } = await import('./TabBar')
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
      render(<TabBar />)
    })

    expect(screen.queryByRole('button', { name: 'Show Browser' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Hide Browser' })).not.toBeInTheDocument()
  })

  it('hides the browser toolbar button for non-session tabs', async () => {
    const { TabBar } = await import('./TabBar')
    const { useTabStore } = await import('../../stores/tabStore')
    const { useChatStore } = await import('../../stores/chatStore')

    useTabStore.setState({
      tabs: [
        { sessionId: '__terminal__1', title: 'Terminal 1', type: 'terminal', status: 'idle' },
        { sessionId: '__settings__', title: 'Settings', type: 'settings', status: 'idle' },
      ],
      activeTabId: '__terminal__1',
    })
    useChatStore.setState({
      sessions: {},
      disconnectSession: vi.fn(),
    } as Partial<ReturnType<typeof useChatStore.getState>>)

    const { rerender } = render(<TabBar />)

    expect(screen.queryByRole('button', { name: 'Show Browser' })).not.toBeInTheDocument()

    await act(async () => {
      useTabStore.getState().setActiveTab('__settings__')
    })
    rerender(<TabBar />)

    expect(screen.queryByRole('button', { name: 'Show Browser' })).not.toBeInTheDocument()
  })

  it('hides the workspace toolbar button for non-session tabs', async () => {
    const { TabBar } = await import('./TabBar')
    const { useTabStore } = await import('../../stores/tabStore')
    const { useChatStore } = await import('../../stores/chatStore')

    useTabStore.setState({
      tabs: [
        { sessionId: '__terminal__1', title: 'Terminal 1', type: 'terminal', status: 'idle' },
        { sessionId: '__settings__', title: 'Settings', type: 'settings', status: 'idle' },
      ],
      activeTabId: '__terminal__1',
    })
    useChatStore.setState({
      sessions: {},
      disconnectSession: vi.fn(),
    } as Partial<ReturnType<typeof useChatStore.getState>>)

    const { rerender } = render(<TabBar />)

    expect(screen.queryByRole('button', { name: 'Show Workspace' })).not.toBeInTheDocument()

    await act(async () => {
      useTabStore.getState().setActiveTab('__settings__')
    })
    rerender(<TabBar />)

    expect(screen.queryByRole('button', { name: 'Show Workspace' })).not.toBeInTheDocument()
  })

  it('treats active SubAgent tabs as non-session tabs for toolbar state', async () => {
    const { useWorkspaceStore } = await import('../../stores/workspaceStore')
    const { TabBar } = await import('./TabBar')
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
      render(<TabBar />)
    })

    expect(screen.queryByRole('button', { name: /activity/i })).not.toBeInTheDocument()
    expect(screen.queryByTestId('open-project-menu')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Show Workspace' })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Open Terminal' }))

    expect(useTabStore.getState().tabs.some((tab) => tab.type === 'terminal')).toBe(true)
    expect(useWorkspaceStore.getState().bySession[tabId]).toBeUndefined()
    expect(useActivityPanelStore.getState().isOpen(tabId)).toBe(false)
  })

  it('treats the market tab as a non-session toolbar target', async () => {
    const { useWorkspaceStore } = await import('../../stores/workspaceStore')
    const { TabBar } = await import('./TabBar')
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
      render(<TabBar />)
    })

    expect(screen.queryByTestId('open-project-menu')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Show Workspace' })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Open Terminal' }))

    const terminalTabs = useTabStore.getState().tabs.filter((tab) => tab.type === 'terminal')
    expect(terminalTabs).toHaveLength(1)
    expect(useTabStore.getState().activeTabId).toBe(terminalTabs[0]?.sessionId)
    expect(useWorkspaceStore.getState().getSession(MARKET_TAB_ID).bottomOpen).toBe(false)
  })

  it('clears session panel state when closing a session tab', async () => {
    const { TabBar } = await import('./TabBar')
    const { useTabStore } = await import('../../stores/tabStore')
    const { useChatStore } = await import('../../stores/chatStore')
    const { useWorkspaceStore } = await import('../../stores/workspaceStore')
    const { useActivityPanelStore } = await import('../../stores/activityPanelStore')

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
    useWorkspaceStore.getState().openTarget('tab-1', { kind: 'file', path: 'a.ts' })
    useWorkspaceStore.getState().openTarget('tab-1', { kind: 'terminal', cwd: '/repo', dock: 'bottom' })
    useActivityPanelStore.getState().open('tab-1')

    await act(async () => {
      render(<TabBar />)
    })

    fireEvent.click(screen.getByLabelText('Close First Session'))

    expect(useWorkspaceStore.getState().bySession['tab-1']).toBeUndefined()
    expect(useActivityPanelStore.getState().isOpen('tab-1')).toBe(false)
  })

  it('asks before stopping running sessions when closing all tabs', async () => {
    const { TabBar } = await import('./TabBar')
    const { useTabStore } = await import('../../stores/tabStore')
    const { useChatStore } = await import('../../stores/chatStore')

    const disconnectSession = vi.fn()
    const stopGeneration = vi.fn()

    useTabStore.setState({
      tabs: [
        { sessionId: 'tab-running', title: 'Running Session', type: 'session', status: 'running' },
        { sessionId: 'tab-thinking', title: 'Thinking Session', type: 'session', status: 'running' },
        { sessionId: 'tab-idle', title: 'Idle Session', type: 'session', status: 'idle' },
      ],
      activeTabId: 'tab-running',
    })
    useChatStore.setState({
      sessions: {
        'tab-running': makeChatSession('streaming'),
        'tab-thinking': makeChatSession('thinking'),
        'tab-idle': makeChatSession('idle'),
      },
      disconnectSession,
      stopGeneration,
    } as Partial<ReturnType<typeof useChatStore.getState>>)

    await act(async () => {
      render(<TabBar />)
    })

    fireEvent.contextMenu(screen.getByText('Running Session'))
    fireEvent.click(screen.getByText('Close All'))

    expect(screen.getByText('Sessions Running')).toBeInTheDocument()
    expect(screen.getByRole('dialog', { name: 'Sessions Running' })).toBeInTheDocument()
    expect(screen.getByText('2 sessions still running')).toBeInTheDocument()
    expect(useTabStore.getState().tabs.map((tab) => tab.sessionId)).toEqual(['tab-running', 'tab-thinking', 'tab-idle'])
    expect(disconnectSession).not.toHaveBeenCalled()
    expect(stopGeneration).not.toHaveBeenCalled()

    fireEvent.click(screen.getByText('Stop All & Close'))

    expect(stopGeneration).toHaveBeenCalledWith('tab-running')
    expect(stopGeneration).toHaveBeenCalledWith('tab-thinking')
    expect(stopGeneration).toHaveBeenCalledTimes(2)
    expect(disconnectSession).toHaveBeenCalledWith('tab-running')
    expect(disconnectSession).toHaveBeenCalledWith('tab-thinking')
    expect(disconnectSession).toHaveBeenCalledWith('tab-idle')
    expect(useTabStore.getState().tabs).toEqual([])
  })

  // The "Session running" dialog counts background tasks as work in progress, so
  // its Stop & Close has to stop them. `stopGeneration` alone does not: the server
  // only interrupts the foreground turn and Agent tasks, which left a background
  // shell command (and the session it kept busy) alive after "Stop & Close" and
  // made the reopened session ask the same question again (issue #1398).
  //
  // These tests run the real chat-store actions on top of a recorded socket so
  // they see what would really leave the client, and in which order.
  describe('stopping background tasks when closing a running session', () => {
    async function recordSocketTraffic() {
      const { wsManager } = await import('../../api/websocket')
      const traffic: string[] = []
      vi.spyOn(wsManager, 'send').mockImplementation((sessionId, message) => {
        traffic.push(
          `send ${sessionId} ${message.type}${message.type === 'stop_background_task' ? ` ${message.taskId}` : ''}`,
        )
      })
      vi.spyOn(wsManager, 'disconnect').mockImplementation((sessionId) => {
        traffic.push(`disconnect ${sessionId}`)
      })
      return traffic
    }

    it('stops the background shell task that kept an otherwise idle session running', async () => {
      const { TabBar } = await import('./TabBar')
      const { useTabStore } = await import('../../stores/tabStore')
      const { useChatStore } = await import('../../stores/chatStore')
      const traffic = await recordSocketTraffic()

      useTabStore.setState({
        tabs: [{ sessionId: 'tab-shell', title: 'Shell Session', type: 'session', status: 'idle' }],
        activeTabId: 'tab-shell',
      })
      useChatStore.setState({
        sessions: {
          'tab-shell': makeSessionWithTasks('idle', [makeBackgroundTask('shell-1')]),
        },
      } as Partial<ReturnType<typeof useChatStore.getState>>)

      await act(async () => {
        render(<TabBar />)
      })

      fireEvent.click(screen.getByLabelText('Close Shell Session'))

      expect(screen.getByRole('dialog', { name: 'Session Running' })).toBeInTheDocument()
      expect(traffic).toEqual([])

      fireEvent.click(screen.getByText('Stop & Close'))

      expect(traffic).toEqual([
        'send tab-shell stop_generation',
        'send tab-shell stop_background_task shell-1',
        'disconnect tab-shell',
      ])
      expect(useTabStore.getState().tabs).toEqual([])
    })

    it('stops only the tasks that are still running and count as session activity', async () => {
      const { TabBar } = await import('./TabBar')
      const { useTabStore } = await import('../../stores/tabStore')
      const { useChatStore } = await import('../../stores/chatStore')
      const traffic = await recordSocketTraffic()

      useTabStore.setState({
        tabs: [{ sessionId: 'tab-mixed', title: 'Mixed Session', type: 'session', status: 'running' }],
        activeTabId: 'tab-mixed',
      })
      useChatStore.setState({
        sessions: {
          'tab-mixed': makeSessionWithTasks('thinking', [
            makeBackgroundTask('shell-running'),
            makeBackgroundTask('shell-done', { status: 'completed' }),
            makeBackgroundTask('shell-failed', { status: 'failed' }),
            makeBackgroundTask('shell-stopped', { status: 'stopped' }),
            // AutoDream is detached maintenance: it never counted as the session running.
            makeBackgroundTask('dream-running', { taskType: 'dream' }),
            // A teammate runtime is a container, not an activity row the user can stop.
            makeBackgroundTask('teammate-running', { taskType: 'in_process_teammate' }),
          ]),
        },
      } as Partial<ReturnType<typeof useChatStore.getState>>)

      await act(async () => {
        render(<TabBar />)
      })

      fireEvent.click(screen.getByLabelText('Close Mixed Session'))
      fireEvent.click(screen.getByText('Stop & Close'))

      expect(traffic).toEqual([
        'send tab-mixed stop_generation',
        'send tab-mixed stop_background_task shell-running',
        'disconnect tab-mixed',
      ])
    })

    it('does not stop a running Agent a second time after the session-level stop', async () => {
      const { TabBar } = await import('./TabBar')
      const { useTabStore } = await import('../../stores/tabStore')
      const { useChatStore } = await import('../../stores/chatStore')
      const traffic = await recordSocketTraffic()

      useTabStore.setState({
        tabs: [{ sessionId: 'tab-agent', title: 'Agent Session', type: 'session', status: 'idle' }],
        activeTabId: 'tab-agent',
      })
      useChatStore.setState({
        sessions: {
          'tab-agent': makeSessionWithTasks('idle', [
            makeBackgroundTask('agent-1', { taskType: 'local_agent' }),
            makeBackgroundTask('shell-1'),
          ]),
        },
      } as Partial<ReturnType<typeof useChatStore.getState>>)

      await act(async () => {
        render(<TabBar />)
      })

      fireEvent.click(screen.getByLabelText('Close Agent Session'))
      fireEvent.click(screen.getByText('Stop & Close'))

      // `stopGeneration` already marks the Agent as stopping; only the shell is left to stop.
      expect(traffic).toEqual([
        'send tab-agent stop_generation',
        'send tab-agent stop_background_task shell-1',
        'disconnect tab-agent',
      ])
    })

    it('sends no stop message when the user keeps the session running', async () => {
      const { TabBar } = await import('./TabBar')
      const { useTabStore } = await import('../../stores/tabStore')
      const { useChatStore } = await import('../../stores/chatStore')
      const traffic = await recordSocketTraffic()

      useTabStore.setState({
        tabs: [{ sessionId: 'tab-shell', title: 'Shell Session', type: 'session', status: 'idle' }],
        activeTabId: 'tab-shell',
      })
      useChatStore.setState({
        sessions: {
          'tab-shell': makeSessionWithTasks('idle', [makeBackgroundTask('shell-1')]),
        },
      } as Partial<ReturnType<typeof useChatStore.getState>>)

      await act(async () => {
        render(<TabBar />)
      })

      fireEvent.click(screen.getByLabelText('Close Shell Session'))
      fireEvent.click(screen.getByText('Keep Running'))

      expect(traffic).toEqual([])
      expect(useTabStore.getState().tabs).toEqual([])
      expect(useChatStore.getState().sessions['tab-shell']?.backgroundAgentTasks?.['shell-1']?.status).toBe('running')
    })

    it('stops the background tasks of every running session when closing all tabs', async () => {
      const { TabBar } = await import('./TabBar')
      const { useTabStore } = await import('../../stores/tabStore')
      const { useChatStore } = await import('../../stores/chatStore')
      const traffic = await recordSocketTraffic()

      useTabStore.setState({
        tabs: [
          { sessionId: 'tab-a', title: 'Session A', type: 'session', status: 'idle' },
          { sessionId: 'tab-b', title: 'Session B', type: 'session', status: 'idle' },
          { sessionId: 'tab-idle', title: 'Idle Session', type: 'session', status: 'idle' },
        ],
        activeTabId: 'tab-a',
      })
      useChatStore.setState({
        sessions: {
          'tab-a': makeSessionWithTasks('idle', [makeBackgroundTask('a-1')]),
          'tab-b': makeSessionWithTasks('idle', [makeBackgroundTask('b-1'), makeBackgroundTask('b-2')]),
          'tab-idle': makeSessionWithTasks('idle', [makeBackgroundTask('old', { status: 'completed' })]),
        },
      } as Partial<ReturnType<typeof useChatStore.getState>>)

      await act(async () => {
        render(<TabBar />)
      })

      fireEvent.contextMenu(screen.getByText('Session A'))
      fireEvent.click(screen.getByText('Close All'))

      expect(screen.getByRole('dialog', { name: 'Sessions Running' })).toBeInTheDocument()
      expect(traffic).toEqual([])

      fireEvent.click(screen.getByText('Stop All & Close'))

      expect(traffic).toEqual([
        'send tab-a stop_generation',
        'send tab-a stop_background_task a-1',
        'disconnect tab-a',
        'send tab-b stop_generation',
        'send tab-b stop_background_task b-1',
        'send tab-b stop_background_task b-2',
        'disconnect tab-b',
        'disconnect tab-idle',
      ])
      expect(useTabStore.getState().tabs).toEqual([])
    })

    it('leaves the tabs that stay open alone when closing the others', async () => {
      const { TabBar } = await import('./TabBar')
      const { useTabStore } = await import('../../stores/tabStore')
      const { useChatStore } = await import('../../stores/chatStore')
      const traffic = await recordSocketTraffic()

      useTabStore.setState({
        tabs: [
          { sessionId: 'tab-other', title: 'Other Session', type: 'session', status: 'idle' },
          { sessionId: 'tab-kept', title: 'Kept Session', type: 'session', status: 'idle' },
        ],
        activeTabId: 'tab-kept',
      })
      useChatStore.setState({
        sessions: {
          'tab-other': makeSessionWithTasks('idle', [makeBackgroundTask('other-1')]),
          'tab-kept': makeSessionWithTasks('idle', [makeBackgroundTask('kept-1')]),
        },
      } as Partial<ReturnType<typeof useChatStore.getState>>)

      await act(async () => {
        render(<TabBar />)
      })

      fireEvent.contextMenu(screen.getByText('Kept Session'))
      fireEvent.click(screen.getByText('Close Others'))
      fireEvent.click(screen.getByText('Stop & Close'))

      expect(traffic).toEqual([
        'send tab-other stop_generation',
        'send tab-other stop_background_task other-1',
        'disconnect tab-other',
      ])
      expect(useTabStore.getState().tabs.map((tab) => tab.sessionId)).toEqual(['tab-kept'])
      expect(useChatStore.getState().sessions['tab-kept']?.backgroundAgentTasks?.['kept-1']?.status).toBe('running')
    })
  })

  it('shows a running marker on tabs from tab status, live chat state, or background tasks', async () => {
    const { TabBar } = await import('./TabBar')
    const { useTabStore } = await import('../../stores/tabStore')
    const { useChatStore } = await import('../../stores/chatStore')
    const backgroundRunningSession = makeChatSession('idle')
    backgroundRunningSession.backgroundAgentTasks = {
      'agent-task-1': {
        taskId: 'agent-task-1',
        toolUseId: 'agent-tool-1',
        status: 'running',
        taskType: 'local_agent',
        description: 'Review screenshots',
        startedAt: 1,
        updatedAt: 2,
      },
    }

    useTabStore.setState({
      tabs: [
        { sessionId: 'tab-status-running', title: 'Status Running', type: 'session', status: 'running' },
        { sessionId: 'tab-chat-running', title: 'Chat Running', type: 'session', status: 'idle' },
        { sessionId: 'tab-background-running', title: 'Background Running', type: 'session', status: 'idle' },
        { sessionId: 'tab-idle', title: 'Idle', type: 'session', status: 'idle' },
      ],
      activeTabId: 'tab-status-running',
    })
    useChatStore.setState({
      sessions: {
        'tab-status-running': makeChatSession('idle'),
        'tab-chat-running': makeChatSession('thinking'),
        'tab-background-running': backgroundRunningSession,
        'tab-idle': makeChatSession('idle'),
      },
      disconnectSession: vi.fn(),
    } as Partial<ReturnType<typeof useChatStore.getState>>)

    await act(async () => {
      render(<TabBar />)
    })

    expect(screen.getAllByLabelText('Session running')).toHaveLength(3)
    expect(screen.getByText('Idle').closest('[data-dragging]')?.querySelector('[aria-label="Session running"]')).toBeNull()
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
    const tabOf = (title: string) => screen.getByText(title).closest<HTMLElement>('[data-dragging]')!
    const attentionMark = (title: string) =>
      within(tabOf(title)).queryByRole('img', { name: 'Waiting for your approval' })
    const runningMark = (title: string) => within(tabOf(title)).queryByLabelText('Session running')

    async function renderStrip(
      titles: Record<string, string>,
      activeTabId: string,
      sessions: Record<string, PerSessionState> = {},
    ) {
      const { TabBar } = await import('./TabBar')
      const { useTabStore } = await import('../../stores/tabStore')
      const { useChatStore } = await import('../../stores/chatStore')

      useTabStore.setState({
        tabs: Object.entries(titles).map(([sessionId, title]) => ({
          sessionId,
          title,
          type: 'session' as const,
          status: 'idle' as const,
        })),
        activeTabId,
      })
      useChatStore.setState({
        sessions: Object.fromEntries(Object.keys(titles).map((id) => [id, sessions[id] ?? makeChatSession('idle')])),
        disconnectSession: vi.fn(),
      } as Partial<ReturnType<typeof useChatStore.getState>>)

      await act(async () => {
        render(<TabBar />)
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

    it('marks the tab while a request is open and gives it back to the running marker once answered', async () => {
      const { receive } = await renderStrip({ waiting: 'Waiting', quiet: 'Quiet' }, 'quiet')

      await receive('waiting', request('r1'))

      expect(tabOf('Waiting')).toHaveAttribute('data-attention', 'true')
      expect(attentionMark('Waiting')).toBeInTheDocument()
      // Parked on a card is "running" by chatState as well. The brand dot said
      // the session was working and could be left alone, which is exactly what
      // was not true of it, so it must not be drawn beside the mark.
      expect(runningMark('Waiting')).toBeNull()
      expect(tabOf('Quiet')).toHaveAttribute('data-attention', 'false')
      expect(attentionMark('Quiet')).toBeNull()

      await receive('waiting', resolved('r1'))

      expect(tabOf('Waiting')).toHaveAttribute('data-attention', 'false')
      expect(attentionMark('Waiting')).toBeNull()
      // An allowed tool runs on, so the tab is back to reporting that.
      expect(runningMark('Waiting')).toBeInTheDocument()
    })

    it('stays lit when a status message overwrites chatState under a card that is still open', async () => {
      const { receive, useChatStore } = await renderStrip({ waiting: 'Waiting' }, 'waiting')

      await receive('waiting', request('r1'))
      expect(useChatStore.getState().sessions.waiting?.chatState).toBe('permission_pending')
      await receive('waiting', { type: 'status', state: 'tool_executing' })

      // The precondition that makes this a regression test: a rule that read
      // chatState would see "not waiting" from here on, under a live card.
      expect(useChatStore.getState().sessions.waiting?.chatState).toBe('tool_executing')
      expect(tabOf('Waiting')).toHaveAttribute('data-attention', 'true')
      expect(attentionMark('Waiting')).toBeInTheDocument()
    })

    it('does not light for chatState alone, because nothing renders a card for it', async () => {
      await renderStrip({ empty: 'Empty' }, 'empty', { empty: makeChatSession('permission_pending') })

      expect(tabOf('Empty')).toHaveAttribute('data-attention', 'false')
      expect(attentionMark('Empty')).toBeNull()
      // It is still not idle, so the tab keeps saying it is running.
      expect(runningMark('Empty')).toBeInTheDocument()
    })

    it.each(['Bash', 'AskUserQuestion', 'ExitPlanMode'])('lights for a %s request', async (toolName) => {
      const { receive } = await renderStrip({ waiting: 'Waiting' }, 'waiting')

      await receive('waiting', request('r1', toolName))

      expect(attentionMark('Waiting')).toBeInTheDocument()
    })

    it('does not light for a Computer Use request, which has no card to answer', async () => {
      const computerUse = { requestId: 'cu-1', request: {} as never }
      await renderStrip({ cu: 'Computer use' }, 'cu', {
        cu: makeChatSession('idle', {
          pendingComputerUsePermission: computerUse,
          pendingComputerUsePermissions: { 'cu-1': computerUse },
        }),
      })

      expect(tabOf('Computer use')).toHaveAttribute('data-attention', 'false')
      expect(attentionMark('Computer use')).toBeNull()
    })

    it('outranks the running marker for a session that is also mid-turn', async () => {
      await renderStrip({ busy: 'Busy' }, 'busy', { busy: makeChatSession('thinking', waiting('r1')) })

      expect(attentionMark('Busy')).toBeInTheDocument()
      expect(runningMark('Busy')).toBeNull()
    })

    it('still shows the error dot for a failed tab that is neither running nor waiting', async () => {
      const { useTabStore } = await renderStrip({ failed: 'Failed', quiet: 'Quiet' }, 'quiet')

      act(() => {
        useTabStore.getState().updateTabStatus('failed', 'error')
      })

      // The dot is decorative and has no name, so it is found by its danger colour.
      expect(tabOf('Failed').querySelector('[class*="--color-error"]')).toBeInTheDocument()
      expect(attentionMark('Failed')).toBeNull()
      expect(runningMark('Failed')).toBeNull()
      expect(tabOf('Quiet').querySelector('[class*="--color-error"]')).toBeNull()
    })

    it('ranks waiting above an earlier failure: the failed turn is over, the card is not', async () => {
      const { receive, useTabStore } = await renderStrip({ failed: 'Failed', quiet: 'Quiet' }, 'quiet')
      act(() => {
        useTabStore.getState().updateTabStatus('failed', 'error')
      })

      await receive('failed', request('rf'))

      expect(attentionMark('Failed')).toBeInTheDocument()
      expect(tabOf('Failed').querySelector('[class*="--color-error"]')).toBeNull()

      // And it goes once the card is answered.
      await receive('failed', resolved('rf', false))
      expect(attentionMark('Failed')).toBeNull()
    })

    it('lights a background tab and the active tab alike, and only the ones that are waiting', async () => {
      const { receive } = await renderStrip({ a: 'Alpha', b: 'Bravo', c: 'Charlie' }, 'a')

      await receive('a', request('ra'))
      await receive('c', request('rc'))

      expect(tabOf('Alpha')).toHaveAttribute('data-attention', 'true')
      expect(tabOf('Bravo')).toHaveAttribute('data-attention', 'false')
      expect(tabOf('Charlie')).toHaveAttribute('data-attention', 'true')
      expect(screen.getAllByRole('img', { name: 'Waiting for your approval' })).toHaveLength(2)
    })

    it('stays lit until the last of several requests is answered', async () => {
      const { receive } = await renderStrip({ waiting: 'Waiting' }, 'waiting')

      await receive('waiting', request('r1'))
      await receive('waiting', request('r2', 'AskUserQuestion'))
      await receive('waiting', resolved('r1'))

      expect(attentionMark('Waiting')).toBeInTheDocument()

      await receive('waiting', resolved('r2'))

      expect(attentionMark('Waiting')).toBeNull()
    })

    it('swaps the mark into the same 14px slot the running dot uses, so the title does not move', async () => {
      const { receive } = await renderStrip({ waiting: 'Waiting' }, 'waiting')
      const slot = () => tabOf('Waiting').firstElementChild as HTMLElement

      await receive('waiting', { type: 'status', state: 'thinking' })
      expect(runningMark('Waiting')).toBeInTheDocument()
      expect(slot()).toHaveClass('w-[14px]', 'mr-1.5')

      await receive('waiting', request('r1'))
      expect(attentionMark('Waiting')).toBeInTheDocument()
      expect(slot()).toHaveClass('w-[14px]', 'mr-1.5')
    })

    it('does not rerender when requests change without changing which tabs are waiting', async () => {
      const { TabBar } = await import('./TabBar')
      const { useTabStore } = await import('../../stores/tabStore')
      const { useChatStore } = await import('../../stores/chatStore')
      const { useSessionStore } = await import('../../stores/sessionStore')

      useTabStore.setState({
        tabs: [{ sessionId: 'tab-1', title: 'Workspace Session', type: 'session', status: 'idle' }],
        activeTabId: 'tab-1',
      })
      useChatStore.setState({
        sessions: {
          'tab-1': makeChatSession('idle', waiting('r1')),
          ghost: makeChatSession('idle'),
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
        render(<TabBar />)
      })
      expect(openProjectMenuMock.paths[openProjectMenuMock.paths.length - 1]).toBe('/repo/worktree')

      openProjectMenuMock.paths = []
      await act(async () => {
        useChatStore.setState((state) => ({
          sessions: {
            ...state.sessions,
            // Same request, fresh objects: what a replayed permission_request does.
            'tab-1': { ...state.sessions['tab-1']!, ...waiting('r1') },
            // A session with no tab is not this strip's business.
            ghost: { ...state.sessions.ghost!, ...waiting('r2') },
          },
        }))
      })
      expect(openProjectMenuMock.paths).toEqual([])

      // Positive control: a change that does alter the set does rerender.
      await act(async () => {
        useChatStore.getState().handleServerMessage('tab-1', resolved('r1'))
      })
      expect(openProjectMenuMock.paths.length).toBeGreaterThan(0)
    })

    describe('scrolled out of view', () => {
      // The strip is 840 wide and scrolled to 300, so both chevrons are in. Each
      // case moves only the tabs' own rects against that.
      async function renderScrolledStrip() {
        const view = await renderStrip({ a: 'Alpha', b: 'Bravo', c: 'Charlie', d: 'Delta' }, 'b')
        const strip = screen.getByTestId('tab-bar-scroll-region')
        stubRect(strip, 0, 840)
        Object.defineProperty(strip, 'clientWidth', { configurable: true, get: () => 840 })
        Object.defineProperty(strip, 'scrollWidth', { configurable: true, get: () => 1600 })
        Object.defineProperty(strip, 'scrollLeft', { configurable: true, get: () => 300 })
        Object.defineProperty(strip, 'scrollBy', { configurable: true, value: vi.fn() })

        const place = (title: string, left: number, right: number) => stubRect(tabOf(title), left, right)
        place('Alpha', -400, -260)
        place('Bravo', 20, 160)
        place('Charlie', 600, 740)
        place('Delta', 900, 1040)
        const scrolled = () => act(() => { fireEvent.scroll(strip) })
        scrolled()

        return { ...view, place, scrolled }
      }
      const hintOn = (side: 'left' | 'right') => screen.queryByTestId(`tab-strip-attention-${side}`)

      it('hints on the right chevron when a waiting tab is cut off past the right edge', async () => {
        const { receive } = await renderScrolledStrip()

        await receive('d', request('rd'))

        expect(hintOn('right')).toBeInTheDocument()
        expect(hintOn('left')).not.toBeInTheDocument()
      })

      it('hints on the left chevron when a waiting tab is cut off past the left edge', async () => {
        const { receive } = await renderScrolledStrip()

        await receive('a', request('ra'))

        expect(hintOn('left')).toBeInTheDocument()
        expect(hintOn('right')).not.toBeInTheDocument()
      })

      it('hints on both sides when waiting tabs are cut off on both', async () => {
        const { receive } = await renderScrolledStrip()

        await receive('a', request('ra'))
        await receive('d', request('rd'))

        expect(hintOn('left')).toBeInTheDocument()
        expect(hintOn('right')).toBeInTheDocument()
      })

      it('describes the hint to a screen reader without renaming the chevron', async () => {
        const { receive } = await renderScrolledStrip()

        await receive('d', request('rd'))

        const chevron = screen.getByRole('button', { name: 'Scroll tabs right' })
        const describedBy = chevron.getAttribute('aria-describedby')
        expect(describedBy).toBeTruthy()
        expect(document.getElementById(describedBy!)).toHaveTextContent('Waiting for your approval')
        expect(chevron).toHaveAttribute('title', 'Waiting for your approval')
        // The other chevron has nothing to say and says nothing.
        expect(screen.getByRole('button', { name: 'Scroll tabs left' })).not.toHaveAttribute('aria-describedby')
      })

      it('lets go of the hint once the waiting tab is scrolled fully into view', async () => {
        const { receive, place, scrolled } = await renderScrolledStrip()
        await receive('d', request('rd'))
        expect(hintOn('right')).toBeInTheDocument()

        place('Delta', 500, 640)
        scrolled()

        expect(hintOn('right')).not.toBeInTheDocument()
      })

      it('says nothing for a tab that is cut off but not waiting', async () => {
        const { receive } = await renderScrolledStrip()

        // Someone else is waiting, and in view. Alpha and Delta are out of view
        // but idle: being out of view is not what the hint is about.
        await receive('c', request('rc'))

        expect(hintOn('left')).not.toBeInTheDocument()
        expect(hintOn('right')).not.toBeInTheDocument()
      })

      it('says nothing for a waiting tab that is whole, because its own mark is on screen', async () => {
        const { receive } = await renderScrolledStrip()

        await receive('b', request('rb'))
        await receive('c', request('rc'))

        expect(hintOn('left')).not.toBeInTheDocument()
        expect(hintOn('right')).not.toBeInTheDocument()
      })

      it('gives a subpixel of slack, and no more than that', async () => {
        const { receive, place, scrolled } = await renderScrolledStrip()
        await receive('d', request('rd'))

        // One pixel past the strip's 840 edge is layout rounding, not a clip.
        place('Delta', 700, 841)
        scrolled()
        expect(hintOn('right')).not.toBeInTheDocument()

        place('Delta', 700, 842)
        scrolled()
        expect(hintOn('right')).toBeInTheDocument()
      })

      it('follows a request that arrives and is answered while the strip stands still', async () => {
        const { receive } = await renderScrolledStrip()
        // No scroll and no resize from here on: only the store moves.
        expect(hintOn('right')).not.toBeInTheDocument()

        await receive('d', request('rd'))
        expect(hintOn('right')).toBeInTheDocument()

        await receive('d', resolved('rd'))
        expect(hintOn('right')).not.toBeInTheDocument()
      })
    })

    describe('jumping to the next one', () => {
      const jump = () => screen.queryByTestId('tab-attention-jump')

      it('is not offered while nothing is waiting', async () => {
        await renderStrip({ a: 'Alpha', b: 'Bravo' }, 'a')

        expect(jump()).not.toBeInTheDocument()
      })

      it('is not offered when the only waiting session is the one on screen', async () => {
        const { receive } = await renderStrip({ a: 'Alpha', b: 'Bravo' }, 'a')

        await receive('a', request('ra'))

        // Its own mark is lit, but there is nowhere else to go.
        expect(attentionMark('Alpha')).toBeInTheDocument()
        expect(jump()).not.toBeInTheDocument()
      })

      it('counts the other waiting sessions and sits with the toolbar buttons', async () => {
        const { receive } = await renderStrip({ a: 'Alpha', b: 'Bravo', c: 'Charlie', d: 'Delta' }, 'a')

        await receive('a', request('ra'))
        await receive('c', request('rc'))
        await receive('d', request('rd'))

        // Alpha is on screen, so it is not somewhere to jump to.
        const button = within(screen.getByTestId('workspace-window-header')).getByTestId('tab-attention-jump')
        expect(button).toHaveTextContent('2')
        expect(button).toHaveAccessibleName('Jump to the next waiting session (2 waiting)')
      })

      it('takes you to the next waiting tab after the active one, in strip order', async () => {
        const { receive, useTabStore } = await renderStrip({ a: 'Alpha', b: 'Bravo', c: 'Charlie', d: 'Delta' }, 'a')
        await receive('c', request('rc'))
        await receive('d', request('rd'))

        fireEvent.click(jump()!)
        expect(useTabStore.getState().activeTabId).toBe('c')

        // From Charlie the only other waiting tab is Delta, and then back again.
        fireEvent.click(jump()!)
        expect(useTabStore.getState().activeTabId).toBe('d')
        fireEvent.click(jump()!)
        expect(useTabStore.getState().activeTabId).toBe('c')
      })

      it('wraps past the end of the strip', async () => {
        const { receive, useTabStore } = await renderStrip({ a: 'Alpha', b: 'Bravo', c: 'Charlie', d: 'Delta' }, 'd')
        await receive('a', request('ra'))
        await receive('c', request('rc'))

        fireEvent.click(jump()!)

        expect(useTabStore.getState().activeTabId).toBe('a')
      })

      it('brings the tab it lands on into view', async () => {
        const { receive } = await renderStrip({ a: 'Alpha', b: 'Bravo', c: 'Charlie' }, 'a')
        await receive('c', request('rc'))
        scrollIntoViewMock.mockClear()

        fireEvent.click(jump()!)

        expect(scrollIntoViewMock).toHaveBeenCalled()
      })

      it('counts down as requests are answered and leaves with the last one', async () => {
        const { receive } = await renderStrip({ a: 'Alpha', b: 'Bravo', c: 'Charlie' }, 'a')
        await receive('b', request('rb'))
        await receive('c', request('rc'))
        expect(jump()).toHaveTextContent('2')

        await receive('b', resolved('rb'))
        expect(jump()).toHaveTextContent('1')

        await receive('c', resolved('rc'))
        expect(jump()).not.toBeInTheDocument()
      })

      it('is offered from a tab that is not a session, such as Settings', async () => {
        const { TabBar } = await import('./TabBar')
        const { useTabStore } = await import('../../stores/tabStore')
        const { useChatStore } = await import('../../stores/chatStore')
        useTabStore.setState({
          tabs: [
            { sessionId: '__settings__', title: 'Settings', type: 'settings', status: 'idle' },
            { sessionId: 'a', title: 'Alpha', type: 'session', status: 'idle' },
          ],
          activeTabId: '__settings__',
        })
        useChatStore.setState({
          sessions: { a: makeChatSession('idle', waiting('ra')) },
          disconnectSession: vi.fn(),
        } as Partial<ReturnType<typeof useChatStore.getState>>)
        await act(async () => {
          render(<TabBar />)
        })

        fireEvent.click(jump()!)

        expect(useTabStore.getState().activeTabId).toBe('a')
      })
    })
  })
})
