import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

// Compaction through the real CLI and request path against a loopback
// Anthropic upstream: the prompt that goes out, the live progress the desktop
// renders, and how many full-context requests one failing compaction may send.

type RecordedRequest = { compaction: boolean; prompt: string }

const COMPACTION_MARKER = 'CRITICAL: Respond with TEXT ONLY'
const SESSION_ID = '5f0c2d0e-6a51-4b7e-9d0c-3c7b8b1f2a10'
const CLI = join(process.cwd(), 'bin', 'claude-haha')
const encoder = new TextEncoder()
let sandbox: string | null = null

afterEach(async () => {
  if (sandbox) {
    await rm(sandbox, { recursive: true, force: true })
    sandbox = null
  }
})

function sse(event: Record<string, unknown>): Uint8Array {
  return encoder.encode(
    `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
  )
}

function messageStart(id: string): Record<string, unknown> {
  return {
    type: 'message_start',
    message: {
      id,
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-4-5',
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 120, output_tokens: 1 },
    },
  }
}

/** A complete text reply whose deltas arrive `gapMs` apart. */
function textReply(id: string, chunks: string[], gapMs = 0): Response {
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(sse(messageStart(id)))
      controller.enqueue(
        sse({
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: '' },
        }),
      )
      for (const text of chunks) {
        if (gapMs) await Bun.sleep(gapMs)
        controller.enqueue(
          sse({
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text },
          }),
        )
      }
      controller.enqueue(sse({ type: 'content_block_stop', index: 0 }))
      controller.enqueue(
        sse({
          type: 'message_delta',
          delta: { stop_reason: 'end_turn', stop_sequence: null },
          usage: { output_tokens: 40 },
        }),
      )
      controller.enqueue(sse({ type: 'message_stop' }))
      controller.close()
    },
  })
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } })
}

/** The upstream closes mid-block: a transport failure that is re-sent. */
function cutOffReply(id: string): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(sse(messageStart(id)))
      controller.enqueue(
        sse({
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: '' },
        }),
      )
      controller.enqueue(
        sse({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: '<summary>partial' },
        }),
      )
      controller.close()
    },
  })
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } })
}

function lastUserText(body: { messages?: Array<{ role: string; content: unknown }> }): string {
  const last = body.messages?.at(-1)
  if (!last) return ''
  if (typeof last.content === 'string') return last.content
  return Array.isArray(last.content)
    ? last.content
        .map(part => (part as { text?: unknown }).text)
        .filter((text): text is string => typeof text === 'string')
        .join('\n')
    : ''
}

function startUpstream(compactionReply: (index: number) => Response) {
  const requests: RecordedRequest[] = []
  let compactions = 0
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      // The CLI may preconnect with a bare HEAD before the first request.
      if (request.method !== 'POST' || !new URL(request.url).pathname.endsWith('/messages')) {
        return new Response(null, { status: 200 })
      }
      const body = (await request.json()) as {
        messages?: Array<{ role: string; content: unknown }>
      }
      const prompt = lastUserText(body)
      const compaction = prompt.includes(COMPACTION_MARKER)
      requests.push({ compaction, prompt })
      return compaction
        ? compactionReply(compactions++)
        : textReply(`msg_turn_${requests.length}`, ['Working on it.'])
    },
  })
  return { server, requests }
}

async function runCli(port: number, args: string[], env: Record<string, string> = {}) {
  // Not --bare: bare mode does not persist the session we resume.
  const child = Bun.spawn([CLI, ...args], {
    cwd: join(sandbox!, 'project'),
    env: {
      ...process.env,
      CALLER_DIR: undefined,
      HOME: sandbox!,
      NODE_ENV: 'production',
      CI: '1',
      CC_HAHA_SKIP_DOTENV: '1',
      CLAUDE_CONFIG_DIR: join(sandbox!, 'config'),
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK: '1',
      DISABLE_AUTOUPDATER: '1',
      DISABLE_TELEMETRY: '1',
      DISABLE_ERROR_REPORTING: '1',
      ANTHROPIC_API_KEY: 'loopback-test-key',
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
      ANTHROPIC_MODEL: 'claude-sonnet-4-5',
      CLAUDE_CODE_USE_BEDROCK: undefined,
      CLAUDE_CODE_USE_VERTEX: undefined,
      CLAUDE_CODE_USE_FOUNDRY: undefined,
      CLAUDE_CODE_USE_OPENAI: undefined,
      CC_HAHA_OPENAI_OAUTH_PROVIDER: undefined,
      ANTHROPIC_AUTH_TOKEN: undefined,
      CLAUDE_CODE_CURRIED_TRINKET: undefined,
      ...env,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  return { stdout, stderr, exitCode }
}

function jsonLines(stdout: string): Array<Record<string, unknown>> {
  return stdout
    .split('\n')
    .filter(line => line.startsWith('{'))
    .map(line => JSON.parse(line) as Record<string, unknown>)
}

async function compactSeededSession(
  compactionReply: (index: number) => Response,
  env: Record<string, string> = {},
) {
  sandbox = await mkdtemp(join(tmpdir(), 'cc-haha-print-compaction-'))
  await mkdir(join(sandbox, 'project'))
  const { server, requests } = startUpstream(compactionReply)
  try {
    const seed = await runCli(
      server.port,
      ['-p', 'Look at the build script.', '--session-id', SESSION_ID],
      env,
    )
    expect({ code: seed.exitCode, output: seed.stdout + seed.stderr }).toMatchObject({ code: 0 })
    const compact = await runCli(
      server.port,
      [
        '-p',
        '/compact',
        '--resume',
        SESSION_ID,
        '--output-format',
        'stream-json',
        '--verbose',
      ],
      env,
    )
    return { ...compact, requests, events: jsonLines(compact.stdout) }
  } finally {
    server.stop(true)
  }
}

describe('print mode compaction', () => {
  test(
    'sends the lean prompt by default and streams compaction progress',
    async () => {
      const summary = [
        '<summary>The user asked to look at the build script. ',
        'Nothing has been changed yet; scripts/build.ts is the entry point. ',
        'Next: read scripts/build.ts and report how the bundle is produced.</summary>',
      ]
      const { requests, events, exitCode } = await compactSeededSession(() =>
        textReply('msg_compact', summary, 1_500),
      )

      expect(exitCode).toBe(0)
      const compactionPrompts = requests.filter(r => r.compaction)
      expect(compactionPrompts).toHaveLength(1)
      const prompt = compactionPrompts[0]!.prompt
      expect(prompt).toContain('Detail you can fetch again needs only a pointer')
      expect(prompt).toContain('plain text only — a <summary> block.')
      expect(prompt).not.toContain('<analysis>')
      expect(prompt).not.toContain('full code snippets')

      const progress = events
        .filter(
          event =>
            event.type === 'system' &&
            event.subtype === 'status' &&
            event.status === 'compacting' &&
            event.compact_progress !== undefined,
        )
        .map(
          event =>
            (event.compact_progress as { output_chars: number }).output_chars,
        )
      // Deltas arrive 1.5s apart and progress is throttled to once a second,
      // so the running total is reported while the summary streams.
      expect(progress.length).toBeGreaterThanOrEqual(2)
      expect(progress).toEqual([...progress].sort((a, b) => a - b))
      expect(new Set(progress).size).toBe(progress.length)
      expect(progress.at(-1)).toBe(summary.join('').length)

      const boundaryIndex = events.findIndex(
        event => event.type === 'system' && event.subtype === 'compact_boundary',
      )
      const lastProgressIndex = events.findLastIndex(
        event => event.compact_progress !== undefined,
      )
      expect(boundaryIndex).toBeGreaterThan(lastProgressIndex)
    },
    60_000,
  )

  test(
    'keeps the original detailed prompt behind CLAUDE_CODE_CURRIED_TRINKET=control',
    async () => {
      const { requests, exitCode } = await compactSeededSession(
        () => textReply('msg_compact', ['<analysis>a</analysis><summary>s</summary>']),
        { CLAUDE_CODE_CURRIED_TRINKET: 'control' },
      )

      expect(exitCode).toBe(0)
      const prompt = requests.find(r => r.compaction)!.prompt
      expect(prompt).toContain('an <analysis> block followed by a <summary> block')
      expect(prompt).toContain('full code snippets')
    },
    60_000,
  )

  test(
    'caps a failing compaction at one request budget across the fork and its fallback',
    async () => {
      const { requests, events } = await compactSeededSession(
        index => cutOffReply(`msg_cut_${index}`),
        { CLAUDE_CODE_MAX_RETRIES: '2' },
      )

      // Without the shared budget the cache-sharing fork re-sends 1 + 2 times,
      // then the streaming fallback re-sends the full context 1 + 2 more.
      expect(requests.filter(r => r.compaction)).toHaveLength(3)
      expect(
        events.some(
          event => event.type === 'system' && event.subtype === 'compact_boundary',
        ),
      ).toBe(false)
    },
    60_000,
  )
})
