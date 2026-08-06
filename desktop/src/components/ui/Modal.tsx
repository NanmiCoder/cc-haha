import { useEffect, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

type ModalProps = {
  open: boolean
  onClose: () => void
  title?: string
  children: ReactNode
  width?: number
  footer?: ReactNode
  variant?: 'dialog' | 'media'
}

export function Modal({
  open,
  onClose,
  title,
  children,
  width = 560,
  footer,
  variant = 'dialog',
}: ModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const previousFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null
    const dialog = dialogRef.current
    const firstFocusable = dialog?.querySelector<HTMLElement>(FOCUSABLE_SELECTOR)
    ;(firstFocusable ?? dialog)?.focus()

    return () => {
      if (previousFocus?.isConnected) previousFocus.focus()
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose()
        return
      }
      if (event.key !== 'Tab') return

      const dialog = dialogRef.current
      if (!dialog) return
      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
      if (focusable.length === 0) {
        event.preventDefault()
        dialog.focus()
        return
      }

      const first = focusable[0]!
      const last = focusable[focusable.length - 1]!
      const focusOutsideDialog = !dialog.contains(document.activeElement)
      if (event.shiftKey && (document.activeElement === first || focusOutsideDialog)) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && (document.activeElement === last || focusOutsideDialog)) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [open, onClose])

  if (!open) return null

  return createPortal(
    <div className="fixed inset-0 z-[var(--z-dialog)] flex items-center justify-center">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-[var(--color-modal-scrim)] transition-opacity duration-200"
        onClick={onClose}
      />

      {/* Modal content */}
      <div
        ref={dialogRef}
        // 24px — the top of the handoff's corner scale, reserved for modals.
        // `dialog-panel`, not `glass-panel`: the fill has to be opaque on its
        // own rather than leaning on a blur that may never run.
        className={variant === 'media'
          ? 'relative flex h-[calc(100dvh-24px)] w-[calc(100vw-24px)] flex-col overflow-hidden rounded-[var(--radius-2xl)] bg-[var(--color-terminal-bg)] text-[var(--color-terminal-fg)]'
          : 'dialog-panel relative flex max-h-[85vh] flex-col rounded-[var(--radius-3xl)]'}
        style={variant === 'media'
          ? { maxHeight: 'calc(100dvh - 24px)', maxWidth: 'calc(100vw - 24px)' }
          : { width, maxWidth: 'calc(100vw - 48px)' }}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
      >
        {title && variant === 'dialog' && (
          <div className="flex items-start justify-between gap-4 px-6 pt-6 pb-0">
            <h2
              // 22px serif — dialog titles are headings, and headings carry the
              // 「墨」 identity (handoff §7, every modal comp).
              className="text-[22px] font-bold tracking-tight text-[var(--color-text-primary)]"
              style={{ fontFamily: 'var(--font-headline)' }}
            >
              {title}
            </h2>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close dialog"
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)]"
            >
              <span className="material-symbols-outlined text-[18px]">close</span>
            </button>
          </div>
        )}

        <div className={variant === 'media'
          ? 'min-h-0 flex-1 overflow-hidden'
          : 'flex-1 overflow-y-auto px-6 py-4'}>
          {children}
        </div>

        {footer && (
          <div className="px-6 pb-6 pt-0 flex justify-end gap-2">
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body,
  )
}
