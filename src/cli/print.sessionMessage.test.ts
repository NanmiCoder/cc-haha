import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSandboxedTestEnvironment } from '../../scripts/pr/test-environment.js'

function completion() {
  const events = [
    { type: 'message_start', message: { id: 'msg_fixture', type: 'message', role: 'assistant', model: 'claude-sonnet-4-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'done' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } },
    { type: 'message_stop' },
  ]
  return events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('')
}

test('headless session inbox acknowledges queued then consumed and deduplicates control deliveries', async () => {
  const home = await mkdtemp(join(tmpdir(), 'session-message-print-'))
  let requests = 0
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    if (new URL(request.url).pathname.endsWith('/messages')) requests++
    return new Response(completion(), { headers: { 'content-type': 'text/event-stream' } })
  } })
  const env = createSandboxedTestEnvironment(home, {
    NODE_ENV: 'production', CI: '1', CC_HAHA_SKIP_DOTENV: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_AUTOUPDATER: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1',
    ANTHROPIC_API_KEY: 'fixture-key', ANTHROPIC_BASE_URL: server.url.origin,
    ANTHROPIC_MODEL: 'claude-sonnet-4-5',
  })
  const payload = { subtype: 'enqueue_session_message', start_if_idle: true, message_id: 'stable', sender_session_id: 'peer', text: '/clear @missing-fixture-file.txt' }
  const input = ['first', 'retry'].map(request_id => JSON.stringify({ type: 'control_request', request_id, request: payload })).join('\n') + '\n'
  try {
    const child = Bun.spawn(['./bin/claude-haha', '--bare', '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'], { env, stdin: new Blob([input]), stdout: 'pipe', stderr: 'pipe' })
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    expect({ code, stderr }).toMatchObject({ code: 0 })
    const events = stdout.trim().split('\n').map(line => JSON.parse(line))
    const controls = events.filter(event => event.type === 'control_response')
    expect(controls).toHaveLength(2)
    expect(controls[0].response.response).toMatchObject({ status: 'queued', duplicate: false })
    expect(controls[1].response.response.duplicate).toBe(true)
    expect(events.filter(event => event.subtype === 'session_message_receipt')).toMatchObject([{ message_id: 'stable', status: 'consumed' }])
    expect(requests).toBe(1)
    const sessionId = events.find(event => event.subtype === 'session_message_receipt').session_id
    const resumed = Bun.spawn(['./bin/claude-haha', '--bare', '-p', '--resume', sessionId, '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'], { env, stdin: new Blob([input]), stdout: 'pipe', stderr: 'pipe' })
    const [resumedText, resumedError, resumedCode] = await Promise.all([new Response(resumed.stdout).text(), new Response(resumed.stderr).text(), resumed.exited])
    expect({ code: resumedCode, stderr: resumedError, stdout: resumedText }).toMatchObject({ code: 0 })
    const resumedEvents = resumedText.trim().split('\n').map(line => JSON.parse(line))
    const resumedControls = resumedEvents.filter(event => event.type === 'control_response')
    expect(resumedControls).toHaveLength(2)
    expect(resumedControls.every(event => event.response.response.status === 'consumed' && event.response.response.duplicate)).toBe(true)
    expect(requests).toBe(1)
  } finally {
    server.stop(true)
    await rm(home, { recursive: true, force: true })
  }
}, 30_000)
