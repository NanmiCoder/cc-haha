import { afterEach, describe, expect, spyOn, test } from 'bun:test'

import { createMockOnlyRunners, MOCK_AGENT_SCENARIOS, toolResultsSentUpstream } from './scenarios'
import { decideReply, UPSTREAM_ERROR_MESSAGE, UPSTREAM_ERROR_TRIGGER, type MockRequest } from './scriptedModel'
import { startMockLlmServer, type MockLlmServer, type RecordedRequest } from './server'
import { LIVE_AGENT_FLOW_SCENARIOS } from '../agent-flow/liveScenarios'

const AGENT_TOOLS = [{ name: 'Bash' }, { name: 'Write' }, { name: 'Read' }]
const SYSTEM = [{ type: 'text', text: 'You are an agent.\n - Primary working directory: /tmp/work/project\n' }]

function agentRequest(messages: MockRequest['messages']): MockRequest {
  return { model: 'mock-model', system: SYSTEM, tools: AGENT_TOOLS, messages }
}

describe('scripted model', () => {
  test('answers side calls without tools with neutral text', () => {
    const reply = decideReply({ messages: [{ role: 'user', content: 'Create a file called a.txt containing the word X' }] })
    expect(reply).toEqual({ kind: 'message', content: [{ type: 'text', text: 'Mock title' }], stopReason: 'end_turn' })
  })

  test('scripts a real pending question and a streaming compaction summary', () => {
    const question = decideReply({ ...agentRequest([{ role: 'user', content: 'MOCK_ASK_BEFORE_COMPACT' }]),
      tools: [...AGENT_TOOLS, { name: 'AskUserQuestion' }],
    })
    expect(question).toMatchObject({ kind: 'message', stopReason: 'tool_use', content: [{
      type: 'tool_use', name: 'AskUserQuestion', input: { questions: [{ question: 'Choose A or B' }] },
    }] })
    const summary = decideReply({ messages: [{ role: 'user', content: 'CRITICAL: Respond with TEXT ONLY' }] })
    expect(summary).toMatchObject({ kind: 'message', stopReason: 'end_turn', chunkDelayMs: 60 })
    if (summary.kind === 'message') expect(summary.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('<summary>') })
  })

  test('writes to an absolute path under the working directory the CLI announced', () => {
    const reply = decideReply(agentRequest([{
      role: 'user',
      content: [
        { type: 'text', text: '<system-reminder>Create a file called wrong.txt containing the word NO</system-reminder>' },
        { type: 'text', text: 'Create a file called live-allowed.txt in the current directory. Its entire contents must be the single word ALLOWED.' },
      ],
    }]))
    expect(reply.kind).toBe('message')
    if (reply.kind !== 'message') return
    expect(reply.stopReason).toBe('tool_use')
    expect(reply.content[0]).toMatchObject({
      type: 'tool_use',
      name: 'Write',
      input: { file_path: '/tmp/work/project/live-allowed.txt', content: 'ALLOWED\n' },
    })
  })

  test('runs a quoted shell command with Bash', () => {
    const reply = decideReply(agentRequest([{ role: 'user', content: 'Run the shell command `echo nonce-1` and tell me what it printed.' }]))
    expect(reply.kind === 'message' && reply.content[0]).toMatchObject({ type: 'tool_use', name: 'Bash', input: { command: 'echo nonce-1' } })
  })

  test('loads deferred image tools and then invokes generation or editing after search', () => {
    const request = agentRequest([{ role: 'user', content: 'MOCK_IMAGE_GENERATE' }])
    expect(decideReply({ ...request, tools: [...AGENT_TOOLS, { name: 'ToolSearch' }] }))
      .toMatchObject({ content: [{ type: 'tool_use', name: 'ToolSearch', input: { query: 'select:ImageGen' } }] })
    expect(decideReply({ ...request, tools: [...AGENT_TOOLS, { name: 'ImageGen' }], messages: [
      ...request.messages!,
      { role: 'user', content: [{ type: 'tool_result', content: [{ type: 'tool_reference', tool_name: 'ImageGen' }] }] },
    ] })).toMatchObject({ content: [{ type: 'tool_use', name: 'ImageGen', input: { prompt: 'A fixture blue square', count: 1 } }] })
    expect(decideReply({ ...request, tools: [...AGENT_TOOLS, { name: 'ImageEdit' }], messages: [
      { role: 'user', content: 'MOCK_IMAGE_EDIT "/tmp/fixture.png"' },
    ] })).toMatchObject({ content: [{ type: 'tool_use', name: 'ImageEdit', input: { referenced_image_paths: ['/tmp/fixture.png'] } }] })
  })

  test.each(['ImageGen', 'ImageEdit'])('selects the Gemini-only 4:5 ratio from the advertised %s schema', (name) => {
    const prompt = name === 'ImageEdit' ? 'MOCK_IMAGE_EDIT "/tmp/fixture.png"' : 'MOCK_IMAGE_GENERATE'
    const request = agentRequest([{ role: 'user', content: prompt }])
    expect(decideReply({ ...request, tools: [...AGENT_TOOLS, {
      name, input_schema: { properties: { aspect_ratio: { enum: ['auto', '1:1', '4:5', '16:9'] } } },
    }] })).toMatchObject({ content: [{ type: 'tool_use', name, input: { aspect_ratio: '4:5' } }] })
    expect(decideReply({ ...request, tools: [...AGENT_TOOLS, {
      name, input_schema: { properties: { aspect_ratio: { enum: ['auto', '1:1', '16:9'] } } },
    }] })).toMatchObject({ content: [{ type: 'tool_use', name, input: { aspect_ratio: '16:9' } }] })
  })

  test.each(['ImageGen', 'ImageEdit'])('selects a supported resolution from the advertised %s schema', (name) => {
    const prompt = name === 'ImageEdit' ? 'MOCK_IMAGE_EDIT "/tmp/fixture.png"' : 'MOCK_IMAGE_GENERATE'
    const request = agentRequest([{ role: 'user', content: prompt }])
    for (const [resolutions, expected] of [
      [['1k'], '1k'],
      [['1k', '2k'], '2k'],
      [undefined, '2k'],
    ] as const) {
      expect(decideReply({ ...request, tools: [...AGENT_TOOLS, {
        name, input_schema: { properties: { resolution: { enum: resolutions ? [...resolutions] : undefined } } },
      }] })).toMatchObject({ content: [{ type: 'tool_use', name, input: { resolution: expected } }] })
    }
  })

  test('reports the tool result it was given, and says when the tool failed', () => {
    const ok = decideReply(agentRequest([
      { role: 'user', content: 'Run the shell command `echo hi`' },
      { role: 'assistant', content: [{ type: 'tool_use' }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'hi\n' }] }] },
    ]))
    expect(ok).toMatchObject({ kind: 'message', stopReason: 'end_turn', content: [{ type: 'text', text: 'Tool result: hi' }] })

    const failed = decideReply(agentRequest([
      { role: 'user', content: 'Create a file called a.txt containing the word X' },
      { role: 'assistant', content: [{ type: 'tool_use' }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: 'Permission denied' }] },
    ]))
    expect(failed).toMatchObject({ content: [{ type: 'text', text: 'The tool failed: Permission denied' }] })
  })

  test('fails on the error trigger, and answers the next prompt merged into the same user message', () => {
    expect(decideReply(agentRequest([{ role: 'user', content: `${UPSTREAM_ERROR_TRIGGER}: please fail` }]))).toEqual({
      kind: 'error',
      status: 400,
      errorType: 'invalid_request_error',
      message: UPSTREAM_ERROR_MESSAGE,
    })

    // After a failed turn the CLI merges the next prompt into the same user message.
    const recovered = decideReply(agentRequest([{
      role: 'user',
      content: [
        { type: 'text', text: `${UPSTREAM_ERROR_TRIGGER}: please fail` },
        { type: 'text', text: 'Reply with one short sentence.' },
      ],
    }]))
    expect(recovered).toMatchObject({ kind: 'message', stopReason: 'end_turn' })
  })

  test('streams a long count slowly enough to be interrupted', () => {
    const reply = decideReply(agentRequest([{ role: 'user', content: 'Count from 1 to 5, one per line.' }]))
    expect(reply).toMatchObject({ kind: 'message', chunkDelayMs: 40, content: [{ type: 'text', text: '1\n2\n3\n4\n5' }] })
  })
})

