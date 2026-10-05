import type { ReactNode } from 'react'
import { useId } from 'react'

import { cx } from '@/lib/cx'

export type SwitchProps = {
  checked: boolean
  onChange: (checked: boolean) => void
  /**
   * Required. When `labelHidden` is set this becomes the accessible name; a
   * toggle with no name is unusable with a screen reader.
   */
  label: string
  labelHidden?: boolean
  description?: ReactNode
  disabled?: boolean
  size?: 'sm' | 'md'
  className?: string
}

const TRACK_SIZE = {
  sm: 'h-4 w-7',
  md: 'h-[18px] w-8',
} as const

const THUMB_SIZE = {
  sm: 'h-3 w-3',
  md: 'h-3.5 w-3.5',
} as const

const THUMB_OFFSET = {
  sm: 'translate-x-0.5 peer-checked:translate-x-[14px]',
  md: 'translate-x-0.5 peer-checked:translate-x-[16px]',
} as const

/**
 * An on/off toggle.
 *
 * The app had three implementations for three toggles — a 100% inconsistency
 * rate — differing by 27% in size (56×32 vs 44×24) and split between a
 * `role="switch"` button and a hidden checkbox. This keeps the hidden native
 * checkbox: it brings keyboard activation, form participation and the checked
 * state for free, where the button version had to reimplement each.
 */
export function Switch({
  checked,
  onChange,
  label,
  labelHidden = false,
  description,
  disabled = false,
  size = 'md',
  className,
}: SwitchProps) {
  const labelId = useId()
  const descriptionId = useId()

  return (
    <label
      className={cx(
        'flex items-center justify-between gap-6',
        disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer',
        className,
      )}
    >
      {!labelHidden && (
        <span className="min-w-0">
          <span id={labelId} className="block text-sm font-medium text-[var(--color-text-primary)]">
            {label}
          </span>
          {description && (
            <span id={descriptionId} className="mt-0.5 block text-xs text-[var(--color-text-secondary)]">
              {description}
            </span>
          )}
        </span>
      )}

      <span className={cx('relative inline-flex flex-none items-center', TRACK_SIZE[size])}>
        <input
          type="checkbox"
          role="switch"
          className="peer sr-only"
          checked={checked}
          disabled={disabled}
          onChange={(event) => onChange(event.target.checked)}
          // Named by the label span rather than by the wrapping <label>: the
          // wrapper also contains `description`, and an implicit label would
          // fold that into the accessible name.
          aria-label={labelHidden ? label : undefined}
          aria-labelledby={labelHidden ? undefined : labelId}
          aria-describedby={description && !labelHidden ? descriptionId : undefined}
        />
        <span
          aria-hidden="true"
          className="absolute inset-0 rounded-full bg-[var(--color-outline)] transition-colors peer-checked:bg-[var(--color-switch-checked-bg)] peer-focus-visible:ring-2 peer-focus-visible:ring-[var(--color-border-focus)]"
        />
        <span
          aria-hidden="true"
          className={cx(
            'relative rounded-full bg-[var(--color-switch-thumb)] shadow-sm transition-transform',
            THUMB_SIZE[size],
            THUMB_OFFSET[size],
          )}
        />
      </span>
    </label>
  )
}
