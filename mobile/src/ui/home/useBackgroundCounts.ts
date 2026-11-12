import { useCallback, useState } from 'react'
import { useFocusEffect } from 'expo-router'
import { useConnection } from '../../state/AppContext'
import { loadHostBackgroundTasks, runningTaskCount } from '../../core/hostActivity'

/**
 * Background task counts of each running session ("background N" on the right of home rows). Only while home is focused, 
 * the computer is online and there are running sessions, read every 10 seconds; sessions that cannot be read show no number.
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
