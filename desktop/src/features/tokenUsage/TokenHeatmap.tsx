import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'

import type { ActivityStatsResponse } from '../../api/activityStats'
import { SettingsSection } from '@/components/settings/SettingsSection'
import { SegmentedControl } from '@/components/ui/SegmentedControl'
import { cx } from '@/lib/cx'
import { useTranslation, type Locale } from '../../i18n'
import { formatTokenAmount } from './formatTokenUnits'
import {
  WEEK_COUNT,
  buildHeatmapDays,
  buildMonthLabels,
  formatDateLabel,
  type HeatmapDay,
  type HeatmapMode,
} from './heatmapModel'
import { tokenAmountTitle } from './TokenAmount'

const WEEKDAY_LABEL_KEYS = [
  'settings.activity.weekday.mon',
  'settings.activity.weekday.wed',
  'settings.activity.weekday.fri',
] as const
const HEAT_CELL_GAP_WIDE = 4
const HEAT_CELL_GAP_TIGHT = 3
const HEAT_LABEL_WIDTH = 38
const HEAT_CELL_MIN = 6
const HEAT_CELL_MAX = 22
const TOOLTIP_WIDTH = 172
const HEAT_COLORS = [
  'var(--color-activity-heat-0)',
  'var(--color-activity-heat-1)',
  'var(--color-activity-heat-2)',
  'var(--color-activity-heat-3)',
  'var(--color-activity-heat-4)',
]
/** Empty days shrink and busy days fill the cell, so the grid reads as dots of different weight. */
const DOT_SCALE = [0.5, 0.72, 0.8, 0.9, 1]

function fitCells(width: number, gap: number) {
  const available = width - HEAT_LABEL_WIDTH - (WEEK_COUNT - 1) * gap
  return Math.max(HEAT_CELL_MIN, Math.min(HEAT_CELL_MAX, Math.floor(available / WEEK_COUNT)))
}

/** A roomy gap while cells are big enough to carry it; a tighter one on a narrow pane, so 52 weeks still fit. */
function calculateHeatLayout(width: number) {
  const wide = fitCells(width, HEAT_CELL_GAP_WIDE)
  if (wide >= 9) return { cellSize: wide, gap: HEAT_CELL_GAP_WIDE }
  return { cellSize: fitCells(width, HEAT_CELL_GAP_TIGHT), gap: HEAT_CELL_GAP_TIGHT }
}

type Translate = ReturnType<typeof useTranslation>

function cellTitle(day: HeatmapDay, locale: Locale, t: Translate) {
  if (day.mode === 'weekly') {
    return t('settings.activity.weekRange', {
      start: formatDateLabel(day.rangeStart ?? day.date, locale),
      end: formatDateLabel(day.rangeEnd ?? day.date, locale),
    })
  }
  if (day.mode === 'cumulative') {
    return t('settings.activity.cumulativeThrough', { date: formatDateLabel(day.rangeEnd ?? day.date, locale) })
  }
  return formatDateLabel(day.date, locale)
}

function cellDetail(day: HeatmapDay, locale: Locale, t: Translate) {
  const tokens = formatTokenAmount(day.tokens, locale).text
  if (day.mode === 'cumulative') return t('settings.activity.tokenValue', { tokens })
  const sessions = t(day.sessionCount === 1 ? 'settings.activity.count.sessionOne' : 'settings.activity.count.sessionOther', { count: day.sessionCount })
  return `${sessions} · ${tokens} ${t('settings.activity.tokens')}`
}

