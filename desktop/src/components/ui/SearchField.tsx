import { Search, X } from 'lucide-react'
import { forwardRef, useId, type InputHTMLAttributes, type KeyboardEvent, type ReactNode } from 'react'

import { cx } from '@/lib/cx'
import { FIELD_SIZE_CLASSES, type FieldSize } from './Input'

export type SearchFieldProps =
  Omit<InputHTMLAttributes<HTMLInputElement>, 'size' | 'type' | 'value' | 'onChange'> & {
    value: string
    onChange: (value: string) => void
    /** Required. A search box rarely has a visible label, so this is its name. */
    label: string
    showLabel?: boolean
    size?: FieldSize
    /** Shows a clear button once there is text. */
    clearable?: boolean
    /**
     * Required whenever `clearable` is on. Two earlier attempts were both
     * wrong: composing `Clear ${label}` in the component hardcoded English and
     * made adoption an i18n regression, while falling back to `label` gave the
     * input and its clear button the *same* accessible name — `getByLabelText`
     * then matches two elements and throws. Only the caller can supply a
     * translated, distinct name, so it has to ask for one.
     */
    clearLabel: string
    onClear?: () => void
    /** Overrides the magnifier. */
    icon?: ReactNode
    containerClassName?: string
    /** Arrow keys move through a result list without leaving the field. */
    onNavigate?: (direction: 'up' | 'down') => void
    /** id of the listbox this field controls, for the combobox pattern. */
    controlsId?: string
    activeDescendantId?: string
  }

const ICON_PX: Record<FieldSize, number> = { sm: 13, md: 14, lg: 16, xl: 16 }
const ICON_INSET: Record<FieldSize, string> = { sm: 'left-2', md: 'left-2.5', lg: 'left-3', xl: 'left-3.5' }
const TEXT_INSET: Record<FieldSize, string> = { sm: 'pl-7', md: 'pl-8', lg: 'pl-9', xl: 'pl-10' }
/** Page-level (`xl`) search bars take the card corner; inline ones the control corner. */
const RADIUS: Record<FieldSize, string> = {
  sm: 'rounded-[var(--radius-md)]',
  md: 'rounded-[var(--radius-md)]',
  lg: 'rounded-[var(--radius-md)]',
  xl: 'rounded-[var(--radius-lg)]',
}

/**
 * The search box.
 *
 * There were 11 independent implementations, in 2 structures and with 7
 * different focus treatments — three of which had no visible focus state at
 * all, so a keyboard user could not tell the field was active.
 *
 * `role="searchbox"` comes from `type="search"`, and the clear button is a real
 * button rather than a click handler on an icon, so it is reachable by keyboard.
 */
export const SearchField = forwardRef<HTMLInputElement, SearchFieldProps>(function SearchField({
  value,
  onChange,
  label,
  showLabel = false,
  size = 'md',
  clearable = true,
  clearLabel,
  onClear,
  icon,
  className,
  containerClassName,
  onNavigate,
  onKeyDown,
  controlsId,
  activeDescendantId,
  disabled,
  id,
  ...props
}: SearchFieldProps, ref) {
  const generatedId = useId()
  const inputId = id ?? generatedId

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (onNavigate && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      event.preventDefault()
      onNavigate(event.key === 'ArrowDown' ? 'down' : 'up')
    }
    onKeyDown?.(event)
  }

  return (
    <div className={cx('flex flex-col gap-1', containerClassName)}>
      {showLabel && (
        <label htmlFor={inputId} className="text-sm font-medium text-[var(--color-text-primary)]">
          {label}
        </label>
      )}
      <div className="relative">
        <span
          aria-hidden="true"
          className={cx(
            'pointer-events-none absolute top-1/2 -translate-y-1/2 text-[var(--color-text-tertiary)]',
            ICON_INSET[size],
          )}
        >
          {icon ?? <Search size={ICON_PX[size]} strokeWidth={2} />}
        </span>
        <input
          ref={ref}
          id={inputId}
          type="search"
          value={value}
          disabled={disabled}
          aria-label={showLabel ? undefined : label}
          aria-controls={controlsId}
          aria-activedescendant={activeDescendantId}
          role={controlsId ? 'combobox' : undefined}
          aria-expanded={controlsId ? true : undefined}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={handleKeyDown}
          className={cx(
            'w-full border outline-none',
            RADIUS[size],
            'bg-[var(--color-surface)] text-[var(--color-text-primary)]',
            'placeholder:text-[var(--color-text-tertiary)]',
            'border-[var(--color-border)] transition-colors duration-150',
            'focus:border-[var(--color-border-focus)] focus:shadow-[var(--shadow-focus-ring)]',
            'disabled:cursor-not-allowed disabled:opacity-60',
            // Chrome renders its own clear affordance for type=search; ours is
            // a real button, so hide the native one rather than showing two.
            '[&::-webkit-search-cancel-button]:appearance-none',
            FIELD_SIZE_CLASSES[size],
            TEXT_INSET[size],
            clearable && value ? 'pr-8' : '',
            className,
          )}
          {...props}
        />
        {clearable && value && (
          <button
            type="button"
            onClick={() => {
              onChange('')
              onClear?.()
            }}
            aria-label={clearLabel}
            className="absolute right-1.5 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded-full text-[var(--color-text-tertiary)] transition-colors hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)]"
          >
            <X size={12} strokeWidth={2.5} />
          </button>
        )}
      </div>
    </div>
  )
})
