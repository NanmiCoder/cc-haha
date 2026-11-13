import type { AppState } from '../../state/AppState.js'
import type { TeamFile } from './teamHelpers.js'
import { readTeamRuntimeControlSync, teamControlIdentity } from './teamRuntimeControlStore.js'

/** Host snapshots carry an identity, not a mutable copy of the team's state. */
export function buildTeamRuntimeSnapshot(
  team: TeamFile | null,
  expectedCreatedAt: number,
  sessionId: string,
  teamFilePath: string,
): NonNullable<AppState['teamContext']> {
  if (!team || team.createdAt !== expectedCreatedAt || team.leadSessionId !== sessionId) {
    throw new Error('Stale or foreign team runtime snapshot')
  }
  return {
    teamName: team.name, teamFilePath, leadAgentId: team.leadAgentId, isLeader: true,
    teammates: Object.fromEntries(team.members.map(member => [member.agentId, {
      name: member.name, agentType: member.agentType, cwd: member.cwd,
      tmuxSessionName: member.backendType === 'process' ? 'process' : '', tmuxPaneId: member.tmuxPaneId,
      spawnedAt: member.joinedAt,
    }])),
  }
}

/** A reconnect restores the roster, never authority to consume held mail. */
export function teamRuntimeSnapshotHoldsMail(team: TeamFile): boolean {
  if (!team.reviewRequired) return false
  const control = readTeamRuntimeControlSync(team.name, teamControlIdentity(team))
  return !control || control.status !== 'running'
}

/** A fresh human action must still be the durable action when the CLI sees it. */
export function confirmTeamRuntimeResume(
  team: TeamFile | null,
  sessionId: string,
  request: { team_name: string; created_at: number; incarnation_id: string; epoch: number; request_id: string },
): { team_name: string; incarnation_id: string; epoch: number; request_id: string } {
  if (!team || team.name !== request.team_name || team.createdAt !== request.created_at || team.leadSessionId !== sessionId) throw new Error('Stale or foreign team resume')
  const identity = teamControlIdentity(team)
  const control = readTeamRuntimeControlSync(team.name, identity)
  if (!control || identity.incarnationId !== request.incarnation_id || control.status !== 'resuming' || control.epoch !== request.epoch || control.resume?.epoch !== request.epoch || control.resume.requestId !== request.request_id) throw new Error('Team resume intent changed; the team remains paused')
  return { team_name: team.name, incarnation_id: identity.incarnationId, epoch: control.epoch, request_id: control.resume.requestId }
}
