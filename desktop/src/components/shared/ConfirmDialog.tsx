import { Modal } from './Modal'
import { Button } from './Button'
import type { ReactNode } from 'react'

type ConfirmDialogProps = {
  open: boolean
  onClose: () => void
  onConfirm: () => void | Promise<void>
  title: string
  body: ReactNode
  confirmLabel: string
  cancelLabel: string
  confirmVariant?: 'primary' | 'danger'
  loading?: boolean
}

export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  body,
  confirmLabel,
  cancelLabel,
  confirmVariant = 'danger',
  loading = false,
}: ConfirmDialogProps) {
  return (
    <Modal
      open={open}
      onClose={loading ? () => {} : onClose}
      title={title}
      width={460}
      footer={(
        <>
          <Button variant="secondary" onClick={onClose} disabled={loading}>
            {cancelLabel}
          </Button>
          <Button variant={confirmVariant} onClick={() => void onConfirm()} loading={loading}>
            {confirmLabel}
          </Button>
        </>
      )}
    >
      {typeof body === 'string' ? (
        <p className="text-sm leading-6 text-[var(--color-text-secondary)]">
          {body}
        </p>
      ) : body}
    </Modal>
  )
}
