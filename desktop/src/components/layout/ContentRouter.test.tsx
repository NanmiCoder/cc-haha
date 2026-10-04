vi.mock('../../pages/ExtensionMarket', () => ({ ExtensionMarket: () => <div data-testid="extension-market-page" /> }))
vi.mock('../../pages/Connectors', () => ({ Connectors: () => <div data-testid="connectors-page" /> }))
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../pages/EmptySession', () => ({
  EmptySession: () => <div data-testid="empty-session" />,
}))

vi.mock('../../pages/ActiveSession', () => ({
  ActiveSession: () => <div data-testid="active-session" />,
}))

vi.mock('../../pages/ScheduledTasks', () => ({
  ScheduledTasks: () => <div data-testid="scheduled-tasks" />,
}))

vi.mock('../../pages/Settings', () => ({
  Settings: () => <div data-testid="settings-page" />,
}))

vi.mock('../../pages/Market', () => ({
  Market: () => <div data-testid="market-page" />,
}))

vi.mock('../../pages/TerminalSettings', () => ({
  TerminalSettings: ({ active, cwd, onNewTerminal, runtimeId, testId }: { active: boolean; cwd?: string; onNewTerminal: () => void; runtimeId?: string; testId: string }) => (
    <div data-active={active ? 'true' : 'false'} data-cwd={cwd ?? ''} data-runtime-id={runtimeId ?? ''} data-testid={testId}>
      <button type="button" onClick={onNewTerminal}>New Terminal</button>
    </div>
  ),
}))

vi.mock('../../pages/SubagentRunPage', () => ({
  SubagentRunPage: ({ sourceSessionId, taskId, toolUseId, title }: { sourceSessionId: string; taskId?: string; toolUseId: string; title: string }) => (
    <div data-testid="subagent-run-page">{sourceSessionId}:{toolUseId}:{taskId}:{title}</div>
  ),
  TeamMemberRunPage: ({ tabId, leadSessionId, agentId, title }: { tabId: string; leadSessionId: string; agentId: string; title: string }) => (
    <div data-testid="team-member-run-page">{tabId}:{leadSessionId}:{agentId}:{title}</div>
  ),
}))

import { ContentRouter } from './ContentRouter'
import { MARKET_TAB_ID, SETTINGS_TAB_ID, useTabStore } from '../../stores/tabStore'
import { useUIStore } from '../../stores/uiStore'

