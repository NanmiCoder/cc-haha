import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSandboxedTestEnvironment } from '../../scripts/pr/test-environment.js'

const SUGGESTION = '运行测试'

// Two text blocks become two assistant messages, which clears the
// "fewer than 2 assistant turns" suppression on the first turn.
function completion(texts: string[]) {
  const events: Record<string, unknown>[] = [
    { type: 'message_start', message: { id: 'msg_fixture', type: 'message', role: 'assistant', model: 'claude-sonnet-4-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 12, output_tokens: 0 } } },
  ]
  texts.forEach((text, index) => {
    events.push(
      { type: 'content_block_start', index, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index, delta: { type: 'text_delta', text } },
      { type: 'content_block_stop', index },
    )
  })
  events.push(
    { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 4 } },
    { type: 'message_stop' },
  )
  return events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('')
}

function spawnWithInput(command: string[], env: Record<string, string>, input: string) {
  const child = Bun.spawn(command, { env, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' })
  child.stdin.write(input)
  child.stdin.end()
  return child
}

function control(requestId: string, request: Record<string, unknown>) {
  return JSON.stringify({ type: 'control_request', request_id: requestId, request })
}

function userMessage(text: string) {
  return JSON.stringify({ type: 'user', session_id: '', parent_tool_use_id: null, message: { role: 'user', content: text } })
}

async function runPrint(lines: string[]) {
  const home = await mkdtemp(join(tmpdir(), 'prompt-suggestion-print-'))
  let suggestionRequests = 0
  let turnRequests = 0
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    if (!new URL(request.url).pathname.endsWith('/messages')) {
      return new Response('{}', { headers: { 'content-type': 'application/json' } })
    }
    const body = await request.json() as { messages: unknown[] }
    if (JSON.stringify(body.messages.at(-1)).includes('[SUGGESTION MODE')) {
      suggestionRequests++
      return new Response(completion([`建议：${SUGGESTION}`]), { headers: { 'content-type': 'text/event-stream' } })
    }
    turnRequests++
    return new Response(completion(['已经修好了。', '要我跑一下测试吗？']), { headers: { 'content-type': 'text/event-stream' } })
  } })
  const env = createSandboxedTestEnvironment(home, {
    NODE_ENV: 'production', CI: '1', CC_HAHA_SKIP_DOTENV: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_AUTOUPDATER: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1',
    ANTHROPIC_API_KEY: 'fixture-key', ANTHROPIC_BASE_URL: server.url.origin,
    ANTHROPIC_MODEL: 'claude-sonnet-4-5',
  })
  try {
    const child = spawnWithInput(
      ['./bin/claude-haha', '--bare', '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'],
      env,
      lines.join('\n') + '\n',
    )
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    expect({ code, stderr }).toMatchObject({ code: 0 })
    const events = stdout.trim().split('\n').map(line => JSON.parse(line))
    return { events, suggestionRequests, turnRequests }
  } finally {
    server.stop(true)
    await rm(home, { recursive: true, force: true })
  }
}

test('set_prompt_suggestions turns on suggestions at runtime and emits the cleaned suggestion after the result', async () => {
  const { events, suggestionRequests } = await runPrint([
    control('enable', { subtype: 'set_prompt_suggestions', enabled: true }),
    userMessage('修一下这个 bug 然后跑测试'),
  ])
  expect(events.find(event => event.type === 'control_response' && event.response.request_id === 'enable')?.response.subtype).toBe('success')
  expect(suggestionRequests).toBe(1)
  const resultIndex = events.findIndex(event => event.type === 'result')
  const suggestionIndex = events.findIndex(event => event.type === 'prompt_suggestion')
  expect(resultIndex).toBeGreaterThanOrEqual(0)
  expect(suggestionIndex).toBeGreaterThan(resultIndex)
  // The "建议：" label is stripped and the two-character CJK suggestion survives the word-count filter.
  expect(events[suggestionIndex].suggestion).toBe(SUGGESTION)
  const activity = events.filter(event => event.subtype === 'prompt_suggestion_activity')
  expect(activity).toHaveLength(2)
  expect(activity.map(event => event.active)).toEqual([true, false])
  expect(activity[1].generation_id).toBe(activity[0].generation_id)
  const idleIndex = events.findIndex(event => event.subtype === 'session_state_changed' && event.state === 'idle')
  if (idleIndex >= 0) expect(events.indexOf(activity[0])).toBeLessThan(idleIndex)
  expect(events.indexOf(activity[0])).toBeGreaterThan(resultIndex)
  expect(events.indexOf(activity[1])).toBeGreaterThan(suggestionIndex)
}, 30_000)

