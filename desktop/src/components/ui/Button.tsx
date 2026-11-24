import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react'

import { cx } from '@/lib/cx'
import { Spinner } from './Spinner'

export type ButtonVariant =
  | 'primary'
  /**
   * Solid terracotta at rest, for the single unmissable action on a surface —
   * the composer's send key. See the note on its entry in `VARIANT_CLASSES` for
   * why this is separate from `primary` rather than replacing it.
   */
  | 'accent'
  | 'secondary'
  | 'tonal'
  /**
   * Terracotta outline that inverts to a solid terracotta fill on hover — the
   * handoff's install/secondary-action button (market cards, detail pages).
   * Distinct from `tonal`, which rests on a soft fill and never inverts.
   */
  | 'tonal-outline'
  | 'ghost'
  | 'danger'
  | 'danger-outline'
  /**
   * Danger-colored text with no border or fill until hovered, for a destructive
   * action that is rarely wanted and should not compete with the page's real
   * primary action (unlike `danger-outline`, which reads as a call to act).
   */
  | 'danger-ghost'
  | 'link'
  /**
   * Inverted fill — dark on light themes, light on dark. For a neutral but
   * emphatic confirm that should not read as the brand action. The pattern
   * appears three times in the app, hand-rolled each time.
   */
  | 'inverse'

/**
 * `base` sits between `sm` and `md` at h-8, which is out of alphabetical order
 * but is the height most existing buttons actually use. It was added after a
 * sweep through `pages/` found almost nothing could adopt this component: the
 * h-8 cluster had no matching size, and `md`/`lg` could not be renumbered
 * without silently shrinking the ~100 buttons already using them.
 */
export type ButtonSize = 'xs' | 'sm' | 'base' | 'md' | 'lg'

/**
 * `circle` collapses the button to a round icon-only target: square, no
 * horizontal padding, fully rounded.
 *
 * It is a shape on `Button` rather than a new tone on `IconButton` because
 * what the composer's send button needs is the *primary* button — ink at rest,
 * terracotta on hover, and above all an opaque disabled fill. `IconButton`
 * dims to `opacity-50` instead, and half-transparent ink over the page ground
 * reads as "still loading" rather than "not available" — the exact reason
 * `DISABLED_FILL` exists below. Reproducing primary's colors on `IconButton`
 * would have forked that definition in two, past the token contrast guards.
 */
export type ButtonShape = 'default' | 'circle'

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant
  size?: ButtonSize
  /** `circle` requires `aria-label`: it renders the icon alone, with no text. */
  shape?: ButtonShape
  /** Swaps `icon` for a spinner and disables the button. Also sets `aria-busy`. */
  loading?: boolean
  icon?: ReactNode
  iconPosition?: 'start' | 'end'
  /** Stretches to the container width. Replaces ad-hoc `className="w-full"`. */
  block?: boolean
}

/**
 * Disabled styling lives per-variant rather than in the base classes.
 *
 * A single `disabled:opacity-50` cannot express the handoff's disabled primary,
 * which is an opaque `--s1` block with `--t3` text — half-transparent ink over
 * the page ground reads as "still loading" rather than "not available". Putting
 * it here also sidesteps a base-vs-variant class fight the component cannot
 * resolve without `tailwind-merge` (see components/AGENTS.md §3.6).
 */
const DISABLED_FILL =
  'disabled:bg-[var(--color-surface-hover)] disabled:text-[var(--color-text-tertiary)] disabled:shadow-none disabled:border-transparent'
const DISABLED_FADE = 'disabled:opacity-50'

const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  // Solid ink, and still ink on hover (a lighter one). It is deliberately not
  // the brand color: terracotta is reserved for the brand, the send key and
  // selection, so an ink block is what reads as "the button". The old hover
  // lift and terracotta flip made every confirm look like a marketing CTA.
  primary:
    `bg-[var(--color-btn-primary-bg)] text-[var(--color-btn-primary-fg)] shadow-[var(--shadow-button-primary)] hover:bg-[var(--color-btn-primary-hover)] active:scale-[0.98] ${DISABLED_FILL}`,
  // Terracotta at rest. `primary`'s ink block is right where a button sits among
  // other buttons; `accent` is for the one control on a surface that has no
  // competition and has to be found instantly — the composer's send key. Using
  // it anywhere terracotta already marks something else is what `primary`
  // exists to avoid.
  accent:
    `bg-[var(--color-brand)] text-[var(--color-on-primary)] shadow-[var(--shadow-button-primary)] hover:bg-[var(--color-brand-hover)] active:scale-[0.98] ${DISABLED_FILL}`,
  secondary:
    `bg-[var(--color-surface)] text-[var(--color-text-primary)] border border-[var(--color-border)] hover:border-[var(--color-outline)] hover:bg-[var(--color-surface-hover)] active:scale-[0.98] ${DISABLED_FILL}`,
  tonal:
    // Text is the darkened pair, not `--color-brand`: the raw accent only makes
    // 4.3:1 on its own soft fill under the two ink palettes.
    `bg-[var(--color-brand-soft)] text-[var(--color-on-brand-soft)] hover:bg-[var(--color-brand-soft-hover)] active:scale-[0.98] ${DISABLED_FILL}`,
  'tonal-outline':
    `bg-transparent text-[var(--color-brand)] border border-[var(--color-primary-fixed-dim)] hover:bg-[var(--color-brand)] hover:border-[var(--color-brand)] hover:text-[var(--color-on-primary)] active:scale-[0.98] ${DISABLED_FADE}`,
  ghost:
    `bg-transparent text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)] active:scale-[0.98] ${DISABLED_FADE}`,
  danger:
    // Foreground from a token, not `white`: dark's --color-error is a light red
    // that white text is unreadable on.
    `bg-[var(--color-error)] text-[var(--color-on-error)] hover:brightness-110 active:scale-[0.98] ${DISABLED_FILL}`,
  inverse:
    `bg-[var(--color-inverse-surface)] text-[var(--color-inverse-on-surface)] hover:bg-[var(--color-btn-primary-hover)] active:scale-[0.98] ${DISABLED_FILL}`,
  'danger-outline':
    `bg-transparent text-[var(--color-error)] border border-[var(--color-error)] hover:bg-[var(--color-error-soft)] active:scale-[0.98] ${DISABLED_FADE}`,
  'danger-ghost':
    `bg-transparent text-[var(--color-error)] hover:bg-[var(--color-error-soft)] active:scale-[0.98] ${DISABLED_FADE}`,
  link:
    `bg-transparent text-[var(--color-brand)] underline-offset-2 hover:underline hover:text-[var(--color-brand-hover)] px-0 ${DISABLED_FADE}`,
}

