/**
 * Editor LSP manager (Phase 3 task 21).
 *
 * Holds at most one LSP child per workspace, lazily spawned on the first
 * diagnostics request and torn down after `IDLE_EVICTION_MS` of inactivity.
 * Restart attempts are capped per workspace so a chronically failing
 * server cannot consume CPU forever — once the cap is hit we surface
 * `restart-cap-exhausted` and require a manual retry from the UI.
 *
 * Diagnostics are normalized: severity 1-4 -> error/warning/info/hint
 * (anything else maps to 'error'), then sorted by a stable comparator
 * (severity > in-edited-file > path > line > column) and capped at the
 * top-20 entries / 5 distinct files. The caller sees `diagnosticsTotal`
 * and `diagnosticsTruncated` so the UI can offer a "show more" affordance.
 *
 * The actual JSON-RPC client lives behind an injected `LspClientFactory` so
 * unit tests can plug in a mock without touching child_process.
 *
 * _Requirements: 6.1-6.5, 7.1-7.6, 9.1-9.5, 12.1-12.4_
 */

import { probeHostCommand, type PrerequisiteProbeResult } from './prerequisitesService.js'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type LspSeverity = 'error' | 'warning' | 'info' | 'hint'

/** LSP wire severities map directly to our four levels; unknown -> 'error'. */
const SEVERITY_MAP: Record<number, LspSeverity> = {
  1: 'error',
  2: 'warning',
  3: 'info',
  4: 'hint',
}

export function mapLspSeverity(value: number | undefined | null): LspSeverity {
  if (typeof value !== 'number') return 'error'
  return SEVERITY_MAP[value] ?? 'error'
}

export type LspDiagnostic = {
  /** Workspace-relative path. */
  path: string
  line: number
  column: number
  severity: LspSeverity
  message: string
  source?: string
  code?: string | number
}

export type LspUnavailableReason =
  | 'prereq-missing'
  | 'init-timeout'
  | 'init-failed'
  | 'crashed'
  | 'restart-cap-exhausted'

export type WorkspaceLspState =
  | { state: 'starting'; workspaceId: string; errorCount: 0 }
  | { state: 'ready'; workspaceId: string; errorCount: number }
  | {
      state: 'unavailable'
      workspaceId: string
      reason: LspUnavailableReason
      errorCount: number
      lastStderrTail?: string
    }

export type LspDiagnosticsResult = {
  state: 'ok' | 'unavailable' | 'starting'
  diagnostics: LspDiagnostic[]
  diagnosticsTotal: number
  diagnosticsTruncated: boolean
  reason?: LspUnavailableReason
  /** Paths the manager refused to evaluate (outside the workspace, etc.). */
  excludedPaths?: string[]
}

export type LspPrerequisite = {
  command: string
  probe: PrerequisiteProbeResult
}

// ---------------------------------------------------------------------------
// Comparator + truncation
// ---------------------------------------------------------------------------

const SEVERITY_ORDER: Record<LspSeverity, number> = {
  error: 0,
  warning: 1,
  info: 2,
  hint: 3,
}

export function makeDiagnosticComparator(editedFilePath: string | null) {
  return (a: LspDiagnostic, b: LspDiagnostic): number => {
    if (SEVERITY_ORDER[a.severity] !== SEVERITY_ORDER[b.severity]) {
      return SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]
    }
    if (editedFilePath) {
      const aIn = a.path === editedFilePath ? 0 : 1
      const bIn = b.path === editedFilePath ? 0 : 1
      if (aIn !== bIn) return aIn - bIn
    }
    if (a.path !== b.path) return a.path < b.path ? -1 : 1
    if (a.line !== b.line) return a.line - b.line
    return a.column - b.column
  }
}

export const DIAGNOSTICS_ENTRY_CAP = 20
export const DIAGNOSTICS_DISTINCT_FILE_CAP = 5

export function truncateDiagnostics(
  diagnostics: LspDiagnostic[],
): { kept: LspDiagnostic[]; truncated: boolean } {
  if (diagnostics.length === 0) {
    return { kept: [], truncated: false }
  }
  const distinctFiles = new Set<string>()
  const kept: LspDiagnostic[] = []
  for (const diag of diagnostics) {
    if (kept.length >= DIAGNOSTICS_ENTRY_CAP) break
    if (!distinctFiles.has(diag.path)) {
      if (distinctFiles.size >= DIAGNOSTICS_DISTINCT_FILE_CAP) continue
      distinctFiles.add(diag.path)
    }
    kept.push(diag)
  }
  return { kept, truncated: kept.length < diagnostics.length }
}

// ---------------------------------------------------------------------------
// Manager
// ---------------------------------------------------------------------------

