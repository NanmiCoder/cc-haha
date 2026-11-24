import { forwardRef, useId, type ReactNode, type TextareaHTMLAttributes } from 'react'

import { cx } from '@/lib/cx'
import { FIELD_BASE_CLASSES, fieldStateClasses } from './Input'

export type TextAreaProps = TextareaHTMLAttributes<HTMLTextAreaElement> & {
  label?: string
  hint?: ReactNode
  error?: string
  required?: boolean
  containerClassName?: string
}

/**
 * A multi-line text field, matching `Input` in every respect except height.
 *
 * All 13 textareas in the app were unlabeled and had no id, so clicking their
 * label — where one existed — did not focus them, and a screen reader
 * encountered them as anonymous edit boxes.
 *
 * Forwards its ref to the `<textarea>` so callers can focus it and place the
 * caret, e.g. an inline editor that opens with the cursor at the end.
 */
export const TextArea = forwardRef<HTMLTextAreaElement, TextAreaProps>(function TextArea({
  label,
  hint,
  error,
  required,
  rows = 4,
  className,
  containerClassName,
  id,
  disabled,
  ...props
}, ref) {
  const generatedId = useId()
  const textareaId = id ?? generatedId
  const hintId = `${textareaId}-hint`
  const errorId = `${textareaId}-error`
  const describedBy = error ? errorId : hint ? hintId : undefined

  return (
    <div className={cx('flex flex-col gap-1', containerClassName)}>
      {label && (
        <label htmlFor={textareaId} className="text-sm font-medium text-[var(--color-text-primary)]">
          {label}
          {required && <span className="ml-0.5 text-[var(--color-error)]">*</span>}
        </label>
      )}
      <textarea
        ref={ref}
        id={textareaId}
        rows={rows}
        disabled={disabled}
        required={required}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        className={cx(FIELD_BASE_CLASSES, 'px-2.5 py-2 text-sm leading-6', fieldStateClasses(!!error), className)}
        {...props}
      />
      {error
        ? <p id={errorId} role="alert" className="text-xs text-[var(--color-error)]">{error}</p>
        : hint
          ? <p id={hintId} className="text-xs text-[var(--color-text-tertiary)]">{hint}</p>
          : null}
    </div>
  )
})
