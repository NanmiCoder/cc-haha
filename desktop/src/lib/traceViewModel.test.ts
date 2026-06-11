import { describe, expect, it } from 'vitest'
import { buildTraceViewModel } from './traceViewModel'
import type { MessageEntry } from '../types/session'
import type { TraceSession } from '../types/trace'

const trace: TraceSession = {
  sessionId: 'session-live',
  session: null,
  summary: {
    apiCalls: 2,
    failedCalls: 0,
    totalDurationMs: 1700,
    totalInputTokens: 12,
    totalOutputTokens: 18,
    models: [{ model: 'gpt-5.5', calls: 2 }],
    updatedAt: '2026-06-09T10:00:04.000Z',
  },
  calls: [
    {
      id: 'call-1',
      sessionId: 'session-live',
      source: 'anthropic',
      provider: { id: 'provider-sub2api', name: 'Sub2API-ChatGPT', format: 'anthropic' },
      model: 'gpt-5.5',
      startedAt: '2026-06-09T10:00:01.000Z',
      completedAt: '2026-06-09T10:00:02.000Z',
      durationMs: 1000,
      usage: { inputTokens: 12, outputTokens: 18, cacheReadInputTokens: 4 },
      request: {
        method: 'POST',
        url: 'https://sub2api.example/v1/messages',
        headers: {},
        body: { contentType: 'json', bytes: 20, sha256: 'a', preview: '{"model":"gpt-5.5"}', truncated: false },
      },
      response: {
        status: 200,
        headers: {},
        body: { contentType: 'json', bytes: 11, sha256: 'b', preview: '{"ok":true}', truncated: false },
      },
    },
    {
      id: 'call-2',
      sessionId: 'session-live',
      source: 'anthropic',
      provider: { id: 'provider-sub2api', name: 'Sub2API-ChatGPT', format: 'anthropic' },
      model: 'gpt-5.5',
      startedAt: '2026-06-09T10:00:04.000Z',
      completedAt: '2026-06-09T10:00:04.700Z',
      durationMs: 700,
      request: {
        method: 'POST',
        url: 'https://sub2api.example/v1/messages',
        headers: {},
        body: { contentType: 'json', bytes: 20, sha256: 'c', preview: '{"model":"gpt-5.5"}', truncated: false },
      },
      response: {
        status: 200,
        headers: {},
        body: { contentType: 'json', bytes: 11, sha256: 'd', preview: '{"ok":true}', truncated: false },
      },
    },
  ],
  events: [
    {
      id: 'event-1',
      sessionId: 'session-live',
      callId: 'call-1',
      source: 'anthropic',
      provider: { id: 'provider-sub2api', name: 'Sub2API-ChatGPT', format: 'anthropic' },
      model: 'gpt-5.5',
      timestamp: '2026-06-09T10:00:01.100Z',
      phase: 'api_call_started',
      severity: 'info',
      metadata: { url: 'https://sub2api.example/v1/messages' },
    },
  ],
}

const messages: MessageEntry[] = [
  {
    id: 'user-1',
    type: 'user',
    content: 'Run ls and summarize the result',
    timestamp: '2026-06-09T10:00:00.000Z',
  },
  {
    id: 'assistant-1',
    type: 'tool_use',
    content: [
      { type: 'text', text: 'I will inspect the directory.' },
      { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'ls -la /tmp' } },
    ],
    timestamp: '2026-06-09T10:00:02.000Z',
  },
  {
    id: 'result-1',
    type: 'tool_result',
    content: [
      { type: 'tool_result', tool_use_id: 'tool-1', content: 'total 8', is_error: false },
    ],
    timestamp: '2026-06-09T10:00:03.000Z',
  },
]

describe('traceViewModel', () => {
  it('builds a turn-centered tree with llm and paired tool spans', () => {
    const viewModel = buildTraceViewModel(trace, messages)

    expect(viewModel.turns).toHaveLength(1)
    expect(viewModel.spansById.get('turn:0')?.childIds).toEqual(expect.arrayContaining([
      'message:user-1',
      'message:assistant-1',
      'tool:tool-1',
      'llm:call-1',
      'llm:call-2',
    ]))

    const tool = viewModel.spansById.get('tool:tool-1')
    expect(tool).toMatchObject({
      kind: 'tool',
      status: 'ok',
      title: 'Bash',
      subtitle: 'ls -la /tmp',
    })
    expect(tool?.childIds[0]).toMatch(/^tool_result:/)
    expect(viewModel.spansById.get(tool?.childIds[0] ?? '')).toMatchObject({
      kind: 'tool_result',
      status: 'ok',
      output: 'total 8',
    })
    expect(viewModel.spansById.get('event:event-1')).toMatchObject({
      kind: 'event',
      parentId: 'llm:call-1',
      status: 'ok',
    })
    expect(viewModel.spansById.get('llm:call-1')?.childIds).toContain('event:event-1')
  })

  it('passes call usage through to llm spans as tokenUsage', () => {
    const viewModel = buildTraceViewModel(trace, messages)

    expect(viewModel.spansById.get('llm:call-1')?.tokenUsage).toEqual({
      inputTokens: 12,
      outputTokens: 18,
      cacheReadInputTokens: 4,
    })
    expect(viewModel.spansById.get('llm:call-2')?.tokenUsage).toBeUndefined()
  })

  it('marks info lifecycle events as noise and omits fullRaw', () => {
    const viewModel = buildTraceViewModel(trace, messages)

    expect(viewModel.spansById.get('event:event-1')?.isLifecycleNoise).toBe(true)
    expect(viewModel.spansById.get('llm:call-1')?.isLifecycleNoise).toBeUndefined()
    expect('fullRaw' in viewModel).toBe(false)
  })

  it('marks pending tool spans when a result has not arrived', () => {
    const viewModel = buildTraceViewModel(trace, messages.slice(0, 2))
    expect(viewModel.spansById.get('tool:tool-1')).toMatchObject({ status: 'pending' })
    expect(viewModel.spansById.get('turn:0')).toMatchObject({ status: 'pending' })
    expect(viewModel.diagnosis).toMatchObject({
      status: 'attention',
      reason: 'pending_tool',
      focusSpanId: 'tool:tool-1',
      pendingToolCalls: 1,
    })
  })

  it('diagnoses event-only errors as blocked', () => {
    const viewModel = buildTraceViewModel({
      sessionId: 'session-event-error',
      session: null,
      summary: {
        apiCalls: 0,
        failedCalls: 0,
        totalDurationMs: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        models: [],
        updatedAt: null,
      },
      calls: [],
      events: [{
        id: 'event-failed',
        sessionId: 'session-event-error',
        timestamp: '2026-06-09T10:00:02.000Z',
        phase: 'upstream_fetch_failed',
        severity: 'error',
        message: 'network down',
      }],
    }, [])

    expect(viewModel.spansById.get('event:event-failed')).toMatchObject({
      kind: 'event',
      status: 'error',
      title: 'Upstream Fetch Failed',
      isLifecycleNoise: false,
    })
    expect(viewModel.diagnosis).toMatchObject({
      status: 'blocked',
      reason: 'event_error',
      focusSpanId: 'event:event-failed',
    })
  })
})
