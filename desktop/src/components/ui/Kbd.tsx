import { forwardRef, type HTMLAttributes, type ReactNode } from 'react'

import { cx } from '@/lib/cx'

export type KbdSize = 'xs' | 'sm' | 'md'
export type KbdAppearance = 'surface' | 'subtle' | 'inverse'

export type KbdProps = HTMLAttributes<HTMLElement> & {
  size?: KbdSize
  appearance?: KbdAppearance
  children: ReactNode
}

const SIZE_CLASSES: Record<KbdSize, string> = {
  xs: 'h-[18px] min-w-[18px] px-1 text-[11px]',
  sm: 'h-5 min-w-5 px-1.5 text-[11px]',
  md: 'h-6 min-w-6 px-1.5 text-xs',
}

const APPEARANCE_CLASSES: Record<KbdAppearance, string> = {
  surface: [
    'border border-b-2 border-[var(--color-border)]',
    'bg-[var(--color-surface-container-low)] text-[var(--color-text-secondary)]',
    'shadow-[var(--bevel-surface-rest)]',
  ].join(' '),
  subtle: [
    'border border-[var(--color-border)]',
    'bg-[var(--color-surface-container)] text-[var(--color-text-tertiary)]',
  ].join(' '),
  inverse: [
    'border border-b-2 border-[var(--color-surface-glass-border)]',
    'bg-[var(--color-inverse-surface)] text-[var(--color-inverse-on-surface)]',
  ].join(' '),
}

/**
 * Physical keycap hint for keyboard shortcuts in menus, tooltips, search
 * palettes, and toolbar actions.
 */
export const Kbd = forwardRef<HTMLElement, KbdProps>(function Kbd({
  size = 'sm',
  appearance = 'surface',
  className,
  children,
  ...props
}, ref) {
  return (
    <kbd
      ref={ref}
      className={cx(
        'inline-flex shrink-0 select-none items-center justify-center bg-clip-padding',
        'rounded-[var(--radius-xs)] font-mono font-normal tabular-nums leading-none',
        SIZE_CLASSES[size],
        APPEARANCE_CLASSES[appearance],
        className,
      )}
      {...props}
    >
      {children}
    </kbd>
  )
})

export type KbdGroupProps = HTMLAttributes<HTMLSpanElement> & {
  children: ReactNode
}

/** Joins adjacent `<Kbd>` caps for multi-key shortcuts (e.g. `⌘` `⇧` `P`). */
export function KbdGroup({ className, children, ...props }: KbdGroupProps) {
  return (
    <span className={cx('inline-flex items-center gap-1', className)} {...props}>
      {children}
    </span>
  )
}
