import * as fs from 'node:fs/promises'
import { createHash } from 'node:crypto'
import * as os from 'node:os'
import * as path from 'node:path'
import { gzipSync } from 'node:zlib'
import type { Dirent } from 'node:fs'
import {
  buildDiagnosticsIssueReport,
  projectDiagnosticEventForSharing,
  type SharedDiagnosticEvent,
} from './diagnosticsShare.js'

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
  cliDiagnosticsPath: string
  runtimeErrorsPath: string
  electronHostPath: string
  exportDir: string
  retentionDays: number
  maxBytes: number
  totalBytes: number
  storageLimitExceeded: boolean
  eventCount: number
  physicalLineCount: number
  corruptLineCount: number
  recentErrorCount: number
  lastEventAt: string | null
}

export type DiagnosticWriteResult =
  | { ok: true; event: DiagnosticEvent }
  | { ok: false; error: string }

type DiagnosticsScanResult = {
  events: DiagnosticEvent[]
  physicalLineCount: number
  corruptLineCount: number
  rawCorruptLineCount: number
  sourceBytes: number
  sourceDigest: string
}

type PendingCorruptionEvidence = {
  corruptLineCount: number
  sourceBytes: number
  sourceDigest: string
}

export type DiagnosticsExportResult = {
  path: string
  fileName: string
  bytes: number
}

const RETENTION_DAYS = 7
const MAX_BYTES = 50 * 1024 * 1024
const MAX_DIAGNOSTICS_BYTES = 20 * 1024 * 1024
const MAX_AUXILIARY_LOG_BYTES = 5 * 1024 * 1024
const MAX_CLI_COMPLETED_SEGMENTS_BYTES = 5 * 1024 * 1024
const MAX_EXPORT_DIRECTORY_BYTES = 14 * 1024 * 1024
const MAX_SHARED_EVENTS = 5_000
const MAX_ISSUE_REPORT_EVENTS = 100
const MAX_STRING_LENGTH = 4096
const MAX_TEXT_FILE_EXPORT_LENGTH = 256 * 1024
const MAX_ARRAY_ITEMS = 40
const MAX_OBJECT_KEYS = 80
const RETENTION_SWEEP_INTERVAL_MS = 60 * 1000
const TRUNCATED_OLDER_CONTENT_MARKER = '[TRUNCATED OLDER CONTENT]\n'
const SENSITIVE_KEY_RE = /(api[_-]?key|auth[_-]?token|access[_-]?token|refresh[_-]?token|session[_-]?token|\btoken\b|secret|password|authorization|cookie|oauth)/i

export class DiagnosticsService {
  private consoleCaptureInstalled = false
  private processCaptureInstalled = false
  private originalConsoleError: typeof console.error | null = null
  private originalConsoleWarn: typeof console.warn | null = null
  private lastRetentionSweepAt = 0
  private writeQueue: Promise<void> = Promise.resolve()

  getLogDir(): string {
    return path.join(this.getConfigDir(), 'cc-haha', 'diagnostics')
  }

  getDiagnosticsPath(): string {
    return path.join(this.getLogDir(), 'diagnostics.jsonl')
  }

  getCliDiagnosticsPath(): string {
    return path.join(this.getLogDir(), 'cli-diagnostics.jsonl')
  }

  getRuntimeErrorsPath(): string {
    return path.join(this.getLogDir(), 'runtime-errors.log')
  }

  getElectronHostPath(): string {
    return path.join(this.getLogDir(), 'electron-host.log')
  }

  private getCorruptionEvidencePath(): string {
    return path.join(this.getLogDir(), 'corruption-evidence.json')
  }

  private getPendingCorruptionEvidencePath(): string {
    return path.join(this.getLogDir(), 'corruption-evidence.pending.json')
  }

  getExportDir(): string {
    return path.join(this.getLogDir(), 'exports')
  }

