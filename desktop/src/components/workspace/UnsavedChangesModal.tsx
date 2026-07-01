import { useEffect, useRef } from 'react'

/**
 * Modal shown when the user attempts to close a tab with unsaved changes.
 *
 * Three actions: `Discard` (drop edits and close), `Save` (persist via R2
 * save endpoint then close), `Cancel` (return to editing). `Cancel` is the
 * default focus and `Esc` triggers it. While a save is in flight, the close
 * button is replaced by a progress indicator and cannot be dismissed; close
 * only proceeds once the save resolves successfully (R4 AC6).
 *
 * The 30 s in-prompt timeout (R4 AC5) dismisses the modal, preserves the
 * dirty buffer, and surfaces an error toast — the host owns the toast and
 * passes a `onTimeout` callback.
 *
 * _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6 (Phase 2 task 14)_
 */

const PROMPT_TIMEOUT_MS = 30_000

export type UnsavedChangesModalProps = {
  open: boolean
  filePath: string
  isSaving: boolean
  onDiscard: () => void
  onSave: () => Promise<void> | void
  onCancel: () => void
  /** Fires once after `PROMPT_TIMEOUT_MS` of being open without resolution. */
  onTimeout: () => void
}

export function UnsavedChangesModal(props: UnsavedChangesModalProps) {
  const { open, filePath, isSaving, onDiscard, onSave, onCancel, onTimeout } = props

  const cancelButtonRef = useRef<HTMLButtonElement | null>(null)
  const timeoutFiredRef = useRef(false)

  // Reset the "timeout already fired" guard whenever we reopen the modal.
  useEffect(() => {
    if (open) timeoutFiredRef.current = false
  }, [open])

  // 30 s in-prompt timeout: dismiss, preserve dirty buffer, surface toast.
  useEffect(() => {
    if (!open || isSaving) return
    const handle = setTimeout(() => {
      if (timeoutFiredRef.current) return
      timeoutFiredRef.current = true
      onTimeout()
    }, PROMPT_TIMEOUT_MS)
    return () => clearTimeout(handle)
  }, [open, isSaving, onTimeout])

  // Cancel default focus + Esc handling.
  useEffect(() => {
    if (!open) return
    cancelButtonRef.current?.focus()

    function handleKey(event: KeyboardEvent) {
      if (event.key === 'Escape' && !isSaving) {
        event.preventDefault()
        onCancel()
      }
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [open, isSaving, onCancel])

  if (!open) return null

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="unsaved-changes-title"
      aria-describedby="unsaved-changes-body"
      data-testid="unsaved-changes-modal"
      className="fixed inset-0 z-[60] flex items-center justify-center bg-[var(--color-scrim)]/40"
    >
      <div className="w-[420px] rounded-[14px] border border-[var(--color-border)] bg-[var(--color-surface)] p-5 shadow-[var(--shadow-modal)]">
        <h2 id="unsaved-changes-title" className="text-[15px] font-semibold text-[var(--color-text)]">
          Unsaved changes
        </h2>
        <p id="unsaved-changes-body" className="mt-2 text-[13px] text-[var(--color-text-muted)]">
          {filePath} has unsaved changes. What would you like to do?
        </p>

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            data-testid="unsaved-changes-discard"
            disabled={isSaving}
            onClick={onDiscard}
            className="rounded-[8px] border border-[var(--color-border)] px-3 py-1.5 text-[12px] text-[var(--color-text)] hover:bg-[var(--color-surface-hover)] disabled:cursor-not-allowed disabled:opacity-50"
          >
            Discard
          </button>
          <button
            type="button"
            data-testid="unsaved-changes-save"
            disabled={isSaving}
            onClick={() => void onSave()}
            className="rounded-[8px] bg-[var(--color-primary)] px-3 py-1.5 text-[12px] font-medium text-[var(--color-on-primary)] disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isSaving ? 'Saving…' : 'Save'}
          </button>
          <button
            ref={cancelButtonRef}
            type="button"
            data-testid="unsaved-changes-cancel"
            disabled={isSaving}
            onClick={onCancel}
            className="rounded-[8px] border border-[var(--color-border)] px-3 py-1.5 text-[12px] text-[var(--color-text)] hover:bg-[var(--color-surface-hover)] disabled:cursor-not-allowed disabled:opacity-50"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}