export type LspClient = {
  /** Returns currently-known diagnostics for a single file. Manager handles
   *  caching/freshness; the client just exposes whatever the server sent
   *  through `textDocument/publishDiagnostics`. */
  getDiagnosticsForFile(workspaceRoot: string, filePath: string): Promise<LspDiagnostic[]>
  /** Multi-file variant — same semantics as the singular form. */
  getDiagnosticsForFiles(workspaceRoot: string, filePaths: string[]): Promise<LspDiagnostic[]>
  /** Total error count across the entire workspace (for Solo tier-1 signal). */
  getErrorCount(): Promise<number>
  /** Send LSP shutdown + exit and wait for the child to exit, with timeout. */
  shutdown(): Promise<void>
  /** Kill the child immediately (SIGKILL on POSIX, TerminateProcess on Windows). */
  kill(): void
}

export type LspClientFactory = (input: {
  workspaceRoot: string
  workspaceId: string
  command: string
  onCrash: (info: { stderrTail: string }) => void
}) => Promise<LspClient>

export type LspManagerConfig = {
  /** Probe + spawn this command. Defaults to typescript-language-server. */
  command?: string
  /** Idle ms before a workspace's LSP is evicted. */
  idleEvictionMs?: number
  /** Restart cap per rolling window. */
  restartCap?: number
  /** Restart window in ms. */
  restartWindowMs?: number
  /** Override clock for tests. */
  now?: () => number
  /** Plug in a mock client in tests. */
  clientFactory?: LspClientFactory
}

const DEFAULT_COMMAND = 'typescript-language-server'
const DEFAULT_IDLE_EVICTION_MS = 600_000 // 10 min
const DEFAULT_RESTART_CAP = 2 // 60 s window, 3rd attempt = exhausted
const DEFAULT_RESTART_WINDOW_MS = 60_000

type WorkspaceEntry = {
  workspaceId: string
  workspaceRoot: string
  state: WorkspaceLspState
  client: LspClient | null
  lastActivityAt: number
  restartTimestamps: number[]
  evictionTimer: ReturnType<typeof setTimeout> | null
}

export class LspManager {
  private workspaces = new Map<string, WorkspaceEntry>()
  private listeners = new Set<(state: WorkspaceLspState) => void>()
  private readonly command: string
  private readonly idleEvictionMs: number
  private readonly restartCap: number
  private readonly restartWindowMs: number
  private readonly now: () => number
  private readonly clientFactory: LspClientFactory | null

  constructor(config: LspManagerConfig = {}) {
    this.command = config.command ?? DEFAULT_COMMAND
    this.idleEvictionMs = config.idleEvictionMs ?? DEFAULT_IDLE_EVICTION_MS
    this.restartCap = config.restartCap ?? DEFAULT_RESTART_CAP
    this.restartWindowMs = config.restartWindowMs ?? DEFAULT_RESTART_WINDOW_MS
    this.now = config.now ?? (() => Date.now())
    this.clientFactory = config.clientFactory ?? null
  }

  // -------------------- State + listeners --------------------

  getState(workspaceId: string): WorkspaceLspState {
    const entry = this.workspaces.get(workspaceId)
    if (!entry) {
      return { state: 'starting', workspaceId, errorCount: 0 }
    }
    return entry.state
  }

