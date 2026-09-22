import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import '@testing-library/jest-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SubagentRunResponse } from '../api/subagents'
import { useSettingsStore } from '../stores/settingsStore'
import { setComposerText } from '../components/chat/composerTestUtils'
import type { ReconstructedWorkflowRun } from '../types/workflow'

const {
  getMemberTranscriptMock,
  getWorkbenchMock,
  sendMemberMessageMock,
  workflowSessionRunsMock,
} = vi.hoisted(() => ({
  getMemberTranscriptMock: vi.fn(),
  getWorkbenchMock: vi.fn(),
  sendMemberMessageMock: vi.fn(),
  workflowSessionRunsMock: vi.fn(),
}))
const viewportMocks = vi.hoisted(() => ({ isMobile: false }))

vi.mock('../hooks/useMobileViewport', () => ({
  useMobileViewport: () => viewportMocks.isMobile,
}))

vi.mock('../api/subagents', async (importOriginal) => ({
  // Keep the real ref helpers: they decide whether the page fetches by tool
  // call or by agent id, so stubbing them would test a fiction.
  ...(await importOriginal<typeof import('../api/subagents')>()),
  subagentsApi: {
    getRunByTool: vi.fn(),
    getRunByAgent: vi.fn(),
    sendMessage: vi.fn(),
  },
}))

vi.mock('../api/teams', () => ({
  teamsApi: {
    getMemberTranscript: getMemberTranscriptMock,
    sendMemberMessage: sendMemberMessageMock,
    getWorkbenchForSession: vi.fn(),
    getWorkbench: getWorkbenchMock,
    get: vi.fn(),
    list: vi.fn(),
    delete: vi.fn(),
  },
}))

vi.mock('../api/workflows', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/workflows')>()
  return {
    ...actual,
    workflowsApi: { ...actual.workflowsApi, sessionRuns: workflowSessionRunsMock },
  }
})

import { subagentsApi } from '../api/subagents'
import { createDefaultSessionState, useChatStore } from '../stores/chatStore'
import { useActivityPanelStore } from '../stores/activityPanelStore'
import { SUBAGENT_TAB_PREFIX, useTabStore } from '../stores/tabStore'
import { memberSessionId, useTeamStore } from '../stores/teamStore'
import { useWorkflowStore } from '../stores/workflowStore'
import { SubagentRunPage, TeamMemberRunPage } from './SubagentRunPage'

const TRANSCRIPT_TIMESTAMP = '2026-07-03T10:20:11.000Z'

function subagentRun(overrides: Partial<SubagentRunResponse> = {}): SubagentRunResponse {
  return {
    sessionId: 'session-1',
    toolUseId: 'tool-1',
    agentId: 'abc123',
    status: 'completed',
    description: 'Explore repo',
    prompt: 'Read files',
    summary: 'Found layout seam',
    messages: [
      {
        id: 'msg-user',
        type: 'user',
        content: 'Read files',
        timestamp: TRANSCRIPT_TIMESTAMP,
      },
      {
        id: 'msg-assistant',
        type: 'assistant',
        content: [{ type: 'text', text: 'Finding' }],
        timestamp: TRANSCRIPT_TIMESTAMP,
      },
    ],
    truncated: false,
    source: 'subagent-jsonl',
    ...overrides,
  }
}

function reconstructedWorkflowRun(
  overrides: Partial<ReconstructedWorkflowRun> = {},
): ReconstructedWorkflowRun {
  return {
    runId: 'wf_member-history',
    taskId: 'w-member-history',
    workflowName: 'member-audit',
    status: 'completed',
    startedAt: 100,
    updatedAt: 200,
    endedAt: 200,
    agents: [{
      agentId: 'member-workflow-worker',
      label: 'Recovered member workflow',
      phaseIndex: 1,
      phaseTitle: 'Inspect',
      agentIndex: 1,
      state: 'done',
    }],
    ...overrides,
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve
    reject = promiseReject
  })
  return { promise, reject, resolve }
}

function expectSharedSessionSurface(agentRunKind: 'subagent' | 'team-member') {
  const surface = screen.getByTestId('session-chat-surface')
  expect(surface).toHaveAttribute('data-session-chat-kind', 'agent')
  expect(surface).toHaveAttribute(
    'data-agent-run-kind',
    agentRunKind,
  )
  expect(screen.getByTestId('agent-run-conversation-column')).toHaveClass('min-w-[360px]')
  expect(screen.getByTestId('session-header').firstElementChild).toHaveClass('max-w-[900px]')
}

