import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'

const { previewBridgeMock } = vi.hoisted(() => ({
  previewBridgeMock: {
    close: vi.fn().mockResolvedValue(undefined),
  },
}))

vi.mock('../../lib/previewBridge', () => ({ previewBridge: previewBridgeMock }))

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

vi.mock('../../pages/TerminalSettings', () => ({
  TerminalSettings: ({ active, cwd, onNewTerminal, runtimeId, testId }: { active: boolean; cwd?: string; onNewTerminal: () => void; runtimeId?: string; testId: string }) => (
    <div data-active={active ? 'true' : 'false'} data-cwd={cwd ?? ''} data-runtime-id={runtimeId ?? ''} data-testid={testId}>
      <button type="button" onClick={onNewTerminal}>New Terminal</button>
    </div>
  ),
}))

vi.mock('../../pages/TraceSession', () => ({
  TraceSession: ({ sessionId }: { sessionId: string }) => <div data-testid="trace-session">trace:{sessionId}</div>,
}))

vi.mock('../../pages/TraceList', () => ({
  TraceList: () => <div data-testid="trace-list" />,
}))

vi.mock('../workbench/WorkbenchTab', () => ({
  WorkbenchTab: ({ sessionId, tabId }: { sessionId: string; tabId: string }) => (
    <div data-testid="workbench-tab">workbench:{sessionId}:{tabId}</div>
  ),
}))

import { ContentRouter } from './ContentRouter'
import { useTabStore } from '../../stores/tabStore'

describe('ContentRouter tab surfaces', () => {
  afterEach(() => {
    cleanup()
    previewBridgeMock.close.mockClear()
    useTabStore.setState({ tabs: [], activeTabId: null })
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

  it('renders trace tabs without mounting the chat session surface', () => {
    useTabStore.setState({
      tabs: [{
        sessionId: '__trace__session-1',
        title: 'Trace',
        type: 'trace',
        status: 'idle',
        traceSessionId: 'session-1',
      }],
      activeTabId: '__trace__session-1',
    })

    render(<ContentRouter />)

    expect(screen.getByTestId('trace-session')).toHaveTextContent('trace:session-1')
    expect(screen.queryByTestId('active-session')).not.toBeInTheDocument()
  })

  it('renders the trace list tab without mounting the chat session surface', () => {
    useTabStore.setState({
      tabs: [{
        sessionId: '__traces__',
        title: 'Trace',
        type: 'traces',
        status: 'idle',
      }],
      activeTabId: '__traces__',
    })

    render(<ContentRouter />)

    expect(screen.getByTestId('trace-list')).toBeInTheDocument()
    expect(screen.queryByTestId('active-session')).not.toBeInTheDocument()
  })

  it('renders workbench tabs as main content instead of mounting the chat session surface', () => {
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

    expect(screen.getByTestId('workbench-tab')).toHaveTextContent('workbench:session-1:__workbench__session-1')
    expect(screen.queryByTestId('active-session')).not.toBeInTheDocument()
  })

  it('closes the native preview when switching from a chat session to settings', async () => {
    useTabStore.setState({
      tabs: [
        { sessionId: 'session-1', title: 'Chat', type: 'session', status: 'idle' },
        { sessionId: '__settings__', title: 'Settings', type: 'settings', status: 'idle' },
      ],
      activeTabId: 'session-1',
    })

    render(<ContentRouter />)
    expect(screen.getByTestId('active-session')).toBeInTheDocument()
    previewBridgeMock.close.mockClear()

    act(() => {
      useTabStore.setState({ activeTabId: '__settings__' })
    })

    expect(screen.getByTestId('settings-page')).toBeInTheDocument()
    await waitFor(() => {
      expect(previewBridgeMock.close).toHaveBeenCalledTimes(1)
    })
  })
})
