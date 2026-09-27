import type { AppState } from '../../state/AppState.js'
import type { TeamFile } from './teamHelpers.js'

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
