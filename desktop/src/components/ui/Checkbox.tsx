import type { InputHTMLAttributes, ReactNode } from 'react'
import { useEffect, useId, useRef } from 'react'

import { cx } from '@/lib/cx'

export type CheckboxProps =
  Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'size' | 'children'> & {
    /** Visible label. Pass `labelHidden` when the surrounding row already says it. */
    label: ReactNode
    labelHidden?: boolean
    description?: ReactNode
    /** Renders the mixed state. Has to be set on the DOM node, not as an attribute. */
    indeterminate?: boolean
    size?: 'sm' | 'md'
    containerClassName?: string
  }

const BOX_SIZE = { sm: 'h-3.5 w-3.5', md: 'h-4 w-4' } as const

/**
 * A checkbox with its label wired up.
 *
 * Keeps the native input — `accent-color` gives a themed check mark for free
 * and the browser handles keyboard, indeterminate rendering and form
 * participation. What varied across the 19 existing checkboxes was everything
 * around it: three sizes, two accent tokens for the same underlying color
 * (`--color-primary` and `--color-brand` are aliases), inconsistent class
 * ordering, and labels associated by wrapping in some places and not at all in
 * others.
 */
export function Checkbox({
  label,
  labelHidden = false,
  description,
  indeterminate = false,
  size = 'md',
  disabled,
  className,
  containerClassName,
  ...props
}: CheckboxProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const labelId = useId()
  const descriptionId = useId()

  useEffect(() => {
    if (inputRef.current) inputRef.current.indeterminate = indeterminate
  }, [indeterminate])

  return (
    <label
      className={cx(
        'flex items-start gap-2',
        disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer',
        containerClassName,
      )}
    >
      <input
        ref={inputRef}
        type="checkbox"
        disabled={disabled}
        // Named by the label span rather than by the wrapping <label>: the
        // wrapper also contains `description`, and an implicit label would fold
        // that into the accessible name.
        aria-label={labelHidden && typeof label === 'string' ? label : undefined}
        aria-labelledby={labelHidden ? undefined : labelId}
        aria-describedby={description ? descriptionId : undefined}
        className={cx(
          'mt-0.5 shrink-0 rounded-[var(--radius-sm)] border-[var(--color-border-strong)]',
          'accent-[var(--color-brand)]',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)]',
          disabled && 'cursor-not-allowed',
          BOX_SIZE[size],
          className,
        )}
        {...props}
      />
      {!labelHidden && (
        <span className="min-w-0">
          <span id={labelId} className="block text-sm text-[var(--color-text-primary)]">{label}</span>
          {description && (
            <span id={descriptionId} className="mt-0.5 block text-xs text-[var(--color-text-secondary)]">
              {description}
            </span>
          )}
        </span>
      )}
    </label>
  )
}
