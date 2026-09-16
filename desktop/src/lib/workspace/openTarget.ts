import { useTabStore } from '../../stores/tabStore'
import { useWorkspaceStore, type WorkspaceOrigin } from '../../stores/workspaceStore'
import type { WorkspaceOpenOptions, WorkspaceTarget } from './types'

export type WorkspaceOpenRequest = WorkspaceOpenOptions & {
  /** The task that owns the workspace this should land in. */
  sessionId: string
  target: WorkspaceTarget
  /** Chat element that asked, so the conversation can scroll back to it. */
  origin?: WorkspaceOrigin
}

/**
 * The one way anything opens something in a workspace.
 *
 * Buttons, keyboard shortcuts, chat file links, turn-change cards, "Open with",
 * preview link routing and agent-driven opens all come through here, so the
 * rules about activation, previewing and task ownership live in one place
 * rather than being re-decided at each call site.
 *
 * Task ownership is the rule that matters most: a request naming a task other
 * than the one in the foreground lands in *that* task's workspace and never
 * pulls the user away from what they are reading. That is why the store is
 * addressed by `sessionId` and not by "the current session".
 */
export function openWorkspaceTarget(request: WorkspaceOpenRequest): string | null {
  const { sessionId, target, origin, ...options } = request
  const activeTabId = useTabStore.getState().activeTabId
  const isForeground = activeTabId === sessionId

  if (origin) useWorkspaceStore.getState().setOrigin(sessionId, origin)

  return useWorkspaceStore.getState().openTarget(sessionId, target, {
    ...options,
    background: options.background === true || !isForeground,
  })
}

/** Convenience wrappers so call sites read as the action the user took. */
export const workspaceOpen = {
  file(sessionId: string, path: string, options?: {
    line?: number
    column?: number
    preview?: boolean
    background?: boolean
    replaceBlankPlaceholder?: boolean
    origin?: WorkspaceOrigin
  }) {
    return openWorkspaceTarget({
      sessionId,
      target: {
        kind: 'file',
        path,
        ...(options?.line
          ? { reveal: { line: options.line, ...(options.column ? { column: options.column } : {}) } }
          : {}),
      },
      ...(options?.preview ? { preview: true } : {}),
      ...(options?.background ? { background: true } : {}),
      ...(options?.replaceBlankPlaceholder ? { replaceBlankPlaceholder: true } : {}),
      ...(options?.origin ? { origin: options.origin } : {}),
    })
  },
  browser(sessionId: string, url?: string, options?: {
    background?: boolean
    origin?: WorkspaceOrigin
  }) {
    return openWorkspaceTarget({
      sessionId,
      target: { kind: 'browser', ...(url ? { url } : {}) },
      ...(options?.background ? { background: true } : {}),
      ...(options?.origin ? { origin: options.origin } : {}),
    })
  },
  review(sessionId: string, options?: {
    source?: Extract<WorkspaceTarget, { kind: 'review' }>['source']
    path?: string
    origin?: WorkspaceOrigin
  }) {
    return openWorkspaceTarget({
      sessionId,
      target: {
        kind: 'review',
        ...(options?.source ? { source: options.source } : {}),
        ...(options?.path ? { path: options.path } : {}),
      },
      ...(options?.origin ? { origin: options.origin } : {}),
    })
  },
  terminal(sessionId: string, cwd: string, options?: {
    dock?: 'side' | 'bottom'
    reuse?: boolean
  }) {
    return openWorkspaceTarget({
      sessionId,
      target: {
        kind: 'terminal',
        cwd,
        ...(options?.dock ? { dock: options.dock } : {}),
        ...(options?.reuse ? { reuse: true } : {}),
      },
    })
  },
}
