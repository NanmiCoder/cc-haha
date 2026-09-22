import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createSandboxedTestEnvironment } from '../../scripts/pr/test-environment.js'

function response(content: Record<string, unknown>[], stopReason: string) {
  const event = (type: string, fields: Record<string, unknown>) =>
    `event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`
  return new Response([
    event('message_start', { message: {
      id: crypto.randomUUID(), type: 'message', role: 'assistant',
      model: 'claude-sonnet-4-5', content: [], stop_reason: null,
      stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 },
    } }),
    ...content.flatMap((block, index) => [
      event('content_block_start', { index, content_block: block.type === 'tool_use' ? { ...block, input: {} } : { type: 'text', text: '' } }),
      event('content_block_delta', { index, delta: block.type === 'tool_use'
        ? { type: 'input_json_delta', partial_json: JSON.stringify(block.input) }
        : { type: 'text_delta', text: block.text } }),
      event('content_block_stop', { index }),
    ]),
    event('message_delta', { delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 1 } }),
    event('message_stop', {}),
  ].join(''), { headers: { 'content-type': 'text/event-stream' } })
}

test('publishes real shell terminals while the model is still working, without repeating them on follow-up', async () => {
  const home = await mkdtemp(join(tmpdir(), 'shell-terminal-stream-'))
  let releaseModel!: () => void
  const modelBlocked = new Promise<void>(resolve => { releaseModel = resolve })
  let waitingForModel = false
  let requestCount = 0
  let sawModelNotification = false
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    if (request.method !== 'POST') return new Response('ok')
    const body = await request.json() as { messages: unknown[] }
    if (new URL(request.url).pathname.includes('count_tokens')) return Response.json({ input_tokens: 1 })
    requestCount++
    if (requestCount === 1) {
      return response([0, 7].map(code => ({
        type: 'tool_use', id: `real-shell-${code}`, name: 'Bash',
        input: { command: `exit ${code}`, description: `real exit ${code}`, run_in_background: true },
      })), 'tool_use')
    }
    if (requestCount === 2) {
      waitingForModel = true
      await modelBlocked
    }
    if (JSON.stringify(body.messages).includes('<task-notification>')) sawModelNotification = true
    return response([{ type: 'text', text: 'Finished developing.' }], 'end_turn')
  } })
  const child = Bun.spawn([process.execPath, '--no-env-file', resolve('bin/claude-haha'),
    '--bare', '-p', '--verbose', '--input-format', 'stream-json', '--output-format', 'stream-json',
    '--dangerously-skip-permissions'], {
    cwd: home,
    env: createSandboxedTestEnvironment(home, {
      NODE_ENV: 'production', CI: '1', CC_HAHA_SKIP_DOTENV: '1',
      CALLER_DIR: home, ANTHROPIC_API_KEY: 'loopback-fixture-key',
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.port}`,
      ANTHROPIC_MODEL: 'claude-sonnet-4-5',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      DISABLE_AUTOUPDATER: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1',
    }), stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
  })
  const events: { type?: string; subtype?: string; task_id?: string; tool_use_id?: string; status?: string }[] = []
  const stdout = (async () => {
    let pending = ''
    for await (const chunk of child.stdout) {
      pending += new TextDecoder().decode(chunk)
      const lines = pending.split('\n')
      pending = lines.pop()!
      for (const line of lines) if (line.trim()) events.push(JSON.parse(line))
    }
  })()
  const stderr = new Response(child.stderr).text()
  const terminals = () => events.filter(event => event.subtype === 'task_notification')
  try {
    child.stdin.write(`${JSON.stringify({ type: 'user', message: { role: 'user', content: 'Run the checks and continue developing.' } })}\n`)
    const deadline = Date.now() + 15_000
    while ((!waitingForModel || terminals().length < 2) && Date.now() < deadline) await Bun.sleep(20)
    expect(waitingForModel).toBe(true)
    expect(events.filter(event => event.subtype === 'task_started')).toHaveLength(2)
    // The upstream is intentionally still pending: no model turn has ended,
    // and the later-priority notification commands have not been consumed.
    expect(terminals().map(event => [event.tool_use_id, event.status]).sort()).toEqual([
      ['real-shell-0', 'completed'], ['real-shell-7', 'failed'],
    ])
    expect(events.some(event => event.type === 'result')).toBe(false)
    for (const terminal of terminals()) {
      const startIndex = events.findIndex(event => event.subtype === 'task_started' && event.task_id === terminal.task_id)
      expect(startIndex).toBeGreaterThanOrEqual(0)
      expect(startIndex).toBeLessThan(events.indexOf(terminal))
    }
    releaseModel()
    child.stdin.end()
    expect(await child.exited).toBe(0)
    await stdout
    expect(terminals()).toHaveLength(2)
    expect(sawModelNotification).toBe(true)
    expect(await stderr).toBe('')
  } finally {
    releaseModel()
    child.kill()
    await child.exited
    await stdout
    server.stop(true)
    await rm(home, { recursive: true, force: true })
  }
}, 30_000)
