import { useEffect } from 'react'
import { useTeamStore } from '../../stores/teamStore'
import { AgentTeamsWorkbench } from './AgentTeamsWorkbench'

/**
 * The detached, full-window form of the workbench. It reads the same
 * per-session timeline the docked panel does, so switching between the two
 * keeps history position and the selected member. The way back to the
 * session is the window header's breadcrumb.
 */
export function AgentTeamsWorkbenchTab({
  leadSessionId,
}: {
  leadSessionId: string
}) {
  const hasTimeline = useTeamStore((state) =>
    Boolean(state.workbenchesBySession[leadSessionId]?.snapshots.length),
  )
  const fetchTeamForSession = useTeamStore((state) => state.fetchTeamForSession)

  // Restoring straight into this tab (or opening it for a session whose team
  // was never fetched) leaves the store empty, so pull the timeline here too.
  useEffect(() => {
    if (hasTimeline) return
    void fetchTeamForSession(leadSessionId)
  }, [fetchTeamForSession, hasTimeline, leadSessionId])

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-[var(--color-surface)]">
      <AgentTeamsWorkbench sessionId={leadSessionId} />
    </div>
  )
}
