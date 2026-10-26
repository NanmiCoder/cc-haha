import { getAgentProfile } from '../../utils/agentProfile.js'
import { isSessionBridgeAvailable } from '../SessionCollaborationTool/bridge.js'

export function isDesktopScheduleAvailable(): boolean {
  return getAgentProfile() !== 'lean' && isSessionBridgeAvailable()
}
