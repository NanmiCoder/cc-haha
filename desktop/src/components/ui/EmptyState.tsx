import type { ReactNode } from 'react'

import { cx } from '@/lib/cx'
import { Button } from './Button'

export type StateSize = 'sm' | 'md' | 'lg'

export type EmptyStateProps = {
  icon?: ReactNode
  /** Rendered as a heading. Omit for one-line placeholders inside a panel. */
  title?: string
  description?: string
  /** The call to action. Only 1 of the 24 hand-rolled empty states had one. */
  action?: {
    label: string
    onClick: () => void
    variant?: 'primary' | 'secondary' | 'tonal'
  }
  size?: StateSize
  /**
   * `dashed` is the bordered placeholder box, `plain` drops the border, and
   * `inline` is a compact single-line version for use inside a list.
   */
  variant?: 'dashed' | 'plain' | 'inline'
  /** Keeps the document outline correct. Defaults to `h3`. */
  headingLevel?: 2 | 3 | 4
  className?: string
}

const SIZE_CLASSES: Record<StateSize, string> = {
  sm: 'px-3 py-6 gap-1.5',
  md: 'px-5 py-10 gap-2',
  lg: 'px-6 py-16 gap-3',
}

const ICON_BOX: Record<StateSize, string> = {
  sm: 'h-8 w-8',
  md: 'h-10 w-10',
  lg: 'h-12 w-12',
}

const TITLE_SIZE: Record<StateSize, string> = {
  sm: 'text-xs',
  md: 'text-sm',
  lg: 'text-[15px]',
}

/**
 * The "nothing here yet" placeholder.
 *
 * Replaces 22 hand-rolled empty states across 15 files. Three of them were
 * local components all called `EmptyState`, imported nowhere else, with
 * incompatible props — one took `{icon, text}`, another `{title, body}`.
 *
 * The title renders as a real heading. In the previous versions only 2 of 24
 * used a heading tag; to a screen reader the rest were ordinary paragraphs, so
 * the reason a region was empty never showed up in the document outline.
 */
export function EmptyState({
  icon,
  title,
  description,
  action,
  size = 'md',
  variant = 'dashed',
  headingLevel = 3,
  className,
}: EmptyStateProps) {
  const Heading = `h${headingLevel}` as 'h2' | 'h3' | 'h4'

  if (variant === 'inline') {
    return (
      <div className={cx('flex items-center gap-2 px-3 py-2 text-xs text-[var(--color-text-tertiary)]', className)}>
        {icon}
        <span>{title ?? description}</span>
      </div>
    )
  }

  return (
    <div
      className={cx(
        'flex flex-col items-center justify-center text-center',
        variant === 'dashed' && 'rounded-[var(--radius-lg)] border border-dashed border-[var(--color-border)] bg-[var(--color-surface)]',
        SIZE_CLASSES[size],
        className,
      )}
    >
      {icon && (
        <span
          aria-hidden="true"
          className={cx(
            'flex items-center justify-center rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface-container-low)] text-[var(--color-text-tertiary)]',
            ICON_BOX[size],
          )}
        >
          {icon}
        </span>
      )}
      {title && (
        <Heading className={cx('font-semibold text-[var(--color-text-primary)]', TITLE_SIZE[size])}>
          {title}
        </Heading>
      )}
      {description && (
        <p className="max-w-prose text-xs leading-6 text-[var(--color-text-tertiary)]">{description}</p>
      )}
      {action && (
        <Button
          size={size === 'sm' ? 'sm' : 'md'}
          variant={action.variant ?? 'secondary'}
          onClick={action.onClick}
          className="mt-1"
        >
          {action.label}
        </Button>
      )}
    </div>
  )
}
