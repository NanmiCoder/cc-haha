import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'

import { cx } from '@/lib/cx'
import type { Locale } from '../../i18n'
import { useTranslation } from '../../i18n'
import { formatTokenAmount, formatTokenAmountExact } from './formatTokenUnits'
import { formatDateLabel, formatMonthName, formatShortDate, parseLocalDate } from './heatmapModel'
import { TokenDayCard } from './TokenDayCard'
import {
  buildColumnGeometry,
  dayModelShares,
  seriesColor,
  stackOrder,
  summarizeDay,
  type DailyModelSeries,
  type DayActivity,
  type RankedModel,
} from './usageModel'

const WIDTH = 928
const HEIGHT = 300
const CARD_WIDTH = 296
/** Space between a day's column and the card or preview beside it. */
const BESIDE_GAP = 14

type Props = {
  days: DailyModelSeries[]
  models: RankedModel[]
  /** Sessions, messages and tool calls per date, for the day card. */
  activity: ReadonlyMap<string, DayActivity>
  locale: Locale
  className?: string
}

/**
 * The last 90 days, one column per day, stacked by model on a zero baseline. Height is the value,
 * read against the grid lines and the labelled peak; color is the model. Pointing at a day previews
 * its total and what each model spent; clicking pins a card with that day's detail, and clicking it
 * again (or Esc) puts it away.
 */
