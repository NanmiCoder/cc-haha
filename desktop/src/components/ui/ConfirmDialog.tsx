import type { ReactNode } from 'react'
import { ActionDialog } from './ActionDialog'

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
    <ActionDialog
      open={open}
      onClose={onClose}
      title={title}
      body={body}
      loading={loading}
      actions={[
        {
          label: cancelLabel,
          onClick: onClose,
          variant: 'secondary',
        },
        {
          label: confirmLabel,
          onClick: onConfirm,
          variant: confirmVariant,
          loading,
        },
      ]}
    />
  )
}
