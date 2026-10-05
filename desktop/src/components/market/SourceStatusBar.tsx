import { useTranslation } from '../../i18n'
import { StatusDot, type Tone } from '@/components/ui/Badge'
import type { MarketSource, SourceStatusInfo } from '../../types/market'
import { MARKET_SOURCES } from '../../types/market'

const DOT_TONES: Record<SourceStatusInfo['status'], Tone> = {
  ok: 'success',
  degraded: 'warning',
  failed: 'danger',
  cached: 'neutral',
}

function formatTime(ts?: number): string {
  if (!ts) return ''
  try {
    return new Date(ts).toLocaleTimeString()
  } catch {
    return ''
  }
}

export function SourceStatusBar({
  sources,
  className = '',
}: {
  sources: Partial<Record<MarketSource, SourceStatusInfo>>
  className?: string
}) {
  const t = useTranslation()
  return (
    <div
      className={`flex flex-wrap items-center gap-x-4 gap-y-1.5 ${className}`}
      data-testid="market-source-status"
    >
      {MARKET_SOURCES.map((source) => {
        const info = sources[source]
        if (!info) return null
        const statusLabel =
          info.status === 'cached' && info.fetchedAt
            ? t('market.sourceStatus.cachedAt', { time: formatTime(info.fetchedAt) })
            : t(`market.sourceStatus.${info.status}`)
        return (
          <span
            key={source}
            data-testid={`market-source-status-${source}`}
            title={info.error || undefined}
            className="inline-flex items-center gap-1.5 text-xs text-[var(--color-text-secondary)]"
          >
            <StatusDot tone={DOT_TONES[info.status]} size="sm" />
            <span className="font-medium text-[var(--color-text-primary)]">{t(`market.source.${source}`)}</span>
            <span className="text-[var(--color-text-tertiary)]">{statusLabel}</span>
          </span>
        )
      })}
    </div>
  )
}