test('suggestions stay off by default and after being turned back off', async () => {
  const off = await runPrint([userMessage('修一下这个 bug 然后跑测试')])
  expect(off.turnRequests).toBe(1)
  expect(off.suggestionRequests).toBe(0)
  expect(off.events.some(event => event.type === 'prompt_suggestion')).toBe(false)

  const toggled = await runPrint([
    control('enable', { subtype: 'set_prompt_suggestions', enabled: true }),
    control('disable', { subtype: 'set_prompt_suggestions', enabled: false }),
    userMessage('修一下这个 bug 然后跑测试'),
  ])
  expect(toggled.turnRequests).toBe(1)
  expect(toggled.suggestionRequests).toBe(0)
  expect(toggled.events.some(event => event.type === 'prompt_suggestion')).toBe(false)
}, 30_000)

test('turns the user did not start do not spend a suggestion request', async () => {
  const { events, suggestionRequests, turnRequests } = await runPrint([
    control('enable', { subtype: 'set_prompt_suggestions', enabled: true }),
    control('scheduled', {
      subtype: 'enqueue_scheduled_task',
      start_if_idle: true,
      message_id: 'scheduled-run',
      text: '检查一下构建状态',
      scheduled_task: { taskId: 'task', runId: 'run', scheduledFor: '2026-11-02T01:00:00Z', taskName: 'Check' },
    }),
  ])
  expect(turnRequests).toBe(1)
  expect(suggestionRequests).toBe(0)
  expect(events.some(event => event.type === 'prompt_suggestion')).toBe(false)
}, 30_000)

test('host notices sent as synthetic SDK user messages do not spend a suggestion request', async () => {
  const { suggestionRequests, turnRequests, events } = await runPrint([
    control('enable', { subtype: 'set_prompt_suggestions', enabled: true }),
    JSON.stringify({ type: 'user', session_id: '', parent_tool_use_id: null, isSynthetic: true, message: { role: 'user', content: '[Team runtime notice] reviewer finished' } }),
  ])
  expect(turnRequests).toBe(1)
  expect(suggestionRequests).toBe(0)
  expect(events.some(event => event.type === 'prompt_suggestion')).toBe(false)
}, 30_000)

type LiveCli = {
  events: any[]
  write(line: string): void
  waitFor(predicate: (event: any) => boolean, after?: number, timeoutMs?: number): Promise<any>
  close(): Promise<void>
}

// Drives the CLI turn by turn, so a second prompt is not batched into the first.
async function startLiveCli(
  fetch: (request: Request) => Response | Promise<Response>,
  extraArgs: string[],
): Promise<LiveCli> {
  const home = await mkdtemp(join(tmpdir(), 'prompt-suggestion-live-'))
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch })
  const env = createSandboxedTestEnvironment(home, {
    NODE_ENV: 'production', CI: '1', CC_HAHA_SKIP_DOTENV: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_AUTOUPDATER: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1',
    ANTHROPIC_API_KEY: 'fixture-key', ANTHROPIC_BASE_URL: server.url.origin,
    ANTHROPIC_MODEL: 'claude-sonnet-4-5',
  })
  const child = Bun.spawn(
    ['./bin/claude-haha', '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', ...extraArgs],
    { env, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
  )
  const events: any[] = []
  const listeners = new Set<() => void>()
  void (async () => {
    const decoder = new TextDecoder()
    const reader = child.stdout.getReader()
    let buffer = ''
    for (;;) {
      const { value: chunk, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(chunk, { stream: true })
      let newline: number
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        if (line.trim()) events.push(JSON.parse(line))
      }
      for (const listener of listeners) listener()
    }
  })()
  return {
    events,
    write(line) {
      child.stdin.write(line + '\n')
      child.stdin.flush()
    },
    waitFor(predicate, after = 0, timeoutMs = 20_000) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          listeners.delete(check)
          reject(new Error(`Timed out; saw ${JSON.stringify(events.slice(after).map(event => event.type))}`))
        }, timeoutMs)
        function check() {
          const event = events.slice(after).find(predicate)
          if (!event) return
          clearTimeout(timer)
          listeners.delete(check)
          resolve(event)
        }
        listeners.add(check)
        check()
      })
    },
    async close() {
      child.stdin.end()
      await Promise.race([child.exited, Bun.sleep(8_000)])
      child.kill()
      server.stop(true)
      await rm(home, { recursive: true, force: true })
    },
  }
}

const textStream = (texts: string[]) =>
  new Response(completion(texts), { headers: { 'content-type': 'text/event-stream' } })

