import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import '@testing-library/jest-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TraceList } from './TraceList'
import { tracesApi } from '../api/traces'
import { SETTINGS_TAB_ID, useTabStore } from '../stores/tabStore'
import { useSettingsStore } from '../stores/settingsStore'
import type { TraceSessionList } from '../types/trace'

vi.mock('../api/traces', () => ({
  tracesApi: {
    list: vi.fn(),
  },
}))

const { openTraceWindowMock } = vi.hoisted(() => ({
  openTraceWindowMock: vi.fn(async () => {}),
}))

vi.mock('../lib/desktopHost', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/desktopHost')>()
  return {
    ...actual,
    getDesktopHost: () => ({
      ...actual.getDesktopHost(),
      trace: { openWindow: openTraceWindowMock },
    }),
  }
})

const traceList: TraceSessionList = {
  total: 1,
  storageDir: '/tmp/cc-haha/traces',
  settings: {
    enabled: true,
    storageDir: '/tmp/cc-haha/traces',
  },
  traces: [{
    sessionId: 'session-trace-list',
    session: {
      id: 'session-trace-list',
      title: 'Debug stuck agent',
      projectPath: '/tmp/project',
      workDir: '/tmp/project',
    },
    summary: {
      apiCalls: 3,
      failedCalls: 1,
      totalDurationMs: 4715,
      totalInputTokens: 1200,
      totalOutputTokens: 300,
      models: [
        { model: 'claude-sonnet-4-5-20250929', calls: 2 },
        { model: 'claude-haiku-4-5-20251001', calls: 1 },
        { model: 'gpt-5.5', calls: 1 },
      ],
      updatedAt: '2026-06-09T15:03:40.010Z',
    },
    fileSize: 2048,
    fileUpdatedAt: '2026-06-09T15:03:40.010Z',
  }],
}

const secondTraceList: TraceSessionList = {
  ...traceList,
  traces: [{
    ...traceList.traces[0]!,
    sessionId: 'session-trace-second-page',
    session: {
      id: 'session-trace-second-page',
      title: 'Second trace session',
      projectPath: '/tmp/second-project',
      workDir: '/tmp/second-project',
    },
    summary: {
      ...traceList.traces[0]!.summary,
      apiCalls: 1,
      failedCalls: 0,
      models: [{ model: 'gpt-5.5', calls: 1 }],
    },
  }],
}

async function findTraceRow(title: RegExp) {
  return await screen.findByRole('listitem', { name: title })
}

