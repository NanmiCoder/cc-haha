import { afterEach, describe, expect, test } from 'bun:test'

import { listCassetteIds, loadCassette, queueKey, serializeCassette, sha, type Cassette, type Interaction } from './cassette'
import { expandEvents, expandString, learnVolatileValues, normalizeEvents, normalizeFragments, pathVariants, type PlaceholderTable } from './normalize'
import { buildCassette, scanForSecrets, startRecorder } from './recorder'
import { compareRequest, startReplayServer, type ReplayServer } from './replayServer'
import { fingerprintRequest, parseSse, responseFeatures, serializeSseEvent, type SseEvent } from './wire'

const stops: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const stop of stops.splice(0)) await stop()
})

const RECORDED_ROOT = '/var/folders/ab/T/cc-haha-agent-replay-rec/replay-multi-tool'
const table = (root: string): PlaceholderTable => [{ name: 'WORK_ROOT', values: pathVariants(root) }]

function anthropicToolStream(id: string, fragments: string[]): SseEvent[] {
  return [
    { event: 'message_start', data: { type: 'message_start', message: { id: 'msg_1', role: 'assistant', content: [], usage: { input_tokens: 900, output_tokens: 1 } } } },
    { event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id, name: 'Bash', input: {} } } },
    ...fragments.map((partial_json) => ({ event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json } } })),
    { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
    { event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 20 } } },
    { event: 'message_stop', data: { type: 'message_stop' } },
  ]
}

function textStream(text: string): SseEvent[] {
  return [
    { event: 'message_start', data: { type: 'message_start', message: { id: 'msg_2', role: 'assistant', content: [], usage: { input_tokens: 950, output_tokens: 1 } } } },
    { event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
    { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } },
    { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
    { event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } } },
    { event: 'message_stop', data: { type: 'message_stop' } },
  ]
}

/** The queue of the agent loop the unit cassette records: its first user message. */
const LOOP = `agent:${sha('List {{WORK_ROOT}}')}`

function interaction(seq: number, request: Partial<Interaction['request']>, events: SseEvent[], toolUseIds: string[] = []): Interaction {
  return {
    seq,
    path: '/v1/messages',
    queue: LOOP,
    request: { model: 'deepseek-flash', stream: true, maxTokens: 32000, toolNames: ['Bash', 'Read'], lastRole: 'user', lastUserText: '', firstUserText: 'List {{WORK_ROOT}}', toolResultIds: [], messageCount: 1, systemSha: 'x', toolsSha: 'y', ...request },
    response: { status: 200, contentType: 'text/event-stream', events: events.map((event) => ({ ...event, dt: 1 })) },
    toolUseIds,
  }
}

/** A recorded turn: the user asks, the model runs Bash in {{WORK_ROOT}}, then answers. */
function cassette(): Cassette {
  return {
    schemaVersion: 1,
    id: 'unit',
    format: 'anthropic',
    recordedWith: { provider: 'DeepSeek', model: 'deepseek-flash', date: '2026-10-14' },
    providerConfig: {},
    interactions: [
      interaction(0, { lastUserText: 'List {{WORK_ROOT}}' }, anthropicToolStream('toolu_1', ['{"command":"ls ', '{{WORK_ROOT}}"}']), ['toolu_1']),
      interaction(1, { lastRole: 'user', toolResultIds: ['toolu_1'], messageCount: 3 }, textStream('done')),
    ],
  }
}

const tools = [{ name: 'Agent', input_schema: {} }, { name: 'Bash', input_schema: {} }, { name: 'Read', input_schema: {} }]
const firstRequest = (root: string, text = `List ${root}`) => ({ model: 'deepseek-flash', stream: true, max_tokens: 32000, tools, messages: [{ role: 'user', content: [{ type: 'text', text }] }] })
const secondRequest = (root: string, ids = ['toolu_1'], offered = tools) => ({
  model: 'deepseek-flash', stream: true, max_tokens: 32000, tools: offered,
  messages: [
    { role: 'user', content: [{ type: 'text', text: `List ${root}` }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: {} }] },
    { role: 'user', content: ids.map((id) => ({ type: 'tool_result', tool_use_id: id, content: 'ok' })) },
  ],
})

