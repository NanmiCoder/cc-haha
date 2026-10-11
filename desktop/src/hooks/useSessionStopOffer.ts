import { getMemberWorkState, resolveTeamMemberIdentity } from '../components/agentTeams/agentTeamsModel'
import { hasRunningSubagentTasks } from '../lib/backgroundTasks'
import { useChatStore } from '../stores/chatStore'
import { useTabStore } from '../stores/tabStore'
import { useTeamPlanStore } from '../stores/teamPlanStore'
import { useTeamStore } from '../stores/teamStore'

/**
 * What Stop would stop in this session, if anything: the running turn, or —
 * with the turn idle — background subagents or a running team. A team member's
 * or subagent's own session never offers Stop; its lead owns that.
 *
 * The composer and the 轨迹 toolbar both offer Stop. The rule lives here so the
 * view that hides the composer cannot drift from the one it replaces.
 */
export type SessionStopOffer = 'turn' | 'background' | null

export function useSessionStopOffer(sessionId: string | null | undefined): SessionStopOffer {
  const isMemberSession = useTeamStore((state) => sessionId ? !!state.getMemberBySessionId(sessionId) : false)
  const isSubagentTab = useTabStore((state) =>
    sessionId ? state.tabs.find((tab) => tab.sessionId === sessionId)?.type === 'subagent' : false,
  )
  const turnRunning = useChatStore((state) => sessionId ? (state.sessions[sessionId]?.chatState ?? 'idle') !== 'idle' : false)
  const hasRunningSubagents = useChatStore((state) =>
    sessionId ? hasRunningSubagentTasks(state.sessions[sessionId]?.backgroundAgentTasks) : false,
  )
  // Approved team processes are tracked by their plan, not background-agent
  // notifications. Keep Stop available after the review card is dismissed.
  const teamPlanRunning = useTeamPlanStore((state) => {
    const plan = sessionId ? state.bySession[sessionId]?.plan : undefined
    return plan?.state === 'launching' || plan?.state === 'running'
  })
  // Stop pauses a running team without ending its plan, so the plan alone
  // would keep offering Stop after every member is already stopped.
  const teamMembersAllStopped = useTeamStore((state) => {
    const team = sessionId ? state.workbenchesBySession[sessionId]?.snapshots.at(-1)?.team : undefined
    if (!team) return false
    const members = team.members.filter((member) => !resolveTeamMemberIdentity(team, member.agentId).isLead)
    return members.length > 0 && members.every((member) => {
      const work = getMemberWorkState(member)
      return work === 'stopped' || work === 'exited'
    })
  })
  if (!sessionId || isMemberSession || isSubagentTab) return null
  if (turnRunning) return 'turn'
  if (hasRunningSubagents || (teamPlanRunning && !teamMembersAllStopped)) return 'background'
  return null
}
