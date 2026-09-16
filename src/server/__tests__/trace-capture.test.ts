import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { createHash } from 'crypto'
import { promises as mutableFs } from 'fs'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import { handleApiRequest } from '../router.js'
import {
  captureResponseTraceSnapshot,
  clearTraceCaptureStateForTests,
  createTraceCallId,
  createTraceBodySnapshot,
  getTraceCaptureDiagnosticsForTests,
  readResponseTraceSnapshot,
  setTraceAppendBeforeWriteHookForTests,
  setTraceFullSnapshotAfterReadHookForTests,
  setTraceProjectionAfterIndexHookForTests,
  traceCaptureService,
  updateTraceCaptureSettings,
} from '../services/traceCaptureService.js'
import { sessionService } from '../services/sessionService.js'
import { createDumpPromptsFetch } from '../../services/api/dumpPrompts.js'
import { buildOpenAICodexFetch } from '../../services/openaiAuth/fetch.js'
import { clearOpenAIOAuthTokenCache } from '../../services/openaiAuth/storage.js'
import { getTraceIndexDatabasePath } from '../services/localIndex/traceDatabase.js'

let tmpDir: string
let originalConfigDir: string | undefined
let originalLocalIndexMode: string | undefined

async function waitForTrace(
  sessionId: string,
  predicate: (trace: Awaited<ReturnType<typeof traceCaptureService.getSessionTrace>>) => boolean,
) {
  for (let attempt = 0; attempt < 30; attempt++) {
    const trace = await traceCaptureService.getSessionTrace(sessionId)
    if (predicate(trace)) return trace
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  return traceCaptureService.getSessionTrace(sessionId)
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'trace-capture-'))
  originalConfigDir = process.env.CLAUDE_CONFIG_DIR
  originalLocalIndexMode = process.env.CC_HAHA_LOCAL_INDEX
  process.env.CLAUDE_CONFIG_DIR = tmpDir
  process.env.CC_HAHA_LOCAL_INDEX = 'on'
  clearTraceCaptureStateForTests()
})

afterEach(async () => {
  clearTraceCaptureStateForTests()
  if (originalConfigDir === undefined) {
    delete process.env.CLAUDE_CONFIG_DIR
  } else {
    process.env.CLAUDE_CONFIG_DIR = originalConfigDir
  }
  if (originalLocalIndexMode === undefined) {
    delete process.env.CC_HAHA_LOCAL_INDEX
  } else {
    process.env.CC_HAHA_LOCAL_INDEX = originalLocalIndexMode
  }
  await fs.rm(tmpDir, { recursive: true, force: true })
})

