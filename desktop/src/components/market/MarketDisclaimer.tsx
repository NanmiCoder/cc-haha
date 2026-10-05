import { useState } from 'react'
import { ShieldAlert, X } from 'lucide-react'
import { useTranslation } from '../../i18n'
import { IconButton } from '@/components/ui/IconButton'

const STORAGE_KEY = 'cc-haha-market-disclaimer-dismissed'

function readDismissed(): boolean {
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem(STORAGE_KEY) === '1'
  } catch {
    return false
  }
}

/**
 * Top-of-market disclaimer: skills come from third-party sources and are not
 * audited locally — users should review (ideally AI-scan) them before install.
 * Dismissal is persisted so it only shows until acknowledged.
 */
export function MarketDisclaimer() {
  const t = useTranslation()
  const [dismissed, setDismissed] = useState(readDismissed)

  if (dismissed) return null

  return (
    <div
      role="note"
      data-testid="market-disclaimer"
      className="flex items-start gap-2 rounded-[var(--radius-md)] bg-[var(--color-warning-container)] py-2 pl-3 pr-1.5 text-[var(--color-on-warning-container)]"
    >
      {/* A caution, so the shared "needs your attention" tone rather than the
          brand wash: terracotta marks the brand and selection, never a state. */}
      <ShieldAlert className="mt-[3px] flex-shrink-0" size={14} strokeWidth={1.75} aria-hidden="true" />
      <p className="min-w-0 flex-1 text-[13px] leading-5">
        <span className="font-medium">{t('market.disclaimer.title')}</span>{' '}
        {t('market.disclaimer.body')}
      </p>
      <IconButton
        icon={<X size={14} strokeWidth={1.75} aria-hidden="true" />}
        label={t('market.disclaimer.dismiss')}
        tone="muted"
        size="xs"
        onClick={() => {
          setDismissed(true)
          try {
            localStorage.setItem(STORAGE_KEY, '1')
          } catch {
            // Persisting is best-effort; the banner stays dismissed for this session.
          }
        }}
      />
    </div>
  )
}
