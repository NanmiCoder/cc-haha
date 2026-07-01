import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Diagnostic } from '../../services/diagnosticTracking.js'
import {
  createLSPServerManager,
  type LSPServerManager,
} from '../../services/lsp/LSPServerManager.js'
import type { ScopedLspServerConfig } from '../../services/lsp/types.js'
import { probeHostCommand } from './prerequisitesService.js'

export type WorkspaceLspSeverity = 'error' | 'warning' | 'info' | 'hint'

export type WorkspaceLspDiagnostic = {
  path: string
  line: number
  column: number
  severity: WorkspaceLspSeverity
  message: string
  source?: string
  code?: string | number
}

export type WorkspaceLspState = {
  state: 'idle' | 'starting' | 'ready' | 'unavailable'
  path: string | null
  serverName: string | null
  command: string | null
  error?: string
}

export type WorkspaceLspDiagnosticsResult = {
  state: WorkspaceLspState['state']
  diagnostics: WorkspaceLspDiagnostic[]
  diagnosticsTotal: number
  diagnosticsTruncated: boolean
  error?: string
}

export type WorkspaceLspSyncInput = {
  path: string
  content?: string
  event?: 'open' | 'change' | 'save'
}

export type WorkspaceLspCustomServerInput = {
  name?: string
  path?: string
  command?: string
  args?: string[]
  extensionToLanguage?: Record<string, string>
}

export type WorkspaceLspConfigInput = {
  server?: WorkspaceLspCustomServerInput
}

type WorkspaceLspServiceOptions = {
  createManager?: (servers: Record<string, ScopedLspServerConfig>) => LSPServerManager
  waitTimeoutMs?: number
  waitIntervalMs?: number
}

type WorkspaceEntry = {
  manager: LSPServerManager
  root: string
  versions: Map<string, number>
  lastError?: string
  initialized: boolean
  configKey: string
}

type LatestDiagnosticEntry = {
  diagnostics: Diagnostic[]
  updatedAt: number
}

const DIAGNOSTICS_CAP = 100
const DEFAULT_WAIT_TIMEOUT_MS = 1_500
const DEFAULT_WAIT_INTERVAL_MS = 50

const latestDiagnostics = new Map<string, LatestDiagnosticEntry>()

export function publishWorkspaceLspDiagnostics(uri: string, diagnostics: Diagnostic[]): void {
  latestDiagnostics.set(uri, { diagnostics, updatedAt: Date.now() })
}

export function clearWorkspaceLspDiagnostics(): void {
  latestDiagnostics.clear()
}

export class WorkspaceLspService {
  private readonly workspaces = new Map<string, WorkspaceEntry>()
  private readonly createManager: (servers: Record<string, ScopedLspServerConfig>) => LSPServerManager
  private readonly waitTimeoutMs: number
  private readonly waitIntervalMs: number

  constructor(options: WorkspaceLspServiceOptions = {}) {
    this.createManager = options.createManager ?? ((servers) => createLSPServerManager({ servers }))
    this.waitTimeoutMs = options.waitTimeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS
    this.waitIntervalMs = options.waitIntervalMs ?? DEFAULT_WAIT_INTERVAL_MS
  }

  async getState(sessionId: string, workspaceRoot: string, requestedPath?: string): Promise<WorkspaceLspState> {
    const pathInfo = requestedPath
      ? await resolveWorkspaceFilePath(workspaceRoot, requestedPath)
      : null
    const entry = this.workspaces.get(sessionId)
    if (!entry) {
      return { state: 'idle', path: pathInfo?.relativePath ?? null, serverName: null, command: null }
    }
    const server = pathInfo ? entry.manager.getServerForFile(pathInfo.absolutePath) : undefined
    if (!pathInfo) {
      return { state: entry.initialized ? 'ready' : 'idle', path: null, serverName: null, command: null, error: entry.lastError }
    }
    if (!server) {
      return { state: 'unavailable', path: pathInfo.relativePath, serverName: null, command: null, error: 'No LSP server configured for file extension' }
    }
    return {
      state: server.state === 'running' ? 'ready' : server.state === 'starting' ? 'starting' : server.state === 'error' ? 'unavailable' : 'idle',
      path: pathInfo.relativePath,
      serverName: server.name,
      command: server.config.command,
      error: server.lastError?.message ?? entry.lastError,
    }
  }

