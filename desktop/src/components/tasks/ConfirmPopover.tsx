import { Button } from '@/components/ui/Button'

type ConfirmPopoverProps = {
  message: string
  confirmLabel: string
  onConfirm: () => void
  onCancel: () => void
  cancelLabel: string
  confirmVariant?: 'primary' | 'danger'
}

export function ConfirmPopover({
  message,
  confirmLabel,
  onConfirm,
  onCancel,
  cancelLabel,
  confirmVariant = 'primary',
}: ConfirmPopoverProps) {
  return (
    // `dropdown-glass` carries the frosted fill, rim and `--shadow-dropdown-glass`;
    // the level comes from the `--z-*` scale rather than a bare `z-50`.
    <div className="dropdown-glass popover-motion absolute right-0 top-full z-[var(--z-popover)] mt-1.5 w-52 rounded-[var(--radius-xl)] p-3">
      <p className="mb-2.5 text-[13px] leading-[1.5] text-[var(--color-text-secondary)]">{message}</p>
      <div className="flex justify-end gap-1.5">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          {cancelLabel}
        </Button>
        <Button type="button" variant={confirmVariant} size="sm" onClick={onConfirm}>
          {confirmLabel}
        </Button>
      </div>
    </div>
  )
}
