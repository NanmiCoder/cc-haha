import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import { createServer } from 'node:net'
import * as os from 'node:os'
import * as path from 'node:path'
import { gunzipSync } from 'node:zlib'
import { handleDiagnosticsApi } from '../api/diagnostics.js'
import { DiagnosticsService, diagnosticsService } from '../services/diagnosticsService.js'

let tmpDir: string
let originalConfigDir: string | undefined

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-haha-diagnostics-test-'))
  originalConfigDir = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = tmpDir
})

afterEach(async () => {
  diagnosticsService.restoreConsoleCaptureForTests()
  if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = originalConfigDir
  await fs.rm(tmpDir, { recursive: true, force: true })
})

function makeRequest(method: string, urlStr: string): { req: Request; url: URL; segments: string[] } {
  const url = new URL(urlStr, 'http://localhost:3456')
  const req = new Request(url.toString(), { method })
  const segments = url.pathname.split('/').filter(Boolean)
  return { req, url, segments }
}

async function getPort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('Failed to allocate a local port')))
        return
      }
      server.close(() => resolve(address.port))
    })
  })
}

async function waitForHttp(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let lastError = ''
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url)
      if (response.ok) return
      lastError = `HTTP ${response.status}`
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }
    await Bun.sleep(100)
  }
  throw new Error(`Timed out waiting for ${url}${lastError ? ` (${lastError})` : ''}`)
}

describe('DiagnosticsService', () => {
  test('writes sanitized structured events and runtime error summaries', async () => {
    const service = new DiagnosticsService()
    await service.recordEvent({
      type: 'cli_start_failed',
      severity: 'error',
      sessionId: 'session-1',
      summary: 'Authorization: Bearer sk-secret-token /Users/example/path',
      details: {
        apiKey: 'sk-secret',
        url: 'https://api.example.com?api_key=secret-value',
        nested: { message: `home=${os.homedir()}` },
      },
    })

    const raw = await fs.readFile(path.join(tmpDir, 'cc-haha', 'diagnostics', 'diagnostics.jsonl'), 'utf-8')
    expect(raw).toContain('cli_start_failed')
    expect(raw).toContain('[REDACTED]')
    expect(raw).not.toContain('sk-secret')
    expect(raw).not.toContain(os.homedir())

    const runtime = await fs.readFile(path.join(tmpDir, 'cc-haha', 'diagnostics', 'runtime-errors.log'), 'utf-8')
    expect(runtime).toContain('cli_start_failed')
    expect(runtime).toContain('"nested"')
    expect(runtime).toContain('[REDACTED]')
    expect(runtime).not.toContain('sk-secret-token')
  })

  test('exports a single diagnostics tarball without provider secrets', async () => {
    const service = new DiagnosticsService()
    await fs.mkdir(path.join(tmpDir, 'cc-haha'), { recursive: true })
    await fs.writeFile(
      path.join(tmpDir, 'cc-haha', 'providers.json'),
      JSON.stringify({
        activeId: 'provider-1',
        providers: [{
          id: 'provider-1',
          name: 'Test Provider',
          presetId: 'custom',
          apiKey: 'sk-provider-secret',
          baseUrl: 'https://api.example.com/anthropic',
          apiFormat: 'anthropic',
          models: { main: 'main-model', haiku: 'haiku-model', sonnet: 'sonnet-model', opus: 'opus-model' },
        }],
      }),
      'utf-8',
    )
    await service.recordEvent({
      type: 'provider_test_failed',
      severity: 'warn',
      sessionId: 'session-abc',
      summary: 'provider failed with token=provider-secret',
      details: { accessToken: 'provider-secret' },
    })
    await fs.writeFile(
      path.join(tmpDir, 'cc-haha', 'diagnostics', 'cli-diagnostics.jsonl'),
      '{"event":"cli_streaming_idle_timeout","data":{"authorization":"Bearer provider-secret"}}\n',
      'utf-8',
    )

    const bundle = await service.exportBundle()
    expect(bundle.path).toEndWith('.tar.gz')
    const archiveText = gunzipSync(await fs.readFile(bundle.path)).toString('utf-8')
    expect(archiveText).toContain('README.txt')
    expect(archiveText).toContain('recent-errors.md')
    expect(archiveText).toContain('cli-diagnostics.jsonl')
    expect(archiveText).toContain('providers-summary.json')
    expect(archiveText).toContain('sessions-summary.json')
    expect(archiveText).toContain('cli_streaming_idle_timeout')
    expect(archiveText).toContain('Test Provider')
    expect(archiveText).toContain('api.example.com')
    expect(archiveText).not.toContain('sk-provider-secret')
    expect(archiveText).not.toContain('provider-secret')
  })

  test('keeps fatal startup errors visible on stderr while recording diagnostics', async () => {
    const port = await getPort()
    const serverArgs = ['bun', 'run', 'src/server/index.ts', '--host', '127.0.0.1', '--port', String(port)]
    const env = {
      ...process.env,
      CLAUDE_CONFIG_DIR: tmpDir,
    }
    const server = Bun.spawn(serverArgs, {
      cwd: process.cwd(),
      env,
      stdout: 'ignore',
      stderr: 'ignore',
    })

    try {
      await waitForHttp(`http://127.0.0.1:${port}/health`, 10_000)

      const duplicate = Bun.spawn(serverArgs, {
        cwd: process.cwd(),
        env,
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(duplicate.stdout).text(),
        new Response(duplicate.stderr).text(),
        duplicate.exited,
      ])

      expect(exitCode).toBe(1)
      expect(stdout).toBe('')
      expect(stderr).toContain('[Server] Uncaught exception:')
      expect(stderr).toContain(`Failed to start server. Is port ${port} in use?`)

      const raw = await fs.readFile(path.join(tmpDir, 'cc-haha', 'diagnostics', 'diagnostics.jsonl'), 'utf-8')
      expect(raw).toContain('server_uncaught_exception')
      expect(raw).toContain(`Failed to start server. Is port ${port} in use?`)
    } finally {
      server.kill()
      await server.exited.catch(() => undefined)
    }
  })
})