  async recordEvent(input: DiagnosticEventInput): Promise<DiagnosticWriteResult> {
    // Test isolation: never let a test run write into the user's real
    // ~/.claude/cc-haha/diagnostics. Tests that genuinely exercise diagnostics
    // set CLAUDE_CONFIG_DIR to a tmp dir; anything else under NODE_ENV=test is
    // a leak (e.g. a fire-and-forget recordEvent resolving after a test's
    // afterEach restored CLAUDE_CONFIG_DIR) and must be dropped.
    if (process.env.NODE_ENV === 'test' && !process.env.CLAUDE_CONFIG_DIR) {
      return { ok: false, error: 'Diagnostics are disabled without an isolated config directory during tests' }
    }

    const event: DiagnosticEvent = {
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      type: input.type,
      // Default to 'info', not 'error': an unclassified event is not evidence
      // of a failure. Only callers that know something went wrong pass 'error'.
      severity: input.severity ?? 'info',
      summary: this.sanitizeString(input.summary),
      ...(input.sessionId ? { sessionId: this.sanitizeString(input.sessionId, 256) } : {}),
      ...(input.details !== undefined ? { details: this.sanitizeValue(input.details) } : {}),
    }

    const operation = this.writeQueue.then(() => this.writeEvent(event))
    this.writeQueue = operation.then(() => undefined, () => undefined)
    return operation
  }

  private async writeEvent(event: DiagnosticEvent): Promise<DiagnosticWriteResult> {
    try {
      await this.ensureLogDir()
      await fs.appendFile(this.getDiagnosticsPath(), JSON.stringify(event) + '\n', 'utf-8')
      if (event.severity === 'warn' || event.severity === 'error') {
        await fs.appendFile(this.getRuntimeErrorsPath(), this.formatRuntimeLogEntry(event), 'utf-8')
      }
      await this.enforceRetention().catch(() => {})
      return { ok: true, event }
    } catch (error) {
      // Diagnostics must never break the product path.
      return { ok: false, error: this.sanitizeWriteError(error) }
    }
  }

  /**
   * Mirror console.error / console.warn into the diagnostics stream.
   *
   * Contract for callers across the codebase: console.error means "error" and
   * console.warn means "warn" in the diagnostics panel. An expected, gracefully
   * handled state (token expiry, normal process shutdown, streaming partials,
   * recovered fallbacks) is NOT an error — log those with console.debug /
   * console.info / console.log, which are intentionally not captured here.
   * Otherwise the panel fills with red noise and real failures get buried.
   */
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

  installProcessCapture(): void {
    if (this.processCaptureInstalled) return
    this.processCaptureInstalled = true

    process.on('uncaughtException', (error) => {
      this.writeProcessFailureToStderr('Uncaught exception', error)
      const fallbackExit = setTimeout(() => process.exit(1), 1000)
      fallbackExit.unref?.()
      void this.recordEvent({
        type: 'server_uncaught_exception',
        severity: 'error',
        summary: error.message || 'Uncaught exception',
        details: { error },
      }).finally(() => process.exit(1))
    })

    process.on('unhandledRejection', (reason) => {
      this.writeProcessFailureToStderr('Unhandled rejection', reason)
      void this.recordEvent({
        type: 'server_unhandled_rejection',
        severity: 'error',
        summary: this.formatUnknownReason(reason),
        details: { reason },
      })
    })
  }

  async getStatus(): Promise<DiagnosticsStatus> {
    await this.ensureLogDir()
    await this.runRetentionSerialized(true, false)
    const scan = await this.scanDiagnosticsFile()
    const events = scan.events
    const totalBytes = await this.getDirectorySize(this.getLogDir())
    const cutoff = Date.now() - 24 * 60 * 60 * 1000
    return {
      logDir: this.getLogDir(),
      diagnosticsPath: this.getDiagnosticsPath(),
      cliDiagnosticsPath: this.getCliDiagnosticsPath(),
      runtimeErrorsPath: this.getRuntimeErrorsPath(),
      electronHostPath: this.getElectronHostPath(),
      exportDir: this.getExportDir(),
      retentionDays: RETENTION_DAYS,
      maxBytes: MAX_BYTES,
      totalBytes,
      storageLimitExceeded: totalBytes > MAX_BYTES || await this.isManagedSurfaceOverLimit(),
      eventCount: events.length,
      physicalLineCount: scan.physicalLineCount,
      corruptLineCount: scan.corruptLineCount,
      recentErrorCount: events.filter((event) =>
        (event.severity === 'error' || event.severity === 'warn') &&
        Date.parse(event.timestamp) >= cutoff
      ).length,
      lastEventAt: events.at(-1)?.timestamp ?? null,
    }
  }