describe('trace capture service', () => {
  test('reads legacy metadata without protocol summaries alongside additive diagnostic metadata', async () => {
    const common = {
      sessionId: 'protocol-metadata-upgrade', source: 'proxy' as const,
      startedAt: '2026-06-09T08:00:00.000Z', completedAt: '2026-06-09T08:00:01.000Z',
      request: { body: { model: 'fixture' } }, response: { status: 200, body: { ok: true } },
    }
    await traceCaptureService.recordCall({ ...common, id: 'legacy', metadata: { phase: 'upstream_fetch_completed', futureField: 'preserve' } })
    const protocolTrace = {
      version: 1, protocol: 'openai_chat', transport: 'eof',
      termination: { finishReason: 'length' },
      usage: { completion_tokens: 64 },
      outputBudget: { field: 'max_completion_tokens', effective: 64, source: 'explicit', wireFields: { max_completion_tokens: 64 } },
    }
    await traceCaptureService.recordCall({ ...common, id: 'current', metadata: { phase: 'upstream_fetch_completed', protocolTrace } })
    clearTraceCaptureStateForTests()
    const trace = await traceCaptureService.getSessionTrace(common.sessionId)
    expect(trace.calls.find(call => call.id === 'legacy')?.metadata).toEqual({ phase: 'upstream_fetch_completed', futureField: 'preserve' })
    expect(trace.calls.find(call => call.id === 'current')?.metadata?.protocolTrace).toEqual(protocolTrace)
  })

  test('keeps a queued trace append and projection in the scope captured by its caller', async () => {
    const root = tmpDir
    const scopeA = path.join(root, 'scope-a')
    const scopeB = path.join(root, 'scope-b')
    process.env.CLAUDE_CONFIG_DIR = scopeA

    let releaseWrite: () => void = () => {}
    const blockedWrite = new Promise<void>(resolve => {
      releaseWrite = resolve
    })
    let signalQueued: () => void = () => {}
    const queued = new Promise<void>(resolve => {
      signalQueued = resolve
    })
    setTraceAppendBeforeWriteHookForTests(async () => {
      setTraceAppendBeforeWriteHookForTests(null)
      signalQueued()
      await blockedWrite
    })

    const pending = traceCaptureService.recordCall({
      id: 'scope-a-call',
      sessionId: 'scope-frozen',
      source: 'proxy',
      startedAt: '2026-07-15T00:00:00.000Z',
      completedAt: '2026-07-15T00:00:00.001Z',
      request: { body: { marker: 'scope-a-private-body' } },
      response: { status: 200, body: { ok: true } },
    })
    await queued
    process.env.CLAUDE_CONFIG_DIR = scopeB
    releaseWrite()
    await pending

    const canonicalA = path.join(
      scopeA,
      'cc-haha',
      'traces',
      'scope-frozen.jsonl',
    )
    const canonicalB = path.join(
      scopeB,
      'cc-haha',
      'traces',
      'scope-frozen.jsonl',
    )
    expect(await fs.readFile(canonicalA, 'utf8')).toContain('scope-a-private-body')
    await expect(fs.stat(canonicalB)).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await fs.lstat(path.join(
      scopeA,
      'cc-haha',
      'db',
      'trace-index-v1.sqlite',
    ))).isFile()).toBe(true)
    await expect(fs.stat(path.join(
      scopeB,
      'cc-haha',
      'db',
      'trace-index-v1.sqlite',
    ))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('keeps interleaved scope projections on independent live database handles', async () => {
    const root = tmpDir
    const scopeA = path.join(root, 'scope-a')
    const scopeB = path.join(root, 'scope-b')
    process.env.CLAUDE_CONFIG_DIR = scopeA
    let releaseA: () => void = () => {}
    const blockedA = new Promise<void>(resolve => {
      releaseA = resolve
    })
    let signalA: () => void = () => {}
    const aHasIndex = new Promise<void>(resolve => {
      signalA = resolve
    })
    let blocked = false
    setTraceProjectionAfterIndexHookForTests(async target => {
      if (target.scope !== scopeA || blocked) return
      blocked = true
      signalA()
      await blockedA
    })

    const record = (id: string) => traceCaptureService.recordCall({
      id,
      sessionId: id,
      source: 'proxy',
      startedAt: '2026-07-15T00:00:00.000Z',
      completedAt: '2026-07-15T00:00:00.001Z',
      request: { body: { marker: id } },
      response: { status: 200, body: { ok: true } },
    })
    const pendingA = record('scope-a-session')
    await aHasIndex
    process.env.CLAUDE_CONFIG_DIR = scopeB
    await record('scope-b-session')
    releaseA()
    await pendingA
    setTraceProjectionAfterIndexHookForTests(null)

    for (const [scope, sessionId] of [
      [scopeA, 'scope-a-session'],
      [scopeB, 'scope-b-session'],
    ] as const) {
      const database = new Database(path.join(
        scope,
        'cc-haha',
        'db',
        'trace-index-v1.sqlite',
      ), { readonly: true })
      expect(database.query<{ state: string; last_error_code: string | null }, [string]>(`
        SELECT state, last_error_code FROM trace_sources WHERE session_id = ?
      `).get(sessionId)).toEqual({ state: 'ready', last_error_code: null })
      database.close(true)
    }
  })

  test('does not degrade scope B when a delayed scope A projection fails', async () => {
    const root = tmpDir
    const scopeA = path.join(root, 'scope-a')
    const scopeB = path.join(root, 'scope-b')
    process.env.CLAUDE_CONFIG_DIR = scopeA
    let releaseA: () => void = () => {}
    const blockedA = new Promise<void>(resolve => {
      releaseA = resolve
    })
    let signalA: () => void = () => {}
    const aHasIndex = new Promise<void>(resolve => {
      signalA = resolve
    })
    let blocked = false
    setTraceProjectionAfterIndexHookForTests(async target => {
      if (target.scope !== scopeA || blocked) return
      blocked = true
      signalA()
      await blockedA
    })
    const record = (id: string) => traceCaptureService.recordCall({
      id,
      sessionId: id,
      source: 'proxy',
      startedAt: '2026-07-15T00:00:00.000Z',
      completedAt: '2026-07-15T00:00:00.001Z',
      request: { body: { marker: id } },
      response: { status: 200, body: { ok: true } },
    })

    const pendingA = record('failing-a-session')
    await aHasIndex
    process.env.CLAUDE_CONFIG_DIR = scopeB
    await record('healthy-b-session')
    await fs.rm(path.join(
      scopeA,
      'cc-haha',
      'traces',
      'failing-a-session.jsonl',
    ))
    releaseA()
    await pendingA
    setTraceProjectionAfterIndexHookForTests(null)

    const databaseB = new Database(path.join(
      scopeB,
      'cc-haha',
      'db',
      'trace-index-v1.sqlite',
    ), { readonly: true })
    expect(databaseB.query<{
      state: string
      last_error_code: string | null
    }, [string]>(`
      SELECT state, last_error_code FROM trace_sources WHERE session_id = ?
    `).get('healthy-b-session')).toEqual({
      state: 'ready',
      last_error_code: null,
    })
    databaseB.close(true)
  })

  test('keeps a trace-list request on one captured scope across an environment switch', async () => {
    const root = tmpDir
    const scopeA = path.join(root, 'scope-a')
    const scopeB = path.join(root, 'scope-b')
    const record = (model: string) => traceCaptureService.recordCall({
      id: `${model}-call`,
      sessionId: 'request-scope-session',
      source: 'proxy',
      model,
      startedAt: '2026-07-15T00:00:00.000Z',
      completedAt: '2026-07-15T00:00:00.001Z',
      request: { body: { marker: model } },
      response: { status: 200, body: { ok: true } },
    })
    process.env.CLAUDE_CONFIG_DIR = scopeA
    await record('scope-a-model')
    process.env.CLAUDE_CONFIG_DIR = scopeB
    await record('scope-b-model')
    process.env.CLAUDE_CONFIG_DIR = scopeA
    process.env.CC_HAHA_LOCAL_INDEX = 'off'

    const traceDirA = path.join(scopeA, 'cc-haha', 'traces')
    const originalReaddir = mutableFs.readdir.bind(mutableFs)
    let switched = false
    const readdirSpy = spyOn(mutableFs, 'readdir').mockImplementation(
      async (...args) => {
        const result = await originalReaddir(...args)
        if (!switched && args[0] === traceDirA) {
          switched = true
          process.env.CLAUDE_CONFIG_DIR = scopeB
        }
        return result
      },
    )
    try {
      const list = await traceCaptureService.listSessionTraces()
      expect(switched).toBe(true)
      expect(list.storageDir).toBe(traceDirA)
      expect(list.settings.storageDir).toBe(traceDirA)
      expect(list.traces[0]?.summary.models).toEqual([
        { model: 'scope-a-model', calls: 1 },
      ])
    } finally {
      readdirSpy.mockRestore()
    }
  })

  test('stores session scoped API calls with redacted headers and capped bodies', async () => {
    const body = {
      model: 'deepseek-v4-pro',
      api_key: 'sk-body-secret',
      messages: [
        { role: 'user', content: 'explain the failed provider response' },
      ],
      padding: 'x'.repeat(250_000),
    }

    await traceCaptureService.recordCall({
      sessionId: 'session-trace-1',
      source: 'proxy',
      querySource: 'repl_main_thread',
      provider: {
        id: 'provider-deepseek',
        name: 'DeepSeek',
        format: 'openai_chat',
      },
      model: 'deepseek-v4-pro',
      startedAt: '2026-06-09T08:00:00.000Z',
      completedAt: '2026-06-09T08:00:00.047Z',
      durationMs: 47,
      request: {
        method: 'POST',
        url: 'https://api.deepseek.com/v1/chat/completions',
        headers: {
          Authorization: 'Bearer sk-header-secret',
          'Content-Type': 'application/json',
        },
        body,
      },
      response: {
        status: 200,
        headers: {
          'x-request-id': 'req-742',
        },
        body: {
          id: 'chatcmpl-742',
          choices: [{ message: { role: 'assistant', content: 'ok' } }],
          usage: { prompt_tokens: 31, completion_tokens: 7 },
        },
      },
    })

    const trace = await traceCaptureService.getSessionTrace('session-trace-1')

    expect(trace.summary.apiCalls).toBe(1)
    expect(trace.summary.failedCalls).toBe(0)
    expect(trace.summary.totalDurationMs).toBe(47)
    expect(trace.summary.totalInputTokens).toBe(31)
    expect(trace.summary.totalOutputTokens).toBe(7)
    expect(trace.summary.models).toEqual([{ model: 'deepseek-v4-pro', calls: 1 }])
    expect(trace.calls[0].request.headers.Authorization).toBe('[redacted]')
    expect(trace.calls[0].request.body.preview).toContain('explain the failed provider response')
    expect(trace.calls[0].request.body.preview).not.toContain('sk-body-secret')
    expect(trace.calls[0].request.body.preview.length).toBe(240_000)
    expect(trace.calls[0].request.body.bytes).toBeGreaterThan(240_000)
    expect(trace.calls[0].request.body.truncated).toBe(true)
    expect(trace.calls[0].response.body.preview).toContain('chatcmpl-742')
    expect(trace.calls[0].usage).toEqual({ inputTokens: 31, outputTokens: 7 })
  })

  test('builds stable body snapshots without throwing on non-json input', () => {
    const snapshot = createTraceBodySnapshot('plain text response', { maxPreviewChars: 20 })

    expect(snapshot.contentType).toBe('text')
    expect(snapshot.preview).toBe('plain text response')
    expect(snapshot.truncated).toBe(false)
    expect(snapshot.sha256).toMatch(/^[0-9a-f]{64}$/)
  })

  test('redacts secret token keys while preserving token-count fields', async () => {
    await traceCaptureService.recordCall({
      sessionId: 'session-redact-boundary',
      source: 'anthropic',
      model: 'claude-fable-5',
      startedAt: '2026-06-09T08:00:00.000Z',
      completedAt: '2026-06-09T08:00:00.050Z',
      durationMs: 50,
      request: {
        method: 'POST',
        url: 'https://api.anthropic.com/v1/messages',
        body: {
          model: 'claude-fable-5',
          max_tokens: 4096,
          access_token: 'super-secret-value',
          refresh_token: 'another-secret-value',
        },
      },
      response: {
        status: 200,
        body: {
          id: 'msg-redact-boundary',
          usage: { input_tokens: 12, output_tokens: 34 },
        },
      },
    })

    const trace = await traceCaptureService.getSessionTrace('session-redact-boundary')
    const requestPreview = trace.calls[0].request.body.preview

    expect(requestPreview).toContain('"max_tokens": 4096')
    expect(requestPreview).not.toContain('super-secret-value')
    expect(requestPreview).not.toContain('another-secret-value')
    expect(trace.calls[0].response?.body.preview).toContain('"input_tokens": 12')
    expect(trace.calls[0].usage).toEqual({ inputTokens: 12, outputTokens: 34 })
  })

  test('captures streamed response bodies up to 1MB before truncating', async () => {
    const chunk = 'a'.repeat(64 * 1024)
    const makeResponse = (chunkCount: number) => new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          for (let index = 0; index < chunkCount; index++) {
            controller.enqueue(new TextEncoder().encode(chunk))
          }
          controller.close()
        },
      }),
      { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
    )

    const midSized = await readResponseTraceSnapshot(makeResponse(6))
    expect(midSized.bytes).toBe(6 * 64 * 1024)
    expect(midSized.sha256).toBe(createHash('sha256').update(chunk.repeat(6)).digest('hex'))
    expect(midSized.preview.length).toBe(240_000)
    expect(midSized.truncated).toBe(true)

    const oversized = await readResponseTraceSnapshot(makeResponse(17))
    expect(oversized.bytes).toBe(1024 * 1024)
    expect(oversized.truncated).toBe(true)
  })

  test('extracts per-call usage from non-streaming anthropic JSON responses', async () => {
    await traceCaptureService.recordCall({
      sessionId: 'session-usage-json',
      source: 'anthropic',
      model: 'claude-fable-5',
      startedAt: '2026-06-09T08:00:00.000Z',
      completedAt: '2026-06-09T08:00:01.000Z',
      durationMs: 1000,
      request: {
        method: 'POST',
        url: 'https://api.anthropic.com/v1/messages',
        body: { model: 'claude-fable-5', messages: [{ role: 'user', content: 'usage me' }] },
      },
      response: {
        status: 200,
        body: {
          id: 'msg-usage-json',
          content: [{ type: 'text', text: 'ok' }],
          usage: {
            input_tokens: 1200,
            output_tokens: 350,
            cache_read_input_tokens: 800,
            cache_creation_input_tokens: 45,
          },
        },
      },
    })

    const trace = await traceCaptureService.getSessionTrace('session-usage-json')

    expect(trace.calls[0].usage).toEqual({
      inputTokens: 1200,
      outputTokens: 350,
      cacheReadInputTokens: 800,
      cacheCreationInputTokens: 45,
    })
    expect(trace.summary.totalInputTokens).toBe(1200)
    expect(trace.summary.totalOutputTokens).toBe(350)
  })

  test('extracts per-call usage from streaming SSE previews by merging message_start and message_delta', async () => {
    const sseBody = [
      'event: message_start',
      'data: {"type":"message_start","message":{"id":"msg_stream","model":"claude-fable-5","usage":{"input_tokens":2500,"output_tokens":2,"cache_read_input_tokens":1800,"cache_creation_input_tokens":90}}}',
      '',
      'event: content_block_delta',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hello"}}',
      '',
      'event: message_delta',
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":640}}',
      '',
      'event: message_stop',
      'data: {"type":"message_stop"}',
      '',
    ].join('\n')

    await traceCaptureService.recordCall({
      sessionId: 'session-usage-sse',
      source: 'anthropic',
      model: 'claude-fable-5',
      startedAt: '2026-06-09T08:00:00.000Z',
      completedAt: '2026-06-09T08:00:02.000Z',
      durationMs: 2000,
      request: {
        method: 'POST',
        url: 'https://api.anthropic.com/v1/messages',
        body: { model: 'claude-fable-5', stream: true },
      },
      response: {
        status: 200,
        body: sseBody,
      },
    })

    const trace = await traceCaptureService.getSessionTrace('session-usage-sse')

    expect(trace.calls[0].usage).toEqual({
      inputTokens: 2500,
      outputTokens: 640,
      cacheReadInputTokens: 1800,
      cacheCreationInputTokens: 90,
    })
    expect(trace.summary.totalInputTokens).toBe(2500)
    expect(trace.summary.totalOutputTokens).toBe(640)
  })

  test('extracts per-call usage from the anthropic side of proxy response wrappers', async () => {
    await traceCaptureService.recordCall({
      sessionId: 'session-usage-proxy',
      source: 'proxy',
      model: 'deepseek-v4-pro',
      startedAt: '2026-06-09T08:00:00.000Z',
      completedAt: '2026-06-09T08:00:01.500Z',
      durationMs: 1500,
      request: {
        method: 'POST',
        url: 'https://api.deepseek.com/v1/chat/completions',
        body: {
          anthropic: { model: 'deepseek-v4-pro' },
          upstream: { model: 'deepseek-chat' },
        },
      },
      response: {
        status: 200,
        body: {
          upstream: { usage: { prompt_tokens: 999, completion_tokens: 111 } },
          anthropic: {
            id: 'msg-proxy-usage',
            usage: {
              input_tokens: 77,
              output_tokens: 33,
              cache_read_input_tokens: 5,
              cache_creation_input_tokens: 0,
            },
          },
        },
      },
    })

    const trace = await traceCaptureService.getSessionTrace('session-usage-proxy')

    expect(trace.calls[0].usage).toEqual({
      inputTokens: 77,
      outputTokens: 33,
      cacheReadInputTokens: 5,
      cacheCreationInputTokens: 0,
    })
    expect(trace.summary.totalInputTokens).toBe(77)
    expect(trace.summary.totalOutputTokens).toBe(33)
  })

  test('omits usage when the response preview is missing, truncated or unparsable', async () => {
    await traceCaptureService.recordCall({
      id: 'call-usage-truncated',
      sessionId: 'session-usage-missing',
      source: 'anthropic',
      model: 'claude-fable-5',
      startedAt: '2026-06-09T08:00:00.000Z',
      completedAt: '2026-06-09T08:00:01.000Z',
      durationMs: 1000,
      request: {
        method: 'POST',
        url: 'https://api.anthropic.com/v1/messages',
        body: { model: 'claude-fable-5' },
      },
      response: {
        status: 200,
        bodySnapshot: createTraceBodySnapshot(
          { id: 'msg-truncated', usage: { input_tokens: 100, output_tokens: 50 } },
          { maxPreviewChars: 24 },
        ),
      },
    })
    await traceCaptureService.recordCall({
      id: 'call-usage-pending',
      sessionId: 'session-usage-missing',
      source: 'anthropic',
      model: 'claude-fable-5',
      status: 'pending',
      startedAt: '2026-06-09T08:00:02.000Z',
      request: {
        method: 'POST',
        url: 'https://api.anthropic.com/v1/messages',
        body: { model: 'claude-fable-5' },
      },
    })
    await traceCaptureService.recordCall({
      id: 'call-usage-absent',
      sessionId: 'session-usage-missing',
      source: 'anthropic',
      model: 'claude-fable-5',
      startedAt: '2026-06-09T08:00:03.000Z',
      completedAt: '2026-06-09T08:00:04.000Z',
      durationMs: 1000,
      request: {
        method: 'POST',
        url: 'https://api.anthropic.com/v1/messages',
        body: { model: 'claude-fable-5' },
      },
      response: {
        status: 200,
        body: { ok: true },
      },
    })

    const trace = await traceCaptureService.getSessionTrace('session-usage-missing')

    expect(trace.calls).toHaveLength(3)
    expect(trace.calls[0].response?.body.truncated).toBe(true)
    for (const call of trace.calls) {
      expect(call.usage).toBeUndefined()
    }
    expect(trace.summary.totalInputTokens).toBe(0)
    expect(trace.summary.totalOutputTokens).toBe(0)
  })

  test('skips malformed trace jsonl entries when reading a session', async () => {
    const traceDir = path.join(tmpDir, 'cc-haha', 'traces')
    await fs.mkdir(traceDir, { recursive: true })
    await fs.writeFile(path.join(traceDir, 'session-corrupt.jsonl'), [
      'not-json',
      'null',
      '{}',
      JSON.stringify({
        type: 'event',
        event: {
          id: 'event-valid',
          sessionId: 'session-corrupt',
          timestamp: '2026-06-09T08:00:00.001Z',
          phase: 'api_call_started',
          severity: 'info',
        },
      }),
      JSON.stringify({
        type: 'call',
        record: {
          id: 'call-valid',
          sessionId: 'session-corrupt',
          source: 'proxy',
          status: 'ok',
          startedAt: '2026-06-09T08:00:00.000Z',
          completedAt: '2026-06-09T08:00:00.020Z',
          durationMs: 20,
          request: {
            method: 'POST',
            url: 'https://api.example.test/v1/chat/completions',
            headers: {},
            body: createTraceBodySnapshot({ model: 'gpt-5.5' }),
          },
          response: {
            status: 200,
            headers: {},
            body: createTraceBodySnapshot({ ok: true }),
          },
        },
      }),
    ].join('\n'))

    const trace = await traceCaptureService.getSessionTrace('session-corrupt')

    expect(trace.calls.map((call) => call.id)).toEqual(['call-valid'])
    // Pre-semantic JSONL remains readable; the desktop falls back to parsing
    // its complete raw body and retains the legacy path for truncated bodies.
    expect(trace.calls[0].request.semantic).toBeUndefined()
    expect(trace.events.map((event) => event.id)).toEqual(['event-valid'])
    expect(trace.summary.apiCalls).toBe(1)
  })

  test('upserts pending calls and preserves lifecycle events', async () => {
    const callId = createTraceCallId()
    await traceCaptureService.recordCall({
      id: callId,
      sessionId: 'session-trace-upsert',
      source: 'anthropic',
      model: 'gpt-5.5',
      status: 'pending',
      startedAt: '2026-06-09T08:00:00.000Z',
      request: {
        method: 'POST',
        url: 'https://sub2api.example.test/v1/messages',
        body: { model: 'gpt-5.5', messages: [{ role: 'user', content: 'pending' }] },
      },
    })
    await traceCaptureService.recordEvent({
      sessionId: 'session-trace-upsert',
      callId,
      phase: 'api_call_started',
      source: 'anthropic',
      model: 'gpt-5.5',
    })
    await traceCaptureService.recordCall({
      id: callId,
      sessionId: 'session-trace-upsert',
      source: 'anthropic',
      model: 'gpt-5.5',
      startedAt: '2026-06-09T08:00:00.000Z',
      completedAt: '2026-06-09T08:00:00.120Z',
      durationMs: 120,
      request: {
        method: 'POST',
        url: 'https://sub2api.example.test/v1/messages',
        body: { model: 'gpt-5.5', messages: [{ role: 'user', content: 'pending' }] },
      },
      response: {
        status: 200,
        body: { id: 'msg-upsert' },
      },
    })

    const trace = await traceCaptureService.getSessionTrace('session-trace-upsert')

    expect(trace.summary.apiCalls).toBe(1)
    expect(trace.calls).toHaveLength(1)
    expect(trace.calls[0].id).toBe(callId)
    expect(trace.calls[0].status).toBe('ok')
    expect(trace.events).toHaveLength(1)
    expect(trace.events[0]).toMatchObject({
      phase: 'api_call_started',
      callId,
      source: 'anthropic',
    })
  })

  test('respects managed trace capture settings before writing new records', async () => {
    await updateTraceCaptureSettings({ enabled: false })

    const result = await traceCaptureService.recordCall({
      sessionId: 'session-trace-disabled',
      source: 'proxy',
      model: 'gpt-5.5',
      request: {
        method: 'POST',
        url: 'https://api.example.test/v1/messages',
        body: { model: 'gpt-5.5' },
      },
    })
    const trace = await traceCaptureService.getSessionTrace('session-trace-disabled')
    const settingsFile = JSON.parse(await fs.readFile(path.join(tmpDir, 'cc-haha', 'settings.json'), 'utf-8')) as {
      traceCapture?: { enabled?: boolean }
    }

    expect(result).toBeNull()
    expect(trace.summary.apiCalls).toBe(0)
    expect(settingsFile.traceCapture?.enabled).toBe(false)
  })

  test('captures direct Anthropic-compatible provider calls from desktop fetch override', async () => {
    const originalFetch = globalThis.fetch
    const originalTraceEnv = process.env.CC_HAHA_TRACE_API_CALLS
    const originalProviderId = process.env.CC_HAHA_TRACE_PROVIDER_ID
    const originalProviderName = process.env.CC_HAHA_TRACE_PROVIDER_NAME
    const originalProviderFormat = process.env.CC_HAHA_TRACE_PROVIDER_FORMAT
    process.env.CC_HAHA_TRACE_API_CALLS = '1'
    process.env.CC_HAHA_TRACE_PROVIDER_ID = 'provider-sub2api'
    process.env.CC_HAHA_TRACE_PROVIDER_NAME = 'Sub2API-ChatGPT'
    process.env.CC_HAHA_TRACE_PROVIDER_FORMAT = 'anthropic'
    try {
      globalThis.fetch = (async () => new Response(
        JSON.stringify({ id: 'msg-direct-trace', content: [{ type: 'text', text: 'ok' }] }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      )) as typeof fetch

      const traceFetch = createDumpPromptsFetch('agent-direct', {
        traceSessionId: 'session-direct-provider',
        querySource: 'test_query',
      })
      await traceFetch('https://sub2api.example.test/v1/messages', {
        method: 'POST',
        body: JSON.stringify({ model: 'gpt-5.5', messages: [{ role: 'user', content: 'trace me' }] }),
      })

      const trace = await waitForTrace(
        'session-direct-provider',
        (snapshot) => Boolean(snapshot.calls[0]?.response) && snapshot.events.length >= 2,
      )
      expect(trace.summary.apiCalls).toBe(1)
      expect(trace.calls[0]).toMatchObject({
        source: 'anthropic',
        model: 'gpt-5.5',
        querySource: 'test_query',
        provider: {
          id: 'provider-sub2api',
          name: 'Sub2API-ChatGPT',
          format: 'anthropic',
        },
      })
      expect(trace.calls[0].request.body.preview).toContain('trace me')
      expect(trace.calls[0].response.body.preview).toContain('msg-direct-trace')
      expect(trace.events.map((event) => event.phase)).toEqual(['api_call_started', 'api_call_completed'])
    } finally {
      globalThis.fetch = originalFetch
      if (originalTraceEnv === undefined) delete process.env.CC_HAHA_TRACE_API_CALLS
      else process.env.CC_HAHA_TRACE_API_CALLS = originalTraceEnv
      if (originalProviderId === undefined) delete process.env.CC_HAHA_TRACE_PROVIDER_ID
      else process.env.CC_HAHA_TRACE_PROVIDER_ID = originalProviderId
      if (originalProviderName === undefined) delete process.env.CC_HAHA_TRACE_PROVIDER_NAME
      else process.env.CC_HAHA_TRACE_PROVIDER_NAME = originalProviderName
      if (originalProviderFormat === undefined) delete process.env.CC_HAHA_TRACE_PROVIDER_FORMAT
      else process.env.CC_HAHA_TRACE_PROVIDER_FORMAT = originalProviderFormat
    }
  })

  test('audits trusted OAuth plaintext while the actual transport receives zstd bytes', async () => {
    const originalFetch = globalThis.fetch
    const overrides = { CC_HAHA_TRACE_API_CALLS: '1', OPENAI_CODEX_OAUTH_FILE: path.join(tmpDir, 'oauth-fixture.json'), CC_HAHA_OPENAI_REQUEST_COMPRESSION: 'true' }
    const prior = Object.fromEntries(Object.keys(overrides).map(key => [key, process.env[key]]))
    Object.assign(process.env, overrides)
    clearOpenAIOAuthTokenCache()
    await fs.writeFile(overrides.OPENAI_CODEX_OAUTH_FILE, JSON.stringify({ accessToken: 'fake-access-audit', refreshToken: 'fake-refresh-audit', expiresAt: Date.now() + 3600000 }))
    let wireBytes = 0
    let plainBody = ''
    try {
      globalThis.fetch = (async (_input, init) => {
        expect(new Headers(init?.headers).get('content-encoding')).toBe('zstd')
        expect(init?.body).toBeInstanceOf(Uint8Array)
        wireBytes = (init!.body as Uint8Array).byteLength
        plainBody = Buffer.from(await Bun.zstdDecompress(init!.body as Uint8Array)).toString('utf8')
        return Response.json({ id: 'resp_zstd_audit', object: 'response', model: 'gpt-6-astra', status: 'completed', output: [] })
      }) as typeof fetch
      const traced = createDumpPromptsFetch('zstd-audit', { traceSessionId: 'session-zstd-audit' })
      const codex = buildOpenAICodexFetch(traced, 'test')
      await (await codex('https://api.anthropic.com/v1/messages', {
        method: 'POST', headers: { 'X-Claude-Code-Session-Id': 'fixture-root' },
        body: JSON.stringify({ model: 'gpt-6-astra', max_tokens: 16, messages: [{ role: 'user', content: 'Audit 中文 '.repeat(1000) }] }),
      })).text()
      const trace = await waitForTrace('session-zstd-audit', snapshot => Boolean(snapshot.calls[0]?.response))
      expect(trace.calls).toHaveLength(1)
      const call = trace.calls[0]
      expect(call.request.headers['content-encoding']).toBe('zstd')
      expect(call.request.body.preview).toContain('Audit 中文')
      expect(call.request.semantic?.request).toMatchObject({ model: 'gpt-6-astra', prompt_cache_key: 'fixture-root' })
      expect(call.metadata).toMatchObject({ requestEncoding: 'zstd', requestPlainBytes: Buffer.byteLength(plainBody), requestWireBytes: wireBytes })
      expect(wireBytes).toBeLessThan(Buffer.byteLength(plainBody))
      expect(JSON.stringify(trace)).not.toContain('fake-access-audit')
    } finally {
      globalThis.fetch = originalFetch
      for (const key of Object.keys(overrides)) {
        if (prior[key] === undefined) delete process.env[key]
        else process.env[key] = prior[key]
      }
      clearOpenAIOAuthTokenCache()
    }
  })

  test('captures direct provider headers when fetch input is a Request', async () => {
    const originalFetch = globalThis.fetch
    const originalTraceEnv = process.env.CC_HAHA_TRACE_API_CALLS
    process.env.CC_HAHA_TRACE_API_CALLS = '1'
    try {
      globalThis.fetch = (async () => new Response(
        JSON.stringify({ id: 'msg-request-input', content: [{ type: 'text', text: 'ok' }] }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      )) as typeof fetch

      const traceFetch = createDumpPromptsFetch('agent-direct-request-input', {
        traceSessionId: 'session-direct-request-input',
        querySource: 'test_query',
      })
      const requestInput = new Request('https://sub2api.example.test/v1/messages', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer sk-direct-header-secret',
          'Content-Type': 'application/json',
        },
      })

      await traceFetch(requestInput, {
        method: 'POST',
        body: JSON.stringify({ model: 'gpt-5.5', messages: [{ role: 'user', content: 'request input' }] }),
      })

      const trace = await waitForTrace(
        'session-direct-request-input',
        (snapshot) => Boolean(snapshot.calls[0]?.response) && snapshot.events.length >= 2,
      )
      expect(trace.summary.apiCalls).toBe(1)
      expect(trace.calls[0].request.headers.authorization).toBe('[redacted]')
      expect(trace.calls[0].request.headers['content-type']).toBe('application/json')
      expect(trace.calls[0].request.body.preview).toContain('request input')
      expect(trace.calls[0].response.body.preview).toContain('msg-request-input')
    } finally {
      globalThis.fetch = originalFetch
      if (originalTraceEnv === undefined) delete process.env.CC_HAHA_TRACE_API_CALLS
      else process.env.CC_HAHA_TRACE_API_CALLS = originalTraceEnv
    }
  })

  test('captures direct provider fetch failures without changing thrown behavior', async () => {
    const originalFetch = globalThis.fetch
    const originalTraceEnv = process.env.CC_HAHA_TRACE_API_CALLS
    process.env.CC_HAHA_TRACE_API_CALLS = '1'
    try {
      globalThis.fetch = (async () => {
        throw new Error('network down for trace')
      }) as typeof fetch

      const traceFetch = createDumpPromptsFetch('agent-direct-fail', {
        traceSessionId: 'session-direct-provider-fail',
        querySource: 'test_query',
      })
      await expect(traceFetch('https://sub2api.example.test/v1/messages', {
        method: 'POST',
        body: JSON.stringify({ model: 'gpt-5.5', messages: [{ role: 'user', content: 'trace failure' }] }),
      })).rejects.toThrow('network down for trace')

      const trace = await waitForTrace(
        'session-direct-provider-fail',
        (snapshot) => Boolean(snapshot.calls[0]?.error) && snapshot.events.length >= 2,
      )
      expect(trace.summary.apiCalls).toBe(1)
      expect(trace.summary.failedCalls).toBe(1)
      expect(trace.calls[0]).toMatchObject({
        source: 'anthropic',
        model: 'gpt-5.5',
        status: 'error',
        error: {
          name: 'Error',
          message: 'network down for trace',
        },
      })
      expect(trace.calls[0].request.body.preview).toContain('trace failure')
      expect(trace.events.map((event) => event.phase)).toEqual(['api_call_started', 'api_call_failed'])
    } finally {
      globalThis.fetch = originalFetch
      if (originalTraceEnv === undefined) delete process.env.CC_HAHA_TRACE_API_CALLS
      else process.env.CC_HAHA_TRACE_API_CALLS = originalTraceEnv
    }
  })

  test('passes session id to local provider proxy without duplicating client-side trace', async () => {
    const originalFetch = globalThis.fetch
    const originalTraceEnv = process.env.CC_HAHA_TRACE_API_CALLS
    let seenHeader: string | null = null
    process.env.CC_HAHA_TRACE_API_CALLS = '1'
    try {
      globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
        seenHeader = new Headers(init?.headers).get('x-claude-code-session-id')
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }) as typeof fetch

      const traceFetch = createDumpPromptsFetch('agent-proxy', {
        traceSessionId: 'session-local-proxy',
        querySource: 'test_query',
      })
      await traceFetch('http://127.0.0.1:3456/proxy/providers/provider-1/v1/messages', {
        method: 'POST',
        body: JSON.stringify({ model: 'deepseek-v4-pro', messages: [{ role: 'user', content: 'proxy trace' }] }),
      })

      expect(seenHeader).toBe('session-local-proxy')
      const trace = await traceCaptureService.getSessionTrace('session-local-proxy')
      expect(trace.summary.apiCalls).toBe(0)
    } finally {
      globalThis.fetch = originalFetch
      if (originalTraceEnv === undefined) delete process.env.CC_HAHA_TRACE_API_CALLS
      else process.env.CC_HAHA_TRACE_API_CALLS = originalTraceEnv
    }
  })

  test('records an aborted error call when the request is aborted mid-stream', async () => {
    const originalFetch = globalThis.fetch
    const originalTraceEnv = process.env.CC_HAHA_TRACE_API_CALLS
    process.env.CC_HAHA_TRACE_API_CALLS = '1'
    try {
      // A stream that sends one chunk then goes silent forever, like the
      // wedged upstream in #766. The mock ignores the abort signal, so the
      // trace capture must end the read itself.
      globalThis.fetch = (async () => {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('data: {"type":"message_start"}\n\n'))
          },
        })
        return new Response(stream, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        })
      }) as typeof fetch

      const abortController = new AbortController()
      const traceFetch = createDumpPromptsFetch('agent-direct-abort', {
        traceSessionId: 'session-direct-abort',
        querySource: 'test_query',
      })
      await traceFetch('https://sub2api.example.test/v1/messages', {
        method: 'POST',
        body: JSON.stringify({ model: 'gpt-5.5', messages: [{ role: 'user', content: 'abort me' }] }),
        signal: abortController.signal,
      })

      // Let the capture loop start reading, then abort like the stream idle
      // watchdog (stream.controller.abort()) or SDK client timeout would.
      await new Promise((resolve) => setTimeout(resolve, 20))
      abortController.abort(new Error('Stream idle timeout: no chunks received for 240s'))

      const trace = await waitForTrace(
        'session-direct-abort',
        (snapshot) => snapshot.calls[0]?.status === 'error'
          && snapshot.events.some((event) => event.phase === 'api_call_aborted'),
      )
      expect(trace.summary.apiCalls).toBe(1)
      expect(trace.summary.failedCalls).toBe(1)
      expect(trace.calls[0]).toMatchObject({
        source: 'anthropic',
        model: 'gpt-5.5',
        status: 'error',
        metadata: { phase: 'api_call_aborted', aborted: true },
      })
      expect(trace.calls[0].error?.message).toContain('Stream idle timeout')
      expect(typeof trace.calls[0].durationMs).toBe('number')
      expect(trace.calls[0].response?.status).toBe(200)
      expect(trace.calls[0].response?.body.preview).toContain('message_start')
      expect(trace.calls[0].response?.body.truncated).toBe(true)
      expect(trace.events.map((event) => event.phase)).toEqual(['api_call_started', 'api_call_aborted'])
      expect(trace.events.at(-1)?.severity).toBe('error')
    } finally {
      globalThis.fetch = originalFetch
      if (originalTraceEnv === undefined) delete process.env.CC_HAHA_TRACE_API_CALLS
      else process.env.CC_HAHA_TRACE_API_CALLS = originalTraceEnv
    }
  })

  test('synthesizes an AbortError when the abort signal carries no reason', async () => {
    const originalFetch = globalThis.fetch
    const originalTraceEnv = process.env.CC_HAHA_TRACE_API_CALLS
    process.env.CC_HAHA_TRACE_API_CALLS = '1'
    try {
      globalThis.fetch = (async () => {
        const stream = new ReadableStream<Uint8Array>({
          start() {
            // No chunks at all: headers arrived, body never produces bytes.
          },
        })
        return new Response(stream, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        })
      }) as typeof fetch

      const abortController = new AbortController()
      const traceFetch = createDumpPromptsFetch('agent-direct-abort-bare', {
        traceSessionId: 'session-direct-abort-bare',
        querySource: 'test_query',
      })
      await traceFetch('https://sub2api.example.test/v1/messages', {
        method: 'POST',
        body: JSON.stringify({ model: 'gpt-5.5', messages: [{ role: 'user', content: 'abort bare' }] }),
        signal: abortController.signal,
      })
      await new Promise((resolve) => setTimeout(resolve, 20))
      abortController.abort()

      const trace = await waitForTrace(
        'session-direct-abort-bare',
        (snapshot) => snapshot.calls[0]?.status === 'error',
      )
      expect(trace.calls[0].status).toBe('error')
      expect(trace.calls[0].error?.name).toBe('AbortError')
      expect(trace.calls[0].metadata).toMatchObject({ phase: 'api_call_aborted', aborted: true })
    } finally {
      globalThis.fetch = originalFetch
      if (originalTraceEnv === undefined) delete process.env.CC_HAHA_TRACE_API_CALLS
      else process.env.CC_HAHA_TRACE_API_CALLS = originalTraceEnv
    }
  })

  test('keeps a completed call ok when the signal aborts after the response finished', async () => {
    const originalFetch = globalThis.fetch
    const originalTraceEnv = process.env.CC_HAHA_TRACE_API_CALLS
    process.env.CC_HAHA_TRACE_API_CALLS = '1'
    try {
      globalThis.fetch = (async () => new Response(
        JSON.stringify({ id: 'msg-late-abort', content: [{ type: 'text', text: 'ok' }] }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      )) as typeof fetch

      const abortController = new AbortController()
      const traceFetch = createDumpPromptsFetch('agent-late-abort', {
        traceSessionId: 'session-late-abort',
        querySource: 'test_query',
      })
      await traceFetch('https://sub2api.example.test/v1/messages', {
        method: 'POST',
        body: JSON.stringify({ model: 'gpt-5.5', messages: [{ role: 'user', content: 'late abort' }] }),
        signal: abortController.signal,
      })

      const completed = await waitForTrace(
        'session-late-abort',
        (snapshot) => snapshot.events.some((event) => event.phase === 'api_call_completed'),
      )
      expect(completed.calls[0].status).not.toBe('error')

      // Aborting after completion (e.g. the user cancels the next tool step)
      // must not rewrite the finished call into an error.
      abortController.abort()
      await new Promise((resolve) => setTimeout(resolve, 50))
      const trace = await traceCaptureService.getSessionTrace('session-late-abort')
      expect(trace.calls).toHaveLength(1)
      expect(trace.calls[0].status).not.toBe('error')
      expect(trace.calls[0].error).toBeUndefined()
      expect(trace.summary.failedCalls).toBe(0)
      expect(trace.events.map((event) => event.phase)).toEqual(['api_call_started', 'api_call_completed'])
    } finally {
      globalThis.fetch = originalFetch
      if (originalTraceEnv === undefined) delete process.env.CC_HAHA_TRACE_API_CALLS
      else process.env.CC_HAHA_TRACE_API_CALLS = originalTraceEnv
    }
  })

  test('marks fetch rejections from an aborted signal with abort metadata', async () => {
    const originalFetch = globalThis.fetch
    const originalTraceEnv = process.env.CC_HAHA_TRACE_API_CALLS
    process.env.CC_HAHA_TRACE_API_CALLS = '1'
    try {
      const abortController = new AbortController()
      globalThis.fetch = (async () => {
        // Mirror undici: reject with an AbortError once the signal aborts
        // before headers arrive (SDK client timeout during prefill).
        abortController.abort()
        const error = new Error('This operation was aborted')
        error.name = 'AbortError'
        throw error
      }) as typeof fetch

      const traceFetch = createDumpPromptsFetch('agent-fetch-abort', {
        traceSessionId: 'session-fetch-abort',
        querySource: 'test_query',
      })
      await expect(traceFetch('https://sub2api.example.test/v1/messages', {
        method: 'POST',
        body: JSON.stringify({ model: 'gpt-5.5', messages: [{ role: 'user', content: 'pre-headers abort' }] }),
        signal: abortController.signal,
      })).rejects.toThrow('This operation was aborted')

      const trace = await waitForTrace(
        'session-fetch-abort',
        (snapshot) => snapshot.calls[0]?.status === 'error'
          && snapshot.events.some((event) => event.phase === 'api_call_failed'),
      )
      expect(trace.calls[0]).toMatchObject({
        status: 'error',
        error: { name: 'AbortError' },
        metadata: { phase: 'api_call_failed', aborted: true },
      })
      expect(trace.events.map((event) => event.phase)).toEqual(['api_call_started', 'api_call_failed'])
    } finally {
      globalThis.fetch = originalFetch
      if (originalTraceEnv === undefined) delete process.env.CC_HAHA_TRACE_API_CALLS
      else process.env.CC_HAHA_TRACE_API_CALLS = originalTraceEnv
    }
  })
})

