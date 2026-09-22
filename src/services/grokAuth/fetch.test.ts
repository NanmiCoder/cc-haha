import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import {
  buildGrokFetch,
  GROK_CLI_API_ENDPOINT,
  GROK_CLI_VERSION,
} from './fetch.js'
import { GROK_OAUTH_FILE_ENV_KEY } from './storage.js'
import { GROK_OAUTH_TOKEN_ENDPOINT } from './client.js'
import {
  GROK_MODEL_CATALOG,
  setGrokRuntimeModelCatalog,
  type GrokModelCatalogEntry,
} from './models.js'
import { isRetryableStreamTransportError } from '../api/withRetry.js'

describe('Grok Responses fetch adapter', () => {
  let tmpDir: string
  let original: string | undefined

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'grok-fetch-'))
    original = process.env[GROK_OAUTH_FILE_ENV_KEY]
    process.env[GROK_OAUTH_FILE_ENV_KEY] = path.join(tmpDir, 'tokens.json')
    await fs.writeFile(process.env[GROK_OAUTH_FILE_ENV_KEY], JSON.stringify({
      accessToken: 'access',
      refreshToken: 'refresh',
      expiresAt: Date.now() + 3_600_000,
    }))
  })

  afterEach(async () => {
    setGrokRuntimeModelCatalog(GROK_MODEL_CATALOG)
    if (original === undefined) delete process.env[GROK_OAUTH_FILE_ENV_KEY]
    else process.env[GROK_OAUTH_FILE_ENV_KEY] = original
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  test('maps Anthropic messages to the exact subscription endpoint and identity', async () => {
    let call: {
      url: string
      headers: Headers
      body: Record<string, unknown>
      proxy?: string
    } | undefined
    const fetchOverride: typeof fetch = async (input, init) => {
      call = {
        url: String(input),
        headers: new Headers(init?.headers),
        body: JSON.parse(String(init?.body)),
        proxy: (init as RequestInit & { proxy?: string } | undefined)?.proxy,
      }
      return new Response([
        'event: response.completed',
        'data: {"response":{"id":"resp_1","object":"response","created_at":1,"model":"grok-4.5","status":"completed","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"ok"}]}],"usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}',
        '',
      ].join('\n'), { headers: { 'Content-Type': 'text/event-stream' } })
    }
    const grokFetch = buildGrokFetch(fetchOverride, 'test')
    const response = await grokFetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      body: JSON.stringify({
        model: 'grok-4.5', max_tokens: 64,
        output_config: { effort: 'max' },
        messages: [{ role: 'user', content: 'Say ok' }],
      }),
      proxy: 'http://127.0.0.1:17890',
    } as RequestInit & { proxy: string })

    expect(call?.url).toBe(GROK_CLI_API_ENDPOINT)
    expect(call?.headers.get('Authorization')).toBe('Bearer access')
    expect(call?.headers.get('X-XAI-Token-Auth')).toBe('xai-grok-cli')
    expect(call?.headers.get('x-grok-client-version')).toBe(GROK_CLI_VERSION)
    expect(call?.headers.get('x-grok-client-mode')).toBe('interactive')
    expect(call?.headers.get('User-Agent')).toBe(`xai-grok-workspace/${GROK_CLI_VERSION}`)
    expect(call?.headers.get('x-grok-model-override')).toBe('grok-4.5')
    expect(call?.body.model).toBe('grok-4.5')
    expect(call?.body.reasoning).toEqual({ effort: 'high' })
    expect(call?.body.stream).toBe(true)
    expect(call?.proxy).toBe('http://127.0.0.1:17890')
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      type: 'message', content: [{ type: 'text', text: 'ok' }],
    })
  })

  test('drops Claude reasoning effort for Grok models that reject it', async () => {
    setGrokRuntimeModelCatalog([
      liveModel('grok-4.8', { supportsReasoningEffort: false }),
    ])
    let upstreamBody: Record<string, unknown> | undefined
    const fetchOverride: typeof fetch = async (_input, init) => {
      upstreamBody = JSON.parse(String(init?.body))
      return new Response([
        'event: response.completed',
        'data: {"response":{"id":"resp_no_effort","object":"response","created_at":1,"model":"grok-4.8","status":"completed","output":[],"usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}',
        '',
      ].join('\n'), { headers: { 'Content-Type': 'text/event-stream' } })
    }

    const response = await buildGrokFetch(fetchOverride, 'test')(
      'https://api.anthropic.com/v1/messages',
      { method: 'POST', body: JSON.stringify({
        model: 'grok-4.8',
        max_tokens: 64,
        output_config: { effort: 'max' },
        messages: [{ role: 'user', content: 'hello' }],
      }) },
    )

    expect(response.status).toBe(200)
    expect(upstreamBody?.reasoning).toBeUndefined()
  })

  test('honors the effort set the live catalog declares for a model this build predates', async () => {
    // Regression: `resolveGrokReasoningEffort` used to read only the bundled
    // catalog, so the live feed's per-model capability declaration was ignored
    // for every model newer than this build.
    setGrokRuntimeModelCatalog([
      liveModel('grok-4.8', {
        supportsReasoningEffort: true,
        reasoningEffort: 'high',
        reasoningEfforts: ['high', 'medium', 'low'],
      }),
    ])
    let upstreamBody: Record<string, unknown> | undefined
    const fetchOverride: typeof fetch = async (_input, init) => {
      upstreamBody = JSON.parse(String(init?.body))
      return new Response([
        'event: response.completed',
        'data: {"response":{"id":"resp_live_effort","object":"response","created_at":1,"model":"grok-4.8","status":"completed","output":[],"usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}',
        '',
      ].join('\n'), { headers: { 'Content-Type': 'text/event-stream' } })
    }

    const response = await buildGrokFetch(fetchOverride, 'test')(
      'https://api.anthropic.com/v1/messages',
      { method: 'POST', body: JSON.stringify({
        model: 'grok-4.8',
        max_tokens: 64,
        output_config: { effort: 'xhigh' },
        messages: [{ role: 'user', content: 'hello' }],
      }) },
    )

    expect(response.status).toBe(200)
    // xhigh is not in the live set, so it must clamp to the declared default
    // rather than being forwarded or dropped.
    expect(upstreamBody?.reasoning).toEqual({ effort: 'high' })
  })

  test('forwards the selected effort for a model neither catalog describes', async () => {
    // The old fallback returned undefined here, and the transform reads that as
    // "the model rejects effort" and deletes the whole reasoning block — so a
    // model launched after this build ran at the upstream default no matter what
    // the user selected.
    let upstreamBody: Record<string, unknown> | undefined
    const fetchOverride: typeof fetch = async (_input, init) => {
      upstreamBody = JSON.parse(String(init?.body))
      return new Response([
        'event: response.completed',
        'data: {"response":{"id":"resp_unknown_effort","object":"response","created_at":1,"model":"grok-4.9-preview","status":"completed","output":[],"usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}',
        '',
      ].join('\n'), { headers: { 'Content-Type': 'text/event-stream' } })
    }

    const response = await buildGrokFetch(fetchOverride, 'test')(
      'https://api.anthropic.com/v1/messages',
      { method: 'POST', body: JSON.stringify({
        model: 'grok-4.9-preview',
        max_tokens: 64,
        output_config: { effort: 'xhigh' },
        messages: [{ role: 'user', content: 'hello' }],
      }) },
    )

    expect(response.status).toBe(200)
    expect(upstreamBody?.reasoning).toEqual({ effort: 'xhigh' })
  })

  test('routes remotely discovered model IDs without silently replacing them', async () => {
    let upstreamBody: Record<string, unknown> | undefined
    let upstreamHeaders: Headers | undefined
    const fetchOverride: typeof fetch = async (_input, init) => {
      upstreamBody = JSON.parse(String(init?.body))
      upstreamHeaders = new Headers(init?.headers)
      return new Response([
        'event: response.completed',
        'data: {"response":{"id":"resp_remote","object":"response","created_at":1,"model":"grok-next-preview","status":"completed","output":[],"usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}',
        '',
      ].join('\n'), { headers: { 'Content-Type': 'text/event-stream' } })
    }

    const response = await buildGrokFetch(fetchOverride, 'test')(
      'https://api.anthropic.com/v1/messages',
      { method: 'POST', body: JSON.stringify({
        model: 'grok-next-preview',
        max_tokens: 64,
        messages: [{ role: 'user', content: 'hello' }],
      }) },
    )

    expect(response.status).toBe(200)
    expect(upstreamBody?.model).toBe('grok-next-preview')
    expect(upstreamHeaders?.get('x-grok-model-override')).toBe('grok-next-preview')
  })

  test('translates subscription SSE back to Anthropic streaming events', async () => {
    const fetchOverride: typeof fetch = async () => new Response([
      'event: response.created',
      'data: {"id":"resp_2","object":"response","created_at":1,"model":"grok-4.5","status":"in_progress"}',
      '',
      'event: response.content_part.added',
      'data: {"output_index":0,"content_index":0,"part":{"type":"output_text","text":""}}',
      '',
      'event: response.output_text.delta',
      'data: {"output_index":0,"content_index":0,"delta":"hello"}',
      '',
      'event: response.output_text.done',
      'data: {"output_index":0,"content_index":0,"text":"hello"}',
      '',
      'event: response.completed',
      'data: {"response":{"id":"resp_2","object":"response","created_at":1,"model":"grok-4.5","status":"completed","output":[],"usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}',
      '',
    ].join('\n'), { headers: { 'Content-Type': 'text/event-stream' } })
    const response = await buildGrokFetch(fetchOverride, 'test')(
      'https://api.anthropic.com/v1/messages',
      { method: 'POST', body: JSON.stringify({
        model: 'claude-opus-4-1', max_tokens: 64, stream: true,
        messages: [{ role: 'user', content: 'hello' }],
      }) },
    )
    expect(response.headers.get('Content-Type')).toContain('text/event-stream')
    expect(await response.text()).toContain('text_delta')
  })

  test('refreshes once after a 401, persists rotation, and retries with the new access token', async () => {
    const inferenceAuth: string[] = []
    const fetchOverride: typeof fetch = async (input, init) => {
      if (String(input) === GROK_OAUTH_TOKEN_ENDPOINT) {
        return Response.json({
          access_token: 'new-access',
          refresh_token: 'new-refresh',
          expires_in: 3600,
        })
      }
      inferenceAuth.push(new Headers(init?.headers).get('Authorization') ?? '')
      if (inferenceAuth.length === 1) return new Response('expired', { status: 401 })
      return new Response([
        'event: response.completed',
        'data: {"response":{"id":"resp_retry","object":"response","created_at":1,"model":"grok-4.5","status":"completed","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"ok"}]}],"usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}',
        '',
      ].join('\n'), { headers: { 'Content-Type': 'text/event-stream' } })
    }

    const response = await buildGrokFetch(fetchOverride, 'test')(
      'https://api.anthropic.com/v1/messages',
      { method: 'POST', body: JSON.stringify({
        model: 'grok-4.5', max_tokens: 64,
        messages: [{ role: 'user', content: 'hello' }],
      }) },
    )

    expect(response.status).toBe(200)
    expect(inferenceAuth).toEqual(['Bearer access', 'Bearer new-access'])
    expect(JSON.parse(await fs.readFile(process.env[GROK_OAUTH_FILE_ENV_KEY]!, 'utf8'))).toMatchObject({
      accessToken: 'new-access',
      refreshToken: 'new-refresh',
    })
  })

  // Every turn of one conversation must land on the same cache entry, or the
  // whole prefix is re-billed each time. xAI reads the identity from the body,
  // the CLI proxy from a header — both must carry it, and both must survive the
  // 401 refresh retry.
  describe('prompt cache identity', () => {
    async function capture(
      body: Record<string, unknown>,
      init: RequestInit = {},
    ): Promise<{ headers: Headers; body: Record<string, unknown> }[]> {
      const calls: { headers: Headers; body: Record<string, unknown> }[] = []
      const fetchOverride: typeof fetch = async (input, requestInit) => {
        if (String(input) === GROK_OAUTH_TOKEN_ENDPOINT) {
          return Response.json({
            access_token: 'new-access',
            refresh_token: 'new-refresh',
            expires_in: 3600,
          })
        }
        calls.push({
          headers: new Headers(requestInit?.headers),
          body: JSON.parse(String(requestInit?.body)),
        })
        return new Response(
          'event: response.completed\ndata: {"response":{"id":"r","object":"response","created_at":1,"model":"grok-4.5","status":"completed","output":[],"usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}\n\n',
          { headers: { 'Content-Type': 'text/event-stream' } },
        )
      }
      await buildGrokFetch(fetchOverride, 'test')(
        'https://api.anthropic.com/v1/messages',
        { method: 'POST', ...init, body: JSON.stringify(body) },
      )
      return calls
    }

    const anthropicBody = (metadata?: Record<string, unknown>) => ({
      model: 'grok-4.5',
      max_tokens: 64,
      messages: [{ role: 'user', content: 'hello' }],
      ...(metadata ? { metadata } : {}),
    })

    test("derives it from Claude Code's session-suffixed user_id", async () => {
      const calls = await capture(
        anthropicBody({ user_id: 'user_abc_session_sess-123' }),
      )
      expect(calls[0]?.body.prompt_cache_key).toBe('sess-123')
      expect(calls[0]?.headers.get('x-grok-conv-id')).toBe('sess-123')
    })

    test('falls back to the CLI session header', async () => {
      const calls = await capture(anthropicBody(), {
        headers: { 'X-Claude-Code-Session-Id': 'sess-header' },
      })
      expect(calls[0]?.body.prompt_cache_key).toBe('sess-header')
      expect(calls[0]?.headers.get('x-grok-conv-id')).toBe('sess-header')
    })

    test('sends no identity rather than an unstable one', async () => {
      const calls = await capture(anthropicBody())
      expect(calls[0]?.body.prompt_cache_key).toBeUndefined()
      expect(calls[0]?.headers.get('x-grok-conv-id')).toBeNull()
    })

    test('keeps the identity on the retry after a 401 refresh', async () => {
      const calls: { headers: Headers; body: Record<string, unknown> }[] = []
      const fetchOverride: typeof fetch = async (input, requestInit) => {
        if (String(input) === GROK_OAUTH_TOKEN_ENDPOINT) {
          return Response.json({
            access_token: 'new-access',
            refresh_token: 'new-refresh',
            expires_in: 3600,
          })
        }
        calls.push({
          headers: new Headers(requestInit?.headers),
          body: JSON.parse(String(requestInit?.body)),
        })
        if (calls.length === 1) return new Response('expired', { status: 401 })
        return new Response(
          'event: response.completed\ndata: {"response":{"id":"r","object":"response","created_at":1,"model":"grok-4.5","status":"completed","output":[],"usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}\n\n',
          { headers: { 'Content-Type': 'text/event-stream' } },
        )
      }
      await buildGrokFetch(fetchOverride, 'test')(
        'https://api.anthropic.com/v1/messages',
        {
          method: 'POST',
          body: JSON.stringify(
            anthropicBody({ user_id: 'user_abc_session_sess-retry' }),
          ),
        },
      )

      expect(calls).toHaveLength(2)
      for (const call of calls) {
        expect(call.headers.get('x-grok-conv-id')).toBe('sess-retry')
        expect(call.headers.get('x-grok-model-override')).toBe('grok-4.5')
        expect(call.headers.get('x-grok-client-mode')).toBe('interactive')
        expect(call.body.prompt_cache_key).toBe('sess-retry')
      }
    })
  })

  // The Grok subscription endpoint is reached over a long-lived TLS stream held
  // open by the CLI process, so a proxy/NAT/edge reset lands mid-response
  // rather than on stream creation. Drive a real socket reset — not a fake
  // error object — so the classifier is pinned to what the runtime actually
  // throws through the SSE transform.
  test('surfaces a mid-stream socket reset as a retryable transport error', async () => {
    const upstream = Bun.listen({
      hostname: '127.0.0.1',
      port: 0,
      socket: {
        data(socket) {
          socket.write(
            'HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n',
          )
          const event = [
            'event: response.created',
            'data: {"model":"grok-4.5"}',
            '',
            '',
          ].join('\n')
          socket.write(`${event.length.toString(16)}\r\n${event}\r\n`)
          setTimeout(() => socket.terminate(), 20)
        },
      },
    })

    try {
      const response = await buildGrokFetch(
        (_input, init) => fetch(`http://127.0.0.1:${upstream.port}/v1/responses`, init),
        'test',
      )('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        body: JSON.stringify({
          model: 'grok-4.5',
          max_tokens: 64,
          stream: true,
          messages: [{ role: 'user', content: 'hello' }],
        }),
      })

      expect(response.status).toBe(200)

      let thrown: unknown
      try {
        const reader = response.body!.getReader()
        for (;;) {
          const { done } = await reader.read()
          if (done) break
        }
      } catch (error) {
        thrown = error
      }

      // The transform must propagate the fault, not close the stream cleanly —
      // a clean close would look like a finished (truncated) turn.
      expect(thrown).toBeDefined()
      expect(isRetryableStreamTransportError(thrown)).toBe(true)
    } finally {
      upstream.stop(true)
    }
  })

  test('does not refresh-loop on entitlement failures', async () => {
    let calls = 0
    const response = await buildGrokFetch(async () => {
      calls += 1
      return new Response('subscription required', { status: 403 })
    }, 'test')(
      'https://api.anthropic.com/v1/messages',
      { method: 'POST', body: JSON.stringify({
        model: 'grok-4.5', max_tokens: 64,
        messages: [{ role: 'user', content: 'hello' }],
      }) },
    )
    expect(response.status).toBe(403)
    expect(calls).toBe(1)
  })
})

/** A `/v1/models` row as the CLI proxy advertises it. */
function liveModel(
  value: string,
  overrides: Partial<GrokModelCatalogEntry>,
): GrokModelCatalogEntry {
  return {
    value,
    label: value,
    description: '',
    contextWindow: 500_000,
    ...overrides,
  }
}