export function TokenHeatmap({ stats, locale }: { stats: ActivityStatsResponse; locale: Locale }) {
  const t = useTranslation()
  const measureRef = useRef<HTMLDivElement | null>(null)
  const [mode, setMode] = useState<HeatmapMode>('daily')
  const [hoveredDate, setHoveredDate] = useState<string | null>(null)
  const [focusedDate, setFocusedDate] = useState<string | null>(null)
  const [{ cellSize, gap }, setLayout] = useState({ cellSize: 10, gap: HEAT_CELL_GAP_WIDE })

  useEffect(() => {
    const element = measureRef.current
    if (!element) return
    const update = () => {
      const next = calculateHeatLayout(element.clientWidth)
      setLayout((current) => (current.cellSize === next.cellSize && current.gap === next.gap ? current : next))
    }
    update()
    if (typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(update)
      observer.observe(element)
      return () => observer.disconnect()
    }
    window.addEventListener('resize', update)
    return () => window.removeEventListener('resize', update)
  }, [])

  const days = useMemo(() => buildHeatmapDays(stats, mode), [mode, stats])
  const monthLabels = useMemo(() => buildMonthLabels(days, locale), [days, locale])
  const activeDate = hoveredDate ?? focusedDate
  const tooltipDay = days.find((day) => day.date === activeDate) ?? null
  const tooltipIndex = tooltipDay ? days.findIndex((day) => day.date === tooltipDay.date) : -1
  const gridWidth = WEEK_COUNT * cellSize + (WEEK_COUNT - 1) * gap
  const gridHeight = 7 * cellSize + 6 * gap
  const totalWidth = HEAT_LABEL_WIDTH + gridWidth
  const tooltipStyle = tooltipIndex >= 0
    ? {
        left: Math.max(
          HEAT_LABEL_WIDTH,
          Math.min(totalWidth - TOOLTIP_WIDTH, HEAT_LABEL_WIDTH + Math.floor(tooltipIndex / 7) * (cellSize + gap) - 52),
        ),
        top: Math.max(28, 30 + (tooltipIndex % 7) * (cellSize + gap) - 50),
      }
    : undefined

  const modeOptions: Array<{ mode: HeatmapMode; label: string; help: string }> = [
    { mode: 'daily', label: t('settings.activity.mode.daily'), help: t('settings.activity.modeHelp.daily') },
    { mode: 'weekly', label: t('settings.activity.mode.weekly'), help: t('settings.activity.modeHelp.weekly') },
    { mode: 'cumulative', label: t('settings.activity.mode.cumulative'), help: t('settings.activity.modeHelp.cumulative') },
  ]

  return (
    <SettingsSection
      title={t('settings.activity.tokenActivity')}
      action={
        <SegmentedControl
          size="sm"
          label={t('settings.activity.tokenActivity')}
          value={mode}
          onChange={setMode}
          items={modeOptions.map((option) => ({ value: option.mode, label: option.label, title: option.help }))}
        />
      }
    >
      <div ref={measureRef} className="min-w-0">
        <div className="relative" style={{ width: totalWidth, maxWidth: '100%' }}>
          {/* Absolutely placed by week: grid auto-placement pushed a label whose
              4-column span ran past the last week onto a second row. */}
          <div
            data-testid="activity-month-labels"
            className="relative mb-3 h-5 text-[11px] leading-none text-[var(--color-text-tertiary)]"
            style={{ marginLeft: HEAT_LABEL_WIDTH }}
          >
            {monthLabels.map((month) => (
              <span
                key={`${month.week}-${month.label}`}
                className="absolute top-0 whitespace-nowrap"
                style={{ left: month.week * (cellSize + gap) }}
              >
                {month.label}
              </span>
            ))}
          </div>

          <div className="flex items-start" style={{ gap }}>
            <div
              className="grid shrink-0 grid-rows-7 text-[11px] leading-none text-[var(--color-text-tertiary)]"
              style={{ width: HEAT_LABEL_WIDTH, height: gridHeight, rowGap: gap }}
            >
              <div className="row-start-2 flex items-center">{t(WEEKDAY_LABEL_KEYS[0])}</div>
              <div className="row-start-4 flex items-center">{t(WEEKDAY_LABEL_KEYS[1])}</div>
              <div className="row-start-6 flex items-center">{t(WEEKDAY_LABEL_KEYS[2])}</div>
            </div>

            <div
              role="grid"
              aria-label={t('settings.activity.heatmapLabel')}
              className="grid grid-flow-col"
              style={{
                gridTemplateRows: `repeat(7, ${cellSize}px)`,
                gridAutoColumns: `${cellSize}px`,
                columnGap: gap,
                rowGap: gap,
              }}
              onMouseLeave={() => setHoveredDate(null)}
            >
              {days.map((day) => {
                const title = cellTitle(day, locale, t)
                const detail = cellDetail(day, locale, t)
                return (
                  <button
                    key={day.date}
                    type="button"
                    role="gridcell"
                    aria-label={`${title}: ${detail}`}
                    aria-describedby={activeDate === day.date ? `activity-day-tooltip-${day.date}` : undefined}
                    className={cx(
                      'activity-heat-cell rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)] focus-visible:ring-offset-1 focus-visible:ring-offset-[var(--color-surface)]',
                      activeDate === day.date && 'is-active',
                    )}
                    style={{
                      width: cellSize,
                      height: cellSize,
                      backgroundColor: HEAT_COLORS[day.level],
                      '--dot-scale': DOT_SCALE[day.level],
                    } as CSSProperties}
                    onFocus={() => setFocusedDate(day.date)}
                    onBlur={() => setFocusedDate(null)}
                    onMouseEnter={() => setHoveredDate(day.date)}
                  />
                )
              })}
            </div>
          </div>

          {tooltipDay ? (
            <div
              id={`activity-day-tooltip-${tooltipDay.date}`}
              role="tooltip"
              className="pointer-events-none absolute z-[var(--z-tooltip)] min-w-[172px] rounded-[var(--radius-md)] border border-[var(--color-activity-tooltip-border)] bg-[var(--color-activity-tooltip-surface)] px-2.5 py-1.5 text-xs shadow-[var(--shadow-dropdown)]"
              style={tooltipStyle}
            >
              <div className="font-medium text-[var(--color-activity-tooltip-text)]">{cellTitle(tooltipDay, locale, t)}</div>
              <div className="mt-0.5 tabular-nums text-[var(--color-activity-tooltip-muted)]" title={tokenAmountTitle(tooltipDay.tokens, locale)}>
                {cellDetail(tooltipDay, locale, t)}
              </div>
            </div>
          ) : null}
        </div>
      </div>

      <div className="mt-3 flex items-center justify-end gap-1.5 text-[11px] text-[var(--color-text-tertiary)]">
        <span className="mr-0.5">{t('settings.activity.less')}</span>
        {HEAT_COLORS.map((color, level) => (
          <span
            key={color}
            aria-hidden="true"
            className="rounded-full"
            style={{
              width: 12,
              height: 12,
              backgroundColor: color,
              transform: `scale(${DOT_SCALE[level]})`,
            }}
          />
        ))}
        <span className="ml-0.5">{t('settings.activity.more')}</span>
      </div>
    </SettingsSection>
  )
}