describe('captureResponseTraceSnapshot', () => {
  test('returns the full body without abort involvement', async () => {
    const response = new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
    const capture = await captureResponseTraceSnapshot(response, { signal: new AbortController().signal })
    expect(capture.aborted).toBe(false)
    expect(capture.snapshot.preview).toContain('"ok"')
    expect(capture.snapshot.truncated).toBe(false)
  })

  test('finishes with partial data when aborted mid-stream', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('partial sse data'))
      },
    })
    const response = new Response(stream, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    })

    const controller = new AbortController()
    const capturePromise = captureResponseTraceSnapshot(response, { signal: controller.signal })
    await new Promise((resolve) => setTimeout(resolve, 10))
    controller.abort(new Error('client timeout'))

    const capture = await capturePromise
    expect(capture.aborted).toBe(true)
    expect((capture.abortReason as Error).message).toBe('client timeout')
    expect(capture.snapshot.preview).toContain('partial sse data')
    expect(capture.snapshot.truncated).toBe(true)
  })

  test('locks a Responses terminal event as complete without waiting for HTTP EOF', async () => {
    let cancelled = false
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode([
          'event: response.completed',
          'data: {"type":"response.completed","response":{"status":"completed"}}',
          '',
          '',
        ].join('\n')))
        // Keep the HTTP body open forever after the logical terminal event.
      },
      cancel() {
        cancelled = true
      },
    })
    const response = new Response(stream, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    })
    const controller = new AbortController()

    const capture = await captureResponseTraceSnapshot(response, {
      signal: controller.signal,
    })
    controller.abort(new Error('late SDK cleanup'))

    expect(capture.aborted).toBe(false)
    expect(capture.snapshot.preview).toContain('response.completed')
    expect(cancelled).toBe(true)
  })

  test('force-finishes after the grace period when cancel cannot wake a hung read', async () => {
    const encoder = new TextEncoder()
    let reads = 0
    let cancelled = false
    const fakeReader = {
      read() {
        reads += 1
        if (reads === 1) {
          return Promise.resolve({ done: false, value: encoder.encode('stuck partial body') })
        }
        // Hangs forever even after cancel(): models a runtime where
        // reader.cancel() does not settle a pending read.
        return new Promise(() => {})
      },
      cancel() {
        cancelled = true
        return Promise.resolve()
      },
      releaseLock() {},
    }
    const fakeResponse = {
      headers: new Headers({ 'content-type': 'text/event-stream' }),
      body: { getReader: () => fakeReader },
    } as unknown as Response

    const controller = new AbortController()
    const capturePromise = captureResponseTraceSnapshot(fakeResponse, {
      signal: controller.signal,
      abortGraceMs: 20,
    })
    await new Promise((resolve) => setTimeout(resolve, 10))
    controller.abort()

    const capture = await capturePromise
    expect(cancelled).toBe(true)
    expect(capture.aborted).toBe(true)
    expect(capture.snapshot.preview).toContain('stuck partial body')
    expect(capture.snapshot.truncated).toBe(true)
  })

  test('treats an already-aborted signal as an immediate abort', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start() {
        // Never produces data.
      },
    })
    const response = new Response(stream, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    })
    const controller = new AbortController()
    controller.abort()

    const capture = await captureResponseTraceSnapshot(response, {
      signal: controller.signal,
      abortGraceMs: 50,
    })
    expect(capture.aborted).toBe(true)
    expect(capture.snapshot.preview).toBe('')
  })
})

