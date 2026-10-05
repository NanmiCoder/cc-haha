import { memo, useRef, useState, type MouseEvent } from 'react'
import { useTranslation } from '../../i18n'
import { cx } from '@/lib/cx'
import { rowAtFraction, type MinimapModel } from '../../lib/trajectory/minimap'
import type { TrajectoryLane } from '../../lib/trajectory/viewModel'
import type { TrajectoryRow } from '../../types/trajectory'
import { KIND_FILL_CLASSES, KIND_LABEL_KEYS } from './trajectoryLabels'

const LANE_HEIGHT = 14

type Props = {
  model: MinimapModel
  /** Visible slice of the table as fractions of the plot, if known. */
  viewport: { x: number; w: number } | null
  rowsById: ReadonlyMap<string, TrajectoryRow>
  onSelect: (rowId: string) => void
}

type Hover = { left: number; rowId: string }

function hitTest(model: MinimapModel, event: MouseEvent<HTMLDivElement>): string | null {
  const hit = (event.target as HTMLElement).dataset?.rowId
  if (hit) return hit
  const rect = event.currentTarget.getBoundingClientRect()
  if (!rect.width) return null
  const x = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width))
  const laneIndex = Math.floor((event.clientY - rect.top) / LANE_HEIGHT)
  const lane = laneIndex >= 0 && laneIndex <= 2 ? (laneIndex as TrajectoryLane) : null
  return rowAtFraction(model, x, lane) ?? rowAtFraction(model, x, null)
}

/**
 * Three lanes (input / model / tools) across the loaded session. Spans are
 * pre-bucketed by `buildMinimap`, so the DOM stays bounded however long the
 * session is; spans take their row kind's badge color, and failures get
 * full-height marks so they stay visible at any scale.
 */
export const TrajectoryMinimap = memo(function TrajectoryMinimap({ model, viewport, rowsById, onSelect }: Props) {
  const t = useTranslation()
  const [hover, setHover] = useState<Hover | null>(null)
  const frame = useRef(0)
  const lanes: Array<{ lane: TrajectoryLane; label: string }> = [
    { lane: 0, label: t('trajectory.minimap.input') },
    { lane: 1, label: t('trajectory.minimap.model') },
    { lane: 2, label: t('trajectory.minimap.tools') },
  ]

  const handleMove = (event: MouseEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect()
    const left = event.clientX - rect.left
    const rowId = hitTest(model, event)
    cancelAnimationFrame(frame.current)
    frame.current = requestAnimationFrame(() => setHover(rowId ? { left, rowId } : null))
  }

  const hoverRow = hover ? rowsById.get(hover.rowId) : undefined

  return (
    <div className="flex shrink-0 gap-2 border-b border-[var(--color-border)] px-3 py-1.5" data-testid="trajectory-minimap">
      <div className="flex w-9 shrink-0 flex-col text-right text-[11px] leading-[14px] text-[var(--color-text-tertiary)]" aria-hidden>
        {lanes.map(({ lane, label }) => <span key={lane}>{label}</span>)}
      </div>
      <div
        className="relative min-w-0 flex-1 cursor-pointer"
        style={{ height: LANE_HEIGHT * 3 }}
        onClick={(event) => {
          const rowId = hitTest(model, event)
          if (rowId) onSelect(rowId)
        }}
        onMouseMove={handleMove}
        onMouseLeave={() => {
          cancelAnimationFrame(frame.current)
          setHover(null)
        }}
        role="img"
        aria-label={t('trajectory.minimap.label')}
      >
        {model.turnMarks.map((x, index) => (
          <span key={`turn-${index}`} aria-hidden className="absolute inset-y-0 w-px bg-[var(--color-border)]" style={{ left: `${x * 100}%` }} />
        ))}
        {viewport && (
          <span
            aria-hidden
            data-testid="trajectory-minimap-viewport"
            className="absolute inset-y-0 rounded-[var(--radius-sm)] border border-[var(--color-border-focus)] bg-[var(--color-surface-hover)]"
            style={{ left: `${viewport.x * 100}%`, width: `max(${viewport.w * 100}%, 2px)` }}
          />
        )}
        {model.runs.map((run) => (
          <span
            key={`${run.lane}:${run.x}`}
            aria-hidden
            data-row-id={run.rowId}
            data-kind={run.kind}
            className={cx(
              'trajectory-minimap-span absolute',
              run.error ? 'bg-[var(--color-error)]' : KIND_FILL_CLASSES[run.kind],
              run.match && 'ring-1 ring-[var(--color-text-primary)]',
              run.selected && 'ring-2 ring-[var(--color-text-primary)]',
            )}
            style={{
              left: `${run.x * 100}%`,
              width: `max(${run.w * 100}%, 2px)`,
              top: run.lane * LANE_HEIGHT + 3,
              height: LANE_HEIGHT - 6,
            }}
          />
        ))}
        {model.errorMarks.map((mark) => (
          <span
            key={`error-${mark.x}`}
            aria-hidden
            data-row-id={mark.rowId}
            data-testid="trajectory-minimap-error"
            className="absolute inset-y-0 w-[2px] -translate-x-1/2 bg-[var(--color-error)]"
            style={{ left: `${mark.x * 100}%` }}
          />
        ))}
        {hover && hoverRow && (
          <div
            role="tooltip"
            className="pointer-events-none absolute top-full z-[var(--z-tooltip)] mt-1 max-w-[320px] -translate-x-1/2 truncate rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-surface-container-lowest)] px-2 py-1 text-[12px] text-[var(--color-text-primary)] shadow-[var(--shadow-dropdown)]"
            style={{ left: hover.left }}
          >
            <span className="text-[var(--color-text-tertiary)]">{t(KIND_LABEL_KEYS[hoverRow.kind])} · </span>
            {hoverRow.toolName ? `${hoverRow.toolName} ${hoverRow.inputSummary ?? ''}` : hoverRow.preview || hoverRow.label || ''}
          </div>
        )}
      </div>
    </div>
  )
})