  onStateChange(listener: (state: WorkspaceLspState) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private setState(entry: WorkspaceEntry, next: WorkspaceLspState): void {
    entry.state = next
    for (const listener of this.listeners) listener(next)
  }

  // -------------------- Diagnostics --------------------

  async getDiagnosticsForFile(
    workspaceId: string,
    workspaceRoot: string,
    filePath: string,
    options: { spawnIfNeeded?: boolean } = {},
  ): Promise<LspDiagnosticsResult> {
    return this.getDiagnosticsForFiles(workspaceId, workspaceRoot, [filePath], {
      ...options,
      editedFilePath: filePath,
    })
  }

  async getDiagnosticsForFiles(
    workspaceId: string,
    workspaceRoot: string,
    filePaths: string[],
    options: { spawnIfNeeded?: boolean; editedFilePath?: string } = {},
  ): Promise<LspDiagnosticsResult> {
    const spawnIfNeeded = options.spawnIfNeeded ?? true
    const entry = await this.ensureWorkspace(workspaceId, workspaceRoot, spawnIfNeeded)
    if (entry.state.state !== 'ready' || !entry.client) {
      return {
        state: entry.state.state === 'starting' ? 'starting' : 'unavailable',
        diagnostics: [],
        diagnosticsTotal: 0,
        diagnosticsTruncated: false,
        ...(entry.state.state === 'unavailable' ? { reason: entry.state.reason } : {}),
      }
    }

    entry.lastActivityAt = this.now()
    this.scheduleEviction(entry)

    let raw: LspDiagnostic[]
    try {
      raw = await entry.client.getDiagnosticsForFiles(workspaceRoot, filePaths)
    } catch {
      return {
        state: 'unavailable',
        diagnostics: [],
        diagnosticsTotal: 0,
        diagnosticsTruncated: false,
        reason: 'crashed',
      }
    }
    const sorted = [...raw].sort(makeDiagnosticComparator(options.editedFilePath ?? null))
    const { kept, truncated } = truncateDiagnostics(sorted)
    return {
      state: 'ok',
      diagnostics: kept,
      diagnosticsTotal: raw.length,
      diagnosticsTruncated: truncated,
    }
  }

  async getErrorCount(workspaceId: string, workspaceRoot: string): Promise<number> {
    const entry = await this.ensureWorkspace(workspaceId, workspaceRoot, true)
    if (entry.state.state !== 'ready' || !entry.client) return 0
    try {
      return await entry.client.getErrorCount()
    } catch {
      return 0
    }
  }

  // -------------------- Prerequisites --------------------

  async getPrerequisites(): Promise<LspPrerequisite[]> {
    const probe = await probeHostCommand(this.command)
    return [{ command: this.command, probe }]
  }

  // -------------------- Lifecycle --------------------

  async shutdownWorkspace(workspaceId: string): Promise<void> {
    const entry = this.workspaces.get(workspaceId)
    if (!entry) return
    if (entry.evictionTimer) {
      clearTimeout(entry.evictionTimer)
      entry.evictionTimer = null
    }
    if (entry.client) {
      try {
        await entry.client.shutdown()
      } catch {
        try {
          entry.client.kill()
        } catch {
          /* ignore */
        }
      }
      entry.client = null
    }
    this.workspaces.delete(workspaceId)
  }

  async shutdownAll(): Promise<void> {
    const ids = Array.from(this.workspaces.keys())
    await Promise.all(ids.map((id) => this.shutdownWorkspace(id)))
  }

  // -------------------- Internals --------------------

  private async ensureWorkspace(
    workspaceId: string,
    workspaceRoot: string,
    spawnIfNeeded: boolean,
  ): Promise<WorkspaceEntry> {
    let entry = this.workspaces.get(workspaceId)
    if (!entry) {
      entry = {
        workspaceId,
        workspaceRoot,
        state: { state: 'starting', workspaceId, errorCount: 0 },
        client: null,
        lastActivityAt: this.now(),
        restartTimestamps: [],
        evictionTimer: null,
      }
      this.workspaces.set(workspaceId, entry)
    }

    if (entry.state.state === 'ready' && entry.client) return entry
    if (entry.state.state === 'unavailable') return entry
    if (!spawnIfNeeded) return entry
    if (!this.clientFactory) {
      this.markUnavailable(entry, 'init-failed')
      return entry
    }

    // Restart cap: prune timestamps outside the rolling window.
    const cutoff = this.now() - this.restartWindowMs
    entry.restartTimestamps = entry.restartTimestamps.filter((t) => t >= cutoff)
    if (entry.restartTimestamps.length > this.restartCap) {
      this.markUnavailable(entry, 'restart-cap-exhausted')
      return entry
    }

    // Probe the host command before paying the spawn cost.
    let probe: PrerequisiteProbeResult
    try {
      probe = await probeHostCommand(this.command)
    } catch {
      this.markUnavailable(entry, 'init-failed')
      return entry
    }
    if (!probe.installed) {
      this.markUnavailable(entry, 'prereq-missing')
      return entry
    }

    try {
      const client = await this.clientFactory({
        workspaceRoot,
        workspaceId,
        command: this.command,
        onCrash: ({ stderrTail }) => {
          this.markUnavailable(entry!, 'crashed', stderrTail)
          entry!.client = null
        },
      })
      entry.client = client
      entry.restartTimestamps.push(this.now())
      this.setState(entry, { state: 'ready', workspaceId, errorCount: 0 })
    } catch {
      entry.restartTimestamps.push(this.now())
      this.markUnavailable(entry, 'init-failed')
    }
    return entry
  }

  private markUnavailable(
    entry: WorkspaceEntry,
    reason: LspUnavailableReason,
    lastStderrTail?: string,
  ): void {
    this.setState(entry, {
      state: 'unavailable',
      workspaceId: entry.workspaceId,
      reason,
      errorCount: 0,
      ...(lastStderrTail !== undefined ? { lastStderrTail } : {}),
    })
  }

  private scheduleEviction(entry: WorkspaceEntry): void {
    if (entry.evictionTimer) clearTimeout(entry.evictionTimer)
    entry.evictionTimer = setTimeout(() => {
      // Only evict if no recent activity touched the entry.
      if (this.now() - entry.lastActivityAt < this.idleEvictionMs) {
        this.scheduleEviction(entry)
        return
      }
      void this.shutdownWorkspace(entry.workspaceId)
    }, this.idleEvictionMs)
    if (typeof entry.evictionTimer.unref === 'function') {
      entry.evictionTimer.unref()
    }
  }
}
