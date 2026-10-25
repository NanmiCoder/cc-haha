import { Minus, MoveHorizontal, Plus, Scan } from 'lucide-react'

import { cx } from '@/lib/cx'
import { IconButton } from './IconButton'

export type ZoomControlsLabels = {
  /** Names the whole cluster ("Zoom controls"). */
  group: string
  zoomIn: string
  zoomOut: string
  /** What the fit button does for this viewer: "Fit to window" or "Fit to width". */
  fit: string
}

/**
 * What "fit" means for a viewer. Picks the fit button's icon, which must not read as
 * "maximize": the workspace panel's own maximize control sits in the same view.
 */
export type ZoomFitMode = 'window' | 'width'

/**
 * The look of a control floating over a viewer: a hairline-bordered pill. Shared
 * so an extra action placed beside the zoom cluster reads as part of it.
 */
export function floatingPillClass(surface: 'default' | 'media' | 'lightbox', { flat = false }: { flat?: boolean } = {}): string {
  return cx(
    'inline-flex items-center gap-0.5 border',
    surface === 'lightbox' ? 'rounded-[var(--radius-full)] p-1' : 'rounded-[var(--radius-lg)] p-0.5',
    // A pill floating over content lifts off it with a shadow; one sitting in a
    // toolbar is already on a surface of its own.
    !flat && 'shadow-[var(--shadow-card)]',
    surface === 'lightbox'
      ? 'border-[var(--color-lightbox-control-bg)] bg-[var(--color-lightbox-control-bg)] text-[var(--color-lightbox-control-fg)]'
      : surface === 'media'
      ? 'border-[var(--color-media-border)] bg-[var(--color-media-header)] text-[var(--color-media-muted)]'
      : 'border-[var(--color-border)] bg-[var(--color-surface-container-lowest)] text-[var(--color-text-secondary)]',
  )
}

export type ZoomControlsProps = {
  /** The zoom as the whole-number percentage a person reads. */
  percent: number
  /** The viewer is showing whatever scale fits, rather than a scale the user chose. */
  fitActive: boolean
  canZoomIn: boolean
  canZoomOut: boolean
  onZoomIn: () => void
  onZoomOut: () => void
  onFit: () => void
  /** Defaults to `window`. */
  fitMode?: ZoomFitMode
  /** Caller-supplied so this primitive never carries user-visible text of its own. */
  labels: ZoomControlsLabels
  /**
   * `media` for a control that floats over the dark lightbox, whose colors do
   * not follow the theme; `default` for one that sits on a panel.
   */
  surface?: 'default' | 'media' | 'lightbox'
  /** No drop shadow: for a cluster that sits in a toolbar rather than floating over content. */
  flat?: boolean
  className?: string
}

/**
 * The zoom cluster shared by every viewer: − / percentage / + / fit.
 *
 * The percentage is a readout, not a button. "Actual size" is reached by the "+"
 * ladder passing through 100%, by a double click on the content, and by the
 * keyboard, so it does not need a control of its own competing for room in a
 * narrow panel.
 *
 * Fit is an action, not a toggle: it is only available once the reader has zoomed
 * away from the fitted scale, so a button that can be clicked always does something.
 */
export function ZoomControls({
  percent,
  fitActive,
  canZoomIn,
  canZoomOut,
  onZoomIn,
  onZoomOut,
  onFit,
  fitMode = 'window',
  labels,
  surface = 'default',
  flat = false,
  className,
}: ZoomControlsProps) {
  const lightbox = surface === 'lightbox'
  return (
    <div
      role="group"
      aria-label={labels.group}
      className={cx(floatingPillClass(surface, { flat }), className)}
    >
      <IconButton
        icon={<Minus size={16} strokeWidth={1.9} />}
        label={labels.zoomOut}
        size={lightbox ? '2xl' : 'md'}
        shape={lightbox ? 'circle' : 'square'}
        tone="secondary"
        surface={surface}
        disabled={!canZoomOut}
        onClick={onZoomOut}
      />
      <span className={lightbox ? 'min-w-[4rem] px-2 text-center text-[14px] tabular-nums' : 'min-w-[3.25rem] px-1 text-center font-mono text-xs tabular-nums'}>{percent}%</span>
      <IconButton
        icon={<Plus size={16} strokeWidth={1.9} />}
        label={labels.zoomIn}
        size={lightbox ? '2xl' : 'md'}
        shape={lightbox ? 'circle' : 'square'}
        tone="secondary"
        surface={surface}
        disabled={!canZoomIn}
        onClick={onZoomIn}
      />
      <IconButton
        icon={fitMode === 'width'
          ? <MoveHorizontal size={16} strokeWidth={1.9} />
          : <Scan size={15} strokeWidth={1.9} />}
        label={labels.fit}
        size={lightbox ? '2xl' : 'md'}
        shape={lightbox ? 'circle' : 'square'}
        tone="secondary"
        surface={surface}
        disabled={fitActive}
        onClick={onFit}
      />
    </div>
  )
}
