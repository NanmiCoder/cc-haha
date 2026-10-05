import {
  cloneElement,
  isValidElement,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement,
  type ReactNode,
} from 'react'

import { Check } from 'lucide-react'

import { useDismissable } from '@/hooks/useDismissable'
import { cx } from '@/lib/cx'

type DropdownItem<T extends string> = {
  value: T
  label: string
  description?: string
  icon?: ReactNode
  disabled?: boolean
}

type DropdownProps<T extends string> = {
  items: DropdownItem<T>[]
  value: T
  onChange: (value: T) => void
  trigger: ReactNode
  /**
   * Names the control for screen readers. Optional for compatibility with the
   * existing call sites, but pass it: without one the trigger is announced as
   * just "button".
   */
  label?: string
  width?: CSSProperties['width']
  maxHeight?: CSSProperties['maxHeight']
  align?: 'left' | 'right'
  placement?: 'bottom' | 'top'
  className?: string
}

/**
 * A single-select dropdown with rich option rows.
 *
 * Prefer `SelectField` for plain text options — the native control brings
 * type-ahead, mobile pickers and platform behavior for free. Use this when
 * options need icons or a description line.
 *
 * The listbox semantics and keyboard handling here were previously absent: the
 * trigger was a `<div onClick>` (not focusable, not activated by Enter or
 * Space), the panel had no role, and arrow keys did nothing.
 *
 * **Contract for `trigger`**: it must reach a real DOM element. This component
 * clones it to attach a ref, the aria state, and its own `onClick`/`onKeyDown`.
 * A plain `<button>` works. A custom component works only if it is wrapped in
 * `forwardRef` *and* spreads the rest of its props onto the DOM node —
 * otherwise the handlers land nowhere and the dropdown silently never opens.
 * That is exactly what happened to `market/FilterBar`'s filter chips. The
 * development-only check below turns that silence into a console warning.
 */
