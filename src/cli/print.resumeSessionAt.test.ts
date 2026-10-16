import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
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

type Row = { uuid: string; parentUuid: string | null; type: 'user' | 'assistant'; message: Record<string, unknown> }

function chain(): { rows: Row[]; ids: Record<'prompt' | 'plan' | 'toolUse' | 'toolResult' | 'after', string> } {
  const ids = {
    prompt: crypto.randomUUID(), plan: crypto.randomUUID(), toolUse: crypto.randomUUID(),
    toolResult: crypto.randomUUID(), after: crypto.randomUUID(),
  }
  const assistant = (id: string, uuid: string, parentUuid: string, content: unknown[]): Row => ({
    uuid, parentUuid, type: 'assistant',
    message: { id, role: 'assistant', model: 'claude-sonnet-4-5', content, stop_reason: null, usage: { input_tokens: 1, output_tokens: 1 } },
  })
  const rows: Row[] = [
    { uuid: ids.prompt, parentUuid: null, type: 'user', message: { role: 'user', content: 'start the long job' } },
    assistant('msg_plan', ids.plan, ids.prompt, [{ type: 'text', text: 'PLAN-VISIBLE' }]),
    assistant('msg_tool', ids.toolUse, ids.plan, [{ type: 'tool_use', id: 'toolu_job', name: 'Bash', input: { command: 'sleep 600' } }]),
  ]
  return { rows, ids }
}

// Without --bare, so a SessionStart hook configured in the sandbox really runs.
async function runSideChat(options: { rows: Row[]; resumeAt?: string; resumeHook?: boolean }) {
  const home = await mkdtemp(join(tmpdir(), 'resume-session-at-'))
  const requests: any[] = []
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    if (new URL(request.url).pathname.endsWith('/messages')) requests.push(await request.json())
    return new Response(completion(), { headers: { 'content-type': 'text/event-stream' } })
  } })
  const env = createSandboxedTestEnvironment(home, {
    NODE_ENV: 'production', CI: '1', CC_HAHA_SKIP_DOTENV: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_AUTOUPDATER: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1',
    ANTHROPIC_API_KEY: 'fixture-key', ANTHROPIC_BASE_URL: server.url.origin,
    ANTHROPIC_MODEL: 'claude-sonnet-4-5',
  })
  try {
    const parentId = crypto.randomUUID()
    const transcriptDir = join(home, '.claude', 'projects', 'fixture')
    await mkdir(transcriptDir, { recursive: true })
    if (options.resumeHook) {
      const output = JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'RESUME-HOOK-CONTEXT' } })
      await writeFile(join(home, '.claude', 'settings.json'), JSON.stringify({
        hooks: { SessionStart: [{ matcher: 'resume', hooks: [{ type: 'command', command: `printf '%s' '${output}'` }] }] },
      }))
    }
    const transcript = join(transcriptDir, `${parentId}.jsonl`)
    const lines = options.rows.map(row => JSON.stringify({
      ...row, sessionId: parentId, cwd: process.cwd(), version: '9.9.9',
      timestamp: new Date().toISOString(), isSidechain: false, userType: 'external',
    }))
    await writeFile(transcript, lines.join('\n') + '\n')
    // The same arguments the desktop server passes for a side chat.
    const child = Bun.spawn(['./bin/claude-haha', ...(options.resumeHook ? [] : ['--bare']), '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
      '--resume', transcript, ...(options.resumeAt ? ['--resume-session-at', options.resumeAt] : []), '--fork-session',
      '--session-id', crypto.randomUUID(), '--no-session-persistence'],
      { env, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' })
    child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: 'SIDE-QUESTION' } }) + '\n')
    child.stdin.end()
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    const events = stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
    return { code, stderr, events, requests }
  } finally {
    server.stop(true)
    await rm(home, { recursive: true, force: true })
  }
}

function toolIds(messages: any[]) {
  const blocks = messages.flatMap(message => Array.isArray(message.content) ? message.content : [])
  return {
    uses: blocks.filter(block => block.type === 'tool_use').map(block => block.id),
    results: blocks.filter(block => block.type === 'tool_result').map(block => block.tool_use_id),
  }
}

test('side chat can fork at a tool call that has no result yet', async () => {
  const { rows, ids } = chain()
  const run = await runSideChat({ rows, resumeAt: ids.toolUse })
  expect({ code: run.code, stderr: run.stderr }).toEqual({ code: 0, stderr: '' })
  expect(run.events.filter(event => event.type === 'result').map(event => event.subtype)).toEqual(['success'])
  expect(run.requests).toHaveLength(1)
  const text = JSON.stringify(run.requests[0].messages)
  expect(text).toContain('PLAN-VISIBLE')
  expect(text).toContain('SIDE-QUESTION')
  // The pending call stays with the parent; the child never inherits a dangling tool_use.
  expect(toolIds(run.requests[0].messages).uses).toEqual([])
}, 30_000)

test('a rewind boundary runs resume hooks but does not add their context after it', async () => {
  const { rows, ids } = chain()
  // Control: an ordinary resume receives the hook context, so its absence below is meaningful.
  const control = await runSideChat({ rows, resumeHook: true })
  expect({ code: control.code, stderr: control.stderr }).toEqual({ code: 0, stderr: '' })
  expect(JSON.stringify(control.requests[0].messages)).toContain('RESUME-HOOK-CONTEXT')

  const fork = await runSideChat({ rows, resumeAt: ids.toolUse, resumeHook: true })
  expect({ code: fork.code, stderr: fork.stderr }).toEqual({ code: 0, stderr: '' })
  expect(fork.requests).toHaveLength(1)
  const text = JSON.stringify(fork.requests[0].messages)
  expect(text).toContain('PLAN-VISIBLE')
  expect(text).not.toContain('RESUME-HOOK-CONTEXT')
}, 60_000)

// Adjacent path: this also passes on the old order (the API layer pairs a
// dangling call), so it guards the boundary rather than detecting the bug.
test('forking before a tool result keeps the result and later text out of the child', async () => {
  const { rows, ids } = chain()
  rows.push(
    { uuid: ids.toolResult, parentUuid: ids.toolUse, type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_job', content: 'RESULT-AFTER-CUT' }] } },
    { uuid: ids.after, parentUuid: ids.toolResult, type: 'assistant', message: { id: 'msg_after', role: 'assistant', model: 'claude-sonnet-4-5', content: [{ type: 'text', text: 'TEXT-AFTER-CUT' }], stop_reason: null, usage: { input_tokens: 1, output_tokens: 1 } } },
  )
  const run = await runSideChat({ rows, resumeAt: ids.toolUse })
  expect({ code: run.code, stderr: run.stderr }).toEqual({ code: 0, stderr: '' })
  expect(run.requests).toHaveLength(1)
  const text = JSON.stringify(run.requests[0].messages)
  expect(text).toContain('PLAN-VISIBLE')
  expect(text).not.toContain('RESULT-AFTER-CUT')
  expect(text).not.toContain('TEXT-AFTER-CUT')
  const { uses, results } = toolIds(run.requests[0].messages)
  expect(uses.filter(id => !results.includes(id))).toEqual([])
}, 30_000)

test('an unknown resume boundary is still reported as a load error', async () => {
  const { rows } = chain()
  const missing = crypto.randomUUID()
  const run = await runSideChat({ rows, resumeAt: missing })
  expect(run.code).toBe(1)
  expect(run.requests).toHaveLength(0)
  expect(run.events.find(event => event.type === 'result')).toMatchObject({
    subtype: 'error_during_execution', is_error: true,
    errors: [`No message found with message.uuid of: ${missing}`],
  })
}, 30_000)
