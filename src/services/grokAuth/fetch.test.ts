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
    if (original === undefined) delete process.env[GROK_OAUTH_FILE_ENV_KEY]
    else process.env[GROK_OAUTH_FILE_ENV_KEY] = original
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  test('maps Anthropic messages to the exact subscription endpoint and identity', async () => {
    let call: { url: string; headers: Headers; body: Record<string, unknown> } | undefined
    const fetchOverride: typeof fetch = async (input, init) => {
      call = {
        url: String(input),
        headers: new Headers(init?.headers),
        body: JSON.parse(String(init?.body)),
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
    })

    expect(call?.url).toBe(GROK_CLI_API_ENDPOINT)
    expect(call?.headers.get('Authorization')).toBe('Bearer access')
    expect(call?.headers.get('X-XAI-Token-Auth')).toBe('xai-grok-cli')
    expect(call?.headers.get('x-grok-client-version')).toBe(GROK_CLI_VERSION)
    expect(call?.headers.get('User-Agent')).toBe(`xai-grok-workspace/${GROK_CLI_VERSION}`)
    expect(call?.headers.get('x-grok-model-override')).toBe('grok-4.5')
    expect(call?.body.model).toBe('grok-4.5')
    expect(call?.body.reasoning).toEqual({ effort: 'high' })
    expect(call?.body.stream).toBe(true)
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      type: 'message', content: [{ type: 'text', text: 'ok' }],
    })
  })

  test('drops Claude reasoning effort for Grok models that reject it', async () => {
    let upstreamBody: Record<string, unknown> | undefined
    const fetchOverride: typeof fetch = async (_input, init) => {
      upstreamBody = JSON.parse(String(init?.body))
      return new Response([
        'event: response.completed',
        'data: {"response":{"id":"resp_no_effort","object":"response","created_at":1,"model":"grok-composer-2.5-fast","status":"completed","output":[],"usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}',
        '',
      ].join('\n'), { headers: { 'Content-Type': 'text/event-stream' } })
    }

    const response = await buildGrokFetch(fetchOverride, 'test')(
      'https://api.anthropic.com/v1/messages',
      { method: 'POST', body: JSON.stringify({
        model: 'grok-composer-2.5-fast',
        max_tokens: 64,
        output_config: { effort: 'max' },
        messages: [{ role: 'user', content: 'hello' }],
      }) },
    )

    expect(response.status).toBe(200)
    expect(upstreamBody?.reasoning).toBeUndefined()
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
