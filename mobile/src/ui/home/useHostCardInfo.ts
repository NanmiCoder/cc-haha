import { useCallback, useState } from 'react'
import { useFocusEffect } from 'expo-router'
import { useConnection } from '../../state/AppContext'
import { modelDisplayName } from '../computer/computerModel'

type Info = { hostId: string; model?: string; expiresAt?: number }

/**
 * Two extra pieces of info in the computer card status line: the default model for new tasks and the public pairing expiry.
 * Read each once every time home gains focus (new values show after returning from the model page); left empty when unavailable, and the card simply omits that segment without errors.
 * Reads: GET /api/models/current, and GET /api/public-access/session when public.
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
