import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import { createServer } from 'node:net'
import * as os from 'node:os'
import * as path from 'node:path'
import { gunzipSync } from 'node:zlib'
import { handleDiagnosticsApi } from '../api/diagnostics.js'
import { DiagnosticsService, diagnosticsService } from '../services/diagnosticsService.js'
import { createSandboxedTestEnvironment } from '../../../scripts/pr/test-environment.js'

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

function readTarEntry(archive: Buffer, entryName: string): string {
  const tar = gunzipSync(archive)
  let offset = 0
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512)
    if (header.every((byte) => byte === 0)) break
    const name = header.subarray(0, 100).toString('utf-8').replace(/\0.*$/, '')
    const sizeText = header.subarray(124, 136).toString('ascii').replace(/\0.*$/, '').trim()
    const size = Number.parseInt(sizeText || '0', 8)
    const contentStart = offset + 512
    if (name === entryName) {
      return tar.subarray(contentStart, contentStart + size).toString('utf-8')
    }
    offset = contentStart + Math.ceil(size / 512) * 512
  }
  throw new Error(`Missing tar entry: ${entryName}`)
}

async function assertAppendSurvivesCliCleanup(
  service: DiagnosticsService,
  appendTarget: string,
  marker: string,
): Promise<void> {
  await fs.mkdir(service.getLogDir(), { recursive: true })
  await fs.writeFile(appendTarget, 'old cli event\n')
  const staleDate = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000)
  await fs.utimes(appendTarget, staleDate, staleDate)
  const originalRename = fs.rename
  const originalRm = fs.rm
  let injected = false
  const injectAppend = async () => {
    if (injected) return
    injected = true
    await fs.appendFile(appendTarget, `${marker}\n`)
  }
  const renameSpy = spyOn(fs, 'rename').mockImplementation(async (from, to) => {
    if (from === appendTarget) await injectAppend()
    return originalRename(from, to)
  })
  const rmSpy = spyOn(fs, 'rm').mockImplementation(async (target, options) => {
    if (target === appendTarget) await injectAppend()
    return originalRm(target, options)
  })
  try {
    await service.getStatus()
  } finally {
    renameSpy.mockRestore()
    rmSpy.mockRestore()
  }

  expect(injected).toBe(true)
  const bundle = await service.exportBundle()
  expect(readTarEntry(await fs.readFile(bundle.path), 'cli-diagnostics.jsonl')).toContain(marker)
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
        proxyUrl: 'https://proxy-user:p%40ss@example.com:8443/api',
        nested: { message: `home=${os.homedir()}` },
      },
    })

    const raw = await fs.readFile(path.join(tmpDir, 'cc-haha', 'diagnostics', 'diagnostics.jsonl'), 'utf-8')
    expect(raw).toContain('cli_start_failed')
    expect(raw).toContain('[REDACTED]')
    expect(raw).toContain('https://[REDACTED]@example.com:8443/api')
    expect(raw).not.toContain('sk-secret')
    expect(raw).not.toContain('proxy-user')
    expect(raw).not.toContain('p%40ss')
    expect(raw).not.toContain(os.homedir())

    const runtime = await fs.readFile(path.join(tmpDir, 'cc-haha', 'diagnostics', 'runtime-errors.log'), 'utf-8')
    expect(runtime).toContain('cli_start_failed')
    expect(runtime).toContain('"nested"')
    expect(runtime).toContain('[REDACTED]')
    expect(runtime).not.toContain('sk-secret-token')
  })

  test('defaults an unclassified event to info, not error', async () => {
    const service = new DiagnosticsService()
    await service.recordEvent({ type: 'some_unclassified_event', summary: 'no severity given' })

    const raw = await fs.readFile(path.join(tmpDir, 'cc-haha', 'diagnostics', 'diagnostics.jsonl'), 'utf-8')
    const event = JSON.parse(raw.trim().split('\n').at(-1)!)
    expect(event.severity).toBe('info')

    // info events stay out of the warning/error runtime log
    await expect(
      fs.readFile(path.join(tmpDir, 'cc-haha', 'diagnostics', 'runtime-errors.log'), 'utf-8'),
    ).rejects.toThrow()
  })

  test('drops events under NODE_ENV=test when no CLAUDE_CONFIG_DIR is set (no real-home pollution)', async () => {
    const service = new DiagnosticsService()
    const appendSpy = spyOn(fs, 'appendFile')
    const savedConfigDir = process.env.CLAUDE_CONFIG_DIR
    delete process.env.CLAUDE_CONFIG_DIR
    try {
      await service.recordEvent({ type: 'leaked_test_event', severity: 'error', summary: 'should not be written' })
      expect(appendSpy).not.toHaveBeenCalled()
    } finally {
      appendSpy.mockRestore()
      if (savedConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = savedConfigDir
    }
  })

  test('counts all retained events and reports corrupt lines outside the visible window', async () => {
    const service = new DiagnosticsService()
    const events = Array.from({ length: 600 }, (_, index) => ({
      id: String(index),
      timestamp: new Date().toISOString(),
      type: index < 100 ? 'real_failure' : 'normal_exit',
      severity: index < 100 ? 'error' : 'info',
      summary: index < 100 ? 'boom' : 'clean',
    }))
    await fs.mkdir(path.dirname(service.getDiagnosticsPath()), { recursive: true })
    await fs.writeFile(service.getDiagnosticsPath(), `${events.map(JSON.stringify).join('\n')}\n{broken`)

    const status = await service.getStatus()
    expect(status.eventCount).toBe(600)
    expect(status.recentErrorCount).toBe(100)
    expect(status.physicalLineCount).toBe(601)
    expect(status.corruptLineCount).toBe(1)
    expect(await service.readRecentEvents(100)).toHaveLength(100)
  })

  test('counts blank and invalid event-shaped lines as corrupt physical lines', async () => {
    const service = new DiagnosticsService()
    const validEvent = {
      id: 'valid',
      timestamp: new Date().toISOString(),
      type: 'valid_event',
      severity: 'info',
      summary: 'valid',
    }
    await fs.mkdir(path.dirname(service.getDiagnosticsPath()), { recursive: true })
    await fs.writeFile(service.getDiagnosticsPath(), [
      JSON.stringify(validEvent),
      '',
      'null',
      '[]',
      JSON.stringify({ ...validEvent, severity: 'fatal' }),
      JSON.stringify({ ...validEvent, timestamp: 'not-a-date' }),
      JSON.stringify({ ...validEvent, summary: 42 }),
      '',
    ].join('\n'))

    const status = await service.getStatus()
    expect(status.eventCount).toBe(1)
    expect(status.physicalLineCount).toBe(7)
    expect(status.corruptLineCount).toBe(6)
    expect((await service.readRecentEvents()).map((event) => event.id)).toEqual(['valid'])
  })

  test('preserves corrupt-line evidence across the next retention rewrite', async () => {
    const service = new DiagnosticsService()
    const staleEvent = {
      id: 'stale-before-corruption',
      timestamp: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString(),
      type: 'stale',
      severity: 'info',
      summary: 'old',
    }
    await fs.mkdir(path.dirname(service.getDiagnosticsPath()), { recursive: true })
    await fs.writeFile(service.getDiagnosticsPath(), `${JSON.stringify(staleEvent)}\n{PRIVATE_CORRUPT_PAYLOAD\n`)

    await service.recordEvent({ type: 'fresh_after_corruption', summary: 'fresh' })

    const firstStatus = await service.getStatus()
    expect(firstStatus.corruptLineCount).toBe(1)
    expect((await service.readRecentEvents()).map((event) => event.type)).toEqual(['fresh_after_corruption'])
    expect(await fs.readFile(service.getDiagnosticsPath(), 'utf-8')).not.toContain('PRIVATE_CORRUPT_PAYLOAD')

    await service.recordEvent({ type: 'second_fresh', summary: 'second' })
    expect((await service.getStatus()).corruptLineCount).toBe(1)
  })

  test('does not double count corrupt evidence when the structured rewrite fails and retries', async () => {
    const service = new DiagnosticsService()
    const validEvent = {
      id: 'valid-before-retry',
      timestamp: new Date().toISOString(),
      type: 'valid',
      severity: 'info',
      summary: 'valid',
    }
    await fs.mkdir(path.dirname(service.getDiagnosticsPath()), { recursive: true })
    await fs.writeFile(service.getDiagnosticsPath(), `${JSON.stringify(validEvent)}\n{broken-once\n`)
    const originalRename = fs.rename
    let failedRewrite = false
    const renameSpy = spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (!failedRewrite && to === service.getDiagnosticsPath()) {
        failedRewrite = true
        throw Object.assign(new Error('forced diagnostics rewrite failure'), { code: 'EIO' })
      }
      return originalRename(from, to)
    })
    try {
      await service.recordEvent({ type: 'first_retry_probe', summary: 'first' })
      expect((await service.getStatus()).corruptLineCount).toBe(1)
      await service.recordEvent({ type: 'second_retry_probe', summary: 'second' })
    } finally {
      renameSpy.mockRestore()
    }

    expect((await service.getStatus()).corruptLineCount).toBe(1)
    expect((await service.readRecentEvents()).map((event) => event.type)).toContain('second_retry_probe')
  })

  test('recovers pending corrupt evidence after rewrite succeeds but commit fails, then counts new corruption once', async () => {
    const service = new DiagnosticsService()
    const validEvent = {
      id: 'valid-before-commit-crash',
      timestamp: new Date().toISOString(),
      type: 'valid',
      severity: 'info',
      summary: 'valid',
    }
    await fs.mkdir(path.dirname(service.getDiagnosticsPath()), { recursive: true })
    await fs.writeFile(service.getDiagnosticsPath(), `${JSON.stringify(validEvent)}\n{first-corrupt\n`)
    const evidencePath = path.join(service.getLogDir(), 'corruption-evidence.json')
    const originalRename = fs.rename
    let failedCommit = false
    const renameSpy = spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (!failedCommit && to === evidencePath) {
        failedCommit = true
        throw Object.assign(new Error('forced evidence commit failure'), { code: 'EIO' })
      }
      return originalRename(from, to)
    })
    try {
      await service.recordEvent({ type: 'rewrite_succeeds_commit_fails', summary: 'first' })
      await fs.appendFile(service.getDiagnosticsPath(), '{second-corrupt\n')
      await service.recordEvent({ type: 'retry_after_new_corruption', summary: 'second' })
    } finally {
      renameSpy.mockRestore()
    }

    expect((await service.getStatus()).corruptLineCount).toBe(2)
    expect((await service.readRecentEvents()).map((event) => event.type)).toContain('retry_after_new_corruption')
  })

  test('returns a failed write result when the diagnostics directory cannot be created', async () => {
    const service = new DiagnosticsService()
    const blockedConfigDir = path.join(tmpDir, 'config-file')
    await fs.writeFile(blockedConfigDir, 'not-a-directory')
    process.env.CLAUDE_CONFIG_DIR = blockedConfigDir

    const result = await service.recordEvent({ type: 'write_probe', severity: 'error', summary: 'boom' })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).not.toContain(tmpDir)
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
          baseUrl: 'https://user:pass@api.example.com/private?token=x',
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
    expect(archiveText).toContain('projected diagnostic metadata/details')
    expect(archiveText).not.toContain('captured runtime details')
    expect(archiveText).not.toContain('user:pass')
    expect(archiveText).not.toContain('/private')
    expect(archiveText).not.toContain('token=x')
    expect(archiveText).not.toContain('sk-provider-secret')
    expect(archiveText).not.toContain('provider-secret')
  })

  test('leaves exported runtime-errors.log empty when only info events exist', async () => {
    const service = new DiagnosticsService()
    await service.recordEvent({
      type: 'informational_probe',
      severity: 'info',
      summary: 'routine status',
    })

    const bundle = await service.exportBundle()

    expect(readTarEntry(await fs.readFile(bundle.path), 'runtime-errors.log')).toBe('')
  })

  test('exports share projections without captured SDK or assistant content', async () => {
    const service = new DiagnosticsService()
    await service.recordEvent({
      type: 'sdk_api_error',
      severity: 'error',
      summary: 'PRIVATE_ASSISTANT_REPLY',
      details: {
        errorCode: 'API_ERROR',
        status: 'failed',
        capturedOutput: 'PRIVATE_CAPTURED_OUTPUT',
        sdkMessages: [{ result: 'PRIVATE_SDK_RESULT' }],
        bareToken: 'sk-ant-api03-BARESECRET',
      },
    })

    const bundle = await service.exportBundle()
    const archiveText = gunzipSync(await fs.readFile(bundle.path)).toString('utf-8')

    expect(archiveText).toContain('event')
    expect(archiveText).toContain('omittedFields')
    expect(archiveText).toContain('API_ERROR')
    expect(archiveText).not.toContain('PRIVATE_ASSISTANT_REPLY')
    expect(archiveText).not.toContain('PRIVATE_CAPTURED_OUTPUT')
    expect(archiveText).not.toContain('PRIVATE_SDK_RESULT')
    expect(archiveText).not.toContain('sk-ant-api03-BARESECRET')
  })

  test('bounds shared event payloads and issue-report event ids to recent evidence', async () => {
    const service = new DiagnosticsService()
    const events = Array.from({ length: 5_100 }, (_, index) => ({
      id: `event-${index}`,
      timestamp: new Date(Date.now() + index).toISOString(),
      type: 'bounded_export_probe',
      severity: 'error',
      summary: `private summary ${index}`,
    }))
    await fs.mkdir(path.dirname(service.getDiagnosticsPath()), { recursive: true })
    await fs.writeFile(service.getDiagnosticsPath(), `${events.map(JSON.stringify).join('\n')}\n`)

    const bundle = await service.exportBundle()
    const exportedEvents = readTarEntry(await fs.readFile(bundle.path), 'diagnostics.jsonl')
      .trim().split('\n').filter(Boolean)
    expect(exportedEvents).toHaveLength(5_000)
    expect(exportedEvents[0]).toContain('event-5099')
    expect(exportedEvents.at(-1)).toContain('event-100')
    expect(exportedEvents.join('\n')).not.toContain('event-99"')

    const report = await service.buildIssueReport()
    expect(report).toContain('event-5099')
    expect(report).not.toContain('event-4999')
    const eventIdsLine = report.split('\n').find((line) => line.startsWith('- Event IDs:')) ?? ''
    expect(eventIdsLine.length).toBeLessThan(8_000)
  })

  test('includes a sanitized bounded Electron host log in status and exports', async () => {
    const service = new DiagnosticsService()
    const electronHostPath = path.join(service.getLogDir(), 'electron-host.log')
    await fs.mkdir(service.getLogDir(), { recursive: true })
    await fs.writeFile(
      electronHostPath,
      `${'old host line\n'.repeat(500_000)}latest failure token=ELECTRON_SECRET /Users/alice/private/project\n`,
    )

    const status = await service.getStatus()
    expect(status.electronHostPath).toBe(electronHostPath)
    expect((await fs.stat(electronHostPath)).size).toBeLessThanOrEqual(5 * 1024 * 1024)

    const bundle = await service.exportBundle()
    const hostLog = readTarEntry(await fs.readFile(bundle.path), 'electron-host.log')
    expect(hostLog).toContain('latest failure')
    expect(hostLog).not.toContain('ELECTRON_SECRET')
    expect(hostLog).not.toContain('/Users/alice')
    expect(Buffer.byteLength(hostLog)).toBeLessThanOrEqual(256 * 1024 + 64)
  })

  test('bounds active diagnostic surfaces and recent exports under the advertised directory cap', async () => {
    const service = new DiagnosticsService()
    await fs.mkdir(service.getExportDir(), { recursive: true })
    const oversized = `${'diagnostic line\n'.repeat(450_000)}latest marker\n`
    const closedCliSegment = `${service.getCliDiagnosticsPath()}.123.1.jsonl`
    await Promise.all([
      fs.writeFile(service.getRuntimeErrorsPath(), oversized),
      fs.writeFile(closedCliSegment, oversized),
      fs.writeFile(path.join(service.getLogDir(), 'electron-host.log'), oversized),
      ...Array.from({ length: 20 }, (_, index) => fs.writeFile(
        path.join(service.getExportDir(), `recent-${String(index).padStart(2, '0')}.tar.gz`),
        Buffer.alloc(1024 * 1024, index),
      )),
    ])

    const status = await service.getStatus()
    expect(status.totalBytes).toBeLessThanOrEqual(status.maxBytes)
    for (const filePath of [
      service.getRuntimeErrorsPath(),
      path.join(service.getLogDir(), 'electron-host.log'),
    ]) {
      expect((await fs.stat(filePath)).size).toBeLessThanOrEqual(5 * 1024 * 1024)
    }
    await expect(fs.stat(closedCliSegment)).rejects.toThrow()
    const exports = await fs.readdir(service.getExportDir())
    const exportStats = await Promise.all(exports.map((name) => fs.stat(path.join(service.getExportDir(), name))))
    expect(exportStats.reduce((sum, stat) => sum + stat.size, 0)).toBeLessThanOrEqual(15 * 1024 * 1024)
  })

  test('caps closed CLI segments globally and reports active multiprocess overflow honestly', async () => {
    const service = new DiagnosticsService()
    await fs.mkdir(service.getLogDir(), { recursive: true })
    await Promise.all([
      ...Array.from({ length: 8 }, (_, index) => fs.writeFile(
        `${service.getCliDiagnosticsPath()}.${index}.closed.jsonl`,
        Buffer.alloc(1024 * 1024, index),
      )),
      ...Array.from({ length: 55 }, (_, index) => fs.writeFile(
        `${service.getCliDiagnosticsPath()}.unknown-${index}.current.jsonl`,
        Buffer.alloc(1024 * 1024, index),
      )),
    ])

    const status = await service.getStatus()
    const files = await fs.readdir(service.getLogDir())
    const closed = files.filter((name) => name.includes('.closed.jsonl'))
    const closedStats = await Promise.all(closed.map((name) => fs.stat(path.join(service.getLogDir(), name))))
    expect(closedStats.reduce((sum, stat) => sum + stat.size, 0)).toBeLessThanOrEqual(5 * 1024 * 1024)
    expect(status.totalBytes).toBeGreaterThan(status.maxBytes)
    expect(status.storageLimitExceeded).toBe(true)
  })

  test('reclaims dead current CLI segments but preserves the live current process segment', async () => {
    const service = new DiagnosticsService()
    await fs.mkdir(service.getLogDir(), { recursive: true })
    const livePath = `${service.getCliDiagnosticsPath()}.${process.pid}.current.jsonl`
    const deadPath = `${service.getCliDiagnosticsPath()}.99999999.current.jsonl`
    await fs.writeFile(livePath, 'live-current\n')
    await fs.writeFile(deadPath, 'dead-current\n')

    await service.getStatus()

    await expect(fs.readFile(livePath, 'utf-8')).resolves.toContain('live-current')
    await expect(fs.stat(deadPath)).rejects.toThrow()

    const staleDate = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000)
    await fs.utimes(livePath, staleDate, staleDate)
    await service.getStatus()
    await expect(fs.stat(livePath)).rejects.toThrow()
  })

  test('reclaims stale legacy and unknown-PID current files by retention lease while preserving recent legacy', async () => {
    const service = new DiagnosticsService()
    await fs.mkdir(service.getLogDir(), { recursive: true })
    const legacyPath = service.getCliDiagnosticsPath()
    const unknownCurrentPath = `${service.getCliDiagnosticsPath()}.not-a-pid.current.jsonl`
    await fs.writeFile(legacyPath, 'stale legacy\n')
    await fs.writeFile(unknownCurrentPath, 'stale unknown pid\n')
    const staleDate = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000)
    await fs.utimes(legacyPath, staleDate, staleDate)
    await fs.utimes(unknownCurrentPath, staleDate, staleDate)

    await service.getStatus()

    await expect(fs.stat(legacyPath)).rejects.toThrow()
    await expect(fs.stat(unknownCurrentPath)).rejects.toThrow()
    await fs.writeFile(legacyPath, Buffer.alloc(6 * 1024 * 1024, 1))
    const recentLegacyStatus = await service.getStatus()
    await expect(fs.stat(legacyPath)).resolves.toBeTruthy()
    expect(recentLegacyStatus.storageLimitExceeded).toBe(true)
    await fs.utimes(legacyPath, staleDate, staleDate)
    const reclaimedStatus = await service.getStatus()
    await expect(fs.stat(legacyPath)).rejects.toThrow()
    expect(reclaimedStatus.storageLimitExceeded).toBe(true)
    const settledStatus = await service.getStatus()
    expect(settledStatus.storageLimitExceeded).toBe(false)
  })

  test('never replaces an active legacy CLI diagnostics file during retention', async () => {
    const service = new DiagnosticsService()
    const cliPath = service.getCliDiagnosticsPath()
    await fs.mkdir(path.dirname(cliPath), { recursive: true })
    await fs.writeFile(cliPath, `${'old cli line\n'.repeat(500_000)}before-retention\n`)
    const originalRename = fs.rename
    let cliRenameAttempted = false
    const renameSpy = spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (to === cliPath) cliRenameAttempted = true
      return originalRename(from, to)
    })
    try {
      await Promise.all([
        service.getStatus(),
        fs.appendFile(cliPath, 'append-during-retention\n'),
      ])
    } finally {
      renameSpy.mockRestore()
    }

    expect(cliRenameAttempted).toBe(false)
    expect(await fs.readFile(cliPath, 'utf-8')).toContain('append-during-retention')
  })

  test('re-lists CLI segments when the writer rotates between export listing and reading', async () => {
    const service = new DiagnosticsService()
    await fs.mkdir(service.getLogDir(), { recursive: true })
    const currentPath = `${service.getCliDiagnosticsPath()}.${process.pid}.current.jsonl`
    const completedPath = `${service.getCliDiagnosticsPath()}.${process.pid}.rotated.jsonl`
    await fs.writeFile(currentPath, '{"event":"ROTATED_BETWEEN_LIST_AND_READ"}\n')
    const originalOpen = fs.open
    let rotated = false
    const openSpy = spyOn(fs, 'open').mockImplementation(async (filePath, ...args) => {
      if (!rotated && filePath === currentPath) {
        rotated = true
        await fs.rename(currentPath, completedPath)
      }
      return originalOpen(filePath, ...args)
    })
    try {
      const bundle = await service.exportBundle()
      const cliLog = readTarEntry(await fs.readFile(bundle.path), 'cli-diagnostics.jsonl')
      expect(cliLog).toContain('ROTATED_BETWEEN_LIST_AND_READ')
    } finally {
      openSpy.mockRestore()
    }
  })

  test('quarantines a stale PID-current segment so an append immediately before cleanup survives', async () => {
    const service = new DiagnosticsService()
    const currentPath = `${service.getCliDiagnosticsPath()}.${process.pid}.current.jsonl`
    await assertAppendSurvivesCliCleanup(service, currentPath, 'PID_CURRENT_NEW_EVENT')
  })

  test('quarantines a stale legacy append target so an append immediately before cleanup survives', async () => {
    const service = new DiagnosticsService()
    await assertAppendSurvivesCliCleanup(service, service.getCliDiagnosticsPath(), 'LEGACY_NEW_EVENT')
  })

  test('compacts stale structured events without deleting the active diagnostics file', async () => {
    const service = new DiagnosticsService()
    const staleEvent = {
      id: 'stale',
      timestamp: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString(),
      type: 'stale',
      severity: 'info',
      summary: 'old',
    }
    await fs.mkdir(path.dirname(service.getDiagnosticsPath()), { recursive: true })
    await fs.writeFile(service.getDiagnosticsPath(), `${JSON.stringify(staleEvent)}\n`)

    await service.recordEvent({ type: 'fresh', severity: 'info', summary: 'new' })

    expect((await service.readRecentEvents()).map((event) => event.type)).toEqual(['fresh'])
    await expect(fs.stat(service.getDiagnosticsPath())).resolves.toBeTruthy()
  })

  test('keeps the newest complete structured lines when the active file exceeds the byte cap', async () => {
    const service = new DiagnosticsService()
    const oversizedSummary = 'x'.repeat(51 * 1024 * 1024)
    const oversizedEvent = {
      id: 'oversized',
      timestamp: new Date().toISOString(),
      type: 'oversized',
      severity: 'info',
      summary: oversizedSummary,
    }
    await fs.mkdir(path.dirname(service.getDiagnosticsPath()), { recursive: true })
    await fs.writeFile(service.getDiagnosticsPath(), `${JSON.stringify(oversizedEvent)}\n`)

    await service.recordEvent({ type: 'fresh', severity: 'info', summary: 'new' })

    expect((await service.readRecentEvents()).map((event) => event.type)).toEqual(['fresh'])
    await expect(fs.stat(service.getDiagnosticsPath())).resolves.toBeTruthy()
  })

  test('serializes concurrent writes with forced compaction so neither event is lost', async () => {
    const service = new DiagnosticsService()
    const oversizedEvent = {
      id: 'oversized',
      timestamp: new Date().toISOString(),
      type: 'oversized',
      severity: 'info',
      summary: 'x'.repeat(51 * 1024 * 1024),
    }
    await fs.mkdir(path.dirname(service.getDiagnosticsPath()), { recursive: true })
    await fs.writeFile(service.getDiagnosticsPath(), `${JSON.stringify(oversizedEvent)}\n`)

    let releaseFirstRename!: () => void
    let firstRenameReached!: () => void
    const firstRenameGate = new Promise<void>((resolve) => { releaseFirstRename = resolve })
    const firstRenameSignal = new Promise<void>((resolve) => { firstRenameReached = resolve })
    const originalRename = fs.rename
    let renameCount = 0
    const renameSpy = spyOn(fs, 'rename').mockImplementation(async (...args) => {
      renameCount += 1
      if (renameCount === 1) {
        firstRenameReached()
        await firstRenameGate
        return originalRename(...args)
      }
      return originalRename(...args)
    })

    try {
      const firstWrite = service.recordEvent({ type: 'concurrent_first', summary: 'first' })
      await firstRenameSignal
      const secondWrite = service.recordEvent({ type: 'concurrent_second', summary: 'second' })
      await Bun.sleep(100)
      expect(renameCount).toBe(1)
      releaseFirstRename()
      await Promise.all([firstWrite, secondWrite])
    } finally {
      releaseFirstRename()
      renameSpy.mockRestore()
    }

    expect((await service.readRecentEvents()).map((event) => event.type)).toEqual([
      'concurrent_second',
      'concurrent_first',
    ])
  })

  test('exports the tail of oversized CLI text logs', async () => {
    const service = new DiagnosticsService()
    const cliPath = service.getCliDiagnosticsPath()
    await fs.mkdir(path.dirname(cliPath), { recursive: true })
    await fs.writeFile(
      cliPath,
      `OLDEST_PREFIX_MARKER\n${'routine diagnostic line\n'.repeat(15_000)}LATEST_FAILURE_MARKER\n`,
    )

    const bundle = await service.exportBundle()
    const archiveText = gunzipSync(await fs.readFile(bundle.path)).toString('utf-8')

    expect(archiveText).toContain('[TRUNCATED OLDER CONTENT]')
    expect(archiveText).toContain('LATEST_FAILURE_MARKER')
    expect(archiveText).not.toContain('OLDEST_PREFIX_MARKER')
  })

  test('redacts a secret whose key is split across the tail-read byte boundary', async () => {
    const service = new DiagnosticsService()
    const cliPath = service.getCliDiagnosticsPath()
    const secret = 'BOUNDARY_SPLIT_SECRET'
    const marker = 'LATEST_FAILURE_MARKER\n'
    const suffixWithoutKey = `${secret}\n\n${marker}`
    const paddingBytes = 256 * 1024 - Buffer.byteLength(suffixWithoutKey)
    const safeLine = 'safe line\n'
    const suffixPadding = safeLine.repeat(Math.floor(paddingBytes / Buffer.byteLength(safeLine))) +
      'z'.repeat(paddingBytes % Buffer.byteLength(safeLine))
    await fs.mkdir(path.dirname(cliPath), { recursive: true })
    await fs.writeFile(
      cliPath,
      `${'old-prefix'.repeat(600)}\ntoken=${secret}\n${suffixPadding}\n${marker}`,
    )

    const bundle = await service.exportBundle()
    const archiveText = gunzipSync(await fs.readFile(bundle.path)).toString('utf-8')

    expect(archiveText).toContain('LATEST_FAILURE_MARKER')
    expect(archiveText).not.toContain(secret)
  })

  test('keeps fatal startup errors visible on stderr while recording diagnostics', async () => {
    const port = await getPort()
    const serverArgs = ['bun', '--no-env-file', 'run', 'src/server/index.ts', '--host', '127.0.0.1', '--port', String(port)]
    // This spawns a *real* server, not the in-process test runner. Strip the
    // inherited NODE_ENV=test so it installs console/process capture the way a
    // production server does (capture is intentionally skipped under test).
    const env = createSandboxedTestEnvironment(tmpDir, {
      CLAUDE_CONFIG_DIR: tmpDir,
    })
    delete env.NODE_ENV
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
    const clientEventBody = await clientEventRes.json() as { ok: boolean; eventId: string }
    expect(clientEventBody.ok).toBe(true)
    expect(clientEventBody.eventId).toBeString()
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

  test('returns a server error when a client diagnostic event cannot be written', async () => {
    const recordSpy = spyOn(diagnosticsService, 'recordEvent').mockResolvedValue({
      ok: false,
      error: 'diagnostic write failed',
    })
    try {
      const request = new Request('http://localhost:3456/api/diagnostics/events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'write_probe', summary: 'boom' }),
      })
      const url = new URL(request.url)

      const response = await handleDiagnosticsApi(
        request,
        url,
        url.pathname.split('/').filter(Boolean),
      )

      expect(response.status).toBeGreaterThanOrEqual(500)
    } finally {
      recordSpy.mockRestore()
    }
  })

  test('returns a deterministic share-safe GitHub issue report', async () => {
    await fs.mkdir(path.join(tmpDir, 'cc-haha'), { recursive: true })
    await fs.writeFile(
      path.join(tmpDir, 'cc-haha', 'providers.json'),
      JSON.stringify({
        activeId: 'provider-issue-report',
        providers: [{
          id: 'provider-issue-report',
          name: 'Issue Report Provider',
          apiFormat: 'anthropic',
          baseUrl: 'https://user:pass@api.example.com/private?token=x',
          models: { main: 'main-model' },
        }],
      }),
      'utf-8',
    )
    await diagnosticsService.recordEvent({
      type: 'sdk_result_error',
      severity: 'error',
      summary: 'PRIVATE_ASSISTANT_REPLY',
      details: {
        errorCode: 'CLI_EXITED',
        status: 'failed',
        sdkMessages: [{ result: 'PRIVATE_SDK_RESULT' }],
      },
    })
    const request = makeRequest('GET', '/api/diagnostics/issue-report')

    const response = await handleDiagnosticsApi(request.req, request.url, request.segments)
    const body = await response.json() as { report: string }

    expect(response.status).toBe(200)
    expect(body.report).toContain('## 问题描述')
    expect(body.report).toContain('## 运行环境')
    expect(body.report).toContain('## Provider / 模型')
    expect(body.report).toContain('## 诊断关联')
    expect(body.report).toContain('## 复现步骤')
    expect(body.report).toContain('## 错误摘要')
    expect(body.report).toContain('CLI_EXITED')
    expect(body.report).toContain('api.example.com')
    expect(body.report).not.toContain('user:pass')
    expect(body.report).not.toContain('/private')
    expect(body.report).not.toContain('token=x')
    expect(body.report).not.toContain('PRIVATE_ASSISTANT_REPLY')
    expect(body.report).not.toContain('PRIVATE_SDK_RESULT')
  })
})
