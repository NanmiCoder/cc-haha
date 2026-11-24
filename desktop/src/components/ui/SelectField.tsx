import { useId, type ReactNode, type SelectHTMLAttributes } from 'react'

import { cx } from '@/lib/cx'
import { FIELD_BASE_CLASSES, FIELD_SIZE_CLASSES, fieldStateClasses, type FieldSize } from './Input'

export type SelectOption<T extends string = string> = {
  value: T
  label: string
  disabled?: boolean
}

export type SelectFieldProps<T extends string = string> =
  Omit<SelectHTMLAttributes<HTMLSelectElement>, 'size' | 'onChange' | 'value' | 'children'> & {
    /**
     * Required. All 7 native selects in the app shipped without a label or an
     * `aria-label`, leaving them nameless in the accessibility tree.
     */
    label: string
    labelHidden?: boolean
    options: ReadonlyArray<SelectOption<T>>
    value: T
    onChange: (value: T) => void
    hint?: ReactNode
    error?: string
    size?: FieldSize
    containerClassName?: string
  }

/**
 * A native `<select>` with its label wired up.
 *
 * Deliberately native rather than a custom listbox: the platform control gets
 * keyboard interaction, type-ahead, mobile pickers and screen-reader support
 * for free, and none of the 7 call sites needs custom option rendering. Use
 * `Dropdown` when the options need custom markup.
 */
export function SelectField<T extends string = string>({
  label,
  labelHidden = false,
  options,
  value,
  onChange,
  hint,
  error,
  size = 'lg',
  className,
  containerClassName,
  id,
  disabled,
  ...props
}: SelectFieldProps<T>) {
  const generatedId = useId()
  const selectId = id ?? generatedId
  const hintId = `${selectId}-hint`
  const errorId = `${selectId}-error`
  const describedBy = error ? errorId : hint ? hintId : undefined

  return (
    <div className={cx('flex flex-col gap-1', containerClassName)}>
      {!labelHidden && (
        <label htmlFor={selectId} className="text-sm font-medium text-[var(--color-text-primary)]">
          {label}
        </label>
      )}
      <select
        id={selectId}
        value={value}
        disabled={disabled}
        aria-label={labelHidden ? label : undefined}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        onChange={(event) => onChange(event.target.value as T)}
        className={cx(FIELD_BASE_CLASSES, FIELD_SIZE_CLASSES[size], fieldStateClasses(!!error), 'cursor-pointer', className)}
        {...props}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value} disabled={option.disabled}>
            {option.label}
          </option>
        ))}
      </select>
      {error
        ? <p id={errorId} role="alert" className="text-xs text-[var(--color-error)]">{error}</p>
        : hint
          ? <p id={hintId} className="text-xs text-[var(--color-text-tertiary)]">{hint}</p>
          : null}
    </div>
  )
}