describe('ContentRouter tab surfaces', () => {
  afterEach(() => {
    cleanup()
    useTabStore.setState({ tabs: [], activeTabId: null })
    useUIStore.setState({ pendingSettingsTab: null })
  })

  it('renders the active terminal tab as main content', () => {
    useTabStore.setState({
      tabs: [{ sessionId: '__terminal__1', title: 'Terminal 1', type: 'terminal', status: 'idle', terminalCwd: '/tmp/project' }],
      activeTabId: '__terminal__1',
    })

    render(<ContentRouter />)

    expect(screen.getByTestId('terminal-host-__terminal__1')).toHaveAttribute('data-active', 'true')
    expect(screen.getByTestId('terminal-host-__terminal__1')).toHaveAttribute('data-cwd', '/tmp/project')
    expect(screen.getByTestId('terminal-host-__terminal__1')).toHaveAttribute('data-runtime-id', '__terminal__1')
    expect(screen.queryByTestId('active-session')).not.toBeInTheDocument()
  })

  it('uses a promoted docked runtime when rendering a terminal tab', () => {
    useTabStore.setState({
      tabs: [{
        sessionId: '__terminal__1',
        title: 'Terminal 1',
        type: 'terminal',
        status: 'idle',
        terminalCwd: '/tmp/project',
        terminalRuntimeId: '__session_terminal__session-1',
      }],
      activeTabId: '__terminal__1',
    })

    render(<ContentRouter />)

    expect(screen.getByTestId('terminal-host-__terminal__1')).toHaveAttribute('data-runtime-id', '__session_terminal__session-1')
  })

  it('keeps one browser page layer for the life of the window, inside the session panel', () => {
    // A workspace browser page dies when its element leaves the DOM and
    // reloads when it moves, so the layer holding them must never be
    // re-created — not on a page switch, a task switch, or with no task open.
    useTabStore.setState({
      tabs: [
        { sessionId: 'session-1', title: 'One', type: 'session', status: 'idle' },
        { sessionId: 'session-2', title: 'Two', type: 'session', status: 'idle' },
        { sessionId: MARKET_TAB_ID, title: 'Market', type: 'market', status: 'idle' },
      ],
      activeTabId: 'session-1',
    })
    render(<ContentRouter />)
    const layer = screen.getByTestId('workspace-browser-guest-layer')
    // Same stacking context as the session content: it fades and goes inert
    // with the panel when another page takes the window.
    expect(screen.getByTestId('session-tab-panel')).toContainElement(layer)

    act(() => useTabStore.getState().setActiveTab(MARKET_TAB_ID))
    expect(screen.getByTestId('session-tab-panel')).toHaveAttribute('inert')
    expect(screen.getByTestId('workspace-browser-guest-layer')).toBe(layer)

    act(() => useTabStore.getState().setActiveTab('session-2'))
    expect(screen.getByTestId('workspace-browser-guest-layer')).toBe(layer)

    act(() => useTabStore.setState({
      tabs: [{ sessionId: MARKET_TAB_ID, title: 'Market', type: 'market', status: 'idle' }],
      activeTabId: MARKET_TAB_ID,
    }))
    expect(screen.queryByTestId('active-session')).toBeNull()
    expect(screen.getByTestId('workspace-browser-guest-layer')).toBe(layer)
  })

  it('keeps terminal tabs mounted while chat content is active', () => {
    useTabStore.setState({
      tabs: [
        { sessionId: '__terminal__1', title: 'Terminal 1', type: 'terminal', status: 'idle' },
        { sessionId: 'session-1', title: 'Chat', type: 'session', status: 'idle' },
      ],
      activeTabId: 'session-1',
    })

    render(<ContentRouter />)

    expect(screen.getByTestId('terminal-host-__terminal__1')).toHaveAttribute('data-active', 'false')
    expect(screen.getByTestId('active-session')).toBeInTheDocument()
  })

  it('can open another terminal tab from a terminal page', () => {
    useTabStore.setState({
      tabs: [{ sessionId: '__terminal__1', title: 'Terminal 1', type: 'terminal', status: 'idle', terminalCwd: '/tmp/project' }],
      activeTabId: '__terminal__1',
    })

    render(<ContentRouter />)
    fireEvent.click(screen.getByRole('button', { name: 'New Terminal' }))

    expect(useTabStore.getState().tabs.filter((tab) => tab.type === 'terminal')).toHaveLength(2)
    expect(useTabStore.getState().activeTabId).not.toBe('__terminal__1')
    expect(useTabStore.getState().tabs.find((tab) => tab.sessionId === useTabStore.getState().activeTabId)?.terminalCwd).toBe('/tmp/project')
  })

  it('renders SubAgent run tabs', () => {
    useTabStore.setState({
      tabs: [{
        sessionId: '__subagent__session-1__tool-1',
        title: 'Kuhn',
        type: 'subagent',
        status: 'idle',
        sourceSessionId: 'session-1',
        subagentToolUseId: 'tool-1',
        subagentTaskId: 'agent-1',
      }],
      activeTabId: '__subagent__session-1__tool-1',
    })

    render(<ContentRouter />)

    expect(screen.getByTestId('subagent-run-page')).toHaveTextContent('session-1:tool-1:agent-1:Kuhn')
    expect(screen.queryByTestId('active-session')).not.toBeInTheDocument()
  })

  it('falls back to the empty session for malformed SubAgent tab metadata', () => {
    useTabStore.setState({
      tabs: [{
        sessionId: '__subagent__session-1__tool-1',
        title: 'Kuhn',
        type: 'subagent',
        status: 'idle',
      }],
      activeTabId: '__subagent__session-1__tool-1',
    })

    render(<ContentRouter />)

    expect(screen.getByTestId('empty-session')).toBeInTheDocument()
    expect(screen.queryByTestId('subagent-run-page')).not.toBeInTheDocument()
  })

  it('renders Agent Teams members through the shared agent run desktop route', () => {
    useTabStore.setState({
      tabs: [{
        sessionId: 'team-member:reviewer@review-team',
        title: 'Reviewer',
        type: 'team-member',
        status: 'idle',
        sourceSessionId: 'lead-session',
        teamLeadSessionId: 'lead-session',
        teamMemberAgentId: 'reviewer@review-team',
        returnTabId: '__team__lead-session',
      }],
      activeTabId: 'team-member:reviewer@review-team',
    })

    render(<ContentRouter />)

    expect(screen.getByTestId('team-member-run-page')).toHaveTextContent(
      'team-member:reviewer@review-team:lead-session:reviewer@review-team:Reviewer',
    )
    expect(screen.queryByTestId('active-session')).not.toBeInTheDocument()
  })

  it('renders the market tab without mounting the chat session surface', () => {
    useTabStore.setState({
      tabs: [{
        sessionId: MARKET_TAB_ID,
        title: 'Market',
        type: 'market',
        status: 'idle',
      }],
      activeTabId: MARKET_TAB_ID,
    })

    render(<ContentRouter />)

    expect(screen.getByTestId('extension-market-page')).toBeInTheDocument()
    expect(screen.queryByTestId('active-session')).not.toBeInTheDocument()
  })

  it('returns an old in-memory workbench tab to its source task', () => {
    useTabStore.setState({
      tabs: [{
        sessionId: '__workbench__session-1',
        title: 'Workbench',
        type: 'workbench',
        status: 'idle',
        workbenchSessionId: 'session-1',
      }],
      activeTabId: '__workbench__session-1',
    })

    render(<ContentRouter />)

    expect(screen.getByTestId('active-session')).toBeInTheDocument()
    expect(useTabStore.getState().activeTabId).toBe('session-1')
    expect(useTabStore.getState().tabs.some(tab => tab.type === 'workbench')).toBe(false)
  })

  it('switches to settings without dropping the source task', async () => {
    useTabStore.setState({
      tabs: [
        { sessionId: 'session-1', title: 'Chat', type: 'session', status: 'idle' },
        { sessionId: '__settings__', title: 'Settings', type: 'settings', status: 'idle' },
      ],
      activeTabId: 'session-1',
    })

    render(<ContentRouter />)
    expect(screen.getByTestId('active-session')).toBeInTheDocument()

    act(() => {
      useTabStore.setState({ activeTabId: '__settings__' })
    })

    expect(screen.getByTestId('settings-page')).toBeInTheDocument()
    expect(useTabStore.getState().tabs.find(tab => tab.sessionId === 'session-1')).toMatchObject({ type: 'session' })
  })

  it('keeps the current conversation mounted while settings is open', () => {
    useTabStore.setState({
      tabs: [
        { sessionId: 'session-1', title: 'Chat', type: 'session', status: 'idle' },
        { sessionId: SETTINGS_TAB_ID, title: 'Settings', type: 'settings', status: 'idle' },
      ],
      activeTabId: 'session-1',
    })

    render(<ContentRouter />)
    const conversation = screen.getByTestId('active-session')

    act(() => useTabStore.getState().setActiveTab(SETTINGS_TAB_ID))
    expect(screen.getByTestId('settings-page')).toBeInTheDocument()
    expect(conversation).toBeInTheDocument()
    expect(conversation.closest('[aria-hidden]')).toHaveAttribute('aria-hidden', 'true')
    expect(conversation.closest('[aria-hidden]')).toHaveAttribute('inert')

    act(() => useTabStore.getState().setActiveTab('session-1'))
    expect(screen.getByTestId('active-session')).toBe(conversation)
    expect(screen.queryByTestId('settings-page')).not.toBeInTheDocument()
  })
})

it('routes the independent connectors tab', () => {
  useTabStore.setState({ tabs: [{ sessionId: '__connectors__', title: 'Connectors', type: 'connectors', status: 'idle' }], activeTabId: '__connectors__' })
  render(<ContentRouter />)
  expect(screen.getByTestId('extension-market-page')).toBeInTheDocument()
})
