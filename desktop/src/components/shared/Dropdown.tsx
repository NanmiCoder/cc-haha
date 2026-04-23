import { useState, useRef, useEffect, type ReactNode } from 'react'

type DropdownItem<T extends string> = {
  value: T
  label: string
  description?: string
  icon?: ReactNode
}

type DropdownProps<T extends string> = {
  items: DropdownItem<T>[]
  value: T
  onChange: (value: T) => void
  trigger: ReactNode
  width?: number
  align?: 'left' | 'right'
}

export function Dropdown<T extends string>({
  items,
  value,
  onChange,
  trigger,
  width = 320,
  align = 'left',
}: DropdownProps<T>) {
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

  return (
    <div ref={ref} className="relative inline-block">
      <div onClick={() => setOpen(!open)} className="cursor-pointer">
        {trigger}
      </div>

      {open && (
        <div
          className={`
            absolute z-50 mt-1 py-1 rounded-[var(--radius-lg)]
            bg-[var(--color-surface)] border border-[var(--color-border)]
            shadow-[var(--shadow-dropdown)]
            animate-in fade-in slide-in-from-top-1
            ${align === 'right' ? 'right-0' : 'left-0'}
          `}
          style={{ width }}
        >
          {items.map((item, i) => (
            <button
              key={item.value}
              onClick={() => { onChange(item.value); setOpen(false) }}
              className={`
                w-full flex items-center gap-3 px-4 py-3 text-left transition-colors
                hover:bg-[var(--color-surface-hover)]
                ${i > 0 ? 'border-t border-[var(--color-border-separator)]' : ''}
              `}
            >
              {item.icon && <span className="text-lg flex-shrink-0">{item.icon}</span>}
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium text-[var(--color-text-primary)]">{item.label}</div>
                {item.description && (
                  <div className="text-xs text-[var(--color-text-secondary)] mt-0.5">{item.description}</div>
                )}
              </div>
              {item.value === value && (
                <span className="text-[var(--color-text-primary)] text-sm flex-shrink-0">✓</span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
