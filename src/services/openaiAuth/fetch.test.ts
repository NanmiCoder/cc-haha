import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import { configureEffortParams, executeNonStreamingRequest } from '../api/claude.js'
import { asAgentId } from '../../types/ids.js'
import { OPENAI_CODEX_API_ENDPOINT } from './client.js'
import { buildOpenAICodexFetch } from './fetch.js'
import { OpenAICodexTurnState } from './turnState.js'
import { OPENAI_CODEX_REASONING_EFFORT_ENV_KEY } from './models.js'
import { clearOpenAIOAuthTokenCache } from './storage.js'
import { encodeOpenAIReasoningEnvelope } from '../../server/proxy/transform/openaiReasoning.js'
import { buildComputerUseTools } from '../../vendor/computer-use-mcp/tools.js'

function readWireBody(init?: RequestInit): Record<string, any> {
  const body = init?.body
  return JSON.parse(body instanceof Uint8Array
    ? Buffer.from(Bun.zstdDecompressSync(body)).toString('utf8')
    : String(body))
}

describe('buildOpenAICodexFetch', () => {
  let tmpDir: string
  let originalTokenFile: string | undefined
  let originalReasoningEffort: string | undefined
  let originalCompression: string | undefined

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'openai-codex-fetch-'))
    originalTokenFile = process.env.OPENAI_CODEX_OAUTH_FILE
    originalCompression = process.env.CC_HAHA_OPENAI_REQUEST_COMPRESSION
    delete process.env.CC_HAHA_OPENAI_REQUEST_COMPRESSION
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
    if (originalCompression === undefined) delete process.env.CC_HAHA_OPENAI_REQUEST_COMPRESSION
    else process.env.CC_HAHA_OPENAI_REQUEST_COMPRESSION = originalCompression
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

  test('dedicated OAuth omits output budgets while preserving optional schema fields and serial tools', async () => {
    let sent: Record<string, any> | undefined
    const codexFetch = buildOpenAICodexFetch(async (_input, init) => {
      sent = readWireBody(init)
      return Response.json({ id: 'fixture', status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '{}' }] }] })
    }, 'test')!
    const schema = { type: 'object', properties: { optional: { type: 'string' } } }
    const response = await codexFetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      body: JSON.stringify({
        model: 'gpt-6-astra', max_tokens: 64, messages: [{ role: 'user', content: 'fixture' }],
        tools: [{ name: 'Read', input_schema: { type: 'object' } }],
        tool_choice: { type: 'auto', disable_parallel_tool_use: true },
        output_config: { format: { type: 'json_schema', schema } },
      }),
    })
    expect(response.status).toBe(200)
    expect(sent?.max_output_tokens).toBeUndefined()
    expect(sent?.max_tokens).toBeUndefined()
    expect(sent?.parallel_tool_calls).toBe(false)
    expect(sent?.text.format).toEqual({ type: 'json_schema', name: 'response', schema, strict: false })
    expect(sent?.text.format.schema.required).toBeUndefined()
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
        body: readWireBody(init) as Record<string, unknown>,
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

  test('preserves optional Computer Use parameters in the final Codex OAuth request', async () => {
    const computerTools = buildComputerUseTools().filter(tool =>
      ['get_app_state', 'click'].includes(tool.name),
    )
    const originalSchemas = structuredClone(computerTools.map(tool => tool.inputSchema))
    const calls: Array<{ url: string; body: Record<string, unknown> }> = []
    const codexFetch = buildOpenAICodexFetch(async (input, init) => {
      calls.push({ url: String(input), body: readWireBody(init) })
      return Response.json({
        id: 'resp_computer_schema',
        object: 'response',
        created_at: 0,
        model: 'gpt-6-astra',
        status: 'completed',
        output: [],
      })
    }, 'test')

    const response = await codexFetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      body: JSON.stringify({
        model: 'gpt-6-astra',
        max_tokens: 64,
        messages: [{ role: 'user', content: 'Inspect Blender' }],
        tools: computerTools.map(tool => ({
          name: tool.name,
          description: tool.description,
          input_schema: tool.inputSchema,
        })),
      }),
    })
    expect(response.status).toBe(200)
    await response.text()
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe(OPENAI_CODEX_API_ENDPOINT)
    const outboundTools = calls[0].body.tools as Array<{
      name: string
      strict?: boolean
      parameters: Record<string, unknown>
    }>
    expect(outboundTools).toHaveLength(computerTools.length)
    for (const [index, tool] of outboundTools.entries()) {
      expect(tool.name).toBe(computerTools[index].name)
      expect(tool.strict).toBe(false)
      expect(tool.parameters).toEqual(originalSchemas[index])
      expect(tool.parameters.required).toEqual(['app'])
    }
    expect(computerTools.map(tool => tool.inputSchema)).toEqual(originalSchemas)
  })

  test('routes repeated session requests to a stable cache key without changing multimodal reasoning or tool schemas', async () => {
    const bodies: Array<Record<string, unknown>> = []
    const codexFetch = buildOpenAICodexFetch(async (_input, init) => {
      bodies.push(readWireBody(init))
      return Response.json({ id: 'resp_cache', object: 'response', status: 'completed', output: [] })
    }, 'test')
    const reasoning = { type: 'reasoning' as const, id: 'rs_cache', summary: [], encrypted_content: 'opaque-test-reasoning' }
    const schema = { type: 'object', properties: { app: { type: 'string' }, disableDiff: { type: 'boolean' } }, required: ['app'] }
    const body = JSON.stringify({
      model: 'gpt-6-astra', max_tokens: 64,
      output_config: { effort: 'high' },
      metadata: { user_id: JSON.stringify({ session_id: 'sdk-json-metadata' }) },
      messages: [
        { role: 'assistant', content: [
          { type: 'redacted_thinking', data: encodeOpenAIReasoningEnvelope(reasoning) },
          { type: 'tool_use', id: 'call_image', name: 'get_app_state', input: { app: 'Blender' } },
        ] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_image', content: [
          { type: 'text', text: 'Blender screenshot' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA==' } },
        ] }] },
      ],
      tools: [{ name: 'get_app_state', description: 'Observe app', input_schema: schema }],
    })
    for (const sessionId of ['session-one', 'session-one', 'session-two']) {
      const response = await codexFetch('https://api.anthropic.com/v1/messages', {
        method: 'POST', headers: { 'X-Claude-Code-Session-Id': sessionId }, body,
      })
      await response.text()
    }
    expect(bodies.map(item => item.prompt_cache_key)).toEqual(['session-one', 'session-one', 'session-two'])
    for (const outgoing of bodies) {
      expect(outgoing.reasoning).toEqual({ effort: 'high' })
      expect(outgoing.include).toEqual(['reasoning.encrypted_content'])
      expect(outgoing.input).toEqual([
        reasoning,
        { type: 'function_call', call_id: 'call_image', name: 'get_app_state', arguments: JSON.stringify({ app: 'Blender' }) },
        { type: 'function_call_output', call_id: 'call_image', output: [
          { type: 'input_text', text: 'Blender screenshot' },
          { type: 'input_image', image_url: 'data:image/png;base64,AA==' },
        ] },
      ])
      expect(outgoing.tools).toMatchObject([{ strict: false, parameters: schema }])
    }
  })

  test('uses existing cache identity precedence and Request headers without inventing a key', async () => {
    const keys: unknown[] = []
    const codexFetch = buildOpenAICodexFetch(async (_input, init) => {
      keys.push(readWireBody(init).prompt_cache_key)
      return Response.json({ id: 'resp_cache_identity', object: 'response', status: 'completed', output: [] })
    }, 'test')
    for (const entry of [
      { metadata: { user_id: 'user_test_session_metadata-session' }, header: 'header-session', initHeader: 'init-session' },
      { metadata: { session_id: 'metadata-field-session' }, header: 'header-session' },
      { header: 'request-session' },
      { header: 'request-session', initHeader: 'init-session' },
      {},
    ]) {
      const request = new Request('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: entry.header ? { 'x-claude-code-session-id': entry.header } : {},
        body: JSON.stringify({ model: 'gpt-6-astra', max_tokens: 64, metadata: entry.metadata, messages: [{ role: 'user', content: 'Hello' }] }),
      })
      const response = await codexFetch(request, entry.initHeader ? { headers: { 'X-Claude-Code-Session-Id': entry.initHeader } } : undefined)
      await response.text()
    }
    expect(keys).toEqual(['metadata-session', 'metadata-field-session', 'request-session', 'init-session', undefined])
  })

  test('replays the first server routing state across same-turn client recreation without rotating it', async () => {
    using state = new OpenAICodexTurnState(new AbortController().signal)
    const sent: Array<string | null> = []
    const upstream: typeof fetch = async (_input, init) => {
      sent.push(new Headers(init?.headers).get('x-codex-turn-state'))
      return Response.json({ id: 'resp_state', object: 'response', status: 'completed', output: [] }, {
        headers: { 'x-codex-turn-state': `server-state-${sent.length}` },
      })
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      // Auth retry/client recreation and tool continuation share the explicit turn object.
      const fetch = buildOpenAICodexFetch(upstream, 'test', state)
      await (await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST', body: JSON.stringify({ model: 'gpt-6-astra', messages: [{ role: 'user', content: 'Hello' }] }),
      })).text()
    }
    expect(sent).toEqual([null, 'server-state-1', 'server-state-1'])
    expect(JSON.stringify(state)).toBe('{}')
  })

  test('isolates concurrent turns with the same session key and discards canceled or finished state', async () => {
    const controller = new AbortController()
    using first = new OpenAICodexTurnState(controller.signal)
    using second = new OpenAICodexTurnState(new AbortController().signal)
    const firstSent: Array<string | null> = []
    const secondSent: Array<string | null> = []
    const upstream = (name: string, sent: Array<string | null>): typeof fetch => async (_input, init) => {
      sent.push(new Headers(init?.headers).get('x-codex-turn-state'))
      return Response.json({ id: 'resp_isolated', object: 'response', status: 'completed', output: [] }, {
        headers: { 'x-codex-turn-state': name },
      })
    }
    const request = async (state: OpenAICodexTurnState, name: string, sent: Array<string | null>) => {
      const fetch = buildOpenAICodexFetch(upstream(name, sent), 'test', state)
      await (await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST', headers: { 'X-Claude-Code-Session-Id': 'shared-session' },
        body: JSON.stringify({ model: 'gpt-6-astra', messages: [{ role: 'user', content: 'Hello' }] }),
      })).text()
    }
    await Promise.all([request(first, 'first', firstSent), request(second, 'second', secondSent)])
    await Promise.all([request(first, 'first-next', firstSent), request(second, 'second-next', secondSent)])
    expect(firstSent).toEqual([null, 'first'])
    expect(secondSent).toEqual([null, 'second'])
    controller.abort()
    expect(first.get()).toBeUndefined()
    first.capture('late-canceled-response')
    expect(first.get()).toBeUndefined()
    second[Symbol.dispose]()
    second.capture('late-finished-response')
    expect(second.get()).toBeUndefined()
    using nextTurn = new OpenAICodexTurnState(new AbortController().signal)
    await request(nextTurn, 'new-turn', firstSent)
    expect(firstSent).toEqual([null, 'first', null])
  })

  test('does not capture routing state from an error or a response arriving after cancellation', async () => {
    const controller = new AbortController()
    using state = new OpenAICodexTurnState(controller.signal)
    const sent: Array<string | null> = []
    let attempt = 0
    const fetch = buildOpenAICodexFetch(async (_input, init) => {
      sent.push(new Headers(init?.headers).get('x-codex-turn-state'))
      if (attempt++ === 0) return Response.json({ error: 'temporary' }, { status: 503, headers: { 'x-codex-turn-state': 'error-state' } })
      controller.abort()
      return Response.json({ id: 'late', object: 'response', status: 'completed', output: [] }, { headers: { 'x-codex-turn-state': 'late-state' } })
    }, 'test', state)
    for (let i = 0; i < 2; i++) await (await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', body: JSON.stringify({ model: 'gpt-6-astra', messages: [{ role: 'user', content: 'Hello' }] }),
    })).text()
    expect(sent).toEqual([null, null])
    expect(state.get()).toBeUndefined()
  })

  test('keeps turn routing through streaming SDK cleanup while a real root-turn abort clears it', async () => {
    const root = new AbortController()
    const request = new AbortController()
    using state = new OpenAICodexTurnState(root.signal)
    const sent: Array<string | null> = []
    const fetch = buildOpenAICodexFetch(async (_input, init) => {
      sent.push(new Headers(init?.headers).get('x-codex-turn-state'))
      return new Response([
        'event: response.completed',
        'data: {"response":{"id":"resp_sticky_stream","object":"response","model":"gpt-6-astra","status":"completed","output":[],"usage":{"input_tokens":1,"output_tokens":0,"total_tokens":1}}}',
        '', '',
      ].join('\n'), { headers: { 'Content-Type': 'text/event-stream', 'x-codex-turn-state': 'first-stream-state' } })
    }, 'test', state)
    const body = JSON.stringify({ model: 'gpt-6-astra', stream: true, messages: [{ role: 'user', content: 'Hello' }] })
    await (await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', body, signal: request.signal })).text()
    request.abort() // SDK stream disposal is not the end of the agentic turn.
    expect(state.get()).toBe('first-stream-state')
    await (await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', body })).text()
    expect(sent).toEqual([null, 'first-stream-state'])
    root.abort()
    expect(state.get()).toBeUndefined()
  })

  test('threads routing state through the actual SDK client factory across tool continuations', async () => {
    const { getAnthropicClient } = await import('../api/client.js')
    const overrides = { CC_HAHA_OPENAI_OAUTH_PROVIDER: '1', CC_HAHA_GROK_OAUTH_PROVIDER: '', CLAUDE_CONFIG_DIR: tmpDir, CLAUDE_CODE_SIMPLE: '1' }
    const previous = Object.fromEntries(Object.keys(overrides).map(key => [key, process.env[key]]))
    Object.assign(process.env, overrides)
    using state = new OpenAICodexTurnState(new AbortController().signal)
    const sent: Array<string | null> = []
    try {
      for (let i = 0; i < 2; i++) {
        const client = await getAnthropicClient({
          maxRetries: 0, model: 'gpt-6-astra', openAITurnState: state,
          fetchOverride: async (_input, init) => {
            sent.push(new Headers(init?.headers).get('x-codex-turn-state'))
            return Response.json({ id: 'resp_factory', object: 'response', status: 'completed', output: [] }, {
              headers: { 'x-codex-turn-state': 'factory-turn-state' },
            })
          },
        })
        await client.messages.create({ model: 'gpt-6-astra', max_tokens: 16, messages: [{ role: 'user', content: 'Hello' }] })
      }
      expect(sent).toEqual([null, 'factory-turn-state'])
    } finally {
      for (const key of Object.keys(overrides)) {
        if (previous[key] === undefined) delete process.env[key]
        else process.env[key] = previous[key]
      }
    }
  })

  test('sends stable root and branch identity independent of cache overrides and turn state', async () => {
    const sent: Array<{ session: string | null; thread: string | null; cache: string | undefined }> = []
    const upstream: typeof fetch = async (_input, init) => {
      const headers = new Headers(init?.headers)
      sent.push({ session: headers.get('session-id'), thread: headers.get('thread-id'), cache: readWireBody(init).prompt_cache_key })
      return Response.json({ id: 'resp_identity', object: 'response', status: 'completed', output: [] })
    }
    const root = '01234567-89ab-4cde-8fab-0123456789ab'
    const other = '11234567-89ab-4cde-8fab-0123456789ab'
    for (const [session, agent] of [[root, undefined], [root, 'a0000000000000001'], [root, 'a0000000000000001'], [root, 'a0000000000000002'], [other, 'a0000000000000001']] as const) {
      using state = new OpenAICodexTurnState(new AbortController().signal)
      const codexFetch = buildOpenAICodexFetch(upstream, 'test', state, agent)
      await (await codexFetch('https://api.anthropic.com/v1/messages', {
        method: 'POST', headers: { 'X-Claude-Code-Session-Id': session },
        body: JSON.stringify({ model: 'gpt-6-astra', max_tokens: 16, metadata: { session_id: 'explicit-cache-override' }, messages: [{ role: 'user', content: 'Hello' }] }),
      })).text()
    }
    expect(sent[0]).toEqual({ session: root, thread: root, cache: 'explicit-cache-override' })
    expect(sent[1]).toEqual(sent[2])
    expect(sent[1].session).toBe(root)
    expect(sent[1].thread).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(sent[1].thread).not.toBe(root)
    expect(sent[3].thread).not.toBe(sent[1].thread)
    expect(sent[4].session).toBe(other)
    expect(sent[4].thread).not.toBe(sent[1].thread)
  })

  test('reads identity from Request headers with RequestInit precedence and never invents missing identity', async () => {
    const sent: Array<[string | null, string | null]> = []
    const codexFetch = buildOpenAICodexFetch(async (_input, init) => {
      const headers = new Headers(init?.headers)
      sent.push([headers.get('session-id'), headers.get('thread-id')])
      return Response.json({ id: 'resp_identity_headers', object: 'response', status: 'completed', output: [] })
    }, 'test')
    const body = JSON.stringify({ model: 'gpt-6-astra', metadata: { session_id: 'cache-only' }, messages: [{ role: 'user', content: 'Hello' }] })
    const request = () => new Request('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'X-Claude-Code-Session-Id': 'request-root' }, body })
    await (await codexFetch(request())).text()
    await (await codexFetch(request(), { headers: { 'X-Claude-Code-Session-Id': 'init-root' } })).text()
    await (await codexFetch('https://api.anthropic.com/v1/messages', { method: 'POST', body })).text()
    expect(sent).toEqual([['request-root', 'request-root'], ['init-root', 'init-root'], [null, null]])
  })

  test('forwards explicit agent identity through recreated SDK clients and SDK retries', async () => {
    const { getAnthropicClient } = await import('../api/client.js')
    const overrides = { CC_HAHA_OPENAI_OAUTH_PROVIDER: '1', CC_HAHA_GROK_OAUTH_PROVIDER: '', CLAUDE_CONFIG_DIR: tmpDir, CLAUDE_CODE_SIMPLE: '1' }
    const previous = Object.fromEntries(Object.keys(overrides).map(key => [key, process.env[key]]))
    Object.assign(process.env, overrides)
    const sent: Array<[string | null, string | null]> = []
    try {
      for (const agentId of ['a0000000000000001', 'a0000000000000001', 'a0000000000000002', undefined]) {
        const client = await getAnthropicClient({
          maxRetries: 1, model: 'gpt-6-astra', agentId,
          fetchOverride: async (_input, init) => {
            const headers = new Headers(init?.headers)
            sent.push([headers.get('session-id'), headers.get('thread-id')])
            if (sent.length === 1) return Response.json({ error: { message: 'retry fixture' } }, { status: 500, headers: { 'retry-after-ms': '1' } })
            return Response.json({ id: 'resp_identity_factory', object: 'response', status: 'completed', output: [] })
          },
        })
        await client.messages.create({ model: 'gpt-6-astra', max_tokens: 16, messages: [{ role: 'user', content: 'Hello' }] })
      }
      expect(sent).toHaveLength(5)
      expect(sent[0][0]).toBeTruthy()
      expect(sent[0][1]).not.toBe(sent[0][0])
      expect(sent[0]).toEqual(sent[1])
      expect(sent[1]).toEqual(sent[2])
      expect(sent[3][0]).toBe(sent[0][0])
      expect(sent[3][1]).not.toBe(sent[0][1])
      expect(sent[4][1]).toBe(sent[4][0])
    } finally {
      for (const key of Object.keys(overrides)) {
        if (previous[key] === undefined) delete process.env[key]
        else process.env[key] = previous[key]
      }
    }
  })

  test('retains branch identity through the non-streaming fallback client factory', async () => {
    const overrides = { CC_HAHA_OPENAI_OAUTH_PROVIDER: '1', CC_HAHA_GROK_OAUTH_PROVIDER: '', CLAUDE_CONFIG_DIR: tmpDir, CLAUDE_CODE_SIMPLE: '1' }
    const previous = Object.fromEntries(Object.keys(overrides).map(key => [key, process.env[key]]))
    Object.assign(process.env, overrides)
    const sent: Array<[string | null, string | null]> = []
    try {
      const run = executeNonStreamingRequest({
        model: 'gpt-6-astra', source: 'test', agentId: asAgentId('a0000000000000001'),
        fetchOverride: async (_input, init) => {
          const headers = new Headers(init?.headers)
          sent.push([headers.get('session-id'), headers.get('thread-id')])
          return Response.json({ id: 'resp_fallback_identity', object: 'response', status: 'completed', output: [] })
        },
      }, { model: 'gpt-6-astra', thinkingConfig: { type: 'disabled' }, signal: new AbortController().signal },
      () => ({ model: 'gpt-6-astra', max_tokens: 16, messages: [{ role: 'user', content: 'Hello' }] }),
      () => {}, () => {})
      let next = await run.next()
      while (!next.done) next = await run.next()
      expect(sent).toHaveLength(1)
      expect(sent[0][0]).toBeTruthy()
      expect(sent[0][1]).toBeTruthy()
      expect(sent[0][1]).not.toBe(sent[0][0])
    } finally {
      for (const key of Object.keys(overrides)) {
        if (previous[key] === undefined) delete process.env[key]
        else process.env[key] = previous[key]
      }
    }
  })

  test('compresses the final OAuth wire request with zstd without replaying transport failures', async () => {
    let calls = 0
    const codexFetch = buildOpenAICodexFetch(async (_input, init) => {
      calls++
      expect(new Headers(init?.headers).get('content-encoding')).toBe('zstd')
      expect(init?.body).toBeInstanceOf(Uint8Array)
      const decoded = await Bun.zstdDecompress(init!.body as Uint8Array)
      const body = JSON.parse(Buffer.from(decoded).toString('utf8'))
      expect(body.model).toBe('gpt-6-astra')
      throw new Error('transport fixture failure')
    }, 'test')
    await expect(codexFetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', body: JSON.stringify({ model: 'gpt-6-astra', messages: [{ role: 'user', content: 'Hello' }] }),
    })).rejects.toThrow('transport fixture failure')
    expect(calls).toBe(1)
  })

  test('never submits after cancellation during compression and only falls back before transport', async () => {
    let release!: (body: Uint8Array) => void
    const compressor = spyOn(Bun, 'zstdCompress').mockImplementation(() => new Promise(resolve => { release = resolve }))
    let submitted = 0
    const codexFetch = buildOpenAICodexFetch(async (_input, init) => {
      submitted++
      expect(typeof init?.body).toBe('string')
      expect(new Headers(init?.headers).has('content-encoding')).toBe(false)
      return Response.json({ id: 'resp_local_fallback', object: 'response', status: 'completed', output: [] })
    }, 'test')
    const body = JSON.stringify({ model: 'gpt-6-astra', messages: [{ role: 'user', content: 'Hello' }] })
    try {
      const abort = new AbortController()
      const pending = codexFetch('https://api.anthropic.com/v1/messages', { method: 'POST', body, signal: abort.signal })
      while (!release) await new Promise(resolve => setTimeout(resolve, 1))
      abort.abort()
      release(new Uint8Array([1]))
      await expect(pending).rejects.toThrow()
      expect(submitted).toBe(0)
      compressor.mockRejectedValue(new Error('local codec failure'))
      await (await codexFetch('https://api.anthropic.com/v1/messages', { method: 'POST', body })).text()
      expect(submitted).toBe(1)
    } finally { compressor.mockRestore() }
  })

  test('leaves non-messages requests untouched without calling the encoder', async () => {
    const encoder = spyOn(Bun, 'zstdCompress')
    const init = { method: 'POST', body: 'unchanged fixture' }
    try {
      const codexFetch = buildOpenAICodexFetch(async (input, received) => {
        expect(String(input)).toBe('https://example.test/other')
        expect(received).toBe(init)
        return new Response('ok')
      }, 'test')
      await (await codexFetch('https://example.test/other', init)).text()
      expect(encoder).not.toHaveBeenCalled()
    } finally { encoder.mockRestore() }
  })

  test('uses streamed Codex responses even for non-streaming Anthropic callers', async () => {
    const upstreamCalls: Array<{
      url: string
      body: Record<string, unknown>
    }> = []
    const fetchOverride: typeof fetch = async (input, init) => {
      const body = readWireBody(init) as Record<string, unknown>
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
      upstreamBodies.push(readWireBody(init) as Record<string, unknown>)
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
      const body = readWireBody(init) as Record<string, unknown>
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
      const body = readWireBody(init) as Record<string, unknown>
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
      const body = readWireBody(init) as Record<string, unknown>
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
