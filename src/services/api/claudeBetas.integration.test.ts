import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createSandboxedTestEnvironment } from '../../../scripts/pr/test-environment.js'

const contextBeta = 'context-1m-2025-08-07'
const root = resolve(import.meta.dir, '../../..')

async function runRelay(options: {
  model?: string
  injectHeader?: boolean
  env?: Record<string, string>
  args?: string[]
} = {}) {
  const sandbox = await mkdtemp(join(tmpdir(), 'cc-haha-context-beta-'))
  const requests: { model: string, beta: string, status: number }[] = []
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      if (!new URL(request.url).pathname.endsWith('/messages')) {
        return new Response('Unexpected route', { status: 404 })
      }
      const body = await request.json() as { model: string }
      const beta = request.headers.get('anthropic-beta') ?? ''
      const forwardedHeaders = new Headers(request.headers)
      if (options.injectHeader) {
        forwardedHeaders.set('anthropic-beta', [beta, contextBeta].filter(Boolean).join(','))
      }
      const accepted = forwardedHeaders.get('anthropic-beta')?.split(',').includes(contextBeta)
      requests.push({ model: body.model, beta, status: accepted ? 200 : 400 })
      if (!accepted) {
        return Response.json({ type: 'error', error: {
          type: 'invalid_request_error', message: '1m 上下文已经全量可用，请启用 1m 上下文后重试',
        } }, { status: 400 })
      }
      const events = [
        { type: 'message_start', message: {
          id: 'msg_context_fixture', type: 'message', role: 'assistant', model: body.model,
          content: [], stop_reason: null, stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 0 },
        } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'relay-ok' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null },
          usage: { output_tokens: 1 } },
        { type: 'message_stop' },
      ]
      return new Response(events.map(event =>
        `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''), {
        headers: { 'content-type': 'text/event-stream' },
      })
    },
  })
  const child = Bun.spawn([
    process.execPath, '--no-env-file', join(root, 'src/entrypoints/cli.tsx'),
    '-p', 'Reply relay-ok', '--model', options.model ?? 'claude-opus-5[1m]',
    '--output-format', 'json', '--tools', '', '--strict-mcp-config',
    '--mcp-config', '{"mcpServers":{}}', '--setting-sources', 'user',
    ...options.args ?? [],
  ], {
    cwd: root,
    env: createSandboxedTestEnvironment(sandbox, {
      NODE_ENV: 'production',
      CALLER_DIR: sandbox,
      ANTHROPIC_API_KEY: 'loopback-test-key',
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.port}`,
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'claude-opus-5[1m]',
      ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES: 'thinking,effort',
      CLAUDE_CODE_MODEL_CONTEXT_WINDOWS: '{"claude-opus-5":1000000}',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      CLAUDE_CODE_SKIP_UPDATE_CHECK: '1',
      ...options.env,
    }),
    stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
  })
  const timer = setTimeout(() => child.kill('SIGKILL'), 30_000)
  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ])
    return { exitCode, stdout, stderr, requests }
  } finally {
    clearTimeout(timer)
    child.kill()
    server.stop(true)
    await rm(sandbox, { recursive: true, force: true })
  }
}

test('real CLI can complete against the strict relay when only its missing header is supplied', async () => {
  const result = await runRelay({ injectHeader: true })
  expect(result.exitCode, JSON.stringify(result)).toBe(0)
  expect(result.stdout).toContain('relay-ok')
  expect(result.requests.map(request => request.model)).toEqual(['claude-opus-5'])
}, 40_000)

test('real CLI honors environment and SDK 1M opt-ins without a model suffix', async () => {
  for (const options of [
    { env: { ANTHROPIC_BETAS: ` , ${contextBeta}, ` } },
    { args: ['--betas', contextBeta] },
  ]) {
    const result = await runRelay({ model: 'claude-opus-5', ...options })
    expect(result.exitCode, JSON.stringify(result)).toBe(0)
    expect(result.stdout).toContain('relay-ok')
    expect(result.requests).toHaveLength(1)
    expect(result.requests[0]?.beta.split(',')).toContain(contextBeta)
  }
}, 80_000)

test('real CLI does not force 1M onto models without opt-in or with context disabled', async () => {
  for (const options of [
    { model: 'claude-opus-5' },
    { env: { CLAUDE_CODE_DISABLE_1M_CONTEXT: '1' } },
    { env: { CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: '1' } },
  ]) {
    const result = await runRelay(options)
    expect(result.exitCode, JSON.stringify(result)).toBe(1)
    expect(result.stdout).toContain('请启用 1m 上下文后重试')
    expect(result.requests).toHaveLength(1)
    expect(result.requests[0]?.beta.split(',')).not.toContain(contextBeta)
  }
}, 80_000)

test('real CLI sends the opted-in 1M beta to third-party Anthropic relays', async () => {
  const result = await runRelay()
  expect(result.exitCode, JSON.stringify(result)).toBe(0)
  expect(result.stdout).toContain('relay-ok')
  expect(result.requests).toHaveLength(1)
  expect(result.requests[0]?.model).toBe('claude-opus-5')
  expect(result.requests[0]?.beta.split(',')).toContain(contextBeta)
}, 40_000)
