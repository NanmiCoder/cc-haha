import '@testing-library/jest-dom'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TraceCallRecord } from '../../../types/trace'
import type { TraceCallsNear, TrajectoryRow } from '../../../types/trajectory'

const getTraceCallsNear = vi.fn<(sessionId: string, from: string, to: string) => Promise<TraceCallsNear>>()
const getTraceCall = vi.fn<(sessionId: string, callId: string, at?: string) => Promise<{ call: TraceCallRecord }>>()

vi.mock('../../../api/trajectory', () => ({
  trajectoryApi: {
    getTraceCallsNear: (sessionId: string, from: string, to: string) => getTraceCallsNear(sessionId, from, to),
  },
}))

vi.mock('../../../api/sessions', () => ({
  sessionsApi: {
    getTraceCall: (sessionId: string, callId: string, at?: string) => getTraceCall(sessionId, callId, at),
  },
}))

import { RawRequestTab } from './RawRequestTab'
import { clearTraceCallCache } from '../../../lib/trace/callCache'
import { resetTraceSectionState } from './Section'
import { useSettingsStore } from '../../../stores/settingsStore'

const at = (seconds: number) => new Date(Date.UTC(2026, 9, 4, 10, 0, 0) + seconds * 1000).toISOString()

const ROW: TrajectoryRow = {
  id: 'a:msg_1',
  kind: 'assistant',
  turn: 1,
  ts: at(5),
  endTs: at(8),
  startTs: at(1),
  preview: 'Checking',
  loc: [[0, 10]],
  model: 'claude-x',
}

const REQUEST = {
  model: 'claude-x',
  system: [{ type: 'text', text: 'You are the harness system prompt.' }],
  tools: [{ name: 'Bash', description: 'Run commands', input_schema: { type: 'object' } }],
  messages: [
    { role: 'user', content: [{ type: 'text', text: '<system-reminder>\nSkills available: pdf\n</system-reminder>' }, { type: 'text', text: 'Build the console' }] },
  ],
  max_tokens: 1024,
}

function call(id: string, start: number, end: number, extra: Partial<TraceCallRecord> = {}): TraceCallRecord {
  return {
    id,
    sessionId: 's1',
    source: 'anthropic',
    model: 'claude-x',
    status: 'ok',
    startedAt: at(start),
    completedAt: at(end),
    request: { method: 'POST', url: 'https://api/v1/messages', headers: {}, body: { contentType: 'json', bytes: 10, sha256: 'x', preview: '', truncated: false } },
    ...extra,
  }
}

describe('RawRequestTab', () => {
  const setTraceCaptureEnabled = vi.fn(async () => {})

  beforeEach(() => {
    getTraceCallsNear.mockReset()
    getTraceCall.mockReset()
    setTraceCaptureEnabled.mockClear()
    clearTraceCallCache()
    resetTraceSectionState()
    useSettingsStore.setState({ locale: 'en', traceCapture: { enabled: true, storageDir: '/tmp' }, setTraceCaptureEnabled })
  })

  it('shows the captured request and response of the closest call', async () => {
    getTraceCallsNear.mockResolvedValue({ captured: true, revisionToken: 'rev-1', calls: [call('early', 0.5, 2), call('match', 1, 8)], locs: { match: '9000-12000' } })
    getTraceCall.mockResolvedValue({
      call: call('match', 1, 8, {
        request: {
          method: 'POST',
          url: 'https://api/v1/messages',
          headers: { 'content-type': 'application/json' },
          body: { contentType: 'json', bytes: 100, sha256: 'x', preview: JSON.stringify(REQUEST), truncated: false },
          semantic: { version: 1, request: REQUEST },
        },
        response: {
          status: 200,
          headers: {},
          body: { contentType: 'json', bytes: 50, sha256: 'y', preview: JSON.stringify({ role: 'assistant', content: [{ type: 'text', text: 'Response from the model' }], stop_reason: 'end_turn' }), truncated: false },
        },
      }),
    })
    render(<RawRequestTab sessionId="s1" row={ROW} />)

    expect(await screen.findByText(/Closest captured call by time/)).toBeInTheDocument()
    // The record locator reaches calls beyond the capture's indexed window.
    expect(getTraceCall).toHaveBeenCalledWith('s1', 'match', '9000-12000')
    expect(await screen.findByText('Response from the model')).toBeInTheDocument()
    // Where the call went and with which model sit at the top.
    expect(screen.getByTestId('trajectory-request-endpoint')).toHaveTextContent(/POST\s*https:\/\/api\/v1\/messages/)
    expect(screen.getByTestId('trajectory-request-model')).toHaveTextContent('claude-x')
    expect(screen.getByTestId('trajectory-request-summary')).toHaveTextContent('HTTP 200')
    expect(screen.getByText('end_turn')).toBeInTheDocument()
    // The harness-injected reminder is split out of the conversation.
    expect(screen.getByText('Injected context')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /System prompt/ }))
    expect(await screen.findByText('You are the harness system prompt.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Tools/ }))
    const tools = screen.getByRole('button', { name: /Tools/ }).closest('section') ?? document.body
    expect(within(tools as HTMLElement).getByRole('button', { name: 'Bash' })).toBeInTheDocument()
  })

  it('says the response was never captured and offers the switch right here', async () => {
    useSettingsStore.setState({ traceCapture: { enabled: false, storageDir: '/tmp' } })
    getTraceCallsNear.mockResolvedValue({ captured: false, calls: [] })
    render(<RawRequestTab sessionId="s1" row={ROW} />)
    expect(await screen.findByText(/recording was off when this response ran/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('switch', { name: /Record raw requests/ }))
    expect(setTraceCaptureEnabled).toHaveBeenCalledWith(true)
    expect(getTraceCall).not.toHaveBeenCalled()
  })

  it('distinguishes a capture with no matching call', async () => {
    getTraceCallsNear.mockResolvedValue({ captured: true, calls: [call('later', 30, 40)] })
    render(<RawRequestTab sessionId="s1" row={ROW} />)
    expect(await screen.findByText(/No captured call matches this response/)).toBeInTheDocument()
    // Capture is on, so there is nothing to switch.
    expect(screen.queryByRole('switch')).not.toBeInTheDocument()
  })

  it('reports a failed capture lookup instead of spinning', async () => {
    getTraceCallsNear.mockRejectedValue(new Error('capture unavailable'))
    render(<RawRequestTab sessionId="s1" row={ROW} />)
    expect(await screen.findByText(/capture unavailable/)).toBeInTheDocument()
  })
})