describe('session trace API', () => {
  test('returns an empty trace when no calls were captured for the session', async () => {
    const req = new Request('http://localhost:3456/api/sessions/missing-session/trace')
    const url = new URL(req.url)

    const res = await handleApiRequest(req, url)
    const body = await res.json() as Awaited<ReturnType<typeof traceCaptureService.getSessionTrace>> & { session: unknown }

    expect(res.status).toBe(200)
    expect(body.sessionId).toBe('missing-session')
    expect(body.session).toBeNull()
    expect(body.summary.apiCalls).toBe(0)
    expect(body.calls).toEqual([])
    expect(body.events).toEqual([])
  })

  test('trims call body previews in the session trace list response without touching stored data', async () => {
    const recorded = await traceCaptureService.recordCall({
      sessionId: 'session-trim-api',
      source: 'anthropic',
      model: 'claude-fable-5',
      startedAt: '2026-06-09T08:00:00.000Z',
      completedAt: '2026-06-09T08:00:01.000Z',
      durationMs: 1000,
      request: {
        method: 'POST',
        url: 'https://api.anthropic.com/v1/messages',
        body: {
          model: 'claude-fable-5',
          messages: [{ role: 'user', content: 'find the trimmed call' }],
          padding: 'y'.repeat(6000),
        },
      },
      response: {
        status: 200,
        body: {
          id: 'msg-trim-api',
          content: [{ type: 'text', text: 'z'.repeat(6000) }],
          usage: { input_tokens: 10, output_tokens: 20 },
        },
      },
    })

    const req = new Request('http://localhost:3456/api/sessions/session-trim-api/trace')
    const res = await handleApiRequest(req, new URL(req.url))
    const body = await res.json() as {
      calls: Array<{
        usage?: { inputTokens: number; outputTokens: number }
        request: {
          body: { preview: string; truncated: boolean; bytes: number; sha256: string }
          semantic?: unknown
        }
        response?: { body: { preview: string; truncated: boolean; bytes: number; sha256: string } }
      }>
    }

    expect(res.status).toBe(200)
    expect(body.calls).toHaveLength(1)
    expect(body.calls[0].request.body.preview.length).toBe(2048)
    expect(body.calls[0].request.body.truncated).toBe(true)
    expect(body.calls[0].response?.body.preview.length).toBe(2048)
    expect(body.calls[0].response?.body.truncated).toBe(true)
    expect(body.calls[0].usage).toEqual({ inputTokens: 10, outputTokens: 20 })
    expect(body.calls[0].request.semantic).toBeUndefined()

    const stored = await traceCaptureService.getSessionTrace('session-trim-api')
    expect(stored.calls[0].request.semantic?.request.messages).toHaveLength(1)
    expect(stored.calls[0].request.body.preview.length).toBeGreaterThan(2048)
    expect(stored.calls[0].request.body.truncated).toBe(false)
    expect(stored.calls[0].response?.body.preview.length).toBeGreaterThan(2048)
    expect(stored.calls[0].response?.body.truncated).toBe(false)
    expect(body.calls[0].request.body.bytes).toBe(stored.calls[0].request.body.bytes)
    expect(body.calls[0].request.body.sha256).toBe(stored.calls[0].request.body.sha256)
    expect(body.calls[0].response?.body.bytes).toBe(stored.calls[0].response?.body.bytes)
    expect(body.calls[0].response?.body.sha256).toBe(stored.calls[0].response?.body.sha256)
    expect(recorded).not.toBeNull()
  })

  test('returns the full untrimmed call record from the trace call detail endpoint', async () => {
    const recorded = await traceCaptureService.recordCall({
      sessionId: 'session-call-detail',
      source: 'anthropic',
      model: 'claude-fable-5',
      startedAt: '2026-06-09T08:00:00.000Z',
      completedAt: '2026-06-09T08:00:01.000Z',
      durationMs: 1000,
      request: {
        method: 'POST',
        url: 'https://api.anthropic.com/v1/messages',
        body: {
          model: 'claude-fable-5',
          messages: [{ role: 'user', content: 'full detail please' }],
          padding: 'y'.repeat(6000),
        },
      },
      response: {
        status: 200,
        body: {
          id: 'msg-call-detail',
          usage: { input_tokens: 64, output_tokens: 16 },
        },
      },
    })

    const req = new Request(`http://localhost:3456/api/sessions/session-call-detail/trace/calls/${recorded?.id}`)
    const res = await handleApiRequest(req, new URL(req.url))
    const body = await res.json() as {
      call: {
        id: string
        usage?: { inputTokens: number; outputTokens: number }
        request: { body: { preview: string; truncated: boolean }; semantic?: { version: number } }
      }
    }

    expect(res.status).toBe(200)
    expect(body.call.id).toBe(recorded!.id)
    expect(body.call.request.body.preview.length).toBeGreaterThan(2048)
    expect(body.call.request.body.truncated).toBe(false)
    expect(body.call.request.body.preview).toContain('full detail please')
    expect(body.call.request.semantic?.version).toBe(1)
    expect(body.call.usage).toEqual({ inputTokens: 64, outputTokens: 16 })
  })

  test('returns 404 with an error payload when the trace call id is unknown', async () => {
    const req = new Request('http://localhost:3456/api/sessions/session-call-detail/trace/calls/call-not-there')
    const res = await handleApiRequest(req, new URL(req.url))
    const body = await res.json() as { error: string; message: string }

    expect(res.status).toBe(404)
    expect(body.error).toBe('NOT_FOUND')
    expect(body.message).toContain('call-not-there')
  })

  test('lists trace sessions with storage metadata and managed settings', async () => {
    await traceCaptureService.recordCall({
      sessionId: 'session-list-trace',
      source: 'proxy',
      model: 'gpt-5.5',
      startedAt: '2026-06-09T08:00:00.000Z',
      completedAt: '2026-06-09T08:00:00.015Z',
      durationMs: 15,
      request: {
        method: 'POST',
        url: 'https://api.example.test/v1/messages',
        body: { model: 'gpt-5.5' },
      },
      response: {
        status: 200,
        body: { ok: true },
      },
    })

    const req = new Request('http://localhost:3456/api/traces')
    const res = await handleApiRequest(req, new URL(req.url))
    const body = await res.json() as {
      traces: Array<{ sessionId: string; summary: { apiCalls: number }; fileSize: number }>
      total: number
      storageDir: string
      settings: { enabled: boolean; storageDir: string }
    }

    expect(res.status).toBe(200)
    expect(body.total).toBe(1)
    expect(body.traces[0].sessionId).toBe('session-list-trace')
    expect(body.traces[0].summary.apiCalls).toBe(1)
    expect(body.traces[0].fileSize).toBeGreaterThan(0)
    expect(body.storageDir).toBe(path.join(tmpDir, 'cc-haha', 'traces'))
    expect(body.settings).toEqual({
      enabled: true,
      storageDir: path.join(tmpDir, 'cc-haha', 'traces'),
    })
  })

  test('lists trace sessions without loading full session messages', async () => {
    await traceCaptureService.recordCall({
      sessionId: 'session-list-lightweight',
      source: 'proxy',
      model: 'gpt-5.5',
      startedAt: '2026-06-09T08:00:00.000Z',
      completedAt: '2026-06-09T08:00:00.015Z',
      durationMs: 15,
      request: {
        method: 'POST',
        url: 'https://api.example.test/v1/messages',
        body: { model: 'gpt-5.5' },
      },
      response: {
        status: 200,
        body: { ok: true },
      },
    })

    const getSessionSpy = spyOn(sessionService, 'getSession')
    try {
      const req = new Request('http://localhost:3456/api/traces')
      const res = await handleApiRequest(req, new URL(req.url))
      const body = await res.json() as {
        traces: Array<{ sessionId: string; session: unknown }>
      }

      expect(res.status).toBe(200)
      expect(body.traces[0].sessionId).toBe('session-list-lightweight')
      expect(getSessionSpy).not.toHaveBeenCalled()
    } finally {
      getSessionSpy.mockRestore()
    }
  })

  test('returns an unchanged revision cursor without rereading the trace body', async () => {
    await traceCaptureService.recordCall({
      sessionId: 'session-revision-probe',
      source: 'proxy',
      startedAt: '2026-06-09T08:00:00.000Z',
      completedAt: '2026-06-09T08:00:00.010Z',
      request: { body: { prompt: 'hello' } },
      response: { status: 200, body: { ok: true } },
    })

    const firstReq = new Request('http://localhost:3456/api/traces/session-revision-probe/revision')
    const firstRes = await handleApiRequest(firstReq, new URL(firstReq.url))
    const first = await firstRes.json() as {
      revision: number
      revisionToken: string
      changed: boolean
    }
    expect(firstRes.status).toBe(200)
    expect(first.changed).toBe(true)

    clearTraceCaptureStateForTests()
    const secondReq = new Request(
      `http://localhost:3456/api/traces/session-revision-probe/revision?sinceRevision=${first.revision}`,
    )
    const secondRes = await handleApiRequest(secondReq, new URL(secondReq.url))
    const second = await secondRes.json() as { revision: number; changed: boolean; reset: boolean }

    expect(secondRes.status).toBe(200)
    expect(second).toEqual({
      sessionId: 'session-revision-probe',
      revision: first.revision,
      revisionToken: first.revisionToken,
      changed: false,
      reset: false,
    })
    expect(getTraceCaptureDiagnosticsForTests().fullJsonlBytesRead).toBe(0)
  })

  test('deletes a trace session file and invalidates cached reads', async () => {
    await traceCaptureService.recordCall({
      sessionId: 'session-delete-trace',
      source: 'proxy',
      model: 'gpt-5.5',
      startedAt: '2026-06-09T08:00:00.000Z',
      completedAt: '2026-06-09T08:00:00.015Z',
      durationMs: 15,
      request: {
        method: 'POST',
        url: 'https://api.example.test/v1/messages',
        body: { model: 'gpt-5.5' },
      },
      response: {
        status: 200,
        body: { ok: true },
      },
    })

    const cached = await traceCaptureService.getSessionTrace('session-delete-trace')
    expect(cached.calls).toHaveLength(1)

    const req = new Request('http://localhost:3456/api/traces/session-delete-trace', { method: 'DELETE' })
    const res = await handleApiRequest(req, new URL(req.url))
    const body = await res.json() as { sessionId: string; deleted: boolean }

    expect(res.status).toBe(200)
    expect(body).toEqual({ sessionId: 'session-delete-trace', deleted: true })
    await expect(fs.stat(path.join(tmpDir, 'cc-haha', 'traces', 'session-delete-trace.jsonl'))).rejects.toThrow()

    const afterDelete = await traceCaptureService.getSessionTrace('session-delete-trace')
    expect(afterDelete.calls).toEqual([])
    expect(afterDelete.events).toEqual([])

    const secondReq = new Request('http://localhost:3456/api/traces/session-delete-trace', { method: 'DELETE' })
    const secondRes = await handleApiRequest(secondReq, new URL(secondReq.url))
    const secondBody = await secondRes.json() as { sessionId: string; deleted: boolean }

    expect(secondRes.status).toBe(200)
    expect(secondBody).toEqual({ sessionId: 'session-delete-trace', deleted: false })
  })

  test('searches trace sessions by session title and project path before paginating', async () => {
    const checkoutDir = path.join(tmpDir, 'checkout')
    const otherDir = path.join(tmpDir, 'other')
    await fs.mkdir(checkoutDir, { recursive: true })
    await fs.mkdir(otherDir, { recursive: true })
    const resolvedCheckoutDir = await fs.realpath(checkoutDir)
    const alpha = await sessionService.createSession(checkoutDir)
    await sessionService.renameSession(alpha.sessionId, 'Debug stuck checkout agent')
    const beta = await sessionService.createSession(otherDir)
    await sessionService.renameSession(beta.sessionId, 'Unrelated model run')

    await traceCaptureService.recordCall({
      sessionId: alpha.sessionId,
      source: 'proxy',
      model: 'gpt-5.5',
      startedAt: '2026-06-09T08:00:00.000Z',
      completedAt: '2026-06-09T08:00:00.015Z',
      durationMs: 15,
      request: {
        method: 'POST',
        url: 'https://api.example.test/v1/messages',
        body: { model: 'gpt-5.5' },
      },
      response: {
        status: 200,
        body: { ok: true },
      },
    })
    await traceCaptureService.recordCall({
      sessionId: beta.sessionId,
      source: 'proxy',
      model: 'gpt-5.5',
      startedAt: '2026-06-09T08:00:01.000Z',
      completedAt: '2026-06-09T08:00:01.015Z',
      durationMs: 15,
      request: {
        method: 'POST',
        url: 'https://api.example.test/v1/messages',
        body: { model: 'gpt-5.5' },
      },
      response: {
        status: 200,
        body: { ok: true },
      },
    })

    const titleReq = new Request('http://localhost:3456/api/traces?q=stuck%20agent&limit=10&offset=0')
    const titleRes = await handleApiRequest(titleReq, new URL(titleReq.url))
    const titleBody = await titleRes.json() as {
      traces: Array<{ sessionId: string; session: { title: string; projectPath: string } | null }>
      total: number
    }

    expect(titleRes.status).toBe(200)
    expect(titleBody.total).toBe(1)
    expect(titleBody.traces.map((trace) => trace.sessionId)).toEqual([alpha.sessionId])
    expect(titleBody.traces[0].session?.title).toBe('Debug stuck checkout agent')

    const pathReq = new Request('http://localhost:3456/api/traces?q=checkout&limit=10&offset=0')
    const pathRes = await handleApiRequest(pathReq, new URL(pathReq.url))
    const pathBody = await pathRes.json() as {
      traces: Array<{ sessionId: string; session: { projectPath: string; workDir: string | null } | null }>
      total: number
    }

    expect(pathRes.status).toBe(200)
    expect(pathBody.total).toBe(1)
    expect(pathBody.traces.map((trace) => trace.sessionId)).toEqual([alpha.sessionId])
    expect(pathBody.traces[0].session?.workDir).toBe(resolvedCheckoutDir)

    const missReq = new Request('http://localhost:3456/api/traces?q=missing-title&limit=10&offset=0')
    const missRes = await handleApiRequest(missReq, new URL(missReq.url))
    const missBody = await missRes.json() as {
      traces: Array<{ sessionId: string }>
      total: number
    }

    expect(missRes.status).toBe(200)
    expect(missBody.total).toBe(0)
    expect(missBody.traces).toEqual([])
  })
})

