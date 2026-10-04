import { describe, expect, it } from 'vitest'
import type { TraceCallRecord } from '../../types/trace'
import { summarizeTraceCall } from './requestSummary'

function call(overrides: Partial<TraceCallRecord> & { body?: unknown; preview?: string } = {}): TraceCallRecord {
  const { body, preview, ...rest } = overrides
  return {
    id: 'c1',
    sessionId: 's1',
    source: 'anthropic',
    status: 'ok',
    startedAt: '2026-10-04T10:00:00.000Z',
    durationMs: 1234,
    model: 'claude-opus-5-5',
    request: {
      method: 'POST',
      url: 'https://api.anthropic.com/v1/messages?beta=true',
      headers: {},
      body: { contentType: 'json', bytes: 10, sha256: 'x', preview: preview ?? '', truncated: false },
      ...(body !== undefined ? { semantic: { version: 1 as const, request: body as Record<string, unknown> } } : {}),
    },
    response: { status: 200, headers: { 'request-id': 'req_011abc' }, body: { contentType: 'json', bytes: 1, sha256: 'y', preview: '', truncated: false } },
    ...rest,
  }
}

describe('summarizeTraceCall', () => {
  it('reports a direct call: endpoint, model, status, duration and request id', () => {
    const summary = summarizeTraceCall(call({ body: { model: 'claude-opus-5-5' }, querySource: 'sdk', provider: { id: null, name: 'Anthropic', format: 'anthropic' } }), null)
    expect(summary).toMatchObject({
      method: 'POST',
      url: 'https://api.anthropic.com/v1/messages?beta=true',
      route: 'direct',
      providerName: 'Anthropic',
      providerFormat: 'anthropic',
      requestedModel: 'claude-opus-5-5',
      status: 200,
      durationMs: 1234,
      requestId: 'req_011abc',
      querySource: 'sdk',
    })
    expect(summary.upstreamModel).toBeUndefined()
  })

  it('shows the model the proxy actually sent upstream when it was mapped', () => {
    const summary = summarizeTraceCall(call({
      source: 'proxy',
      request: {
        method: 'POST',
        url: 'https://api.deepseek.com/chat/completions',
        headers: {},
        body: { contentType: 'json', bytes: 10, sha256: 'x', preview: JSON.stringify({ anthropic: { model: 'claude-sonnet-5-5' }, upstream: { model: 'deepseek-v4-flash' } }), truncated: false },
      },
    }), { kind: 'sse', message: null, usage: null, model: 'deepseek-v4-flash-0915' })
    expect(summary).toMatchObject({
      route: 'proxy',
      url: 'https://api.deepseek.com/chat/completions',
      requestedModel: 'claude-sonnet-5-5',
      upstreamModel: 'deepseek-v4-flash',
      respondedModel: 'deepseek-v4-flash-0915',
    })
  })

  it('omits a responded model that only repeats what was sent', () => {
    const summary = summarizeTraceCall(call({ body: { model: 'claude-opus-5-5' } }), { kind: 'json', message: null, usage: null, model: 'claude-opus-5-5' })
    expect(summary.respondedModel).toBeUndefined()
  })

  it('still finds the model in a truncated body preview', () => {
    const summary = summarizeTraceCall(call({ model: undefined, preview: '{"model":"glm-5","messages":[{"role":"user","content":"…' }), null)
    expect(summary.requestedModel).toBe('glm-5')
  })

  it('ignores a redacted request id header', () => {
    const summary = summarizeTraceCall(call({
      response: { status: 200, headers: { 'X-Request-Id': '[REDACTED]', 'cf-ray': '8f1a2b' }, body: { contentType: 'json', bytes: 1, sha256: 'y', preview: '', truncated: false } },
    }), null)
    expect(summary.requestId).toBe('8f1a2b')
  })
})
