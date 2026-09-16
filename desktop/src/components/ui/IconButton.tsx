import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react'

import { cx } from '@/lib/cx'
import { Spinner } from './Spinner'

/** `2xl` is 44px — the platform minimum for a primary touch target. */
export type IconButtonSize = '2xs' | 'xs' | 'sm' | 'md' | 'lg' | 'xl' | '2xl'
export type IconButtonTone = 'default' | 'secondary' | 'muted' | 'brand' | 'danger'
/** Which surface this button sits on — decides its hover fill. */
export type IconButtonSurface = 'default' | 'sidebar' | 'terminal' | 'media'

export type IconButtonProps =
  Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children' | 'aria-label' | 'title'> & {
    /** A lucide component, a material-symbols name, or any node. */
    icon: ReactNode | string
    /**
     * Required. An icon-only control has no visible text, so without this it is
     * unreachable by screen readers and unlabeled in the accessibility tree.
     * Ten such buttons shipped unnamed before this component existed.
     */
    label: string
    /** Also renders `label` as a native tooltip. Defaults to true. */
    showTooltip?: boolean
    /**
     * `2xs` is 20px; `2xl` (44px) is the platform minimum for PRIMARY touch
     * targets — `xl` (40px) is acceptable only for secondary ones. This line
     * used to call 40px "the mobile touch-target minimum", which contradicted
     * the type's own doc above and put the most-tapped mobile controls a size
     * short.
     */
    size?: IconButtonSize
    tone?: IconButtonTone
    shape?: 'square' | 'circle'
    /** Renders a tinted background at rest, for buttons that need presence. */
    filled?: boolean
    /**
     * Renders the tone at full strength with a contrasting foreground, for
     * buttons that must stay legible over arbitrary content — a remove badge
     * pinned to a user-supplied image, for instance. `filled` only tints, which
     * washes out against a photo.
     */
    solid?: boolean
    /** Hairline border on a transparent background. */
    bordered?: boolean
    /**
     * Turns red on hover while resting in `tone`. For destructive actions that
     * should not shout until the pointer is on them — a delete icon sitting red
     * at rest reads as an error state.
     */
    hoverTone?: 'danger'
    /**
     * Toggle state. Sets `aria-pressed` and a resting fill, so a toolbar toggle
     * does not need its own wrapper component to express "on".
     */
    pressed?: boolean
    /**
     * The sidebar has its own hover token tuned for its gradient background
     * (`--color-sidebar-item-hover`), which differs from `--color-surface-hover`
     * in all three themes. Without this, sidebar buttons cannot adopt this
     * component: two arbitrary `hover:bg-[…]` values would fight and the winner
     * depends on stylesheet order.
     */
    surface?: IconButtonSurface
    /**
     * How the disabled state reads. `dim` fades to 50%; `hide` makes it fully
     * transparent, for controls that only appear on row hover — a ghost at 50%
     * during a load is the bug those call sites were avoiding.
     *
     * A prop rather than a `className` override because both resolve to
     * `disabled:opacity-*`, and Tailwind picks the winner by sorting the values,
     * not by the order they were passed.
     */
    disabledStyle?: 'dim' | 'hide'
    loading?: boolean
  }

const SIZE_CLASSES: Record<IconButtonSize, string> = {
  '2xs': 'h-5 w-5 rounded-[var(--radius-sm)]',
  xs: 'h-6 w-6 rounded-[var(--radius-sm)]',
  sm: 'h-7 w-7 rounded-[var(--radius-md)]',
  md: 'h-8 w-8 rounded-[var(--radius-md)]',
  lg: 'h-9 w-9 rounded-[var(--radius-lg)]',
  xl: 'h-10 w-10 rounded-[var(--radius-lg)]',
  '2xl': 'h-11 w-11 rounded-[var(--radius-lg)]',
}

const ICON_PX: Record<IconButtonSize, number> = {
  '2xs': 11, xs: 13, sm: 14, md: 16, lg: 18, xl: 20, '2xl': 22,
}

const REST_TEXT: Record<IconButtonTone, string> = {
  default: 'text-[var(--color-text-primary)]',
  secondary: 'text-[var(--color-text-secondary)]',
  muted: 'text-[var(--color-text-tertiary)]',
  brand: 'text-[var(--color-brand)]',
  danger: 'text-[var(--color-error)]',
}