describe('diagnostics API', () => {
  test('returns status, events, export path, and supports clearing logs', async () => {
    const service = diagnosticsService
    await service.recordEvent({
      type: 'api_unhandled_error',
      severity: 'error',
      summary: 'boom',
    })

    const statusReq = makeRequest('GET', '/api/diagnostics/status')
    const statusRes = await handleDiagnosticsApi(statusReq.req, statusReq.url, statusReq.segments)
    expect(statusRes.status).toBe(200)
    const status = await statusRes.json() as { logDir: string; cliDiagnosticsPath: string; recentErrorCount: number }
    expect(status.logDir).toContain(path.join('cc-haha', 'diagnostics'))
    expect(status.cliDiagnosticsPath).toContain('cli-diagnostics.jsonl')
    expect(status.recentErrorCount).toBe(1)

    const eventsReq = makeRequest('GET', '/api/diagnostics/events?limit=10')
    const eventsRes = await handleDiagnosticsApi(eventsReq.req, eventsReq.url, eventsReq.segments)
    expect(eventsRes.status).toBe(200)
    const events = await eventsRes.json() as { events: Array<{ type: string }> }
    expect(events.events[0].type).toBe('api_unhandled_error')

    const clientEventReq = new Request('http://localhost:3456/api/diagnostics/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'client_unhandled_rejection',
        severity: 'error',
        summary: 'frontend exploded token=client-secret',
        details: { accessToken: 'client-secret', stack: 'Error: boom' },
      }),
    })
    const clientEventUrl = new URL(clientEventReq.url)
    const clientEventRes = await handleDiagnosticsApi(
      clientEventReq,
      clientEventUrl,
      clientEventUrl.pathname.split('/').filter(Boolean),
    )
    expect(clientEventRes.status).toBe(200)
    const clientEvents = await service.readRecentEvents(10)
    expect(clientEvents[0].type).toBe('client_unhandled_rejection')
    expect(JSON.stringify(clientEvents[0])).toContain('[REDACTED]')
    expect(JSON.stringify(clientEvents[0])).not.toContain('client-secret')

    const exportReq = makeRequest('POST', '/api/diagnostics/export')
    const exportRes = await handleDiagnosticsApi(exportReq.req, exportReq.url, exportReq.segments)
    expect(exportRes.status).toBe(200)
    const exported = await exportRes.json() as { bundle: { path: string } }
    await expect(fs.stat(exported.bundle.path)).resolves.toBeTruthy()

    const clearReq = makeRequest('DELETE', '/api/diagnostics')
    const clearRes = await handleDiagnosticsApi(clearReq.req, clearReq.url, clearReq.segments)
    expect(clearRes.status).toBe(200)
    expect(await service.readRecentEvents()).toEqual([])
  })
})
