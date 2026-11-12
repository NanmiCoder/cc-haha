import { useEffect, useState } from 'react'
import type { ApiClient } from '../../core/client'
import type { TeamsSetting } from './runLogic'

/**
 * Whether agent teams are enabled in the computer settings. Reread when `epoch` changes (every time run mode opens); 
 * when "disabled" is read while the draft still has a team, turn it off immediately so the sent message does not carry a team request that will not take effect.
 */
export function useTeamsSetting(
  client: ApiClient | null,
  epoch: number,
  armed: boolean,
  onDisarm: () => void
): TeamsSetting {
  const [setting, setSetting] = useState<TeamsSetting>('unknown')
  useEffect(() => {
    if (!client) return
    const controller = new AbortController()
    client
      .get<{ agentTeamsEnabled?: boolean }>('/api/settings/user', { signal: controller.signal })
      .then((value) => {
        if (!controller.signal.aborted) setSetting(value.agentTeamsEnabled === false ? 'off' : 'on')
      })
      .catch(() => {
        if (!controller.signal.aborted) setSetting('error')
      })
    return () => controller.abort()
  }, [client, epoch])
  useEffect(() => {
    if (setting === 'off' && armed) onDisarm()
  }, [setting, armed, onDisarm])
  return setting
}