const messageStart = () => ({ type: 'message_start', message: { id: `msg_${crypto.randomUUID()}`, type: 'message', role: 'assistant', model: 'claude-sonnet-4-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 12, output_tokens: 0 } } })

const sseBody = (events: Record<string, unknown>[]) =>
  events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('')

test("an interrupted turn does not predict from the previous turn's context", async () => {
  let suggestionRequests = 0
  let turnRequests = 0
  let secondTurnStarted!: () => void
  const secondTurn = new Promise<void>(resolve => { secondTurnStarted = resolve })
  const cli = await startLiveCli(async request => {
    if (!new URL(request.url).pathname.endsWith('/messages')) return new Response('{}')
    const body = await request.json() as { messages: unknown[] }
    if (JSON.stringify(body.messages.at(-1)).includes('[SUGGESTION MODE')) {
      suggestionRequests++
      return textStream([SUGGESTION])
    }
    turnRequests++
    if (turnRequests === 1) return textStream(['已经修好了。', '要我跑一下测试吗？'])
    // The second turn streams a little and then hangs until the CLI aborts it.
    secondTurnStarted()
    const encoder = new TextEncoder()
    return new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(sseBody([
          messageStart(),
          { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '正在重构' } },
        ])))
        request.signal.addEventListener('abort', () => { try { controller.close() } catch {} })
      },
    }), { headers: { 'content-type': 'text/event-stream' } })
  }, ['--bare'])
  try {
    cli.write(control('enable', { subtype: 'set_prompt_suggestions', enabled: true }))
    cli.write(userMessage('修一下这个 bug'))
    await cli.waitFor(event => event.type === 'prompt_suggestion')
    expect(suggestionRequests).toBe(1)

    const mark = cli.events.length
    cli.write(userMessage('再把它重构一下'))
    await secondTurn
    await Bun.sleep(300)
    cli.write(control('stop', { subtype: 'interrupt' }))
    await cli.waitFor(event => event.type === 'result', mark)
    // Generation would start right after the result; give it time to show up.
    await Bun.sleep(1_500)
    expect(suggestionRequests).toBe(1)
    expect(cli.events.slice(mark).some(event => event.type === 'prompt_suggestion')).toBe(false)
  } finally {
    await cli.close()
  }
}, 40_000)

test('a turn that waits for a background agent gets one suggestion after the final result', async () => {
  const log: string[] = []
  const cli = await startLiveCli(async request => {
    if (!new URL(request.url).pathname.endsWith('/messages')) return new Response('{}')
    const body = await request.json() as { messages: unknown[] }
    const all = JSON.stringify(body.messages)
    const last = JSON.stringify(body.messages.at(-1))
    if (last.includes('[SUGGESTION MODE')) {
      log.push('suggestion')
      return textStream([SUGGESTION])
    }
    if (JSON.stringify(body.messages[0]).includes('SUBTASK_PROMPT') && !all.includes('KICKOFF')) {
      log.push('subagent')
      await Bun.sleep(1_000)
      return textStream(['sub done'])
    }
    if (last.includes('task-notification') || last.includes('sub done')) {
      log.push('followup')
      return textStream(['后台任务完成了。', '结果已经合并。'])
    }
    if (last.includes('tool_result')) {
      log.push('main-after-tool')
      return textStream(['已经在后台启动。', '等它完成。'])
    }
    log.push('main')
    return new Response(sseBody([
      messageStart(),
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_bg1', name: 'Agent', input: {} } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ description: 'helper', prompt: 'SUBTASK_PROMPT do it', subagent_type: 'general-purpose', run_in_background: true }) } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 4 } },
      { type: 'message_stop' },
    ]), { headers: { 'content-type': 'text/event-stream' } })
  }, ['--dangerously-skip-permissions'])
  try {
    cli.write(control('enable', { subtype: 'set_prompt_suggestions', enabled: true }))
    cli.write(userMessage('KICKOFF 在后台跑一个助手'))
    const suggestion = await cli.waitFor(event => event.type === 'prompt_suggestion', 0, 30_000)
    expect(suggestion.suggestion).toBe(SUGGESTION)
    // Predicted once, from the settled exchange, and delivered after its result.
    expect(log.filter(entry => entry === 'suggestion')).toHaveLength(1)
    expect(log.indexOf('suggestion')).toBeGreaterThan(log.indexOf('followup'))
    const lastResult = cli.events.findLastIndex(event => event.type === 'result')
    expect(cli.events.indexOf(suggestion)).toBeGreaterThan(lastResult)
  } finally {
    await cli.close()
  }
}, 60_000)