  async sync(
    sessionId: string,
    workspaceRoot: string,
    input: WorkspaceLspSyncInput,
    config?: WorkspaceLspConfigInput,
  ): Promise<WorkspaceLspState> {
    const pathInfo = await resolveWorkspaceFilePath(workspaceRoot, input.path)
    const entry = await this.ensureEntry(sessionId, workspaceRoot, config)
    const event = input.event ?? 'change'
    const content = input.content ?? await fs.readFile(pathInfo.absolutePath, 'utf8')

    try {
      if (event === 'save') {
        if (content !== undefined) {
          await this.sendOpenOrChange(entry, pathInfo.absolutePath, content)
        }
        await entry.manager.saveFile(pathInfo.absolutePath)
      } else {
        await this.sendOpenOrChange(entry, pathInfo.absolutePath, content ?? '')
      }
      entry.lastError = undefined
    } catch (error) {
      entry.lastError = error instanceof Error ? error.message : 'LSP sync failed'
    }

    return this.getState(sessionId, workspaceRoot, pathInfo.relativePath)
  }

  async getDiagnostics(
    sessionId: string,
    workspaceRoot: string,
    requestedPath: string,
    options: { refresh?: boolean; config?: WorkspaceLspConfigInput } = {},
  ): Promise<WorkspaceLspDiagnosticsResult> {
    const pathInfo = await resolveWorkspaceFilePath(workspaceRoot, requestedPath)
    if (options.refresh) {
      await this.sync(sessionId, workspaceRoot, { path: pathInfo.relativePath, event: 'open' }, options.config)
    }

    const uri = pathToFileURL(pathInfo.absolutePath).href
    const diagnostics = await this.waitForDiagnostics(uri)
    const mapped = diagnostics.map((diagnostic) => toWorkspaceDiagnostic(pathInfo.relativePath, diagnostic))
    return {
      state: (await this.getState(sessionId, workspaceRoot, pathInfo.relativePath)).state,
      diagnostics: mapped.slice(0, DIAGNOSTICS_CAP),
      diagnosticsTotal: mapped.length,
      diagnosticsTruncated: mapped.length > DIAGNOSTICS_CAP,
    }
  }

  async restart(
    sessionId: string,
    workspaceRoot: string,
    requestedPath?: string,
    config?: WorkspaceLspConfigInput,
  ): Promise<WorkspaceLspState> {
    const pathInfo = requestedPath
      ? await resolveWorkspaceFilePath(workspaceRoot, requestedPath)
      : null
    const existing = this.workspaces.get(sessionId)
    if (existing) {
      await existing.manager.shutdown()
      this.workspaces.delete(sessionId)
    }
    const entry = await this.ensureEntry(sessionId, workspaceRoot, config)
    if (pathInfo) {
      try {
        await entry.manager.ensureServerStarted(pathInfo.absolutePath)
        entry.lastError = undefined
      } catch (error) {
        entry.lastError = error instanceof Error ? error.message : 'LSP restart failed'
      }
    }
    return this.getState(sessionId, workspaceRoot, pathInfo?.relativePath)
  }

  private async ensureEntry(
    sessionId: string,
    workspaceRoot: string,
    config?: WorkspaceLspConfigInput,
  ): Promise<WorkspaceEntry> {
    const canonicalRoot = await fs.realpath(workspaceRoot)
    const configKey = stableConfigKey(config)
    const existing = this.workspaces.get(sessionId)
    if (existing && existing.root === canonicalRoot && existing.configKey === configKey) return existing
    if (existing) await existing.manager.shutdown()

    const servers = await buildServerConfigs(canonicalRoot, config)
    const manager = this.createManager(servers)
    const entry: WorkspaceEntry = {
      manager,
      root: canonicalRoot,
      versions: new Map(),
      initialized: false,
      configKey,
    }
    this.workspaces.set(sessionId, entry)
    await manager.initialize()
    entry.initialized = true
    this.registerDiagnosticsHandlers(entry)
    return entry
  }

  private registerDiagnosticsHandlers(entry: WorkspaceEntry): void {
    for (const server of entry.manager.getAllServers().values()) {
      server.onNotification('textDocument/publishDiagnostics', (params: unknown) => {
        if (!params || typeof params !== 'object') return
        const candidate = params as { uri?: unknown; diagnostics?: unknown }
        if (typeof candidate.uri !== 'string' || !Array.isArray(candidate.diagnostics)) return
        publishWorkspaceLspDiagnostics(
          candidate.uri,
          candidate.diagnostics.map(toDiagnostic),
        )
      })
    }
  }

  private async sendOpenOrChange(entry: WorkspaceEntry, absolutePath: string, content: string): Promise<void> {
    if (entry.manager.isFileOpen(absolutePath)) {
      await this.changeWithVersion(entry, absolutePath, content)
    } else {
      await this.openWithVersion(entry, absolutePath, content)
    }
  }

  private async openWithVersion(entry: WorkspaceEntry, absolutePath: string, content: string): Promise<void> {
    entry.versions.set(pathToFileURL(absolutePath).href, 1)
    await entry.manager.openFile(absolutePath, content)
  }

