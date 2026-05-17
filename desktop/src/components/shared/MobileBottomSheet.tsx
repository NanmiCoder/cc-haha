import { useEffect, type ReactNode, type Ref } from 'react'
import { createPortal } from 'react-dom'

type Props = {
  open: boolean
  onClose: () => void
  title: ReactNode
  children: ReactNode
  closeLabel?: string
  headerExtra?: ReactNode
  footer?: ReactNode
  id?: string
  role?: string
  ariaLabel?: string
  contentClassName?: string
  panelClassName?: string
  panelRef?: Ref<HTMLDivElement>
  testId?: string
}

export function MobileBottomSheet({
  open,
  onClose,
  title,
  children,
  closeLabel = 'Close',
  headerExtra,
  footer,
  id,
  role = 'dialog',
  ariaLabel,
  contentClassName = '',
  panelClassName = '',
  panelRef,
  testId,
}: Props) {
  useEffect(() => {
    if (!open) return
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [open, onClose])

  if (!open) return null

  return createPortal(
    <div className="fixed inset-0 z-[10000] bg-black/25" onClick={onClose}>
      <div
        ref={panelRef}
        id={id}
        role={role}
        aria-modal={role === 'dialog' ? true : undefined}
        aria-label={ariaLabel ?? (typeof title === 'string' ? title : undefined)}
        data-testid={testId}
        className={`absolute inset-x-0 bottom-0 flex max-h-[min(78dvh,640px)] min-h-0 flex-col overflow-hidden rounded-t-2xl border-x-0 border-y border-[var(--color-border)] bg-[var(--color-surface-container-lowest)] shadow-[0_-18px_48px_rgba(54,35,28,0.22)] ${panelClassName}`}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="shrink-0 border-b border-[var(--color-border)] px-4 py-3">
          <div className="flex min-h-10 items-center justify-between gap-3">
            <div className="min-w-0 text-[11px] font-bold uppercase tracking-widest text-[var(--color-outline)]">
              {title}
            </div>
            <button
              type="button"
              aria-label={closeLabel}
              onClick={onClose}
              className="grid h-10 w-10 shrink-0 place-items-center rounded-full text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)]"
            >
              <span className="material-symbols-outlined text-[20px]">close</span>
            </button>
          </div>
          {headerExtra && (
            <div className="mt-3">
              {headerExtra}
            </div>
          )}
        </div>

        <div className={`min-h-0 flex-1 overflow-y-auto ${contentClassName}`}>
          {children}
        </div>

        {footer && (
          <div className="shrink-0 border-t border-[var(--color-border)]">
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body,
  )
}
