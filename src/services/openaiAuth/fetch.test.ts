import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import { configureEffortParams } from '../api/claude.js'
import { OPENAI_CODEX_API_ENDPOINT } from './client.js'
import { buildOpenAICodexFetch } from './fetch.js'
import { OPENAI_CODEX_REASONING_EFFORT_ENV_KEY } from './models.js'
import { clearOpenAIOAuthTokenCache } from './storage.js'

describe('buildOpenAICodexFetch', () => {
  let tmpDir: string
  let originalTokenFile: string | undefined
  let originalReasoningEffort: string | undefined

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'openai-codex-fetch-'))
    originalTokenFile = process.env.OPENAI_CODEX_OAUTH_FILE
    originalReasoningEffort = process.env[OPENAI_CODEX_REASONING_EFFORT_ENV_KEY]
    delete process.env[OPENAI_CODEX_REASONING_EFFORT_ENV_KEY]
    process.env.OPENAI_CODEX_OAUTH_FILE = path.join(tmpDir, 'openai-oauth.json')
    clearOpenAIOAuthTokenCache()
    await fs.writeFile(
      process.env.OPENAI_CODEX_OAUTH_FILE,
      JSON.stringify({
        accessToken: 'access-for-chatgpt',
        refreshToken: 'refresh-for-chatgpt',
        expiresAt: Date.now() + 60 * 60_000,
        accountId: 'acct_fetch',
        email: 'user@example.com',
      }),
      'utf-8',
    )
  })

  afterEach(async () => {
    if (originalTokenFile === undefined) {
      delete process.env.OPENAI_CODEX_OAUTH_FILE
    } else {
      process.env.OPENAI_CODEX_OAUTH_FILE = originalTokenFile
    }
    if (originalReasoningEffort === undefined) {
      delete process.env[OPENAI_CODEX_REASONING_EFFORT_ENV_KEY]
    } else {
      process.env[OPENAI_CODEX_REASONING_EFFORT_ENV_KEY] = originalReasoningEffort
    }
    clearOpenAIOAuthTokenCache()
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  test('preserves a structured policy rejection even when upstream wraps it in HTTP 503', async () => {
    const codexFetch = buildOpenAICodexFetch(async () => Response.json({
      error: { code: 'cyber_policy', message: 'Request blocked by safety policy' },
    }, { status: 503, headers: { 'x-request-id': 'policy-request-id' } }), 'test')!
    const response = await codexFetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      body: JSON.stringify({ model: 'gpt-6-astra', max_tokens: 64, messages: [{ role: 'user', content: 'Hello' }] }),
    })
    expect(response.status).toBe(403)
    expect(response.headers.get('x-should-retry')).toBe('false')
    expect(response.headers.get('x-request-id')).toBe('policy-request-id')
    expect(await response.json()).toEqual({
      type: 'error',
      error: { type: 'permission_error', code: 'cyber_policy', message: 'Request blocked by safety policy' },
    })
  })

  test('maps Anthropic messages to ChatGPT Codex responses endpoint with account header', async () => {
    const upstreamCalls: Array<{
      url: string
      headers: Record<string, string>
      body: Record<string, unknown>
      proxy?: string
    }> = []
    const fetchOverride: typeof fetch = async (input, init) => {
      const headers = new Headers(init?.headers)
      upstreamCalls.push({
        url: String(input),
        headers: Object.fromEntries(headers.entries()),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
        proxy: (init as RequestInit & { proxy?: string } | undefined)?.proxy,
      })
      return Response.json({
        id: 'resp_123',
        object: 'response',
        created_at: 1_779_118_000,
        model: 'gpt-5.5',
        status: 'completed',
        output: [{
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'ok' }],
        }],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      })
    }

    const openAIFetch = buildOpenAICodexFetch(fetchOverride, 'test')
    const response = await openAIFetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      body: JSON.stringify({
        model: 'gpt-5.5',
        max_tokens: 64,
        messages: [{ role: 'user', content: 'Say ok' }],
      }),
      proxy: 'http://127.0.0.1:17890',
    } as RequestInit & { proxy: string })

    expect(upstreamCalls).toHaveLength(1)
    expect(upstreamCalls[0].url).toBe(OPENAI_CODEX_API_ENDPOINT)
    expect(upstreamCalls[0].headers.authorization).toBe('Bearer access-for-chatgpt')
    expect(upstreamCalls[0].headers.accept).toBe('text/event-stream')
    expect(upstreamCalls[0].headers['chatgpt-account-id']).toBe('acct_fetch')
    expect(upstreamCalls[0].headers.originator).toBe('codex_cli_rs')
    expect(upstreamCalls[0].body.model).toBe('gpt-5.5')
    expect(upstreamCalls[0].body.reasoning).toEqual({ effort: 'medium' })
    expect(upstreamCalls[0].body.include).toEqual(['reasoning.encrypted_content'])
    expect(upstreamCalls[0].proxy).toBe('http://127.0.0.1:17890')
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      type: 'message',
      model: 'gpt-5.5',
      content: [{ type: 'text', text: 'ok' }],
    })
  })

  test('uses streamed Codex responses even for non-streaming Anthropic callers', async () => {
    const upstreamCalls: Array<{
      url: string
      body: Record<string, unknown>
    }> = []
    const fetchOverride: typeof fetch = async (input, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      upstreamCalls.push({
        url: String(input),
        body,
      })
      return new Response([
        'event: response.completed',
        'data: {"response":{"id":"resp_456","object":"response","created_at":1779118000,"model":"gpt-5.5","status":"completed","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"streamed ok"}]}],"usage":{"input_tokens":3,"output_tokens":2,"total_tokens":5}}}',
        '',
      ].join('\n'), {
        headers: { 'Content-Type': 'text/event-stream' },
      })
    }

    const openAIFetch = buildOpenAICodexFetch(fetchOverride, 'test')
    const response = await openAIFetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      body: JSON.stringify({
        model: 'gpt-5.5',
        max_tokens: 64,
        messages: [{ role: 'user', content: 'Say ok' }],
      }),
    })

    expect(upstreamCalls).toHaveLength(1)
    expect(upstreamCalls[0].url).toBe(OPENAI_CODEX_API_ENDPOINT)
    expect(upstreamCalls[0].body.stream).toBe(true)
    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toContain('application/json')
    await expect(response.json()).resolves.toMatchObject({
      type: 'message',
      model: 'gpt-5.5',
      content: [{ type: 'text', text: 'streamed ok' }],
    })
  })

  test('marks streaming responses as OpenAI OAuth and preserves encrypted reasoning', async () => {
    const upstreamBodies: Array<Record<string, unknown>> = []
    const fetchOverride: typeof fetch = async (_input, init) => {
      upstreamBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      return new Response([
        'event: response.created',
        'data: {"response":{"id":"resp_reasoning","model":"gpt-5.6-terra","status":"in_progress"}}',
        '',
        'event: response.output_item.done',
        'data: {"output_index":0,"item":{"type":"reasoning","id":"rs_fetch","summary":[],"encrypted_content":"opaque"}}',
        '',
        'event: response.completed',
        'data: {"response":{"id":"resp_reasoning","object":"response","created_at":1779118000,"model":"gpt-5.6-terra","status":"completed","output":[],"usage":{"input_tokens":3,"output_tokens":2,"total_tokens":5}}}',
        '',
      ].join('\n'), {
        headers: { 'Content-Type': 'text/event-stream' },
      })
    }
    const openAIFetch = buildOpenAICodexFetch(fetchOverride, 'compact')

    const response = await openAIFetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      body: JSON.stringify({
        model: 'gpt-5.6-terra',
        max_tokens: 64,
        stream: true,
        messages: [{ role: 'user', content: 'Compact this' }],
      }),
    })
    const body = await response.text()

    expect(response.headers.get('x-cc-haha-openai-codex-stream')).toBe('1')
    expect(upstreamBodies[0].include).toEqual(['reasoning.encrypted_content'])
    expect(body).toContain('redacted_thinking')
    expect(body).toContain('opaque')
  })

  test('does not propagate SDK cleanup abort after response.completed', async () => {
    const requestController = new AbortController()
    let upstreamSignal: AbortSignal | null | undefined
    const fetchOverride: typeof fetch = async (_input, init) => {
      upstreamSignal = init?.signal
      return new Response([
        'event: response.created',
        'data: {"response":{"id":"resp_terminal","model":"gpt-5.6-terra","status":"in_progress"}}',
        '',
        'event: response.completed',
        'data: {"response":{"id":"resp_terminal","object":"response","created_at":1779118000,"model":"gpt-5.6-terra","status":"completed","output":[],"usage":{"input_tokens":3,"output_tokens":2,"total_tokens":5}}}',
        '',
      ].join('\n'), {
        headers: { 'Content-Type': 'text/event-stream' },
      })
    }
    const openAIFetch = buildOpenAICodexFetch(fetchOverride, 'test')

    const response = await openAIFetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: requestController.signal,
      body: JSON.stringify({
        model: 'gpt-5.6-terra',
        max_tokens: 64,
        stream: true,
        messages: [{ role: 'user', content: 'Say ok' }],
      }),
    })
    await response.text()
    requestController.abort(new Error('SDK stream cleanup'))

    expect(upstreamSignal).not.toBe(requestController.signal)
    expect(upstreamSignal?.aborted).toBe(false)
  })

  test('still propagates cancellation before a Responses terminal event', async () => {
    const requestController = new AbortController()
    let upstreamSignal: AbortSignal | null | undefined
    const fetchOverride: typeof fetch = async (_input, init) => {
      upstreamSignal = init?.signal
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode([
            'event: response.created',
            'data: {"response":{"id":"resp_cancel","model":"gpt-5.6-terra","status":"in_progress"}}',
            '',
            '',
          ].join('\n')))
        },
      }), {
        headers: { 'Content-Type': 'text/event-stream' },
      })
    }
    const openAIFetch = buildOpenAICodexFetch(fetchOverride, 'test')
    const response = await openAIFetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: requestController.signal,
      body: JSON.stringify({
        model: 'gpt-5.6-terra',
        max_tokens: 64,
        stream: true,
        messages: [{ role: 'user', content: 'Say ok' }],
      }),
    })
    const reader = response.body!.getReader()
    await reader.read()
    await reader.cancel('consumer stopped')

    expect(upstreamSignal?.aborted).toBe(true)
  })

  test('applies defaults and validates request and session efforts for the final request', async () => {
    const upstreamBodies: Array<Record<string, unknown>> = []
    const fetchOverride: typeof fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      upstreamBodies.push(body)
      return Response.json({
        id: `resp_${upstreamBodies.length}`,
        object: 'response',
        created_at: 1_779_118_000,
        model: body.model,
        status: 'completed',
        output: [{
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'ok' }],
        }],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      })
    }
    const openAIFetch = buildOpenAICodexFetch(fetchOverride, 'test')

    const send = async (
      model: string,
      sessionEffort?: string,
      requestEffort?: string,
    ) => {
      if (sessionEffort) {
        process.env[OPENAI_CODEX_REASONING_EFFORT_ENV_KEY] = sessionEffort
      } else {
        delete process.env[OPENAI_CODEX_REASONING_EFFORT_ENV_KEY]
      }
      await openAIFetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        body: JSON.stringify({
          model,
          max_tokens: 64,
          messages: [{ role: 'user', content: 'Say ok' }],
          ...(requestEffort && { output_config: { effort: requestEffort } }),
        }),
      })
    }

    await send('gpt-5.6-sol')
    await send('gpt-5.6-terra')
    await send('gpt-5.6-sol', 'xhigh')
    await send('gpt-5.6-luna', 'max')
    await send('gpt-5.5', 'max')
    await send('gpt-5.5', 'xhigh', 'max')

    expect(upstreamBodies.map((body) => body.reasoning)).toEqual([
      { effort: 'low' },
      { effort: 'medium' },
      { effort: 'xhigh' },
      { effort: 'max' },
      { effort: 'medium' },
      { effort: 'xhigh' },
    ])
  })

  test('keeps Agent request effort above Desktop session effort without synthesizing high', async () => {
    const upstreamBodies: Array<Record<string, unknown>> = []
    const fetchOverride: typeof fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      upstreamBodies.push(body)
      return Response.json({
        id: `resp_${upstreamBodies.length}`,
        object: 'response',
        created_at: 1_779_118_000,
        model: body.model,
        status: 'completed',
        output: [{
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'ok' }],
        }],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      })
    }
    const openAIFetch = buildOpenAICodexFetch(fetchOverride, 'agent:custom')

    const send = async (
      sessionEffort: 'low' | 'xhigh' | 'max',
      requestEffort?: 'low' | 'xhigh' | 'max',
    ) => {
      process.env[OPENAI_CODEX_REASONING_EFFORT_ENV_KEY] = sessionEffort
      const outputConfig: Record<string, unknown> = {}
      configureEffortParams(
        requestEffort,
        outputConfig,
        {},
        [],
        'gpt-5.6-sol',
      )
      await openAIFetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        body: JSON.stringify({
          model: 'gpt-5.6-sol',
          max_tokens: 64,
          messages: [{ role: 'user', content: 'Say ok' }],
          ...(Object.keys(outputConfig).length > 0 && {
            output_config: outputConfig,
          }),
        }),
      })
    }

    // Agent effort omitted: inherit the Desktop session choice at every
    // supported level instead of receiving a synthetic request-level high.
    await send('low')
    await send('xhigh')
    await send('max')
    // Agent effort explicit: request-scoped value remains authoritative.
    await send('max', 'low')

    expect(upstreamBodies.map(body => body.reasoning)).toEqual([
      { effort: 'low' },
      { effort: 'xhigh' },
      { effort: 'max' },
      { effort: 'low' },
    ])
  })

  test('keeps concurrent subagent request efforts isolated from the session default', async () => {
    process.env[OPENAI_CODEX_REASONING_EFFORT_ENV_KEY] = 'high'
    const upstreamBodies: Array<Record<string, unknown>> = []
    const fetchOverride: typeof fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      // Let the two requests overlap and finish in the opposite order from
      // their launch. Per-request effort must not depend on process.env writes.
      await new Promise(resolve =>
        setTimeout(resolve, body.model === 'gpt-5.6-luna' ? 10 : 0),
      )
      upstreamBodies.push(body)
      return Response.json({
        id: `resp_${String(body.model)}`,
        object: 'response',
        created_at: 1_779_118_000,
        model: body.model,
        status: 'completed',
        output: [{
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'ok' }],
        }],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      })
    }
    const openAIFetch = buildOpenAICodexFetch(fetchOverride, 'agent:custom')

    await Promise.all([
      openAIFetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        body: JSON.stringify({
          model: 'gpt-5.6-luna',
          max_tokens: 64,
          messages: [{ role: 'user', content: 'Quick lookup' }],
          output_config: { effort: 'low' },
        }),
      }),
      openAIFetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        body: JSON.stringify({
          model: 'gpt-5.6-sol',
          max_tokens: 64,
          messages: [{ role: 'user', content: 'Deep analysis' }],
          output_config: { effort: 'xhigh' },
        }),
      }),
    ])

    expect(
      Object.fromEntries(
        upstreamBodies.map(body => [String(body.model), body.reasoning]),
      ),
    ).toEqual({
      'gpt-5.6-luna': { effort: 'low' },
      'gpt-5.6-sol': { effort: 'xhigh' },
    })
    expect(process.env[OPENAI_CODEX_REASONING_EFFORT_ENV_KEY]).toBe('high')
  })
})
