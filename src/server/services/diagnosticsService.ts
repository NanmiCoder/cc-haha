import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { gzipSync } from 'node:zlib'
import type { Dirent } from 'node:fs'

export type DiagnosticSeverity = 'debug' | 'info' | 'warn' | 'error'

export type DiagnosticEventInput = {
  type: string
  severity?: DiagnosticSeverity
  summary: string
  sessionId?: string
  details?: unknown
}

export type DiagnosticEvent = {
  id: string
  timestamp: string
  type: string
  severity: DiagnosticSeverity
  summary: string
  sessionId?: string
  details?: unknown
}

export type DiagnosticsStatus = {
  logDir: string
  diagnosticsPath: string
  runtimeErrorsPath: string
  exportDir: string
  retentionDays: number
  maxBytes: number
  totalBytes: number
  eventCount: number
  recentErrorCount: number
  lastEventAt: string | null
}

export type DiagnosticsExportResult = {
  path: string
  fileName: string
  bytes: number
}

const RETENTION_DAYS = 7
const MAX_BYTES = 50 * 1024 * 1024
const MAX_STRING_LENGTH = 4096
const MAX_ARRAY_ITEMS = 40
const MAX_OBJECT_KEYS = 80
const MAX_EVENTS_IN_EXPORT = 5000
const SENSITIVE_KEY_RE = /(api[_-]?key|auth[_-]?token|access[_-]?token|refresh[_-]?token|session[_-]?token|\btoken\b|secret|password|authorization|cookie|oauth)/i

export class DiagnosticsService {
  private consoleCaptureInstalled = false
  private originalConsoleError: typeof console.error | null = null
  private originalConsoleWarn: typeof console.warn | null = null

  getLogDir(): string {
    return path.join(this.getConfigDir(), 'yuanclaw', 'diagnostics')
  }

  getDiagnosticsPath(): string {
    return path.join(this.getLogDir(), 'diagnostics.jsonl')
  }

  getRuntimeErrorsPath(): string {
    return path.join(this.getLogDir(), 'runtime-errors.log')
  }

  getExportDir(): string {
    return path.join(this.getLogDir(), 'exports')
  }

  async recordEvent(input: DiagnosticEventInput): Promise<void> {
    const event: DiagnosticEvent = {
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      type: input.type,
      severity: input.severity ?? 'error',
      summary: this.sanitizeString(input.summary),
      ...(input.sessionId ? { sessionId: this.sanitizeString(input.sessionId, 256) } : {}),
      ...(input.details !== undefined ? { details: this.sanitizeValue(input.details) } : {}),
    }

    try {
      await this.ensureLogDir()
      await fs.appendFile(this.getDiagnosticsPath(), JSON.stringify(event) + '\n', 'utf-8')
      if (event.severity === 'warn' || event.severity === 'error') {
        await fs.appendFile(this.getRuntimeErrorsPath(), this.formatRuntimeLogLine(event), 'utf-8')
      }
      await this.enforceRetention().catch(() => {})
    } catch {
      // Diagnostics must never break the product path.
    }
  }

  installConsoleCapture(): void {
    if (this.consoleCaptureInstalled) return
    this.consoleCaptureInstalled = true
    this.originalConsoleError = console.error.bind(console)
    this.originalConsoleWarn = console.warn.bind(console)

    console.error = (...args: unknown[]) => {
      this.originalConsoleError?.(...args)
      void this.recordEvent({
        type: 'console_error',
        severity: 'error',
        summary: this.formatConsoleArgs(args),
      })
    }

    console.warn = (...args: unknown[]) => {
      this.originalConsoleWarn?.(...args)
      void this.recordEvent({
        type: 'console_warn',
        severity: 'warn',
        summary: this.formatConsoleArgs(args),
      })
    }
  }

  restoreConsoleCaptureForTests(): void {
    if (this.originalConsoleError) console.error = this.originalConsoleError
    if (this.originalConsoleWarn) console.warn = this.originalConsoleWarn
    this.consoleCaptureInstalled = false
    this.originalConsoleError = null
    this.originalConsoleWarn = null
  }