export function Dropdown<T extends string>({
  items,
  value,
  onChange,
  trigger,
  label,
  width = 320,
  maxHeight,
  align = 'left',
  placement = 'bottom',
  className = '',
}: DropdownProps<T>) {
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(-1)
  const containerRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const listId = useId()

  const close = useCallback(() => {
    setOpen(false)
    setActiveIndex(-1)
    // Return focus to the trigger. Of the 28 hand-rolled dropdowns, exactly one
    // did this; everywhere else closing a menu dropped the keyboard user back
    // at the top of the document.
    triggerRef.current?.focus()
  }, [])

  useDismissable({
    open,
    refs: [containerRef],
    onDismiss: close,
    // Dropdowns routinely open inside a Modal. Without this, one Escape closes
    // the dropdown and the dialog behind it.
    stopEscapePropagation: true,
  })

  // Track the highlighted option so arrow keys have somewhere to start, and
  // move focus into the list so those keys reach it at all.
  useEffect(() => {
    if (!open) return
    const selected = items.findIndex((item) => item.value === value)
    setActiveIndex(selected >= 0 ? selected : 0)
    listRef.current?.focus()
    // Only on open: re-running on every `items` identity change would steal
    // focus back from a user who tabbed away.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // A trigger that swallows the cloned props leaves this ref null. Nothing else
  // reports it: the click handler simply never fires and the menu looks inert.
  useEffect(() => {
    if (!import.meta.env.DEV) return
    if (open && !triggerRef.current) {
      console.warn(
        '[Dropdown] The trigger did not forward its ref. If it is a custom component, '
        + 'wrap it in forwardRef and spread the remaining props onto its DOM node — '
        + 'otherwise this dropdown cannot be opened or positioned.',
      )
    }
  }, [open])

  useEffect(() => {
    if (!open || activeIndex < 0) return
    const options = listRef.current?.querySelectorAll<HTMLElement>('[role="option"]')
    // Optional call: scrollIntoView's options argument is not universally
    // supported, and jsdom omits the method entirely.
    options?.[activeIndex]?.scrollIntoView?.({ block: 'nearest' })
  }, [open, activeIndex])

  const step = (delta: number) => {
    const enabled = items.map((item, index) => ({ item, index })).filter(({ item }) => !item.disabled)
    if (enabled.length === 0) return
    const current = enabled.findIndex(({ index }) => index === activeIndex)
    const next = enabled[(current + delta + enabled.length) % enabled.length]!
    setActiveIndex(next.index)
  }

  const handleTriggerKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Enter' || event.key === ' ' || event.key === 'ArrowDown') {
      event.preventDefault()
      setOpen(true)
      return
    }
    if (event.key === 'Escape' && open) {
      event.preventDefault()
      close()
    }
  }

  const handleListKeyDown = (event: React.KeyboardEvent) => {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault()
        step(1)
        break
      case 'ArrowUp':
        event.preventDefault()
        step(-1)
        break
      case 'Home':
        event.preventDefault()
        setActiveIndex(0)
        break
      case 'End':
        event.preventDefault()
        setActiveIndex(items.length - 1)
        break
      case 'Enter':
      case ' ': {
        event.preventDefault()
        const item = items[activeIndex]
        if (item && !item.disabled) {
          onChange(item.value)
          close()
        }
        break
      }
      default:
        break
    }
  }

  // The aria state goes onto the caller's own trigger element rather than a
  // wrapper. Every call site passes a `<button>`, and wrapping a button in a
  // `role="combobox" tabIndex=0` div nests one interactive control inside
  // another — two tab stops for one control, and a role the button overrides.
  const triggerNode = isValidElement(trigger)
    ? cloneElement(trigger as ReactElement<Record<string, unknown>>, {
      ref: triggerRef,
      'aria-expanded': open,
      'aria-haspopup': 'listbox',
      'aria-controls': open ? listId : undefined,
      onClick: (event: React.MouseEvent) => {
        ;((trigger as ReactElement<Record<string, unknown>>).props.onClick as ((e: React.MouseEvent) => void) | undefined)?.(event)
        if (open) close()
        else setOpen(true)
      },
      onKeyDown: handleTriggerKeyDown,
    })
    : (
      <div
        ref={triggerRef}
        role="button"
        tabIndex={0}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-controls={open ? listId : undefined}
        aria-label={label}
        onClick={() => (open ? close() : setOpen(true))}
        onKeyDown={handleTriggerKeyDown}
        className="cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)]"
      >
        {trigger}
      </div>
    )

  return (
    <div ref={containerRef} className={cx('relative', className || 'inline-block')}>
      {triggerNode}

      {open && (
        <div
          ref={listRef}
          id={listId}
          role="listbox"
          aria-label={label}
          aria-activedescendant={activeIndex >= 0 ? `${listId}-${activeIndex}` : undefined}
          tabIndex={-1}
          onKeyDown={handleListKeyDown}
          className={cx(
            // Menus are cards (12px) with padded rows; one value here settles
            // the corner for every Dropdown menu in the app.
            'absolute z-[var(--z-dropdown)] rounded-[var(--radius-lg)] p-1',
            'bg-[var(--color-surface-container-lowest)] border border-[var(--color-border)]',
            'shadow-[var(--shadow-dropdown)] focus:outline-none',
            maxHeight ? 'overflow-y-auto' : 'overflow-hidden',
            align === 'right' ? 'right-0' : 'left-0',
            placement === 'top' ? 'bottom-full mb-1 animate-overlay-in-bottom' : 'top-full mt-1 animate-overlay-in-top',
          )}
          style={{ width, maxHeight }}
        >
          {items.map((item, index) => (
            <div
              key={item.value}
              id={`${listId}-${index}`}
              role="option"
              aria-selected={item.value === value}
              aria-disabled={item.disabled || undefined}
              onClick={() => {
                if (item.disabled) return
                onChange(item.value)
                close()
              }}
              onMouseEnter={() => setActiveIndex(index)}
              className={cx(
                'flex w-full items-center gap-2.5 rounded-[var(--radius-sm)] px-2.5 py-2 text-left transition-colors',
                item.disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer',
                (index === activeIndex || item.value === value) && !item.disabled && 'bg-[var(--color-surface-hover)]',
              )}
            >
              {item.icon && (
                <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center text-[var(--color-text-secondary)]">
                  {item.icon}
                </span>
              )}
              <div className="min-w-0 flex-1">
                <div className="text-[13px] font-medium text-[var(--color-text-primary)]">{item.label}</div>
                {item.description && (
                  <div className="mt-0.5 text-xs text-[var(--color-text-tertiary)]">{item.description}</div>
                )}
              </div>
              {item.value === value && (
                <Check size={15} strokeWidth={2} aria-hidden="true" className="flex-shrink-0 text-[var(--color-brand)]" />
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
