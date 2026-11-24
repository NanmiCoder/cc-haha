import { useId, type CSSProperties } from 'react'
import { X } from 'lucide-react'

import { IconButton } from '@/components/ui/IconButton'
import { useTranslation, type Locale } from '../../i18n'
import { formatTokenAmount } from './formatTokenUnits'
import { DATE_LOCALES, formatDayHeading } from './heatmapModel'
import { tokenAmountTitle } from './TokenAmount'
import { formatShare, seriesColor, type DaySummary } from './usageModel'

type Props = {
  day: DaySummary
  locale: Locale
  onClose: () => void
  /** Where the stream places it: `left` and `width`, so the card stays beside the day it describes. */
  style: CSSProperties
}

/**
 * One day of the stream, opened: its total against the busiest day and the
 * average one, which models carried it, and what the day was spent on.
 */
export function TokenDayCard({ day, locale, onClose, style }: Props) {
  const t = useTranslation()
  const headingId = useId()
  const total = formatTokenAmount(day.total, locale)
  const count = new Intl.NumberFormat(DATE_LOCALES[locale])

  const stats = [
    { label: t('settings.activity.sessions'), value: day.sessionCount },
    { label: t('settings.activity.messages'), value: day.messageCount },
    { label: t('settings.activity.totalToolCalls'), value: day.toolCallCount },
  ]

  return (
    <div
      role="group"
      aria-labelledby={headingId}
      data-testid="stream-day-card"
      className="absolute top-2 z-[var(--z-raised)] rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] p-4 shadow-[var(--shadow-dropdown)]"
      style={style}
    >
      <div className="flex items-center justify-between gap-2">
        <div id={headingId} className="min-w-0 truncate text-[13px] font-medium text-[var(--color-text-primary)]">
          {formatDayHeading(day.date, locale)}
        </div>
        <IconButton
          icon={<X size={14} strokeWidth={1.75} aria-hidden="true" />}
          label={t('settings.activity.day.close')}
          size="sm"
          tone="muted"
          showTooltip={false}
          onClick={onClose}
        />
      </div>

      <div className="mt-3 flex items-baseline gap-1.5 tabular-nums" title={tokenAmountTitle(day.total, locale)}>
        <span data-testid="stream-day-total" className="text-[26px] font-medium leading-[1.1] tracking-[-0.02em] text-[var(--color-text-primary)]">
          {total.value}
        </span>
        {total.unit ? <span className="text-[15px] font-medium text-[var(--color-brand)]">{total.unit}</span> : null}
      </div>

      {/* The bar is this day against the busiest one; the notch is the average active day. */}
      <div aria-hidden="true" className="relative mt-3 h-1.5 rounded-full bg-[var(--color-surface-container)]">
        <div className="h-full rounded-full bg-[var(--color-text-primary)]" style={{ width: `${day.ofPeak * 100}%` }} />
        <div
          className="absolute -top-[3px] h-3 w-0.5 bg-[var(--color-brand)]"
          style={{ left: `${Math.min(day.average / day.peak, 1) * 100}%` }}
        />
      </div>
      <div className="mt-1.5 flex items-center justify-between gap-2 font-mono text-[11px] text-[var(--color-text-tertiary)]">
        <span>
          {t('settings.activity.day.rankOfPeak', { rank: day.rank, percent: formatShare(day.total, day.peak, locale) })}
        </span>
        <span className="text-[var(--color-brand)]">
          {t('settings.activity.day.average', { amount: formatTokenAmount(day.average, locale).text })}
        </span>
      </div>

      <div aria-hidden="true" className="mt-3.5 flex h-2 gap-0.5">
        {day.models.map((model) => (
          <div
            key={model.id}
            className="min-w-px rounded-[var(--radius-xs)]"
            style={{ width: `${model.share * 100}%`, background: seriesColor(model.series) }}
          />
        ))}
      </div>
      <ul className="mt-2.5 grid gap-1.5">
        {day.models.map((model) => (
          <li key={model.id} className="flex items-center gap-2 text-xs leading-4">
            <span aria-hidden="true" className="h-2 w-2 shrink-0 rounded-full" style={{ background: seriesColor(model.series) }} />
            <span className="min-w-0 flex-1 truncate text-[var(--color-text-secondary)]">
              {model.foldedCount ? t('settings.activity.moreModels', { count: model.foldedCount }) : model.label}
            </span>
            <span className="font-medium tabular-nums text-[var(--color-text-primary)]">{formatTokenAmount(model.tokens, locale).text}</span>
            <span className="w-9 text-right font-mono text-[11px] text-[var(--color-text-tertiary)]">{formatShare(model.tokens, day.total, locale)}</span>
          </li>
        ))}
      </ul>

      <dl className="mt-3.5 grid grid-cols-3 gap-2 border-t border-[var(--color-border)] pt-3">
        {stats.map((stat) => (
          <div key={stat.label} className="min-w-0">
            <dt className="truncate text-[11px] text-[var(--color-text-tertiary)]">{stat.label}</dt>
            <dd className="m-0 mt-0.5 text-[15px] font-medium tabular-nums text-[var(--color-text-primary)]">{count.format(stat.value)}</dd>
          </div>
        ))}
      </dl>
    </div>
  )
}
