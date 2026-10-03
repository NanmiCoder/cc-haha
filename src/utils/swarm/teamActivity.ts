import type { AppState } from '../../state/AppState.js'
import { hasWorkingInProcessTeammates, isTeamLead } from '../teammate.js'
import { TEAM_LEAD_NAME } from './constants.js'
import { readTeamFile } from './teamHelpers.js'

/**
 * Whether a team lead still has members doing work it is waiting for: an
 * in-process teammate mid-turn, or a desktop process member that is mid-turn
 * or scheduled for an automatic retry (the server records both in the team
 * file). Their results reach the lead as teammate messages, which start a new
 * lead turn when the current one has ended.
 */
export function hasTeamWorkInProgress(appState: AppState): boolean {
  const team = appState.teamContext
  if (!team || !isTeamLead(team)) return false
  if (hasWorkingInProcessTeammates(appState)) return true
  const teamFile = readTeamFile(team.teamName)
  return !!teamFile?.members.some(member =>
    member.name !== TEAM_LEAD_NAME &&
    member.backendType === 'process' &&
    member.terminated !== true &&
    (member.isActive === true || member.autoRetry !== undefined),
  )
}
