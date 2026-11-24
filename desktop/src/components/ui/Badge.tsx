import type { HTMLAttributes, ReactNode } from 'react'

import { cx } from '@/lib/cx'

/**
 * The status vocabulary shared by `Badge`, `StatusDot` and anything else that
 * needs to color a state. Keep new states mapping onto these six rather than
 * introducing a seventh color.
 */
export type Tone = 'neutral' | 'brand' | 'success' | 'warning' | 'danger' | 'info'

export type BadgeProps = Omit<HTMLAttributes<HTMLSpanElement>, 'children' | 'title'> & {
  tone?: Tone
  /**
   * `soft` is a tinted fill, `outline` is a hairline border on transparent.
   * There is deliberately no `solid`: all 45 badges in the app were tinted,
   * and a solid variant would need a readable foreground per tone per theme —
   * twelve tokens nobody currently has a use for.
   */
  variant?: 'soft' | 'outline'
  /** `xs` matches the 10px pill used by 27 of the 45 existing badges. */
  size?: 'xs' | 'sm' | 'md'
  /**
   * Adds a hairline border to a `soft` badge, for badges that need to hold
   * their edge against a busy background. Uses an opaque token rather than the
   * `/20` alpha the hand-rolled badges used, which Safari 15 drops entirely.
   */
  bordered?: boolean
  /** Set false for counters, which read better with a square-ish corner. */
  pill?: boolean
  icon?: ReactNode
  /** Tabular figures for versions, hashes and paths. */
  mono?: boolean
  /**
   * Lets long content wrap and break mid-word. Badges are single-line by
   * default, which overflows for the things that actually go in a `mono` badge
   * — file paths, hook matchers, package specifiers.
   */
  wrap?: boolean
  /** Native tooltip, for badges whose text is truncated or abbreviated. */
  title?: string
  className?: string
  children: ReactNode
}

/**
 * Foreground comes from the matching `on-*-container` token, not the accent.
 * Using the accent as its own foreground fails contrast where the container is
 * light and the accent is mid-tone: the light theme's warning badge measured
 * 2.66:1 against its own fill, well under the 4.5 needed for small text.
 */
const SOFT_CLASSES: Record<Tone, string> = {
  neutral: 'bg-[var(--color-surface-container)] text-[var(--color-text-secondary)]',
  // The darkened pair, not `--color-brand`: the raw accent only reaches
  // 4.3–4.5:1 on its own soft fill under the two ink palettes.
  brand: 'bg-[var(--color-brand-soft)] text-[var(--color-on-brand-soft)]',
  success: 'bg-[var(--color-success-container)] text-[var(--color-on-success-container)]',
  warning: 'bg-[var(--color-warning-container)] text-[var(--color-on-warning-container)]',
  danger: 'bg-[var(--color-error-container)] text-[var(--color-on-error-container)]',
  info: 'bg-[var(--color-info-container)] text-[var(--color-on-info-container)]',
}

const OUTLINE_CLASSES: Record<Tone, string> = {
  neutral: 'border border-[var(--color-border)] text-[var(--color-text-secondary)]',
  brand: 'border border-[var(--color-brand)] text-[var(--color-brand)]',
  success: 'border border-[var(--color-success)] text-[var(--color-success)]',
  warning: 'border border-[var(--color-warning)] text-[var(--color-warning)]',
  danger: 'border border-[var(--color-error)] text-[var(--color-error)]',
  info: 'border border-[var(--color-info)] text-[var(--color-info)]',
}

const SIZE_CLASSES = {
  xs: 'px-1.5 py-0.5 text-[11px] gap-1',
  sm: 'px-2 py-0.5 text-xs gap-1',
  md: 'px-2.5 py-1 text-[11px] gap-1.5',
} as const

/** Border colors for `bordered` soft badges, one shade up from the fill. */
const SOFT_BORDER: Record<Tone, string> = {
  neutral: 'border border-[var(--color-border)]',
  brand: 'border border-[var(--color-brand-soft-hover)]',
  success: 'border border-[var(--color-success)]',
  warning: 'border border-[var(--color-warning)]',
  danger: 'border border-[var(--color-error)]',
  info: 'border border-[var(--color-info)]',
}

/**
 * A small status pill.
 *
 * Replaces 45 hand-rolled variants. Two of them — `market/InstallStateBadge`
 * and `market/SecurityBadge` — had character-identical shells and differed only
 * in their status-to-color map; with this in place each is just that map.
 */
export function Badge({
  tone = 'neutral',
  variant = 'soft',
  size = 'xs',
  bordered = false,
  pill = true,
  icon,
  mono = false,
  wrap = false,
  title,
  className,
  children,
  // Passed through so call sites can attach `data-testid`, `aria-*` or an id.
  // A component that swallows these forces the caller back to a hand-rolled
  // span the moment a test needs to select it.
  ...props
}: BadgeProps) {
  return (
    <span
      title={title}
      {...props}
      className={cx(
        'inline-flex shrink-0 items-center font-medium',
        wrap ? 'break-all' : 'whitespace-nowrap',
        pill ? 'rounded-full' : 'rounded-[var(--radius-sm)]',
        SIZE_CLASSES[size],
        variant === 'soft' ? SOFT_CLASSES[tone] : OUTLINE_CLASSES[tone],
        variant === 'soft' && bordered && SOFT_BORDER[tone],
        mono && 'font-mono tabular-nums',
        className,
      )}
    >
      {icon}
      {children}
    </span>
  )
}

export type StatusDotProps = {
  tone: Tone
  /** `sm` (6px) matches 23 of the 41 existing dots. */
  size?: 'sm' | 'md' | 'lg'
  /**
   * Breathes on `animate-pulse-dot` (1.5s). Two call sites used the generic
   * `animate-pulse` (2s) instead and visibly breathed out of step with the
   * other thirteen.
   */
  pulse?: boolean
  /**
   * Accessible name. A bare dot conveys nothing to a screen reader, so pass one
   * unless adjacent text already states the status.
   */
  label?: string
  className?: string
  // Passed through for the same reason as `Badge`: a dot a test cannot select
  // pushes the caller back to a hand-rolled span.
} & Omit<HTMLAttributes<HTMLSpanElement>, 'className' | 'role' | 'aria-label'>

const DOT_SIZE = { sm: 'h-1.5 w-1.5', md: 'h-2 w-2', lg: 'h-2.5 w-2.5' } as const

const DOT_TONE: Record<Tone, string> = {
  neutral: 'bg-[var(--color-text-tertiary)]',
  brand: 'bg-[var(--color-brand)]',
  success: 'bg-[var(--color-success)]',
  warning: 'bg-[var(--color-warning)]',
  danger: 'bg-[var(--color-error)]',
  info: 'bg-[var(--color-info)]',
}

/** A colored dot for live status. */
export function StatusDot({ tone, size = 'sm', pulse = false, label, className, ...rest }: StatusDotProps) {
  return (
    <span
      {...rest}
      role={label ? 'status' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      className={cx(
        'inline-block shrink-0 rounded-full',
        DOT_SIZE[size],
        DOT_TONE[tone],
        pulse && 'animate-pulse-dot',
        className,
      )}
    />
  )
}