describe('TraceList', () => {
  beforeEach(() => {
    useSettingsStore.setState({ locale: 'en' })
    useTabStore.setState({ tabs: [], activeTabId: null })
    vi.mocked(tracesApi.list).mockResolvedValue(traceList)
  })

  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
    useTabStore.setState({ tabs: [], activeTabId: null })
    useSettingsStore.setState({ locale: 'en' })
  })

  it('renders rows with title, model chips, failure count and metrics', async () => {
    render(<TraceList />)

    const row = await findTraceRow(/Debug stuck agent/)
    expect(tracesApi.list).toHaveBeenCalledWith({ limit: 50, offset: 0, query: '' })

    // header: storage dir + collection badge + aggregate chips
    expect(screen.getByText('/tmp/cc-haha/traces')).toBeInTheDocument()
    expect(screen.getByText('Collecting')).toBeInTheDocument()
    expect(screen.getByText('Sessions')).toBeInTheDocument()

    // row line 1: model chips use short names, capped at 2 with a "+N" overflow chip
    expect(within(row).getByText('sonnet-4-5')).toBeInTheDocument()
    expect(within(row).getByText('haiku-4-5')).toBeInTheDocument()
    expect(within(row).getByText('+1')).toBeInTheDocument()
    expect(within(row).queryByText('gpt-5.5')).not.toBeInTheDocument()
    expect(within(row).getByText('sonnet-4-5')).toHaveAttribute('title', 'claude-sonnet-4-5-20250929 x2')

    // row line 1: failed-call indicator
    expect(within(row).getByTitle('Failed')).toHaveTextContent('1')

    // row line 2: short session id + project path
    expect(within(row).getByText('session-')).toBeInTheDocument()
    expect(within(row).getByText('/tmp/project')).toBeInTheDocument()

    // right metrics: calls / duration / compact tokens
    expect(within(row).getByText('3')).toBeInTheDocument()
    expect(within(row).getByText('4.7s')).toBeInTheDocument()
    expect(within(row).getByText('1.5k')).toBeInTheDocument()
  })

  it('opens a trace tab when the row is clicked or activated via keyboard', async () => {
    render(<TraceList />)

    fireEvent.click(await screen.findByText('Debug stuck agent'))

    expect(useTabStore.getState().activeTabId).toBe('__trace__session-trace-list')
    expect(useTabStore.getState().tabs.find((tab) => tab.type === 'trace')?.traceSessionId).toBe('session-trace-list')

    useTabStore.setState({ tabs: [], activeTabId: null })
    fireEvent.keyDown(within(await findTraceRow(/Debug stuck agent/)).getByRole('button', { name: /Debug stuck agent/ }), { key: 'Enter' })

    expect(useTabStore.getState().activeTabId).toBe('__trace__session-trace-list')
  })

  it('runs hover actions without triggering the row click', async () => {
    render(<TraceList />)

    const row = await findTraceRow(/Debug stuck agent/)
    expect(row).not.toHaveAttribute('role', 'button')
    fireEvent.click(within(row).getByRole('button', { name: 'Open in separate window' }))

    expect(openTraceWindowMock).toHaveBeenCalledWith('session-trace-list')
    expect(useTabStore.getState().activeTabId).toBeNull()

    fireEvent.click(within(row).getByRole('button', { name: 'Trace' }))

    expect(useTabStore.getState().activeTabId).toBe('__trace__session-trace-list')
  })

  it('opens General settings from the trace settings button', async () => {
    render(<TraceList />)

    fireEvent.click(await screen.findByRole('button', { name: 'Trace settings' }))

    expect(useTabStore.getState().activeTabId).toBe(SETTINGS_TAB_ID)
    expect(useTabStore.getState().tabs.find((tab) => tab.sessionId === SETTINGS_TAB_ID)?.type).toBe('settings')
  })

  it('loads additional trace pages instead of fetching all rows at once', async () => {
    vi.mocked(tracesApi.list)
      .mockResolvedValueOnce({ ...traceList, total: 2 })
      .mockResolvedValueOnce({ ...secondTraceList, total: 2 })

    render(<TraceList />)

    expect(await screen.findByText('Debug stuck agent')).toBeInTheDocument()
    expect(screen.getByText('Showing 1 of 2')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Load more' }))

    expect(await screen.findByText('Second trace session')).toBeInTheDocument()
    expect(screen.getByText('Showing 2 of 2')).toBeInTheDocument()
    expect(tracesApi.list).toHaveBeenNthCalledWith(1, { limit: 50, offset: 0, query: '' })
    expect(tracesApi.list).toHaveBeenNthCalledWith(2, { limit: 50, offset: 1, query: '' })
  })

  it('sends title search text to the trace list API', async () => {
    render(<TraceList />)

    await screen.findByText('Debug stuck agent')
    fireEvent.change(screen.getByPlaceholderText('Search title, session ID, or project path'), {
      target: { value: 'stuck agent' },
    })

    await waitFor(() => {
      expect(tracesApi.list).toHaveBeenLastCalledWith({ limit: 50, offset: 0, query: 'stuck agent' })
    })
  })

  it('shows the paused badge when capture is disabled', async () => {
    vi.mocked(tracesApi.list).mockResolvedValue({
      ...traceList,
      settings: { enabled: false, storageDir: '/tmp/cc-haha/traces' },
    })

    render(<TraceList />)

    expect(await screen.findByText('Paused')).toBeInTheDocument()
    expect(screen.queryByText('Collecting')).not.toBeInTheDocument()
  })
})
