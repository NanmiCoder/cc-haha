import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'

import { cx } from '@/lib/cx'
import type { Locale } from '../../i18n'
import { useTranslation } from '../../i18n'
import { formatTokenAmount, formatTokenAmountExact } from './formatTokenUnits'
import { formatDateLabel, formatMonthName, formatShortDate, parseLocalDate } from './heatmapModel'
import { TokenDayCard } from './TokenDayCard'
import {
  buildStreamGeometry,
  seriesColor,
  summarizeDay,
  type DailyModelSeries,
  type DayActivity,
  type RankedModel,
} from './usageModel'

const WIDTH = 928
const HEIGHT = 300
const CARD_WIDTH = 296
/** Space between the chosen day's line and the card beside it. */
const CARD_GAP = 14

type Props = {
  days: DailyModelSeries[]
  models: RankedModel[]
  /** Sessions, messages and tool calls per date, for the day card. */
  activity: ReadonlyMap<string, DayActivity>
  locale: Locale
  className?: string
}

/**
 * The last 90 days as one stream, split by model. It reads as rhythm and mix —
 * which models carried which stretch — and prints the real peak instead of a
 * scale. Pointing at a day marks it with its figure; clicking pins a card with
 * that day's detail, and clicking it again (or Esc) puts it away.
 */
