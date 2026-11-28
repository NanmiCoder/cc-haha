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
    /** Optional right-aligned adornment (such as a `<Kbd>` shortcut hint) shown when the clear button is absent. */
    trailing?: ReactNode
    /** Monospace face with tabular numerals for symbol/path filtering. */
    mono?: boolean
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
  sm: 'rounded-[var(--radius-control)]',
  md: 'rounded-[var(--radius-card-inner)]',
  lg: 'rounded-[var(--radius-card-inner)]',
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
  trailing,
  mono = false,
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
  const showClear = clearable && Boolean(value)
  const showTrailing = !showClear && Boolean(trailing)

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
            'pointer-events-none absolute top-1/2 flex -translate-y-1/2 items-center text-[var(--color-text-tertiary)]',
            ICON_INSET[size],
          )}
        >
          {icon ?? <Search size={ICON_PX[size]} strokeWidth={1.75} />}
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
            'w-full border outline-none bg-clip-padding',
            RADIUS[size],
            'bg-[var(--color-surface)] text-[var(--color-text-primary)]',
            'placeholder:text-[var(--color-text-tertiary)]',
            'border-[var(--color-border)] shadow-[var(--bevel-surface-rest)]',
            'transition-[border-color,box-shadow,background-color] duration-150 ease-out',
            'enabled:hover:border-[var(--color-outline)]',
            'focus:border-[var(--color-border-focus)] focus:shadow-[var(--shadow-focus-ring)]',
            'disabled:cursor-not-allowed disabled:opacity-60 disabled:bg-[var(--color-surface-container)] disabled:shadow-none',
            // Chrome renders its own clear affordance for type=search; ours is
            // a real button, so hide the native one rather than showing two.
            '[&::-webkit-search-cancel-button]:appearance-none',
            FIELD_SIZE_CLASSES[size],
            TEXT_INSET[size],
            mono && 'font-mono tabular-nums',
            showClear ? 'pr-8' : showTrailing ? 'pr-12' : '',
            className,
          )}
          {...props}
        />
        {showClear && (
          <button
            type="button"
            onClick={() => {
              onChange('')
              onClear?.()
            }}
            aria-label={clearLabel}
            className="absolute right-1.5 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded-full text-[var(--color-text-tertiary)] transition-[background-color,color,transform] duration-150 hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)] active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)] motion-reduce:active:scale-100"
          >
            <X size={12} strokeWidth={1.75} />
          </button>
        )}
        {showTrailing && (
          <span className="pointer-events-none absolute right-2 top-1/2 flex -translate-y-1/2 items-center">
            {trailing}
          </span>
        )}
      </div>
    </div>
  )
})
