import { useEffect, useState } from 'react'
import type { ApiClient } from '../../core/client'
import type { TeamsSetting } from './runLogic'

/**
 * 电脑设置里有没有开 Agent 团队。`epoch` 变化时（每次打开运行方式）重新读取；
 * 读到「已关闭」而草稿里还留着团队时，立刻关掉，免得发出去的消息带着不会生效的团队要求。
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