export function TokenStreamChart({ days, models, activity, locale, className }: Props) {
  const t = useTranslation()
  const geometry = useMemo(() => buildStreamGeometry(days, WIDTH, HEIGHT), [days])
  const frameRef = useRef<HTMLDivElement | null>(null)
  const dayButtons = useRef(new Map<string, HTMLButtonElement>())
  const [frameWidth, setFrameWidth] = useState(WIDTH)
  const [selectedDate, setSelectedDate] = useState<string | null>(null)
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null)

  const first = days[0]
  const last = days[days.length - 1]
  const peak = geometry.peak
  const hasChart = peak !== null

  // The card is placed in pixels so it can stay inside a narrow pane.
  useEffect(() => {
    const element = frameRef.current
    if (!element) return
    const update = () => {
      if (element.clientWidth > 0) setFrameWidth(element.clientWidth)
    }
    update()
    if (typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(update)
      observer.observe(element)
      return () => observer.disconnect()
    }
    window.addEventListener('resize', update)
    return () => window.removeEventListener('resize', update)
  }, [hasChart])

  const selectedIndex = selectedDate === null ? -1 : days.findIndex((day) => day.date === selectedDate)
  const summary = useMemo(
    () => (selectedIndex >= 0 ? summarizeDay(days, selectedIndex, models, activity) : null),
    [days, selectedIndex, models, activity],
  )

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

  const slot = WIDTH / (days.length - 1)
  const xAt = (index: number) => index * slot
  const hovered = hoveredIndex === null ? undefined : days[hoveredIndex]
  const showHover = hoveredIndex !== null && hovered !== undefined && hovered.total > 0 && hovered.date !== summary?.date

  const closeCard = () => {
    const date = summary?.date
    setSelectedDate(null)
    if (date) dayButtons.current.get(date)?.focus()
    // Handing focus back is not the pointer arriving on that day. Its focus handler just asked for a
    // preview, and a pointer sitting on the card's x would never send the leave that clears it.
    setHoveredIndex(null)
  }
  const toggleDay = (index: number) => {
    const day = days[index]
    if (!day || day.total <= 0) return
    setSelectedDate((current) => (current === day.date ? null : day.date))
  }
  const handleKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape' && summary) closeCard()
  }

  const cardWidth = Math.min(CARD_WIDTH, frameWidth)
  const anchorX = selectedIndex >= 0 ? (selectedIndex / (days.length - 1)) * frameWidth : 0
  const fitsRight = anchorX + CARD_GAP + cardWidth <= frameWidth
  const cardLeft = Math.max(0, Math.min(frameWidth - cardWidth, fitsRight ? anchorX + CARD_GAP : anchorX - CARD_GAP - cardWidth))
  const selectedX = xAt(selectedIndex)

  return (
    <div className={className}>
      <div ref={frameRef} className="relative" onKeyDown={handleKeyDown}>
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
          <g data-testid="stream-peak-marker">
            <circle cx={peak.x} cy={peak.y} r={4} fill="var(--color-text-primary)" stroke="var(--color-surface)" strokeWidth={2} />
            <line x1={peak.x} x2={peak.x} y1={peak.y} y2={Math.max(peak.y - 24, 0)} stroke="var(--color-text-primary)" strokeWidth={1} />
          </g>
          {summary ? (
            <g data-testid="stream-selection" pointerEvents="none">
              <rect x={0} y={0} width={Math.max(selectedX - slot / 2, 0)} height={HEIGHT} fill="var(--color-surface)" fillOpacity={0.55} />
              <rect x={selectedX + slot / 2} y={0} width={Math.max(WIDTH - selectedX - slot / 2, 0)} height={HEIGHT} fill="var(--color-surface)" fillOpacity={0.55} />
              <line x1={selectedX} x2={selectedX} y1={0} y2={HEIGHT} stroke="var(--color-text-primary)" strokeWidth={1} />
              <circle cx={selectedX} cy={geometry.dayTops[selectedIndex]} r={4.5} fill="var(--color-text-primary)" stroke="var(--color-surface)" strokeWidth={2} />
            </g>
          ) : null}
          {showHover ? (
            <line
              data-testid="stream-hover-line"
              x1={xAt(hoveredIndex)}
              x2={xAt(hoveredIndex)}
              y1={0}
              y2={HEIGHT}
              stroke="var(--color-text-primary)"
              strokeWidth={1}
              strokeDasharray="3 3"
              pointerEvents="none"
            />
          ) : null}
        </svg>

        {/* HTML, not SVG text: the viewBox scales with the pane, and a label that shrinks with it stops being legible. */}
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

        {showHover ? (
          <span
            data-testid="stream-hover-chip"
            aria-hidden="true"
            className="pointer-events-none absolute bottom-1.5 z-[var(--z-raised)] -translate-x-1/2 whitespace-nowrap rounded-[var(--radius-sm)] bg-[var(--color-text-primary)] px-2 py-[3px] font-mono text-[11px] text-[var(--color-surface)]"
            style={{ left: `${(hoveredIndex / (days.length - 1)) * 100}%` }}
          >
            {formatShortDate(hovered.date, locale)} · {formatTokenAmount(hovered.total, locale).text}
          </span>
        ) : null}

        {/* One target per day, centred on the day's own x so it lines up with the stream under it. A day
            with no usage has nothing to open, but still answers the pointer so a stale marker can't linger. */}
        <div
          className="absolute inset-y-0 flex"
          style={{ left: `-${50 / (days.length - 1)}%`, right: `-${50 / (days.length - 1)}%` }}
          onMouseLeave={() => setHoveredIndex(null)}
        >
          {days.map((day, index) => {
            const active = day.total > 0
            return (
              <button
                key={day.date}
                ref={(node) => {
                  if (node) dayButtons.current.set(day.date, node)
                  else dayButtons.current.delete(day.date)
                }}
                type="button"
                aria-label={`${formatDateLabel(day.date, locale)} · ${formatTokenAmount(day.total, locale).text} ${t('settings.activity.tokens')} (${formatTokenAmountExact(day.total)})`}
                aria-pressed={active ? summary?.date === day.date : undefined}
                aria-disabled={active ? undefined : true}
                tabIndex={active ? 0 : -1}
                className={cx(
                  'h-full min-w-0 flex-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)]',
                  active ? 'cursor-pointer' : 'cursor-default',
                )}
                onClick={() => toggleDay(index)}
                onMouseEnter={() => setHoveredIndex(index)}
                onFocus={() => setHoveredIndex(index)}
                onBlur={() => setHoveredIndex(null)}
              />
            )
          })}
        </div>

        {summary ? <TokenDayCard day={summary} locale={locale} onClose={closeCard} style={{ left: cardLeft, width: cardWidth }} /> : null}
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
