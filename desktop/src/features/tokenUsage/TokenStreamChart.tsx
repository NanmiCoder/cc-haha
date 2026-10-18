import { useMemo } from 'react'

import type { Locale } from '../../i18n'
import { useTranslation } from '../../i18n'
import { formatTokenAmount, formatTokenAmountExact } from './formatTokenUnits'
import { formatDateLabel, formatMonthName, formatShortDate, parseLocalDate } from './heatmapModel'
import { buildStreamGeometry, seriesColor, type DailyModelSeries, type RankedModel } from './usageModel'

const WIDTH = 928
const HEIGHT = 300

type Props = {
  days: DailyModelSeries[]
  models: RankedModel[]
  locale: Locale
  className?: string
}

/**
 * The last 90 days as one stream, split by model. It reads as rhythm and mix —
 * which models carried which stretch — and prints the real peak instead of a
 * scale; every day's own figure is on hover.
 */
export function TokenStreamChart({ days, models, locale, className }: Props) {
  const t = useTranslation()
  const geometry = useMemo(() => buildStreamGeometry(days, WIDTH, HEIGHT), [days])
  const slot = WIDTH / Math.max(days.length, 1)
  const first = days[0]
  const last = days[days.length - 1]
  const peak = geometry.peak

  // Usage older than the window still counts toward the page, but there is nothing to draw for it here.
  if (!peak) {
    return (
      <div className={className}>
        <p className="border-y border-[var(--color-border)] py-10 text-center text-xs text-[var(--color-text-tertiary)]">
          {t('settings.activity.streamEmpty')}
        </p>
      </div>
    )
  }

  return (
    <div className={className}>
      <div className="relative">
        <svg
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          role="img"
          aria-label={t('settings.activity.streamLabel')}
          className="block h-auto w-full overflow-visible"
        >
          {geometry.layers.map((layer) => {
            const model = models[layer.modelIndex]
            return (
              <path
                key={model?.id ?? layer.modelIndex}
                d={layer.d}
                fill={seriesColor(model?.series ?? 1)}
                stroke="var(--color-surface)"
                strokeWidth={1.5}
                strokeLinejoin="round"
              />
            )
          })}
          {peak ? (
            <g data-testid="stream-peak-marker">
              <circle cx={peak.x} cy={peak.y} r={4} fill="var(--color-text-primary)" stroke="var(--color-surface)" strokeWidth={2} />
              <line x1={peak.x} x2={peak.x} y1={peak.y} y2={Math.max(peak.y - 24, 0)} stroke="var(--color-text-primary)" strokeWidth={1} />
            </g>
          ) : null}
          {days.map((day, index) => (
            <rect key={day.date} x={index * slot} y={0} width={slot} height={HEIGHT} fill="transparent">
              <title>{`${formatDateLabel(day.date, locale)} · ${formatTokenAmount(day.total, locale).text} ${t('settings.activity.tokens')} (${formatTokenAmountExact(day.total)})`}</title>
            </rect>
          ))}
        </svg>
        {/* HTML, not SVG text: the viewBox scales with the pane, and a label that shrinks with it stops being legible. */}
        {peak ? (
          <span
            data-testid="stream-peak"
            className="pointer-events-none absolute whitespace-nowrap text-[13px] font-medium text-[var(--color-text-primary)]"
            style={{
              left: `${(peak.x / WIDTH) * 100}%`,
              top: `${(Math.max(peak.y - 30, 0) / HEIGHT) * 100}%`,
              transform: peak.x > WIDTH * 0.7 ? 'translate(-100%, -100%)' : 'translate(-50%, -100%)',
            }}
          >
            {t('settings.activity.peakOn', {
              amount: formatTokenAmount(peak.total, locale).text,
              date: formatShortDate(peak.date, locale),
            })}
          </span>
        ) : null}
      </div>

      <div aria-hidden="true" className="relative mt-1.5 h-5 border-t border-[var(--color-border)] font-mono text-[11px] text-[var(--color-text-tertiary)]">
        {geometry.monthTicks.map((tick) => (
          <span
            key={tick.date}
            className="absolute top-1.5 -translate-x-1/2 whitespace-nowrap"
            style={{ left: `${tick.fraction * 100}%` }}
          >
            {formatMonthName(parseLocalDate(tick.date), locale)}
          </span>
        ))}
        {last ? (
          <span className="absolute right-0 top-1.5 whitespace-nowrap">{formatShortDate(last.date, locale)}</span>
        ) : null}
      </div>
      {first && last ? <span className="sr-only">{`${formatDateLabel(first.date, locale)} – ${formatDateLabel(last.date, locale)}`}</span> : null}

      <ul className="mt-4 flex flex-wrap gap-x-5 gap-y-2 text-xs text-[var(--color-text-tertiary)]">
        {models.map((model) => (
          <li key={model.id} className="inline-flex items-center gap-2">
            <span aria-hidden="true" className="h-2.5 w-2.5 rounded-full" style={{ background: seriesColor(model.series) }} />
            <span className="text-[var(--color-text-primary)]">{model.label}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}
