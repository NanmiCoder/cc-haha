import { listPendingPermissions, type PerSessionState } from '../stores/chatStore'

type AttentionSource = Pick<PerSessionState, 'pendingPermission' | 'pendingPermissions'>

/**
 * Whether a session is parked on a decision only the user can make: a tool
 * approval, an AskUserQuestion card or an ExitPlanMode review. All three arrive
 * as `permission_request` and land in the same records that PermissionDialog,
 * AskUserQuestion and the composer render from, so a marker built on this can
 * never disagree with the card behind the tab.
 *
 * It reads the records, not `chatState`. `status(tool_executing)`,
 * `session_state(running)` and `content_start` overwrite `chatState` while the
 * request is still open, which switched a state-based marker off under a card
 * that was still waiting. Computer Use records are left out on purpose: nothing
 * renders them, so counting them would light a marker with no card to answer.
 *
 * This is the one place that decides. The window header, both sidebar views and
 * the mobile header all call it; a surface that grows its own rule will drift.
 */
export function sessionNeedsAttention(session: AttentionSource | undefined): boolean {
  return listPendingPermissions(session).length > 0
}

/** The ids among `ids` (every session by default) that are waiting on the user. */
export function collectAttentionIds(
  sessions: Readonly<Record<string, AttentionSource | undefined>>,
  ids: readonly string[] = Object.keys(sessions),
): string[] {
  return ids.filter((id) => sessionNeedsAttention(sessions[id]))
}

/**
 * The next waiting session after `activeId` in `orderedIds` (the sidebar's
 * order), wrapping past the end and never returning `activeId` itself. An
 * `activeId` that is not in the list (Settings, the new-session page) starts
 * from the first entry.
 */
export function nextAttentionSessionId(
  orderedIds: readonly string[],
  attentionIds: ReadonlySet<string>,
  activeId: string | null,
): string | null {
  const start = activeId ? orderedIds.indexOf(activeId) : -1
  for (let step = 1; step <= orderedIds.length; step += 1) {
    const id = orderedIds[(start + step) % orderedIds.length]
    if (id !== undefined && id !== activeId && attentionIds.has(id)) return id
  }
  return null
}
