import { useEffect, useId, useState } from 'react'
import { Power } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { useTranslation } from '@/i18n'
import { getDesktopHost } from '@/lib/desktopHost'
import { useIdlePowerStore } from '@/stores/idlePowerStore'

export function IdlePowerStatus() {
  const t = useTranslation()
  const errorId = useId()
  const { snapshot, cancelling, error, cancel } = useIdlePowerStore()
  const countdown = snapshot?.countdown
  const [now, setNow] = useState(Date.now)
  const [dismissed, setDismissed] = useState<string | null>(null)

  useEffect(() => {
    if (!countdown) return
    setNow(Date.now())
    setDismissed(null)
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [countdown])

  if (!getDesktopHost().isDesktop || !snapshot) return null
  const { notice, lastAction } = snapshot
  const messageId = `${notice ?? ''}:${lastAction?.requestedAt ?? ''}:${lastAction?.action ?? ''}:${lastAction?.result ?? ''}`
  if (!countdown && ((!notice && !lastAction) || dismissed === messageId)) return null

  const errorText = error === 'cancel'
    ? t('power.cancelFailed')
    : error === 'load' ? t('settings.general.idlePowerLoadFailed') : null
  const failed = notice === 'failed' || notice === 'unavailable' || lastAction?.result === 'failed'
  const tone = countdown ? 'text-[var(--color-warning)]' : failed ? 'text-[var(--color-error)]' : 'text-[var(--color-info)]'

  return (
    <section
      aria-label={t('power.statusTitle')}
      className="fixed bottom-4 left-1/2 z-[var(--z-toast)] flex w-[min(560px,calc(100vw-32px))] -translate-x-1/2 items-start gap-3 rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface-container-lowest)] p-4 text-[13px] text-[var(--color-text-primary)] shadow-[var(--shadow-dropdown)]"
    >
      <Power size={18} strokeWidth={1.75} aria-hidden="true" className={`mt-0.5 shrink-0 ${tone}`} />
      <div className="min-w-0 flex-1 space-y-2">
        <div role={failed ? 'alert' : 'status'} aria-live={failed ? 'assertive' : 'polite'}>
          {countdown ? (
            <>
              <p className="font-medium">{t('power.countdown', {
                action: t(`power.action.${countdown.action}`),
                seconds: Math.max(0, Math.ceil((countdown.deadline - now) / 1000)),
              })}</p>
              <p className="mt-1 text-xs text-[var(--color-text-secondary)]">{t('power.countdownHint')}</p>
            </>
          ) : (
            <>
              {notice && <p>{t(`power.cancelled.${notice}`)}</p>}
              {lastAction && <p className={notice ? 'mt-1 text-xs text-[var(--color-text-secondary)]' : undefined}>{t(`power.last.${lastAction.result}`, {
                action: t(`power.action.${lastAction.action}`),
              })}</p>}
            </>
          )}
        </div>
        {errorText && <p id={errorId} role="alert" className="text-xs text-[var(--color-error)]">{errorText}</p>}
        {countdown ? (
          <Button size="base" variant="secondary" loading={cancelling} aria-describedby={errorText ? errorId : undefined} onClick={() => void cancel().catch(() => {})}>
            {t('power.cancel')}
          </Button>
        ) : (
          <Button size="sm" variant="ghost" onClick={() => setDismissed(messageId)}>{t('common.dismissNotification')}</Button>
        )}
      </div>
    </section>
  )
}
