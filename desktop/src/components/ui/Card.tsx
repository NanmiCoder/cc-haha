import type { HTMLAttributes, ReactNode } from 'react'

import { cx } from '@/lib/cx'

export type CardProps = HTMLAttributes<HTMLElement> & {
  radius?: 'sm' | 'md' | 'lg' | 'xl' | '2xl'
  /** Which surface layer this card sits on. */
  surface?: 'base' | 'low' | 'lowest' | 'high' | 'container' | 'none'
  border?: 'solid' | 'dashed' | 'none'
  padding?: 'none' | 'sm' | 'md' | 'lg'
  /**
   * Elevation, from the handoff's three-step shadow scale.
   *
   * `card` is the resting lift for content cards; `composer` is the heavier one
   * reserved for the input dock and for cards lifting on hover. Kept as a prop
   * rather than a `className` because two `shadow-[…]` values do not compose —
   * Tailwind picks a winner by sorting, not by argument order.
   */
  shadow?: 'none' | 'card' | 'composer'
  /** Adds hover and focus affordances for cards that are themselves clickable. */
  interactive?: boolean
  /** Raises the card 2px on hover. Only meaningful with `interactive`. */
  lift?: boolean
  as?: 'div' | 'section' | 'article' | 'li'
  className?: string
  children: ReactNode
}

const RADIUS = {
  sm: 'rounded-[var(--radius-sm)]',
  md: 'rounded-[var(--radius-md)]',
  lg: 'rounded-[var(--radius-lg)]',
  xl: 'rounded-[var(--radius-xl)]',
  '2xl': 'rounded-[var(--radius-2xl)]',
} as const

const SHADOW = {
  none: '',
  card: 'shadow-[var(--shadow-card)]',
  composer: 'shadow-[var(--shadow-composer)]',
} as const

const SURFACE = {
  base: 'bg-[var(--color-surface)]',
  low: 'bg-[var(--color-surface-container-low)]',
  lowest: 'bg-[var(--color-surface-container-lowest)]',
  high: 'bg-[var(--color-surface-container-high)]',
  container: 'bg-[var(--color-surface-container)]',
  none: '',
} as const

const BORDER = {
  solid: 'border border-[var(--color-border)]',
  dashed: 'border border-dashed border-[var(--color-border)]',
  none: '',
} as const

const PADDING = { none: '', sm: 'p-2.5', md: 'p-4', lg: 'p-5' } as const

/**
 * A bordered surface.
 *
 * The point of this is not saving markup — the seven most common container
 * recipes account for 115 sites, but each is only a handful of classes. The
 * point is giving corner radii somewhere to converge: hardcoded Tailwind radii
 * outnumber the design tokens 433 to 184, and `rounded-lg` (8px) and
 * `rounded-[var(--radius-lg)]` (12px) are different values wearing the same
 * name. A call site that becomes `<Card radius="lg">` stops being part of that
 * problem, one file at a time.
 *
 * Use it in new code and when a file is being touched anyway. A sweeping
 * find-and-replace across 115 sites is not worth the regression risk.
 */
export function Card({
  radius = 'lg',
  surface = 'base',
  border = 'solid',
  padding = 'md',
  shadow = 'none',
  interactive = false,
  lift = false,
  as: Element = 'div',
  className,
  children,
  // Everything else (`data-*`, `style`, aria) passes through, same as Badge and
  // for the same reason: without it a caller that needs a test id or a scoped
  // CSS class is forced back to hand-rolled markup.
  ...rest
}: CardProps) {
  return (
    <Element
      {...rest}
      className={cx(
        RADIUS[radius],
        SURFACE[surface],
        BORDER[border],
        PADDING[padding],
        // A lifting card animates its own shadow on hover, so it must not also
        // carry a resting one — the two `shadow-[…]` values would not compose.
        lift ? '' : SHADOW[shadow],
        interactive && [
          'cursor-pointer transition-[background-color,border-color,box-shadow,transform] duration-150 ease-out',
          'hover:border-[var(--color-brand)] hover:bg-[var(--color-surface-hover)]',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)]',
          'focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-surface)]',
        ].join(' '),
        lift && [
          'shadow-[var(--shadow-card)] hover:-translate-y-0.5 hover:shadow-[var(--shadow-composer)]',
          'motion-reduce:transition-none motion-reduce:hover:translate-y-0',
        ].join(' '),
        className,
      )}
    >
      {children}
    </Element>
  )
}
