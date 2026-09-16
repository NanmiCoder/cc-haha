import { describe, expect, spyOn, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { createSandboxedTestEnvironment } from '../scripts/pr/test-environment.js'
import { run } from './localRecoveryCli.js'

describe('local recovery Anthropic base URL compatibility', () => {
  for (const mode of ['print', 'interactive'] as const) {
    for (const baseUrl of [undefined, 'https://provider.example/anthropic/v1/']) {
      test(`${mode} entry point uses ${baseUrl ?? 'the default Anthropic endpoint'} with supplied input`, async () => {
        const sandboxHome = await mkdtemp(join(tmpdir(), 'recovery-entry-point-'))
        const previousEnv = { ...process.env }
        const testEnv = createSandboxedTestEnvironment(sandboxHome, {
          ANTHROPIC_API_KEY: 'sk-test-recovery',
          ANTHROPIC_MODEL: 'claude-sonnet-4-6',
          ...(baseUrl ? { ANTHROPIC_BASE_URL: baseUrl } : {}),
        })
        for (const key of Object.keys(process.env)) delete process.env[key]
        Object.assign(process.env, testEnv)
        let stdout = ''
        let stderr = ''
        const requests: Array<{ url: string; body: unknown }> = []
        const stdoutSpy = spyOn(process.stdout, 'write').mockImplementation(chunk => {
          stdout += String(chunk)
          return true
        })
        const stderrSpy = spyOn(process.stderr, 'write').mockImplementation(chunk => {
          stderr += String(chunk)
          return true
        })
        const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
          requests.push({
            url: input instanceof Request ? input.url : String(input),
            body: JSON.parse(String(init?.body)),
          })
          return Response.json({
            id: 'msg-recovery-entry-point',
            type: 'message',
            role: 'assistant',
            model: 'claude-sonnet-4-6',
            content: [{ type: 'text', text: 'entry point succeeded' }],
            stop_reason: 'end_turn',
            stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 1 },
          })
        })

        try {
          await run(
            mode === 'print' ? ['--print'] : [],
            Readable.from([mode === 'print' ? 'hello\n' : 'hello\n/exit\n']),
          )
          expect(stderr).toBe('')
          expect(stdout).toContain('entry point succeeded')
          expect(requests).toEqual([{
            url: baseUrl ? 'https://provider.example/anthropic/v1/messages' : 'https://api.anthropic.com/v1/messages',
            body: expect.objectContaining({
              model: 'claude-sonnet-4-6',
              messages: [{ role: 'user', content: 'hello' }],
            }),
          }])
        } finally {
          fetchSpy.mockRestore()
          stdoutSpy.mockRestore()
          stderrSpy.mockRestore()
          for (const key of Object.keys(process.env)) delete process.env[key]
          Object.assign(process.env, previousEnv)
          await rm(sandboxHome, { recursive: true, force: true })
        }
      })
    }
  }

  for (const mode of ['print', 'interactive'] as const) {
    for (const basePath of ['/anthropic', '/anthropic/v1/']) {
      test(`${mode} sends messages through ${basePath} without duplicating the API version`, async () => {
        const sandboxHome = await mkdtemp(join(tmpdir(), 'recovery-base-url-'))
        const requests: Array<{ path: string; body: unknown }> = []
        const upstream = Bun.serve({
          hostname: '127.0.0.1',
          port: 0,
          async fetch(request) {
            const pathname = new URL(request.url).pathname
            requests.push({ path: pathname, body: await request.json() })
            if (pathname !== '/anthropic/v1/messages') {
              return Response.json({ error: { type: 'not_found_error', message: 'wrong endpoint' } }, { status: 404 })
            }
            return Response.json({
              id: 'msg-recovery-test',
              type: 'message',
              role: 'assistant',
              model: 'claude-sonnet-4-6',
              content: [{ type: 'text', text: 'recovery request succeeded' }],
              stop_reason: 'end_turn',
              stop_sequence: null,
              usage: { input_tokens: 1, output_tokens: 1 },
            })
          },
        })
        let child: ReturnType<typeof Bun.spawn> | undefined

        try {
          child = Bun.spawn([
            process.execPath,
            '--no-env-file',
            join(import.meta.dir, 'localRecoveryCli.ts'),
            ...(mode === 'print' ? ['--print', 'hello'] : []),
          ], {
            cwd: join(import.meta.dir, '..'),
            env: createSandboxedTestEnvironment(sandboxHome, {
              ANTHROPIC_API_KEY: 'sk-test-recovery',
              ANTHROPIC_BASE_URL: `http://127.0.0.1:${upstream.port}${basePath}`,
              ANTHROPIC_MODEL: 'claude-sonnet-4-6',
              API_TIMEOUT_MS: '2000',
            }),
            stdin: mode === 'interactive' ? new Blob(['hello\n/exit\n']) : 'ignore',
            stdout: 'pipe',
            stderr: 'pipe',
          })
          const [stdout, stderr, exitCode] = await Promise.all([
            new Response(child.stdout).text(),
            new Response(child.stderr).text(),
            child.exited,
          ])

          expect(stderr).toBe('')
          expect(exitCode).toBe(0)
          expect(stdout).toContain('recovery request succeeded')
          expect(requests).toEqual([{
            path: '/anthropic/v1/messages',
            body: expect.objectContaining({
              model: 'claude-sonnet-4-6',
              messages: [{ role: 'user', content: 'hello' }],
            }),
          }])
        } finally {
          child?.kill()
          upstream.stop(true)
          await rm(sandboxHome, { recursive: true, force: true })
        }
      })
    }
  }
})
