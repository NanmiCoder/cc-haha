/**
 * `GET /api/sessions/:id/trace/near` locates captured model calls by start
 * time, independent of which overview window the trace index holds, and the
 * `?at=` locator lets the call-detail route hydrate any of them.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { handleApiRequest } from '../router.js'
import {
  clearTraceCaptureStateForTests,
  drainTraceCaptureForTests,
  traceCaptureService,
  type TraceCallRecord,
} from '../services/traceCaptureService.js'
import { TRACE_WINDOW_RECORD_LIMIT } from '../../services/api/traceCapture.js'
import type { TraceCallsNear } from '../services/trajectoryTypes.js'

let tmpDir: string
const saved: Record<string, string | undefined> = {}
const ENV_KEYS = ['CLAUDE_CONFIG_DIR', 'CC_HAHA_LOCAL_INDEX', 'CC_HAHA_TRACE_API_CALLS'] as const

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'trace-near-'))
  for (const key of ENV_KEYS) saved[key] = process.env[key]
  process.env.CLAUDE_CONFIG_DIR = tmpDir
  process.env.CC_HAHA_LOCAL_INDEX = 'on'
  process.env.CC_HAHA_TRACE_API_CALLS = '1'
  clearTraceCaptureStateForTests()
})

afterEach(async () => {
  await drainTraceCaptureForTests()
  clearTraceCaptureStateForTests()
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
  await fs.rm(tmpDir, { recursive: true, force: true })
})

type NearBody = TraceCallsNear & { calls: TraceCallRecord[] }

async function get(pathname: string): Promise<Response> {
  const url = new URL(pathname, 'http://localhost:3456')
  return handleApiRequest(new Request(url.toString(), { method: 'GET' }), url)
}

async function near(sessionId: string, from: string, to: string): Promise<NearBody> {
  const response = await get(`/api/sessions/${sessionId}/trace/near?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`)
  expect(response.status).toBe(200)
  return await response.json() as NearBody
}

const at = (minute: number, second = 0) => new Date(Date.UTC(2026, 9, 4, 1, minute, second)).toISOString()

async function recordCalls(sessionId: string, minutes: number[]) {
  for (const minute of minutes) {
    await traceCaptureService.recordCall({
      id: `call-${minute}`, sessionId, source: 'proxy', model: 'fixture-model',
      startedAt: at(minute), completedAt: at(minute, 5), durationMs: 5000,
      request: { body: { model: 'fixture-model', marker: `request-${minute}` } },
      response: { status: 200, body: { ok: true } },
    })
  }
}

describe('GET /api/sessions/:id/trace/near', () => {
  test('answers from the trace index oldest first and caps the result', async () => {
    // Recorded out of start order: the index sorts by startedAt.
    await recordCalls('near-indexed', [5, 3, 4, 10, 1])
    const body = await near('near-indexed', at(3), at(5))
    expect(body.captured).toBe(true)
    expect(body.calls.map(call => call.id)).toEqual(['call-3', 'call-4', 'call-5'])
    expect(body.calls[0]).toMatchObject({ model: 'fixture-model', startedAt: at(3), status: 'ok' })
    expect(body.revisionToken).toBeString()
    expect(body.limited).toBeUndefined()
    expect(Object.keys(body.locs ?? {})).toEqual(['call-3', 'call-4', 'call-5'])

    const detail = await get(`/api/sessions/near-indexed/trace/calls/call-4?at=${body.locs!['call-4']}`)
    expect(detail.status).toBe(200)
    expect(JSON.stringify((await detail.json() as { call: TraceCallRecord }).call.request.body)).toContain('request-4')

    await recordCalls('near-cap', Array.from({ length: 55 }, (_, n) => n))
    const capped = await near('near-cap', at(0), at(59))
    expect(capped.calls).toHaveLength(50)
    expect(capped.calls[0]!.id).toBe('call-0')
    expect(capped.calls.at(-1)!.id).toBe('call-49')
    expect(capped.limited).toBe(true)
  })

  test('falls back to the bounded scan when the index is off with the same answer', async () => {
    await recordCalls('near-scan', [5, 3, 4, 10, 1])
    const indexed = await near('near-scan', at(3), at(5))
    process.env.CC_HAHA_LOCAL_INDEX = 'off'
    clearTraceCaptureStateForTests()
    const scanned = await near('near-scan', at(3), at(5))
    expect(scanned.calls.map(call => call.id)).toEqual(indexed.calls.map(call => call.id))
    expect(scanned.locs).toEqual(indexed.locs)
    expect(scanned.captured).toBe(true)
    expect((await near('near-scan', at(30), at(40))).calls).toEqual([])
  })

  test('reaches calls beyond the indexed overview window and hydrates them through the locator', async () => {
    const sessionId = 'near-large'
    const tracePath = path.join(tmpDir, 'cc-haha', 'traces', `${sessionId}.jsonl`)
    await fs.mkdir(path.dirname(tracePath), { recursive: true })
    const total = TRACE_WINDOW_RECORD_LIMIT + 500
    const base = Date.UTC(2026, 9, 4, 0, 0, 0)
    const iso = (n: number, offsetMs = 0) => new Date(base + n * 1000 + offsetMs).toISOString()
    const lines: string[] = []
    for (let n = 0; n < total; n++) {
      lines.push(JSON.stringify({ type: 'call', record: {
        id: `big-${n}`, sessionId, source: 'proxy', model: 'fixture-model', status: 'ok',
        startedAt: iso(n), completedAt: iso(n, 500), durationMs: 500,
        request: { method: 'POST', url: 'https://example.invalid/v1/messages', headers: {}, body: { contentType: 'json', bytes: 2, sha256: '', preview: `{"n":${n}}`, truncated: false } },
        response: { status: 200, headers: {}, body: { contentType: 'json', bytes: 2, sha256: '', preview: '{}', truncated: false } },
      } }))
      if (n % 1000 === 0) lines.push(JSON.stringify({ type: 'event', event: { id: `ev-${n}`, sessionId, timestamp: iso(n, 600), phase: 'note', severity: 'info' } }))
    }
    await fs.writeFile(tracePath, lines.join('\n') + '\n')

    // The overview window stops at the record limit, so the tail is not in it.
    const overview = await get(`/api/sessions/${sessionId}/trace`)
    expect(((await overview.json()) as { window: { state: string } }).window.state).toBe('limited')

    const tail = total - 3
    const body = await near(sessionId, iso(tail), iso(tail + 1))
    expect(body.captured).toBe(true)
    expect(body.calls.map(call => call.id)).toEqual([`big-${tail}`, `big-${tail + 1}`])
    expect(body.limited).toBeUndefined()

    const loc = body.locs![`big-${tail}`]!
    const detail = await get(`/api/sessions/${sessionId}/trace/calls/big-${tail}?at=${loc}`)
    expect(detail.status).toBe(200)
    expect((await detail.json() as { call: TraceCallRecord }).call.request.body.preview).toBe(`{"n":${tail}}`)
    // Without the locator the detail route only searches the first window.
    expect((await get(`/api/sessions/${sessionId}/trace/calls/big-${tail}`)).status).not.toBe(200)
    // A locator naming another call's record never hydrates the wrong call.
    expect((await get(`/api/sessions/${sessionId}/trace/calls/big-${tail + 1}?at=${loc}`)).status).not.toBe(200)
    const [start, end] = loc.split('-').map(Number) as [number, number]
    expect((await get(`/api/sessions/${sessionId}/trace/calls/big-${tail}?at=${start + 1}-${end}`)).status).not.toBe(200)

    // An early window lands in the middle of the file through the binary search.
    const early = await near(sessionId, iso(42), iso(44))
    expect(early.calls.map(call => call.id)).toEqual(['big-42', 'big-43', 'big-44'])
  })

  test('reports no capture without 404 and validates the window', async () => {
    expect(await near('no-such-session', at(0), at(1))).toEqual({ calls: [], captured: false })
    await recordCalls('near-validate', [1])
    const bad = [
      `to=${encodeURIComponent(at(1))}`,
      `from=${encodeURIComponent(at(1))}`,
      `from=yesterday&to=${encodeURIComponent(at(1))}`,
      `from=1696380000000&to=1696380060000`,
      `from=${encodeURIComponent(at(5))}&to=${encodeURIComponent(at(1))}`,
      `from=${encodeURIComponent(at(0))}&to=${encodeURIComponent(new Date(Date.parse(at(0)) + 61 * 60 * 1000).toISOString())}`,
    ]
    for (const query of bad) {
      const response = await get(`/api/sessions/near-validate/trace/near?${query}`)
      expect({ query, status: response.status }).toEqual({ query, status: 400 })
    }
    for (const locator of ['abc', '10-5', '5-5', '-1-4']) {
      const response = await get(`/api/sessions/near-validate/trace/calls/call-1?at=${locator}`)
      expect({ locator, status: response.status }).toEqual({ locator, status: 400 })
    }
  })
})
