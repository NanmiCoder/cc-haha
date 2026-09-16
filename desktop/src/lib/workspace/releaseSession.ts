import { useActivityPanelStore } from '../../stores/activityPanelStore'
import { useWorkspaceContentStore } from '../../stores/workspaceContentStore'
import { useWorkspaceReviewStore } from '../../stores/workspaceReviewStore'
import { useWorkspaceStore } from '../../stores/workspaceStore'

/**
 * Release everything a task owns: its PTYs, its pages, its cached content and
 * its review state.
 *
 * Successful single/batch deletion owns this boundary, including replacement
 * of an empty task. Explicit task closes also call it; repeat calls are safe.
 *
 * Switching away from a task deliberately does NOT come here.
 */
export function releaseWorkspaceSession(sessionId: string): void {
  useWorkspaceStore.getState().clearSession(sessionId)
  useWorkspaceContentStore.getState().clearSession(sessionId)
  useWorkspaceReviewStore.getState().clearSession(sessionId)
  useActivityPanelStore.getState().close(sessionId)
}
