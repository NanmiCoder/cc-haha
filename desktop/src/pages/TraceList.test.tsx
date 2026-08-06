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
    deleteSession: vi.fn(),
  },
}))

const { openTraceWindowMock, hostState } = vi.hoisted(() => ({
  openTraceWindowMock: vi.fn(async () => {}),
  /** Flipped per-test to model H5/browser, where there is no native window API. */
  hostState: { hasTraceHost: true },
}))

vi.mock('../lib/desktopHost', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/desktopHost')>()
  return {
    ...actual,
    getDesktopHost: () => ({
      ...actual.getDesktopHost(),
      trace: hostState.hasTraceHost ? { openWindow: openTraceWindowMock } : undefined,
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
    hostState.hasTraceHost = true
    vi.mocked(tracesApi.list).mockResolvedValue(traceList)
    vi.mocked(tracesApi.deleteSession).mockResolvedValue({ sessionId: 'session-trace-list', deleted: true })
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
    // '4.71s', not '4.7s': the list used to carry its own formatter with one
    // decimal. It now shares formatDurationMs with the detail view, which is the
    // whole point — see the minutes case below.
    expect(within(row).getByText('4.71s')).toBeInTheDocument()
    expect(within(row).getByText('1.5k')).toBeInTheDocument()
  })

  // Regression: the list had a private formatDuration that stopped at seconds, so a
  // 12-minute session read "739.0s" here while the detail view — same field, same
  // t('trace.modelTime') label, shared formatter — read "12m 19s". Anything over a
  // minute exposes the fork, which is why no existing fixture caught it.
  it('renders a duration over a minute the same way the detail view does', async () => {
    vi.mocked(tracesApi.list).mockResolvedValue({
      ...traceList,
      traces: [{
        ...traceList.traces[0]!,
        summary: { ...traceList.traces[0]!.summary, totalDurationMs: 739_000 },
      }],
    })

    render(<TraceList />)
    const row = await findTraceRow(/Debug stuck agent/)

    expect(within(row).getByText('12m 19s')).toBeInTheDocument()
  })

  it('opens a trace tab when the row is clicked or activated via keyboard', async () => {
    render(<TraceList />)

    fireEvent.click(await screen.findByText('Debug stuck agent'))

    expect(useTabStore.getState().activeTabId).toBe('__trace__session-trace-list')
    const traceTab = useTabStore.getState().tabs.find((tab) => tab.type === 'trace')
    expect(traceTab?.traceSessionId).toBe('session-trace-list')
    // Titled with the session itself — the tab bar's trace glyph carries the
    // type, so a "Model trace: " prefix would only eat the visible width.
    expect(traceTab?.title).toBe('Debug stuck agent')

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

    // The row actions cover only what a row click cannot express. A separate
    // "open" button would just duplicate the click and crowd the hover strip.
    expect(within(row).getAllByRole('button').map((button) => button.getAttribute('aria-label')))
      .toEqual([null, 'Open in separate window', 'Delete trace'])
  })

  it('opens a browser tab instead of a dead button when there is no desktop shell', async () => {
    hostState.hasTraceHost = false
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(null)
    render(<TraceList />)

    const row = await findTraceRow(/Debug stuck agent/)
    fireEvent.click(within(row).getByRole('button', { name: 'Open in separate window' }))

    expect(openTraceWindowMock).not.toHaveBeenCalled()
    expect(openSpy).toHaveBeenCalledWith(
      expect.stringContaining('traceWindow=1'),
      '_blank',
      'noopener,noreferrer',
    )
    expect(openSpy.mock.calls[0]?.[0]).toContain('traceSessionId=session-trace-list')
    openSpy.mockRestore()
  })

  it('requires confirmation before deleting a trace session', async () => {
    vi.mocked(tracesApi.list)
      .mockResolvedValueOnce(traceList)
      .mockResolvedValueOnce({ ...traceList, traces: [], total: 0 })

    render(<TraceList />)

    const row = await findTraceRow(/Debug stuck agent/)
    fireEvent.click(within(row).getByRole('button', { name: 'Delete trace' }))

    expect(tracesApi.deleteSession).not.toHaveBeenCalled()
    expect(screen.getByText('Delete trace data for "Debug stuck agent"? Chat history is not deleted.')).toBeInTheDocument()

    fireEvent.click(within(screen.getByRole('dialog', { name: 'Delete trace session' })).getByRole('button', { name: 'Delete' }))

    await waitFor(() => {
      expect(tracesApi.deleteSession).toHaveBeenCalledWith('session-trace-list')
    })
    await waitFor(() => {
      expect(screen.queryByText('Debug stuck agent')).not.toBeInTheDocument()
    })
    expect(tracesApi.list).toHaveBeenNthCalledWith(2, { limit: 50, offset: 0, query: '' })
    expect(useTabStore.getState().activeTabId).toBeNull()
  })

  it('opens General settings from the trace settings button', async () => {
    render(<TraceList />)

    fireEvent.click(await screen.findByRole('button', { name: 'Trace settings' }))

    expect(useTabStore.getState().activeTabId).toBe(SETTINGS_TAB_ID)
    expect(useTabStore.getState().tabs.find((tab) => tab.sessionId === SETTINGS_TAB_ID)?.type).toBe('settings')
  })

  it('announces a failed load and retries from inside the error', async () => {
    vi.mocked(tracesApi.list)
      .mockRejectedValueOnce(new Error('trace store unreachable'))
      .mockResolvedValueOnce(traceList)

    render(<TraceList />)

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('trace store unreachable')

    fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }))

    expect(await screen.findByText('/tmp/cc-haha/traces')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
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
