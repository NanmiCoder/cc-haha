import { useEffect, useRef, useState } from 'react'
import { adaptersApi, type WechatRuntimeSnapshot } from '../../api/adapters'
import { getDesktopHost } from '../../lib/desktopHost'
import { useTranslation } from '../../i18n'
import { Button } from '../../components/ui/Button'
import { StatusDot } from '../../components/ui/Badge'

const stateKeys = {
  stopped: 'settings.adapters.wechatHealthStopped',
  starting: 'settings.adapters.wechatHealthStarting',
  online: 'settings.adapters.wechatHealthOnline',
  reconnecting: 'settings.adapters.wechatHealthReconnecting',
  auth_expired: 'settings.adapters.wechatHealthAuthExpired',
  error: 'settings.adapters.wechatHealthError',
  stale: 'settings.adapters.wechatHealthStale',
} as const

export function WechatConnectionStatus({ paired }: { paired: boolean }) {
  const t = useTranslation()
  const [snapshot, setSnapshot] = useState<WechatRuntimeSnapshot | null>(null)
  const [unreachable, setUnreachable] = useState(false)
  const [restarting, setRestarting] = useState(false)
  const [restartFailed, setRestartFailed] = useState(false)
  const revision = useRef(0)
  const mounted = useRef(true)
  const reconnecting = useRef(false)
  const host = getDesktopHost()

  useEffect(() => {
    mounted.current = true
    let disposed = false
    let timer: ReturnType<typeof setTimeout>
    const refresh = async () => {
      if (reconnecting.current) { timer = setTimeout(refresh, 5_000); return }
      const version = revision.current
      try {
        const next = await adaptersApi.getWechatRuntime()
        if (disposed || !mounted.current || version !== revision.current) return
        setSnapshot(next)
        setUnreachable(false)
      } catch {
        if (!disposed && mounted.current && version === revision.current) setUnreachable(true)
      } finally {
        if (!disposed && mounted.current) timer = setTimeout(refresh, 5_000)
      }
    }
    void refresh()
    return () => { disposed = true; mounted.current = false; clearTimeout(timer); revision.current++ }
  }, [])

  const reconnect = async () => {
    if (reconnecting.current) return
    reconnecting.current = true
    revision.current++
    setRestarting(true)
    setRestartFailed(false)
    setSnapshot({ state: 'starting', serverReachable: false })
    try {
      await host.adapters.restartSidecar('wechat')
      if (!mounted.current) return
      const next = await adaptersApi.getWechatRuntime()
      if (mounted.current) { setSnapshot(next); setUnreachable(false) }
    } catch {
      if (mounted.current) { setRestartFailed(true); setSnapshot({ state: 'error', serverReachable: false }) }
    } finally {
      reconnecting.current = false
      if (mounted.current) setRestarting(false)
    }
  }
  const online = !unreachable && snapshot?.state === 'online'
  const formatTime = (timestamp?: number) => timestamp ? new Date(timestamp).toLocaleString() : t('settings.adapters.wechatHealthNever')
  return (
    <div className="border-t border-[var(--color-border)] px-4 py-3.5" aria-live="polite">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <StatusDot tone={online ? 'success' : unreachable || snapshot?.state === 'error' || snapshot?.state === 'auth_expired' ? 'danger' : 'neutral'} />
          <span>{unreachable ? t('settings.adapters.wechatHealthServerOffline') : snapshot ? t(stateKeys[snapshot.state]) : t('settings.adapters.wechatHealthChecking')}</span>
        </div>
        {host.isDesktop && <Button size="sm" variant="secondary" loading={restarting} onClick={() => void reconnect()}>{t('settings.adapters.wechatHealthReconnect')}</Button>}
      </div>
      <p className="mt-2 text-xs text-[var(--color-text-secondary)]">{paired ? t('settings.adapters.wechatHealthPaired') : t('settings.adapters.wechatHealthUnpaired')}</p>
      <p className="mt-1 text-xs text-[var(--color-text-secondary)]">{t('settings.adapters.wechatHealthLastReceive')}: {formatTime(snapshot?.lastReceiveAt)} · {t('settings.adapters.wechatHealthLastSend')}: {formatTime(snapshot?.lastSendAt)}</p>
      {restartFailed && <p role="alert" className="mt-2 text-sm">{t('settings.adapters.wechatHealthRestartFailed')}</p>}
    </div>
  )
}