  async getStatus(): Promise<DiagnosticsStatus> {
    await this.ensureLogDir()
    const events = await this.readRecentEvents(500)
    const totalBytes = await this.getDirectorySize(this.getLogDir())
    const cutoff = Date.now() - 24 * 60 * 60 * 1000
    return {
      logDir: this.getLogDir(),
      diagnosticsPath: this.getDiagnosticsPath(),
      runtimeErrorsPath: this.getRuntimeErrorsPath(),
      exportDir: this.getExportDir(),
      retentionDays: RETENTION_DAYS,
      maxBytes: MAX_BYTES,
      totalBytes,
      eventCount: events.length,
      recentErrorCount: events.filter((event) =>
        (event.severity === 'error' || event.severity === 'warn') &&
        Date.parse(event.timestamp) >= cutoff
      ).length,
      lastEventAt: events[0]?.timestamp ?? null,
    }
  }

  async readRecentEvents(limit = 100): Promise<DiagnosticEvent[]> {
    const boundedLimit = Math.max(1, Math.min(limit, 1000))
    let raw = ''
    try {
      raw = await fs.readFile(this.getDiagnosticsPath(), 'utf-8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw err
    }

    return raw
      .split('\n')
      .filter(Boolean)
      .slice(-boundedLimit)
      .map((line) => {
        try {
          return JSON.parse(line) as DiagnosticEvent
        } catch {
          return null
        }
      })
      .filter((event): event is DiagnosticEvent => event !== null)
      .reverse()
  }

  async exportBundle(): Promise<DiagnosticsExportResult> {
    await this.ensureLogDir()
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
    const fileName = `yuanclaw-diagnostics-${timestamp}.tar.gz`
    const outPath = path.join(this.getExportDir(), fileName)
    const events = await this.readRecentEvents(MAX_EVENTS_IN_EXPORT)
    const files = [
      {
        name: 'README.txt',
        content: this.buildReadme(),
      },
      {
        name: 'app-info.json',
        content: JSON.stringify(this.buildAppInfo(), null, 2) + '\n',
      },
      {
        name: 'diagnostics.jsonl',
        content: events.map((event) => JSON.stringify(this.sanitizeValue(event))).join('\n') + (events.length ? '\n' : ''),
      },
      {
        name: 'runtime-errors.log',
        content: await this.readSanitizedTextFile(this.getRuntimeErrorsPath()),
      },
      {
        name: 'providers-summary.json',
        content: JSON.stringify(await this.buildProvidersSummary(), null, 2) + '\n',
      },
      {
        name: 'sessions-summary.json',
        content: JSON.stringify(this.buildSessionsSummary(events), null, 2) + '\n',
      },
    ]

    const archive = this.createTarGz(files)
    await fs.mkdir(this.getExportDir(), { recursive: true })
    await fs.writeFile(outPath, archive)
    return { path: outPath, fileName, bytes: archive.byteLength }
  }

  async openLogDir(): Promise<void> {
    await this.ensureLogDir()
    const dir = this.getLogDir()
    if (process.platform === 'darwin') {
      Bun.spawn(['open', dir], { stdout: 'ignore', stderr: 'ignore' })
      return
    }
    if (process.platform === 'win32') {
      Bun.spawn(['cmd', '/c', 'start', '', dir], { stdout: 'ignore', stderr: 'ignore' })
      return
    }
    Bun.spawn(['xdg-open', dir], { stdout: 'ignore', stderr: 'ignore' })
  }

  async clear(): Promise<void> {
    await fs.rm(this.getLogDir(), { recursive: true, force: true })
    await this.ensureLogDir()
  }

  sanitizeValue(value: unknown, depth = 0): unknown {
    if (depth > 6) return '[TRUNCATED_DEPTH]'
    if (value === null || value === undefined) return value
    if (typeof value === 'string') return this.sanitizeString(value)
    if (typeof value === 'number' || typeof value === 'boolean') return value
    if (typeof value === 'bigint') return value.toString()
    if (value instanceof Error) {
      return {
        name: value.name,
        message: this.sanitizeString(value.message),
        stack: value.stack ? this.sanitizeString(value.stack) : undefined,
      }
    }
    if (Array.isArray(value)) {
      return value.slice(0, MAX_ARRAY_ITEMS).map((entry) => this.sanitizeValue(entry, depth + 1))
    }
    if (typeof value === 'object') {
      const result: Record<string, unknown> = {}
      let count = 0
      for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
        if (count >= MAX_OBJECT_KEYS) {
          result.__truncatedKeys = true
          break
        }
        count += 1
        result[key] = SENSITIVE_KEY_RE.test(key)
          ? '[REDACTED]'
          : this.sanitizeValue(entry, depth + 1)
      }
      return result
    }
    return String(value)
  }

