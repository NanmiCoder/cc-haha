import { useCallback, useState } from 'react'
import { AppState } from 'react-native'
import { useFocusEffect } from 'expo-router'
import { useConnection } from '../../state/AppContext'
import { ApiError } from '../../core/client'
import type { Host } from '../../core/types'
import { errorText } from '../theme'
import type { HostCheck } from './homeModel'

/** 本次打开 App 期间每台电脑最后一次连通的时间，只在内存里。 */
const lastOnline = new Map<string, number>()

/**
 * 每台电脑的连通检查：聚焦时立即检查，之后每 20 秒、回到前台时再查。
 * 公网连接额外读取授权到期时间；在线时读取正在跑和等你的任务数。
 */
export function useHostCheck(host: Host, refresh = 0): HostCheck {
  const { client, error } = useConnection(host.id)
  const [status, setStatus] = useState<HostCheck>({ state: 'checking' })
  useFocusEffect(
    useCallback(() => {
      if (!client) return
      void refresh
      const controller = new AbortController()
      let timer: ReturnType<typeof setTimeout>
      let checking = false
      async function check() {
        if (checking || controller.signal.aborted) return
        checking = true
        try {
          let expiresAt: number | undefined
          if (client!.host.auth === 'remote') {
            const result = await client!.get<{
              authenticated: boolean
              expiresAt?: number
            }>('/api/public-access/session', {
              signal: controller.signal,
              timeoutMs: 6000,
            })
            if (!result.authenticated)
              throw new ApiError('授权已失效，请重新配对', 401)
            expiresAt = result.expiresAt
          } else
            await client!.verify({ signal: controller.signal, timeoutMs: 6000 })
          if (controller.signal.aborted) return
          const checkedAt = Date.now()
          lastOnline.set(client!.host.id, checkedAt)
          setStatus({ state: 'online', expiresAt, checkedAt })
          try {
            const live = await client!.get<{
              sessions: { activityState: string }[]
            }>('/api/sessions/live-status', {
              signal: controller.signal,
              timeoutMs: 6000,
            })
            if (!controller.signal.aborted)
              setStatus({
                state: 'online',
                expiresAt,
                checkedAt,
                waiting: live.sessions.filter((row) => row.activityState === 'waiting').length,
                running: live.sessions.filter((row) => row.activityState === 'running').length,
              })
          } catch {
            /* Older desktops can still be connected without live activity metadata. */
          }
        } catch (failure) {
          if (!controller.signal.aborted)
            setStatus({
              state:
                failure instanceof ApiError && [401, 403].includes(failure.status)
                  ? 'unauthorized'
                  : 'offline',
              message: errorText(failure),
              lastOnlineAt: lastOnline.get(client!.host.id),
            })
        } finally {
          checking = false
          if (!controller.signal.aborted) timer = setTimeout(check, 20000)
        }
      }
      setStatus({ state: 'checking' })
      void check()
      const listener = AppState.addEventListener('change', (state) => {
        if (state === 'active') {
          clearTimeout(timer)
          void check()
        }
      })
      return () => {
        controller.abort()
        clearTimeout(timer)
        listener.remove()
      }
    }, [client, refresh])
  )
  return error ? { state: 'unauthorized', message: error } : status
}
