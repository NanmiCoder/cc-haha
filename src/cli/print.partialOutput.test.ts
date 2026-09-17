import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

let configDir: string | null = null

async function removeConfigDir(path: string): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      await rm(path, { recursive: true, force: true })
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (process.platform !== 'win32' || !['EACCES', 'EBUSY', 'EPERM'].includes(code ?? '') || attempt === 19) {
        throw error
      }
      await new Promise(resolve => setTimeout(resolve, 100))
    }
  }
}

afterEach(async () => {
  if (configDir) {
    await removeConfigDir(configDir)
    configDir = null
  }
})

describe('print mode partial output', () => {
  test(
    'keeps assistant text produced before a mid-stream API error',
    async () => {
      const server = Bun.serve({
        hostname: '127.0.0.1',
        port: 0,
        fetch() {
          return new Response(midStreamErrorResponse(), {
            headers: { 'content-type': 'text/event-stream' },
          })
        },
      })
      configDir = await mkdtemp(join(tmpdir(), 'cc-haha-print-partial-'))

      try {
        const child = Bun.spawn(
          // --bare still allows the built-in Computer Use MCP. This output-only
          // fixture must not start its native helper or hold its venv executable open.
          [process.execPath, '--no-env-file', './bin/claude-haha', '--bare', '--no-computer-use', '-p', 'Reply briefly'],
          {
            cwd: process.cwd(),
            env: {
              ...process.env,
              NODE_ENV: 'production',
              CI: '1',
              CC_HAHA_SKIP_DOTENV: '1',
              CLAUDE_CONFIG_DIR: configDir,
              CLAUDE_CODE_SKIP_PROMPT_HISTORY: '1',
              CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
              CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK: '1',
              CLAUDE_STREAM_TRANSIENT_RETRY_MAX: '0',
              DISABLE_AUTOUPDATER: '1',
              DISABLE_TELEMETRY: '1',
              DISABLE_ERROR_REPORTING: '1',
              ANTHROPIC_API_KEY: 'loopback-test-key',
              ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.port}`,
              ANTHROPIC_MODEL: 'claude-sonnet-4-5',
              CLAUDE_CODE_USE_BEDROCK: undefined,
              CLAUDE_CODE_USE_VERTEX: undefined,
              CLAUDE_CODE_USE_FOUNDRY: undefined,
              ANTHROPIC_AUTH_TOKEN: undefined,
            },
            stdout: 'pipe',
            stderr: 'pipe',
          },
        )

        const [stdout, stderr, exitCode] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ])

        expect(exitCode).toBe(1)
        expect(stderr).not.toContain('FIRST_PARTIAL_SENTINEL')
        expect(stderr).not.toContain('SECOND_PARTIAL_SENTINEL')
        expect(stdout).toContain('FIRST_PARTIAL_SENTINEL')
        expect(stdout).toContain('SECOND_PARTIAL_SENTINEL')
        expect(stdout).toContain('MIDSTREAM_SENTINEL_ERROR')
        expect(existsSync(join(configDir, '.runtime', 'venv'))).toBe(false)
      } finally {
        server.stop(true)
      }
    },
    30_000,
  )

  test(
    'keeps completed text when a socket reset exhausts stream retries',
    async () => {
      const server = Bun.listen({
        hostname: '127.0.0.1',
        port: 0,
        socket: {
          open(socket) {
            const payload = completedBlockWithoutMessageStop()
            socket.write(
              [
                'HTTP/1.1 200 OK',
                'Content-Type: text/event-stream',
                'Transfer-Encoding: chunked',
                'Connection: close',
                '',
                `${Buffer.byteLength(payload).toString(16)}\r\n${payload}\r\n`,
              ].join('\r\n'),
            )
            socket.flush()
            setTimeout(() => socket.end(), 50)
          },
          data() {},
        },
      })
      configDir = await mkdtemp(join(tmpdir(), 'cc-haha-print-transport-'))

      try {
        const child = Bun.spawn(
          [process.execPath, '--no-env-file', './bin/claude-haha', '--bare', '--no-computer-use', '-p', 'Reply briefly'],
          {
            cwd: process.cwd(),
            env: {
              ...process.env,
              NODE_ENV: 'production',
              CI: '1',
              CC_HAHA_SKIP_DOTENV: '1',
              CLAUDE_CONFIG_DIR: configDir,
              CLAUDE_CODE_SKIP_PROMPT_HISTORY: '1',
              CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
              CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK: '1',
              CLAUDE_STREAM_TRANSIENT_RETRY_MAX: '0',
              DISABLE_AUTOUPDATER: '1',
              DISABLE_TELEMETRY: '1',
              DISABLE_ERROR_REPORTING: '1',
              ANTHROPIC_API_KEY: 'loopback-test-key',
              ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.port}`,
              ANTHROPIC_MODEL: 'claude-sonnet-4-5',
              CLAUDE_CODE_USE_BEDROCK: undefined,
              CLAUDE_CODE_USE_VERTEX: undefined,
              CLAUDE_CODE_USE_FOUNDRY: undefined,
              ANTHROPIC_AUTH_TOKEN: undefined,
            },
            stdout: 'pipe',
            stderr: 'pipe',
          },
        )

        const [stdout, , exitCode] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ])

        expect(exitCode).toBe(1)
        expect(stdout.match(/TRANSPORT_PARTIAL_SENTINEL/g)).toHaveLength(1)
        expect(stdout).toMatch(/socket|connection|stream/i)
        expect(existsSync(join(configDir, '.runtime', 'venv'))).toBe(false)
      } finally {
        server.stop(true)
      }
    },
    30_000,
  )
})

function sseEvent(name: string, data: unknown): string {
  return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`
}

function midStreamErrorResponse(): string {
  return [
    sseEvent('message_start', {
      type: 'message_start',
      message: {
        id: 'msg_partial_output',
        type: 'message',
        role: 'assistant',
        model: 'claude-sonnet-4-5',
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 0 },
      },
    }),
    sseEvent('content_block_start', {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    }),
    sseEvent('content_block_delta', {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'FIRST_PARTIAL_SENTINEL' },
    }),
    sseEvent('content_block_stop', {
      type: 'content_block_stop',
      index: 0,
    }),
    sseEvent('content_block_start', {
      type: 'content_block_start',
      index: 1,
      content_block: { type: 'text', text: '' },
    }),
    sseEvent('content_block_delta', {
      type: 'content_block_delta',
      index: 1,
      delta: { type: 'text_delta', text: 'SECOND_PARTIAL_SENTINEL' },
    }),
    sseEvent('content_block_stop', {
      type: 'content_block_stop',
      index: 1,
    }),
    sseEvent('error', {
      type: 'error',
      error: {
        type: 'api_error',
        message: 'MIDSTREAM_SENTINEL_ERROR',
      },
    }),
  ].join('')
}

function completedBlockWithoutMessageStop(): string {
  return [
    sseEvent('message_start', {
      type: 'message_start',
      message: {
        id: 'msg_transport_partial',
        type: 'message',
        role: 'assistant',
        model: 'claude-sonnet-4-5',
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 0 },
      },
    }),
    sseEvent('content_block_start', {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    }),
    sseEvent('content_block_delta', {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'TRANSPORT_PARTIAL_SENTINEL' },
    }),
    sseEvent('content_block_stop', {
      type: 'content_block_stop',
      index: 0,
    }),
  ].join('')
}