  sanitizeString(value: string, maxLength = MAX_STRING_LENGTH): string {
    let sanitized = value
      .replace(/(Bearer\s+)[A-Za-z0-9._~+/-]+/gi, '$1[REDACTED]')
      .replace(/((?:api[_-]?key|auth[_-]?token|access[_-]?token|refresh[_-]?token|session[_-]?token|token|secret|password)\s*[:=]\s*)[^\s,;"'}]+/gi, '$1[REDACTED]')
      .replace(/(ANTHROPIC_(?:API_KEY|AUTH_TOKEN)\s*[:=]\s*)[^\s,;"'}]+/gi, '$1[REDACTED]')
      .replace(/([?&](?:api[_-]?key|token|auth|access_token|refresh_token|key)=)[^&\s]+/gi, '$1[REDACTED]')

    const home = os.homedir()
    if (home && sanitized.includes(home)) {
      sanitized = sanitized.split(home).join('~')
    }

    if (sanitized.length > maxLength) {
      return `${sanitized.slice(0, maxLength)}...[TRUNCATED ${sanitized.length - maxLength} chars]`
    }
    return sanitized
  }

  private async ensureLogDir(): Promise<void> {
    await fs.mkdir(this.getExportDir(), { recursive: true })
  }

  private getConfigDir(): string {
    return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
  }

  private formatConsoleArgs(args: unknown[]): string {
    return this.sanitizeString(args.map((arg) => {
      if (arg instanceof Error) return `${arg.name}: ${arg.message}\n${arg.stack ?? ''}`
      if (typeof arg === 'string') return arg
      try {
        return JSON.stringify(this.sanitizeValue(arg))
      } catch {
        return String(arg)
      }
    }).join(' '))
  }

  private formatRuntimeLogLine(event: DiagnosticEvent): string {
    return `[${event.timestamp}] ${event.severity.toUpperCase()} ${event.type}${event.sessionId ? ` session=${event.sessionId}` : ''}: ${event.summary}\n`
  }

  private buildReadme(): string {
    return [
      'yuanclaw diagnostics bundle',
      '',
      'This bundle is generated by the desktop app for debugging server and CLI startup/runtime failures.',
      'It intentionally excludes chat prompts, assistant replies, file contents, attachments, full environment variables, API keys, bearer tokens, cookies, and OAuth tokens.',
      'Paths under the current home directory are normalized to "~". Long fields are truncated.',
      '',
      'Files:',
      '- app-info.json: runtime and platform summary.',
      '- diagnostics.jsonl: sanitized structured diagnostic events.',
      '- runtime-errors.log: sanitized warning/error summaries.',
      '- providers-summary.json: provider count, active id, base URL host, model ids, and API format without API keys.',
      '- sessions-summary.json: session ids observed in diagnostic events, without transcript content.',
      '',
    ].join('\n')
  }

  private buildAppInfo(): Record<string, unknown> {
    return this.sanitizeValue({
      appVersion: process.env.APP_VERSION || '999.0.0-local',
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      bun: typeof Bun !== 'undefined' ? Bun.version : null,
      cwd: process.cwd(),
      uptimeSeconds: Math.round(process.uptime()),
      generatedAt: new Date().toISOString(),
    }) as Record<string, unknown>
  }

  private async buildProvidersSummary(): Promise<Record<string, unknown>> {
    const providerPath = path.join(this.getConfigDir(), 'yuanclaw', 'providers.json')
    try {
      const raw = await fs.readFile(providerPath, 'utf-8')
      const parsed = JSON.parse(raw) as {
        activeId?: string | null
        providers?: Array<Record<string, unknown>>
      }
      return {
        activeId: parsed.activeId ?? null,
        count: Array.isArray(parsed.providers) ? parsed.providers.length : 0,
        providers: (parsed.providers ?? []).map((provider) => ({
          id: provider.id,
          name: provider.name,
          presetId: provider.presetId,
          apiFormat: provider.apiFormat,
          baseUrl: this.summarizeUrl(typeof provider.baseUrl === 'string' ? provider.baseUrl : ''),
          models: provider.models,
        })),
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return { activeId: null, count: 0, providers: [] }
      }
      return { error: this.sanitizeString(err instanceof Error ? err.message : String(err)) }
    }
  }

  private summarizeUrl(value: string): Record<string, string> | null {
    if (!value.trim()) return null
    try {
      const url = new URL(value)
      return { protocol: url.protocol, host: url.host, pathname: url.pathname }
    } catch {
      return { value: this.sanitizeString(value, 512) }
    }
  }

  private buildSessionsSummary(events: DiagnosticEvent[]): Record<string, unknown> {
    const sessions = new Map<string, { eventCount: number; lastEventAt: string; severities: Set<DiagnosticSeverity> }>()
    for (const event of events) {
      if (!event.sessionId) continue
      const current = sessions.get(event.sessionId) ?? {
        eventCount: 0,
        lastEventAt: event.timestamp,
        severities: new Set<DiagnosticSeverity>(),
      }
      current.eventCount += 1
      current.lastEventAt = current.lastEventAt > event.timestamp ? current.lastEventAt : event.timestamp
      current.severities.add(event.severity)
      sessions.set(event.sessionId, current)
    }
    return {
      count: sessions.size,
      sessions: [...sessions.entries()].map(([sessionId, info]) => ({
        sessionId,
        eventCount: info.eventCount,
        lastEventAt: info.lastEventAt,
        severities: [...info.severities],
      })),
      transcriptContentIncluded: false,
    }
  }

  private async readSanitizedTextFile(filePath: string): Promise<string> {
    try {
      return this.sanitizeString(await fs.readFile(filePath, 'utf-8'), 2 * MAX_STRING_LENGTH)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return ''
      throw err
    }
  }

  private async enforceRetention(): Promise<void> {
    const dir = this.getLogDir()
    const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000
    const files = await this.listFiles(dir)

    for (const file of files) {
      if (file.mtimeMs < cutoff) {
        await fs.rm(file.path, { force: true })
      }
    }

    const remaining = (await this.listFiles(dir)).sort((a, b) => a.mtimeMs - b.mtimeMs)
    let total = remaining.reduce((sum, file) => sum + file.size, 0)
    for (const file of remaining) {
      if (total <= MAX_BYTES) break
      await fs.rm(file.path, { force: true })
      total -= file.size
    }
  }

  private async getDirectorySize(dir: string): Promise<number> {
    return (await this.listFiles(dir)).reduce((sum, file) => sum + file.size, 0)
  }

  private async listFiles(dir: string): Promise<Array<{ path: string; size: number; mtimeMs: number }>> {
    const results: Array<{ path: string; size: number; mtimeMs: number }> = []
    let entries: Dirent[]
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw err
    }

    for (const entry of entries) {
      const filePath = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        results.push(...await this.listFiles(filePath))
        continue
      }
      if (!entry.isFile()) continue
      const stat = await fs.stat(filePath)
      results.push({ path: filePath, size: stat.size, mtimeMs: stat.mtimeMs })
    }
    return results
  }

  private createTarGz(files: Array<{ name: string; content: string }>): Buffer {
    const chunks: Buffer[] = []
    const mtime = Math.floor(Date.now() / 1000)
    for (const file of files) {
      const body = Buffer.from(file.content, 'utf-8')
      chunks.push(this.createTarHeader(file.name, body.byteLength, mtime))
      chunks.push(body)
      const padding = (512 - (body.byteLength % 512)) % 512
      if (padding > 0) chunks.push(Buffer.alloc(padding))
    }
    chunks.push(Buffer.alloc(1024))
    return gzipSync(Buffer.concat(chunks))
  }

  private createTarHeader(name: string, size: number, mtime: number): Buffer {
    const header = Buffer.alloc(512)
    this.writeTarString(header, 0, 100, name)
    this.writeTarString(header, 100, 8, '0000644')
    this.writeTarString(header, 108, 8, '0000000')
    this.writeTarString(header, 116, 8, '0000000')
    this.writeTarOctal(header, 124, 12, size)
    this.writeTarOctal(header, 136, 12, mtime)
    header.fill(0x20, 148, 156)
    header[156] = '0'.charCodeAt(0)
    this.writeTarString(header, 257, 6, 'ustar')
    this.writeTarString(header, 263, 2, '00')

    let checksum = 0
    for (const byte of header) checksum += byte
    const checksumValue = checksum.toString(8).padStart(6, '0')
    header.write(checksumValue.slice(-6), 148, 6, 'ascii')
    header[154] = 0
    header[155] = 0x20
    return header
  }

  private writeTarString(header: Buffer, offset: number, length: number, value: string): void {
    header.write(value.slice(0, length), offset, length, 'utf-8')
  }

  private writeTarOctal(header: Buffer, offset: number, length: number, value: number): void {
    const encoded = value.toString(8).padStart(length - 1, '0')
    header.write(encoded.slice(-length + 1), offset, length - 1, 'ascii')
    header[offset + length - 1] = 0
  }
}

export const diagnosticsService = new DiagnosticsService()
