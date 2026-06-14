/**
 * Desktop-side mirror of the LSP-related types from the server. Kept
 * narrow on purpose — the desktop UI only needs the wire shapes, not
 * the manager-internal state. Mirrored manually rather than imported
 * across the desktop / server boundary because there's no shared
 * types module yet.
 *
 * Wire-format compatibility is asserted by the server tests: any time
 * the server-side LspManager types change, this file must move with
 * them. There is no automatic generator yet.
 */

export type LspSeverity = 'error' | 'warning' | 'info' | 'hint'

export type LspDiagnostic = {
  path: string
  line: number
  column: number
  severity: LspSeverity
  message: string
  source?: string
  code?: string | number
}

export type WorkspaceLspDiagnostic = LspDiagnostic

export type LspUnavailableReason =
  | 'prereq-missing'
  | 'init-timeout'
  | 'init-failed'
  | 'crashed'
  | 'restart-cap-exhausted'

export type WorkspaceLspState =
  | { state: 'idle'; path: string | null; serverName: string | null; command: string | null; error?: string }
  | { state: 'starting'; path: string | null; serverName: string | null; command: string | null; error?: string }
  | { state: 'ready'; path: string | null; serverName: string | null; command: string | null; error?: string }
  | { state: 'unavailable'; path: string | null; serverName: string | null; command: string | null; error?: string }

export type LegacyWorkspaceLspState =
  | { state: 'starting'; workspaceId: string; errorCount: 0 }
  | { state: 'ready'; workspaceId: string; errorCount: number }
  | {
      state: 'unavailable'
      workspaceId: string
      reason: LspUnavailableReason
      errorCount: number
      lastStderrTail?: string
    }

export type LspStateChangedEvent = {
  type: 'lsp.state.changed'
  workspaceId: string
  state: 'starting' | 'ready' | 'unavailable'
  errorCount: number
  reason?: LspUnavailableReason
  lastStderrTail?: string
}
