import type { CSSProperties, ReactNode } from 'react'

import { cx } from '@/lib/cx'

export type SkeletonProps = {
  shape?: 'line' | 'block' | 'circle'
  width?: string
  height?: string
  radius?: 'sm' | 'md' | 'lg' | 'full'
  /** Two placeholder shades replace the four in circulation. */
  tone?: 'base' | 'strong'
  className?: string
}

const RADIUS = {
  sm: 'rounded-[var(--radius-sm)]',
  md: 'rounded-[var(--radius-md)]',
  lg: 'rounded-[var(--radius-lg)]',
  full: 'rounded-full',
} as const

const TONE = {
  base: 'bg-[var(--color-surface-container)]',
  strong: 'bg-[var(--color-surface-container-high)]',
} as const

const SHAPE_DEFAULTS = {
  line: { height: '0.75rem', radius: 'sm' as const },
  block: { height: '4rem', radius: 'md' as const },
  circle: { height: '2rem', radius: 'full' as const },
}

/**
 * One placeholder rectangle.
 *
 * Deliberately does NOT animate. The pulse belongs on `SkeletonGroup`, so a
 * cluster of placeholders breathes as one object instead of each element
 * pulsing on its own phase — the giveaway that six of these were hand-rolled
 * independently.
 */
export function Skeleton({
  shape = 'line',
  width,
  height,
  radius,
  tone = 'base',
  className,
}: SkeletonProps) {
  const defaults = SHAPE_DEFAULTS[shape]

  return (
    <div
      aria-hidden="true"
      className={cx(TONE[tone], RADIUS[radius ?? defaults.radius], className)}
      style={{
        width: width ?? (shape === 'circle' ? height ?? defaults.height : undefined),
        height: height ?? defaults.height,
      }}
    />
  )
}

export type SkeletonGroupProps = {
  /** Announced while the placeholder is on screen, e.g. "Loading sessions". */
  label: string
  className?: string
  /**
   * For layout a caller cannot express as a class — a grid template built from
   * the same constants the real grid uses. Inline beats the utility classes
   * below deterministically, which two competing `gap` classes do not.
   */
  style?: CSSProperties
  children: ReactNode
}

/**
 * Wraps a cluster of `Skeleton`s.
 *
 * The only place that holds `animate-pulse`, and the only place that carries
 * the loading semantics — the hand-rolled placeholders had neither `role` nor
 * `aria-busy`, so a screen reader saw an empty region and said nothing.
 */
export function SkeletonGroup({ label, className, style, children }: SkeletonGroupProps) {
  return (
    <div role="status" aria-busy="true" aria-live="polite" style={style} className={cx('animate-pulse', className)}>
      <span className="sr-only">{label}</span>
      {children}
    </div>
  )
}

export type SkeletonRowsProps = {
  label: string
  count: number
  rowHeight?: string
  /** Lines of text per row. */
  lines?: number
  divided?: boolean
  className?: string
}

/** A list placeholder: `count` rows, each with `lines` text lines. */
export function SkeletonRows({
  label,
  count,
  rowHeight,
  lines = 2,
  divided = false,
  className,
}: SkeletonRowsProps) {
  return (
    <SkeletonGroup label={label} className={cx('flex flex-col', divided && 'divide-y divide-[var(--color-border)]', className)}>
      {Array.from({ length: count }, (_, row) => (
        <div key={row} className="flex flex-col gap-2 py-3" style={{ minHeight: rowHeight }}>
          {Array.from({ length: lines }, (_, line) => (
            <Skeleton
              key={line}
              // Ragged widths read as text; equal-width bars read as a table.
              width={line === 0 ? '45%' : line === lines - 1 ? '70%' : '90%'}
              tone={line === 0 ? 'strong' : 'base'}
            />
          ))}
        </div>
      ))}
    </SkeletonGroup>
  )
}

export type SkeletonCardsProps = {
  label: string
  count: number
  minHeight?: string
  withAvatar?: boolean
  className?: string
  /** Grid overrides — see `SkeletonGroupProps['style']`. */
  style?: CSSProperties
}

/** A card-grid placeholder. */
export function SkeletonCards({
  label,
  count,
  minHeight = '132px',
  withAvatar = false,
  className,
  style,
}: SkeletonCardsProps) {
  return (
    <SkeletonGroup label={label} style={style} className={cx('grid gap-3', className)}>
      {Array.from({ length: count }, (_, card) => (
        <div
          key={card}
          className="flex flex-col gap-3 rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface-container-low)] p-4"
          style={{ minHeight }}
        >
          <div className="flex items-center gap-3">
            {withAvatar && <Skeleton shape="circle" height="2rem" tone="strong" />}
            <Skeleton width="50%" tone="strong" />
          </div>
          <Skeleton width="90%" />
          <Skeleton width="65%" />
        </div>
      ))}
    </SkeletonGroup>
  )
}
