import { useState, useRef, useEffect, type CSSProperties, type ReactNode } from 'react'

type MultiSelectDropdownItem<T extends string> = {
  value: T
  label: string
  description?: string
  icon?: ReactNode
}

type MultiSelectDropdownProps<T extends string> = {
  items: MultiSelectDropdownItem<T>[]
  /** Currently selected values. Items not in this array are rendered unchecked. */
  values: T[]
  /** Toggle a single item. The popover stays open so multiple items can be selected without reopening. */
  onToggle: (value: T) => void
  trigger: ReactNode
  width?: CSSProperties['width']
  maxHeight?: CSSProperties['maxHeight']
  align?: 'left' | 'right'
  className?: string
  /** Optional bulk shortcuts shown above the items. */
  selectAllLabel?: string
  clearLabel?: string
  onSelectAll?: () => void
  onClear?: () => void
}

/**
 * Multi-select cousin of Dropdown. Click outside / press Escape to close.
 * Clicking an item toggles it without closing — bulk-selection without
 * reopening the popover for each pick. The shape mirrors Dropdown so a
 * caller can swap them without learning a different API surface.
 */
export function MultiSelectDropdown<T extends string>({
  items,
  values,
  onToggle,
  trigger,
  width = 320,
  maxHeight,
  align = 'left',
  className = '',
  selectAllLabel,
  clearLabel,
  onSelectAll,
  onClear,
}: MultiSelectDropdownProps<T>) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const handleClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', handleClick)
    document.addEventListener('keydown', handleEsc)
    return () => {
      document.removeEventListener('mousedown', handleClick)
      document.removeEventListener('keydown', handleEsc)
    }
  }, [open])

  const selectedSet = new Set(values)
  const showHeader = (selectAllLabel && onSelectAll) || (clearLabel && onClear)

  return (
    <div ref={ref} className={`relative ${className || 'inline-block'}`}>
      <div onClick={() => setOpen(!open)} className="cursor-pointer">
        {trigger}
      </div>

      {open && (
        <div
          className={`
            absolute z-50 mt-1 rounded-[var(--radius-lg)]
            bg-[var(--color-surface-container-lowest)] border border-[var(--color-border)]
            shadow-[var(--shadow-dropdown)]
            animate-in fade-in slide-in-from-top-1
            ${maxHeight ? 'overflow-y-auto' : 'overflow-hidden'}
            ${align === 'right' ? 'right-0' : 'left-0'}
          `}
          style={{ width, maxHeight }}
        >
          {showHeader && (
            <div className="flex items-center gap-2 px-3 py-2 border-b border-[var(--color-border-separator)] text-xs">
              {selectAllLabel && onSelectAll && (
                <button
                  type="button"
                  onClick={onSelectAll}
                  className="text-[var(--color-brand)] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-brand)] rounded-sm px-1 -mx-1"
                >
                  {selectAllLabel}
                </button>
              )}
              {clearLabel && onClear && (
                <button
                  type="button"
                  onClick={onClear}
                  className="text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-brand)] rounded-sm px-1 -mx-1"
                >
                  {clearLabel}
                </button>
              )}
            </div>
          )}

          {items.map((item, i) => {
            const checked = selectedSet.has(item.value)
            return (
              <button
                key={item.value}
                type="button"
                onClick={() => onToggle(item.value)}
                className={`
                  w-full flex items-center gap-3 px-3 py-2.5 text-left transition-colors
                  hover:bg-[var(--color-surface-hover)] focus-visible:outline-none focus-visible:bg-[var(--color-surface-hover)]
                  ${checked ? 'bg-[var(--color-model-option-selected-bg)]' : ''}
                  ${i > 0 ? 'border-t border-[var(--color-border-separator)]' : ''}
                `}
                aria-checked={checked}
                role="menuitemcheckbox"
              >
                <span
                  className={`
                    flex h-5 w-5 flex-shrink-0 items-center justify-center rounded
                    ${checked
                      ? 'bg-[var(--color-brand)] text-[var(--color-btn-primary-fg)]'
                      : 'border border-[var(--color-border)]'}
                  `}
                  aria-hidden="true"
                >
                  {checked && (
                    <span className="material-symbols-outlined text-[14px]" style={{ fontVariationSettings: "'FILL' 1" }}>check</span>
                  )}
                </span>
                {item.icon && (
                  <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center text-[var(--color-text-secondary)]">{item.icon}</span>
                )}
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-[var(--color-text-primary)]">{item.label}</div>
                  {item.description && (
                    <div className="text-xs text-[var(--color-text-secondary)] mt-0.5">{item.description}</div>
                  )}
                </div>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