  async readRecentEvents(limit = 100): Promise<DiagnosticEvent[]> {
    const boundedLimit = Math.max(1, Math.min(limit, 1000))
    const scan = await this.scanDiagnosticsFile()
    return scan.events.slice(-boundedLimit).reverse()
  }

  private async scanDiagnosticsFile(): Promise<DiagnosticsScanResult> {
    let raw = ''
    try {
      raw = await fs.readFile(this.getDiagnosticsPath(), 'utf-8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        const persistedCorruptLineCount = await this.readPersistedCorruptLineCount()
        return {
          events: [],
          physicalLineCount: 0,
          corruptLineCount: persistedCorruptLineCount,
          rawCorruptLineCount: 0,
          sourceBytes: 0,
          sourceDigest: this.hashBuffer(Buffer.alloc(0)),
        }
      }
      throw err
    }

    const lines = raw.length === 0 ? [] : raw.split('\n')
    if (raw.endsWith('\n')) lines.pop()
    const events: DiagnosticEvent[] = []
    let corruptLineCount = 0
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line) as unknown
        if (!this.isDiagnosticEvent(parsed)) {
          corruptLineCount += 1
          continue
        }
        events.push(parsed)
      } catch {
        corruptLineCount += 1
      }
    }
    const sourceBuffer = Buffer.from(raw, 'utf-8')
    const persistedCorruptLineCount = await this.readPersistedCorruptLineCount(sourceBuffer, corruptLineCount)
    return {
      events,
      physicalLineCount: lines.length,
      corruptLineCount: persistedCorruptLineCount + corruptLineCount,
      rawCorruptLineCount: corruptLineCount,
      sourceBytes: sourceBuffer.byteLength,
      sourceDigest: this.hashBuffer(sourceBuffer),
    }
  }

  async exportBundle(): Promise<DiagnosticsExportResult> {
    await this.ensureLogDir()
    await this.runRetentionSerialized(true, true)
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
    const fileName = `cc-haha-diagnostics-${timestamp}.tar.gz`
    const outPath = path.join(this.getExportDir(), fileName)
    const scan = await this.scanDiagnosticsFile()
    const events = scan.events.slice(-MAX_SHARED_EVENTS).reverse()
    const sharedEvents = events.map(projectDiagnosticEventForSharing)
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
        content: sharedEvents.map((event) => JSON.stringify(event)).join('\n') + (sharedEvents.length ? '\n' : ''),
      },
      {
        name: 'recent-errors.md',
        content: this.buildRecentErrorsSummary(sharedEvents),
      },
      {
        name: 'runtime-errors.log',
        content: this.buildSharedRuntimeLog(sharedEvents),
      },
      {
        name: 'cli-diagnostics.jsonl',
        content: await this.readCliDiagnosticsForSharing(MAX_TEXT_FILE_EXPORT_LENGTH),
      },
      {
        name: 'electron-host.log',
        content: await this.readSanitizedTextFile(this.getElectronHostPath(), MAX_TEXT_FILE_EXPORT_LENGTH),
      },
      {
        name: 'providers-summary.json',
        content: JSON.stringify(await this.buildProvidersSummary(), null, 2) + '\n',
      },
      {
        name: 'sessions-summary.json',
        content: JSON.stringify(this.buildSessionsSummary(sharedEvents), null, 2) + '\n',
      },
    ]

    const archive = this.createTarGz(files)
    await fs.mkdir(this.getExportDir(), { recursive: true })
    await fs.writeFile(outPath, archive)
    await this.enforceExportRetention(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000)
    return { path: outPath, fileName, bytes: archive.byteLength }
  }

  async buildIssueReport(): Promise<string> {
    await this.ensureLogDir()
    await this.runRetentionSerialized(true, true)
    const scan = await this.scanDiagnosticsFile()
    return buildDiagnosticsIssueReport({
      generatedAt: new Date().toISOString(),
      appInfo: this.buildAppInfo(),
      providersSummary: await this.buildProvidersSummary(),
      events: scan.events.slice(-MAX_ISSUE_REPORT_EVENTS).reverse().map(projectDiagnosticEventForSharing),
      corruptLineCount: scan.corruptLineCount,
    })
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
      .replace(/([a-z][a-z0-9+.-]*:\/\/)([^/?#\s:@]+(?::[^/?#\s@]*)?@)/gi, '$1[REDACTED]@')
      .replace(/((?:api[_-]?key|auth[_-]?token|access[_-]?token|refresh[_-]?token|session[_-]?token|token|secret|password)\s*[:=]\s*)[^\s,;"'}]+/gi, '$1[REDACTED]')
      .replace(/(ANTHROPIC_(?:API_KEY|AUTH_TOKEN)\s*[:=]\s*)[^\s,;"'}]+/gi, '$1[REDACTED]')
      .replace(/([?&](?:api[_-]?key|token|auth|access_token|refresh_token|key)=)[^&\s]+/gi, '$1[REDACTED]')
      .replace(/\bAKIA[A-Z0-9]{16}\b/g, '[REDACTED_AWS_ACCESS_KEY]')
      .replace(/(?:\/Users|\/home|\/private|\/var\/folders|\/tmp)\/[^\s"'`]+/g, '[REDACTED_PATH]')
      .replace(/\b[A-Z]:\\(?:[^\s"'`]+\\)*[^\s"'`]*/gi, '[REDACTED_PATH]')

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

  private formatUnknownReason(reason: unknown): string {
    if (reason instanceof Error) return reason.message || reason.name
    if (typeof reason === 'string') return this.sanitizeString(reason)
    try {
      return this.sanitizeString(JSON.stringify(this.sanitizeValue(reason)))
    } catch {
      return this.sanitizeString(String(reason))
    }
  }

  private writeProcessFailureToStderr(label: string, reason: unknown): void {
    if (reason instanceof Error && reason.stack) {
      process.stderr.write(`[Server] ${label}:\n${reason.stack}\n`)
      return
    }
    const summary = reason instanceof Error
      ? `${reason.name}: ${reason.message}`
      : this.formatUnknownReason(reason)
    process.stderr.write(`[Server] ${label}: ${summary}\n`)
  }

  private formatRuntimeLogEntry(event: DiagnosticEvent): string {
    const lines = [
      `[${event.timestamp}] ${event.severity.toUpperCase()} ${event.type}${event.sessionId ? ` session=${event.sessionId}` : ''}`,
      `summary: ${event.summary}`,
    ]
    if (event.details !== undefined) {
      lines.push('details:')
      lines.push(JSON.stringify(event.details, null, 2))
    }
    return `${lines.join('\n')}\n\n`
  }

  private buildReadme(): string {
    return [
      'cc-haha diagnostics bundle',
      '',
      'This bundle is generated by the desktop app for debugging server and CLI startup/runtime failures.',
      'Content-bearing fields are omitted and secrets/personal data receive best-effort redaction.',
      'Included metadata may contain event ids, timestamps, event types, severity, session ids, error codes/status, provider/model identifiers, and provider hostnames.',
      'Paths under the current home directory are normalized to "~". Long fields are truncated.',
      'Review every file before sharing because automated redaction cannot guarantee removal of all sensitive data.',
      '',
      'Files:',
      '- app-info.json: runtime and platform summary.',
      '- diagnostics.jsonl: sanitized structured diagnostic events.',
      '- recent-errors.md: human-readable warning/error timeline for GitHub issues.',
      '- runtime-errors.log: warning/error timeline with projected diagnostic metadata/details.',
      '- cli-diagnostics.jsonl: sanitized no-PII CLI internal diagnostics emitted by the child process.',
      '- electron-host.log: sanitized recent Electron host lifecycle diagnostics.',
      '- providers-summary.json: provider count, active id, base URL host, model ids, and API format without API keys.',
      '- sessions-summary.json: session ids observed in diagnostic events, without transcript content.',
      '',
    ].join('\n')
  }

  private buildRecentErrorsSummary(events: SharedDiagnosticEvent[]): string {
    const errorEvents = events
      .filter((event) => event.severity === 'error' || event.severity === 'warn')
      .slice(0, 50)

    const lines = [
      '# cc-haha recent diagnostics',
      '',
      `Generated: ${new Date().toISOString()}`,
      `Events included: ${errorEvents.length}`,
      '',
    ]

    if (errorEvents.length === 0) {
      lines.push('No recent warnings or errors were recorded.')
      lines.push('')
      return lines.join('\n')
    }

    for (const event of errorEvents) {
      lines.push(`## ${event.timestamp} ${event.severity.toUpperCase()} ${event.type}`)
      if (event.sessionId) lines.push(`session: ${event.sessionId}`)
      lines.push('')
      if (event.details !== undefined) {
        lines.push('')
        lines.push('```json')
        lines.push(JSON.stringify(event.details, null, 2))
        lines.push('```')
      }
      lines.push('')
    }

    return lines.join('\n')
  }

  private buildSharedRuntimeLog(events: SharedDiagnosticEvent[]): string {
    const errorEvents = events.filter((event) => event.severity === 'error' || event.severity === 'warn')
    return errorEvents
      .map((event) => {
        const lines = [
          `[${event.timestamp}] ${event.severity.toUpperCase()} ${event.type}${event.sessionId ? ` session=${event.sessionId}` : ''}`,
        ]
        if (event.details !== undefined) lines.push(JSON.stringify(event.details, null, 2))
        if (event.omittedFields.length > 0) lines.push(`omittedFields: ${event.omittedFields.join(', ')}`)
        return lines.join('\n')
      })
      .join('\n\n') + (errorEvents.length > 0 ? '\n' : '')
  }

  private buildAppInfo(): Record<string, unknown> {
    return this.sanitizeValue({
      appVersion: process.env.APP_VERSION || '999.0.0-local',
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      bun: typeof Bun !== 'undefined' ? Bun.version : null,
      uptimeSeconds: Math.round(process.uptime()),
      generatedAt: new Date().toISOString(),
    }) as Record<string, unknown>
  }

  private async buildProvidersSummary(): Promise<Record<string, unknown>> {
    const providerPath = path.join(this.getConfigDir(), 'cc-haha', 'providers.json')
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
      return { hostname: url.hostname }
    } catch {
      return null
    }
  }

  private buildSessionsSummary(events: SharedDiagnosticEvent[]): Record<string, unknown> {
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

  private async readSanitizedTextFile(
    filePath: string,
    maxLength = 2 * MAX_STRING_LENGTH,
  ): Promise<string> {
    let file: fs.FileHandle | undefined
    try {
      file = await fs.open(filePath, 'r')
      const stat = await file.stat()
      if (stat.size <= maxLength) {
        return this.sanitizeString(await file.readFile('utf-8'), maxLength)
      }

      const readLength = Math.min(stat.size, maxLength + MAX_STRING_LENGTH)
      const start = stat.size - readLength
      const buffer = Buffer.alloc(readLength)
      await file.read(buffer, 0, readLength, start)
      let rawTail = buffer.toString('utf-8')
      if (start > 0) {
        const firstCompleteLine = rawTail.indexOf('\n')
        rawTail = firstCompleteLine === -1 ? '' : rawTail.slice(firstCompleteLine + 1)
      }
      const sanitizedTail = this.sanitizeString(rawTail, Number.MAX_SAFE_INTEGER)
      return TRUNCATED_OLDER_CONTENT_MARKER + sanitizedTail.slice(-maxLength)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return ''
      throw err
    } finally {
      await file?.close()
    }
  }

  private async readCliDiagnosticsForSharing(maxLength: number): Promise<string> {
    const baseName = path.basename(this.getCliDiagnosticsPath())
    const successfullyReadPaths = new Set<string>()
    const seenContentDigests = new Set<string>()
    const chunks: string[] = []
    // A writer may atomically rotate current -> completed between listing and
    // opening. Re-list a fixed number of times so the moved inode is normally
    // picked up under its new name without ever locking or mutating it.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const files = (await this.listFiles(this.getLogDir()))
        .filter((file) => path.dirname(file.path) === this.getLogDir())
        .filter((file) => {
          const name = path.basename(file.path)
          return name === baseName || (name.startsWith(`${baseName}.`) && name.endsWith('.jsonl'))
        })
        .sort((left, right) => left.mtimeMs - right.mtimeMs)
      for (const file of files) {
        if (successfullyReadPaths.has(file.path)) continue
        const content = await this.readSanitizedTextFile(file.path, maxLength)
        if (!content) continue
        successfullyReadPaths.add(file.path)
        const digest = this.hashBuffer(Buffer.from(content, 'utf-8'))
        if (seenContentDigests.has(digest)) continue
        seenContentDigests.add(digest)
        chunks.push(content)
      }
    }
    const combined = chunks.join('')
    return combined.length > maxLength
      ? TRUNCATED_OLDER_CONTENT_MARKER + combined.slice(-maxLength)
      : combined
  }

  private async runRetentionSerialized(force: boolean, compactStructured: boolean): Promise<void> {
    const operation = this.writeQueue.then(() => this.enforceRetention(force, compactStructured))
    this.writeQueue = operation.then(() => undefined, () => undefined)
    await operation
  }

  private async enforceRetention(force = false, compactStructured = true): Promise<void> {
    const diagnosticsPath = this.getDiagnosticsPath()
    const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000
    const stat = await fs.stat(diagnosticsPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null
      throw error
    })
    const forceCompaction = (stat?.size ?? 0) > MAX_DIAGNOSTICS_BYTES
    const now = Date.now()
    if (!force && !forceCompaction && now - this.lastRetentionSweepAt < RETENTION_SWEEP_INTERVAL_MS) return
    if (stat) {
      const scan = await this.scanDiagnosticsFile()
      const hasStaleEvent = scan.events.some((event) => Date.parse(event.timestamp) < cutoff)
      if (compactStructured || forceCompaction || hasStaleEvent) {
        if (scan.rawCorruptLineCount > 0) {
          await this.writePendingCorruptLineCount({
            corruptLineCount: scan.corruptLineCount,
            sourceBytes: scan.sourceBytes,
            sourceDigest: scan.sourceDigest,
          })
        }
        const retained = scan.events
          .filter((event) => Date.parse(event.timestamp) >= cutoff)
          .sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp))
        const newestLinesThatFit = this.keepNewestCompleteLinesWithinBytes(retained, MAX_DIAGNOSTICS_BYTES)
        await this.rewriteDiagnosticsAtomically(newestLinesThatFit)
        if (scan.rawCorruptLineCount > 0) await this.commitPendingCorruptLineCount()
      }
    }

    await Promise.all([
      this.truncateTextFileToTail(this.getRuntimeErrorsPath(), MAX_AUXILIARY_LOG_BYTES),
      this.truncateTextFileToTail(this.getElectronHostPath(), MAX_AUXILIARY_LOG_BYTES),
      this.enforceCliCompletedSegmentRetention(cutoff),
    ])
    await this.enforceExportRetention(cutoff)
    this.lastRetentionSweepAt = now
  }

  private async readPersistedCorruptLineCount(
    sourceBuffer = Buffer.alloc(0),
    rawCorruptLineCount = 0,
  ): Promise<number> {
    let committed = 0
    try {
      const parsed = JSON.parse(await fs.readFile(this.getCorruptionEvidencePath(), 'utf-8')) as unknown
      if (parsed && typeof parsed === 'object') {
        const count = (parsed as Record<string, unknown>).corruptLineCount
        committed = typeof count === 'number' && Number.isSafeInteger(count) && count >= 0 ? count : 0
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error
    }
    const pending = await this.readPendingCorruptEvidence()
    if (!pending) return committed
    const pendingSourceStillPresent = sourceBuffer.byteLength >= pending.sourceBytes &&
      this.hashBuffer(sourceBuffer.subarray(0, pending.sourceBytes)) === pending.sourceDigest
    if (rawCorruptLineCount > 0 && pendingSourceStillPresent) return committed
    return Math.max(committed, pending.corruptLineCount)
  }

  private async readPendingCorruptEvidence(): Promise<PendingCorruptionEvidence | null> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.getPendingCorruptionEvidencePath(), 'utf-8')) as unknown
      if (!parsed || typeof parsed !== 'object') return null
      const record = parsed as Record<string, unknown>
      return typeof record.corruptLineCount === 'number' && Number.isSafeInteger(record.corruptLineCount) && record.corruptLineCount >= 0 &&
        typeof record.sourceBytes === 'number' && Number.isSafeInteger(record.sourceBytes) && record.sourceBytes >= 0 &&
        typeof record.sourceDigest === 'string'
        ? record as PendingCorruptionEvidence
        : null
    } catch {
      return null
    }
  }

  private async writePendingCorruptLineCount(evidence: PendingCorruptionEvidence): Promise<void> {
    await fs.writeFile(
      this.getPendingCorruptionEvidencePath(),
      `${JSON.stringify(evidence)}\n`,
      { encoding: 'utf-8', mode: 0o600 },
    )
  }

  private async commitPendingCorruptLineCount(): Promise<void> {
    await fs.rename(this.getPendingCorruptionEvidencePath(), this.getCorruptionEvidencePath())
  }

  private hashBuffer(buffer: Buffer): string {
    return createHash('sha256').update(buffer).digest('hex')
  }

  private async truncateTextFileToTail(filePath: string, maxBytes: number): Promise<void> {
    let file: fs.FileHandle | undefined
    try {
      file = await fs.open(filePath, 'r')
      const stat = await file.stat()
      if (stat.size <= maxBytes) return
      const readLength = Math.min(stat.size, maxBytes + MAX_STRING_LENGTH)
      const buffer = Buffer.alloc(readLength)
      await file.read(buffer, 0, readLength, stat.size - readLength)
      await file.close()
      file = undefined
      let tail = buffer.toString('utf-8')
      const firstCompleteLine = tail.indexOf('\n')
      tail = firstCompleteLine === -1 ? tail.slice(-maxBytes) : tail.slice(firstCompleteLine + 1)
      while (Buffer.byteLength(tail, 'utf-8') > maxBytes) tail = tail.slice(1)
      const temporaryPath = `${filePath}.${crypto.randomUUID()}.tmp`
      try {
        await fs.writeFile(temporaryPath, tail, { encoding: 'utf-8', mode: 0o600 })
        await fs.rename(temporaryPath, filePath)
      } finally {
        await fs.rm(temporaryPath, { force: true })
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    } finally {
      await file?.close()
    }
  }

  private async enforceExportRetention(cutoff: number): Promise<void> {
    const files = (await this.listFiles(this.getExportDir())).sort((left, right) => left.mtimeMs - right.mtimeMs)
    let retainedBytes = files.reduce((sum, file) => sum + file.size, 0)
    for (const file of files) {
      if (file.mtimeMs >= cutoff && retainedBytes <= MAX_EXPORT_DIRECTORY_BYTES) continue
      await fs.rm(file.path, { force: true })
      retainedBytes -= file.size
    }
  }

  private async enforceCliCompletedSegmentRetention(cutoff: number): Promise<void> {
    const baseName = path.basename(this.getCliDiagnosticsPath())
    const cliFiles = (await this.listFiles(this.getLogDir()))
      .filter((file) => path.dirname(file.path) === this.getLogDir())
      .filter((file) => {
        const name = path.basename(file.path)
        return name === baseName || (name.startsWith(`${baseName}.`) && name.endsWith('.jsonl'))
      })
    const removed = new Set<string>()
    for (const file of cliFiles) {
      const name = path.basename(file.path)
      if (name.includes('.reclaimed.')) {
        if (file.mtimeMs < cutoff) {
          await fs.rm(file.path, { force: true })
          removed.add(file.path)
        }
        continue
      }
      if (name === baseName) {
        if (file.mtimeMs < cutoff) {
          await this.quarantineCliAppendTarget(file.path)
          removed.add(file.path)
        }
        continue
      }
      if (!name.endsWith('.current.jsonl')) continue
      const pidMatch = name.match(new RegExp(`^${this.escapeRegExp(baseName)}\\.(\\d+)\\.current\\.jsonl$`))
      const liveness = pidMatch ? this.getPidLiveness(Number(pidMatch[1])) : 'unknown'
      if (liveness === 'dead' || file.mtimeMs < cutoff) {
        await this.quarantineCliAppendTarget(file.path)
        removed.add(file.path)
      }
    }
    const recentLegacyBytes = cliFiles
      .filter((file) => path.basename(file.path) === baseName && !removed.has(file.path))
      .reduce((sum, file) => sum + file.size, 0)
    const completed = cliFiles
      .filter((file) => !removed.has(file.path))
      .filter((file) => {
        const name = path.basename(file.path)
        return name !== baseName && !name.endsWith('.current.jsonl') && !name.includes('.reclaimed.')
      })
      .sort((left, right) => left.mtimeMs - right.mtimeMs)
    let retainedBytes = recentLegacyBytes + completed.reduce((sum, file) => sum + file.size, 0)
    for (const file of completed) {
      if (file.mtimeMs >= cutoff && retainedBytes <= MAX_CLI_COMPLETED_SEGMENTS_BYTES) continue
      await fs.rm(file.path, { force: true })
      retainedBytes -= file.size
    }
  }

  private async quarantineCliAppendTarget(filePath: string): Promise<void> {
    const currentSuffix = '.current.jsonl'
    const stem = filePath.endsWith(currentSuffix)
      ? filePath.slice(0, -currentSuffix.length)
      : filePath
    const quarantinePath = `${stem}.reclaimed.${crypto.randomUUID()}.jsonl`
    try {
      await fs.rename(filePath, quarantinePath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }

  private getPidLiveness(pid: number): 'alive' | 'dead' | 'unknown' {
    if (!Number.isSafeInteger(pid) || pid <= 0) return 'unknown'
    try {
      process.kill(pid, 0)
      return 'alive'
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ESRCH') return 'dead'
      if (code === 'EPERM') return 'alive'
      return 'unknown'
    }
  }

  private escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }

  private async isManagedSurfaceOverLimit(): Promise<boolean> {
    const files = await this.listFiles(this.getLogDir())
    const sizeOf = (filePath: string) => files.find((file) => file.path === filePath)?.size ?? 0
    const cliBaseName = path.basename(this.getCliDiagnosticsPath())
    const cliBytes = files
      .filter((file) => path.dirname(file.path) === this.getLogDir())
      .filter((file) => {
        const name = path.basename(file.path)
        return name === cliBaseName || (name.startsWith(`${cliBaseName}.`) && name.endsWith('.jsonl'))
      })
      .reduce((sum, file) => sum + file.size, 0)
    const exportBytes = files
      .filter((file) => file.path.startsWith(`${this.getExportDir()}${path.sep}`))
      .reduce((sum, file) => sum + file.size, 0)
    return sizeOf(this.getDiagnosticsPath()) > MAX_DIAGNOSTICS_BYTES ||
      sizeOf(this.getRuntimeErrorsPath()) > MAX_AUXILIARY_LOG_BYTES ||
      sizeOf(this.getElectronHostPath()) > MAX_AUXILIARY_LOG_BYTES ||
      cliBytes > MAX_CLI_COMPLETED_SEGMENTS_BYTES ||
      exportBytes > MAX_EXPORT_DIRECTORY_BYTES
  }

  private keepNewestCompleteLinesWithinBytes(events: DiagnosticEvent[], maxBytes: number): string[] {
    const kept: string[] = []
    let totalBytes = 0
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const line = JSON.stringify(events[index])
      const lineBytes = Buffer.byteLength(line, 'utf-8') + 1
      if (lineBytes > maxBytes - totalBytes) break
      kept.push(line)
      totalBytes += lineBytes
    }
    return kept.reverse()
  }

  private async rewriteDiagnosticsAtomically(lines: string[]): Promise<void> {
    const diagnosticsPath = this.getDiagnosticsPath()
    const temporaryPath = `${diagnosticsPath}.${crypto.randomUUID()}.tmp`
    const content = lines.length > 0 ? `${lines.join('\n')}\n` : ''
    try {
      await fs.writeFile(temporaryPath, content, 'utf-8')
      await fs.rename(temporaryPath, diagnosticsPath)
    } finally {
      await fs.rm(temporaryPath, { force: true })
    }
  }

  private sanitizeWriteError(error: unknown): string {
    const raw = error instanceof Error ? error.message : String(error)
    return this.sanitizeString(raw).split(this.getConfigDir()).join('$CLAUDE_CONFIG_DIR')
  }

  private isDiagnosticEvent(value: unknown): value is DiagnosticEvent {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
    const event = value as Record<string, unknown>
    return typeof event.id === 'string' &&
      typeof event.timestamp === 'string' &&
      Number.isFinite(Date.parse(event.timestamp)) &&
      typeof event.type === 'string' &&
      (event.severity === 'debug' || event.severity === 'info' || event.severity === 'warn' || event.severity === 'error') &&
      typeof event.summary === 'string' &&
      (event.sessionId === undefined || typeof event.sessionId === 'string')
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