/**
 * Surfaces whose ground does not follow `--color-surface`, and so cannot use
 * the text colors above.
 *
 * Terminal controls follow the workspace, while media controls keep their
 * dark surround. Each surface supplies its own text and hover tokens.
 *
 * Partial on purpose: `default` and `sidebar` fall through to the maps above,
 * so their output is unchanged.
 */
const SURFACE_REST_TEXT: Partial<Record<IconButtonSurface, Record<IconButtonTone, string>>> = {
  terminal: {
    default: 'text-[var(--color-terminal-fg)]',
    secondary: 'text-[var(--color-terminal-muted)]',
    muted: 'text-[var(--color-terminal-muted)]',
    brand: 'text-[var(--color-terminal-cursor)]',
    danger: 'text-[var(--color-terminal-danger)]',
  },
  media: {
    default: 'text-[var(--color-media-fg)]',
    secondary: 'text-[var(--color-media-muted)]',
    muted: 'text-[var(--color-media-muted)]',
    brand: 'text-[var(--color-media-cursor)]',
    danger: 'text-[var(--color-media-danger)]',
  },
}

/**
 * Hover background, keyed by tone then by the surface the button sits on.
 *
 * Kept separate from the hover *text* color below, because emitting both and
 * letting `hoverTone` add a third class does not work: Tailwind sorts same-
 * utility arbitrary values alphabetically by value and the last one wins, so
 * `hover:text-[var(--color-text-primary)]` beats
 * `hover:text-[var(--color-error)]` regardless of the order they are passed in.
 * Only one hover text color may ever be emitted.
 */
const HOVER_BG: Record<IconButtonSurface, Record<IconButtonTone, string>> = {
  default: {
    default: 'hover:bg-[var(--color-surface-hover)]',
    secondary: 'hover:bg-[var(--color-surface-hover)]',
    muted: 'hover:bg-[var(--color-surface-hover)]',
    brand: 'hover:bg-[var(--color-brand-soft)]',
    danger: 'hover:bg-[var(--color-error-soft)]',
  },
  sidebar: {
    default: 'hover:bg-[var(--color-sidebar-item-hover)]',
    secondary: 'hover:bg-[var(--color-sidebar-item-hover)]',
    muted: 'hover:bg-[var(--color-sidebar-item-hover)]',
    brand: 'hover:bg-[var(--color-sidebar-item-hover)]',
    danger: 'hover:bg-[var(--color-sidebar-item-hover)]',
  },
  terminal: {
    default: 'hover:bg-[var(--color-terminal-selection)]',
    secondary: 'hover:bg-[var(--color-terminal-selection)]',
    muted: 'hover:bg-[var(--color-terminal-selection)]',
    brand: 'hover:bg-[var(--color-terminal-selection)]',
    danger: 'hover:bg-[var(--color-terminal-selection)]',
  },
  media: {
    default: 'hover:bg-[var(--color-media-selection)]',
    secondary: 'hover:bg-[var(--color-media-selection)]',
    muted: 'hover:bg-[var(--color-media-selection)]',
    brand: 'hover:bg-[var(--color-media-selection)]',
    danger: 'hover:bg-[var(--color-media-selection)]',
  },
}

/** Hover text color. Muted and secondary brighten toward primary on hover. */
const HOVER_TEXT: Record<IconButtonTone, string> = {
  default: '',
  secondary: 'hover:text-[var(--color-text-primary)]',
  muted: 'hover:text-[var(--color-text-primary)]',
  brand: '',
  danger: '',
}

/** See `SURFACE_REST_TEXT`. Only one hover text color may ever be emitted. */
const SURFACE_HOVER_TEXT: Partial<Record<IconButtonSurface, Record<IconButtonTone, string>>> = {
  terminal: {
    default: '',
    secondary: 'hover:text-[var(--color-terminal-fg)]',
    muted: 'hover:text-[var(--color-terminal-fg)]',
    brand: '',
    danger: '',
  },
  media: {
    default: '',
    secondary: 'hover:text-[var(--color-media-fg)]',
    muted: 'hover:text-[var(--color-media-fg)]',
    brand: '',
    danger: '',
  },
}

const FILLED_CLASSES: Record<IconButtonTone, string> = {
  default: 'bg-[var(--color-surface)] border border-[var(--color-border)]',
  secondary: 'bg-[var(--color-surface)] border border-[var(--color-border)]',
  muted: 'bg-[var(--color-surface-container)] border border-[var(--color-border)]',
  brand: 'bg-[var(--color-brand-soft)]',
  danger: 'bg-[var(--color-error-soft)]',
}

