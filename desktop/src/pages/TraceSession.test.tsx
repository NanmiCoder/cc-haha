import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import '@testing-library/jest-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TraceSession } from './TraceSession'
import { sessionsApi } from '../api/sessions'
import { useSessionStore } from '../stores/sessionStore'
import { useSettingsStore } from '../stores/settingsStore'
import { clearTraceCallCache } from '../lib/trace/callCache'
import { Section, resetTraceSectionState } from '../components/trace/detail/Section'
import type { MessageEntry } from '../types/session'
import type { TraceCallRecord, TraceSession as TraceSessionData } from '../types/trace'

vi.mock('../api/sessions', () => ({
  sessionsApi: {
    getTrace: vi.fn(),
    getMessages: vi.fn(),
    getTraceCall: vi.fn(),
  },
}))

const SESSION_ID = 'session-live'

const requestPreview = JSON.stringify({
  model: 'claude-sonnet-4-5',
  system: 'You are helpful.',
  messages: [{ role: 'user', content: 'Hello world' }],
  tools: [{ name: 'Bash', description: 'Run shell commands', input_schema: { type: 'object' } }],
  max_tokens: 4096,
})

function makeCall(overrides: Partial<TraceCallRecord> = {}): TraceCallRecord {
  return {
    id: 'call-1',
    sessionId: SESSION_ID,
    source: 'anthropic',
    provider: { id: 'provider-main', name: 'Anthropic Direct', format: 'anthropic' },
    model: 'claude-sonnet-4-5',
    startedAt: '2026-06-09T10:00:01.000Z',
    completedAt: '2026-06-09T10:00:03.000Z',
    durationMs: 2000,
    usage: { inputTokens: 1200, outputTokens: 847 },
    request: {
      method: 'POST',
      url: 'https://api.anthropic.com/v1/messages',
      headers: { 'content-type': 'application/json' },
      body: {
        contentType: 'json',
        bytes: requestPreview.length,
        sha256: 'a'.repeat(64),
        preview: requestPreview,
        truncated: true,
      },
    },
    response: {
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: {
        contentType: 'json',
        bytes: 96,
        sha256: 'b'.repeat(64),
        preview: JSON.stringify({
          model: 'claude-sonnet-4-5',
          content: [{ type: 'text', text: 'Hi (preview)' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 1200, output_tokens: 847 },
        }),
        truncated: true,
      },
    },
    ...overrides,
  }
}

const fullCall = makeCall({
  request: {
    method: 'POST',
    url: 'https://api.anthropic.com/v1/messages',
    headers: { 'content-type': 'application/json' },
    body: {
      contentType: 'json',
      bytes: requestPreview.length,
      sha256: 'a'.repeat(64),
      preview: requestPreview,
      truncated: false,
    },
  },
  response: {
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: {
      contentType: 'json',
      bytes: 128,
      sha256: 'b'.repeat(64),
      preview: JSON.stringify({
        model: 'claude-sonnet-4-5',
        content: [{ type: 'text', text: 'Hi from the full record' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 1200, output_tokens: 847 },
      }),
      truncated: false,
    },
  },
})

const baseTrace: TraceSessionData = {
  sessionId: SESSION_ID,
  session: {
    id: SESSION_ID,
    title: 'Trace API title',
    projectPath: '/tmp',
    workDir: '/tmp',
  },
  summary: {
    apiCalls: 1,
    failedCalls: 0,
    totalDurationMs: 2000,
    totalInputTokens: 1200,
    totalOutputTokens: 847,
    models: [{ model: 'claude-sonnet-4-5', calls: 1 }],
    updatedAt: '2026-06-09T10:00:06.000Z',
  },
  calls: [makeCall()],
}

const baseMessages: MessageEntry[] = [
  { id: 'msg-1', type: 'user', content: 'Hello world', timestamp: '2026-06-09T10:00:00.000Z' },
  {
    id: 'msg-2',
    type: 'assistant',
    content: [{ type: 'text', text: 'Hi there' }],
    timestamp: '2026-06-09T10:00:04.000Z',
    model: 'claude-sonnet-4-5',
  },
  {
    id: 'msg-3',
    type: 'tool_use',
    content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls -la' } }],
    timestamp: '2026-06-09T10:00:05.000Z',
  },
  {
    id: 'msg-4',
    type: 'tool_result',
    content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'file.txt' }],
    timestamp: '2026-06-09T10:00:06.000Z',
  },
]

