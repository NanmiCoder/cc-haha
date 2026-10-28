import { useCallback, useState } from 'react'
import { useFocusEffect } from 'expo-router'
import { useConnection } from '../../state/AppContext'
import { modelDisplayName } from '../computer/computerModel'

type Info = { hostId: string; model?: string; expiresAt?: number }

/**
 * 电脑卡状态行里的两个附加信息：新任务默认用的模型名、公网配对的到期时间。
 * 每次首页聚焦时各读一次（从模型页改完回来能看到新值）；读不到就留空，卡片直接省掉那一段，不报错。
 * 读取：GET /api/models/current、公网时 GET /api/public-access/session。
 */
export function useHostCardInfo(enabled: boolean) {
  const { client } = useConnection()
  const [info, setInfo] = useState<Info | null>(null)
  useFocusEffect(
    useCallback(() => {
      if (!client || !enabled) return
      const controller = new AbortController()
      const { signal } = controller
      const hostId = client.host.id
      const put = (patch: Partial<Info>) => {
        if (!signal.aborted)
          setInfo((current) => ({
            ...(current?.hostId === hostId ? current : {}),
            ...patch,
            hostId,
          }))
      }
      client
        .get<{ model?: { id: string; name?: string } }>('/api/models/current', {
          signal,
          timeoutMs: 6000,
        })
        .then((result) => put({ model: modelDisplayName(result.model) || undefined }))
        .catch(() => {})
      if (client.host.auth === 'remote')
        client
          .get<{ authenticated?: boolean; expiresAt?: number }>('/api/public-access/session', {
            signal,
            timeoutMs: 6000,
          })
          .then((result) =>
            put({ expiresAt: result.authenticated ? result.expiresAt : undefined })
          )
          .catch(() => {})
      return () => controller.abort()
    }, [client, enabled])
  )
  return info && info.hostId === client?.host.id ? info : null
}