export function TokenStreamChart({ days, models, activity, locale, className }: Props) {
  const t = useTranslation()
  const geometry = useMemo(() => buildColumnGeometry(days, models, WIDTH, HEIGHT), [days, models])
  const frameRef = useRef<HTMLDivElement | null>(null)
  const dayButtons = useRef(new Map<string, HTMLButtonElement>())
  const [frameWidth, setFrameWidth] = useState(WIDTH)
  const [selectedDate, setSelectedDate] = useState<string | null>(null)
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null)
  const previewRef = useRef<HTMLDivElement | null>(null)
  const [previewSize, setPreviewSize] = useState({ width: 0, height: 0 })

  const first = days[0]
  const last = days[days.length - 1]
  const peak = geometry.peak
  const hasChart = peak !== null

  // The card and the preview are placed in pixels so they stay inside a narrow pane.
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

  // The preview is placed by its own size, which changes with the day, the data and the locale, so it
  // is measured after every render; an unchanged size leaves the state alone.
  useLayoutEffect(() => {
    const element = previewRef.current
    if (!element) return
    const width = element.offsetWidth
    const height = element.offsetHeight
    setPreviewSize((current) => (current.width === width && current.height === height ? current : { width, height }))
  })

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

  const slot = WIDTH / days.length
  const centreX = (index: number) => (index + 0.5) * slot
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

  // Beside the day, on whichever side has room, and never off the chart.
  const besideDay = (index: number, boxWidth: number) => {
    const anchorX = ((index + 0.5) / days.length) * frameWidth
    const fitsRight = anchorX + BESIDE_GAP + boxWidth <= frameWidth
    return Math.max(0, Math.min(frameWidth - boxWidth, fitsRight ? anchorX + BESIDE_GAP : anchorX - BESIDE_GAP - boxWidth))
  }
  const cardWidth = Math.min(CARD_WIDTH, frameWidth)
  const cardLeft = selectedIndex >= 0 ? besideDay(selectedIndex, cardWidth) : 0
  // The preview starts level with the top of the column and slides up when it would run past the baseline.
  const frameHeight = (frameWidth * HEIGHT) / WIDTH
  const preview = showHover
    ? {
        models: dayModelShares(hovered, models),
        left: besideDay(hoveredIndex, previewSize.width),
        top: Math.max(0, Math.min(frameHeight - previewSize.height, (geometry.dayTops[hoveredIndex]! / HEIGHT) * frameHeight)),
      }
    : null
  const legend = stackOrder(models).map((index) => models[index]!)
  // Pointing at the peak day hides its label: the preview already carries the same figure.
  const peakLabelHidden = showHover && hoveredIndex === peak.index

  return (
    <div className={className}>
      <div ref={frameRef} className="relative" onKeyDown={handleKeyDown}>
        <svg
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          role="img"
          aria-label={t('settings.activity.streamLabel')}
          className="block h-auto w-full overflow-visible"
        >
          {showHover ? (
            <rect
              data-testid="stream-hover-band"
              x={hoveredIndex * slot}
              y={0}
              width={slot}
              height={HEIGHT}
              fill="var(--color-text-primary)"
              fillOpacity={0.06}
              pointerEvents="none"
            />
          ) : null}
          {geometry.grid.map((line) => (
            <line key={line.value} x1={0} x2={WIDTH} y1={line.y} y2={line.y} stroke="var(--color-border)" strokeWidth={1} />
          ))}
          {geometry.layers.map((layer) => {
            const model = models[layer.modelIndex]
            return <path key={model?.id ?? layer.modelIndex} d={layer.d} fill={seriesColor(model?.series ?? 1)} />
          })}
          <line x1={0} x2={WIDTH} y1={HEIGHT - 0.5} y2={HEIGHT - 0.5} stroke="var(--color-outline)" strokeWidth={1} />
          <g data-testid="stream-peak-marker">
            <circle cx={peak.x} cy={peak.y - 6} r={3} fill="var(--color-text-primary)" />
            <line x1={peak.x} x2={peak.x} y1={peak.y - 6} y2={Math.max(peak.y - 18, 0)} stroke="var(--color-text-primary)" strokeWidth={1} />
          </g>
          {summary ? (
            <g data-testid="stream-selection" pointerEvents="none">
              <rect x={0} y={0} width={selectedIndex * slot} height={HEIGHT} fill="var(--color-surface)" fillOpacity={0.55} />
              <rect x={(selectedIndex + 1) * slot} y={0} width={WIDTH - (selectedIndex + 1) * slot} height={HEIGHT} fill="var(--color-surface)" fillOpacity={0.55} />
              <circle cx={centreX(selectedIndex)} cy={geometry.dayTops[selectedIndex]! - 6} r={3.5} fill="var(--color-text-primary)" stroke="var(--color-surface)" strokeWidth={2} />
            </g>
          ) : null}
        </svg>

        {/* HTML, not SVG text: the viewBox scales with the pane, and a label that shrinks with it stops being legible. */}
        {geometry.grid.map((line) => (
          <span
            key={line.value}
            data-testid="stream-grid-label"
            aria-hidden="true"
            className="pointer-events-none absolute left-0 -translate-y-full pb-0.5 font-mono text-[11px] leading-none text-[var(--color-text-tertiary)] [text-shadow:0_0_3px_var(--color-surface),0_0_3px_var(--color-surface)]"
            style={{ top: `${(line.y / HEIGHT) * 100}%` }}
          >
            {formatTokenAmount(line.value, locale).text}
          </span>
        ))}
        <span
          data-testid="stream-peak"
          className="pointer-events-none absolute whitespace-nowrap text-[13px] font-medium text-[var(--color-text-primary)]"
          style={{
            left: `${(peak.x / WIDTH) * 100}%`,
            top: `${(Math.max(peak.y - 22, 0) / HEIGHT) * 100}%`,
            transform: peak.x > WIDTH * 0.7 ? 'translate(-100%, -100%)' : 'translate(-50%, -100%)',
            opacity: peakLabelHidden ? 0 : 1,
          }}
        >
          {t('settings.activity.peakOn', {
            amount: formatTokenAmount(peak.total, locale).text,
            date: formatShortDate(peak.date, locale),
          })}
        </span>

        {/* One target per day, exactly over that day's slot. A day with no usage has nothing to open,
            but still answers the pointer so a stale marker can't linger. */}
        <div className="absolute inset-0 flex" onMouseLeave={() => setHoveredIndex(null)}>
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

        {/* After the card, so a preview of another day reads on top of it. */}
        {preview && hovered ? (
          <div
            ref={previewRef}
            data-testid="stream-day-preview"
            aria-hidden="true"
            className="pointer-events-none absolute z-[var(--z-raised)] w-max min-w-[148px] max-w-[240px] rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 shadow-[var(--shadow-dropdown)]"
            style={{ left: preview.left, top: preview.top }}
          >
            <div className="flex items-baseline justify-between gap-3 whitespace-nowrap">
              <span className="font-mono text-[11px] text-[var(--color-text-tertiary)]">{formatShortDate(hovered.date, locale)}</span>
              <span data-testid="stream-day-preview-total" className="text-[13px] font-medium tabular-nums text-[var(--color-text-primary)]">
                {formatTokenAmount(hovered.total, locale).text}
              </span>
            </div>
            <ul className="mt-1.5 grid gap-1">
              {preview.models.map((model) => (
                <li key={model.id} className="flex items-center gap-2 text-xs leading-4">
                  <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: seriesColor(model.series) }} />
                  <span className="min-w-0 flex-1 truncate text-[var(--color-text-secondary)]">
                    {model.foldedCount ? t('settings.activity.moreModels', { count: model.foldedCount }) : model.label}
                  </span>
                  <span className="tabular-nums text-[var(--color-text-primary)]">{formatTokenAmount(model.tokens, locale).text}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>

      <div aria-hidden="true" className="relative h-5 font-mono text-[11px] text-[var(--color-text-tertiary)]">
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
        {legend.map((model) => (
          <li key={model.id} className="inline-flex items-center gap-2">
            <span aria-hidden="true" className="h-2.5 w-2.5 rounded-full" style={{ background: seriesColor(model.series) }} />
            <span className="text-[var(--color-text-primary)]">{model.label}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}