describe('trace read cache', () => {
  function buildTraceCallLine(id: string, sessionId = 'session-cache-hit', payload = 'ok'): string {
    return `${JSON.stringify({
      type: 'call',
      record: {
        id,
        sessionId,
        source: 'proxy',
        status: 'ok',
        startedAt: '2026-06-09T08:00:00.000Z',
        completedAt: '2026-06-09T08:00:00.020Z',
        durationMs: 20,
        request: {
          method: 'POST',
          url: 'https://api.example.test/v1/chat/completions',
          headers: {},
          body: createTraceBodySnapshot({ model: 'gpt-5.5', payload }),
        },
        response: {
          status: 200,
          headers: {},
          body: createTraceBodySnapshot({ ok: true }),
        },
      },
    })}\n`
  }

  test('invalidates cached entries after a same-size rewrite with restored mtime', async () => {
    const traceDir = path.join(tmpDir, 'cc-haha', 'traces')
    const filePath = path.join(traceDir, 'session-cache-hit.jsonl')
    await fs.mkdir(traceDir, { recursive: true })

    const lineA = buildTraceCallLine('call-aaa')
    const lineB = buildTraceCallLine('call-bbb')
    expect(Buffer.byteLength(lineA)).toBe(Buffer.byteLength(lineB))

    const initialTime = new Date('2026-06-09T08:00:00.000Z')
    await fs.writeFile(filePath, lineA)
    await fs.utimes(filePath, initialTime, initialTime)

    const first = await traceCaptureService.getSessionTrace('session-cache-hit')
    expect(first.calls.map((call) => call.id)).toEqual(['call-aaa'])

    // Same size + restored mtime still represents a different source snapshot.
    await fs.writeFile(filePath, lineB)
    await fs.utimes(filePath, initialTime, initialTime)

    const second = await traceCaptureService.getSessionTrace('session-cache-hit')
    expect(second.calls.map((call) => call.id)).toEqual(['call-bbb'])

    const laterTime = new Date('2026-06-09T08:00:05.000Z')
    await fs.utimes(filePath, laterTime, laterTime)

    const third = await traceCaptureService.getSessionTrace('session-cache-hit')
    expect(third.calls.map((call) => call.id)).toEqual(['call-bbb'])
  })

  test('stores trimmed records in the list cache and keeps full records for detail reads', async () => {
    const traceDir = path.join(tmpDir, 'cc-haha', 'traces')
    const filePath = path.join(traceDir, 'session-cache-list.jsonl')
    await fs.mkdir(traceDir, { recursive: true })
    await fs.writeFile(filePath, buildTraceCallLine('call-list-cache', 'session-cache-list', 'x'.repeat(10_000)))

    const list = await traceCaptureService.listSessionTraces({ sessionIds: ['session-cache-list'] })
    expect(list.traces).toHaveLength(1)

    const trace = await traceCaptureService.getSessionTrace('session-cache-list')
    const detail = await traceCaptureService.getSessionTraceCall('session-cache-list', 'call-list-cache')

    expect(trace.calls[0].request.body.preview.length).toBeGreaterThan(2048)
    expect(detail?.request.body.preview.length).toBeGreaterThan(2048)
  })

  test('invalidates the cache when new entries are appended in process', async () => {
    await traceCaptureService.recordCall({
      id: 'call-cache-1',
      sessionId: 'session-cache-append',
      source: 'proxy',
      model: 'gpt-5.5',
      startedAt: '2026-06-09T08:00:00.000Z',
      completedAt: '2026-06-09T08:00:00.010Z',
      durationMs: 10,
      request: {
        method: 'POST',
        url: 'https://api.example.test/v1/messages',
        body: { model: 'gpt-5.5' },
      },
      response: {
        status: 200,
        body: { ok: true },
      },
    })

    const first = await traceCaptureService.getSessionTrace('session-cache-append')
    expect(first.calls.map((call) => call.id)).toEqual(['call-cache-1'])

    await traceCaptureService.recordCall({
      id: 'call-cache-2',
      sessionId: 'session-cache-append',
      source: 'proxy',
      model: 'gpt-5.5',
      startedAt: '2026-06-09T08:00:01.000Z',
      completedAt: '2026-06-09T08:00:01.010Z',
      durationMs: 10,
      request: {
        method: 'POST',
        url: 'https://api.example.test/v1/messages',
        body: { model: 'gpt-5.5' },
      },
      response: {
        status: 200,
        body: { ok: true },
      },
    })

    const second = await traceCaptureService.getSessionTrace('session-cache-append')
    expect(second.calls.map((call) => call.id)).toEqual(['call-cache-1', 'call-cache-2'])
  })

  test('serves a warm trace list from the persisted projection without reopening JSONL', async () => {
    await traceCaptureService.recordCall({
      id: 'call-projection-warm',
      sessionId: 'session-projection-warm',
      source: 'proxy',
      model: 'gpt-5.5',
      startedAt: '2026-06-09T08:00:00.000Z',
      completedAt: '2026-06-09T08:00:00.010Z',
      durationMs: 10,
      request: { body: { model: 'gpt-5.5' } },
      response: { status: 200, body: { usage: { input_tokens: 3, output_tokens: 2 } } },
    })
    await traceCaptureService.listSessionTraces()
    clearTraceCaptureStateForTests()

    const readFileSpy = spyOn(fs, 'readFile')
    try {
      const list = await traceCaptureService.listSessionTraces()

      expect(list.traces).toHaveLength(1)
      expect(list.traces[0].summary).toMatchObject({
        apiCalls: 1,
        totalInputTokens: 3,
        totalOutputTokens: 2,
      })
      expect(getTraceCaptureDiagnosticsForTests().fullJsonlBytesRead).toBe(0)
      expect(readFileSpy).not.toHaveBeenCalled()
    } finally {
      readFileSpy.mockRestore()
    }
  })

  test('projects an in-process append without rereading the existing JSONL prefix', async () => {
    await traceCaptureService.recordCall({
      id: 'call-projection-1',
      sessionId: 'session-projection-append',
      source: 'proxy',
      startedAt: '2026-06-09T08:00:00.000Z',
      completedAt: '2026-06-09T08:00:00.010Z',
      durationMs: 10,
      request: { body: { padding: 'x'.repeat(64_000) } },
      response: { status: 200, body: { ok: true } },
    })
    await traceCaptureService.listSessionTraces()
    clearTraceCaptureStateForTests()

    const readFileSpy = spyOn(fs, 'readFile')
    try {
      await traceCaptureService.recordCall({
        id: 'call-projection-2',
        sessionId: 'session-projection-append',
        source: 'proxy',
        startedAt: '2026-06-09T08:00:01.000Z',
        completedAt: '2026-06-09T08:00:01.010Z',
        durationMs: 10,
        request: { body: { small: true } },
        response: { status: 200, body: { ok: true } },
      })
      const list = await traceCaptureService.listSessionTraces()

      expect(list.traces[0].summary.apiCalls).toBe(2)
      expect(getTraceCaptureDiagnosticsForTests()).toMatchObject({
        fullJsonlBytesRead: 0,
        appendedEntriesProjected: 1,
      })
      expect(readFileSpy).not.toHaveBeenCalled()
    } finally {
      readFileSpy.mockRestore()
    }
  })

  test('projects an external append from the stored boundary without rereading the prefix', async () => {
    const traceDir = path.join(tmpDir, 'cc-haha', 'traces')
    const filePath = path.join(traceDir, 'session-projection-external-append.jsonl')
    await fs.mkdir(traceDir, { recursive: true })
    const prefix = buildTraceCallLine(
      'call-external-a',
      'session-projection-external-append',
      'x'.repeat(180_000),
    )
    const appended = buildTraceCallLine(
      'call-external-b',
      'session-projection-external-append',
      'small',
    )
    await fs.writeFile(filePath, prefix)
    expect((await traceCaptureService.listSessionTraces()).traces[0].summary.apiCalls).toBe(1)
    clearTraceCaptureStateForTests()

    await fs.appendFile(filePath, appended)
    const revision = await traceCaptureService.getSessionTraceRevision(
      'session-projection-external-append',
    )
    const diagnostics = getTraceCaptureDiagnosticsForTests() as Record<string, number>

    expect(revision.changed).toBe(true)
    expect(diagnostics.fullJsonlBytesRead).toBe(0)
    expect(diagnostics.incrementalJsonlBytesRead).toBe(Buffer.byteLength(appended))
    expect(diagnostics.fingerprintBytesRead).toBeLessThanOrEqual(7 * 64 * 1024)
    expect((await traceCaptureService.listSessionTraces()).traces[0].summary.apiCalls).toBe(2)
    expect((await traceCaptureService.getSessionTrace('session-projection-external-append')).calls)
      .toHaveLength(2)
    expect(await traceCaptureService.getSessionTraceRevision(
      'session-projection-external-append',
      revision.revision,
    )).toMatchObject({
      revision: revision.revision,
      changed: false,
      reset: false,
    })
  })

  test('does not commit an append parsed from a different source snapshot than its fingerprint', async () => {
    const traceDir = path.join(tmpDir, 'cc-haha', 'traces')
    const filePath = path.join(traceDir, 'session-projection-append-race.jsonl')
    await fs.mkdir(traceDir, { recursive: true })
    const prefix = buildTraceCallLine(
      'call-race-prefix',
      'session-projection-append-race',
    )
    const oldAppend = JSON.parse(buildTraceCallLine(
      'call-race-append',
      'session-projection-append-race',
    ))
    oldAppend.record.model = 'model-old'
    const newAppend = structuredClone(oldAppend)
    newAppend.record.model = 'model-new'
    const oldLine = `${JSON.stringify(oldAppend)}\n`
    const newLine = `${JSON.stringify(newAppend)}\n`
    expect(Buffer.byteLength(oldLine)).toBe(Buffer.byteLength(newLine))

    await fs.writeFile(filePath, prefix)
    expect((await traceCaptureService.listSessionTraces()).traces[0].summary.apiCalls).toBe(1)
    clearTraceCaptureStateForTests()

    await fs.appendFile(filePath, oldLine)
    const fixedTime = new Date('2026-06-09T08:00:00.000Z')
    await fs.utimes(filePath, fixedTime, fixedTime)
    const target = await fs.stat(filePath)
    const prefixBytes = Buffer.byteLength(prefix)
    const originalOpen = mutableFs.open.bind(mutableFs)
    let rewroteAfterRangeRead = false
    const openSpy = spyOn(mutableFs, 'open').mockImplementation(async (...args) => {
      const handle = await originalOpen(...args)
      let readAppendRange = false
      return new Proxy(handle, {
        get(targetHandle, property) {
          if (property === 'read') {
            return async (
              buffer: Uint8Array,
              offset: number,
              length: number,
              position: number,
            ) => {
              if (position === prefixBytes && length === Buffer.byteLength(oldLine)) {
                readAppendRange = true
              }
              return targetHandle.read(buffer, offset, length, position)
            }
          }
          if (property === 'close') {
            return async () => {
              await targetHandle.close()
              if (readAppendRange && !rewroteAfterRangeRead) {
                rewroteAfterRangeRead = true
                await fs.writeFile(filePath, `${prefix}${newLine}`)
                await fs.utimes(filePath, target.atime, target.mtime)
              }
            }
          }
          const value = Reflect.get(targetHandle, property, targetHandle)
          return typeof value === 'function' ? value.bind(targetHandle) : value
        },
      })
    })

    try {
      await traceCaptureService.getSessionTraceRevision('session-projection-append-race')
      const list = await traceCaptureService.listSessionTraces()

      expect(rewroteAfterRangeRead).toBe(true)
      expect(list.traces[0].summary.models).toEqual([{ model: 'model-new', calls: 1 }])
    } finally {
      openSpy.mockRestore()
    }
  })

  test('invalidates a projection after a same-size rewrite with restored mtime', async () => {
    const traceDir = path.join(tmpDir, 'cc-haha', 'traces')
    const filePath = path.join(traceDir, 'session-projection-same-size.jsonl')
    await fs.mkdir(traceDir, { recursive: true })
    const lineA = buildTraceCallLine('call-aaa', 'session-projection-same-size')
    const lineB = buildTraceCallLine('call-bbb', 'session-projection-same-size')
    const fixedTime = new Date('2026-06-09T08:00:00.000Z')
    expect(Buffer.byteLength(lineA)).toBe(Buffer.byteLength(lineB))

    await fs.writeFile(filePath, lineA)
    await fs.utimes(filePath, fixedTime, fixedTime)
    const initial = await traceCaptureService.getSessionTraceRevision('session-projection-same-size')
    clearTraceCaptureStateForTests()

    await fs.writeFile(filePath, lineB)
    await fs.utimes(filePath, fixedTime, fixedTime)
    const rewritten = await traceCaptureService.getSessionTraceRevision(
      'session-projection-same-size',
      initial.revision,
    )

    expect(rewritten.changed).toBe(true)
    expect(rewritten.reset).toBe(true)
    expect(rewritten.revision).toBeGreaterThan(initial.revision)
    expect((await traceCaptureService.getSessionTrace('session-projection-same-size')).calls[0].id)
      .toBe('call-bbb')
  })

  test('invalidates a large projection after an unsampled middle rewrite with restored mtime', async () => {
    const sessionId = 'session-projection-middle-rewrite'
    const traceDir = path.join(tmpDir, 'cc-haha', 'traces')
    const filePath = path.join(traceDir, `${sessionId}.jsonl`)
    await fs.mkdir(traceDir, { recursive: true })
    const paddedLine = (id: string, model: string, padding: number): string => {
      const entry = JSON.parse(buildTraceCallLine(id, sessionId)) as {
        record: Record<string, unknown>
      }
      entry.record.model = model
      entry.record.metadata = { padding: 'x'.repeat(padding) }
      return `${JSON.stringify(entry)}\n`
    }
    const original = [
      paddedLine('call-first', 'model-first', 90_000),
      paddedLine('call-middle', 'model-aaa', 1_000),
      paddedLine('call-last', 'model-last-', 90_000),
    ].join('')
    const rewritten = original.replace('model-aaa', 'model-bbb')
    const fixedTime = new Date('2026-06-09T08:00:00.000Z')
    expect(Buffer.byteLength(original)).toBe(Buffer.byteLength(rewritten))
    expect(Buffer.byteLength(original)).toBeGreaterThan(2 * 64 * 1024)

    await fs.writeFile(filePath, original)
    await fs.utimes(filePath, fixedTime, fixedTime)
    const initial = (await traceCaptureService.listSessionTraces({
      sessionIds: [sessionId],
    })).traces[0]!.summary.models
    await new Promise(resolve => setTimeout(resolve, 5))
    await fs.writeFile(filePath, rewritten)
    await fs.utimes(filePath, fixedTime, fixedTime)

    const projected = (await traceCaptureService.listSessionTraces({
      sessionIds: [sessionId],
    })).traces[0]!.summary.models
    process.env.CC_HAHA_LOCAL_INDEX = 'off'
    const canonical = (await traceCaptureService.listSessionTraces({
      sessionIds: [sessionId],
    })).traces[0]!.summary.models

    expect(initial).toContainEqual({ model: 'model-aaa', calls: 1 })
    expect(projected).toEqual(canonical)
    expect(projected).toContainEqual({ model: 'model-bbb', calls: 1 })
  })

  test('does not commit old full-trace bytes with a newer middle-rewrite fingerprint', async () => {
    const sessionId = 'session-projection-full-read-race'
    const traceDir = path.join(tmpDir, 'cc-haha', 'traces')
    const filePath = path.join(traceDir, `${sessionId}.jsonl`)
    await fs.mkdir(traceDir, { recursive: true })
    const paddedLine = (id: string, model: string, padding: number): string => {
      const entry = JSON.parse(buildTraceCallLine(id, sessionId)) as {
        record: Record<string, unknown>
      }
      entry.record.model = model
      entry.record.metadata = { padding: 'x'.repeat(padding) }
      return `${JSON.stringify(entry)}\n`
    }
    const original = [
      paddedLine('call-first', 'model-first', 90_000),
      paddedLine('call-middle', 'model-aaa', 1_000),
      paddedLine('call-last', 'model-last-', 90_000),
    ].join('')
    const rewritten = original.replace('model-aaa', 'model-bbb')
    const fixedTime = new Date('2026-06-09T08:00:00.000Z')
    await fs.writeFile(filePath, original)
    await fs.utimes(filePath, fixedTime, fixedTime)
    setTraceFullSnapshotAfterReadHookForTests(async () => {
      setTraceFullSnapshotAfterReadHookForTests(null)
      await new Promise(resolve => setTimeout(resolve, 5))
      await fs.writeFile(filePath, rewritten)
      await fs.utimes(filePath, fixedTime, fixedTime)
    })

    const projected = (await traceCaptureService.listSessionTraces({
      sessionIds: [sessionId],
    })).traces[0]!.summary.models
    process.env.CC_HAHA_LOCAL_INDEX = 'off'
    const canonical = (await traceCaptureService.listSessionTraces({
      sessionIds: [sessionId],
    })).traces[0]!.summary.models

    expect(projected).toEqual(canonical)
    expect(projected).toContainEqual({ model: 'model-bbb', calls: 1 })
    expect(projected).not.toContainEqual({ model: 'model-aaa', calls: 1 })
  })

  test('rebuilds after a same-size rewrite and after a truncated source', async () => {
    const traceDir = path.join(tmpDir, 'cc-haha', 'traces')
    const filePath = path.join(traceDir, 'session-projection-rewrite.jsonl')
    await fs.mkdir(traceDir, { recursive: true })
    const lineA = buildTraceCallLine('call-aaa', 'session-projection-rewrite')
    const lineB = buildTraceCallLine('call-bbb', 'session-projection-rewrite')
    expect(Buffer.byteLength(lineA)).toBe(Buffer.byteLength(lineB))

    await fs.writeFile(filePath, `${lineA}${buildTraceCallLine('call-ccc', 'session-projection-rewrite')}`)
    const initial = await traceCaptureService.listSessionTraces()
    expect(initial.traces[0].summary.apiCalls).toBe(2)
    const initialRevision = await traceCaptureService.getSessionTraceRevision('session-projection-rewrite')

    await fs.writeFile(filePath, lineB)
    const later = new Date('2026-06-09T08:01:00.000Z')
    await fs.utimes(filePath, later, later)
    const rewritten = await traceCaptureService.listSessionTraces()
    const rewrittenRevision = await traceCaptureService.getSessionTraceRevision('session-projection-rewrite')

    expect(rewritten.traces[0].summary.apiCalls).toBe(1)
    expect(rewrittenRevision.revision).toBeGreaterThan(initialRevision.revision)
    expect((await traceCaptureService.getSessionTrace('session-projection-rewrite')).calls[0].id)
      .toBe('call-bbb')
  })

  test('does not index a partial tail and picks up complete lines appended after it', async () => {
    const traceDir = path.join(tmpDir, 'cc-haha', 'traces')
    const filePath = path.join(traceDir, 'session-projection-tail.jsonl')
    await fs.mkdir(traceDir, { recursive: true })
    const lineA = buildTraceCallLine('call-tail-a', 'session-projection-tail')
    const lineB = buildTraceCallLine('call-tail-b', 'session-projection-tail')

    await fs.writeFile(filePath, `${lineA}{"type":"call"`)
    expect((await traceCaptureService.listSessionTraces()).traces[0].summary.apiCalls).toBe(1)
    clearTraceCaptureStateForTests()

    await fs.appendFile(filePath, `\n${lineB}`)
    const afterAppend = await traceCaptureService.listSessionTraces()
    expect(afterAppend.traces[0].summary.apiCalls).toBe(2)
    const diagnostics = getTraceCaptureDiagnosticsForTests() as Record<string, number>
    expect(diagnostics.fullJsonlBytesRead).toBe(0)
    expect(diagnostics.incrementalJsonlBytesRead).toBe(
      Buffer.byteLength('{"type":"call"') + 1 + Buffer.byteLength(lineB),
    )
  })

  test('falls back to canonical JSONL when the independent trace database is corrupt', async () => {
    await traceCaptureService.recordCall({
      id: 'call-corrupt-index',
      sessionId: 'session-corrupt-index',
      source: 'proxy',
      startedAt: '2026-06-09T08:00:00.000Z',
      completedAt: '2026-06-09T08:00:00.010Z',
      request: { body: { prompt: 'still readable' } },
      response: { status: 200, body: { ok: true } },
    })
    clearTraceCaptureStateForTests()
    const databasePath = path.join(tmpDir, 'cc-haha', 'db', 'trace-index-v1.sqlite')
    await fs.writeFile(databasePath, 'not a sqlite database')

    const list = await traceCaptureService.listSessionTraces()
    const trace = await traceCaptureService.getSessionTrace('session-corrupt-index')

    expect(list.traces[0].summary.apiCalls).toBe(1)
    expect(trace.calls.map(call => call.id)).toEqual(['call-corrupt-index'])
  })

  test('keeps trace SQLite completely untouched in off mode, including after a runtime rollback', async () => {
    process.env.CC_HAHA_LOCAL_INDEX = 'off'
    clearTraceCaptureStateForTests()

    await traceCaptureService.recordCall({
      id: 'call-off-a',
      sessionId: 'session-off',
      source: 'proxy',
      startedAt: '2026-07-15T08:00:00.000Z',
      completedAt: '2026-07-15T08:00:00.010Z',
      request: { body: { prompt: 'canonical only' } },
      response: { status: 200, body: { ok: true } },
    })
    const databasePath = getTraceIndexDatabasePath()

    expect((await traceCaptureService.listSessionTraces()).traces[0]?.summary.apiCalls).toBe(1)
    expect((await traceCaptureService.getSessionTraceRevision('session-off')).changed).toBe(true)
    expect((await traceCaptureService.getSessionTraceCall('session-off', 'call-off-a'))?.id)
      .toBe('call-off-a')
    await expect(fs.stat(databasePath)).rejects.toThrow()

    process.env.CC_HAHA_LOCAL_INDEX = 'on'
    await traceCaptureService.listSessionTraces()
    expect((await fs.stat(databasePath)).isFile()).toBe(true)

    process.env.CC_HAHA_LOCAL_INDEX = 'off'
    await traceCaptureService.getSessionTraceRevision('session-off')
    await fs.rm(databasePath, { force: true })
    await traceCaptureService.recordCall({
      id: 'call-off-b',
      sessionId: 'session-off',
      source: 'proxy',
      startedAt: '2026-07-15T08:00:01.000Z',
      completedAt: '2026-07-15T08:00:01.010Z',
      request: { body: { prompt: 'still canonical only' } },
      response: { status: 200, body: { ok: true } },
    })
    await expect(fs.stat(databasePath)).rejects.toThrow()
  })

  test('cools down after an opener busy error and retries after an explicit off-on cycle', async () => {
    await traceCaptureService.recordCall({
      id: 'call-busy-open',
      sessionId: 'session-busy-open',
      source: 'proxy',
      startedAt: '2026-07-15T08:00:00.000Z',
      completedAt: '2026-07-15T08:00:00.010Z',
      request: { body: { prompt: 'canonical fallback' } },
      response: { status: 200, body: { ok: true } },
    })
    clearTraceCaptureStateForTests()
    const database = new Database(getTraceIndexDatabasePath())
    database.exec('PRAGMA journal_mode = DELETE')
    database.exec('BEGIN EXCLUSIVE')
    const startedAt = performance.now()
    const first = await traceCaptureService.listSessionTraces({
      sessionIds: ['session-busy-open'],
    })
    const elapsedMs = performance.now() - startedAt
    database.exec('ROLLBACK')
    database.run(
      'UPDATE trace_sessions SET api_calls = 99 WHERE session_id = ?',
      ['session-busy-open'],
    )
    database.close()

    const duringCooldown = await traceCaptureService.listSessionTraces({
      sessionIds: ['session-busy-open'],
    })
    expect(first.traces[0]?.summary.apiCalls).toBe(1)
    expect(duringCooldown.traces[0]?.summary.apiCalls).toBe(1)
    expect(elapsedMs).toBeLessThan(250)

    process.env.CC_HAHA_LOCAL_INDEX = 'off'
    await traceCaptureService.listSessionTraces({ sessionIds: ['session-busy-open'] })
    process.env.CC_HAHA_LOCAL_INDEX = 'on'
    const recovered = await traceCaptureService.listSessionTraces({
      sessionIds: ['session-busy-open'],
    })
    expect(recovered.traces[0]?.summary.apiCalls).toBe(99)
  })

  test('cools down after an operation busy error and rebuilds after off-on recovery', async () => {
    await traceCaptureService.recordCall({
      id: 'call-busy-operation-a',
      sessionId: 'session-busy-operation',
      source: 'proxy',
      startedAt: '2026-07-15T08:00:00.000Z',
      completedAt: '2026-07-15T08:00:00.010Z',
      request: { body: { prompt: 'first' } },
      response: { status: 200, body: { ok: true } },
    })
    const databasePath = getTraceIndexDatabasePath()
    const writer = new Database(databasePath)
    writer.exec('BEGIN IMMEDIATE')
    const traceFile = path.join(
      tmpDir,
      'cc-haha',
      'traces',
      'session-busy-operation.jsonl',
    )
    await fs.appendFile(
      traceFile,
      `${JSON.stringify({
        type: 'call',
        record: {
          id: 'call-busy-operation-b',
          sessionId: 'session-busy-operation',
          source: 'proxy',
          status: 'ok',
          startedAt: '2026-07-15T08:00:01.000Z',
          completedAt: '2026-07-15T08:00:01.010Z',
          request: { method: 'POST', url: '', headers: {}, body: createTraceBodySnapshot({}) },
          response: { status: 200, headers: {}, body: createTraceBodySnapshot({ ok: true }) },
        },
      })}\n`,
    )

    const fallback = await traceCaptureService.listSessionTraces({
      sessionIds: ['session-busy-operation'],
    })
    writer.exec('ROLLBACK')
    writer.close()
    expect(fallback.traces[0]?.summary.apiCalls).toBe(2)

    const duringCooldown = await traceCaptureService.listSessionTraces({
      sessionIds: ['session-busy-operation'],
    })
    expect(duringCooldown.traces[0]?.summary.apiCalls).toBe(2)
    process.env.CC_HAHA_LOCAL_INDEX = 'off'
    await traceCaptureService.listSessionTraces({ sessionIds: ['session-busy-operation'] })
    process.env.CC_HAHA_LOCAL_INDEX = 'on'
    const recovered = await traceCaptureService.listSessionTraces({
      sessionIds: ['session-busy-operation'],
    })
    expect(recovered.traces[0]?.summary.apiCalls).toBe(2)
    const inspected = new Database(databasePath, { readonly: true })
    expect(inspected.query<{ api_calls: number }, []>(
      "SELECT api_calls FROM trace_sessions WHERE session_id = 'session-busy-operation'",
    ).get()).toEqual({ api_calls: 2 })
    inspected.close()
  })

  test('returns canonical trace summaries in shadow mode and records projection mismatches safely', async () => {
    await traceCaptureService.recordCall({
      id: 'call-shadow',
      sessionId: 'session-shadow',
      source: 'proxy',
      startedAt: '2026-07-15T08:00:00.000Z',
      completedAt: '2026-07-15T08:00:00.010Z',
      request: { body: { prompt: 'canonical wins' } },
      response: { status: 200, body: { ok: true } },
    })
    clearTraceCaptureStateForTests()
    const database = new Database(getTraceIndexDatabasePath())
    database.run(
      'UPDATE trace_sessions SET api_calls = 99 WHERE session_id = ?',
      ['session-shadow'],
    )
    database.close()
    process.env.CC_HAHA_LOCAL_INDEX = 'shadow'

    const list = await traceCaptureService.listSessionTraces({ sessionIds: ['session-shadow'] })

    expect(list.traces[0]?.summary.apiCalls).toBe(1)
    expect(getTraceCaptureDiagnosticsForTests()).toMatchObject({
      shadowComparisons: 1,
      shadowMismatches: 1,
    })
  })

  test('preserves canonical model order after a call changes models', async () => {
    const record = async (input: {
      id: string
      model: string
      startedAt: string
    }) => traceCaptureService.recordCall({
      ...input,
      sessionId: 'session-model-order',
      source: 'proxy',
      completedAt: input.startedAt,
      request: { body: { model: input.model } },
      response: { status: 200, body: { ok: true } },
    })
    await record({
      id: 'call-first',
      model: 'z-model',
      startedAt: '2026-07-15T08:00:00.000Z',
    })
    await record({
      id: 'call-second',
      model: 'a-model',
      startedAt: '2026-07-15T08:00:01.000Z',
    })
    await record({
      id: 'call-first',
      model: 'b-model',
      startedAt: '2026-07-15T08:00:00.000Z',
    })

    const projected = (await traceCaptureService.listSessionTraces({
      sessionIds: ['session-model-order'],
    })).traces[0]!.summary.models
    process.env.CC_HAHA_LOCAL_INDEX = 'off'
    const canonical = (await traceCaptureService.listSessionTraces({
      sessionIds: ['session-model-order'],
    })).traces[0]!.summary.models

    expect(projected).toEqual(canonical)
    expect(projected).toEqual([
      { model: 'b-model', calls: 1 },
      { model: 'a-model', calls: 1 },
    ])
  })

  test('preserves canonical first-insertion order when call start times tie', async () => {
    const startedAt = '2026-07-15T08:00:00.000Z'
    await traceCaptureService.recordCall({
      id: 'call-first',
      sessionId: 'session-start-tie',
      source: 'proxy',
      status: 'pending',
      startedAt,
      request: { body: { state: 'pending' } },
    })
    await traceCaptureService.recordCall({
      id: 'call-second',
      sessionId: 'session-start-tie',
      source: 'proxy',
      startedAt,
      completedAt: '2026-07-15T08:00:10.000Z',
      request: { body: { state: 'second' } },
      response: { status: 200, body: { ok: true } },
    })
    await traceCaptureService.recordCall({
      id: 'call-first',
      sessionId: 'session-start-tie',
      source: 'proxy',
      startedAt,
      completedAt: '2026-07-15T08:00:20.000Z',
      request: { body: { state: 'first-completed' } },
      response: { status: 200, body: { ok: true } },
    })

    const projected = (await traceCaptureService.listSessionTraces({
      sessionIds: ['session-start-tie'],
    })).traces[0]!.summary.updatedAt
    process.env.CC_HAHA_LOCAL_INDEX = 'off'
    const canonical = (await traceCaptureService.listSessionTraces({
      sessionIds: ['session-start-tie'],
    })).traces[0]!.summary.updatedAt

    expect(projected).toBe(canonical)
    expect(projected).toBe('2026-07-15T08:00:10.000Z')
  })

  test('preserves canonical LWW insertion order after a full projection rebuild', async () => {
    const startedAt = '2026-07-15T08:00:00.000Z'
    const record = async (input: {
      id: string
      model: string
      completedAt: string
    }) => traceCaptureService.recordCall({
      ...input,
      sessionId: 'session-rebuild-lww-order',
      source: 'proxy',
      startedAt,
      request: { body: { model: input.model } },
      response: { status: 200, body: { ok: true } },
    })
    await record({
      id: 'call-first',
      model: 'z-model',
      completedAt: '2026-07-15T08:00:20.000Z',
    })
    await record({
      id: 'call-second',
      model: 'a-model',
      completedAt: '2026-07-15T08:00:10.000Z',
    })
    await record({
      id: 'call-first',
      model: 'z-model',
      completedAt: '2026-07-15T08:00:20.000Z',
    })

    clearTraceCaptureStateForTests()
    for (const suffix of ['', '-wal', '-shm']) {
      await fs.rm(`${getTraceIndexDatabasePath()}${suffix}`, { force: true })
    }
    const projected = (await traceCaptureService.listSessionTraces({
      sessionIds: ['session-rebuild-lww-order'],
    })).traces[0]!.summary
    process.env.CC_HAHA_LOCAL_INDEX = 'off'
    const canonical = (await traceCaptureService.listSessionTraces({
      sessionIds: ['session-rebuild-lww-order'],
    })).traces[0]!.summary

    expect(projected).toEqual(canonical)
    expect(projected.models).toEqual([
      { model: 'z-model', calls: 1 },
      { model: 'a-model', calls: 1 },
    ])
    expect(projected.updatedAt).toBe('2026-07-15T08:00:10.000Z')
  })

  test('uses an incarnation-safe revision token after deleting the DB and replacing the source', async () => {
    await traceCaptureService.recordCall({
      id: 'call-old',
      sessionId: 'session-revision-incarnation',
      source: 'proxy',
      startedAt: '2026-07-15T08:00:00.000Z',
      completedAt: '2026-07-15T08:00:00.010Z',
      request: { body: { prompt: 'old' } },
      response: { status: 200, body: { ok: true } },
    })
    const first = await traceCaptureService.getSessionTraceRevision('session-revision-incarnation')
    expect(first.revisionToken).toBeString()
    const filePath = path.join(
      tmpDir,
      'cc-haha',
      'traces',
      'session-revision-incarnation.jsonl',
    )
    const rewritten = (await fs.readFile(filePath, 'utf8'))
      .replaceAll('call-old', 'call-new')
      .replaceAll('"old"', '"new"')
    clearTraceCaptureStateForTests()
    await fs.writeFile(filePath, rewritten)
    for (const suffix of ['', '-wal', '-shm']) {
      await fs.rm(`${getTraceIndexDatabasePath()}${suffix}`, { force: true })
    }

    const request = new Request(
      `http://localhost:3456/api/traces/session-revision-incarnation/revision?sinceRevision=${first.revision}&sinceRevisionToken=${encodeURIComponent(first.revisionToken)}`,
    )
    const response = await handleApiRequest(request, new URL(request.url))
    const second = await response.json() as Awaited<ReturnType<
      typeof traceCaptureService.getSessionTraceRevision
    >>

    expect(second.revision).toBe(first.revision)
    expect(second.revisionToken).not.toBe(first.revisionToken)
    expect(second.changed).toBe(true)
    expect(second.reset).toBe(true)
    expect((await traceCaptureService.getSessionTrace('session-revision-incarnation')).calls[0]?.id)
      .toBe('call-new')
  })

  test('keeps a revision reset epoch across append while changing the revision token', async () => {
    await traceCaptureService.recordCall({
      id: 'call-token-a',
      sessionId: 'session-token-append',
      source: 'proxy',
      startedAt: '2026-07-15T08:00:00.000Z',
      completedAt: '2026-07-15T08:00:00.010Z',
      request: { body: { prompt: 'a' } },
      response: { status: 200, body: { ok: true } },
    })
    const first = await traceCaptureService.getSessionTraceRevision('session-token-append')
    await traceCaptureService.recordCall({
      id: 'call-token-b',
      sessionId: 'session-token-append',
      source: 'proxy',
      startedAt: '2026-07-15T08:00:01.000Z',
      completedAt: '2026-07-15T08:00:01.010Z',
      request: { body: { prompt: 'b' } },
      response: { status: 200, body: { ok: true } },
    })

    const second = await traceCaptureService.getSessionTraceRevision(
      'session-token-append',
      first.revision,
      first.revisionToken,
    )

    expect(second.revisionToken).not.toBe(first.revisionToken)
    expect(second.changed).toBe(true)
    expect(second.reset).toBe(false)
  })

  test('hydrates a warm targeted call detail from its latest bounded locator', async () => {
    await traceCaptureService.recordCall({
      id: 'call-bounded-detail',
      sessionId: 'session-bounded-detail',
      source: 'proxy',
      startedAt: '2026-07-15T08:00:00.000Z',
      completedAt: '2026-07-15T08:00:00.010Z',
      request: { body: { padding: 'x'.repeat(400_000) } },
      response: { status: 200, body: { ok: true } },
    })
    await traceCaptureService.getSessionTraceRevision('session-bounded-detail')
    const sourceSize = (await fs.stat(path.join(
      tmpDir,
      'cc-haha',
      'traces',
      'session-bounded-detail.jsonl',
    ))).size
    clearTraceCaptureStateForTests()

    const detail = await traceCaptureService.getSessionTraceCall(
      'session-bounded-detail',
      'call-bounded-detail',
    )
    const diagnostics = getTraceCaptureDiagnosticsForTests()

    expect(detail?.id).toBe('call-bounded-detail')
    expect(diagnostics.fullJsonlBytesRead).toBe(0)
    expect(diagnostics.incrementalJsonlBytesRead).toBe(sourceSize)
    expect(diagnostics.incrementalJsonlBytesRead).toBeLessThan(250_000)
  })

  test('uses the last-write-wins locator and falls back when a locator is corrupt', async () => {
    for (const [status, prompt] of [['pending', 'old'], ['ok', 'new']] as const) {
      await traceCaptureService.recordCall({
        id: 'call-lww-detail',
        sessionId: 'session-lww-detail',
        source: 'proxy',
        status,
        startedAt: '2026-07-15T08:00:00.000Z',
        ...(status === 'ok' ? { completedAt: '2026-07-15T08:00:00.010Z' } : {}),
        request: { body: { prompt } },
        ...(status === 'ok' ? { response: { status: 200, body: { ok: true } } } : {}),
      })
    }
    clearTraceCaptureStateForTests()
    const latest = await traceCaptureService.getSessionTraceCall('session-lww-detail', 'call-lww-detail')
    expect(latest?.request.body.preview).toContain('new')
    expect(getTraceCaptureDiagnosticsForTests().fullJsonlBytesRead).toBe(0)

    clearTraceCaptureStateForTests()
    const database = new Database(getTraceIndexDatabasePath())
    database.run(
      'UPDATE trace_calls SET byte_start = 1, byte_length = 8 WHERE session_id = ? AND call_id = ?',
      ['session-lww-detail', 'call-lww-detail'],
    )
    database.close()
    const fallback = await traceCaptureService.getSessionTraceCall(
      'session-lww-detail',
      'call-lww-detail',
    )
    expect(fallback?.request.body.preview).toContain('new')
    expect(getTraceCaptureDiagnosticsForTests().fullJsonlBytesRead).toBeGreaterThan(0)
  })

  test('falls back when a valid locator is tampered to an older record for the same call', async () => {
    for (const [status, prompt] of [['pending', 'old'], ['ok', 'new']] as const) {
      await traceCaptureService.recordCall({
        id: 'call-stale-locator',
        sessionId: 'session-stale-locator',
        source: 'proxy',
        status,
        startedAt: '2026-07-15T08:00:00.000Z',
        ...(status === 'ok' ? { completedAt: '2026-07-15T08:00:00.010Z' } : {}),
        request: { body: { prompt } },
        ...(status === 'ok' ? { response: { status: 200, body: { ok: true } } } : {}),
      })
    }
    const filePath = path.join(
      tmpDir,
      'cc-haha',
      'traces',
      'session-stale-locator.jsonl',
    )
    const raw = await fs.readFile(filePath)
    const oldLineLength = raw.indexOf(0x0a) + 1
    clearTraceCaptureStateForTests()
    const database = new Database(getTraceIndexDatabasePath())
    database.run(
      'UPDATE trace_calls SET byte_start = 0, byte_length = ? WHERE session_id = ? AND call_id = ?',
      [oldLineLength, 'session-stale-locator', 'call-stale-locator'],
    )
    database.close()

    const detail = await traceCaptureService.getSessionTraceCall(
      'session-stale-locator',
      'call-stale-locator',
    )

    expect(detail?.status).toBe('ok')
    expect(detail?.request.body.preview).toContain('new')
    expect(getTraceCaptureDiagnosticsForTests().fullJsonlBytesRead).toBeGreaterThan(0)
  })
})
