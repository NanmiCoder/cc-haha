/**
 * WebSocket event for LSP state changes (Phase 3 task 22).
 *
 * Producers: `LspManager.onStateChange` listener registered in
 * `api/sessions.ts` (or wherever the manager singleton lives) sends one
 * of these per workspace state transition. Consumer is the desktop
 * `LspStatusIndicator` component, which subscribes via the existing
 * sessions WS channel and reflects ready / starting / unavailable in
 * real time.
 *
 * Type-only file — emit logic is centralized through `sendToSession`
 * inside the manager wiring point.
 *
 * _Requirements: 13.2 (Phase 3 task 22)_
 */

import type { LspUnavailableReason } from '../services/lspManager.js'

export type LspStateChangedEvent = {
  type: 'lsp.state.changed'
  workspaceId: string
  state: 'starting' | 'ready' | 'unavailable'
  errorCount: number
  reason?: LspUnavailableReason
  lastStderrTail?: string
}