  private async changeWithVersion(entry: WorkspaceEntry, absolutePath: string, content: string): Promise<void> {
    const uri = pathToFileURL(absolutePath).href
    entry.versions.set(uri, (entry.versions.get(uri) ?? 1) + 1)
    await entry.manager.changeFile(absolutePath, content)
  }

  private async waitForDiagnostics(uri: string): Promise<Diagnostic[]> {
    const startedAt = Date.now()
    const initial = latestDiagnostics.get(uri)
    while (Date.now() - startedAt < this.waitTimeoutMs) {
      const current = latestDiagnostics.get(uri)
      if (current && current !== initial) return current.diagnostics
      await new Promise((resolve) => setTimeout(resolve, this.waitIntervalMs))
    }
    return latestDiagnostics.get(uri)?.diagnostics ?? []
  }
}

function stableConfigKey(config?: WorkspaceLspConfigInput): string {
  if (!config?.server) return 'default'
  const server = config.server
  const normalized = {
    name: server.name?.trim() || 'custom:lsp',
    path: server.path?.trim(),
    command: server.command?.trim(),
    args: server.args ?? [],
    extensionToLanguage: Object.fromEntries(
      Object.entries(server.extensionToLanguage ?? {})
        .map(([extension, language]) => [
          extension.startsWith('.') ? extension.toLowerCase() : `.${extension.toLowerCase()}`,
          language,
        ])
        .sort(([left], [right]) => left.localeCompare(right)),
    ),
  }
  return JSON.stringify(normalized)
}

async function buildServerConfigs(
  workspaceRoot: string,
  config?: WorkspaceLspConfigInput,
): Promise<Record<string, ScopedLspServerConfig>> {
  const presets: Record<string, ScopedLspServerConfig> = {
    'preset:rust-analyzer': {
      command: 'rust-analyzer',
      args: [],
      extensionToLanguage: { '.rs': 'rust' },
      transport: 'stdio',
      workspaceFolder: workspaceRoot,
      startupTimeout: 10_000,
    },
    'preset:typescript-language-server': {
      command: 'typescript-language-server',
      args: ['--stdio'],
      extensionToLanguage: { '.ts': 'typescript', '.tsx': 'typescriptreact', '.js': 'javascript', '.jsx': 'javascriptreact' },
      transport: 'stdio',
      workspaceFolder: workspaceRoot,
      startupTimeout: 10_000,
    },
    'preset:pyright-langserver': {
      command: 'pyright-langserver',
      args: ['--stdio'],
      extensionToLanguage: { '.py': 'python' },
      transport: 'stdio',
      workspaceFolder: workspaceRoot,
      startupTimeout: 10_000,
    },
  }

  if (!config?.server) return presets
  const customName = config.server.name?.trim() || 'custom:lsp'
  const custom = normalizeCustomServerConfig(config.server, workspaceRoot)
  await probeLspCommand(custom.command)
  const customExtensions = new Set(Object.keys(custom.extensionToLanguage))
  const remainingPresets = Object.fromEntries(
    Object.entries(presets)
      .map(([name, preset]) => [
        name,
        {
          ...preset,
          extensionToLanguage: Object.fromEntries(
            Object.entries(preset.extensionToLanguage)
              .filter(([extension]) => !customExtensions.has(extension.toLowerCase())),
          ),
        },
      ] as const)
      .filter(([, preset]) => Object.keys(preset.extensionToLanguage).length > 0),
  )
  return { [customName]: custom, ...remainingPresets }
}

function normalizeCustomServerConfig(input: WorkspaceLspCustomServerInput, workspaceRoot: string): ScopedLspServerConfig {
  const command = input.path ?? input.command
  if (!command || !command.trim()) throw new Error('Custom LSP requires path or command')
  const trimmedCommand = command.trim()
  if (input.path && !path.isAbsolute(trimmedCommand)) {
    throw new Error('Custom LSP path must be absolute')
  }
  if (!input.path && /[\s"'`$&|;<>()]/.test(trimmedCommand)) {
    throw new Error('Custom LSP command must be a bare executable; put arguments in args')
  }
  const args = input.args ?? []
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string')) {
    throw new Error('Custom LSP args must be a string array')
  }
  const extensionToLanguage = normalizeExtensionMap(input.extensionToLanguage)
  return {
    command: trimmedCommand,
    args,
    extensionToLanguage,
    transport: 'stdio',
    workspaceFolder: workspaceRoot,
    startupTimeout: 10_000,
  }
}

