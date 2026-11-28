import { getMemberWorkState, resolveTeamMemberIdentity } from '../components/agentTeams/agentTeamsModel'
import type { TeamWorkbenchSnapshot } from '../types/team'

/**
 * Whether an Agent Team is still working on behalf of a lead session whose own
 * turn may be idle (#1524). Stop, the tab's running dot and the close-tab
 * confirmation all ask this, so they cannot disagree about what "running" means.
 *
 * It takes the raw inputs rather than reading stores so a selector can read
 * each store separately and stay cheap: neither touches the transcript.
 */

/** An approved plan whose team was launched and has not ended. */
export function isTeamPlanActive(plan: { state: string } | null | undefined): boolean {
  return plan?.state === 'launching' || plan?.state === 'running'
}

/**
 * Stop pauses a running team without ending its plan, so the plan alone keeps
 * saying "running" after every member is already stopped or exited. False when
 * there is no roster to judge by.
 */
export function areTeamMembersAllStopped(team: TeamWorkbenchSnapshot['team'] | null | undefined): boolean {
  if (!team) return false
  const members = team.members.filter((member) => !resolveTeamMemberIdentity(team, member.agentId).isLead)
  return members.length > 0 && members.every((member) => {
    const work = getMemberWorkState(member)
    return work === 'stopped' || work === 'exited'
  })
}

export const ANTIGRAVITY_SWARM_TEAM_PREFIX = 'agy-swarm-'

export function isAntigravitySwarmTeamName(name: string | null | undefined): boolean {
  return typeof name === 'string' && name.startsWith(ANTIGRAVITY_SWARM_TEAM_PREFIX)
}

type TeamRunningSnapshot = Pick<TeamWorkbenchSnapshot, 'team'> & { deletedAt?: string }

/**
 * Antigravity native Swarms do not use cc-haha's Claude TeamPlan store; a swarm
 * is actively working in the background whenever any non-lead worker is mid-turn.
 */
export function isAntigravitySwarmRunning(
  snapshot: TeamRunningSnapshot | null | undefined,
): boolean {
  if (!snapshot || snapshot.deletedAt || !isAntigravitySwarmTeamName(snapshot.team.name)) {
    return false
  }
  return snapshot.team.members.some((member) => (
    !resolveTeamMemberIdentity(snapshot.team, member.agentId).isLead &&
    getMemberWorkState(member) === 'working'
  ))
}

/**
 * An Antigravity Swarm is paused when all non-lead workers are stopped/exited
 * and at least one unfinished worker is explicitly stopped (not permanently killed).
 */
export function isAntigravitySwarmPaused(
  snapshot: TeamRunningSnapshot | null | undefined,
): boolean {
  if (!snapshot || snapshot.deletedAt || !isAntigravitySwarmTeamName(snapshot.team.name)) {
    return false
  }
  const members = snapshot.team.members.filter((member) => !resolveTeamMemberIdentity(snapshot.team, member.agentId).isLead)
  if (members.length === 0 || !areTeamMembersAllStopped(snapshot.team)) return false
  return members.some((member) => getMemberWorkState(member) === 'stopped')
}

export function isTeamRunning(
  plan: { state: string } | null | undefined,
  snapshot: TeamRunningSnapshot | null | undefined,
): boolean {
  return (isTeamPlanActive(plan) && !areTeamMembersAllStopped(snapshot?.team)) || isAntigravitySwarmRunning(snapshot)
}
