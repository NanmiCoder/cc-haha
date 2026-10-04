import { describe, expect, it, vi } from 'vitest'
import type { TraceCallRecord } from '../../types/trace'
import type { TraceCallsNear } from '../../types/trajectory'
import { findTraceCallForRow, scoreTraceCall } from './findTraceCall'
import { makeRow } from './trajectoryFixtures'

function at(seconds: number) {
  return new Date(Date.UTC(2026, 9, 4, 10, 0, 0) + seconds * 1000).toISOString()
}

function call(id: string, start: number, end: number, model = 'm'): TraceCallRecord {
  return {
    id,
    sessionId: 's',
    source: 'anthropic',
    model,
    status: 'ok',
    startedAt: at(start),
    completedAt: at(end),
    durationMs: (end - start) * 1000,
    request: { method: 'POST', url: '', headers: {}, body: { contentType: 'json', bytes: 0, sha256: '', preview: '', truncated: false } },
  } as TraceCallRecord
}

describe('scoreTraceCall', () => {
  const row = makeRow({ id: 'a:1', kind: 'assistant', startTs: at(100), ts: at(104), endTs: at(110), model: 'm' })

  it('rejects calls that started after the response began (beyond clock-skew slack)', () => {
    expect(scoreTraceCall(call('late', 107, 110), row)).toBeNull()
  })

  it('prefers the call that completed closest to the last response block', () => {
    const close = scoreTraceCall(call('close', 100, 110), row)!
    const far = scoreTraceCall(call('far', 100, 104), row)!
    expect(close).toBeLessThan(far)
  })

  it('penalizes a different model, so a parallel side query does not win', () => {
    const same = scoreTraceCall(call('same', 100, 111, 'm'), row)!
    const other = scoreTraceCall(call('other', 100, 110, 'haiku'), row)!
    expect(same).toBeLessThan(other)
  })
})

describe('findTraceCallForRow', () => {
  const row = makeRow({ id: 'a:x', kind: 'assistant', startTs: at(7350), ts: at(7355), endTs: at(7358), model: 'm' })

  it('asks the server for calls around the request window and picks the best', async () => {
    const load = vi.fn(async (): Promise<TraceCallsNear> => ({
      captured: true,
      revisionToken: 'rev',
      calls: [call('before', 7340, 7349), call('match', 7350, 7358), call('parallel', 7351, 7400)],
    }))
    const result = await findTraceCallForRow(row, load)
    expect(result).toMatchObject({ status: 'matched', call: { id: 'match' }, revisionKey: 'rev' })
    expect(load).toHaveBeenCalledTimes(1)
    const [from, to] = load.mock.calls[0] as unknown as [string, string]
    // The window starts before the request (skew slack) and ends just after the first block.
    expect(Date.parse(from)).toBe(Date.parse(at(7348)))
    expect(Date.parse(to)).toBe(Date.parse(at(7357)))
  })

  it('tells "never captured" apart from "captured but no match"', async () => {
    expect(await findTraceCallForRow(row, async () => ({ captured: false, calls: [] }))).toEqual({ status: 'uncaptured' })
    expect(await findTraceCallForRow(row, async () => ({ captured: true, calls: [call('late', 9000, 9001)] }))).toEqual({ status: 'unmatched' })
  })
})
