import { afterEach, describe, expect, test } from 'bun:test'

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
