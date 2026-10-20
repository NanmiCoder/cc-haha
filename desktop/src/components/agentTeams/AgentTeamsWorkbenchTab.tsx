import { useEffect } from 'react'
import { ArrowLeft } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { useTranslation } from '../../i18n'
import { useTabStore } from '../../stores/tabStore'
import { useTeamStore } from '../../stores/teamStore'
import { AgentTeamsWorkbench } from './AgentTeamsWorkbench'

/**
 * The detached, full-window form of the workbench. It reads the same
 * per-session timeline the docked panel does, so switching between the two
 * keeps history position and the selected member.
 */
export function AgentTeamsWorkbenchTab({
  tabId,
  leadSessionId,
}: {
  tabId: string
  leadSessionId: string
}) {
  const t = useTranslation()
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
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-[var(--color-surface)]">
      <div className="flex shrink-0 items-center gap-2 border-b border-[var(--color-border)] px-3 py-1.5">
        <Button
          variant="ghost"
          size="sm"
          icon={<ArrowLeft size={14} strokeWidth={2} aria-hidden="true" />}
          onClick={() => useTabStore.getState().returnFromTeamWorkbench(tabId)}
        >
          {t('agentTeams.backToSession')}
        </Button>
      </div>
      <AgentTeamsWorkbench sessionId={leadSessionId} />
    </div>
  )
}