/** Full-strength fill with a contrasting foreground, for `solid`. */
const SOLID_CLASSES: Record<IconButtonTone, string> = {
  default: 'bg-[var(--color-inverse-surface)] text-[var(--color-inverse-on-surface)]',
  secondary: 'bg-[var(--color-inverse-surface)] text-[var(--color-inverse-on-surface)]',
  muted: 'bg-[var(--color-inverse-surface)] text-[var(--color-inverse-on-surface)]',
  brand: 'bg-[var(--color-brand)] text-[var(--color-on-primary)]',
  danger: 'bg-[var(--color-error)] text-[var(--color-on-error)]',
}

const PRESSED_CLASSES: Record<IconButtonSurface, string> = {
  default: 'bg-[var(--color-surface-selected)] text-[var(--color-text-primary)]',
  sidebar: 'bg-[var(--color-sidebar-item-hover)] text-[var(--color-text-primary)]',
  terminal: 'bg-[var(--color-terminal-selection)] text-[var(--color-terminal-fg)]',
  media: 'bg-[var(--color-media-selection)] text-[var(--color-media-fg)]',
}

const BASE_CLASSES = [
  'inline-flex shrink-0 items-center justify-center',
  'transition-colors duration-150 cursor-pointer',
  // Offset matches Button: the two sit side by side in every toolbar, and a
  // flush ring next to a floated one reads as two different focus systems.
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)]',
  'focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-surface)]',
  'disabled:cursor-not-allowed disabled:pointer-events-none',
].join(' ')

const DISABLED_OPACITY = { dim: 'disabled:opacity-50', hide: 'disabled:opacity-0' } as const

/**
 * A square/round button holding nothing but an icon.
 *
 * This is the largest single category of hand-rolled control in the app: 76
 * strict icon-only buttons across 40 files, in 15 corner radii and 12 sizes,
 * with a focus ring on 41% of them. Three of them are the same h-7 square with
 * three different radii (`rounded-lg`, `rounded-[7px]`, `rounded-[6px]`).
 *
 * `label` is mandatory rather than optional-with-a-fallback: a fallback would
 * let unnamed buttons keep shipping, which is the state this replaces.
 */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton({
  icon,
  label,
  showTooltip = true,
  size = 'md',
  tone = 'default',
  shape = 'square',
  filled = false,
  solid = false,
  bordered = false,
  hoverTone,
  pressed,
  surface = 'default',
  disabledStyle = 'dim',
  loading = false,
  disabled,
  className,
  type = 'button',
  ...props
}, ref) {
  const iconSize = ICON_PX[size]

  return (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      title={showTooltip ? label : undefined}
      aria-pressed={pressed}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cx(
        BASE_CLASSES,
        DISABLED_OPACITY[disabledStyle],
        SIZE_CLASSES[size],
        // `solid` supplies both fill and foreground, so the tone's resting text
        // color and hover fill are skipped rather than left to compete.
        solid ? SOLID_CLASSES[tone] : (SURFACE_REST_TEXT[surface] ?? REST_TEXT)[tone],
        solid && 'hover:brightness-110',
        // A pressed button carries its own fill and hover; skipping the tone's
        // hover here keeps two `hover:bg-[…]` values from competing.
        !solid && (pressed ? PRESSED_CLASSES[surface] : HOVER_BG[surface][tone]),
        // Exactly one hover text color — `hoverTone` replaces the tone's own
        // rather than stacking on top of it, which Tailwind would silently
        // resolve the wrong way.
        !solid && !pressed && (
          hoverTone === 'danger'
            ? 'hover:text-[var(--color-error)]'
            : (SURFACE_HOVER_TEXT[surface] ?? HOVER_TEXT)[tone]
        ),
        filled && !pressed && !solid && FILLED_CLASSES[tone],
        bordered && !filled && 'border border-[var(--color-border)]',
        shape === 'circle' && 'rounded-full',
        className,
      )}
      {...props}
    >
      {loading
        ? <Spinner size={iconSize} />
        : typeof icon === 'string'
          ? (
            <span className="material-symbols-outlined" style={{ fontSize: iconSize }} aria-hidden="true">
              {icon}
            </span>
          )
          : icon}
    </button>
  )
})
