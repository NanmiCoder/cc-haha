import { useCallback, useState } from 'react'
import { useFocusEffect } from 'expo-router'
import { useConnection } from '../../state/AppContext'
import { loadHostBackgroundTasks, runningTaskCount } from '../../core/hostActivity'

/**
 * 进行中各会话正在跑的后台任务数（首页行右侧的“后台 N”）。只在首页聚焦、
 * 电脑在线且有运行中会话时每 10 秒读一次；读不到的会话不显示数字。
 */
export function useBackgroundCounts(sessionIds: string[], enabled: boolean) {
  const { client } = useConnection()
  const key = sessionIds.join('\n')
  const [counts, setCounts] = useState<{
    hostId: string
    values: Record<string, number>
  } | null>(null)
  useFocusEffect(
    useCallback(() => {
      if (!client || !enabled || !key) return
      const controller = new AbortController()
      let timer: ReturnType<typeof setTimeout> | undefined
      const load = async () => {
        const groups = await loadHostBackgroundTasks(
          client,
          key.split('\n'),
          controller.signal
        )
        if (controller.signal.aborted) return
        setCounts({
          hostId: client.host.id,
          values: Object.fromEntries(
            groups.map((group) => [group.sessionId, runningTaskCount([group])])
          ),
        })
        timer = setTimeout(() => void load(), 10000)
      }
      void load()
      return () => {
        controller.abort()
        clearTimeout(timer)
      }
    }, [client, enabled, key])
  )
  return counts && counts.hostId === client?.host.id ? counts.values : {}
}
