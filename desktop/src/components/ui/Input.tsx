import { useId, type InputHTMLAttributes, type ReactNode } from 'react'

import { cx } from '@/lib/cx'

/** `xl` is the 44px page-level tier the handoff draws for market/list search bars. */
export type FieldSize = 'sm' | 'md' | 'lg' | 'xl'

export type InputProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> & {
  label?: string
  /** Guidance shown below the field while it is valid. */
  hint?: ReactNode
  /** Replaces `hint` when present and marks the field invalid. */
  error?: string
  required?: boolean
  size?: FieldSize
  containerClassName?: string
}

export const FIELD_SIZE_CLASSES: Record<FieldSize, string> = {
  sm: 'h-7 px-2 text-xs',
  md: 'h-8 px-2.5 text-sm',
  lg: 'h-10 px-3 text-sm',
  xl: 'h-11 px-3.5 text-sm',
}

/**
 * Base classes shared by every text-entry control, so a textarea and an input
 * sitting next to each other actually match.
 */
export const FIELD_BASE_CLASSES = [
  'w-full rounded-[var(--radius-md)] border outline-none',
  'bg-[var(--color-surface)] text-[var(--color-text-primary)]',
  'placeholder:text-[var(--color-text-tertiary)]',
  'transition-colors duration-150',
  'disabled:cursor-not-allowed disabled:opacity-60 disabled:bg-[var(--color-surface-container)]',
].join(' ')

export function fieldStateClasses(invalid: boolean): string {
  return invalid
    ? 'border-[var(--color-error)] focus:shadow-[var(--shadow-error-ring)]'
    : 'border-[var(--color-border)] focus:border-[var(--color-border-focus)] focus:shadow-[var(--shadow-focus-ring)]'
}

/**
 * A single-line text field with its label, hint and error wired together.
 *
 * The id now comes from `useId()`. It used to be derived from the label text
 * (`label.toLowerCase().replace(/\s+/g, '-')`), which collides for any two
 * Chinese labels — Chinese has no spaces, so the replace is a no-op and two
 * different labels can produce the same id, pointing one `<label>` at the other
 * field's input.
 *
 * Across the 76 native inputs this replaces, `aria-invalid` appeared once,
 * `disabled:` styling never, and `focus-visible:` never.
 */
export function Input({
  label,
  hint,
  error,
  required,
  size = 'lg',
  className,
  containerClassName,
  id,
  disabled,
  ...props
}: InputProps) {
  const generatedId = useId()
  const inputId = id ?? generatedId
  const hintId = `${inputId}-hint`
  const errorId = `${inputId}-error`
  const describedBy = error ? errorId : hint ? hintId : undefined

  return (
    <div className={cx('flex flex-col gap-1', containerClassName)}>
      {label && (
        <label htmlFor={inputId} className="text-sm font-medium text-[var(--color-text-primary)]">
          {label}
          {required && <span className="ml-0.5 text-[var(--color-error)]">*</span>}
        </label>
      )}
      <input
        id={inputId}
        disabled={disabled}
        required={required}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        className={cx(FIELD_BASE_CLASSES, FIELD_SIZE_CLASSES[size], fieldStateClasses(!!error), className)}
        {...props}
      />
      {error
        ? <p id={errorId} role="alert" className="text-xs text-[var(--color-error)]">{error}</p>
        : hint
          ? <p id={hintId} className="text-xs text-[var(--color-text-tertiary)]">{hint}</p>
          : null}
    </div>
  )
}