async function startServer(): Promise<ReplayServer> {
  const server = startReplayServer({ format: 'anthropic', maxEventDelayMs: 0 })
  stops.push(() => server.stop())
  return server
}

async function post(server: ReplayServer, body: unknown, path = '/v1/messages') {
  const response = await fetch(`${server.url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return { status: response.status, text: await response.text() }
}

describe('normalisation', () => {
  test('a path split across fragments becomes one whole placeholder and expands back for another run', () => {
    const fragments = ['{"command":"ls /var/folders/ab/T/cc-haha-agent', '-replay-rec/replay-multi', '-tool/src"}']
    const normalized = normalizeFragments(fragments, table(RECORDED_ROOT), true)

    expect(normalized).toHaveLength(3)
    expect(normalized.join('')).toBe('{"command":"ls {{WORK_ROOT}}/src"}')
    expect(normalized.filter((fragment) => fragment.includes('{{WORK_ROOT}}'))).toHaveLength(1)
    const expanded = normalized.map((fragment) => expandString(fragment, { WORK_ROOT: '/tmp/replay/x' }, true))
    expect(JSON.parse(expanded.join(''))).toEqual({ command: 'ls /tmp/replay/x/src' })
  })

  test('catches the /private spelling of a macOS temp path and JSON-escapes Windows paths', () => {
    const events = anthropicToolStream('toolu_9', [`{"command":"cat /private${RECORDED_ROOT}/a.txt"}`])
    const normalized = normalizeEvents('anthropic', events, table(RECORDED_ROOT))
    expect(JSON.stringify(normalized)).toContain('cat {{WORK_ROOT}}/a.txt')
    expect(JSON.stringify(normalized)).not.toContain('/var/folders')

    const expanded = expandEvents('anthropic', normalized, { WORK_ROOT: 'C:\\Users\\ci\\work' })
    const json = expanded.map((event) => (event.data as { delta?: { partial_json?: string } }).delta?.partial_json ?? '').join('')
    expect(JSON.parse(json)).toEqual({ command: 'cat C:\\Users\\ci\\work/a.txt' })
  })

  test('parses and re-serialises SSE without losing events', () => {
    const events = textStream('hi')
    expect(parseSse(events.map(serializeSseEvent).join(''))).toEqual(events)
    expect(parseSse('data: {"choices":[]}\n\ndata: [DONE]\n\n')).toEqual([{ data: { choices: [] } }, { data: '[DONE]' }])
  })

  test('fingerprints both dialects and ignores harness reminders in user text', () => {
    const anthropic = fingerprintRequest('anthropic', {
      model: 'm', stream: true, max_tokens: 10, tools: [{ name: 'Read' }, { name: 'Bash' }],
      messages: [{ role: 'user', content: [{ type: 'text', text: '<system-reminder>today is 2026-10-14</system-reminder>' }, { type: 'text', text: 'hello' }] }],
    })
    expect(anthropic).toMatchObject({ toolNames: ['Bash', 'Read'], lastUserText: 'hello', toolResultIds: [] })

    const openai = fingerprintRequest('openai_chat', {
      model: 'm', stream: true, tools: [{ type: 'function', function: { name: 'Grep' } }],
      messages: [{ role: 'user', content: 'q' }, { role: 'assistant', tool_calls: [] }, { role: 'tool', tool_call_id: 'call_1' }, { role: 'tool', tool_call_id: 'call_2' }],
    })
    expect(openai).toMatchObject({ toolNames: ['Grep'], lastRole: 'tool', toolResultIds: ['call_1', 'call_2'] })
  })

  test('gives every agent loop its own queue by the prompt that started it', () => {
    const loop = (first: string, ...later: string[]) => fingerprintRequest('anthropic', {
      tools: [{ name: 'Agent' }, { name: 'Bash' }],
      messages: [{ role: 'user', content: [{ type: 'text', text: '<system-reminder>date</system-reminder>' }, { type: 'text', text: first }] }, ...later.map((text) => ({ role: 'user', content: text }))],
    })
    const plain = fingerprintRequest('anthropic', { messages: [] })
    // A loop keeps its queue as it grows; a subagent or teammate has its own.
    expect(queueKey('/v1/messages', loop('Count the files'), '')).toBe(queueKey('/v1/messages', loop('Count the files', 'tool output'), ''))
    expect(queueKey('/v1/messages', loop('Count the files'), '')).not.toBe(queueKey('/v1/messages', loop('Read package.json'), ''))
    expect(queueKey('/v1/messages', loop('Count the files'), '')).toStartWith('agent:')
    expect(queueKey('/v1/messages', plain, 'Generate a title')).not.toBe(queueKey('/v1/messages', plain, 'Summarize'))
    expect(queueKey('/v1/messages/count_tokens', plain, '')).toBe('count_tokens')
  })

  test('detects thinking and fragmented tool input in recorded traffic', () => {
    expect(responseFeatures('anthropic', anthropicToolStream('t', ['{"a"', ':1}']))).toMatchObject({ fragmentedToolInput: true, toolNames: ['Bash'] })
    expect(responseFeatures('openai_chat', [{ data: { choices: [{ index: 0, delta: { reasoning_content: 'hmm' } }] } }]).thinking).toBe(true)
  })
})

describe('cassette files', () => {
  test('store one SSE event per line and round-trip exactly', () => {
    const text = serializeCassette(cassette())
    expect(JSON.parse(text)).toEqual(cassette())
    const eventLines = text.split('\n').filter((line) => line.trim().startsWith('{"event":'))
    expect(eventLines).toHaveLength(cassette().interactions.reduce((total, interaction) => total + interaction.response.events!.length, 0))
  })

  test('every committed cassette loads, matches its id, and carries no temp path', () => {
    const ids = listCassetteIds()
    expect(ids.length).toBeGreaterThan(0)
    for (const id of ids) {
      const loaded = loadCassette(id)!
      expect(loaded.interactions.length, id).toBeGreaterThan(0)
      expect(JSON.stringify(loaded), id).not.toMatch(/\/var\/folders\/[a-z0-9_]{2}\/[a-z0-9_]{10,}|-var-folders-[a-z0-9]{2}-[a-z0-9]{10,}|sk-[A-Za-z0-9]{16}/)
    }
  })
})

describe('replay server', () => {
  test('serves a recorded turn to a run in a different directory', async () => {
    const server = await startServer()
    const root = '/tmp/replay-run/replay-multi-tool'
    server.load(cassette(), table(root))

    const first = await post(server, firstRequest(root))
    expect(first.status).toBe(200)
    const partial = parseSse(first.text).map((event) => (event.data as { delta?: { partial_json?: string } }).delta?.partial_json ?? '').join('')
    expect(JSON.parse(partial)).toEqual({ command: `ls ${root}` })
    expect((await post(server, secondRequest(root))).status).toBe(200)

    const report = server.finish()
    expect(report).toMatchObject({ served: 2, mismatches: [], unused: [], synthesized: [] })
  })

  for (const [name, send] of [
    ['the user typed something else', (server: ReplayServer, root: string) => post(server, firstRequest(root, 'Delete everything'))],
    ['a tool result answers a different call', async (server: ReplayServer, root: string) => { await post(server, firstRequest(root)); return post(server, secondRequest(root, ['toolu_other'])) }],
    ['the request no longer offers a tool the reply calls', async (server: ReplayServer, root: string) => post(server, { ...firstRequest(root), tools: [{ name: 'Agent', input_schema: {} }, { name: 'Read', input_schema: {} }] })],
    ['the app sends one request more than the recording', async (server: ReplayServer, root: string) => { await post(server, firstRequest(root)); await post(server, secondRequest(root)); return post(server, secondRequest(root)) }],
  ] as const) {
    test(`fails loudly when ${name}`, async () => {
      const server = await startServer()
      const root = '/tmp/replay-run/replay-multi-tool'
      server.load(cassette(), table(root))
      const response = await send(server, root)

      expect(response.status).toBe(400)
      expect(response.text).toContain('replay_mismatch')
      expect(server.finish().mismatches).toHaveLength(1)
    })
  }

  test('accepts parallel tool results in any completion order, but not a missing one', () => {
    const recorded = interaction(1, { toolResultIds: ['call_0', 'call_1', 'call_2'] }, textStream('done'))
    const actual = (ids: string[]) => ({ ...recorded.request, toolNames: ['Agent', 'Read'], toolResultIds: ids })
    expect(compareRequest(recorded, actual(['call_2', 'call_0', 'call_1']), ['call_0', 'call_1', 'call_2'], 'anthropic')).toBeNull()
    expect(compareRequest(recorded, actual(['call_0', 'call_1']), ['call_0', 'call_1', 'call_2'], 'anthropic')).toContain('tool results')
  })

  test('learns a clock-minted id from the request and quotes this run\'s value back', async () => {
    expect(learnVolatileValues('approve shutdown-{{V1}}@reporter', 'approve shutdown-1791961472346@reporter')).toEqual({ V1: '1791961472346' })
    expect(learnVolatileValues('approve shutdown-{{V1}}@reporter', 'reject shutdown-1791961472346@reporter')).toBeNull()

    const server = await startServer()
    const quoted = cassette()
    quoted.interactions = [{
      ...interaction(0, { lastUserText: 'Shut down: shutdown-{{V1}}@reporter', firstUserText: 'Shut down: shutdown-{{V1}}@reporter' }, textStream('approved shutdown-{{V1}}@reporter')),
      queue: `agent:${sha('Shut down: shutdown-{{V}}@reporter')}`,
    }]
    server.load(quoted, table('/tmp/r'))
    const response = await post(server, firstRequest('/tmp/r', 'Shut down: shutdown-1791961472346@reporter'))

    expect(response.status).toBe(200)
    expect(response.text).toContain('approved shutdown-1791961472346@reporter')
    expect(server.finish().mismatches).toEqual([])
  })

  test('reports recorded requests the app never made', async () => {
    const server = await startServer()
    server.load(cassette(), table('/tmp/r'))
    await post(server, firstRequest('/tmp/r'))
    expect(server.finish().unused).toEqual([{ seq: 1, queue: LOOP, lastUserText: '' }])
  })

  test('answers an unrecorded side call with a placeholder instead of failing', async () => {
    const server = await startServer()
    server.load(cassette(), table('/tmp/r'))
    const side = await post(server, { model: 'deepseek-flash', stream: false, system: 'Generate a short title', messages: [{ role: 'user', content: 'x' }] })
    expect(side.status).toBe(200)
    const report = server.finish()
    expect(report.synthesized).toHaveLength(1)
    expect(report.mismatches).toEqual([])
  })

  test('holds a recording that the client cut short open until the client hangs up', async () => {
    const server = await startServer()
    const cut = cassette()
    cut.interactions = [{ ...interaction(0, { lastUserText: 'Count', firstUserText: 'Count' }, textStream('1 2 3').slice(0, 3)), queue: `agent:${sha('Count')}` }]
    server.load(cut, table('/tmp/r'))
    const controller = new AbortController()
    const response = await fetch(`${server.url}/v1/messages`, { method: 'POST', body: JSON.stringify({ ...firstRequest('/tmp/r', 'Count') }), signal: controller.signal })
    const reader = response.body!.getReader()
    let text = ''
    while (!text.includes('1 2 3')) {
      const { done, value } = await reader.read()
      if (done) throw new Error(`stream ended before the recorded prefix: ${text}`)
      text += new TextDecoder().decode(value)
    }
    const next = await Promise.race([reader.read().then(() => 'more'), Bun.sleep(200).then(() => 'open')])
    expect(next).toBe('open')
    controller.abort()
  })
})

describe('recorder', () => {
  test('settles after the client hangs up mid-stream, keeping what arrived', async () => {
    const upstream = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch() {
        const events = textStream('1 2 3')
        return new Response(new ReadableStream({
          async start(controller) {
            for (const event of events) {
              controller.enqueue(new TextEncoder().encode(serializeSseEvent(event)))
              await Bun.sleep(100)
            }
            controller.close()
          },
        }), { headers: { 'content-type': 'text/event-stream' } })
      },
    })
    stops.push(async () => { await upstream.stop(true) })
    const recorder = startRecorder({ format: 'anthropic', upstreamBase: `http://127.0.0.1:${upstream.port}`, apiKey: 'k' })
    stops.push(() => recorder.stop())
    const controller = new AbortController()
    const response = await fetch(`${recorder.url}/v1/messages`, { method: 'POST', body: '{}', signal: controller.signal })
    await response.body!.getReader().read()
    controller.abort()

    await recorder.settle(50, 3_000)
    const [raw] = recorder.take()
    expect(raw!.response.events!.length).toBeGreaterThan(0)
    expect(raw!.response.events!.length).toBeLessThan(textStream('x').length)
  })


  test('swaps in the real key, streams through, and records events with timing', async () => {
    const seen: Array<{ url: string; auth: string | null; key: string | null }> = []
    const upstream = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(req) {
        seen.push({ url: req.url, auth: req.headers.get('authorization'), key: req.headers.get('x-api-key') })
        return new Response(anthropicToolStream('toolu_7', ['{"command":"ls ', `${RECORDED_ROOT}"}`]).map(serializeSseEvent).join(''), { headers: { 'content-type': 'text/event-stream' } })
      },
    })
    stops.push(async () => { await upstream.stop(true) })
    const recorder = startRecorder({ format: 'anthropic', upstreamBase: `http://127.0.0.1:${upstream.port}/anthropic`, apiKey: 'sk-real-secret-key-1234567890' })
    stops.push(() => recorder.stop())

    const response = await fetch(`${recorder.url}/v1/messages?beta=true`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'replay-fake-key' },
      body: JSON.stringify({ ...firstRequest(RECORDED_ROOT), system: 'You are Claude Code' }),
    })
    expect(parseSse(await response.text()).length).toBeGreaterThan(3)
    await recorder.settle(50, 5_000)

    expect(seen).toEqual([{ url: `http://127.0.0.1:${upstream.port}/anthropic/v1/messages?beta=true`, auth: 'Bearer sk-real-secret-key-1234567890', key: 'sk-real-secret-key-1234567890' }])
    const raw = recorder.take()
    expect(raw[0]!.response.events!.every((event) => typeof event.dt === 'number')).toBe(true)

    const built = buildCassette({ id: 'unit', format: 'anthropic', provider: 'DeepSeek', model: 'deepseek-flash', providerConfig: {}, raw, table: table(RECORDED_ROOT) })
    const serialized = JSON.stringify(built)
    expect(serialized).not.toContain(RECORDED_ROOT)
    expect(serialized).not.toContain('replay-fake-key')
    expect(built.interactions[0]).toMatchObject({ queue: LOOP, toolUseIds: ['toolu_7'], request: { lastUserText: 'List {{WORK_ROOT}}', firstUserText: 'List {{WORK_ROOT}}' } })
    expect(scanForSecrets(serialized, ['sk-real-secret-key-1234567890'])).toEqual([])
    expect(scanForSecrets(`${serialized} sk-real-secret-key-1234567890`, ['sk-real-secret-key-1234567890']).length).toBeGreaterThan(0)
  })
})
