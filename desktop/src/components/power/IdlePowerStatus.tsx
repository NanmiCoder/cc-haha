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
  const statusRing = countdown ? 'v6c-ring-waiting' : failed ? 'v6c-ring-error' : 'v6c-ring-running'
  const iconChipTone = countdown
    ? 'bg-[var(--color-warning-container)] text-[var(--color-on-warning-container)]'
    : failed
      ? 'bg-[var(--color-error-container)] text-[var(--color-on-error-container)]'
      : 'bg-[var(--color-info-container)] text-[var(--color-on-info-container)]'

  return (
    <section
      aria-label={t('power.statusTitle')}
      className={`surface-glass v6c-glass-card ${statusRing} animate-overlay-in fixed bottom-4 left-1/2 z-[var(--z-toast)] flex w-[min(560px,calc(100vw-32px))] -translate-x-1/2 items-start gap-3 rounded-[var(--radius-lg)] border border-[var(--color-surface-glass-border)] p-3.5 text-[13px] text-[var(--color-text-primary)]`}
    >
      <span
        aria-hidden="true"
        className={`mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-[var(--radius-control)] ${iconChipTone}`}
      >
        <Power size={16} strokeWidth={1.75} aria-hidden="true" />
      </span>
      <div className="min-w-0 flex-1 space-y-2">
        <div role={failed ? 'alert' : 'status'} aria-live={failed ? 'assertive' : 'polite'}>
          {countdown ? (
            <>
              <p className="font-medium tabular-nums">{t('power.countdown', {
                action: t(`power.action.${countdown.action}`),
                seconds: Math.max(0, Math.ceil((countdown.deadline - now) / 1000)),
              })}</p>
              <p className="mt-1 text-[12px] text-[var(--color-text-secondary)]">{t('power.countdownHint')}</p>
            </>
          ) : (
            <>
              {notice && <p>{t(`power.cancelled.${notice}`)}</p>}
              {lastAction && <p className={notice ? 'mt-1 text-[12px] text-[var(--color-text-secondary)]' : undefined}>{t(`power.last.${lastAction.result}`, {
                action: t(`power.action.${lastAction.action}`),
              })}</p>}
            </>
          )}
        </div>
        {errorText && <p id={errorId} role="alert" className="text-[12px] text-[var(--color-error)]">{errorText}</p>}
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