async function renderReady(pollIntervalMs = 60_000) {
  render(<TraceSession sessionId={SESSION_ID} pollIntervalMs={pollIntervalMs} />)
  await screen.findByTestId('trace-split-layout')
}

describe('TraceSession', () => {
  beforeEach(() => {
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      writable: true,
      value: vi.fn(),
    })
    clearTraceCallCache()
    resetTraceSectionState()
    window.localStorage.clear()
    useSettingsStore.setState({ locale: 'en' })
    vi.mocked(sessionsApi.getTrace).mockResolvedValue(baseTrace)
    vi.mocked(sessionsApi.getMessages).mockResolvedValue({ messages: baseMessages })
    vi.mocked(sessionsApi.getTraceCall).mockResolvedValue({ call: fullCall })
    useSessionStore.setState({
      sessions: [{
        id: SESSION_ID,
        title: 'Live probe',
        createdAt: '2026-06-09T10:00:00.000Z',
        modifiedAt: '2026-06-09T10:10:00.000Z',
        messageCount: baseMessages.length,
        projectPath: '/tmp',
        workDir: '/tmp',
        workDirExists: true,
      }],
      activeSessionId: SESSION_ID,
      isLoading: false,
      error: null,
    })
  })

  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
    useSessionStore.setState({ sessions: [], activeSessionId: null, isLoading: false, error: null })
    useSettingsStore.setState({ locale: 'en' })
  })

  it('renders the two-pane layout with tree and detail', async () => {
    await renderReady()

    expect(screen.getByTestId('trace-header')).toBeInTheDocument()
    expect(screen.getByTestId('trace-tree')).toBeInTheDocument()
    expect(screen.getByTestId('trace-detail')).toBeInTheDocument()
    expect(screen.getByTestId('trace-split-divider')).toBeInTheDocument()

    // Session root is selected by default and shows the overview grid.
    const detail = within(screen.getByTestId('trace-detail'))
    expect(detail.getByTestId('trace-overview')).toBeInTheDocument()
    expect(detail.getByText('LLM calls')).toBeInTheDocument()
    expect(detail.getAllByText('Wall time').length).toBeGreaterThan(0)
    expect(detail.getAllByText('6.00s').length).toBeGreaterThan(0)
    expect(detail.getAllByText('Model time').length).toBeGreaterThan(0)
    expect(detail.getAllByText('2.00s').length).toBeGreaterThan(0)
    expect(detail.getByText('Tool time')).toBeInTheDocument()
    expect(detail.getAllByText('1.00s').length).toBeGreaterThan(0)

    // Timeline rows for messages, the model call, and the tool call.
    const tree = within(screen.getByTestId('trace-tree'))
    expect(tree.getByText('User message')).toBeInTheDocument()
    expect(tree.getByText('claude-sonnet-4-5')).toBeInTheDocument()
    expect(tree.getByText('Bash')).toBeInTheDocument()
  })

  it('groups timeline rows by turn with user message previews', async () => {
    vi.mocked(sessionsApi.getMessages).mockResolvedValue({
      messages: [
        ...baseMessages,
        { id: 'msg-5', type: 'user', content: 'Second question', timestamp: '2026-06-09T10:05:00.000Z' },
      ],
    })
    await renderReady()

    const tree = within(screen.getByTestId('trace-tree'))
    expect(tree.getByText('Turn 1')).toBeInTheDocument()
    expect(tree.getByText('Turn 2')).toBeInTheDocument()
    // Preview text shows in both the turn header and the user message row.
    expect(tree.getAllByText('Hello world').length).toBeGreaterThan(0)
    expect(tree.getAllByText('Second question').length).toBeGreaterThan(0)

    // Collapsing a turn hides its rows.
    expect(tree.getByText('Bash')).toBeInTheDocument()
    fireEvent.click(tree.getAllByRole('button', { name: 'Toggle turn' })[0]!)
    expect(tree.queryByText('Bash')).not.toBeInTheDocument()
  })

  it('selecting a tree row drives the detail panel', async () => {
    await renderReady()

    const tree = within(screen.getByTestId('trace-tree'))
    fireEvent.click(tree.getByText('Bash'))

    const detail = within(screen.getByTestId('trace-detail'))
    expect(detail.getByRole('heading', { level: 2, name: 'Bash' })).toBeInTheDocument()
    expect(detail.getByText('Duration')).toBeInTheDocument()
    expect(detail.getByText('1.00s')).toBeInTheDocument()
    expect(detail.getAllByText('Completed').length).toBeGreaterThan(0)
    expect(detail.getByTestId('trace-tool-detail')).toBeInTheDocument()
    expect(detail.getByText('Input')).toBeInTheDocument()
    expect(detail.getByText('Result')).toBeInTheDocument()
    expect(detail.getByText('file.txt')).toBeInTheDocument()
  })

  it('filters lifecycle noise events out of the tree but keeps error events', async () => {
    vi.mocked(sessionsApi.getTrace).mockResolvedValue({
      ...baseTrace,
      events: [
        {
          id: 'event-noise',
          sessionId: SESSION_ID,
          callId: 'call-1',
          source: 'anthropic',
          timestamp: '2026-06-09T10:00:01.100Z',
          phase: 'api_call_started',
          severity: 'info',
        },
        {
          id: 'event-failed',
          sessionId: SESSION_ID,
          callId: 'call-1',
          source: 'anthropic',
          timestamp: '2026-06-09T10:00:02.000Z',
          phase: 'api_call_failed',
          severity: 'error',
          message: 'network down',
        },
      ],
    })
    await renderReady()

    const tree = within(screen.getByTestId('trace-tree'))
    expect(tree.getByText('API call failed')).toBeInTheDocument()
    expect(tree.queryByText('API call started')).not.toBeInTheDocument()
  })

  it('loads the full call record on demand and renders semantic sections', async () => {
    await renderReady()

    fireEvent.click(within(screen.getByTestId('trace-tree')).getByText('claude-sonnet-4-5'))

    await waitFor(() => expect(sessionsApi.getTraceCall).toHaveBeenCalledWith(SESSION_ID, 'call-1'))
    const detail = within(screen.getByTestId('trace-detail'))
    expect(await detail.findByText('Hi from the full record')).toBeInTheDocument()

    // Section flow: Response (open) / Messages (open) / System prompt / Tools / Parameters / Raw.
    expect(detail.getByRole('button', { name: /^Response/ })).toBeInTheDocument()
    expect(detail.getByRole('button', { name: /^Messages/ })).toBeInTheDocument()
    expect(detail.getByText('Hello world')).toBeInTheDocument()
    expect(detail.getByText('end_turn')).toBeInTheDocument()
    expect(detail.getByRole('button', { name: /^Tools/ })).toBeInTheDocument()
    expect(detail.getByRole('button', { name: /^Parameters/ })).toBeInTheDocument()
    expect(detail.getByRole('button', { name: 'Raw' })).toBeInTheDocument()

    // System prompt is collapsed by default; expanding reveals the text.
    expect(detail.queryByText('You are helpful.')).not.toBeInTheDocument()
    fireEvent.click(detail.getByRole('button', { name: /^System prompt/ }))
    expect(detail.getByText('You are helpful.')).toBeInTheDocument()

    // Header badge row carries the usage brief.
    expect(detail.getByText('1.2k → 847')).toBeInTheDocument()
  })

  it('shows the aborted badge and abort guidance for an aborted call', async () => {
    const abortedCall = makeCall({
      id: 'call-aborted',
      status: 'error',
      completedAt: '2026-06-09T10:04:01.000Z',
      durationMs: 240_000,
      metadata: { phase: 'api_call_aborted', aborted: true },
      error: { name: 'AbortError', message: 'Stream idle timeout: no chunks received for 240s' },
      response: {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
        body: {
          contentType: 'text',
          bytes: 30,
          sha256: 'c'.repeat(64),
          preview: 'data: {"type":"message_start"}',
          truncated: true,
        },
      },
    })
    vi.mocked(sessionsApi.getTrace).mockResolvedValue({
      ...baseTrace,
      summary: { ...baseTrace.summary, failedCalls: 1 },
      calls: [abortedCall],
    })
    vi.mocked(sessionsApi.getTraceCall).mockResolvedValue({ call: abortedCall })
    await renderReady()

    fireEvent.click(within(screen.getByTestId('trace-tree')).getByText('claude-sonnet-4-5'))

    const detail = within(screen.getByTestId('trace-detail'))
    expect(await detail.findByTestId('trace-call-error')).toBeInTheDocument()
    expect(detail.getByTestId('trace-call-aborted-badge')).toHaveTextContent('Aborted')
    expect(detail.getByText('AbortError')).toBeInTheDocument()
    expect(detail.getByText('Stream idle timeout: no chunks received for 240s')).toBeInTheDocument()
    expect(
      detail.getByText('The request was aborted before the response completed (timeout or cancellation).'),
    ).toBeInTheDocument()
    // The header pill shows the terminal error state, not pending.
    expect(detail.getByText('error')).toBeInTheDocument()
    expect(detail.queryByText('pending')).not.toBeInTheDocument()
  })

  it('falls back to Raw with a legacy notice when the body cannot be parsed', async () => {
    const legacyCall = makeCall({
      request: {
        method: 'POST',
        url: 'https://api.anthropic.com/v1/messages',
        headers: {},
        body: {
          contentType: 'json',
          bytes: 4096,
          sha256: 'c'.repeat(64),
          preview: '{"model":"claude-sonnet-4-5","messages":[{"role"',
          truncated: true,
        },
      },
    })
    vi.mocked(sessionsApi.getTrace).mockResolvedValue({ ...baseTrace, calls: [legacyCall] })
    vi.mocked(sessionsApi.getTraceCall).mockResolvedValue({ call: legacyCall })
    await renderReady()

    fireEvent.click(within(screen.getByTestId('trace-tree')).getByText('claude-sonnet-4-5'))

    const detail = within(screen.getByTestId('trace-detail'))
    expect(await detail.findByText('Legacy truncated record; the semantic view is unavailable. See Raw below.')).toBeInTheDocument()
    // Raw section opens by default in fallback mode; semantic sections are skipped.
    await waitFor(() => expect(detail.getByText('Request body')).toBeInTheDocument())
    expect(detail.queryByRole('button', { name: /^Messages/ })).not.toBeInTheDocument()
  })

  it('applies poll updates and short-circuits identical snapshots', async () => {
    vi.mocked(sessionsApi.getTrace)
      .mockResolvedValueOnce(baseTrace)
      .mockResolvedValueOnce(baseTrace)
      .mockResolvedValueOnce(baseTrace)
      .mockResolvedValue({
        ...baseTrace,
        summary: {
          ...baseTrace.summary,
          apiCalls: 2,
          updatedAt: '2026-06-09T10:00:09.000Z',
          models: [{ model: 'claude-sonnet-4-5', calls: 2 }],
        },
        calls: [baseTrace.calls[0]!, makeCall({ id: 'call-2', startedAt: '2026-06-09T10:00:08.000Z' })],
      })
    await renderReady(20)

    fireEvent.click(within(screen.getByTestId('trace-tree')).getByText('claude-sonnet-4-5'))
    await waitFor(() => expect(sessionsApi.getTraceCall).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(vi.mocked(sessionsApi.getTrace).mock.calls.length).toBeGreaterThanOrEqual(3))

    await screen.findByText('claude-sonnet-4-5 x2')
    expect(sessionsApi.getTraceCall).toHaveBeenCalledTimes(1)
    const detail = within(screen.getByTestId('trace-detail'))
    expect(detail.getByRole('heading', { level: 2, name: 'claude-sonnet-4-5' })).toBeInTheDocument()
  })

  it('applies poll updates when a call changes without changing row counts', async () => {
    const pendingTrace: TraceSessionData = {
      ...baseTrace,
      summary: {
        ...baseTrace.summary,
        failedCalls: 0,
        updatedAt: '2026-06-09T10:00:01.000Z',
      },
      calls: [makeCall({ status: 'pending', completedAt: undefined, durationMs: undefined, response: undefined, usage: undefined })],
    }
    const completedTrace: TraceSessionData = {
      ...baseTrace,
      summary: {
        ...baseTrace.summary,
        failedCalls: 1,
        updatedAt: '2026-06-09T10:00:01.000Z',
      },
      calls: [makeCall({ status: 'error', error: { name: 'Error', message: 'rate limited' }, response: undefined })],
    }
    vi.mocked(sessionsApi.getTrace)
      .mockResolvedValueOnce(pendingTrace)
      .mockResolvedValue(completedTrace)

    await renderReady(20)

    await waitFor(() => expect(vi.mocked(sessionsApi.getTrace).mock.calls.length).toBeGreaterThanOrEqual(2))
    const diagnosis = within(screen.getByTestId('trace-diagnosis'))
    expect(diagnosis.getByText('error')).toBeInTheDocument()
    expect(diagnosis.getByText('Model call failed')).toBeInTheDocument()
  })

  it('keeps section collapse state scoped to each trace session instance', async () => {
    const { rerender } = render(
      <Section key="left" scopeId="left" sectionKey="llm.raw" title="Raw" defaultOpen>
        left body
      </Section>,
    )

    fireEvent.click(screen.getByRole('button', { name: /Raw/ }))
    expect(screen.queryByText('left body')).not.toBeInTheDocument()

    rerender(
      <Section key="right" scopeId="right" sectionKey="llm.raw" title="Raw" defaultOpen>
        right body
      </Section>,
    )

    expect(screen.getByRole('button', { name: /Raw/ })).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('right body')).toBeInTheDocument()
  })

  it('supports keyboard navigation in the tree', async () => {
    await renderReady()

    const tree = screen.getByRole('tree')
    const detail = within(screen.getByTestId('trace-detail'))

    // First ArrowDown lands on the turn header.
    fireEvent.keyDown(tree, { key: 'ArrowDown' })
    expect(detail.getByRole('heading', { level: 2, name: 'Hello world' })).toBeInTheDocument()

    // Next ArrowDown moves to the first row inside the turn.
    fireEvent.keyDown(tree, { key: 'ArrowDown' })
    expect(detail.getByRole('heading', { level: 2, name: 'User message' })).toBeInTheDocument()
    expect(screen.getByRole('treeitem', { name: /User message/ })).toHaveAttribute('aria-selected', 'true')

    // ArrowUp returns to the turn header.
    fireEvent.keyDown(tree, { key: 'ArrowUp' })
    expect(detail.getByRole('heading', { level: 2, name: 'Hello world' })).toBeInTheDocument()
  })

  it('shows the error state with retry when the trace load fails', async () => {
    vi.mocked(sessionsApi.getTrace)
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue(baseTrace)

    render(<TraceSession sessionId={SESSION_ID} pollIntervalMs={60_000} />)

    expect(await screen.findByText('Failed to load trace')).toBeInTheDocument()
    expect(screen.getByText('boom')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByTestId('trace-split-layout')).toBeInTheDocument()
  })

  it('shows the empty state when the session has no captured activity', async () => {
    vi.mocked(sessionsApi.getTrace).mockResolvedValue({
      ...baseTrace,
      summary: {
        ...baseTrace.summary,
        apiCalls: 0,
        totalDurationMs: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        models: [],
      },
      calls: [],
    })
    vi.mocked(sessionsApi.getMessages).mockResolvedValue({ messages: [] })

    render(<TraceSession sessionId={SESSION_ID} pollIntervalMs={60_000} />)

    expect(await screen.findByText('No trace calls yet')).toBeInTheDocument()
    expect(screen.queryByTestId('trace-split-layout')).not.toBeInTheDocument()
  })

  it('uses trace session metadata when the sidebar store has not loaded the session', async () => {
    useSessionStore.setState({ sessions: [], activeSessionId: null, isLoading: false, error: null })

    render(<TraceSession sessionId={SESSION_ID} standalone pollIntervalMs={60_000} />)

    expect(await screen.findByRole('heading', { level: 1, name: 'Trace API title' })).toBeInTheDocument()
  })
})
