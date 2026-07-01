/**
 * Shared emitter for the `workspace.file.saved` WebSocket event.
 *
 * Both write paths — user (this PR, via `WorkspaceFileService`) and agent
 * (PR-4, via `AgentEditTool`) — must funnel through `emitWorkspaceFileSaved`
 * so the desktop client sees a single, well-typed event shape on the wire.
 *
 * Centralizing the emitter is what enforces the conflict-banner contract:
 * the desktop store decides "echo of my own save" vs "external save" by
 * comparing the `hash` field, so producers cannot accidentally omit it.
 *
 * _Requirements: 2.9, 3.1 (Phase 2 task 11)_
 */

import { sendToSession } from '../ws/handler.js'

export type WorkspaceFileSavedSource = 'user' | 'agent'

export type WorkspaceFileSavedEvent = {
  type: 'workspace.file.saved'
  sessionId: string
  path: string
  hash: string
  source: WorkspaceFileSavedSource
  timestamp: number
  /** Optional — agent path may identify the agent that wrote the file. */
  actor?: string
}

export type WorkspaceFileSavedInput = Omit<WorkspaceFileSavedEvent, 'type' | 'timestamp'> & {
  /** Optional — defaults to `Date.now()` so callers don't have to pass it. */
  timestamp?: number
}

/**
 * Send the `workspace.file.saved` event to the session's WebSocket.
 *
 * Returns `true` if the message reached an open socket, `false` if the
 * session has no live connection (caller may swallow this — the desktop
 * client will refetch on reconnect).
 */
export function emitWorkspaceFileSaved(input: WorkspaceFileSavedInput): boolean {
  const event: WorkspaceFileSavedEvent = {
    type: 'workspace.file.saved',
    sessionId: input.sessionId,
    path: input.path,
    hash: input.hash,
    source: input.source,
    timestamp: input.timestamp ?? Date.now(),
    ...(input.actor !== undefined ? { actor: input.actor } : {}),
  }
  return sendToSession(input.sessionId, event)
}
