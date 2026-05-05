import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { gunzipSync } from 'node:zlib'
import { handleDiagnosticsApi } from '../api/diagnostics.js'
import { DiagnosticsService, diagnosticsService } from '../services/diagnosticsService.js'

let tmpDir: string
let originalConfigDir: string | undefined

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yuanclaw-diagnostics-test-'))
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

    const raw = await fs.readFile(path.join(tmpDir, 'yuanclaw', 'diagnostics', 'diagnostics.jsonl'), 'utf-8')
    expect(raw).toContain('cli_start_failed')
    expect(raw).toContain('[REDACTED]')
    expect(raw).not.toContain('sk-secret')
    expect(raw).not.toContain(os.homedir())

    const runtime = await fs.readFile(path.join(tmpDir, 'yuanclaw', 'diagnostics', 'runtime-errors.log'), 'utf-8')
    expect(runtime).toContain('cli_start_failed')
    expect(runtime).toContain('[REDACTED]')
    expect(runtime).not.toContain('sk-secret-token')
  })

  test('exports a single diagnostics tarball without provider secrets', async () => {
    const service = new DiagnosticsService()
    await fs.mkdir(path.join(tmpDir, 'yuanclaw'), { recursive: true })
    await fs.writeFile(
      path.join(tmpDir, 'yuanclaw', 'providers.json'),
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

    const bundle = await service.exportBundle()
    expect(bundle.path).toEndWith('.tar.gz')
    const archiveText = gunzipSync(await fs.readFile(bundle.path)).toString('utf-8')
    expect(archiveText).toContain('README.txt')
    expect(archiveText).toContain('providers-summary.json')
    expect(archiveText).toContain('sessions-summary.json')
    expect(archiveText).toContain('Test Provider')
    expect(archiveText).toContain('api.example.com')
    expect(archiveText).not.toContain('sk-provider-secret')
    expect(archiveText).not.toContain('provider-secret')
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
    const status = await statusRes.json() as { logDir: string; recentErrorCount: number }
    expect(status.logDir).toContain(path.join('yuanclaw', 'diagnostics'))
    expect(status.recentErrorCount).toBe(1)

    const eventsReq = makeRequest('GET', '/api/diagnostics/events?limit=10')
    const eventsRes = await handleDiagnosticsApi(eventsReq.req, eventsReq.url, eventsReq.segments)
    expect(eventsRes.status).toBe(200)
    const events = await eventsRes.json() as { events: Array<{ type: string }> }
    expect(events.events[0].type).toBe('api_unhandled_error')

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