describe('SubagentRunPage', () => {
  beforeEach(() => {
    viewportMocks.isMobile = false
    useSettingsStore.setState({ locale: 'en' })
    useChatStore.setState({ sessions: {} })
    useTabStore.setState({ tabs: [], activeTabId: null })
    useActivityPanelStore.setState({
      openSessionId: null,
      selectedSectionBySession: {},
      dismissedBackgroundTaskKeysBySession: {},
    })
    useTeamStore.getState().clearTeam()
    useWorkflowStore.setState({ runs: {} })
    getMemberTranscriptMock.mockReset()
    getWorkbenchMock.mockReset()
    sendMemberMessageMock.mockReset()
    sendMemberMessageMock.mockResolvedValue({ ok: true })
    workflowSessionRunsMock.mockReset()
    workflowSessionRunsMock.mockResolvedValue({ runs: [] })
    localStorage.clear()
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    vi.mocked(subagentsApi.getRunByTool).mockReset()
    vi.mocked(subagentsApi.getRunByAgent).mockReset()
    vi.mocked(subagentsApi.sendMessage).mockReset()
    useTeamStore.getState().clearTeam()
  })

  it('shows incomplete evidence without hiding content and can recover on refresh', async () => {
    vi.mocked(subagentsApi.getRunByTool)
      .mockResolvedValueOnce(subagentRun({ historyComplete: false, activityComplete: false, truncated: true, status: 'unknown' }))
      .mockResolvedValue(subagentRun({ historyComplete: true }))
    render(<SubagentRunPage sourceSessionId="session-1" toolUseId="tool-1" title="Partial Agent" />)
    expect(await screen.findByText('Some history could not be read. Available content is shown; refresh to retry.')).toBeInTheDocument()
    expect(screen.getByTestId('subagent-conversation')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Refresh SubAgent run' }))
    await waitFor(() => expect(screen.queryByText('Some history could not be read. Available content is shown; refresh to retry.')).not.toBeInTheDocument())
    expect(screen.getByTestId('subagent-conversation')).toBeInTheDocument()
  })

  it('preserves displayed messages when a refresh cannot read any history', async () => {
    vi.mocked(subagentsApi.getRunByTool)
      .mockResolvedValueOnce(subagentRun({ messages: [{ id: 'retained', type: 'assistant', content: 'Previously readable answer', timestamp: TRANSCRIPT_TIMESTAMP }] }))
      .mockResolvedValue(subagentRun({ messages: [], prompt: undefined, result: undefined, summary: undefined, historyComplete: false, activityComplete: false, status: 'unknown' }))
    render(<SubagentRunPage sourceSessionId="session-1" toolUseId="tool-1" title="Partial Agent" />)
    await screen.findByText('Previously readable answer')
    fireEvent.click(screen.getByRole('button', { name: 'Refresh SubAgent run' }))
    await screen.findByText('Some history could not be read. Available content is shown; refresh to retry.')
    expect(screen.getByText('Previously readable answer')).toBeInTheDocument()
  })

  it('returns to the parent session and closes its own tab via the back button', async () => {
    vi.mocked(subagentsApi.getRunByTool).mockResolvedValue(subagentRun())
    useTabStore.getState().openTab('session-1', 'Parent session')
    const tabId = useTabStore.getState().openSubagentTab('session-1', 'tool-1', 'Kuhn')
    useActivityPanelStore.getState().open(tabId)

    render(<SubagentRunPage sourceSessionId="session-1" toolUseId="tool-1" taskId="agent-1" title="Kuhn" />)

    fireEvent.click(await screen.findByRole('button', { name: 'Back to parent session' }))

    expect(useTabStore.getState().activeTabId).toBe('session-1')
    expect(useTabStore.getState().tabs.map((tab) => tab.sessionId)).toEqual(['session-1'])
    expect(useActivityPanelStore.getState().openSessionId).toBe('session-1')
  })

  it('fetches a workflow agent by agent id, not by tool call', async () => {
    // Workflow agents are spawned by the workflow runtime, so no parent Agent
    // tool call exists to look them up by. Same page, same rendering — only
    // the lookup differs.
    vi.mocked(subagentsApi.getRunByAgent).mockResolvedValue(subagentRun())

    render(
      <SubagentRunPage
        sourceSessionId="session-1"
        toolUseId="agent:wfagent1"
        title="survey response.js"
      />,
    )

    expect(await screen.findByText('survey response.js')).toBeInTheDocument()
    expect(subagentsApi.getRunByAgent).toHaveBeenCalledWith('session-1', 'wfagent1')
    expect(subagentsApi.getRunByTool).not.toHaveBeenCalled()
    expectSharedSessionSurface('subagent')
  })

  it.each([
    ['foreground SubAgent', 'tool-direct', 'direct-agent', false],
    ['background Agent', 'tool-background', 'background-agent', false],
    ['workflow Agent', 'agent:workflow-agent', 'workflow-agent', true],
  ] as const)('renders %s text, thinking and tools before the next transcript poll', async (
    _kind,
    toolUseId,
    agentId,
    byAgentId,
  ) => {
    const response = subagentRun({
      toolUseId,
      agentId,
      status: 'running',
      messages: [],
      prompt: `Prompt for ${agentId}`,
    })
    if (byAgentId) {
      vi.mocked(subagentsApi.getRunByAgent).mockResolvedValue(response)
    } else {
      vi.mocked(subagentsApi.getRunByTool).mockResolvedValue(response)
    }

    render(
      <SubagentRunPage
        sourceSessionId="session-1"
        toolUseId={toolUseId}
        title={agentId}
      />,
    )
    const conversation = await screen.findByTestId('subagent-conversation')
    const send = (
      event: Extract<import('../types/chat').ServerMessage, { type: 'agent_run_event' }>['event'],
    ) => useChatStore.getState().handleServerMessage('session-1', {
      type: 'agent_run_event',
      runAgentId: agentId,
      streamId: `stream-${agentId}`,
      targetAgentId: agentId,
      event,
    })

    act(() => {
      send({ type: 'thinking', text: `Live thinking from ${agentId}` })
      send({ type: 'content_start', blockType: 'text' })
      send({ type: 'content_delta', text: `Live answer from ${agentId}` })
      send({
        type: 'content_start',
        blockType: 'tool_use',
        toolName: 'Read',
        toolUseId: 'live-read',
      })
      send({ type: 'content_delta', toolInput: '{"file_path":"src/live.ts"}' })
    })
    const runSessionId = `${SUBAGENT_TAB_PREFIX}session-1__${toolUseId}`
    expect(useChatStore.getState().sessions[runSessionId]?.activeToolName).toBe('Read')
    await waitFor(() => {
      expect(useChatStore.getState().sessions[runSessionId]?.streamingToolInput)
        .toContain('src/live.ts')
    })

    act(() => {
      send({
        type: 'tool_use_complete',
        toolName: 'Read',
        toolUseId: 'live-read',
        input: { file_path: 'src/live.ts' },
      })
      send({
        type: 'tool_result',
        toolUseId: 'live-read',
        content: 'live file contents',
        isError: false,
      })
    })

    expect(conversation).toHaveTextContent(`Live thinking from ${agentId}`)
    expect(conversation).toHaveTextContent(`Live answer from ${agentId}`)
    expect(conversation).toHaveTextContent('live.ts')
    expect(conversation).toHaveTextContent('live file contents')
    expect(useChatStore.getState().sessions['session-1']?.messages ?? []).toEqual([])
    expect(byAgentId ? subagentsApi.getRunByAgent : subagentsApi.getRunByTool)
      .toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('button', { name: 'Refresh SubAgent run' }))
    await waitFor(() => {
      expect(byAgentId ? subagentsApi.getRunByAgent : subagentsApi.getRunByTool)
        .toHaveBeenCalledTimes(2)
    })
    expect(conversation).toHaveTextContent(`Live answer from ${agentId}`)
    expect(conversation).toHaveTextContent('live file contents')
  })

  it('keeps a live SubAgent turn across a stale poll, then reconciles the next durable poll', async () => {
    const stalePoll = deferred<SubagentRunResponse>()
    vi.mocked(subagentsApi.getRunByTool)
      .mockResolvedValueOnce(subagentRun({
        status: 'running',
        messages: [],
      }))
      .mockReturnValueOnce(stalePoll.promise)
      .mockResolvedValueOnce(subagentRun({
        status: 'completed',
        messages: [{
          id: 'durable-live-turn',
          type: 'assistant',
          content: [{ type: 'text', text: 'Durable answer after the live turn' }],
          timestamp: TRANSCRIPT_TIMESTAMP,
        }],
      }))

    render(
      <SubagentRunPage
        sourceSessionId="session-1"
        toolUseId="tool-1"
        title="SubAgent"
      />,
    )
    const conversation = await screen.findByTestId('subagent-conversation')

    fireEvent.click(screen.getByRole('button', { name: 'Refresh SubAgent run' }))
    await waitFor(() => expect(subagentsApi.getRunByTool).toHaveBeenCalledTimes(2))

    act(() => {
      const send = (
        event: Extract<import('../types/chat').ServerMessage, { type: 'agent_run_event' }>['event'],
      ) => useChatStore.getState().handleServerMessage('session-1', {
        type: 'agent_run_event',
        runAgentId: 'abc123',
        streamId: 'stale-boundary-stream',
        targetAgentId: 'abc123',
        event,
      })
      send({ type: 'content_start', blockType: 'text' })
      send({ type: 'content_delta', text: 'Live answer that the stale poll must not erase' })
      send({ type: 'status', state: 'idle' })
    })
    expect(conversation).toHaveTextContent('Live answer that the stale poll must not erase')

    await act(async () => {
      stalePoll.resolve(subagentRun({ status: 'completed', messages: [] }))
      await stalePoll.promise
    })
    expect(conversation).toHaveTextContent('Live answer that the stale poll must not erase')
    const runSessionId = `${SUBAGENT_TAB_PREFIX}session-1__tool-1`
    expect(useChatStore.getState().sessions[runSessionId]?.agentStreamRevision)
      .toBe(2)

    fireEvent.click(screen.getByRole('button', { name: 'Refresh SubAgent run' }))
    await waitFor(() => expect(subagentsApi.getRunByTool).toHaveBeenCalledTimes(3))
    expect(await screen.findByText('Durable answer after the live turn')).toBeInTheDocument()
    expect(conversation).not.toHaveTextContent('Live answer that the stale poll must not erase')
    expect(useChatStore.getState().sessions[runSessionId]?.agentStreamRevision)
      .toBe(0)
  })

  it('uses live workflow progress instead of sealing a running agent as completed', async () => {
    vi.mocked(subagentsApi.getRunByAgent).mockResolvedValue(subagentRun({
      agentId: 'abc123',
      status: 'completed',
    }))
    const workflowRun = {
      taskId: 'workflow-task',
      sourceSessionId: 'session-1',
      sessionId: 'session-1',
      workflowName: 'review-flow',
      status: 'running' as const,
      startedAt: 1,
      updatedAt: 2,
      agentCount: 1,
      totalTokens: 0,
      toolCalls: 0,
      progress: [{
        type: 'workflow_agent' as const,
        index: 0,
        label: 'Review changes',
        state: 'progress' as const,
        agentId: 'abc123',
      }],
    }
    useWorkflowStore.setState({ runs: { 'workflow-task': workflowRun } })

    render(
      <SubagentRunPage
        sourceSessionId="session-1"
        toolUseId="agent:abc123"
        title="Workflow reviewer"
      />,
    )

    const titleRow = (await screen.findByRole('heading', { name: 'Workflow reviewer' })).parentElement!
    expect(within(titleRow).getByText('Running')).toBeInTheDocument()
    expect(
      useChatStore.getState().sessions['__subagent__session-1__agent:abc123']?.chatState,
    ).toBe('thinking')

    act(() => {
      useWorkflowStore.setState({
        runs: {
          'workflow-task': {
            ...workflowRun,
            status: 'completed',
            updatedAt: 3,
            progress: [{
              ...workflowRun.progress[0]!,
              state: 'done',
            }],
          },
        },
      })
    })

    await waitFor(() => expect(within(titleRow).getByText('Completed')).toBeInTheDocument())
    expect(
      useChatStore.getState().sessions['__subagent__session-1__agent:abc123']?.chatState,
    ).toBe('idle')
  })

  it('renders SubAgent run details', async () => {
    vi.mocked(subagentsApi.getRunByTool).mockResolvedValue(subagentRun({
      outputFile: '/tmp/result.md',
    }))

    render(<SubagentRunPage sourceSessionId="session-1" toolUseId="tool-1" taskId="agent-1" title="Kuhn" />)

    expect(await screen.findByText('Kuhn')).toBeInTheDocument()
    expect(subagentsApi.getRunByTool).toHaveBeenCalledWith('session-1', 'tool-1', 'agent-1')
    expect(screen.getByText('Agent: abc123')).toBeInTheDocument()
    expect(screen.getAllByText('Explore repo').length).toBeGreaterThan(0)
    expect(screen.getByText('Output: /tmp/result.md')).toBeInTheDocument()
    expect(screen.queryByText('Parent Agent Tool Call')).not.toBeInTheDocument()
    expect(document.body).not.toHaveTextContent('"prompt": "Read files"')
    expect(screen.queryByText(/Dispatched an agent|派遣了一个代理/)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Open run/ })).not.toBeInTheDocument()

    const transcript = screen.getByTestId('subagent-conversation')
    expect(transcript).toHaveTextContent('Read files')
    expect(transcript).toHaveTextContent('Finding')
    expect(transcript).not.toHaveTextContent('assistant_text')
    expectSharedSessionSurface('subagent')
  })

  it('shows the model the newest transcript turn answered on, not an earlier one', async () => {
    vi.mocked(subagentsApi.getRunByTool).mockResolvedValue(subagentRun({
      messages: [
        { id: 'msg-user', type: 'user', content: 'Read files', timestamp: TRANSCRIPT_TIMESTAMP },
        {
          id: 'msg-assistant-1',
          type: 'assistant',
          content: [{ type: 'text', text: 'First pass' }],
          model: 'claude-haiku-4-5',
          timestamp: TRANSCRIPT_TIMESTAMP,
        },
        {
          id: 'msg-assistant-2',
          type: 'assistant',
          content: [{ type: 'text', text: 'Second pass' }],
          model: 'claude-sonnet-5',
          timestamp: TRANSCRIPT_TIMESTAMP,
        },
      ],
    }))

    render(<SubagentRunPage sourceSessionId="session-1" toolUseId="tool-1" title="Kuhn" />)

    await screen.findByTestId('subagent-conversation')
    const header = screen.getByTestId('session-header')
    expect(within(header).getByText('claude-sonnet-5')).toBeInTheDocument()
    expect(within(header).queryByText('claude-haiku-4-5')).not.toBeInTheDocument()
  })

  it('omits the model badge while no turn has reported one', async () => {
    vi.mocked(subagentsApi.getRunByTool).mockResolvedValue(subagentRun())

    render(<SubagentRunPage sourceSessionId="session-1" toolUseId="tool-1" title="Kuhn" />)

    await screen.findByTestId('subagent-conversation')
    const header = screen.getByTestId('session-header')
    expect(within(header).queryByTitle('Model')).not.toBeInTheDocument()
    expect(within(header).getByText('Completed')).toBeInTheDocument()
  })

  it('uses compact main-session chrome and mobile transcript behavior on narrow screens', async () => {
    viewportMocks.isMobile = true
    vi.mocked(subagentsApi.getRunByTool).mockResolvedValue(subagentRun({
      messages: Array.from({ length: 4 }, (_, index) => ({
        id: `mobile-turn-${index}`,
        type: 'user' as const,
        content: `Mobile turn ${index + 1}`,
        timestamp: TRANSCRIPT_TIMESTAMP,
      })),
    }))

    render(<SubagentRunPage sourceSessionId="session-1" toolUseId="tool-1" title="Mobile child" />)

    await screen.findByTestId('subagent-conversation')
    expect(screen.getByTestId('session-header')).toHaveClass('px-4', 'py-2.5')
    expect(screen.getByTestId('agent-run-conversation-column')).toHaveClass('flex-1')
    expect(screen.queryByTestId('conversation-navigator')).not.toBeInTheDocument()
  })

  it('does not replace authoritative activity with a partial transcript tail', async () => {
    const tabId = `${SUBAGENT_TAB_PREFIX}session-1__tool-1`
    const tasks = { running: { taskId: 'running', toolUseId: 'owned-tool', status: 'running' as const, description: 'Live owned task', startedAt: 1, updatedAt: 2 } }
    useChatStore.setState({ sessions: { [tabId]: { ...createDefaultSessionState(), backgroundAgentTasks: tasks } } })
    vi.mocked(subagentsApi.getRunByTool).mockResolvedValue(subagentRun({ activityComplete: false, historyComplete: false, truncated: true }))
    render(<SubagentRunPage sourceSessionId="session-1" toolUseId="tool-1" title="SubAgent" />)
    await screen.findByTestId('subagent-conversation')
    expect(useChatStore.getState().sessions[tabId]?.backgroundAgentTasks).toBe(tasks)
  })

  it('auto-opens the owning SubAgent Task and Bash activity without another click', async () => {
    vi.mocked(subagentsApi.getRunByTool).mockResolvedValue(subagentRun({
      status: 'running',
      messages: [
        {
          id: 'child-activity-tools',
          type: 'assistant',
          parentToolUseId: 'tool-1',
          content: [
            {
              type: 'tool_use',
              id: 'child-task-create',
              name: 'TaskCreate',
              input: { subject: 'Keep the child task on the child run' },
            },
            {
              type: 'tool_use',
              id: 'child-bash',
              name: 'Bash',
              input: { command: 'bun test child', run_in_background: true },
            },
          ],
          timestamp: TRANSCRIPT_TIMESTAMP,
        },
        {
          id: 'child-task-result',
          type: 'tool_result',
          parentToolUseId: 'tool-1',
          content: [{
            type: 'tool_result',
            tool_use_id: 'child-task-create',
            content: 'Task #1 created successfully: Keep the child task on the child run',
          }],
          timestamp: TRANSCRIPT_TIMESTAMP,
        },
        {
          id: 'child-bash-result',
          type: 'tool_result',
          parentToolUseId: 'tool-1',
          content: [{
            type: 'tool_result',
            tool_use_id: 'child-bash',
            content: 'Command running in background with ID: child-bash-1',
          }],
          timestamp: TRANSCRIPT_TIMESTAMP,
        },
      ],
    }))

    render(<SubagentRunPage sourceSessionId="session-1" toolUseId="tool-1" title="Kuhn" />)

    const panel = await screen.findByTestId('session-activity-panel')
    expect(panel).toHaveAttribute('data-placement', 'rail')
    expect(within(panel).getByText('Keep the child task on the child run')).toBeInTheDocument()
    expect(within(panel).getByText('bun test child')).toBeInTheDocument()
    expect(screen.getByTestId('agent-run-conversation-column')).toHaveClass('pr-[352px]')

    fireEvent.click(screen.getByRole('button', { name: 'Close activity' }))
    await waitFor(() => expect(screen.queryByTestId('session-activity-panel')).not.toBeInTheDocument())
  })

  it('renders complete Activity projection even when conversation history is truncated', async () => {
    vi.mocked(subagentsApi.getRunByTool).mockResolvedValue(subagentRun({
      truncated: true,
      messages: [{
        id: 'visible-tail',
        type: 'assistant',
        content: [{ type: 'text', text: 'Visible tail message' }],
        timestamp: TRANSCRIPT_TIMESTAMP,
      }],
      activityMessages: [
        {
          id: 'middle-todo',
          type: 'assistant',
          content: [{
            type: 'tool_use',
            id: 'middle-todo-use',
            name: 'TodoWrite',
            input: {
              todos: [{
                content: 'Middle transcript task survives truncation',
                status: 'in_progress',
                activeForm: 'Preserving middle task',
              }],
            },
          }],
          timestamp: '2026-07-03T10:19:00.000Z',
        },
        {
          id: 'middle-shell-use',
          type: 'assistant',
          content: [{
            type: 'tool_use',
            id: 'middle-shell-tool',
            name: 'Bash',
            input: { command: 'bun run middle-check', run_in_background: true },
          }],
          timestamp: '2026-07-03T10:19:01.000Z',
        },
        {
          id: 'middle-shell-result',
          type: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: 'middle-shell-tool',
            content: 'Command running in background with ID: middle-shell-task',
          }],
          toolUseResult: { backgroundTaskId: 'middle-shell-task' },
          timestamp: '2026-07-03T10:19:02.000Z',
        },
      ],
      activityTaskNotifications: [{
        taskId: 'middle-shell-task',
        toolUseId: 'middle-shell-tool',
        status: 'completed',
        summary: 'Middle shell completed',
        timestamp: '2026-07-03T10:19:03.000Z',
      }],
    }))

    render(
      <SubagentRunPage
        sourceSessionId="session-1"
        toolUseId="tool-1"
        title="Long-running agent"
      />,
    )

    expect(await screen.findByText('Visible tail message')).toBeInTheDocument()
    const panel = await screen.findByRole('dialog', { name: 'Activity' })
    expect(within(panel).getByText('Middle transcript task survives truncation')).toBeInTheDocument()
    expect(within(panel).getByText('bun run middle-check')).toBeInTheDocument()
    expect(within(panel).getByText('Completed')).toBeInTheDocument()
  })

  it('joins live owner-scoped task events into the open SubAgent activity surface', async () => {
    vi.mocked(subagentsApi.getRunByTool).mockResolvedValue(subagentRun({
      status: 'running',
      messages: [],
    }))

    render(
      <SubagentRunPage
        sourceSessionId="session-1"
        toolUseId="tool-1"
        title="Owning agent"
      />,
    )
    await screen.findByTestId('subagent-conversation')

    act(() => {
      useChatStore.getState().handleServerMessage('session-1', {
        type: 'system_notification',
        subtype: 'task_started',
        data: {
          task_id: 'nested-live-task',
          tool_use_id: 'nested-live-tool',
          owner_agent_id: 'abc123',
          task_type: 'local_agent',
          description: 'Nested live review',
        },
      })
    })

    const runSessionId = '__subagent__session-1__tool-1'
    await waitFor(() => {
      expect(
        useChatStore.getState().sessions[runSessionId]
          ?.backgroundAgentTasks?.['nested-live-task']?.status,
      ).toBe('running')
    })
    expect(
      useChatStore.getState().sessions['session-1']
        ?.backgroundAgentTasks?.['nested-live-task'],
    ).toBeUndefined()
    const panel = await screen.findByRole('dialog', { name: 'Activity' })
    expect(within(panel).getByText('Nested live review')).toBeInTheDocument()
  })

  it('hydrates owner-scoped workflow history into the synthetic SubAgent activity surface', async () => {
    vi.mocked(subagentsApi.getRunByTool).mockResolvedValue(subagentRun({
      agentId: 'abc123',
      messages: [],
    }))
    workflowSessionRunsMock.mockResolvedValue({
      runs: [{
        runId: 'wf_owned-history',
        taskId: 'w-owned-history',
        ownerAgentId: 'abc123',
        workflowName: 'nested-audit',
        status: 'failed',
        startedAt: 100,
        updatedAt: 200,
        endedAt: 200,
        error: 'nested audit failed',
        agents: [{
          agentId: 'nested-worker',
          label: 'Nested workflow worker',
          phaseIndex: 1,
          phaseTitle: 'Inspect',
          agentIndex: 1,
          state: 'error',
          error: 'nested audit failed',
        }],
      }],
    })

    render(
      <SubagentRunPage
        sourceSessionId="session-1"
        toolUseId="tool-1"
        title="Workflow owner"
      />,
    )

    const panel = await screen.findByRole('dialog', { name: 'Activity' })
    expect(await within(panel).findByText('Nested workflow worker')).toBeInTheDocument()
    expect(workflowSessionRunsMock).toHaveBeenCalledWith('session-1')
  })

  it('does not fall back to a root workflow when the SubAgent owns none', async () => {
    vi.mocked(subagentsApi.getRunByTool).mockResolvedValue(subagentRun({
      agentId: 'abc123',
      messages: [],
    }))
    useWorkflowStore.getState().handleTaskEvent('session-1', 'task_started', {
      task_id: 'root-workflow',
      task_type: 'local_workflow',
      workflow_name: 'root-only-audit',
      workflow_run_id: 'wf_root-only',
    })
    useWorkflowStore.getState().handleTaskEvent('session-1', 'task_progress', {
      task_id: 'root-workflow',
      task_type: 'local_workflow',
      workflow_name: 'root-only-audit',
      workflow_progress: [{
        type: 'workflow_agent',
        index: 1,
        label: 'Never leak the root workflow',
        state: 'progress',
        agentId: 'root-worker',
      }],
    })

    render(
      <SubagentRunPage
        sourceSessionId="session-1"
        toolUseId="tool-1"
        title="Workflow-free owner"
      />,
    )

    await screen.findByTestId('subagent-conversation')
    await waitFor(() => expect(workflowSessionRunsMock).toHaveBeenCalledWith('session-1'))
    expect(screen.queryByText('Never leak the root workflow')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Activity' })).not.toBeInTheDocument()
  })

  it('does not let a stale transcript poll roll a resumed live task back to completed', async () => {
    const staleRun = subagentRun({
      status: 'completed',
      messages: [],
      taskNotifications: [{
        taskId: 'resumed-task',
        toolUseId: 'resumed-tool',
        status: 'completed',
        summary: 'Previous lifecycle completed',
        timestamp: '2026-07-03T10:20:00.000Z',
      }],
    })
    const staleRefresh = deferred<SubagentRunResponse>()
    vi.mocked(subagentsApi.getRunByTool)
      .mockResolvedValueOnce(staleRun)
      .mockReturnValueOnce(staleRefresh.promise)

    render(
      <SubagentRunPage
        sourceSessionId="session-1"
        toolUseId="tool-1"
        title="Resumable agent"
      />,
    )
    await screen.findByTestId('subagent-conversation')
    const runSessionId = '__subagent__session-1__tool-1'
    await waitFor(() => {
      expect(
        useChatStore.getState().sessions[runSessionId]
          ?.backgroundAgentTasks?.['resumed-task']?.status,
      ).toBe('completed')
    })

    fireEvent.click(screen.getByRole('button', { name: 'Refresh SubAgent run' }))
    act(() => {
      useChatStore.getState().handleServerMessage('session-1', {
        type: 'system_notification',
        subtype: 'task_started',
        data: {
          task_id: 'resumed-task',
          tool_use_id: 'resumed-tool',
          owner_agent_id: 'abc123',
          task_type: 'local_agent',
          description: 'Resumed lifecycle',
        },
      })
    })
    expect(
      useChatStore.getState().sessions[runSessionId]
        ?.backgroundAgentTasks?.['resumed-task']?.status,
    ).toBe('running')
    expect(
      useChatStore.getState().sessions[runSessionId]
        ?.agentTaskNotifications?.['resumed-tool'],
    ).toBeUndefined()

    await act(async () => {
      staleRefresh.resolve(staleRun)
      await staleRefresh.promise
    })

    await waitFor(() => {
      expect(
        useChatStore.getState().sessions[runSessionId]
          ?.backgroundAgentTasks?.['resumed-task']?.status,
      ).toBe('running')
    })
    expect(
      useChatStore.getState().sessions[runSessionId]
        ?.agentTaskNotifications?.['resumed-tool'],
    ).toBeUndefined()
  })

  it('applies hidden terminal notifications to the SubAgent background activity', async () => {
    vi.mocked(subagentsApi.getRunByTool).mockResolvedValue(subagentRun({
      messages: [
        {
          id: 'child-shell-use',
          type: 'assistant',
          content: [{
            type: 'tool_use',
            id: 'child-shell-tool',
            name: 'Bash',
            input: { command: 'bun run child-check', run_in_background: true },
          }],
          timestamp: TRANSCRIPT_TIMESTAMP,
        },
        {
          id: 'child-shell-result',
          type: 'tool_result',
          content: [{
            type: 'tool_result',
            tool_use_id: 'child-shell-tool',
            content: 'Command running in background with ID: child-shell-task',
          }],
          timestamp: TRANSCRIPT_TIMESTAMP,
        },
      ],
      taskNotifications: [{
        taskId: 'child-shell-task',
        toolUseId: 'child-shell-tool',
        status: 'stopped',
        summary: 'Child check was stopped',
        timestamp: '2026-07-03T10:20:12.000Z',
      }],
    }))

    render(<SubagentRunPage sourceSessionId="session-1" toolUseId="tool-1" title="Kuhn" />)

    const panel = await screen.findByTestId('session-activity-panel')
    await waitFor(() => {
      expect(
        useChatStore.getState().sessions['__subagent__session-1__tool-1']
          ?.backgroundAgentTasks?.['child-shell-task']?.status,
      ).toBe('stopped')
    })
    expect(within(panel).getByText('Stopped')).toBeInTheDocument()
  })

  it.each([
    {
      currentRef: 'tool-1',
      currentAgentId: 'abc123',
      childToolUseId: 'Agent:0',
      expectedRef: 'tool-1/abc123/Agent:0',
    },
    {
      currentRef: 'tool-1/abc123/Agent:0',
      currentAgentId: 'nested-agent',
      childToolUseId: 'call.0',
      expectedRef: 'tool-1/abc123/Agent:0/nested-agent/call.0',
    },
    {
      currentRef: 'tool-1',
      currentAgentId: 'newest-fragment',
      childToolUseId: 'older-fragment/Agent:0',
      expectedRef: 'tool-1/older-fragment/Agent:0',
    },
  ])('opens nested Agent rows with their canonical run path ($expectedRef)', async ({
    currentRef,
    currentAgentId,
    childToolUseId,
    expectedRef,
  }) => {
    vi.mocked(subagentsApi.getRunByTool).mockResolvedValue(subagentRun({
      toolUseId: currentRef,
      agentId: currentAgentId,
      messages: [{
        id: 'nested-agent-use',
        type: 'assistant',
        content: [{
          type: 'tool_use',
          id: childToolUseId,
          name: 'Agent',
          input: { description: 'Nested review' },
        }],
        timestamp: TRANSCRIPT_TIMESTAMP,
      }],
    }))

    const parent = render(
      <SubagentRunPage
        sourceSessionId="session-1"
        toolUseId={currentRef}
        title="Current agent"
      />,
    )

    const conversation = await screen.findByTestId('subagent-conversation')
    fireEvent.click(within(conversation).getByRole('button', { name: /dispatched an agent/i }))
    fireEvent.click(within(conversation).getByRole('button', { name: /Open run Nested review/ }))

    expect(
      useTabStore.getState().tabs.find((tab) => tab.subagentToolUseId === expectedRef),
    ).toMatchObject({
      sourceSessionId: 'session-1',
      subagentToolUseId: expectedRef,
      returnTabId: `__subagent__session-1__${currentRef}`,
    })

    parent.unmount()
    vi.mocked(subagentsApi.getRunByTool).mockResolvedValue(subagentRun({
      toolUseId: expectedRef,
      agentId: 'nested-target',
    }))
    render(
      <SubagentRunPage
        sourceSessionId="session-1"
        toolUseId={expectedRef}
        title="Nested review"
      />,
    )

    await screen.findByTestId('subagent-conversation')
    expectSharedSessionSurface('subagent')
  })

  it('fetches a nested workflow Agent by canonical tool path, not by agent id', async () => {
    vi.mocked(subagentsApi.getRunByAgent).mockResolvedValue(subagentRun({
      agentId: 'wf123',
      messages: [{
        id: 'workflow-nested-agent',
        type: 'assistant',
        content: [{
          type: 'tool_use',
          id: 'Agent:0',
          name: 'Agent',
          input: { description: 'Workflow nested review' },
        }],
        timestamp: TRANSCRIPT_TIMESTAMP,
      }],
    }))
    const outer = render(
      <SubagentRunPage
        sourceSessionId="session-1"
        toolUseId="agent:wf123"
        title="Workflow agent"
      />,
    )
    const conversation = await screen.findByTestId('subagent-conversation')
    fireEvent.click(within(conversation).getByRole('button', { name: /dispatched an agent/i }))
    fireEvent.click(within(conversation).getByRole('button', { name: /Open run Workflow nested review/ }))
    outer.unmount()

    vi.mocked(subagentsApi.getRunByTool).mockResolvedValue(subagentRun({
      toolUseId: 'agent:wf123/wf123/Agent:0',
      agentId: 'nested-workflow-agent',
    }))
    render(
      <SubagentRunPage
        sourceSessionId="session-1"
        toolUseId="agent:wf123/wf123/Agent:0"
        title="Workflow nested review"
      />,
    )

    await waitFor(() => {
      expect(subagentsApi.getRunByTool).toHaveBeenCalledWith(
        'session-1',
        'agent:wf123/wf123/Agent:0',
        undefined,
      )
    })
    expect(subagentsApi.getRunByAgent).toHaveBeenCalledTimes(1)
    expectSharedSessionSurface('subagent')
  })

  it('projects a parent-linked TodoWrite into its owning SubAgent panel', async () => {
    vi.mocked(subagentsApi.getRunByTool).mockResolvedValue(subagentRun({
      messages: [{
        id: 'child-todo-tools',
        type: 'assistant',
        parentToolUseId: 'tool-1',
        content: [{
          type: 'tool_use',
          id: 'child-todo-write',
          name: 'TodoWrite',
          input: {
            todos: [{
              content: 'Verify the child-owned activity seam',
              activeForm: 'Verifying child activity',
              status: 'in_progress',
            }],
          },
        }],
        timestamp: TRANSCRIPT_TIMESTAMP,
      }],
    }))

    render(<SubagentRunPage sourceSessionId="session-1" toolUseId="tool-1" title="Kuhn" />)

    const panel = await screen.findByTestId('session-activity-panel')
    expect(within(panel).getByText('Verify the child-owned activity seam')).toBeInTheDocument()
  })

  it('uses the Team member task projection when a teammate opens through the main Agent row', async () => {
    vi.mocked(subagentsApi.getRunByTool).mockResolvedValue(subagentRun({
      agentId: 'reviewer@review-team',
      messages: [{
        id: 'teammate-task-tools',
        type: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'shared-task-create',
            name: 'TaskCreate',
            input: { subject: 'Do not show the whole shared list' },
          },
          {
            type: 'tool_use',
            id: 'teammate-todo',
            name: 'TodoWrite',
            input: {
              todos: [{ content: 'Keep the teammate checklist', status: 'in_progress' }],
            },
          },
        ],
        timestamp: TRANSCRIPT_TIMESTAMP,
      }],
    }))
    const sourceSession = createDefaultSessionState()
    sourceSession.messages = [{
      id: 'team-agent-launch',
      type: 'tool_use',
      toolName: 'Agent',
      toolUseId: 'tool-1',
      input: {
        name: 'reviewer',
        team_name: 'review-team',
        description: 'Review the auth flow',
      },
      timestamp: 1,
    }]
    useChatStore.setState({ sessions: { 'session-1': sourceSession } })
    useTeamStore.setState({
      workbenchesBySession: {
        'session-1': {
          teamName: 'review-team',
          loading: false,
          error: null,
          snapshots: [{
            version: 'review-team-v1',
            generatedAt: TRANSCRIPT_TIMESTAMP,
            team: {
              name: 'review-team',
              leadSessionId: 'session-1',
              members: [{
                agentId: 'reviewer@review-team',
                name: 'reviewer',
                role: 'security-reviewer',
                status: 'running',
              }],
            },
            tasks: [{
              id: '1',
              subject: 'Show only the reviewer owned task',
              description: 'Owned projection',
              owner: 'reviewer',
              status: 'in_progress',
              blocks: [],
              blockedBy: [],
              taskListId: 'review-team',
            }],
            messages: [],
          }],
        },
      },
    })

    render(<SubagentRunPage sourceSessionId="session-1" toolUseId="tool-1" title="reviewer" />)

    const panel = await screen.findByTestId('session-activity-panel')
    expect(within(panel).getByText('Show only the reviewer owned task')).toBeInTheDocument()
    expect(within(panel).getByText('Keep the teammate checklist')).toBeInTheDocument()
    expect(within(panel).queryByText('Do not show the whole shared list')).not.toBeInTheDocument()
  })

  it('routes a scoped nested teammate Agent into its shared run UI', async () => {
    vi.mocked(subagentsApi.getRunByTool).mockResolvedValue(subagentRun({
      agentId: 'nested-team-agent',
      status: 'running',
      messages: [],
    }))
    const createdAt = Date.parse('2026-08-09T00:00:00.000Z')
    useChatStore.setState({ sessions: { 'session-1': createDefaultSessionState() } })
    useTeamStore.setState({
      workbenchesBySession: {
        'session-1': {
          teamName: 'review-team',
          loading: false,
          error: null,
          snapshots: [{
            version: 'review-team-v1',
            generatedAt: TRANSCRIPT_TIMESTAMP,
            team: {
              name: 'review-team',
              leadSessionId: 'session-1',
              createdAt: String(createdAt),
              members: [{
                agentId: 'reviewer@review-team',
                name: 'reviewer',
                role: 'security-reviewer',
                status: 'running',
              }],
            },
            tasks: [],
            messages: [],
          }],
        },
      },
    })

    render(<SubagentRunPage sourceSessionId="session-1" toolUseId="nested-Agent:0" title="Nested review" />)
    const conversation = await screen.findByTestId('subagent-conversation')
    act(() => {
      useChatStore.getState().handleServerMessage('session-1', {
        type: 'agent_run_event',
        runAgentId: 'nested-team-agent',
        streamId: 'nested-team-stream',
        targetAgentId: 'nested-team-agent',
        targetAgentScopeId: JSON.stringify(['review-team', 'session-1', createdAt]),
        event: { type: 'content_delta', text: 'Scoped nested answer' },
      })
    })

    await waitFor(() => expect(conversation).toHaveTextContent('Scoped nested answer'))
    expect(useChatStore.getState().sessions['session-1']?.streamingText).toBe('')
  })

  it('isolates a teammate shared task list before its workbench snapshot arrives', async () => {
    vi.mocked(subagentsApi.getRunByTool).mockResolvedValue(subagentRun({
      agentId: 'reviewer@review-team',
      messages: [{
        id: 'early-teammate-task-tools',
        type: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'early-shared-task-create',
            name: 'TaskCreate',
            input: { subject: 'Never leak the early shared task' },
          },
          {
            type: 'tool_use',
            id: 'early-teammate-todo',
            name: 'TodoWrite',
            input: {
              todos: [{ content: 'Keep the early teammate checklist', status: 'in_progress' }],
            },
          },
        ],
        timestamp: TRANSCRIPT_TIMESTAMP,
      }],
    }))
    const sourceSession = createDefaultSessionState()
    sourceSession.messages = [{
      id: 'early-team-agent-launch',
      type: 'tool_use',
      toolName: 'Agent',
      toolUseId: 'tool-1',
      input: {
        name: 'reviewer',
        team_name: 'review-team',
        description: 'Review before discovery completes',
      },
      timestamp: 1,
    }]
    useChatStore.setState({ sessions: { 'session-1': sourceSession } })

    render(<SubagentRunPage sourceSessionId="session-1" toolUseId="tool-1" title="reviewer" />)

    const panel = await screen.findByTestId('session-activity-panel')
    expect(within(panel).getByText('Keep the early teammate checklist')).toBeInTheDocument()
    expect(within(panel).queryByText('Never leak the early shared task')).not.toBeInTheDocument()
  })

  it('renders and streams an Agent Teams member in the shared run desktop', async () => {
    const member = {
      agentId: 'reviewer@review-team',
      name: 'reviewer',
      role: 'security-reviewer',
      status: 'running' as const,
      currentTask: 'Review auth changes',
    }
    const peer = {
      agentId: 'api-reviewer@review-team',
      name: 'api-reviewer',
      role: 'api-reviewer',
      status: 'running' as const,
    }
    const snapshot = {
      version: 'v1',
      generatedAt: '2026-08-09T00:00:00.000Z',
      team: {
        name: 'review-team',
        incarnationId: 'review-team:2026-08-09:lead-session',
        leadAgentId: 'lead@review-team',
        leadSessionId: 'lead-session',
        createdAt: String(Date.parse('2026-08-09T00:00:00.000Z')),
        members: [member, peer],
      },
      tasks: [],
      messages: [],
    }
    getMemberTranscriptMock.mockResolvedValue({
      ownerAgentIds: ['reviewer-fragment-uuid'],
      messages: [
        {
          id: 'lead-message',
          type: 'user',
          content: '<teammate-message teammate_id="team-lead">**Prioritize** the auth flow.\n\n- Verify sessions</teammate-message>',
          timestamp: TRANSCRIPT_TIMESTAMP,
        },
        {
          id: 'peer-message',
          type: 'user',
          content: '<teammate-message teammate_id="api-reviewer">Check `src/auth.ts` before merge.</teammate-message>',
          timestamp: TRANSCRIPT_TIMESTAMP,
        },
        {
          id: 'member-message',
          type: 'assistant',
          content: [{ type: 'text', text: 'Auth review is in progress.' }],
          timestamp: TRANSCRIPT_TIMESTAMP,
        },
      ],
    })
    workflowSessionRunsMock.mockResolvedValue({
      runs: [reconstructedWorkflowRun({
        ownerAgentId: 'reviewer-fragment-uuid',
        agents: [{
          agentId: 'in-process-workflow-worker',
          label: 'In-process member workflow',
          phaseIndex: 1,
          phaseTitle: 'Inspect',
          agentIndex: 1,
          state: 'done',
        }],
      })],
    })
    useTeamStore.setState({
      activeTeam: snapshot.team,
      workbenchesBySession: {
        'lead-session': {
          teamName: 'review-team',
          snapshots: [snapshot],
          loading: false,
          error: null,
        },
      },
    })
    useTabStore.getState().openTab('lead-session', 'Lead session')
    const workbenchTabId = useTabStore.getState().openTeamWorkbenchTab('lead-session', 'review-team')
    useTeamStore.getState().openMemberSession(member, snapshot.team, snapshot)
    useTeamStore.setState({
      activeTeam: {
        name: 'other-team',
        leadSessionId: 'other-lead-session',
        members: [{ agentId: 'other@other-team', role: 'other', status: 'running' }],
      },
    })
    const tabId = memberSessionId(member.agentId, snapshot.team.incarnationId)

    render(
      <TeamMemberRunPage
        tabId={tabId}
        leadSessionId="lead-session"
        agentId={member.agentId}
        title="reviewer"
      />,
    )

    expect(await screen.findByTestId('team-member-conversation')).toHaveTextContent('Auth review is in progress.')
    const transcript = screen.getByTestId('team-member-conversation')
    act(() => {
      const targetAgentScopeId = JSON.stringify([
        snapshot.team.name,
        snapshot.team.leadSessionId,
        Number(snapshot.team.createdAt),
      ])
      const send = (
        event: Extract<import('../types/chat').ServerMessage, { type: 'agent_run_event' }>['event'],
      ) => useChatStore.getState().handleServerMessage('lead-session', {
        type: 'agent_run_event',
        runAgentId: 'reviewer-fragment-uuid',
        streamId: 'teammate-live-stream',
        targetAgentId: member.agentId,
        targetAgentScopeId,
        event,
      })
      send({ type: 'thinking', text: 'Live teammate thinking' })
      send({ type: 'content_start', blockType: 'text' })
      send({ type: 'content_delta', text: 'Live teammate answer' })
      send({
        type: 'content_start',
        blockType: 'tool_use',
        toolName: 'Read',
        toolUseId: 'member-live-read',
      })
      send({
        type: 'tool_use_complete',
        toolName: 'Read',
        toolUseId: 'member-live-read',
        input: { file_path: 'src/member-live.ts' },
      })
      send({
        type: 'tool_result',
        toolUseId: 'member-live-read',
        content: 'member live file contents',
        isError: false,
      })
    })
    expect(transcript).toHaveTextContent('Live teammate thinking')
    expect(transcript).toHaveTextContent('Live teammate answer')
    expect(transcript).toHaveTextContent('member-live.ts')
    expect(transcript).toHaveTextContent('member live file contents')
    expect(useChatStore.getState().sessions['lead-session']?.messages ?? []).toEqual([])

    act(() => {
      useChatStore.getState().handleServerMessage('lead-session', {
        type: 'agent_run_event',
        runAgentId: 'reviewer-fragment-uuid',
        streamId: 'teammate-live-stream',
        targetAgentId: member.agentId,
        targetAgentScopeId: JSON.stringify([
          snapshot.team.name,
          snapshot.team.leadSessionId,
          Number(snapshot.team.createdAt),
        ]),
        event: { type: 'status', state: 'idle' },
      })
    })
    expect(transcript).toHaveTextContent('Live teammate answer')
    expect(transcript).toHaveTextContent('member live file contents')
    expect(transcript).toHaveTextContent('Prioritize the auth flow.')
    expect(transcript).toHaveTextContent('Check src/auth.ts before merge.')
    // Drive the real transcript adapter: both lead-to-member and member-to-member
    // communication must arrive at the shared message renderer as Markdown.
    expect(screen.getByText('Prioritize').tagName).toBe('STRONG')
    expect(screen.getByText('src/auth.ts').tagName).toBe('CODE')
    expect(transcript.querySelectorAll('[data-message-body="teammate"]')).toHaveLength(2)
    const leadShell = transcript.querySelector<HTMLElement>(
      '[data-message-shell="teammate"][data-teammate-from="team-lead"]',
    )
    const peerShell = transcript.querySelector<HTMLElement>(
      '[data-message-shell="teammate"][data-teammate-from="api-reviewer"]',
    )
    expect(leadShell).toBeTruthy()
    expect(peerShell).toBeTruthy()
    expect(leadShell?.querySelector('[data-testid="teammate-message-avatar"]'))
      .toHaveAttribute('data-avatar-key', 'team-lead')
    expectSharedSessionSurface('team-member')
    expect(screen.getByText('Review auth changes')).toBeInTheDocument()
    expect(screen.queryByTestId('team-member-readonly-note')).not.toBeInTheDocument()
    const activityPanel = await screen.findByRole('dialog', { name: 'Activity' })
    expect(await within(activityPanel).findByText('In-process member workflow')).toBeInTheDocument()
    expect(workflowSessionRunsMock).toHaveBeenCalledWith('lead-session')

    setComposerText('Please check the regression path.', 33)
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' })
    await waitFor(() => {
      expect(sendMemberMessageMock).toHaveBeenCalledWith(
        'review-team',
        'reviewer@review-team',
        'Please check the regression path.',
      )
    })

    useActivityPanelStore.getState().open(tabId)
    fireEvent.click(screen.getByRole('button', { name: 'Back to team overview' }))
    expect(useTabStore.getState().activeTabId).toBe(workbenchTabId)
    expect(useTabStore.getState().tabs.some((tab) => tab.sessionId === tabId)).toBe(false)
    expect(useActivityPanelStore.getState().openSessionId).toBe('lead-session')
  })

  it('opens a nested Agent from an independent teammate session and returns to the member', async () => {
    const member = {
      agentId: 'reviewer@review-team',
      name: 'reviewer',
      role: 'security-reviewer',
      status: 'running' as const,
      sessionId: 'reviewer-session',
    }
    const team = {
      name: 'review-team',
      leadSessionId: 'lead-session',
      members: [member],
    }
    getMemberTranscriptMock.mockResolvedValue({
      messages: [{
        id: 'member-nested-agent',
        type: 'assistant',
        content: [{
          type: 'tool_use',
          id: 'member-Agent:0',
          name: 'Agent',
          input: { description: 'Member nested review' },
        }],
        timestamp: TRANSCRIPT_TIMESTAMP,
      }],
    })
    workflowSessionRunsMock.mockResolvedValue({
      runs: [reconstructedWorkflowRun({
        agents: [{
          agentId: 'independent-workflow-worker',
          label: 'Independent member workflow',
          phaseIndex: 1,
          phaseTitle: 'Inspect',
          agentIndex: 1,
          state: 'done',
        }],
      })],
    })
    useTeamStore.setState({ activeTeam: team })
    useTabStore.getState().openTab('lead-session', 'Lead session')
    useTeamStore.getState().openMemberSession(member, team)
    const memberTabId = 'team-member:reviewer@review-team'

    render(
      <TeamMemberRunPage
        tabId={memberTabId}
        leadSessionId="lead-session"
        agentId={member.agentId}
        title="reviewer"
      />,
    )
    const conversation = await screen.findByTestId('team-member-conversation')
    const activityPanel = await screen.findByRole('dialog', { name: 'Activity' })
    expect(await within(activityPanel).findByText('Independent member workflow')).toBeInTheDocument()
    expect(workflowSessionRunsMock).toHaveBeenCalledWith('reviewer-session')
    fireEvent.click(within(conversation).getByRole('button', { name: /dispatched an agent/i }))
    fireEvent.click(within(conversation).getByRole('button', { name: /Open run Member nested review/ }))

    expect(
      useTabStore.getState().tabs.find((tab) => tab.subagentToolUseId === 'member-Agent:0'),
    ).toMatchObject({
      sourceSessionId: 'reviewer-session',
      subagentToolUseId: 'member-Agent:0',
      returnTabId: memberTabId,
    })
  })

  it('projects only a teammate owned task plus its Todo and Bash activity into the shared panel', async () => {
    const member = {
      agentId: 'reviewer@review-team',
      name: 'reviewer',
      role: 'security-reviewer',
      status: 'running' as const,
    }
    const team = {
      name: 'review-team',
      leadAgentId: 'lead@review-team',
      leadSessionId: 'lead-session',
      members: [member],
    }
    const snapshot = {
      version: 'v1',
      generatedAt: '2026-08-09T00:00:00.000Z',
      team,
      tasks: [
        {
          id: '1',
          subject: 'Audit the authentication boundary',
          description: 'Owned by the reviewer',
          owner: 'reviewer',
          status: 'in_progress' as const,
          blocks: [],
          blockedBy: [],
          taskListId: 'review-team',
        },
        {
          id: '2',
          subject: 'Implement the unrelated UI',
          description: 'Owned by another teammate',
          owner: 'ui-designer',
          status: 'pending' as const,
          blocks: [],
          blockedBy: [],
          taskListId: 'review-team',
        },
      ],
      messages: [],
    }
    getMemberTranscriptMock.mockResolvedValue({
      messages: [
        {
          id: 'member-activity-tools',
          type: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'member-shared-task-create',
              name: 'TaskCreate',
              input: { subject: 'Do not project the shared transcript task' },
            },
            {
              type: 'tool_use',
              id: 'member-todo-write',
              name: 'TodoWrite',
              input: {
                todos: [{
                  content: 'Exercise the member-only checklist',
                  activeForm: 'Exercising the member checklist',
                  status: 'pending',
                }],
              },
            },
            {
              type: 'tool_use',
              id: 'member-bash',
              name: 'Bash',
              input: { command: 'bun test auth', run_in_background: true },
            },
          ],
          timestamp: TRANSCRIPT_TIMESTAMP,
        },
        {
          id: 'member-bash-result',
          type: 'tool_result',
          content: [{
            type: 'tool_result',
            tool_use_id: 'member-bash',
            content: 'Command running in background with ID: bash-review-1',
          }],
          timestamp: TRANSCRIPT_TIMESTAMP,
        },
      ],
    })
    useTeamStore.setState({
      activeTeam: team,
      workbenchesBySession: {
        'lead-session': {
          teamName: 'review-team',
          snapshots: [snapshot],
          loading: false,
          error: null,
        },
      },
    })
    useActivityPanelStore.getState().open('lead-session')
    useTeamStore.getState().openMemberSession(member, team)
    expect(useActivityPanelStore.getState().openSessionId).toBe(
      'team-member:reviewer@review-team',
    )

    render(
      <TeamMemberRunPage
        tabId="team-member:reviewer@review-team"
        leadSessionId="lead-session"
        agentId={member.agentId}
        title="reviewer"
      />,
    )

    const panel = await screen.findByTestId('session-activity-panel')
    expect(within(panel).getByText('Audit the authentication boundary')).toBeInTheDocument()
    expect(within(panel).getByText('Exercise the member-only checklist')).toBeInTheDocument()
    expect(within(panel).getByText('bun test auth')).toBeInTheDocument()
    expect(within(panel).queryByText('Implement the unrelated UI')).not.toBeInTheDocument()
    expect(within(panel).queryByText('Do not project the shared transcript task')).not.toBeInTheDocument()
  })

  it('shows transcript loading immediately instead of an empty member conversation', async () => {
    const transcript = deferred<Awaited<ReturnType<typeof getMemberTranscriptMock>>>()
    const member = {
      agentId: 'slow-reviewer@review-team',
      name: 'slow-reviewer',
      role: 'security-reviewer',
      status: 'running' as const,
    }
    const team = {
      name: 'review-team',
      leadSessionId: 'lead-session',
      members: [member],
    }
    getMemberTranscriptMock.mockReturnValue(transcript.promise)
    useTeamStore.setState({ activeTeam: team })
    useTeamStore.getState().openMemberSession(member, team)

    render(
      <TeamMemberRunPage
        tabId="team-member:slow-reviewer@review-team"
        leadSessionId="lead-session"
        agentId={member.agentId}
        title="slow-reviewer"
      />,
    )

    expect(screen.getByRole('status')).toHaveTextContent('Loading member transcript...')
    expect(screen.queryByTestId('team-member-conversation')).not.toBeInTheDocument()

    transcript.resolve({ messages: [] })
    expect(await screen.findByTestId('team-member-conversation')).toBeInTheDocument()
    expect(getMemberTranscriptMock).toHaveBeenCalledTimes(1)
  })

  it('settles a completed member task without losing direct-message activity', async () => {
    const member = {
      agentId: 'ui-designer@review-team',
      name: 'ui-designer',
      role: 'ui-designer',
      status: 'running' as const,
    }
    // The member's own turn marker says whether it is producing output. Its
    // task status cannot: a teammate marks a task started and can then end its
    // turn, and an umbrella task stays open across every turn beneath it.
    const workbench = (
      version: string,
      taskStatus: 'in_progress' | 'completed',
      owner: string | null = 'ui-designer',
      activity: 'active' | 'idle' = taskStatus === 'in_progress' ? 'active' : 'idle',
    ) => ({
      version,
      generatedAt: `2026-08-09T00:00:0${version.slice(-1)}.000Z`,
      team: {
        name: 'review-team',
        leadSessionId: 'lead-session',
        members: [{ ...member, activity }],
      },
      tasks: [{
        id: 'design-system',
        subject: 'Build the design system',
        description: 'Create the shared primitives',
        ...(owner ? { owner } : {}),
        status: taskStatus,
        blocks: [],
        blockedBy: [],
        taskListId: 'review-team',
      }],
      messages: [],
    })
    const directReply = deferred<{ ok: true }>()
    const directMessageTimestamp = new Date().toISOString()
    const initialTranscriptMessage = {
      id: 'initial-progress',
      type: 'assistant',
      content: [
        { type: 'thinking', thinking: 'Check the token architecture before delivery.' },
        { type: 'text', text: 'The design system is in progress.' },
      ],
      timestamp: TRANSCRIPT_TIMESTAMP,
    }

    getWorkbenchMock
      .mockResolvedValueOnce(workbench('v1', 'in_progress'))
      .mockResolvedValueOnce(workbench('v2', 'completed'))
      .mockResolvedValueOnce(workbench('v3', 'in_progress', null, 'idle'))
    getMemberTranscriptMock
      .mockResolvedValueOnce({
        messages: [initialTranscriptMessage],
        signature: 'signature-1',
        cursor: 'cursor-1',
        afterOrdinal: 0,
      })
      .mockResolvedValueOnce({
        messages: [
          initialTranscriptMessage,
          {
            id: 'full-reset-marker',
            type: 'assistant',
            content: [{ type: 'text', text: 'Historical reset marker.' }],
            timestamp: TRANSCRIPT_TIMESTAMP,
          },
        ],
        reset: true,
        signature: 'signature-2',
        cursor: 'cursor-2',
        afterOrdinal: 0,
      })
      .mockResolvedValueOnce({
        messages: [{
          id: 'direct-message-echo',
          type: 'user',
          content: 'Please verify the final tokens.',
          timestamp: directMessageTimestamp,
        }],
        signature: 'signature-3',
        cursor: 'cursor-3',
        afterOrdinal: 1,
      })
      .mockResolvedValueOnce({
        messages: [{
          id: 'direct-message-reply',
          type: 'assistant',
          content: [{ type: 'text', text: 'The final tokens are verified.' }],
          timestamp: directMessageTimestamp,
        }],
        signature: 'signature-4',
        cursor: 'cursor-4',
        afterOrdinal: 2,
      })
    sendMemberMessageMock.mockReturnValue(directReply.promise)

    await act(async () => {
      await useTeamStore.getState().fetchWorkbench('review-team')
    })
    expect(
      useTeamStore.getState().workbenchesBySession['lead-session']?.snapshots.at(-1)
        ?.tasks[0]?.status,
    ).toBe('in_progress')
    useTeamStore.getState().openMemberSession(member)

    render(
      <TeamMemberRunPage
        tabId="team-member:ui-designer@review-team"
        leadSessionId="lead-session"
        agentId={member.agentId}
        title="ui-designer"
      />,
    )

    expect(await screen.findByTestId('turn-status-indicator')).toHaveTextContent('Thinking...')
    useTeamStore.getState().stopMemberPolling()

    await act(async () => {
      await useTeamStore.getState().fetchWorkbench('review-team')
    })
    expect(
      useTeamStore.getState().workbenchesBySession['lead-session']?.snapshots.at(-1)
        ?.tasks[0]?.status,
    ).toBe('completed')
    await waitFor(() => {
      expect(screen.queryByTestId('turn-status-indicator')).not.toBeInTheDocument()
    })
    expect(screen.getByRole('button', { name: /Thought/ })).toBeInTheDocument()

    await act(async () => {
      await useTeamStore.getState().fetchWorkbench('review-team')
    })
    expect(
      useTeamStore.getState().workbenchesBySession['lead-session']?.snapshots.at(-1)
        ?.tasks[0]?.owner,
    ).toBeUndefined()
    expect(screen.queryByTestId('turn-status-indicator')).not.toBeInTheDocument()

    setComposerText('Please verify the final tokens.', 31)
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' })
    await waitFor(() => {
      expect(sendMemberMessageMock).toHaveBeenCalledWith(
        'review-team',
        member.agentId,
        'Please verify the final tokens.',
      )
    })
    const memberSessionId = 'team-member:ui-designer@review-team'
    await waitFor(() => {
      const matchingPrompts = useChatStore.getState().sessions[memberSessionId]?.messages
        .filter((message) => message.type === 'user_text' && message.content === 'Please verify the final tokens.')
      expect(matchingPrompts).toHaveLength(1)
      expect(matchingPrompts?.[0]).toMatchObject({ pending: true })
    })
    expect(screen.getByText('Please verify the final tokens.')).toBeInTheDocument()
    expect(screen.getByTestId('turn-status-indicator')).toHaveTextContent('Thinking...')

    await act(async () => {
      directReply.resolve({ ok: true })
      await directReply.promise
    })
    await waitFor(() => expect(getMemberTranscriptMock).toHaveBeenCalledTimes(2))
    useTeamStore.getState().stopMemberPolling()
    expect(await screen.findByText('Historical reset marker.')).toBeInTheDocument()
    expect(screen.getByTestId('turn-status-indicator')).toHaveTextContent('Thinking...')
    expect(
      useChatStore.getState().sessions[memberSessionId]?.messages
        .find((message) => message.type === 'user_text' && message.content === 'Please verify the final tokens.'),
    ).toMatchObject({ pending: true })

    await act(async () => {
      await useTeamStore.getState().refreshMemberSession(memberSessionId)
    })
    await waitFor(() => {
      const matchingPrompts = useChatStore.getState().sessions[memberSessionId]?.messages
        .filter((message) => message.type === 'user_text' && message.content === 'Please verify the final tokens.')
      expect(matchingPrompts).toHaveLength(1)
      expect(matchingPrompts?.[0]).toMatchObject({ id: 'direct-message-echo' })
      expect(matchingPrompts?.[0]?.type === 'user_text' && matchingPrompts[0].pending)
        .not.toBe(true)
    })
    expect(screen.getByTestId('turn-status-indicator')).toHaveTextContent('Thinking...')

    await act(async () => {
      await useTeamStore.getState().refreshMemberSession(memberSessionId)
    })
    expect(await screen.findByText('The final tokens are verified.')).toBeInTheDocument()
    expect(getMemberTranscriptMock).toHaveBeenCalledTimes(4)
    await waitFor(() => {
      expect(screen.queryByTestId('turn-status-indicator')).not.toBeInTheDocument()
    })
  })

  it('replays physical-owner activity once the Team transcript identifies its fragment', async () => {
    const transcript = deferred<Awaited<ReturnType<typeof getMemberTranscriptMock>>>()
    const member = {
      agentId: 'physical-reviewer@review-team',
      name: 'physical-reviewer',
      role: 'reviewer',
      status: 'running' as const,
      // A configured member session can also be the physical fallback
      // fragment. Its identity is not known until the transcript responds.
      sessionId: 'physical-fragment-uuid',
    }
    const team = {
      name: 'review-team',
      leadSessionId: 'physical-owner-lead',
      incarnationId: 'physical-owner-incarnation',
      createdAt: '2026-08-10T00:00:00.000Z',
      members: [member],
    }
    const tabId = memberSessionId(member.agentId, team.incarnationId)
    getMemberTranscriptMock.mockReturnValue(transcript.promise)
    useTeamStore.setState({ activeTeam: team })
    useTeamStore.getState().openMemberSession(member, team)

    render(
      <TeamMemberRunPage
        tabId={tabId}
        leadSessionId={team.leadSessionId}
        agentId={member.agentId}
        title="physical-reviewer"
      />,
    )
    // The live event arrives while the first transcript request is still in
    // flight. It must remain pending until the response tells us whether the
    // configured session id is a physical fragment that requires namespacing.
    act(() => {
      useChatStore.getState().handleServerMessage(team.leadSessionId, {
        type: 'system_notification',
        subtype: 'task_started',
        data: {
          task_id: 'physical-nested-task',
          tool_use_id: 'physical-nested-tool',
          owner_agent_id: 'physical-fragment-uuid',
          task_type: 'local_agent',
          description: 'Physical fragment nested review',
        },
      })
    })
    expect(
      useChatStore.getState().sessions[team.leadSessionId]
        ?.backgroundAgentTasks?.['physical-nested-task'],
    ).toBeUndefined()

    await act(async () => {
      transcript.resolve({
        messages: [],
        taskNotifications: [],
        ownerAgentIds: ['physical-fragment-uuid'],
      })
      await transcript.promise
    })

    const panel = await screen.findByTestId('session-activity-panel')
    expect(within(panel).getByText('Physical fragment nested review')).toBeInTheDocument()
    expect(
      useChatStore.getState().sessions[tabId]
        ?.backgroundAgentTasks?.['physical-fragment-uuid/physical-nested-task'],
    ).toMatchObject({ status: 'running' })
    expect(
      useChatStore.getState().sessions[tabId]
        ?.backgroundAgentTasks?.['physical-nested-task'],
    ).toBeUndefined()
  })

  it('hides the composer for a one-shot SubAgent and explains why', async () => {
    vi.mocked(subagentsApi.getRunByTool).mockResolvedValue(subagentRun({ canSendMessage: false }))

    render(<SubagentRunPage sourceSessionId="session-1" toolUseId="tool-1" title="Kuhn" />)

    await screen.findByTestId('subagent-conversation')
    expect(screen.getByTestId('subagent-readonly-note')).toHaveTextContent(
      'This is the record of a one-shot subagent. It cannot be continued.',
    )
    expect(document.querySelector('[data-composer-editor]')).toBeNull()
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
  })

  it('hides the composer when the server does not report an inbox at all', async () => {
    const { canSendMessage: _omitted, ...withoutFlag } = subagentRun()
    vi.mocked(subagentsApi.getRunByTool).mockResolvedValue(withoutFlag as SubagentRunResponse)

    render(<SubagentRunPage sourceSessionId="session-1" toolUseId="tool-1" title="Kuhn" />)

    await screen.findByTestId('subagent-conversation')
    expect(screen.getByTestId('subagent-readonly-note')).toBeInTheDocument()
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
  })

  it('continues a resumable agent from the shared conversation composer', async () => {
    vi.mocked(subagentsApi.getRunByTool).mockResolvedValue(subagentRun({ canSendMessage: true }))
    vi.mocked(subagentsApi.sendMessage).mockResolvedValue({
      ok: true,
      agent_id: 'abc123',
      delivery: 'resumed',
    })
    useTabStore.getState().openTab('session-1', 'Parent session')
    useTabStore.getState().openSubagentTab('session-1', 'tool-1', 'Kuhn', 'agent-1')

    render(
      <SubagentRunPage
        sourceSessionId="session-1"
        toolUseId="tool-1"
        taskId="agent-1"
        title="Kuhn"
      />,
    )

    await screen.findByTestId('subagent-conversation')
    expect(screen.queryByTestId('subagent-readonly-note')).not.toBeInTheDocument()
    setComposerText('Review the new regression test.', 31)
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' })

    await waitFor(() => {
      expect(subagentsApi.sendMessage).toHaveBeenCalledWith(
        'session-1',
        'tool-1',
        'Review the new regression test.',
        'agent-1',
      )
    })
  })

  it('keeps a failed continuation visible after the transcript refreshes', async () => {
    vi.mocked(subagentsApi.getRunByTool).mockResolvedValue(subagentRun({ canSendMessage: true }))
    vi.mocked(subagentsApi.sendMessage).mockRejectedValue(new Error('Agent transcript is unavailable'))
    useTabStore.getState().openTab('session-1', 'Parent session')
    useTabStore.getState().openSubagentTab('session-1', 'tool-1', 'Kuhn', 'agent-1')

    render(
      <SubagentRunPage
        sourceSessionId="session-1"
        toolUseId="tool-1"
        taskId="agent-1"
        title="Kuhn"
      />,
    )

    await screen.findByTestId('subagent-conversation')
    setComposerText('Continue the review.', 20)
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' })
    expect(await screen.findByText('Agent transcript is unavailable')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Refresh SubAgent run' }))
    await waitFor(() => expect(subagentsApi.getRunByTool).toHaveBeenCalledTimes(2))
    expect(screen.getByText('Continue the review.')).toBeInTheDocument()
    expect(screen.getByText('Agent transcript is unavailable')).toBeInTheDocument()
    expect(screen.queryByText('Thinking...')).not.toBeInTheDocument()
  })

  it('renders a loading state while the run is loading', () => {
    vi.mocked(subagentsApi.getRunByTool).mockReturnValue(deferred<SubagentRunResponse>().promise)

    render(<SubagentRunPage sourceSessionId="session-1" toolUseId="tool-1" title="Kuhn" />)

    expect(screen.getByRole('status')).toHaveTextContent('Loading SubAgent run...')
    expect(screen.getByRole('button', { name: 'Refresh SubAgent run' })).toBeDisabled()
  })

  it('renders a missing transcript fallback', async () => {
    vi.mocked(subagentsApi.getRunByTool).mockResolvedValue(subagentRun({
      agentId: null,
      status: 'unknown',
      summary: 'Only summary available',
      messages: [],
      source: 'none',
    }))

    render(<SubagentRunPage sourceSessionId="session-1" toolUseId="tool-1" title="SubAgent" />)

    const conversation = await screen.findByTestId('subagent-conversation')
    expect(conversation).toHaveTextContent('Only summary available')
    expect(screen.queryByText('No local transcript messages captured for this SubAgent.')).not.toBeInTheDocument()
  })

  it('refreshes running SubAgent runs while the detail tab is open', async () => {
    vi.mocked(subagentsApi.getRunByTool)
      .mockResolvedValueOnce(subagentRun({
        status: 'running',
        messages: [],
        prompt: 'Review streaming changes',
      }))
      .mockResolvedValueOnce(subagentRun({
        status: 'completed',
        messages: [],
        prompt: 'Review streaming changes',
        result: 'Streaming review complete',
      }))

    render(<SubagentRunPage sourceSessionId="session-1" toolUseId="tool-1" title="SubAgent" />)

    expect(await screen.findByText('Running')).toBeInTheDocument()
    expect(screen.getByTestId('subagent-conversation')).toHaveTextContent('Review streaming changes')

    await waitFor(() => expect(subagentsApi.getRunByTool).toHaveBeenCalledTimes(2), { timeout: 2500 })
    expect(await screen.findByText('Completed')).toBeInTheDocument()
    expect(screen.getByTestId('subagent-conversation')).toHaveTextContent('Streaming review complete')
  })

  it('shows newly persisted tool activity before a running SubAgent completes', async () => {
    vi.mocked(subagentsApi.getRunByTool)
      .mockResolvedValueOnce(subagentRun({
        status: 'running',
        messages: [],
        prompt: 'Inspect live tools',
      }))
      .mockResolvedValueOnce(subagentRun({
        status: 'running',
        prompt: 'Inspect live tools',
        messages: [
          {
            id: 'child-tool-use',
            type: 'tool_use',
            content: [{
              type: 'tool_use',
              id: 'child-read-1',
              name: 'Read',
              input: { file_path: '/tmp/example.ts' },
            }],
            timestamp: TRANSCRIPT_TIMESTAMP,
          },
          {
            id: 'child-tool-result',
            type: 'tool_result',
            content: [{
              type: 'tool_result',
              tool_use_id: 'child-read-1',
              content: 'export const ready = true',
            }],
            timestamp: TRANSCRIPT_TIMESTAMP,
          },
        ],
      }))

    render(
      <SubagentRunPage
        sourceSessionId="session-1"
        toolUseId="tool-1"
        taskId="agent-1"
        title="SubAgent"
      />,
    )

    expect(await screen.findByText('Running')).toBeInTheDocument()
    await waitFor(() => expect(subagentsApi.getRunByTool).toHaveBeenCalledTimes(2), { timeout: 2500 })

    expect(screen.getByText('Running')).toBeInTheDocument()
    expect(screen.getByTestId('subagent-conversation')).toHaveTextContent('Read')
    expect(screen.getByTestId('subagent-conversation')).toHaveTextContent('example.ts')
    expect(screen.getByTestId('subagent-conversation')).toHaveTextContent('export const ready = true')
  })

  it('keeps an expanded tool call open after a live run refresh', async () => {
    const firstRefresh = deferred<SubagentRunResponse>()
    const liveRun = (updatedAt: string) => subagentRun({
      status: 'running',
      prompt: 'Inspect live tools',
      updatedAt,
      messages: [
        {
          id: 'child-tool-use',
          type: 'tool_use',
          content: [
            {
              type: 'tool_use',
              id: 'child-bash-1',
              name: 'Bash',
              input: { command: 'pwd' },
            },
            {
              type: 'tool_use',
              id: 'child-glob-1',
              name: 'Glob',
              input: { pattern: '*' },
            },
          ],
          timestamp: TRANSCRIPT_TIMESTAMP,
        },
        {
          id: 'child-tool-results',
          type: 'tool_result',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'child-bash-1',
              content: '/workspace',
            },
            {
              type: 'tool_result',
              tool_use_id: 'child-glob-1',
              content: 'src',
            },
          ],
          timestamp: TRANSCRIPT_TIMESTAMP,
        },
      ],
    })

    vi.mocked(subagentsApi.getRunByTool)
      .mockResolvedValueOnce(liveRun(TRANSCRIPT_TIMESTAMP))
      .mockReturnValueOnce(firstRefresh.promise)

    render(<SubagentRunPage sourceSessionId="session-1" toolUseId="tool-1" title="SubAgent" />)

    // A running run plays open, so its rows are already there — no need to
    // unfold the summary first, and clicking it here would fold them away.
    expect(await screen.findByTestId('activity-group')).toHaveAttribute('data-expanded', 'true')
    fireEvent.click(screen.getByRole('button', { name: /Bash.*pwd/i }))
    expect(document.querySelector('[data-shell-output]')).toHaveTextContent('/workspace')

    await waitFor(() => expect(subagentsApi.getRunByTool).toHaveBeenCalledTimes(2), { timeout: 2500 })
    await act(async () => {
      firstRefresh.resolve(liveRun('2026-07-03T10:20:13.000Z'))
      await firstRefresh.promise
    })

    expect(document.querySelector('[data-shell-output]')).toHaveTextContent('/workspace')
  })

  it('discovers a live task id that arrives after the detail tab opens', async () => {
    vi.mocked(subagentsApi.getRunByTool).mockResolvedValue(subagentRun({
      status: 'running',
      messages: [],
      prompt: 'Wait for task metadata',
    }))

    render(<SubagentRunPage sourceSessionId="session-1" toolUseId="tool-1" title="SubAgent" />)

    expect(await screen.findByText('Running')).toBeInTheDocument()
    expectSharedSessionSurface('subagent')
    expect(subagentsApi.getRunByTool).toHaveBeenCalledWith('session-1', 'tool-1', undefined)

    act(() => {
      useChatStore.setState({
        sessions: {
          'session-1': {
            ...createDefaultSessionState(),
            backgroundAgentTasks: {
              'agent-1': {
                taskId: 'agent-1',
                toolUseId: 'tool-1',
                status: 'running',
                startedAt: 1,
                updatedAt: 1,
              },
            },
          } as never,
        },
      })
    })

    await waitFor(() => {
      expect(subagentsApi.getRunByTool).toHaveBeenCalledWith('session-1', 'tool-1', 'agent-1')
    })
    expectSharedSessionSurface('subagent')
  })

  it('keeps the tab open on API errors', async () => {
    vi.mocked(subagentsApi.getRunByTool).mockRejectedValue(new Error('boom'))

    render(<SubagentRunPage sourceSessionId="session-1" toolUseId="tool-1" title="SubAgent" />)

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('boom'))
    expect(screen.getByRole('button', { name: 'Refresh SubAgent run' })).toBeInTheDocument()
  })

  it('ignores stale responses when the selected SubAgent changes before the first request resolves', async () => {
    const first = deferred<SubagentRunResponse>()
    const second = deferred<SubagentRunResponse>()
    vi.mocked(subagentsApi.getRunByTool).mockImplementation((sessionId) =>
      sessionId === 'session-a' ? first.promise : second.promise
    )

    const { rerender } = render(<SubagentRunPage sourceSessionId="session-a" toolUseId="tool-a" title="First Agent" />)
    rerender(<SubagentRunPage sourceSessionId="session-b" toolUseId="tool-b" title="Second Agent" />)

    await act(async () => {
      second.resolve(subagentRun({
        sessionId: 'session-b',
        toolUseId: 'tool-b',
        summary: 'Second result',
        messages: [{
          id: 'second-finding',
          type: 'assistant',
          content: [{ type: 'text', text: 'Second finding' }],
          timestamp: TRANSCRIPT_TIMESTAMP,
        }],
      }))
      await second.promise
    })

    expect(screen.getByText(/Second finding/)).toBeInTheDocument()

    await act(async () => {
      first.resolve(subagentRun({
        sessionId: 'session-a',
        toolUseId: 'tool-a',
        summary: 'Stale first result',
        messages: [{
          id: 'stale-finding',
          type: 'assistant',
          content: [{ type: 'text', text: 'Stale finding' }],
          timestamp: TRANSCRIPT_TIMESTAMP,
        }],
      }))
      await first.promise
    })

    expect(screen.getByText(/Second finding/)).toBeInTheDocument()
    expect(screen.queryByText('Stale first result')).not.toBeInTheDocument()
    expect(screen.queryByText(/Stale finding/)).not.toBeInTheDocument()
  })

  it('keeps existing details visible when refresh fails', async () => {
    vi.mocked(subagentsApi.getRunByTool)
      .mockResolvedValueOnce(subagentRun({ messages: [], summary: 'Initial result' }))
      .mockRejectedValueOnce(new Error('refresh failed'))

    render(<SubagentRunPage sourceSessionId="session-1" toolUseId="tool-1" title="SubAgent" />)

    expect((await screen.findAllByText('Initial result')).length).toBeGreaterThan(0)

    fireEvent.click(screen.getByRole('button', { name: 'Refresh SubAgent run' }))

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('refresh failed'))
    expect(screen.getAllByText('Initial result').length).toBeGreaterThan(0)
  })
})