/**
 * Each size pins an explicit height. Before this, the three sizes set only
 * padding, which is the direct cause of the 18 distinct button heights across
 * the app: any caller who needed a specific height had to bypass the component.
 *
 * The values reproduce what `px-2 py-1 text-xs` / `px-4 py-2 text-sm` /
 * `px-5 py-2.5 text-sm` already rendered, so adopting this component does not
 * move any existing button. `xs` is new.
 */
const SIZE_CLASSES: Record<ButtonSize, string> = {
  xs: 'h-5 text-[11px] gap-1',
  sm: 'h-6 text-xs gap-1.5',
  base: 'h-8 text-[13px] gap-1.5',
  md: 'h-9 text-sm gap-1.5',
  lg: 'h-10 text-sm gap-2',
}

/**
 * Horizontal padding, separate from the size class so `link` can drop it.
 * When it lived inside SIZE_CLASSES, `link` emitted both `px-0` and the size's
 * `px-4` — and Tailwind resolves that by sorting the generated stylesheet, not
 * by the order the classes were passed, so the winner was a coin flip.
 */
const SIZE_PX: Record<ButtonSize, string> = {
  xs: 'px-1.5',
  sm: 'px-2',
  base: 'px-3',
  md: 'px-4',
  lg: 'px-5',
}

/**
 * Widths for `shape="circle"`, one per size's height in SIZE_CLASSES. A circle
 * is only a circle while the two agree, so these are not free to drift.
 */
const SIZE_SQUARE: Record<ButtonSize, string> = {
  xs: 'w-5',
  sm: 'w-6',
  base: 'w-8',
  md: 'w-9',
  lg: 'w-10',
}

const SPINNER_SIZE: Record<ButtonSize, number> = { xs: 11, sm: 12, base: 14, md: 16, lg: 16 }

/**
 * The radius lives here rather than in BASE_CLASSES for the same reason `link`
 * pulls `px` out of the size class: emitting both `rounded-[var(--radius-md)]`
 * and `rounded-full` would leave the winner to stylesheet order rather than to
 * the shape that was asked for (see components/AGENTS.md §3.6). Exactly one
 * radius may ever be emitted.
 */
const SHAPE_RADIUS: Record<ButtonShape, string> = {
  default: 'rounded-[var(--radius-md)]',
  circle: 'rounded-full',
}

const BASE_CLASSES = [
  'inline-flex items-center justify-center',
  'font-medium cursor-pointer',
  // The handoff pins one motion curve on every button: .16s on paint, .14s on
  // transform. `transition-colors` alone would leave the hover lift snapping.
  'transition-[background-color,color,border-color,box-shadow,transform,opacity] duration-150 ease-out',
  // `--color-border-focus` resolves to the terracotta accent in all six
  // palettes; the 2px offset is the handoff's global focus treatment, and the
  // offset color has to be a token or it paints white on the ink themes.
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)]',
  'focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-surface)]',
  'disabled:cursor-not-allowed disabled:pointer-events-none disabled:translate-y-0',
  'motion-reduce:transition-none motion-reduce:hover:translate-y-0 motion-reduce:active:scale-100',
].join(' ')

/**
 * The button for anything with a visible label. For icon-only controls use
 * `IconButton`, which forces an accessible name.
 *
 * `type` defaults to `"button"`. The native default is `"submit"`, which makes
 * any button dropped inside a form submit it on click — a bug that only shows
 * up once someone wraps the surrounding markup in a `<form>`.
 *
 * Wrapped in `forwardRef` because overlays anchor to their trigger: `Tooltip`
 * and `Dropdown` both attach a ref to whatever they are given. A component
 * that swallows the ref leaves the tooltip unpositionable and stops the
 * dropdown returning focus on close — silently, with only a console warning.
 * (React 19 would pass `ref` as a plain prop, but the installed runtime is
 * 18.3.1 despite what package.json declares.)
 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button({
  variant = 'primary',
  size = 'md',
  shape = 'default',
  loading = false,
  icon,
  iconPosition = 'start',
  block = false,
  type = 'button',
  disabled,
  children,
  className,
  ...props
}, ref) {
  const leading = loading ? <Spinner size={SPINNER_SIZE[size]} /> : iconPosition === 'start' ? icon : null
  const trailing = !loading && iconPosition === 'end' ? icon : null

  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cx(
        BASE_CLASSES,
        SHAPE_RADIUS[shape],
        VARIANT_CLASSES[variant],
        SIZE_CLASSES[size],
        // A circle carries no label, so it takes a matching width instead of
        // horizontal padding.
        shape === 'circle' ? SIZE_SQUARE[size] : variant !== 'link' && SIZE_PX[size],
        block && 'w-full',
        className,
      )}
      {...props}
    >
      {leading}
      {children}
      {trailing}
    </button>
  )
})
