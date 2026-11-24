import { useRef, type ReactNode } from 'react'

import { cx } from '@/lib/cx'

export type SegmentedItem<T extends string> = {
  value: T
  label: ReactNode
  icon?: ReactNode
  disabled?: boolean
  /** Native tooltip, for icon-only segments. */
  title?: string
}

export type SegmentedControlProps<T extends string> = {
  items: ReadonlyArray<SegmentedItem<T>>
  value: T
  onChange: (value: T) => void
  /** Required. Names the group for screen readers. */
  label: string
  /**
   * `radiogroup` for picking a value, `tablist` for switching views. The
   * distinction matters: a screen reader announces "tab 2 of 4" only for the
   * latter, and only a tablist implies associated panels.
   */
  as?: 'radiogroup' | 'tablist'
  /**
   * `chip` is a wrapping row of separate pill buttons rather than one framed
   * track — for option sets too long for a single line (the market's catalog
   * categories). It wraps instead of scrolling sideways: a hidden horizontal
   * overflow hides options from anyone who never thinks to scroll.
   */
  appearance?: 'solid' | 'raised' | 'underline' | 'chip'
  size?: 'sm' | 'md'
  /** `fill` stretches segments equally; `auto` sizes each to its content. */
  layout?: 'fill' | 'auto'
  className?: string
}

const SIZE_CLASSES = {
  sm: 'h-7 text-xs',
  md: 'h-8 text-sm',
} as const

const SEGMENT_PADDING = {
  sm: 'px-2.5 gap-1',
  md: 'px-3 gap-1.5',
} as const

/** Chips size themselves; the wrapping row has no single height to pin. */
const CHIP_SIZE_CLASSES = {
  sm: 'h-7 px-3 gap-1 text-xs',
  md: 'h-8 px-3.5 gap-1.5 text-[13px]',
} as const

/**
 * A row of mutually exclusive options.
 *
 * Collapses 10 implementations with 6 different active-state treatments
 * (gradient fill, flat fill, border plus tint, raised white, underline, plain
 * color shift) — five of which lived inside `pages/Settings.tsx` alone, where
 * two adjacent selectors had character-identical wrappers and different
 * active fills.
 *
 * Arrow keys move between segments, which none of the four `role="tab"` call
 * sites supported; none of them had a `role="tablist"` parent either, so the
 * roles announced nothing.
 */
export function SegmentedControl<T extends string>({
  items,
  value,
  onChange,
  label,
  as = 'radiogroup',
  appearance = 'solid',
  size = 'md',
  layout = 'auto',
  className,
}: SegmentedControlProps<T>) {
  const containerRef = useRef<HTMLDivElement>(null)

  const focusSegment = (index: number) => {
    const buttons = containerRef.current?.querySelectorAll<HTMLButtonElement>('button:not([disabled])')
    if (!buttons?.length) return
    const wrapped = (index + buttons.length) % buttons.length
    buttons[wrapped]?.focus()
    buttons[wrapped]?.click()
  }

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return
    const buttons = Array.from(
      containerRef.current?.querySelectorAll<HTMLButtonElement>('button:not([disabled])') ?? [],
    )
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement)
    if (current === -1) return
    event.preventDefault()
    focusSegment(current + (event.key === 'ArrowRight' ? 1 : -1))
  }

  const isTabs = as === 'tablist'
  const isChip = appearance === 'chip'

  return (
    <div
      ref={containerRef}
      role={as}
      aria-label={label}
      onKeyDown={handleKeyDown}
      className={cx(
        isChip ? 'flex flex-wrap items-center gap-1.5' : 'inline-flex items-center',
        appearance === 'underline'
          ? 'gap-1 border-b border-[var(--color-border)]'
          : !isChip && 'gap-0.5 rounded-[var(--radius-md)] bg-[var(--color-surface-container-high)] p-0.5',
        layout === 'fill' && 'flex w-full',
        !isChip && SIZE_CLASSES[size],
        className,
      )}
    >
      {items.map((item) => {
        const selected = item.value === value
        return (
          <button
            key={item.value}
            type="button"
            role={isTabs ? 'tab' : 'radio'}
            aria-selected={isTabs ? selected : undefined}
            aria-checked={isTabs ? undefined : selected}
            // Roving tabindex: the group is one tab stop, arrows move within it.
            tabIndex={selected ? 0 : -1}
            disabled={item.disabled}
            title={item.title}
            onClick={() => onChange(item.value)}
            className={cx(
              'inline-flex items-center justify-center font-medium whitespace-nowrap',
              'transition-colors duration-150 cursor-pointer',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)]',
              'disabled:cursor-not-allowed disabled:opacity-50',
              isChip ? CHIP_SIZE_CLASSES[size] : cx('h-full', SEGMENT_PADDING[size]),
              layout === 'fill' && 'flex-1',
              isChip
                ? cx(
                  'rounded-full border',
                  // The ink fill of the primary button, so the picked chip
                  // reads as the same "on" state as the page's main action.
                  selected
                    ? 'border-[var(--color-btn-primary-bg)] bg-[var(--color-btn-primary-bg)] text-[var(--color-btn-primary-fg)]'
                    : 'border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text-secondary)] hover:border-[var(--color-border-strong)] hover:text-[var(--color-text-primary)]',
                )
                : appearance === 'underline'
                ? cx(
                  'rounded-none border-b-2 -mb-px',
                  selected
                    ? 'border-[var(--color-brand)] text-[var(--color-brand)]'
                    : 'border-transparent text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]',
                )
                : cx(
                  'rounded-[var(--radius-sm)]',
                  // `solid` and `raised` now share the lifted segment: a
                  // terracotta-filled segment competed with the send key for
                  // "the one brand-colored thing on screen".
                  selected
                    ? 'bg-[var(--color-surface)] text-[var(--color-text-primary)] shadow-[var(--shadow-segment)]'
                    : 'text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]',
                ),
            )}
          >
            {item.icon}
            {item.label}
          </button>
        )
      })}
    </div>
  )
}