type SseEvent = { event: string; data: Record<string, unknown> }

function parseSse(body: string): SseEvent[] {
  return body.trim().split('\n\n').map((frame) => {
    const event = /^event: (.+)$/m.exec(frame)![1]!
    const data = JSON.parse(/^data: (.+)$/m.exec(frame)![1]!) as Record<string, unknown>
    return { event, data }
  })
}

describe('mock Anthropic endpoint', () => {
  let server: MockLlmServer | null = null
  afterEach(async () => {
    await server?.stop()
    server = null
  })

  async function post(body: unknown, signal?: AbortSignal) {
    server ??= startMockLlmServer()
    return await fetch(`${server.url}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    })
  }

  test('streams a tool call as the Anthropic event sequence and records the request', async () => {
    const response = await post({ ...agentRequest([{ role: 'user', content: 'Run the shell command `ls`' }]), stream: true })
    expect(response.headers.get('content-type')).toBe('text/event-stream')
    const events = parseSse(await response.text())

    expect(events.map((event) => event.event)).toEqual([
      'message_start',
      'content_block_start',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop',
    ])
    expect(events[1]!.data.content_block).toMatchObject({ type: 'tool_use', name: 'Bash', input: {} })
    const delta = events[2]!.data.delta as { type: string; partial_json: string }
    expect(delta.type).toBe('input_json_delta')
    expect(JSON.parse(delta.partial_json)).toMatchObject({ command: 'ls' })
    expect(events[4]!.data.delta).toMatchObject({ stop_reason: 'tool_use' })
    expect(server!.requests).toHaveLength(1)
    expect(server!.requests[0]).toMatchObject({ path: '/v1/messages', stream: true, outcome: 'completed' })
  })

  test('answers non-streamed requests with a JSON message', async () => {
    const response = await post({ messages: [{ role: 'user', content: 'title please' }] })
    expect(await response.json()).toMatchObject({
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'Mock title' }],
      stop_reason: 'end_turn',
    })
  })

  test('serves Images and Gemini fixtures only with the configured image credentials', async () => {
    server = startMockLlmServer()
    const imageResponse = await fetch(`${server.url}/v1/images/generations`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer mock-image-key' },
      body: JSON.stringify({ model: 'mock-image', prompt: 'A square' }),
    })
    expect(imageResponse.status).toBe(200)
    expect(await imageResponse.json()).toMatchObject({ data: [{ url: expect.stringContaining('data:image/png;base64,') }] })
    const nativeResponse = await fetch(`${server.url}/v1beta/models/mock-image:generateContent`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': 'mock-image-key' },
      body: JSON.stringify({ contents: [], generationConfig: { imageConfig: { aspectRatio: '4:5' } } }),
    })
    expect(nativeResponse.status).toBe(200)
    expect(await nativeResponse.json()).toMatchObject({ candidates: [{ content: { parts: [
      { text: 'Fixture image' }, { inlineData: { mimeType: 'image/png', data: expect.any(String) } },
    ] } }] })
    const missingCredentials = await fetch(`${server.url}/v1/images/generations`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    })
    expect(missingCredentials.status).toBe(401)
    expect(server.imageRequests).toHaveLength(3)
    expect(server.requests).toHaveLength(0)
  })

  test.each([
    '/v1beta/openai/v1beta/models/mock-image:generateContent',
    '/v1beta/openai/models/mock-image:generateContent',
    '/v1beta/models/wrong-image:generateContent',
  ])('rejects incorrect native Gemini endpoint %s', async (path) => {
    server = startMockLlmServer()
    const response = await fetch(`${server.url}${path}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': 'mock-image-key' },
      body: JSON.stringify({ contents: [], generationConfig: { imageConfig: { aspectRatio: '4:5' } } }),
    })
    expect(response.status).toBe(404)
  })

  test.each(['19.5:9', '20:9', '9:20', 'auto'])('rejects unsupported native Gemini ratio %s', async (aspectRatio) => {
    server = startMockLlmServer()
    const response = await fetch(`${server.url}/v1beta/models/mock-image:generateContent`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': 'mock-image-key' },
      body: JSON.stringify({ contents: [], generationConfig: { imageConfig: { aspectRatio } } }),
    })
    expect(response.status).toBe(400)
  })

  test.each([
    ['gemini-3.1-flash-lite-image', '1K'],
    ['gemini-3.1-flash-lite-image', undefined],
    ['mock-image', '2K'],
  ])('serves the native Gemini %s fixture with resolution %s', async (model, imageSize) => {
    server = startMockLlmServer()
    const response = await fetch(`${server.url}/v1beta/models/${model}:generateContent`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': 'mock-image-key' },
      body: JSON.stringify({ contents: [], generationConfig: { imageConfig: { imageSize, aspectRatio: '4:5' } } }),
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ candidates: [{ content: { parts: [
      { text: 'Fixture image' }, { inlineData: { mimeType: 'image/png', data: expect.any(String) } },
    ] } }] })
  })

  test.each(['2K', '4K', '512'])('rejects unsupported Lite resolution %s at the native endpoint', async (imageSize) => {
    server = startMockLlmServer()
    const response = await fetch(`${server.url}/v1beta/models/gemini-3.1-flash-lite-image:generateContent`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': 'mock-image-key' },
      body: JSON.stringify({ contents: [], generationConfig: { imageConfig: { imageSize, aspectRatio: '4:5' } } }),
    })
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: 'Gemini Lite images require 1K resolution' })
  })

  test('rejects image credentials sent under the other protocol header', async () => {
    server = startMockLlmServer()
    for (const [path, header] of [
      ['/v1beta/models/mock-image:generateContent', { Authorization: 'Bearer mock-image-key' }],
      ['/v1/images/generations', { 'x-goog-api-key': 'mock-image-key' }],
    ] as const) {
      const response = await fetch(`${server.url}${path}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...header }, body: '{}',
      })
      expect(response.status).toBe(401)
    }
  })

  test('returns provider-shaped errors', async () => {
    const response = await post({ ...agentRequest([{ role: 'user', content: UPSTREAM_ERROR_TRIGGER }]), stream: true })
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ type: 'error', error: { type: 'invalid_request_error', message: UPSTREAM_ERROR_MESSAGE } })
    expect(server!.requests[0]!.outcome).toBe('error')
  })

  test('records a client hang-up mid-stream as cancelled', async () => {
    const controller = new AbortController()
    const response = await post({ ...agentRequest([{ role: 'user', content: 'Count from 1 to 300' }]), stream: true }, controller.signal)
    const reader = response.body!.getReader()
    await reader.read()
    controller.abort()

    const deadline = Date.now() + 2_000
    while (server!.requests[0]!.outcome === 'pending' && Date.now() < deadline) await Bun.sleep(20)
    expect(server!.requests[0]!.outcome).toBe('cancelled')
  })
})

describe('mock-LLM scenario catalog', () => {
  test('restores the provider base URL and image settings when the image scenario fails', async () => {
    const original = {
      baseUrl: 'http://upstream.invalid/original',
      imageGeneration: { protocol: 'xai_images', model: 'previous-image', apiKey: 'previous-fixture-key' },
    }
    const updates: unknown[] = []
    const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      if (init?.method === 'PUT') updates.push(JSON.parse(String(init.body)))
      return Response.json({ provider: original })
    })
    try {
      await expect(createMockOnlyRunners([])['mock-image-provider-protocols']!({
        baseUrl: 'http://server.invalid', workRoot: '/fixture', artifactDir: '/fixture/artifacts', stepTimeoutMs: 100,
        target: { providerId: 'fixture', providerName: 'Fixture', modelId: 'mock-model', host: 'http://upstream.invalid', source: 'fixture' },
        async createSession() { throw new Error('fixture session failure') },
        async openSocket() { throw new Error('must not open a socket after session failure') },
        pinRuntime() {},
      })).rejects.toThrow('fixture session failure')
      expect(updates).toEqual([
        { baseUrl: original.baseUrl, imageGeneration: { protocol: 'openai_images', model: 'mock-image', baseUrl: '', apiKey: 'mock-image-key' } },
        original,
      ])
    } finally {
      fetchSpy.mockRestore()
    }
  })

  test('runs every live scenario plus mock-only ones, each with a runner', () => {
    const ids = MOCK_AGENT_SCENARIOS.map((scenario) => scenario.id)
    for (const live of LIVE_AGENT_FLOW_SCENARIOS) expect(ids).toContain(live.id)
    expect(new Set(ids).size).toBe(ids.length)

    const runners = createMockOnlyRunners([])
    for (const id of ids.filter((id) => id.startsWith('mock-'))) expect(typeof runners[id]).toBe('function')
  })

  test('finds tool results the CLI sent upstream after a given request', () => {
    const request = (content: unknown): RecordedRequest => ({
      path: '/v1/messages',
      stream: true,
      receivedAt: 0,
      outcome: 'completed',
      body: { messages: [{ role: 'user', content: content as never }] },
    })
    const requests = [
      request([{ type: 'tool_result', content: 'old' }]),
      request('plain prompt'),
      request([{ type: 'tool_result', content: 'new', is_error: true }]),
    ]
    expect(toolResultsSentUpstream(requests, 1)).toEqual([{ type: 'tool_result', content: 'new', is_error: true }])
  })
})