function normalizeExtensionMap(mapping: Record<string, string> | undefined): Record<string, string> {
  if (!mapping || Object.keys(mapping).length === 0) {
    throw new Error('Custom LSP extensionToLanguage must contain at least one entry')
  }
  const normalized: Record<string, string> = {}
  for (const [rawExt, rawLanguage] of Object.entries(mapping)) {
    const ext = rawExt.startsWith('.') ? rawExt.toLowerCase() : `.${rawExt.toLowerCase()}`
    if (!/^\.[A-Za-z0-9_+-]+$/.test(ext)) throw new Error(`Invalid LSP extension: ${rawExt}`)
    const language = rawLanguage.trim()
    if (!language) throw new Error(`Invalid LSP language for extension: ${rawExt}`)
    normalized[ext] = language
  }
  return normalized
}

async function probeLspCommand(command: string): Promise<void> {
  if (path.isAbsolute(command)) {
    const stat = await fs.stat(command)
    if (!stat.isFile()) throw new Error('Custom LSP path is not a file')
    return
  }
  const probe = await probeHostCommand(command)
  if (!probe.installed) throw new Error(`Custom LSP command not found: ${command}`)
}

async function resolveWorkspaceFilePath(workspaceRoot: string, requestedPath: string) {
  if (!requestedPath || typeof requestedPath !== 'string') {
    throw new Error('path query parameter is required')
  }
  const canonicalRoot = await fs.realpath(workspaceRoot)
  const lexicalAbsolute = path.isAbsolute(requestedPath)
    ? path.resolve(requestedPath)
    : path.resolve(canonicalRoot, requestedPath)
  const rootWithSep = canonicalRoot.endsWith(path.sep) ? canonicalRoot : `${canonicalRoot}${path.sep}`
  if (lexicalAbsolute !== canonicalRoot && !lexicalAbsolute.startsWith(rootWithSep)) {
    throw new Error('path resolves outside workspace')
  }
  const parent = path.dirname(lexicalAbsolute)
  const canonicalParent = await fs.realpath(parent)
  const absolutePath = path.join(canonicalParent, path.basename(lexicalAbsolute))
  const rootWithSepForResolved = canonicalRoot.endsWith(path.sep) ? canonicalRoot : `${canonicalRoot}${path.sep}`
  if (absolutePath !== canonicalRoot && !absolutePath.startsWith(rootWithSepForResolved)) {
    throw new Error('path resolves outside workspace')
  }

  try {
    const canonicalTarget = await fs.realpath(absolutePath)
    if (canonicalTarget !== canonicalRoot && !canonicalTarget.startsWith(rootWithSepForResolved)) {
      throw new Error('path resolves outside workspace')
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error
  }

  return {
    absolutePath,
    relativePath: path.relative(canonicalRoot, absolutePath).split(path.sep).join('/'),
  }
}

function toDiagnostic(input: unknown): Diagnostic {
  const diagnostic = input as {
    message?: unknown
    severity?: unknown
    range?: { start?: { line?: unknown; character?: unknown }; end?: { line?: unknown; character?: unknown } }
    source?: unknown
    code?: unknown
  }
  const start = diagnostic.range?.start ?? {}
  const end = diagnostic.range?.end ?? start
  return {
    message: typeof diagnostic.message === 'string' ? diagnostic.message : String(diagnostic.message ?? ''),
    severity: mapSeverityToDiagnostic(diagnostic.severity),
    range: {
      start: { line: numberOrZero(start.line), character: numberOrZero(start.character) },
      end: { line: numberOrZero(end.line), character: numberOrZero(end.character) },
    },
    ...(typeof diagnostic.source === 'string' ? { source: diagnostic.source } : {}),
    ...(diagnostic.code !== undefined ? { code: String(diagnostic.code) } : {}),
  }
}

function mapSeverityToDiagnostic(severity: unknown): Diagnostic['severity'] {
  switch (severity) {
    case 2:
      return 'Warning'
    case 3:
      return 'Info'
    case 4:
      return 'Hint'
    case 1:
    default:
      return 'Error'
  }
}

function toWorkspaceDiagnostic(relativePath: string, diagnostic: Diagnostic): WorkspaceLspDiagnostic {
  return {
    path: relativePath,
    line: diagnostic.range.start.line + 1,
    column: diagnostic.range.start.character + 1,
    severity: mapSeverityToWorkspace(diagnostic.severity),
    message: diagnostic.message,
    source: diagnostic.source,
    code: diagnostic.code,
  }
}

function mapSeverityToWorkspace(severity: Diagnostic['severity']): WorkspaceLspSeverity {
  switch (severity) {
    case 'Warning':
      return 'warning'
    case 'Info':
      return 'info'
    case 'Hint':
      return 'hint'
    case 'Error':
    default:
      return 'error'
  }
}

function numberOrZero(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}
